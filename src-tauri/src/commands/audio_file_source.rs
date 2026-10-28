//! Native, bounded-memory access to user-selected audio. FFmpeg decodes only one
//! requested time range to a private PCM cache; neither IPC nor playback reads
//! the entire original recording into memory.
use http::{header, Method, Request, Response, StatusCode};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

const SAMPLE_RATE: u64 = 16_000;
const MAX_SOURCE_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_SOURCE_SECONDS: f64 = 24.0 * 60.0 * 60.0;
const MAX_PART_MS: u64 = 30 * 60 * 1000;
const MAX_READ_SAMPLES: u64 = 16_000;
const MAX_PLAYBACK_BYTES: u64 = 1024 * 1024;
const MAX_PROBE_BYTES: u64 = 1024 * 1024;
const MAX_OPEN_SOURCES: usize = 4;
const MAX_CACHED_PARTS: usize = 2;
const AUDIO_EXTENSIONS: &[&str] = &["wav", "mp3", "m4a", "aac", "flac", "ogg"];
const MANUAL_FALLBACK: &str = "可手动导入已切分文件";

#[derive(Default)]
pub struct AudioFileSourceState {
    sources: Mutex<HashMap<String, Arc<AudioSource>>>,
}

struct AudioSource {
    path: PathBuf,
    cache_dir: PathBuf,
    ffmpeg: PathBuf,
    duration: f64,
    file_size: u64,
    format: &'static str,
    mime: &'static str,
    closed: AtomicBool,
    // Epochs avoid clearing a cancellation that arrives as a worker starts.
    cancel_epoch: AtomicU64,
    preparing: AtomicBool,
    prepare_lock: Mutex<()>,
    parts: Mutex<HashMap<String, PcmPart>>,
}

struct PcmPart {
    path: PathBuf,
    total_samples: u64,
}

impl Drop for AudioSource {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.cache_dir);
    }
}

impl Drop for AudioFileSourceState {
    fn drop(&mut self) {
        if let Ok(sources) = self.sources.get_mut() {
            for source in sources.values() {
                source.closed.store(true, Ordering::SeqCst);
                source.cancel_epoch.fetch_add(1, Ordering::SeqCst);
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    id: String,
    file_name: String,
    duration: f64,
    file_size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartInfo {
    id: String,
    total_samples: u64,
    sample_rate: u64,
}

fn source_for(state: &AudioFileSourceState, id: &str) -> Result<Arc<AudioSource>, String> {
    state
        .sources
        .lock()
        .map_err(|_| "音频文件状态不可用")?
        .get(id)
        .filter(|source| !source.closed.load(Ordering::SeqCst))
        .cloned()
        .ok_or_else(|| "音频文件已关闭，请重新选择文件".into())
}

fn audio_format(path: &Path) -> Result<(&'static str, &'static str), String> {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("wav") => Ok(("wav", "audio/wav")),
        Some("mp3") => Ok(("mp3", "audio/mpeg")),
        Some("m4a") => Ok(("mov", "audio/mp4")),
        Some("aac") => Ok(("aac", "audio/aac")),
        Some("flac") => Ok(("flac", "audio/flac")),
        Some("ogg") => Ok(("ogg", "audio/ogg")),
        _ => Err("请选择 WAV、MP3、M4A、AAC、FLAC 或 OGG 音频文件".into()),
    }
}

fn discover_binary(name: &str) -> Option<PathBuf> {
    let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths)
                .filter(|p| p.is_absolute())
                .collect()
        })
        .unwrap_or_default();
    directories.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            directories.push(parent.to_path_buf());
        }
    }
    #[cfg(windows)]
    let name = format!("{name}.exe");
    directories
        .into_iter()
        .map(|directory| directory.join(&name))
        .find(|path| {
            if !path.is_file() {
                return false;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                return path
                    .metadata()
                    .map(|m| m.permissions().mode() & 0o111 != 0)
                    .unwrap_or(false);
            }
            #[cfg(not(unix))]
            true
        })
}

fn private_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|e| format!("无法创建音频临时文件：{e}"))
}

fn create_cache_dir(path: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|e| format!("无法创建音频缓存目录：{e}"))
}

// Every early return reaps the subprocess before its output file is removed.
struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn run_bounded(
    command: &mut Command,
    watched_files: &[(&Path, u64)],
    timeout: Duration,
    cancelled: impl Fn() -> bool,
) -> Result<ExitStatus, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command.stdin(Stdio::null());
    let mut child = ChildGuard(
        command
            .spawn()
            .map_err(|e| format!("无法启动本机音频解码工具：{e}"))?,
    );
    let deadline = Instant::now() + timeout;
    loop {
        if cancelled() {
            return Err("音频分段已取消".into());
        }
        if Instant::now() >= deadline {
            return Err("音频解码超时，请缩短分段范围后重试".into());
        }
        for (path, limit) in watched_files {
            let size = path
                .metadata()
                .map_err(|e| format!("无法检查音频临时文件：{e}"))?
                .len();
            if size > *limit {
                return Err("音频解码结果超过分段大小限制，请缩短分段范围".into());
            }
        }
        if let Some(status) = child
            .0
            .try_wait()
            .map_err(|e| format!("无法读取解码进程状态：{e}"))?
        {
            // The child may have written its final buffer since the size check.
            for (path, limit) in watched_files {
                if path.metadata().map_err(|e| e.to_string())?.len() > *limit {
                    return Err("音频解码结果超过分段大小限制，请缩短分段范围".into());
                }
            }
            return Ok(status);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn input_options(command: &mut Command, path: &Path, format: &str) {
    // Force one supported container; a renamed playlist must never open URLs
    // or unrelated files. MOV external data references remain disabled.
    command.args(["-protocol_whitelist", "file,pipe", "-f", format]);
    if format == "mov" {
        command.args(["-enable_drefs", "0", "-use_absolute_path", "0"]);
    }
    command.arg("-i").arg(path);
}

fn probe_duration(ffprobe: &Path, path: &Path, format: &str, cache: &Path) -> Result<f64, String> {
    let output_path = cache.join("probe.json");
    let output = private_file(&output_path)?;
    let result = (|| {
        let mut command = Command::new(ffprobe);
        command.args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_type,duration:format=duration",
            "-of",
            "json",
        ]);
        input_options(&mut command, path, format);
        command.stdout(Stdio::from(output)).stderr(Stdio::null());
        let status = run_bounded(
            &mut command,
            &[(&output_path, MAX_PROBE_BYTES)],
            Duration::from_secs(20),
            || false,
        )?;
        if !status.success() {
            return Err("无法识别音频格式或时长".into());
        }
        let bytes = fs::read(&output_path).map_err(|e| format!("无法读取音频信息：{e}"))?;
        let info: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "音频信息无效")?;
        let stream = info
            .get("streams")
            .and_then(|s| s.as_array())
            .and_then(|s| s.first())
            .ok_or("文件中没有可识别的音轨")?;
        if stream.get("codec_type").and_then(|s| s.as_str()) != Some("audio") {
            return Err("文件中没有可识别的音轨".into());
        }
        let number = |value: Option<&serde_json::Value>| -> Option<f64> {
            value
                .and_then(|v| {
                    v.as_str()
                        .and_then(|s| s.parse().ok())
                        .or_else(|| v.as_f64())
                })
                .filter(|n| n.is_finite() && *n > 0.0)
        };
        let duration = number(info.get("format").and_then(|f| f.get("duration")))
            .or_else(|| number(stream.get("duration")))
            .ok_or("无法读取可靠的音频时长")?;
        if duration > MAX_SOURCE_SECONDS {
            return Err("单个音频不能超过 24 小时".into());
        }
        Ok(duration)
    })();
    let _ = fs::remove_file(output_path);
    result.map_err(|e: String| format!("{e}；{MANUAL_FALLBACK}"))
}

#[tauri::command]
pub async fn audio_file_open_source(app: AppHandle) -> Result<Option<SourceInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("选择要翻译的音频文件")
            .add_filter("音频文件", AUDIO_EXTENSIONS)
            .blocking_pick_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|e| format!("无法读取文件位置：{e}"))?
            .canonicalize()
            .map_err(|e| format!("无法打开音频文件：{e}"))?;
        let metadata = path
            .metadata()
            .map_err(|e| format!("无法读取音频文件：{e}"))?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err("请选择非空的普通音频文件".into());
        }
        if metadata.len() > MAX_SOURCE_BYTES {
            return Err(format!("单个音频不能超过 16 GiB；{MANUAL_FALLBACK}"));
        }
        let (format, mime) = audio_format(&path)?;
        let ffmpeg = discover_binary("ffmpeg").ok_or_else(|| {
            format!("未找到本机 FFmpeg，长音频分段需要 FFmpeg 和 ffprobe；{MANUAL_FALLBACK}")
        })?;
        let ffprobe = discover_binary("ffprobe").ok_or_else(|| {
            format!("未找到本机 ffprobe，长音频分段需要 FFmpeg 和 ffprobe；{MANUAL_FALLBACK}")
        })?;
        let id = uuid::Uuid::new_v4().to_string();
        let cache_root = app
            .path()
            .app_cache_dir()
            .map_err(|e| e.to_string())?
            .join("audio-file-sources");
        fs::create_dir_all(&cache_root).map_err(|e| format!("无法创建音频缓存：{e}"))?;
        let cache_dir = cache_root.join(&id);
        create_cache_dir(&cache_dir)?;
        let duration = match probe_duration(&ffprobe, &path, format, &cache_dir) {
            Ok(duration) => duration,
            Err(error) => {
                let _ = fs::remove_dir_all(cache_dir);
                return Err(error);
            }
        };
        let info = SourceInfo {
            id: id.clone(),
            file_name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            duration,
            file_size: metadata.len(),
        };
        let source = Arc::new(AudioSource {
            path,
            cache_dir,
            ffmpeg,
            duration,
            file_size: metadata.len(),
            format,
            mime,
            closed: AtomicBool::new(false),
            cancel_epoch: AtomicU64::new(0),
            preparing: AtomicBool::new(false),
            prepare_lock: Mutex::new(()),
            parts: Mutex::new(HashMap::new()),
        });
        let state = app.state::<AudioFileSourceState>();
        let mut sources = state.sources.lock().map_err(|_| "音频文件状态不可用")?;
        if sources.len() >= MAX_OPEN_SOURCES {
            return Err("打开的音频过多，请关闭前面的文件后重试".into());
        }
        sources.insert(id, source);
        Ok(Some(info))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, PartialEq)]
struct SeekPlan {
    start_sample: u64,
    total_samples: u64,
    max_bytes: u64,
}

fn seek_plan(duration: f64, start_ms: f64, end_ms: f64) -> Result<SeekPlan, String> {
    if !duration.is_finite()
        || duration <= 0.0
        || duration > MAX_SOURCE_SECONDS
        || !start_ms.is_finite()
        || !end_ms.is_finite()
        || start_ms < 0.0
        || end_ms <= start_ms
    {
        return Err("分段时间无效，结束时间必须晚于开始时间".into());
    }
    let start_sample = (start_ms * SAMPLE_RATE as f64 / 1000.0).round() as u64;
    let end_sample = (end_ms * SAMPLE_RATE as f64 / 1000.0).round() as u64;
    if end_sample > (duration * SAMPLE_RATE as f64).ceil() as u64 {
        return Err("分段结束时间超过音频总时长".into());
    }
    if end_sample <= start_sample {
        return Err("分段时间范围至少需要一个音频采样点".into());
    }
    let total_samples = end_sample - start_sample;
    if total_samples > MAX_PART_MS * SAMPLE_RATE / 1000 {
        return Err("每个分段最多 30 分钟，请缩短时间范围".into());
    }
    Ok(SeekPlan {
        start_sample,
        total_samples,
        max_bytes: total_samples * 2,
    })
}

fn seconds_arg(samples: u64) -> String {
    // One 16 kHz sample is exactly 0.0000625 seconds. Seven decimal places
    // preserve the JS planner's boundaries without per-part millisecond drift.
    format!(
        "{}.{:07}",
        samples / SAMPLE_RATE,
        (samples % SAMPLE_RATE) * 625
    )
}

fn prepare_part(source: &AudioSource, plan: SeekPlan, epoch: u64) -> Result<PartInfo, String> {
    let _guard = source
        .prepare_lock
        .lock()
        .map_err(|_| "音频分段状态不可用")?;
    let cancelled = || {
        source.closed.load(Ordering::SeqCst) || source.cancel_epoch.load(Ordering::SeqCst) != epoch
    };
    if cancelled() {
        return Err("音频分段已取消".into());
    }
    if source.parts.lock().map_err(|_| "音频缓存状态不可用")?.len() >= MAX_CACHED_PARTS {
        return Err("请先释放已完成分段的音频缓存".into());
    }
    if source
        .path
        .metadata()
        .map_err(|_| "原音频文件已不可用")?
        .len()
        != source.file_size
    {
        return Err("原音频文件已更改，请重新选择文件".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let path = source.cache_dir.join(format!("{id}.pcm"));
    drop(private_file(&path)?);
    let result = (|| {
        let mut command = Command::new(&source.ffmpeg);
        command.args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            &seconds_arg(plan.start_sample),
            "-accurate_seek",
        ]);
        input_options(&mut command, &source.path, source.format);
        command.args([
            "-t",
            &seconds_arg(plan.total_samples),
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
        ]);
        // Fill timestamp gaps instead of collapsing them; trim at the exact
        // requested sample limit even when a decoder emits an oversized frame.
        command
            .args([
                "-af",
                &format!(
                    "aresample=16000:async=1:first_pts=0,atrim=end_sample={}",
                    plan.max_bytes / 2
                ),
                "-c:a",
                "pcm_s16le",
                "-f",
                "s16le",
            ])
            .arg(&path)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let status = run_bounded(
            &mut command,
            &[(&path, plan.max_bytes)],
            Duration::from_secs(120),
            cancelled,
        )?;
        if !status.success() {
            return Err(format!(
                "音频分段解码失败，请尝试缩短范围；{MANUAL_FALLBACK}"
            ));
        }
        if cancelled() {
            return Err("音频分段已取消".into());
        }
        let bytes = path
            .metadata()
            .map_err(|e| format!("无法读取音频分段：{e}"))?
            .len();
        if bytes == 0 || bytes % 2 != 0 || bytes > plan.max_bytes {
            return Err("该时间范围未解码出有效音频，请调整分段时间".into());
        }
        let total_samples = bytes / 2;
        source
            .parts
            .lock()
            .map_err(|_| "音频缓存状态不可用")?
            .insert(
                id.clone(),
                PcmPart {
                    path: path.clone(),
                    total_samples,
                },
            );
        Ok(PartInfo {
            id,
            total_samples,
            sample_rate: SAMPLE_RATE,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

struct PreparingGuard(Arc<AudioSource>);
impl Drop for PreparingGuard {
    fn drop(&mut self) {
        self.0.preparing.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn audio_file_prepare_part(
    state: State<'_, AudioFileSourceState>,
    id: String,
    start_ms: f64,
    end_ms: f64,
) -> Result<PartInfo, String> {
    let source = source_for(&state, &id)?;
    let epoch = source.cancel_epoch.load(Ordering::SeqCst);
    let plan = seek_plan(source.duration, start_ms, end_ms)?;
    if source
        .preparing
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("另一个音频分段正在准备，请等待完成或取消".into());
    }
    let guard = PreparingGuard(source);
    tauri::async_runtime::spawn_blocking(move || prepare_part(&guard.0, plan, epoch))
        .await
        .map_err(|e| e.to_string())?
}

fn read_part(
    source: &AudioSource,
    part_id: &str,
    start_sample: u64,
    count: u64,
) -> Result<Vec<u8>, String> {
    if source.closed.load(Ordering::SeqCst) {
        return Err("音频文件已关闭".into());
    }
    if count > MAX_READ_SAMPLES {
        return Err("每次最多读取 16000 个音频采样点".into());
    }
    let parts = source.parts.lock().map_err(|_| "音频缓存状态不可用")?;
    let part = parts.get(part_id).ok_or("音频分段已释放，请重新准备")?;
    if start_sample > part.total_samples {
        return Err("音频读取起点超过分段长度".into());
    }
    let count = count.min(part.total_samples - start_sample);
    let mut file = File::open(&part.path).map_err(|e| format!("无法读取音频缓存：{e}"))?;
    file.seek(SeekFrom::Start(start_sample * 2))
        .map_err(|e| e.to_string())?;
    let mut bytes = vec![0; (count * 2) as usize];
    file.read_exact(&mut bytes)
        .map_err(|e| format!("音频缓存不完整：{e}"))?;
    Ok(bytes)
}

#[tauri::command]
pub async fn audio_file_read_part(
    state: State<'_, AudioFileSourceState>,
    id: String,
    part_id: String,
    start_sample: u64,
    count: u64,
) -> Result<Vec<u8>, String> {
    let source = source_for(&state, &id)?;
    tauri::async_runtime::spawn_blocking(move || read_part(&source, &part_id, start_sample, count))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn audio_file_release_part(
    state: State<'_, AudioFileSourceState>,
    id: String,
    part_id: String,
) -> Result<(), String> {
    // Releasing after a concurrent source-close is intentionally idempotent.
    let source = match source_for(&state, &id) {
        Ok(source) => source,
        Err(_) => return Ok(()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut parts = source.parts.lock().map_err(|_| "音频缓存状态不可用")?;
        if let Some(part) = parts.get(&part_id) {
            match fs::remove_file(&part.path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("无法清理音频缓存：{e}")),
            }
            parts.remove(&part_id);
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn audio_file_cancel_prepare(
    state: State<'_, AudioFileSourceState>,
    id: String,
) -> Result<(), String> {
    if let Ok(source) = source_for(&state, &id) {
        source.cancel_epoch.fetch_add(1, Ordering::SeqCst);
    }
    Ok(())
}

fn close_source(source: &AudioSource) -> Result<(), String> {
    let _guard = source
        .prepare_lock
        .lock()
        .map_err(|_| "音频分段状态不可用")?;
    let mut parts = source.parts.lock().map_err(|_| "音频缓存状态不可用")?;
    match fs::remove_dir_all(&source.cache_dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("无法清理音频缓存：{e}")),
    }
    parts.clear();
    Ok(())
}

#[tauri::command]
pub async fn audio_file_close_source(
    state: State<'_, AudioFileSourceState>,
    id: String,
) -> Result<(), String> {
    let source = state
        .sources
        .lock()
        .map_err(|_| "音频文件状态不可用")?
        .remove(&id);
    let Some(source) = source else {
        return Ok(());
    };
    source.closed.store(true, Ordering::SeqCst);
    source.cancel_epoch.fetch_add(1, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || close_source(&source))
        .await
        .map_err(|e| e.to_string())?
}

// A single response body is capped even when the browser requests the entire
// file (or sends no Range header). All successful GETs therefore use 206.
fn playback_range(range: Option<&str>, length: u64) -> Result<(u64, u64), ()> {
    if length == 0 {
        return Err(());
    }
    let (start, end) = match range {
        None => (0, length - 1),
        Some(range) => {
            let range = range.strip_prefix("bytes=").ok_or(())?;
            if range.contains(',') {
                return Err(());
            }
            let (start, end) = range.split_once('-').ok_or(())?;
            let parse = |s: &str| -> Result<u64, ()> {
                if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(());
                }
                s.parse().map_err(|_| ())
            };
            if start.is_empty() {
                let suffix = parse(end)?;
                if suffix == 0 {
                    return Err(());
                }
                (length.saturating_sub(suffix), length - 1)
            } else {
                let start = parse(start)?;
                let end = if end.is_empty() {
                    length - 1
                } else {
                    parse(end)?.min(length - 1)
                };
                if start >= length || end < start {
                    return Err(());
                }
                (start, end)
            }
        }
    };
    Ok((start, end.min(start.saturating_add(MAX_PLAYBACK_BYTES - 1))))
}

fn protocol_response(status: StatusCode, content_type: &str, bytes: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, bytes.len().to_string())
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(bytes)
        .expect("static audio protocol headers are valid")
}

pub fn serve_audio_source(
    state: &AudioFileSourceState,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let path = request
        .uri()
        .path()
        .strip_prefix('/')
        .unwrap_or(request.uri().path());
    if uuid::Uuid::parse_str(path)
        .map(|id| id.to_string() != path)
        .unwrap_or(true)
    {
        return protocol_response(StatusCode::NOT_FOUND, "text/plain", vec![]);
    }
    let source = match source_for(state, path) {
        Ok(source) => source,
        Err(_) => return protocol_response(StatusCode::NOT_FOUND, "text/plain", vec![]),
    };
    if request.method() != Method::GET && request.method() != Method::HEAD {
        let mut response = protocol_response(StatusCode::METHOD_NOT_ALLOWED, "text/plain", vec![]);
        response
            .headers_mut()
            .insert(header::ALLOW, http::HeaderValue::from_static("GET, HEAD"));
        return response;
    }
    let mut file = match File::open(&source.path) {
        Ok(file)
            if file
                .metadata()
                .map(|m| m.is_file() && m.len() == source.file_size)
                .unwrap_or(false) =>
        {
            file
        }
        _ => return protocol_response(StatusCode::NOT_FOUND, "text/plain", vec![]),
    };
    if request.method() == Method::HEAD {
        let mut response = protocol_response(StatusCode::OK, source.mime, vec![]);
        response.headers_mut().insert(
            header::CONTENT_LENGTH,
            source.file_size.to_string().parse().unwrap(),
        );
        response.headers_mut().insert(
            header::ACCEPT_RANGES,
            http::HeaderValue::from_static("bytes"),
        );
        return response;
    }
    let range = match request.headers().get(header::RANGE) {
        Some(range) => match range.to_str() {
            Ok(range) => Some(range),
            Err(_) => Some(""),
        },
        None => None,
    };
    let (start, end) = match playback_range(range, source.file_size) {
        Ok(range) => range,
        Err(()) => {
            let mut response =
                protocol_response(StatusCode::RANGE_NOT_SATISFIABLE, source.mime, vec![]);
            response.headers_mut().insert(
                header::CONTENT_RANGE,
                format!("bytes */{}", source.file_size).parse().unwrap(),
            );
            return response;
        }
    };
    let mut bytes = vec![0; (end - start + 1) as usize];
    if file
        .seek(SeekFrom::Start(start))
        .and_then(|_| file.read_exact(&mut bytes))
        .is_err()
        || source.closed.load(Ordering::SeqCst)
    {
        return protocol_response(StatusCode::NOT_FOUND, "text/plain", vec![]);
    }
    let mut response = protocol_response(StatusCode::PARTIAL_CONTENT, source.mime, bytes);
    response.headers_mut().insert(
        header::CONTENT_RANGE,
        format!("bytes {start}-{end}/{}", source.file_size)
            .parse()
            .unwrap(),
    );
    response.headers_mut().insert(
        header::ACCEPT_RANGES,
        http::HeaderValue::from_static("bytes"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct TempDirectory(PathBuf);
    impl TempDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("translator-source-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn test_source(
        path: PathBuf,
        cache_dir: PathBuf,
        ffmpeg: PathBuf,
        duration: f64,
    ) -> AudioSource {
        AudioSource {
            file_size: path.metadata().unwrap().len(),
            path,
            cache_dir,
            ffmpeg,
            duration,
            format: "wav",
            mime: "audio/wav",
            closed: AtomicBool::new(false),
            cancel_epoch: AtomicU64::new(0),
            preparing: AtomicBool::new(false),
            prepare_lock: Mutex::new(()),
            parts: Mutex::new(HashMap::new()),
        }
    }

    #[test]
    fn playback_ranges_are_bounded_and_invalid_ranges_are_rejected() {
        assert_eq!(
            playback_range(None, 10_000_000),
            Ok((0, MAX_PLAYBACK_BYTES - 1))
        );
        assert_eq!(playback_range(Some("bytes=100-199"), 1000), Ok((100, 199)));
        assert_eq!(playback_range(Some("bytes=990-"), 1000), Ok((990, 999)));
        assert_eq!(playback_range(Some("bytes=-10"), 1000), Ok((990, 999)));
        assert_eq!(playback_range(Some("bytes=-2000"), 1000), Ok((0, 999)));
        assert_eq!(
            playback_range(Some("bytes=0-9999999"), 10_000_000),
            Ok((0, MAX_PLAYBACK_BYTES - 1))
        );
        for bad in [
            "bytes=1000-",
            "bytes=9-1",
            "bytes=0-1,4-9",
            "bytes=-0",
            "bytes=-",
            "items=0-1",
            "bytes=+0-2",
            "bytes=18446744073709551616-",
        ] {
            assert!(playback_range(Some(bad), 1000).is_err(), "{bad}");
        }
        assert!(playback_range(None, 0).is_err());
    }

    #[test]
    fn seek_plans_keep_source_offsets_and_enforce_part_limits() {
        assert_eq!(
            seek_plan(1860.0, 1_800_000.0, 1_860_000.0).unwrap(),
            SeekPlan {
                start_sample: 28_800_000,
                total_samples: 960_000,
                max_bytes: 1_920_000
            }
        );
        assert_eq!(seconds_arg(28_801_968), "1800.1230000");
        assert_eq!(seconds_arg(1), "0.0000625");
        assert_eq!(
            seek_plan(2.123456, 0.0, 2123.4375).unwrap().total_samples,
            33_975
        );
        assert_eq!(
            seek_plan(1860.0, 1_800_000.0625, 1_801_000.125).unwrap(),
            SeekPlan {
                start_sample: 28_800_001,
                total_samples: 16_001,
                max_bytes: 32_002
            }
        );
        assert!(seek_plan(1860.0, 0.0, 1_800_001.0).is_err());
        assert!(seek_plan(1860.0, 1_860_000.0, 1_860_001.0).is_err());
        assert!(seek_plan(1860.0, 5.0, 5.0).is_err());
        assert!(seek_plan(f64::NAN, 0.0, 1000.0).is_err());
        assert!(seek_plan(MAX_SOURCE_SECONDS + 1.0, 0.0, 1000.0).is_err());
        assert!(seek_plan(60.0, f64::NAN, 1000.0).is_err());
        assert!(seek_plan(60.0, -0.1, 1000.0).is_err());
        assert!(seek_plan(60.0, 0.0, 0.01).is_err());
    }

    #[test]
    fn playback_protocol_scopes_tokens_and_never_returns_a_full_large_file() {
        let dir = TempDirectory::new();
        let path = dir.0.join("source.wav");
        let mut file = File::create(&path).unwrap();
        file.write_all(b"RIFF").unwrap();
        file.set_len(4 * MAX_PLAYBACK_BYTES).unwrap();
        let source = Arc::new(test_source(path, dir.0.join("cache"), PathBuf::new(), 60.0));
        let state = AudioFileSourceState::default();
        let id = uuid::Uuid::new_v4().to_string();
        state
            .sources
            .lock()
            .unwrap()
            .insert(id.clone(), source.clone());
        let request = |method: &str, range: Option<&str>| {
            let mut builder = Request::builder()
                .method(method)
                .uri(format!("audio-source://localhost/{id}"));
            if let Some(range) = range {
                builder = builder.header(header::RANGE, range);
            }
            builder.body(vec![]).unwrap()
        };
        let response = serve_audio_source(&state, request("GET", None));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().len(), MAX_PLAYBACK_BYTES as usize);
        assert_eq!(&response.body()[..4], b"RIFF");
        assert_eq!(
            response.headers()[header::CONTENT_RANGE],
            "bytes 0-1048575/4194304"
        );
        let response = serve_audio_source(&state, request("HEAD", None));
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.body().is_empty());
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "4194304");
        assert_eq!(
            serve_audio_source(&state, request("GET", Some("bytes=99999999-"))).status(),
            StatusCode::RANGE_NOT_SATISFIABLE
        );
        assert_eq!(
            serve_audio_source(&state, request("POST", None)).status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        let escaped = Request::builder()
            .uri("audio-source://localhost/../../etc/passwd")
            .body(vec![])
            .unwrap();
        assert_eq!(
            serve_audio_source(&state, escaped).status(),
            StatusCode::NOT_FOUND
        );
        source.closed.store(true, Ordering::SeqCst);
        assert_eq!(
            serve_audio_source(&state, request("GET", None)).status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn cancellation_before_worker_start_cannot_recreate_closed_cache() {
        let dir = TempDirectory::new();
        let path = dir.0.join("source.wav");
        fs::write(&path, b"file").unwrap();
        let cache = dir.0.join("cache");
        fs::create_dir(&cache).unwrap();
        let source = test_source(path, cache.clone(), PathBuf::new(), 60.0);
        source.cancel_epoch.fetch_add(1, Ordering::SeqCst);
        assert!(
            prepare_part(&source, seek_plan(60.0, 0.0, 1000.0).unwrap(), 0)
                .unwrap_err()
                .contains("取消")
        );
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 0);
        source.closed.store(true, Ordering::SeqCst);
        close_source(&source).unwrap();
        assert!(prepare_part(&source, seek_plan(60.0, 0.0, 1000.0).unwrap(), 1).is_err());
        assert!(!cache.exists());
    }

    #[test]
    fn pcm_reads_are_bounded_and_cannot_escape_the_selected_part() {
        let dir = TempDirectory::new();
        let path = dir.0.join("source.wav");
        fs::write(&path, b"file").unwrap();
        let source = test_source(path, dir.0.join("cache"), PathBuf::new(), 60.0);
        let pcm = dir.0.join("part.pcm");
        fs::write(&pcm, [1, 2, 3, 4, 5, 6]).unwrap();
        source.parts.lock().unwrap().insert(
            "part".into(),
            PcmPart {
                path: pcm,
                total_samples: 3,
            },
        );
        assert_eq!(
            read_part(&source, "part", 1, 100).unwrap(),
            vec![3, 4, 5, 6]
        );
        assert_eq!(read_part(&source, "part", 3, 1).unwrap(), Vec::<u8>::new());
        assert!(read_part(&source, "part", 4, 1).is_err());
        assert!(read_part(&source, "part", 0, MAX_READ_SAMPLES + 1).is_err());
        assert!(read_part(&source, "../source.wav", 0, 1).is_err());
    }

    fn sparse_wav(path: &Path, seconds: u32) {
        let data_bytes = seconds * 48_000 * 2;
        let mut file = File::create(path).unwrap();
        file.write_all(b"RIFF").unwrap();
        file.write_all(&(data_bytes + 36).to_le_bytes()).unwrap();
        file.write_all(b"WAVEfmt ").unwrap();
        file.write_all(&16_u32.to_le_bytes()).unwrap();
        file.write_all(&1_u16.to_le_bytes()).unwrap(); // PCM
        file.write_all(&1_u16.to_le_bytes()).unwrap(); // mono
        file.write_all(&48_000_u32.to_le_bytes()).unwrap();
        file.write_all(&96_000_u32.to_le_bytes()).unwrap();
        file.write_all(&2_u16.to_le_bytes()).unwrap();
        file.write_all(&16_u16.to_le_bytes()).unwrap();
        file.write_all(b"data").unwrap();
        file.write_all(&data_bytes.to_le_bytes()).unwrap();
        file.set_len(44 + data_bytes as u64).unwrap();
        // A distinct constant signal late in the recording verifies seeking
        // retains the original timeline rather than decoding the beginning.
        file.seek(SeekFrom::Start(44 + 1800 * 96_000)).unwrap();
        for _ in 0..48_000 {
            file.write_all(&8192_i16.to_le_bytes()).unwrap();
        }
    }

    #[test]
    fn ffmpeg_reads_a_late_segment_of_a_31_minute_large_sparse_recording() {
        let (Some(ffmpeg), Some(ffprobe)) = (discover_binary("ffmpeg"), discover_binary("ffprobe"))
        else {
            eprintln!("skipping native FFmpeg fixture: FFmpeg/ffprobe not installed");
            return;
        };
        let dir = TempDirectory::new();
        let path = dir.0.join("long.wav");
        sparse_wav(&path, 31 * 60);
        assert!(path.metadata().unwrap().len() > 100 * 1024 * 1024);
        let cache = dir.0.join("cache");
        create_cache_dir(&cache).unwrap();
        let duration = probe_duration(&ffprobe, &path, "wav", &cache).unwrap();
        assert!((duration - 1860.0).abs() < 0.001);
        let source = test_source(path, cache.clone(), ffmpeg.clone(), duration);
        let part = prepare_part(
            &source,
            seek_plan(duration, 1_800_000.0, 1_801_000.0).unwrap(),
            0,
        )
        .unwrap();
        assert_eq!(part.total_samples, 16_000);
        let bytes = read_part(&source, &part.id, 100, 1000).unwrap();
        let samples: Vec<i16> = bytes
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect();
        assert!(samples.iter().all(|sample| (sample - 8192).abs() <= 1));
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 1);
        assert_eq!(
            source.parts.lock().unwrap()[&part.id]
                .path
                .metadata()
                .unwrap()
                .len(),
            32_000
        );
        let fractional = prepare_part(
            &source,
            seek_plan(duration, 1_800_000.0625, 1_801_000.125).unwrap(),
            0,
        )
        .unwrap();
        assert_eq!(fractional.total_samples, 16_001);
        assert_eq!(
            source.parts.lock().unwrap()[&fractional.id]
                .path
                .metadata()
                .unwrap()
                .len(),
            32_002
        );
        // Cancel a real-time paced subprocess after several polling cycles.
        // The guard kills and waits before this function returns.
        let mut command = Command::new(&ffmpeg);
        command.args(["-nostdin", "-v", "error", "-re"]);
        input_options(&mut command, &source.path, source.format);
        command
            .args(["-t", "60", "-f", "null", "-"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let polls = AtomicU64::new(0);
        let started = Instant::now();
        assert!(
            run_bounded(&mut command, &[], Duration::from_secs(5), || polls
                .fetch_add(1, Ordering::SeqCst)
                >= 3)
            .unwrap_err()
            .contains("取消")
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        source.closed.store(true, Ordering::SeqCst);
        close_source(&source).unwrap();
        assert!(!cache.exists());
    }
}
