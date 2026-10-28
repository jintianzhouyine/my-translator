/**
 * Settings Manager — handles loading/saving settings via Tauri IPC
 */

const { invoke } = window.__TAURI__.core;

// Default settings shape
const DEFAULT_SETTINGS = {
  soniox_api_key: '',
  openai_api_key: '',
  qwen_api_key: '',
  qwen_workspace_id: '',
  qwen_region: 'cn-beijing',
  qwen_duplex_enabled: true,
  qwen_my_language: 'zh',
  qwen_peer_language: 'en',
  qwen_microphone_device: '',
  qwen_system_device: '',
  qwen_output_device: '',
  qwen_glossary_outbound: {},
  qwen_glossary_inbound: {},
  source_language: 'auto',
  target_language: 'vi',
  translation_type: 'one_way',
  language_a: 'ja',
  language_b: 'vi',
  language_hints_strict: false,
  endpoint_delay: 3000,
  audio_source: 'system',
  overlay_opacity: 0.85,
  font_size: 16,
  max_lines: 5,
  show_original: true,
  translation_mode: 'soniox',
  custom_context: null,
  elevenlabs_api_key: '',
  tts_enabled: false,
  tts_provider: 'edge',
  tts_voice_id: '21m00Tcm4TlvDq8ikWAM',
  tts_speed: 1.2,
  edge_tts_voice: 'vi-VN-HoaiMyNeural',
  edge_tts_speed: 50,
  tts_auto_read: true,
  // Google Cloud (premium) — kept for parity with backend defaults
  google_tts_api_key: '',
  google_tts_voice: 'vi-VN-Chirp3-HD-Aoede',
  google_tts_speed: 1.0,
  // New free online providers (Trudio-style)
  microsoft_v2_voice: 'vi-VN-HoaiMyNeural',
  microsoft_v2_speed: 20,
  google_free_voice: 'vi-VN',
  google_free_api_key: '',
  google_free_speed: 1.0,
  tiktok_voice: 'BV074_streaming',
  tiktok_speed: 1.0,
  tiktok_session_id: '',
  // Local offline (Piper/sherpa-onnx)
  local_tts_voice: 'vi_VN-vais1000-medium',
  local_tts_speed: 1.0,
  local_tts_models_dir: '',
};

class SettingsManager {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this._listeners = [];
  }

  /**
   * Load settings from Rust backend
   */
  async load() {
    try {
      const settings = await invoke('get_settings');
      this.settings = { ...DEFAULT_SETTINGS, ...settings };
    } catch (err) {
      console.error('Failed to load settings:', err);
      this.settings = { ...DEFAULT_SETTINGS };
    }
    this._notify();
    return this.settings;
  }

  /**
   * Save settings to Rust backend
   */
  async save(newSettings) {
    try {
      const merged = { ...this.settings, ...newSettings };
      await invoke('save_settings', { newSettings: merged });
      this.settings = merged;
      this._notify();
      return true;
    } catch (err) {
      console.error('Failed to save settings:', err);
      throw err;
    }
  }

  /**
   * Get current settings (cached)
   */
  get() {
    return { ...this.settings };
  }

  /**
   * Subscribe to settings changes
   */
  onChange(callback) {
    this._listeners.push(callback);
    return () => {
      this._listeners = this._listeners.filter(l => l !== callback);
    };
  }

  _notify() {
    const settings = this.get();
    this._listeners.forEach(cb => cb(settings));
  }
}

// Singleton
export const settingsManager = new SettingsManager();
