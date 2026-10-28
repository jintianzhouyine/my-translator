//! Audio routing for a translated call. Each capture has its own PCM timeline.
//! CPAL streams live and are dropped on their owner thread, never in Tauri state.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::ipc::Channel;

const INPUT_RATE: u32 = 16_000;
const OUTPUT_RATE: u32 = 24_000;
const CAPTURE_BATCH_BYTES: usize = 3_200; // 100 ms, mono PCM16
const MAX_OUTPUT_SAMPLES: usize = OUTPUT_RATE as usize * 5;

#[derive(Clone, Serialize)]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Serialize)]
pub struct AudioDeviceList {
    pub inputs: Vec<AudioDeviceInfo>,
    pub outputs: Vec<AudioDeviceInfo>,
    pub supports_system_device_selection: bool,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CaptureEvent {
    Audio { source: String, pcm: Vec<u8> },
    Error { source: String, message: String },
    Stopped,
}

struct CaptureHandle {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    system_device: String,
    microphone_device: Option<String>,
}

struct CaptureRoute {
    system_device: String,
    microphone_device: Option<String>,
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct OutputHandle {
    id: u64,
    device_id: String,
    stop: Arc<AtomicBool>,
    queue: Arc<Mutex<PlaybackQueue>>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for OutputHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Ok(mut queue) = self.queue.lock() {
            queue.samples.clear();
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[derive(Default)]
pub struct RoutedAudioState {
    // Shared by legacy and routed capture commands to serialize device changes.
    pub(crate) operation: Mutex<()>,
    capture: Mutex<Option<CaptureHandle>>,
    output: Mutex<Option<OutputHandle>>,
    next_output_id: AtomicU64,
}

impl RoutedAudioState {
    pub(crate) fn stop_capture(&self) {
        if let Ok(mut capture) = self.capture.lock() {
            // Drop waits for the owner to release streams before a restart.
            *capture = None;
        }
    }

    pub fn start_capture(
        &self,
        microphone_device: String,
        system_device: String,
        capture_microphone: bool,
        on_audio: Channel<CaptureEvent>,
    ) -> Result<(), String> {
        self.stop_capture();
        #[cfg(not(target_os = "windows"))]
        if !system_device.is_empty() {
            return Err("此平台通过系统声音采集，不支持选择回环输出设备".into());
        }

        let active_output = self
            .output
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .map(|output| output.device_id.clone());
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let thread = std::thread::spawn(move || {
            let result = capture_worker(
                &microphone_device,
                &system_device,
                capture_microphone,
                active_output.as_deref(),
                worker_stop.clone(),
                &on_audio,
                &ready_tx,
            );
            if let Err(message) = result {
                // If startup already succeeded, this is a runtime error.
                let _ = ready_tx.try_send(Err(message.clone()));
                if !worker_stop.load(Ordering::Acquire) {
                    let _ = on_audio.send(CaptureEvent::Error {
                        source: "capture".into(),
                        message,
                    });
                }
            }
            worker_stop.store(true, Ordering::Release);
            let _ = on_audio.send(CaptureEvent::Stopped);
        });
        match ready_rx.recv_timeout(Duration::from_secs(15)) {
            Ok(Ok(route)) => {
                *self.capture.lock().map_err(|e| e.to_string())? = Some(CaptureHandle {
                    stop,
                    thread: Some(thread),
                    system_device: route.system_device,
                    microphone_device: route.microphone_device,
                });
                Ok(())
            }
            result => {
                stop.store(true, Ordering::Release);
                // Device initialization can be blocked by an OS permission dialog.
                // Don't block Tauri indefinitely: the worker observes stop before play.
                drop(thread);
                match result {
                    Ok(Err(message)) => Err(message),
                    _ => Err("音频设备启动超时；请检查麦克风和屏幕录制权限后重试".into()),
                }
            }
        }
    }

    pub fn start_output(
        &self,
        device_id: String,
        on_error: Channel<String>,
    ) -> Result<u64, String> {
        if device_id.trim().is_empty() {
            return Err("请选择译音输出设备（虚拟麦克风对应的播放端）".into());
        }
        {
            let capture = self.capture.lock().map_err(|e| e.to_string())?;
            if let Some(capture) = capture.as_ref() {
                if cfg!(target_os = "windows") {
                    validate_routes(Some(&capture.system_device), Some(&device_id))?;
                }
                validate_microphone(capture.microphone_device.as_deref(), Some(&device_id))?;
            }
        }
        let mut output = self.output.lock().map_err(|e| e.to_string())?;
        *output = None;
        let id = self.next_output_id.fetch_add(1, Ordering::Relaxed) + 1;
        let stop = Arc::new(AtomicBool::new(false));
        let queue = Arc::new(Mutex::new(PlaybackQueue::new(OUTPUT_RATE)));
        let worker_stop = stop.clone();
        let worker_queue = queue.clone();
        let selected_device = device_id.clone();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let thread = std::thread::spawn(move || {
            let result = output_worker(
                &selected_device,
                worker_queue,
                worker_stop.clone(),
                on_error.clone(),
                &ready_tx,
            );
            if let Err(error) = result {
                let _ = ready_tx.try_send(Err(error.clone()));
                if !worker_stop.load(Ordering::Acquire) {
                    let _ = on_error.send(error);
                }
            }
            worker_stop.store(true, Ordering::Release);
        });
        match ready_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => {
                *output = Some(OutputHandle {
                    id,
                    device_id,
                    stop,
                    queue,
                    thread: Some(thread),
                });
                Ok(id)
            }
            result => {
                stop.store(true, Ordering::Release);
                drop(thread);
                match result {
                    Ok(Err(error)) => Err(error),
                    _ => Err("译音输出设备启动超时".into()),
                }
            }
        }
    }

    pub fn write_output(&self, id: u64, pcm: &[u8]) -> Result<(), String> {
        let output = self.output.lock().map_err(|e| e.to_string())?;
        let output = output
            .as_ref()
            .filter(|output| output.id == id && !output.stop.load(Ordering::Acquire))
            .ok_or_else(|| "译音输出已停止或会话已失效".to_string())?;
        let mut queue = output.queue.lock().map_err(|e| e.to_string())?;
        if let Err(error) = queue.push_pcm(pcm) {
            queue.samples.clear();
            output.stop.store(true, Ordering::Release);
            return Err(error);
        }
        Ok(())
    }

    pub fn stop_output(&self, id: u64) -> Result<(), String> {
        let mut output = self.output.lock().map_err(|e| e.to_string())?;
        if output.as_ref().map(|output| output.id) == Some(id) {
            *output = None;
        }
        Ok(())
    }
}

pub fn list_devices() -> Result<AudioDeviceList, String> {
    let host = cpal::default_host();
    let default_input = host
        .default_input_device()
        .and_then(|device| device.name().ok());
    let default_output = host
        .default_output_device()
        .and_then(|device| device.name().ok());
    let inputs = describe_devices(
        host.input_devices().map_err(|e| e.to_string())?,
        default_input,
    );
    let outputs = describe_devices(
        host.output_devices().map_err(|e| e.to_string())?,
        default_output,
    );
    Ok(AudioDeviceList {
        inputs,
        outputs,
        supports_system_device_selection: cfg!(target_os = "windows"),
    })
}

fn describe_devices(
    devices: impl Iterator<Item = cpal::Device>,
    default: Option<String>,
) -> Vec<AudioDeviceInfo> {
    devices
        .filter_map(|device| device.name().ok())
        .map(|name| AudioDeviceInfo {
            id: name.clone(),
            is_default: default.as_deref() == Some(name.as_str()),
            name,
        })
        .collect()
}

// CPAL 0.15 exposes no cross-platform persistent device ID. Persist an exact
// device name, reject ambiguous duplicates, and never silently change routing.
fn select_device(input: bool, id: &str, allow_default: bool) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if id.is_empty() && allow_default {
        return if input {
            host.default_input_device()
        } else {
            host.default_output_device()
        }
        .ok_or_else(|| "找不到默认音频设备".into());
    }
    let devices = if input {
        host.input_devices()
    } else {
        host.output_devices()
    }
    .map_err(|e| format!("无法枚举音频设备：{e}"))?;
    let mut matching = devices.filter(|device| device.name().ok().as_deref() == Some(id));
    let selected = matching
        .next()
        .ok_or_else(|| format!("音频设备已不可用：{id}。请刷新并重新选择。"))?;
    if matching.next().is_some() {
        return Err(format!(
            "多个设备使用相同名称“{id}”，请在系统中重命名后重新选择"
        ));
    }
    Ok(selected)
}

fn validate_routes(captured: Option<&str>, output: Option<&str>) -> Result<(), String> {
    if let (Some(captured), Some(output)) = (captured, output) {
        if !captured.is_empty() && captured == output {
            return Err("对方声音设备与译音输出设备不能相同，否则译音会被重复翻译。会议扬声器请选择耳机，译音请选择虚拟音频设备。".into());
        }
    }
    Ok(())
}

fn validate_microphone(microphone: Option<&str>, output: Option<&str>) -> Result<(), String> {
    if let (Some(microphone), Some(output)) = (microphone, output) {
        if microphone == output {
            return Err("你的麦克风不能选择译音输出设备；请选择真实麦克风或耳机麦克风".into());
        }
    }
    Ok(())
}

enum NativeInput {
    Pcm(&'static str, Vec<u8>),
    Error(&'static str, String),
}

fn capture_worker(
    microphone_id: &str,
    system_id: &str,
    capture_microphone: bool,
    output_id: Option<&str>,
    stop: Arc<AtomicBool>,
    on_audio: &Channel<CaptureEvent>,
    ready: &mpsc::SyncSender<Result<CaptureRoute, String>>,
) -> Result<(), String> {
    let (tx, rx) = mpsc::sync_channel(100);
    let overflow = Arc::new(AtomicBool::new(false));
    let (mic_stream, resolved_microphone) = if capture_microphone {
        let device = select_device(true, microphone_id, true)?;
        let name = device.name().map_err(|e| e.to_string())?;
        validate_microphone(Some(&name), output_id)?;
        (
            Some(build_capture_stream(
                &device,
                false,
                "microphone",
                tx.clone(),
                overflow.clone(),
            )?),
            Some(name),
        )
    } else {
        (None, None)
    };

    #[cfg(target_os = "windows")]
    let (system_stream, resolved_system) = {
        let device = select_device(false, system_id, true)?;
        let name = device.name().map_err(|e| e.to_string())?;
        validate_routes(Some(&name), output_id)?;
        let stream = build_capture_stream(&device, true, "system", tx, overflow.clone())?;
        (stream, name)
    };
    #[cfg(target_os = "macos")]
    let (system_capture, system_rx, resolved_system) = {
        let _ = (system_id, output_id);
        let capture = super::SystemAudioCapture::new();
        let receiver = capture.start()?;
        (capture, receiver, String::new())
    };

    if stop.load(Ordering::Acquire) {
        #[cfg(target_os = "macos")]
        system_capture.stop();
        return Ok(());
    }
    if let Some(stream) = &mic_stream {
        stream.play().map_err(|e| format!("麦克风无法启动：{e}"))?;
    }
    #[cfg(target_os = "windows")]
    system_stream
        .play()
        .map_err(|e| format!("对方声音设备无法启动：{e}"))?;
    if ready
        .send(Ok(CaptureRoute {
            system_device: resolved_system,
            microphone_device: resolved_microphone,
        }))
        .is_err()
    {
        #[cfg(target_os = "macos")]
        system_capture.stop();
        return Ok(());
    }

    let mut buffers: HashMap<&'static str, Vec<u8>> = HashMap::new();
    let mut result = (|| {
        while !stop.load(Ordering::Acquire) {
            if overflow.load(Ordering::Acquire) {
                return Err("音频采集积压，已停止以避免翻译过期声音".into());
            }
            match rx.recv_timeout(Duration::from_millis(10)) {
                Ok(NativeInput::Pcm(source, pcm)) => {
                    forward_pcm(source, pcm, &mut buffers, on_audio)?
                }
                Ok(NativeInput::Error(source, error)) => {
                    return Err(format!("{source} 音频设备错误：{error}"))
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("音频采集设备已断开".into())
                }
            }
            #[cfg(target_os = "macos")]
            loop {
                match system_rx.try_recv() {
                    Ok(pcm) => forward_pcm("system", pcm, &mut buffers, on_audio)?,
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        return Err(system_capture
                            .take_error()
                            .unwrap_or_else(|| "系统声音采集已断开".into()))
                    }
                }
            }
        }
        Ok(())
    })();
    // Release producers first, then drain the audio they already captured. A
    // normal Stop must not discard the final <100 ms of either speaker's voice.
    drop(mic_stream);
    #[cfg(target_os = "windows")]
    drop(system_stream);
    #[cfg(target_os = "macos")]
    system_capture.stop();
    if result.is_ok() {
        result = (|| {
            while let Ok(packet) = rx.try_recv() {
                match packet {
                    NativeInput::Pcm(source, pcm) => {
                        forward_pcm(source, pcm, &mut buffers, on_audio)?;
                    }
                    NativeInput::Error(source, message) => {
                        return Err(format!("{source} 音频设备错误：{message}"));
                    }
                }
            }
            #[cfg(target_os = "macos")]
            while let Ok(pcm) = system_rx.try_recv() {
                forward_pcm("system", pcm, &mut buffers, on_audio)?;
            }
            for (source, pcm) in buffers {
                if !pcm.is_empty() {
                    on_audio
                        .send(CaptureEvent::Audio {
                            source: source.into(),
                            pcm,
                        })
                        .map_err(|_| "字幕窗口音频通道已关闭".to_string())?;
                }
            }
            Ok(())
        })();
    }
    // CPAL stream handles drop here on the same owner thread that created them.
    result
}

fn forward_pcm(
    source: &'static str,
    pcm: Vec<u8>,
    buffers: &mut HashMap<&'static str, Vec<u8>>,
    channel: &Channel<CaptureEvent>,
) -> Result<(), String> {
    for pcm in packetize(source, pcm, buffers) {
        channel
            .send(CaptureEvent::Audio {
                source: source.into(),
                pcm,
            })
            .map_err(|_| "字幕窗口音频通道已关闭".to_string())?;
    }
    Ok(())
}

fn packetize(
    source: &'static str,
    pcm: Vec<u8>,
    buffers: &mut HashMap<&'static str, Vec<u8>>,
) -> Vec<Vec<u8>> {
    let buffer = buffers.entry(source).or_default();
    buffer.extend(pcm);
    let mut packets = Vec::new();
    while buffer.len() >= CAPTURE_BATCH_BYTES {
        let remaining = buffer.split_off(CAPTURE_BATCH_BYTES);
        let pcm = std::mem::replace(buffer, remaining);
        packets.push(pcm);
    }
    packets
}

fn build_capture_stream(
    device: &cpal::Device,
    loopback: bool,
    source: &'static str,
    tx: mpsc::SyncSender<NativeInput>,
    overflow: Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    let supported = if loopback {
        device.default_output_config()
    } else {
        device.default_input_config()
    }
    .map_err(|e| format!("无法读取 {source} 设备格式：{e}"))?;
    let config: cpal::StreamConfig = supported.clone().into();
    if config.channels == 0 || config.sample_rate.0 == 0 {
        return Err("设备返回了无效音频格式".into());
    }
    let mut converter = CaptureConverter::new(config.channels as usize, config.sample_rate.0);
    let error_tx = tx.clone();
    let error_overflow = overflow.clone();
    let error = move |error: cpal::StreamError| {
        if error_tx
            .try_send(NativeInput::Error(source, error.to_string()))
            .is_err()
        {
            error_overflow.store(true, Ordering::Release);
        }
    };
    let mut send = move |samples: Vec<f32>| {
        let pcm = converter.convert(&samples);
        if !pcm.is_empty() && tx.try_send(NativeInput::Pcm(source, pcm)).is_err() {
            overflow.store(true, Ordering::Release);
        }
    };
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config,
            move |data: &[f32], _| send(data.to_vec()),
            error,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config,
            move |data: &[i16], _| send(data.iter().map(|&v| v as f32 / 32768.0).collect()),
            error,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config,
            move |data: &[u16], _| {
                send(
                    data.iter()
                        .map(|&v| (v as f32 - 32768.0) / 32768.0)
                        .collect(),
                )
            },
            error,
            None,
        ),
        cpal::SampleFormat::I32 => device.build_input_stream(
            &config,
            move |data: &[i32], _| send(data.iter().map(|&v| v as f32 / 2147483648.0).collect()),
            error,
            None,
        ),
        format => return Err(format!("不支持的 {source} 音频格式：{format:?}")),
    }
    .map_err(|e| format!("无法打开 {source} 音频设备：{e}"))?;
    Ok(stream)
}

struct CaptureConverter {
    channels: usize,
    resampler: LinearResampler,
}

impl CaptureConverter {
    fn new(channels: usize, rate: u32) -> Self {
        Self {
            channels,
            resampler: LinearResampler::new(rate, INPUT_RATE),
        }
    }
    fn convert(&mut self, samples: &[f32]) -> Vec<u8> {
        let mono = samples
            .chunks_exact(self.channels)
            .map(|frame| frame.iter().sum::<f32>() / self.channels as f32);
        self.resampler.push(mono);
        let mut pcm = Vec::new();
        while let Some(sample) = self.resampler.next_sample() {
            pcm.extend_from_slice(&((sample.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
        }
        pcm
    }
}

/// Stateful interpolation preserves fractional position across packet boundaries.
struct LinearResampler {
    samples: VecDeque<f32>,
    phase: f64,
    step: f64,
}

impl LinearResampler {
    fn new(from_rate: u32, to_rate: u32) -> Self {
        Self {
            samples: VecDeque::new(),
            phase: 0.0,
            step: from_rate as f64 / to_rate as f64,
        }
    }
    fn push(&mut self, samples: impl IntoIterator<Item = f32>) {
        self.samples.extend(samples);
    }
    fn next_sample(&mut self) -> Option<f32> {
        let index = self.phase.floor() as usize;
        if index + 1 >= self.samples.len() {
            return None;
        }
        let fraction = (self.phase - index as f64) as f32;
        let sample = self.samples[index] * (1.0 - fraction) + self.samples[index + 1] * fraction;
        self.phase += self.step;
        let consumed = (self.phase.floor() as usize).min(self.samples.len() - 1);
        self.samples.drain(..consumed);
        self.phase -= consumed as f64;
        Some(sample)
    }
}

struct PlaybackQueue {
    samples: VecDeque<f32>,
    phase: f64,
    device_rate: u32,
}

impl PlaybackQueue {
    fn new(device_rate: u32) -> Self {
        Self {
            samples: VecDeque::new(),
            phase: 0.0,
            device_rate,
        }
    }
    fn push_pcm(&mut self, pcm: &[u8]) -> Result<(), String> {
        if pcm.len() % 2 != 0 {
            return Err("译音 PCM 数据长度无效".into());
        }
        if self.samples.len() + pcm.len() / 2 > MAX_OUTPUT_SAMPLES {
            return Err(
                "译音播放积压超过 5 秒，已停止。请检查输出设备或降低讲话速度后重试。".into(),
            );
        }
        self.samples.extend(
            pcm.chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0),
        );
        Ok(())
    }
    fn next_sample(&mut self) -> f32 {
        let index = self.phase.floor() as usize;
        if index + 1 >= self.samples.len() {
            return 0.0;
        }
        let fraction = (self.phase - index as f64) as f32;
        let sample = self.samples[index] * (1.0 - fraction) + self.samples[index + 1] * fraction;
        self.phase += OUTPUT_RATE as f64 / self.device_rate as f64;
        let consumed = (self.phase.floor() as usize).min(self.samples.len() - 1);
        self.samples.drain(..consumed);
        self.phase -= consumed as f64;
        sample
    }
}

fn output_worker(
    device_id: &str,
    queue: Arc<Mutex<PlaybackQueue>>,
    stop: Arc<AtomicBool>,
    on_error: Channel<String>,
    ready: &mpsc::SyncSender<Result<(), String>>,
) -> Result<(), String> {
    let device = select_device(false, device_id, false)?;
    let supported = device
        .default_output_config()
        .map_err(|e| format!("无法读取译音设备格式：{e}"))?;
    let config: cpal::StreamConfig = supported.clone().into();
    if config.channels == 0 || config.sample_rate.0 == 0 {
        return Err("译音设备返回了无效格式".into());
    }
    queue.lock().map_err(|e| e.to_string())?.device_rate = config.sample_rate.0;
    let error_stop = stop.clone();
    let error = move |error: cpal::StreamError| {
        error_stop.store(true, Ordering::Release);
        let _ = on_error.send(format!("译音输出设备错误：{error}"));
    };
    let channels = config.channels as usize;
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => device.build_output_stream(
            &config,
            move |data: &mut [f32], _| {
                if let Ok(mut queue) = queue.try_lock() {
                    for frame in data.chunks_mut(channels) {
                        frame.fill(queue.next_sample());
                    }
                } else {
                    data.fill(0.0);
                }
            },
            error,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_output_stream(
            &config,
            move |data: &mut [i16], _| {
                if let Ok(mut queue) = queue.try_lock() {
                    for frame in data.chunks_mut(channels) {
                        frame.fill((queue.next_sample().clamp(-1.0, 1.0) * 32767.0) as i16);
                    }
                } else {
                    data.fill(0);
                }
            },
            error,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_output_stream(
            &config,
            move |data: &mut [u16], _| {
                if let Ok(mut queue) = queue.try_lock() {
                    for frame in data.chunks_mut(channels) {
                        frame.fill(
                            (queue.next_sample().clamp(-1.0, 1.0) * 32767.0 + 32768.0) as u16,
                        );
                    }
                } else {
                    data.fill(32768);
                }
            },
            error,
            None,
        ),
        format => return Err(format!("不支持的译音输出格式：{format:?}")),
    }
    .map_err(|e| format!("无法打开译音输出设备：{e}"))?;
    if stop.load(Ordering::Acquire) {
        return Ok(());
    }
    stream
        .play()
        .map_err(|e| format!("无法启动译音播放：{e}"))?;
    if ready.send(Ok(())).is_err() {
        return Ok(());
    }
    while !stop.load(Ordering::Acquire) {
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampling_does_not_depend_on_packet_boundaries() {
        let signal: Vec<f32> = (0..4410).map(|v| (v as f32 * 0.13).sin()).collect();
        let mut whole = LinearResampler::new(44100, 16000);
        whole.push(signal.clone());
        let mut expected = Vec::new();
        while let Some(value) = whole.next_sample() {
            expected.push(value);
        }
        let mut chunked = LinearResampler::new(44100, 16000);
        let mut actual = Vec::new();
        for chunk in signal.chunks(127) {
            chunked.push(chunk.iter().copied());
            while let Some(value) = chunked.next_sample() {
                actual.push(value);
            }
        }
        assert_eq!(actual.len(), expected.len());
        for (actual, expected) in actual.iter().zip(&expected) {
            assert!((actual - expected).abs() < 0.00001);
        }
        assert!((actual.len() as i64 - 1600).abs() <= 1);
    }

    #[test]
    fn stereo_input_mixes_channels_before_resampling() {
        let mut converter = CaptureConverter::new(2, 16000);
        let pcm = converter.convert(&[0.5, -0.5, 1.0, 1.0, 0.0, 0.0]);
        assert_eq!(i16::from_le_bytes([pcm[0], pcm[1]]), 0);
        assert_eq!(i16::from_le_bytes([pcm[2], pcm[3]]), 32767);
    }

    #[test]
    fn output_queue_rejects_malformed_or_stale_audio() {
        let mut queue = PlaybackQueue::new(48000);
        assert!(queue.push_pcm(&[1]).is_err());
        assert!(queue.samples.is_empty());
        queue.push_pcm(&vec![0; MAX_OUTPUT_SAMPLES * 2]).unwrap();
        assert!(queue.push_pcm(&[0, 0]).is_err());
        assert_eq!(queue.samples.len(), MAX_OUTPUT_SAMPLES);
    }

    #[test]
    fn playback_interpolates_across_network_chunks_and_silences_underflow() {
        let mut queue = PlaybackQueue::new(48000);
        queue.push_pcm(&[0, 0, 0, 64]).unwrap();
        assert_eq!(queue.next_sample(), 0.0);
        assert_eq!(queue.next_sample(), 0.25);
        assert_eq!(queue.next_sample(), 0.0); // no next sample yet
        queue.push_pcm(&[0, 0]).unwrap();
        assert_eq!(queue.next_sample(), 0.5);
        assert_eq!(queue.next_sample(), 0.25);
    }

    #[test]
    fn loopback_cannot_capture_translation_output() {
        assert!(validate_routes(Some("Headphones"), Some("Virtual Cable")).is_ok());
        assert!(validate_routes(Some("Virtual Cable"), Some("Virtual Cable")).is_err());
        assert!(validate_routes(None, Some("Virtual Cable")).is_ok());
        assert!(validate_microphone(Some("BlackHole 2ch"), Some("BlackHole 2ch")).is_err());
        assert!(validate_microphone(Some("Built-in Microphone"), Some("BlackHole 2ch")).is_ok());
    }

    #[test]
    fn interleaved_callbacks_preserve_two_independent_audio_timelines() {
        let mut buffers = HashMap::new();
        assert!(packetize("microphone", vec![1; 1000], &mut buffers).is_empty());
        let system = packetize("system", vec![2; 6400], &mut buffers);
        assert_eq!(system, vec![vec![2; 3200], vec![2; 3200]]);
        let microphone = packetize("microphone", vec![1; 2300], &mut buffers);
        assert_eq!(microphone, vec![vec![1; 3200]]);
        assert_eq!(buffers["microphone"], vec![1; 100]);
        assert!(buffers["system"].is_empty());
    }
}
