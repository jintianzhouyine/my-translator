use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// Translation term: source → target mapping for Soniox
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranslationTerm {
    pub source: String,
    pub target: String,
}

/// Custom context for Soniox — provides domain-specific hints
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct CustomContext {
    pub domain: Option<String>,
    pub general: Vec<ContextEntry>,
    pub text: Option<String>,
    pub terms: Vec<String>,
    pub translation_terms: Vec<TranslationTerm>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ContextEntry {
    pub key: String,
    pub value: String,
}

/// App settings — persisted to JSON
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    /// Soniox API key
    pub soniox_api_key: String,
    /// OpenAI API key (for gpt-realtime-translate)
    pub openai_api_key: String,
    /// Alibaba Cloud DashScope API key (for Qwen LiveTranslate Flash)
    #[serde(default)]
    pub qwen_api_key: String,
    pub qwen_workspace_id: String,
    pub qwen_region: String,
    pub qwen_duplex_enabled: bool,
    pub qwen_my_language: String,
    pub qwen_peer_language: String,
    pub qwen_microphone_device: String,
    pub qwen_system_device: String,
    pub qwen_output_device: String,
    pub qwen_glossary_outbound: BTreeMap<String, String>,
    pub qwen_glossary_inbound: BTreeMap<String, String>,
    /// Source language: "auto" or ISO 639-1 code
    pub source_language: String,
    /// Target language: ISO 639-1 code
    pub target_language: String,
    pub translation_type: String,
    pub language_a: String,
    pub language_b: String,
    pub language_hints_strict: bool,
    pub endpoint_delay: u32,
    /// Audio source: "system" | "microphone" | "both"
    pub audio_source: String,
    /// Overlay opacity: 0.0 - 1.0
    pub overlay_opacity: f64,
    /// Font size in px
    pub font_size: u32,
    /// Max transcript lines to display
    pub max_lines: u32,
    /// Whether to show original text alongside translation
    pub show_original: bool,
    /// Translation mode: "soniox" | "local" | "openai" | "qwen"
    pub translation_mode: String,
    /// Optional custom context for better transcription
    pub custom_context: Option<CustomContext>,
    /// ElevenLabs API key for TTS narration
    pub elevenlabs_api_key: String,
    /// Whether TTS narration is enabled
    pub tts_enabled: bool,
    /// TTS provider: "edge" | "microsoft" | "google-free" | "tiktok" | "google" | "elevenlabs"
    pub tts_provider: String,
    /// ElevenLabs voice ID
    pub tts_voice_id: String,
    /// TTS speed multiplier (Web Speech)
    pub tts_speed: f64,
    /// Edge TTS voice name
    pub edge_tts_voice: String,
    /// Edge TTS speed percentage
    pub edge_tts_speed: i32,
    /// Auto-read new translations aloud
    pub tts_auto_read: bool,
    /// Google Cloud TTS API key
    pub google_tts_api_key: String,
    /// Google TTS voice name
    pub google_tts_voice: String,
    /// Google TTS speaking rate
    pub google_tts_speed: f64,
    /// Microsoft v2 (Edge endpoint, dynamic voice list) selected voice
    pub microsoft_v2_voice: String,
    /// Microsoft v2 speed percentage (reuses edge synth)
    pub microsoft_v2_speed: i32,
    /// Google Free (android-tts) language token, e.g. "vi-VN" | "en-US"
    pub google_free_voice: String,
    /// Optional user Google API key for Google Free. When set, overrides the build-time
    /// GOOGLE_FREE_TTS_KEY. Empty → fall back to the build-time key (if any).
    #[serde(default)]
    pub google_free_api_key: String,
    /// Google Free client-side playback speed (endpoint has no rate param). 1.0 = normal.
    #[serde(default = "default_local_tts_speed")]
    pub google_free_speed: f32,
    /// TikTok TTS speaker code, e.g. "BV074_streaming"
    pub tiktok_voice: String,
    /// TikTok client-side playback speed (endpoint has no rate param). 1.0 = normal.
    #[serde(default = "default_local_tts_speed")]
    pub tiktok_speed: f32,
    /// TikTok sessionid cookie (user-supplied; required by the endpoint)
    pub tiktok_session_id: String,
    /// Local offline (Piper/sherpa-onnx) selected voice id, e.g. "vi_VN-vais1000-medium"
    #[serde(default)]
    pub local_tts_voice: String,
    /// Local offline TTS speed (1.0 = normal). Piper length-scale is applied inversely.
    #[serde(default = "default_local_tts_speed")]
    pub local_tts_speed: f32,
    /// Folder where local TTS models are stored; empty = default app-data location.
    #[serde(default)]
    pub local_tts_models_dir: String,
    /// OpenAI Realtime: when true server generates translated audio.
    /// Default false — speaker → mic feedback loop on shared devices.
    #[serde(default)]
    pub openai_audio_output: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            soniox_api_key: String::new(),
            openai_api_key: String::new(),
            qwen_api_key: String::new(),
            qwen_workspace_id: String::new(),
            qwen_region: "cn-beijing".to_string(),
            qwen_duplex_enabled: true,
            qwen_my_language: "zh".to_string(),
            qwen_peer_language: "en".to_string(),
            qwen_microphone_device: String::new(),
            qwen_system_device: String::new(),
            qwen_output_device: String::new(),
            qwen_glossary_outbound: BTreeMap::new(),
            qwen_glossary_inbound: BTreeMap::new(),
            source_language: "auto".to_string(),
            target_language: "vi".to_string(),
            translation_type: "one_way".to_string(),
            language_a: "ja".to_string(),
            language_b: "vi".to_string(),
            language_hints_strict: false,
            endpoint_delay: 3000,
            audio_source: "system".to_string(),
            overlay_opacity: 0.85,
            font_size: 16,
            max_lines: 5,
            show_original: true,
            translation_mode: "soniox".to_string(),
            custom_context: None,
            elevenlabs_api_key: String::new(),
            tts_enabled: false,
            tts_provider: "edge".to_string(),
            tts_voice_id: "21m00Tcm4TlvDq8ikWAM".to_string(),
            tts_speed: 1.2,
            edge_tts_voice: "vi-VN-HoaiMyNeural".to_string(),
            edge_tts_speed: 50,
            tts_auto_read: true,
            google_tts_api_key: String::new(),
            google_tts_voice: "vi-VN-Chirp3-HD-Aoede".to_string(),
            google_tts_speed: 1.0,
            microsoft_v2_voice: "vi-VN-HoaiMyNeural".to_string(),
            microsoft_v2_speed: 20,
            google_free_voice: "vi-VN".to_string(),
            google_free_api_key: String::new(),
            google_free_speed: 1.0,
            tiktok_voice: "BV074_streaming".to_string(),
            tiktok_speed: 1.0,
            tiktok_session_id: String::new(),
            local_tts_voice: "vi_VN-vais1000-medium".to_string(),
            local_tts_speed: 1.0,
            local_tts_models_dir: String::new(),
            openai_audio_output: false,
        }
    }
}

/// Serde default for `local_tts_speed` (field-level default would give 0.0).
fn default_local_tts_speed() -> f32 {
    1.0
}

/// Get the settings file path
/// ~/Library/Application Support/com.personal.translator/settings.json
fn settings_path() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("com.personal.translator");
    path.push("settings.json");
    path
}

impl Settings {
    /// Load settings from disk, or return defaults
    pub fn load() -> Self {
        let path = settings_path();
        if path.exists() {
            match fs::read_to_string(&path) {
                Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
                Err(_) => Self::default(),
            }
        } else {
            Self::default()
        }
    }

    /// Save settings to disk
    pub fn save(&self) -> Result<(), String> {
        let path = settings_path();

        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config dir: {}", e))?;
        }

        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize: {}", e))?;

        fs::write(&path, json).map_err(|e| format!("Failed to write settings: {}", e))?;

        Ok(())
    }
}

/// Thread-safe settings state managed by Tauri
pub struct SettingsState(pub Mutex<Settings>);

#[cfg(test)]
mod tests {
    use super::Settings;

    #[test]
    fn old_settings_receive_qwen_defaults_without_losing_existing_values() {
        let settings: Settings = serde_json::from_str(
            r#"{"qwen_api_key":"test-key","target_language":"ja","translation_mode":"qwen"}"#,
        )
        .unwrap();
        assert_eq!(settings.qwen_api_key, "test-key");
        assert_eq!(settings.target_language, "ja");
        assert_eq!(settings.qwen_region, "cn-beijing");
        assert!(settings.qwen_duplex_enabled);
        assert_eq!(settings.qwen_my_language, "zh");
        assert!(settings.qwen_output_device.is_empty());
        assert!(settings.qwen_glossary_outbound.is_empty());
    }

    #[test]
    fn directional_glossaries_and_translation_options_survive_roundtrip() {
        let original = serde_json::json!({
            "qwen_workspace_id": "workspace-test",
            "qwen_region": "ap-southeast-1",
            "qwen_duplex_enabled": false,
            "qwen_my_language": "ja",
            "qwen_peer_language": "en",
            "qwen_microphone_device": "microphone-id",
            "qwen_system_device": "headphones-id",
            "qwen_output_device": "virtual-id",
            "qwen_glossary_outbound": {"产品名": "ProductName"},
            "qwen_glossary_inbound": {"ProductName": "产品名"},
            "translation_type": "two_way",
            "language_a": "en",
            "language_b": "zh",
            "language_hints_strict": true,
            "endpoint_delay": 800,
            "custom_context": {
                "general": [{"key": "domain", "value": "software"}],
                "terms": ["ProductName"],
                "text": "产品演示",
                "translation_terms": [{"source": "产品名", "target": "ProductName"}]
            }
        });
        let settings: Settings = serde_json::from_value(original.clone()).unwrap();
        let saved = serde_json::to_value(settings).unwrap();
        for (key, value) in original.as_object().unwrap() {
            if key == "custom_context" {
                for (context_key, context_value) in value.as_object().unwrap() {
                    assert_eq!(&saved[key][context_key], context_value);
                }
            } else {
                assert_eq!(&saved[key], value, "setting {key} was changed");
            }
        }
    }
}
