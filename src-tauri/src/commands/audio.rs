use crate::audio::microphone::MicCapture;
use crate::audio::routed::RoutedAudioState;
use crate::audio::SystemAudioCapture;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, AppHandle, Manager};

/// State for tracking active audio captures
pub struct AudioState {
    pub system_audio: Mutex<SystemAudioCapture>,
    pub microphone: Mutex<MicCapture>,
    pub active_receiver: Mutex<Option<AudioForwarder>>,
}

/// Forwards audio from a receiver to a Tauri IPC channel
pub struct AudioForwarder {
    /// Handle to signal stop
    stop_flag: Arc<AtomicBool>,
}

impl AudioForwarder {
    fn stop(&self) {
        self.stop_flag.store(true, Ordering::Release);
    }
}

#[derive(Serialize, Clone)]
pub struct PermissionStatus {
    pub screen_recording: String,
    pub microphone: String,
}

/// Start audio capture and forward data to the frontend via IPC channel
#[tauri::command]
pub async fn start_capture(
    source: String,
    channel: Channel<Vec<u8>>,
    on_error: Channel<String>,
    app: AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AudioState>();
        let routed = app.state::<RoutedAudioState>();
        start_capture_blocking(source, channel, on_error, &state, &routed)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn start_capture_blocking(
    source: String,
    channel: Channel<Vec<u8>>,
    on_error: Channel<String>,
    state: &AudioState,
    routed: &RoutedAudioState,
) -> Result<(), String> {
    let _operation = routed.operation.lock().map_err(|e| e.to_string())?;
    routed.stop_capture();
    // Stop any existing capture first
    stop_capture_inner(state);

    // Every source has an explicit end marker. In "both" mode, losing one source
    // must not be hidden by the other source keeping the merged channel open.
    type CaptureSource = (&'static str, mpsc::Receiver<Vec<u8>>);
    let receivers = (|| -> Result<Vec<CaptureSource>, String> {
        match source.as_str() {
            "system" => Ok(vec![(
                "系统声音",
                state
                    .system_audio
                    .lock()
                    .map_err(|e| e.to_string())?
                    .start()?,
            )]),
            "microphone" => Ok(vec![(
                "麦克风",
                state
                    .microphone
                    .lock()
                    .map_err(|e| e.to_string())?
                    .start()?,
            )]),
            "both" => {
                let system = state
                    .system_audio
                    .lock()
                    .map_err(|e| e.to_string())?
                    .start()?;
                let microphone = state
                    .microphone
                    .lock()
                    .map_err(|e| e.to_string())?
                    .start()?;
                Ok(vec![("系统声音", system), ("麦克风", microphone)])
            }
            _ => Err(format!("Unknown source: {}", source)),
        }
    })();
    let receivers = match receivers {
        Ok(receivers) => receivers,
        Err(error) => {
            // Roll back a system stream if the second source failed to start.
            stop_capture_inner(state);
            return Err(error);
        }
    };

    let stop_flag = Arc::new(AtomicBool::new(false));
    let (sender, receiver) = mpsc::channel();
    for (source, input) in receivers {
        let sender = sender.clone();
        let stopped = stop_flag.clone();
        std::thread::spawn(move || forward_source(input, sender, source, stopped));
    }
    drop(sender);
    let stopped = stop_flag.clone();
    std::thread::spawn(move || {
        forward_audio(
            receiver,
            stopped,
            |pcm| channel.send(pcm).map_err(|_| ()),
            |message| {
                crate::diagnostics::record_native_event("app", "session_failed", Some("capture"));
                let _ = on_error.send(message);
            },
        );
    });

    // Store the forwarder so we can stop it later
    let forwarder = AudioForwarder { stop_flag };
    let mut active = state.active_receiver.lock().map_err(|e| e.to_string())?;
    *active = Some(forwarder);

    Ok(())
}

#[derive(Debug, PartialEq)]
enum CapturePacket {
    Audio(Vec<u8>),
    Stopped(&'static str),
}

fn forward_source(
    receiver: mpsc::Receiver<Vec<u8>>,
    sender: mpsc::Sender<CapturePacket>,
    source: &'static str,
    stopped: Arc<AtomicBool>,
) {
    while !stopped.load(Ordering::Acquire) {
        match receiver.recv_timeout(Duration::from_millis(10)) {
            Ok(pcm) => {
                if sender.send(CapturePacket::Audio(pcm)).is_err() {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if !stopped.load(Ordering::Acquire) {
                    let _ = sender.send(CapturePacket::Stopped(source));
                }
                break;
            }
        }
    }
}

fn forward_audio(
    receiver: mpsc::Receiver<CapturePacket>,
    stopped: Arc<AtomicBool>,
    mut send_audio: impl FnMut(Vec<u8>) -> Result<(), ()>,
    mut report_error: impl FnMut(String),
) {
    let mut buffer = Vec::with_capacity(32000);
    let mut last_flush = Instant::now();
    loop {
        if stopped.load(Ordering::Acquire) {
            if !buffer.is_empty() {
                let _ = send_audio(buffer);
            }
            break;
        }
        let failed = match receiver.recv_timeout(Duration::from_millis(10)) {
            Ok(CapturePacket::Audio(pcm)) => {
                buffer.extend_from_slice(&pcm);
                None
            }
            Ok(CapturePacket::Stopped(source)) => {
                Some(format!("{source}采集已停止，请检查音频设备后重新开始。"))
            }
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Some("音频采集已停止，请检查音频设备后重新开始。".into())
            }
        };
        if let Some(message) = failed {
            // Stop and failure may race. Only the still-active generation reports.
            if !stopped.swap(true, Ordering::AcqRel) {
                if !buffer.is_empty() {
                    let _ = send_audio(buffer);
                }
                report_error(message);
            }
            break;
        }
        if last_flush.elapsed() >= Duration::from_millis(200) && !buffer.is_empty() {
            if send_audio(std::mem::take(&mut buffer)).is_err() {
                stopped.store(true, Ordering::Release);
                break;
            }
            last_flush = Instant::now();
        }
    }
}

/// Stop audio capture
#[tauri::command]
pub async fn stop_capture(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AudioState>();
        let routed = app.state::<RoutedAudioState>();
        let _operation = routed.operation.lock().map_err(|e| e.to_string())?;
        routed.stop_capture();
        stop_capture_inner(&state);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn stop_capture_inner(state: &AudioState) {
    // Stop the forwarder
    if let Ok(mut active) = state.active_receiver.lock() {
        if let Some(forwarder) = active.take() {
            forwarder.stop();
        }
    }

    // Stop system audio
    if let Ok(sys) = state.system_audio.lock() {
        sys.stop();
    }

    // Stop microphone
    if let Ok(mut mic) = state.microphone.lock() {
        mic.stop();
    }
}

/// Check audio capture permissions
#[tauri::command]
pub fn check_permissions() -> PermissionStatus {
    // Note: Actual permission checking on macOS requires Objective-C interop
    // For now, we return "unknown" and permissions will be prompted on first use
    PermissionStatus {
        screen_recording: "unknown".to_string(),
        microphone: "unknown".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_disconnect_preserves_tail_before_its_stop_marker() {
        let (input, receiver) = mpsc::channel();
        let (output, packets) = mpsc::channel();
        input.send(vec![1, 2]).unwrap();
        drop(input);
        forward_source(receiver, output, "麦克风", Arc::new(AtomicBool::new(false)));
        assert_eq!(
            packets.into_iter().collect::<Vec<_>>(),
            vec![
                CapturePacket::Audio(vec![1, 2]),
                CapturePacket::Stopped("麦克风")
            ]
        );
    }

    #[test]
    fn losing_one_source_reports_once_even_while_the_other_channel_is_open() {
        let (sender, receiver) = mpsc::channel();
        sender.send(CapturePacket::Audio(vec![1, 2])).unwrap();
        sender.send(CapturePacket::Stopped("系统声音")).unwrap();
        sender.send(CapturePacket::Stopped("麦克风")).unwrap();
        let stopped = Arc::new(AtomicBool::new(false));
        let mut audio = Vec::new();
        let mut errors = Vec::new();
        forward_audio(
            receiver,
            stopped.clone(),
            |pcm| {
                audio.push(pcm);
                Ok(())
            },
            |message| errors.push(message),
        );
        assert_eq!(audio, vec![vec![1, 2]]);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("系统声音"));
        assert!(stopped.load(Ordering::Acquire));
    }

    #[test]
    fn manual_stop_suppresses_source_and_forwarder_error_notifications() {
        let stopped = Arc::new(AtomicBool::new(true));
        let (input, receiver) = mpsc::channel();
        let (sender, packets) = mpsc::channel();
        drop(input);
        forward_source(receiver, sender, "麦克风", stopped.clone());
        assert_eq!(packets.into_iter().count(), 0);

        let (sender, receiver) = mpsc::channel();
        sender.send(CapturePacket::Stopped("系统声音")).unwrap();
        forward_audio(
            receiver,
            stopped,
            |_| panic!("no captured audio"),
            |_| panic!("user-requested stop must not report an error"),
        );
    }

    #[test]
    fn an_unexpected_complete_disconnect_also_reports_failure() {
        let (sender, receiver) = mpsc::channel();
        drop(sender);
        let stopped = Arc::new(AtomicBool::new(false));
        let mut errors = Vec::new();
        forward_audio(
            receiver,
            stopped,
            |_| Ok(()),
            |message| errors.push(message),
        );
        assert_eq!(errors.len(), 1);
    }
}
