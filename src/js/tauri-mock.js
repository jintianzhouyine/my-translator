/**
 * Mock Tauri APIs for browser-only UI testing (dev server on :3111).
 * Loaded before app.js. Dev-only: activates ONLY when the real Tauri runtime is
 * absent AND we are on the dev port — so it can never shadow window.__TAURI__ in the
 * packaged app (production origin is tauri://localhost or http://tauri.localhost, no :3111).
 */

if (!window.__TAURI__ && location.port === '3111') {
    console.warn('[tauri-mock] Browser dev mode — Tauri APIs are mocked');

    const mockSettings = {
        translation_mode: 'soniox',
        source_language: 'auto',
        target_language: 'vi',
        soniox_api_key: '',
        elevenlabs_api_key: '',
        google_tts_api_key: '',
        openai_api_key: '',
        qwen_api_key: '',
        tts_provider: 'edge',
        edge_tts_voice: 'vi-VN-HoaiMyNeural',
        edge_tts_speed: 50,
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
        local_tts_voice: 'vi_VN-vais1000-medium',
        local_tts_speed: 1.0,
        local_tts_models_dir: '',
        font_size: 16,
    };

    // Sample local (Piper) voice catalog so the download/delete UI can be exercised.
    const mockLocalVoices = [
        { id: 'vi_VN-vais1000-medium', display: 'Tiếng Việt — VAIS1000 (medium)', lang: 'vi', url: '', approxSizeBytes: 67154040, sampleRate: 22050, installed: true, installedBytes: 67154040, imported: false },
        { id: 'vi_VN-25hours_single-low', display: 'Tiếng Việt — 25 hours (low)', lang: 'vi', url: '', approxSizeBytes: 67059380, sampleRate: 16000, installed: false, installedBytes: null, imported: false },
        { id: 'en_US-ryan-medium', display: 'English (US) — Ryan (medium)', lang: 'en', url: '', approxSizeBytes: 63000000, sampleRate: 22050, installed: true, installedBytes: 63000000, imported: false },
        { id: 'en_US-lessac-medium', display: 'English (US) — Lessac (medium)', lang: 'en', url: '', approxSizeBytes: 67230653, sampleRate: 22050, installed: false, installedBytes: null, imported: false },
        // Sample imported (local) voices — always shown regardless of language filter.
        { id: 'tranthanh3870', display: 'tranthanh3870', lang: '', url: '', approxSizeBytes: 0, sampleRate: 0, installed: true, installedBytes: 63000000, imported: true },
        { id: 'mytam2', display: 'mytam2', lang: '', url: '', approxSizeBytes: 0, sampleRate: 0, installed: true, installedBytes: 63000000, imported: true },
    ];

    // Tiny decodable silent WAV (8kHz mono, ~60ms) so Read mode's reader→player loop can
    // advance in browser dev (empty base64 would fail decodeAudioData → every chunk errors).
    const mockSilentWav = 'UklGRuQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YcADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

    // Sample voices so the Microsoft v2 dynamic-populate path can be exercised in-browser.
    const mockMsVoices = JSON.stringify([
        { short_name: 'vi-VN-HoaiMyNeural', friendly_name: 'HoaiMy', gender: 'Female', locale: 'vi-VN' },
        { short_name: 'vi-VN-NamMinhNeural', friendly_name: 'NamMinh', gender: 'Male', locale: 'vi-VN' },
        { short_name: 'en-US-JennyNeural', friendly_name: 'Jenny', gender: 'Female', locale: 'en-US' },
        { short_name: 'en-US-GuyNeural', friendly_name: 'Guy', gender: 'Male', locale: 'en-US' },
        { short_name: 'en-GB-SoniaNeural', friendly_name: 'Sonia', gender: 'Female', locale: 'en-GB' },
    ]);

    window.__TAURI__ = {
        core: {
            invoke: async (cmd, args) => {
                console.log('[tauri-mock] invoke:', cmd);
                switch (cmd) {
                    case 'get_settings':
                        return mockSettings;
                    case 'save_settings':
                        Object.assign(mockSettings, args?.newSettings || {});
                        return null;
                    case 'get_platform_info':
                        return JSON.stringify({ os: 'macos', arch: 'aarch64', is_arm_hardware: true });
                    case 'list_audio_devices':
                        return {
                            inputs: [{ id: 'MacBook Microphone', name: 'MacBook Microphone', is_default: true }],
                            outputs: [
                                { id: 'Headphones', name: 'Headphones', is_default: true },
                                { id: 'BlackHole 2ch', name: 'BlackHole 2ch', is_default: false },
                            ],
                            supports_system_device_selection: false,
                        };
                    case 'microsoft_list_voices':
                        return mockMsVoices;
                    case 'local_tts_list_models':
                        return mockLocalVoices;
                    case 'local_tts_models_dir_path':
                        return mockSettings.local_tts_models_dir ||
                            '/Users/dev/Library/Application Support/com.personal.translator/piper-models';
                    case 'local_tts_download_model': {
                        // Simulate progress then mark installed.
                        const ch = args?.onProgress;
                        const id = args?.id;
                        if (ch && typeof ch.onmessage === 'function') {
                            [25, 50, 75, 100].forEach((pct) =>
                                ch.onmessage({ id, phase: 'downloading', received: pct, total: 100, message: null })
                            );
                            ch.onmessage({ id, phase: 'done', received: 100, total: 100, message: null });
                        }
                        const v = mockLocalVoices.find((m) => m.id === id);
                        if (v) v.installed = true;
                        return null;
                    }
                    case 'local_tts_delete_model': {
                        const v = mockLocalVoices.find((m) => m.id === args?.id);
                        if (v) v.installed = false;
                        return null;
                    }
                    // TTS synth commands: return a tiny decodable silent WAV so Read mode's
                    // reader→player loop can advance in browser dev (real audio only in Tauri).
                    case 'edge_tts_speak':
                    case 'google_free_tts_speak':
                    case 'tiktok_tts_speak':
                    case 'local_tts_speak':
                        return mockSilentWav;
                    case 'start_capture':
                    case 'stop_capture':
                    case 'start_mic_capture':
                    case 'stop_mic_capture':
                        return null;
                    case 'list_transcripts':
                    case 'list_sessions':
                    case 'search_sessions':
                        return [];
                    case 'check_update':
                        return null;
                    default:
                        console.warn('[tauri-mock] unhandled command:', cmd);
                        return null;
                }
            },
            Channel: class {
                constructor() { this.onmessage = null; }
            },
        },
        dialog: {
            // Browser dev: pretend the user picked a folder (null would mean "cancelled").
            open: async () => '/Users/dev/piper-models',
        },
        opener: { openUrl: async (url) => window.open(url, '_blank', 'noopener,noreferrer') },
        window: {
            getCurrentWindow: () => ({
                setAlwaysOnTop: async () => {},
                outerPosition: async () => ({ x: 100, y: 100 }),
                innerSize: async () => ({ width: 800, height: 600 }),
                scaleFactor: async () => 1,
                setPosition: async () => {},
                setSize: async () => {},
                onCloseRequested: async () => () => {},
                listen: async () => () => {},
                close: async () => { window.close(); },
                minimize: async () => {},
                toggleMaximize: async () => {},
            }),
            LogicalSize: class {
                constructor(width, height) { this.width = width; this.height = height; }
            },
        },
    };
}
