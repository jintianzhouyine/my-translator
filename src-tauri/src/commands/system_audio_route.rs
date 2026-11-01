use crate::audio::system_devices::{AudioRoute, SystemAudioRouteState};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn begin_system_audio_route(
    microphone_device: String,
    system_device: String,
    output_device: String,
    app: AppHandle,
) -> Result<AudioRoute, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<SystemAudioRouteState>().begin(
            &microphone_device,
            &system_device,
            &output_device,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn end_system_audio_route(route_id: String, app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<SystemAudioRouteState>().end(&route_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn recover_system_audio_route(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<SystemAudioRouteState>().restore_all())
        .await
        .map_err(|e| e.to_string())?
}
