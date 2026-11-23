use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const WINDOW_LABEL: &str = "desktop-subtitle";

/// Only the selected visible text crosses into the subtitle webview.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(default)]
pub struct DesktopSubtitlePayload {
    pub enabled: bool,
    pub original: String,
    pub translation: String,
    pub speaker: String,
    pub locked: bool,
    pub appearance: DesktopSubtitleAppearance,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct DesktopSubtitleAppearance {
    pub opacity: f64,
    pub font_family: String,
    pub font_size: u32,
    pub color: String,
    pub bold: bool,
    pub italic: bool,
}

impl Default for DesktopSubtitleAppearance {
    fn default() -> Self {
        Self {
            opacity: 1.0,
            font_family: "system".to_string(),
            font_size: 32,
            color: "#fff4a8".to_string(),
            bold: true,
            italic: false,
        }
    }
}

impl DesktopSubtitleAppearance {
    fn normalized(mut self) -> Self {
        self.opacity = if self.opacity.is_finite() {
            self.opacity.clamp(0.2, 1.0)
        } else {
            1.0
        };
        self.font_size = self.font_size.clamp(16, 64);
        if !matches!(
            self.font_family.as_str(),
            "system" | "sans" | "serif" | "mono"
        ) {
            self.font_family = "system".to_string();
        }
        let color = self.color.as_bytes();
        if color.len() != 7 || color[0] != b'#' || !color[1..].iter().all(u8::is_ascii_hexdigit) {
            self.color = "#fff4a8".to_string();
        }
        self
    }
}

#[derive(Default)]
pub struct DesktopSubtitleState(pub Mutex<DesktopSubtitlePayload>, tokio::sync::Mutex<()>);

fn hide_and_notify(app: &AppHandle) -> Result<(), String> {
    app.state::<DesktopSubtitleState>()
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .enabled = false;
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window.hide().map_err(|error| error.to_string())?;
    }
    app.emit_to("main", "desktop-subtitle-closed", ())
        .map_err(|error| error.to_string())
}

/// Called asynchronously so creating the webview never blocks the UI thread.
#[tauri::command]
pub async fn set_desktop_subtitle(
    app: AppHandle,
    state: State<'_, DesktopSubtitleState>,
    payload: DesktopSubtitlePayload,
) -> Result<(), String> {
    let _update = state.1.lock().await;
    let payload = DesktopSubtitlePayload {
        appearance: payload.appearance.normalized(),
        ..payload
    };
    *state.0.lock().map_err(|error| error.to_string())? = payload.clone();

    if !payload.enabled {
        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            window.hide().map_err(|error| error.to_string())?;
        }
        return Ok(());
    }

    let window = match app.get_webview_window(WINDOW_LABEL) {
        Some(window) => window,
        None => {
            let monitor = app
                .get_webview_window("main")
                .and_then(|window| window.current_monitor().ok().flatten())
                .or_else(|| app.primary_monitor().ok().flatten());
            let mut builder = WebviewWindowBuilder::new(
                &app,
                WINDOW_LABEL,
                WebviewUrl::App("desktop-subtitle.html".into()),
            )
            .title("桌面字幕")
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .focused(false)
            .focusable(false)
            .accept_first_mouse(true)
            .visible(false)
            .shadow(false)
            .resizable(true)
            .maximizable(false)
            .minimizable(false)
            .inner_size(900.0, 180.0)
            .min_inner_size(320.0, 120.0);
            if let Some(monitor) = monitor {
                let scale = monitor.scale_factor();
                let area = monitor.work_area();
                let width = (f64::from(area.size.width) / scale - 32.0).clamp(320.0, 900.0);
                let x = f64::from(area.position.x) / scale
                    + (f64::from(area.size.width) / scale - width) / 2.0;
                let y = f64::from(area.position.y) / scale
                    + (f64::from(area.size.height) / scale - 180.0 - 40.0).max(0.0);
                builder = builder.inner_size(width, 180.0).position(x, y);
            }
            let window = builder.build().map_err(|error| error.to_string())?;
            let close_app = app.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Err(error) = hide_and_notify(&close_app) {
                        eprintln!("[desktop subtitle] {error}");
                    }
                }
            });
            window
        }
    };
    window
        .set_resizable(!payload.locked)
        .map_err(|error| error.to_string())?;
    window
        .set_ignore_cursor_events(payload.locked)
        .map_err(|error| error.to_string())?;
    app.emit_to(WINDOW_LABEL, "desktop-subtitle-update", &payload)
        .map_err(|error| error.to_string())?;
    if !window.is_visible().map_err(|error| error.to_string())? {
        window.show().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Read after registering the event listener, covering updates sent while loading.
#[tauri::command]
pub fn get_desktop_subtitle(
    state: State<'_, DesktopSubtitleState>,
) -> Result<DesktopSubtitlePayload, String> {
    Ok(state.0.lock().map_err(|error| error.to_string())?.clone())
}

#[tauri::command]
pub fn close_desktop_subtitle(app: AppHandle) -> Result<(), String> {
    hide_and_notify(&app)
}

/// Let the main window serialize this change after any in-flight text update.
#[tauri::command]
pub fn lock_desktop_subtitle(app: AppHandle) -> Result<(), String> {
    app.emit_to("main", "desktop-subtitle-lock-requested", ())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{DesktopSubtitleAppearance, DesktopSubtitlePayload};

    #[test]
    fn subtitle_snapshot_preserves_unicode_and_enabled_state() {
        let value = serde_json::json!({
            "enabled": true,
            "original": "你好，世界！",
            "translation": "Hello, world!",
            "speaker": "我"
        });
        let payload: DesktopSubtitlePayload = serde_json::from_value(value.clone()).unwrap();
        let saved = serde_json::to_value(payload).unwrap();
        for (key, expected) in value.as_object().unwrap() {
            assert_eq!(&saved[key], expected);
        }
        assert_eq!(saved["locked"], false);
        assert_eq!(saved["appearance"]["fontSize"], 32);
        assert_eq!(saved["appearance"]["fontFamily"], "system");
        assert_eq!(saved["appearance"]["bold"], true);
        assert!(!DesktopSubtitlePayload::default().enabled);
    }

    #[test]
    fn partial_appearance_keeps_defaults_and_normalizes_unsafe_values() {
        let payload: DesktopSubtitlePayload = serde_json::from_value(serde_json::json!({
            "locked": true,
            "appearance": {"opacity": 0.01, "fontSize": 200, "fontFamily": "unknown", "color": "url(x)"}
        })).unwrap();
        assert!(payload.locked);
        let appearance = payload.appearance.normalized();
        assert_eq!(appearance.opacity, 0.2);
        assert_eq!(appearance.font_size, 64);
        assert_eq!(appearance.font_family, "system");
        assert_eq!(appearance.color, "#fff4a8");
        assert!(appearance.bold);
        assert!(!appearance.italic);
        let invalid_opacity = DesktopSubtitleAppearance {
            opacity: f64::NAN,
            ..DesktopSubtitleAppearance::default()
        };
        assert_eq!(invalid_opacity.normalized().opacity, 1.0);
    }

    #[test]
    fn configured_appearance_and_lock_survive_snapshot_roundtrip() {
        let value = serde_json::json!({
            "enabled": true, "original": "测试", "translation": "Test", "speaker": "我", "locked": true,
            "appearance": {"opacity": 0.6, "fontFamily": "serif", "fontSize": 48, "color": "#Aa88ff", "bold": false, "italic": true}
        });
        let payload: DesktopSubtitlePayload = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(payload.appearance.clone().normalized(), payload.appearance);
        assert_eq!(serde_json::to_value(payload).unwrap(), value);
    }
}
