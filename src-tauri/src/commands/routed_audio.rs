use crate::audio::routed::{self, AudioDeviceList, CaptureEvent, RoutedAudioState};
use tauri::{ipc::Channel, AppHandle, Manager, State};

#[tauri::command]
pub fn list_audio_devices() -> Result<AudioDeviceList, String> {
    routed::list_devices()
}

#[tauri::command]
pub async fn start_duplex_capture(
    microphone_device: String,
    system_device: String,
    capture_microphone: Option<bool>,
    on_audio: Channel<CaptureEvent>,
    app: AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RoutedAudioState>();
        let legacy = app.state::<super::audio::AudioState>();
        let _operation = state.operation.lock().map_err(|e| e.to_string())?;
        super::audio::stop_capture_inner(&legacy);
        state.start_capture(
            microphone_device,
            system_device,
            capture_microphone.unwrap_or(true),
            on_audio,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn stop_duplex_capture(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RoutedAudioState>();
        let _operation = state.operation.lock().map_err(|e| e.to_string())?;
        state.stop_capture();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn start_translation_output(
    device_id: String,
    on_error: Channel<String>,
    app: AppHandle,
) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RoutedAudioState>();
        let _operation = state.operation.lock().map_err(|e| e.to_string())?;
        state.start_output(device_id, on_error)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn write_translation_audio(
    output_id: u64,
    pcm: Vec<u8>,
    state: State<'_, RoutedAudioState>,
) -> Result<(), String> {
    state.write_output(output_id, &pcm)
}

#[tauri::command]
pub async fn stop_translation_output(output_id: u64, app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RoutedAudioState>();
        let _operation = state.operation.lock().map_err(|e| e.to_string())?;
        state.stop_output(output_id)
    })
    .await
    .map_err(|e| e.to_string())?
}
