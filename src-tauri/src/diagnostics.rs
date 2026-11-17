//! Explicit diagnostic events only: no console redirection or raw provider payloads.
use crate::diagnostic_log::DiagnosticLog;
use chrono::{Days, Local};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

struct LogState {
    writer: DiagnosticLog,
    directory: PathBuf,
}

static LOG: OnceLock<LogState> = OnceLock::new();

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticEntry {
    event: String,
    engine: Option<String>,
    source: Option<String>,
    direction: Option<String>,
    state: Option<String>,
    reason: Option<String>,
    mode: Option<String>,
    attempt: Option<u8>,
    generation: Option<u64>,
}

fn allowed<'a>(value: Option<&str>, choices: &'a [&'a str]) -> Option<&'a str> {
    choices
        .iter()
        .copied()
        .find(|choice| Some(*choice) == value)
}

fn format_entry(entry: &DiagnosticEntry) -> Result<(&'static str, &'static str, String), String> {
    let event = allowed(
        Some(&entry.event),
        &[
            "app_started",
            "app_exited",
            "live_started",
            "live_paused",
            "live_failed",
            "state_changed",
            "retry_scheduled",
            "warning",
            "error",
            "session_started",
            "session_closed",
            "session_failed",
        ],
    )
    .ok_or("无效的诊断事件")?;
    let component = allowed(
        entry.engine.as_deref(),
        &["app", "soniox", "openai", "qwen", "local"],
    )
    .unwrap_or("app");
    let level = match event {
        "live_failed" | "error" | "session_failed" => "ERROR",
        "warning" | "retry_scheduled" => "WARN",
        _ => "INFO",
    };
    let mut message = format!(
        "event={event} version={} os={} arch={}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    // Validate again on the native side. Even a direct command invocation cannot
    // persist arbitrary strings, paths, secrets or user speech through these fields.
    for (key, value) in [
        (
            "source",
            allowed(entry.source.as_deref(), &["system", "microphone", "both"]),
        ),
        (
            "direction",
            allowed(entry.direction.as_deref(), &["inbound", "outbound", "none"]),
        ),
        (
            "state",
            allowed(
                entry.state.as_deref(),
                &[
                    "connecting",
                    "connected",
                    "disconnected",
                    "error",
                    "stopping",
                ],
            ),
        ),
        (
            "reason",
            allowed(
                entry.reason.as_deref(),
                &[
                    "auth",
                    "quota",
                    "rate_limit",
                    "configuration",
                    "backpressure",
                    "capture",
                    "output",
                    "timeout",
                    "network",
                    "provider",
                    "unknown",
                    "requested",
                    "auto_failure",
                    "app_exit",
                ],
            ),
        ),
        (
            "mode",
            allowed(entry.mode.as_deref(), &["caption", "duplex"]),
        ),
    ] {
        if let Some(value) = value {
            message.push_str(&format!(" {key}={value}"));
        }
    }
    if let Some(attempt) = entry.attempt.filter(|value| *value <= 3) {
        message.push_str(&format!(" attempt={attempt}"));
    }
    if let Some(generation) = entry
        .generation
        .filter(|value| *value <= 9_007_199_254_740_991)
    {
        message.push_str(&format!(" generation={generation}"));
    }
    Ok((level, component, message))
}

fn earliest_date() -> String {
    (Local::now().date_naive() - Days::new(6))
        .format("%Y-%m-%d")
        .to_string()
}

fn write_entry(entry: DiagnosticEntry) -> Result<(), String> {
    let log = LOG.get().ok_or("诊断日志目录尚未初始化")?;
    let (level, component, message) = format_entry(&entry)?;
    let now = Local::now();
    let earliest = (now.date_naive() - Days::new(6))
        .format("%Y-%m-%d")
        .to_string();
    log.writer
        .write(
            &now.format("%Y-%m-%d").to_string(),
            &earliest,
            &now.format("%Y-%m-%dT%H:%M:%S%.3f%:z").to_string(),
            level,
            component,
            &message,
        )
        .map_err(|error| format!("无法写入诊断日志：{error}"))
}

pub fn init(directory: PathBuf) -> Result<(), String> {
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建诊断日志目录：{error}"))?;
    LOG.set(LogState {
        writer: DiagnosticLog::new(directory.clone()),
        directory,
    })
    .map_err(|_| "诊断日志已经初始化")?;
    // Maintenance also runs while the app is idle; writes and opening the folder
    // perform cleanup too, so a wake from sleep does not require a new session.
    let _ = std::thread::Builder::new()
        .name("diagnostic-log-cleanup".into())
        .spawn(|| loop {
            std::thread::sleep(Duration::from_secs(3600));
            if let Some(log) = LOG.get() {
                let _ = log.writer.cleanup(&earliest_date());
            }
        });
    write_entry(DiagnosticEntry {
        event: "app_started".into(),
        engine: Some("app".into()),
        ..Default::default()
    })
}

pub fn record_native_event(engine: &str, event: &str, reason: Option<&str>) {
    let _ = write_entry(DiagnosticEntry {
        event: event.into(),
        engine: Some(engine.into()),
        reason: reason.map(str::to_owned),
        ..Default::default()
    });
}

pub fn record_native_failure(engine: &str, message: &str) {
    // Only the category is retained; raw messages can contain provider inputs.
    let text = message.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|needle| text.contains(needle));
    let reason = if has(&["401", "403", "invalidapikey", "unauthorized", "鉴权"]) {
        "auth"
    } else if has(&["402", "insufficient_quota", "余额", "欠费"]) {
        "quota"
    } else if has(&["429", "throttl", "rate_limit", "限流"]) {
        "rate_limit"
    } else if has(&["积压", "backpressure"]) {
        "backpressure"
    } else if has(&["capture", "采集", "麦克风"]) {
        "capture"
    } else if has(&["输出", "playback"]) {
        "output"
    } else if has(&["timeout", "超时", "timed out"]) {
        "timeout"
    } else if has(&["connection", "socket", "network", "连接", "断开"]) {
        "network"
    } else {
        "unknown"
    };
    record_native_event(engine, "session_failed", Some(reason));
}

#[tauri::command]
pub fn write_diagnostic_event(entry: DiagnosticEntry) -> Result<(), String> {
    write_entry(entry)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLogInfo {
    directory: String,
    retention_days: u8,
}

#[tauri::command]
pub fn get_diagnostic_log_info() -> Result<DiagnosticLogInfo, String> {
    let log = LOG
        .get()
        .ok_or("诊断日志目录不可用，请检查应用数据目录的写入权限")?;
    std::fs::create_dir_all(&log.directory).map_err(|error| error.to_string())?;
    log.writer
        .cleanup(&earliest_date())
        .map_err(|error| error.to_string())?;
    Ok(DiagnosticLogInfo {
        directory: log.directory.to_string_lossy().into(),
        retention_days: 7,
    })
}

#[tauri::command]
pub fn open_diagnostic_log_dir() -> Result<(), String> {
    let info = get_diagnostic_log_info()?;
    #[cfg(target_os = "macos")]
    let command = "open";
    #[cfg(target_os = "windows")]
    let command = "explorer";
    #[cfg(target_os = "linux")]
    let command = "xdg-open";
    std::process::Command::new(command)
        .arg(info.directory)
        .spawn()
        .map_err(|error| format!("无法打开日志目录：{error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_boundary_discards_non_whitelisted_payloads() {
        let entry = DiagnosticEntry {
            event: "live_failed".into(),
            engine: Some("qwen".into()),
            reason: Some("private transcript with sk-secret".into()),
            source: Some("C:\\Users\\private\\recording.wav".into()),
            state: Some("error".into()),
            attempt: Some(255),
            ..Default::default()
        };
        let (level, component, message) = format_entry(&entry).unwrap();
        assert_eq!((level, component), ("ERROR", "qwen"));
        assert!(message.contains("state=error"));
        for private in ["sk-secret", "transcript", "Users", "attempt="] {
            assert!(!message.contains(private));
        }
    }

    #[test]
    fn arbitrary_event_names_cannot_be_written() {
        assert!(format_entry(&DiagnosticEntry {
            event: "user speech".into(),
            ..Default::default()
        })
        .is_err());
    }
}
