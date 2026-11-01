//! A persisted lease on system audio defaults. Device IDs survive process restarts;
//! no system setting changes until both physical routes and the virtual pair are known.
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};

#[cfg(target_os = "macos")]
#[path = "system_devices/macos.rs"]
mod platform;
#[cfg(target_os = "windows")]
#[path = "system_devices/windows.rs"]
mod platform;

#[derive(Clone, Debug)]
struct Device {
    id: String,
    name: String,
    input: bool,
    output: bool,
    virtual_device: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct DefaultDevice {
    key: String,
    id: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct Snapshot {
    route_id: String,
    defaults: Vec<DefaultDevice>,
    #[serde(default)]
    force_restore: bool,
}

#[derive(Debug)]
enum DeviceChangeError {
    Failed(String),
    Unconfirmed(String),
}
impl From<String> for DeviceChangeError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}
impl From<&str> for DeviceChangeError {
    fn from(message: &str) -> Self {
        Self::Failed(message.into())
    }
}
impl std::fmt::Display for DeviceChangeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Failed(message) | Self::Unconfirmed(message) => f.write_str(message),
        }
    }
}

// HAL changes can complete asynchronously. A stable observation also confirms
// rollback requests submitted while the old default is still visible.
fn confirm_default(
    mut matches: impl FnMut() -> Result<bool, String>,
) -> Result<(), DeviceChangeError> {
    use std::time::{Duration, Instant};
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut stable_since = None;
    loop {
        if matches()
            .map_err(|e| DeviceChangeError::Unconfirmed(format!("音频设备切换无法确认：{e}")))?
        {
            let since = stable_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= Duration::from_millis(100) {
                return Ok(());
            }
        } else {
            stable_since = None;
        }
        if Instant::now() >= deadline {
            return Err(DeviceChangeError::Unconfirmed(
                "等待系统音频设备切换超时，请检查系统声音设置".into(),
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioRoute {
    route_id: String,
    microphone_device: String,
    system_device: String,
}

trait Backend {
    fn devices(&self) -> Result<Vec<Device>, String>;
    fn defaults(&self) -> Result<Vec<DefaultDevice>, String>;
    fn set_default(&self, key: &str, id: &str) -> Result<(), DeviceChangeError>;
    fn paired_input<'a>(
        &self,
        output: &Device,
        devices: &'a [Device],
    ) -> Result<&'a Device, String>;
}

pub struct SystemAudioRouteState {
    operation: Mutex<()>,
    path: PathBuf,
}

impl SystemAudioRouteState {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            operation: Mutex::new(()),
            path: app_data_dir.join("audio-defaults-recovery.json"),
        }
    }

    pub fn begin(
        &self,
        microphone: &str,
        system: &str,
        output: &str,
    ) -> Result<AudioRoute, String> {
        let _lock = self.operation.lock().map_err(|e| e.to_string())?;
        let backend = platform::NativeBackend::new()?;
        self.begin_with(&backend, microphone, system, output)
    }

    pub fn end(&self, route_id: &str) -> Result<(), String> {
        let _lock = self.operation.lock().map_err(|e| e.to_string())?;
        let backend = platform::NativeBackend::new()?;
        self.restore_with(&backend, Some(route_id))
    }

    /// Call before the app exits and on the next launch after an abnormal exit.
    pub fn restore_all(&self) -> Result<(), String> {
        let _lock = self.operation.lock().map_err(|e| e.to_string())?;
        if !self.path.exists() {
            return Ok(());
        }
        let backend = platform::NativeBackend::new()?;
        self.restore_with(&backend, None)
    }

    fn read(&self) -> Result<Option<Snapshot>, String> {
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|e| format!("音频设备恢复记录无法读取，请先检查系统声音设置：{e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("无法读取音频设备恢复记录：{e}")),
        }
    }

    fn save(&self, snapshot: &Snapshot) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("无法创建音频设备恢复目录：{e}"))?;
        }
        let bytes = serde_json::to_vec(snapshot).map_err(|e| e.to_string())?;
        let temporary = self.path.with_extension("tmp");
        use std::io::Write;
        let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|e| e.to_string())?;
        fs::rename(&temporary, &self.path).map_err(|e| format!("无法保存音频设备恢复记录：{e}"))
    }

    fn begin_with(
        &self,
        backend: &impl Backend,
        microphone: &str,
        system: &str,
        output: &str,
    ) -> Result<AudioRoute, String> {
        // Never overwrite a failed recovery record with a new lease.
        self.restore_with(backend, None)?;
        let devices = backend.devices()?;
        let defaults = backend.defaults()?;
        if !defaults.iter().any(|d| is_input(&d.key)) || !defaults.iter().any(|d| !is_input(&d.key))
        {
            return Err("系统默认麦克风或播放设备不可用，请先在系统声音设置中选择可用设备".into());
        }
        let output_device = named_device(&devices, output, false)?;
        let virtual_input = backend.paired_input(output_device, &devices)?;
        let mic = physical_device(&devices, &defaults, microphone, true)?;
        let playback = physical_device(&devices, &defaults, system, false)?;
        let mut restore = defaults.clone();
        for value in &mut restore {
            let device = devices.iter().find(|d| d.id == value.id);
            // An earlier manual cable selection is not a usable restoration target.
            if device.is_some_and(|d| d.virtual_device) {
                value.id = if is_input(&value.key) {
                    &mic.id
                } else {
                    &playback.id
                }
                .clone();
            }
        }
        let snapshot = Snapshot {
            route_id: uuid::Uuid::new_v4().to_string(),
            defaults: restore,
            force_restore: false,
        };
        self.save(&snapshot)?;
        let switching = (|| {
            for value in &defaults {
                let target = if is_input(&value.key) {
                    &virtual_input.id
                } else if devices.iter().any(|d| d.id == value.id && d.virtual_device) {
                    &playback.id
                } else {
                    &value.id
                };
                if value.id != *target {
                    backend.set_default(&value.key, target)?;
                }
            }
            Ok::<(), DeviceChangeError>(())
        })();
        if let Err(error) = switching {
            let uncertain = matches!(error, DeviceChangeError::Unconfirmed(_));
            let save_error = if uncertain {
                let mut pending = snapshot.clone();
                pending.force_restore = true;
                self.save(&pending).err()
            } else {
                None
            };
            // Force rollback and keep the journal when the OS might complete a
            // timed-out switch late. Exit/relaunch will confirm it once more.
            let restored = self.restore_impl(backend, None, uncertain);
            if let Some(save_error) = save_error {
                return Err(format!("无法切换系统音频设备：{error}；恢复记录更新失败：{save_error}；恢复结果：{restored:?}"));
            }
            return match restored {
                Ok(()) => Err(format!("无法切换系统音频设备，已恢复原设置：{error}")),
                Err(restore_error) => {
                    Err(format!("无法切换系统音频设备：{error}；{restore_error}"))
                }
            };
        }
        Ok(AudioRoute {
            route_id: snapshot.route_id,
            microphone_device: mic.name.clone(),
            system_device: playback.name.clone(),
        })
    }

    fn restore_with(&self, backend: &impl Backend, route_id: Option<&str>) -> Result<(), String> {
        self.restore_impl(backend, route_id, false)
    }

    fn restore_impl(
        &self,
        backend: &impl Backend,
        route_id: Option<&str>,
        retain_record: bool,
    ) -> Result<(), String> {
        let Some(snapshot) = self.read()? else {
            return Ok(());
        };
        // A delayed stop from an old call must never restore a newer call's lease.
        if route_id.is_some_and(|id| id != snapshot.route_id) {
            return Ok(());
        }
        let devices = backend.devices()?;
        let current = backend.defaults()?;
        let mut errors = Vec::new();
        for value in &snapshot.defaults {
            if !snapshot.force_restore
                && !retain_record
                && current
                    .iter()
                    .any(|d| d.key == value.key && d.id == value.id)
            {
                continue;
            }
            if !devices.iter().any(|d| d.id == value.id) {
                // A disconnected headset must not trap the user forever. An
                // explicitly selected, available physical default is a valid
                // manual recovery; do not replace it or choose another device.
                let manually_recovered = current
                    .iter()
                    .find(|d| d.key == value.key)
                    .and_then(|default| devices.iter().find(|d| d.id == default.id))
                    .is_some_and(|d| {
                        !d.virtual_device
                            && if is_input(&value.key) {
                                d.input
                            } else {
                                d.output
                            }
                    });
                if manually_recovered {
                    continue;
                }
                errors.push(format!(
                    "原设备已断开（{}），请连接设备或在系统声音设置中手动选择",
                    value.key
                ));
                continue;
            }
            if let Err(error) = backend.set_default(&value.key, &value.id) {
                errors.push(error.to_string());
            }
        }
        if !errors.is_empty() {
            return Err(format!(
                "系统音频设备未能完全恢复：{}。已保留记录，将在下次启动重试",
                errors.join("；")
            ));
        }
        if retain_record {
            return Ok(());
        }
        fs::remove_file(&self.path).map_err(|e| format!("音频设备已恢复，但恢复记录清理失败：{e}"))
    }
}

fn is_input(key: &str) -> bool {
    key.starts_with("input")
}

fn named_device<'a>(devices: &'a [Device], name: &str, input: bool) -> Result<&'a Device, String> {
    let mut matches = devices
        .iter()
        .filter(|d| d.name == name && if input { d.input } else { d.output });
    let device = matches
        .next()
        .ok_or_else(|| format!("找不到音频设备「{name}」，请刷新并重新选择"))?;
    if matches.next().is_some() {
        return Err(format!(
            "存在多个同名设备「{name}」，请在系统中重命名后重新选择"
        ));
    }
    Ok(device)
}

fn physical_device<'a>(
    devices: &'a [Device],
    defaults: &[DefaultDevice],
    name: &str,
    input: bool,
) -> Result<&'a Device, String> {
    let label = if input {
        "真实麦克风"
    } else {
        "会议播放／恢复设备（耳机或扬声器）"
    };
    let device = if name.is_empty() {
        let default = defaults
            .iter()
            .find(|d| is_input(&d.key) == input)
            .ok_or_else(|| format!("没有系统默认设备，请明确选择{label}"))?;
        devices
            .iter()
            .find(|d| d.id == default.id)
            .ok_or_else(|| format!("系统默认设备不可用，请选择{label}"))?
    } else {
        named_device(devices, name, input)?
    };
    if device.virtual_device {
        return Err(format!(
            "请在翻译器中明确选择{label}，不能选择虚拟音频设备或指向它的系统默认设备"
        ));
    }
    Ok(device)
}

#[cfg(test)]
#[path = "system_devices/tests.rs"]
mod tests;
