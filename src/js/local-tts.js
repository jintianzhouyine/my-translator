/**
 * Local offline TTS — Piper (VITS) via Rust (`local_tts_speak`, sherpa-onnx).
 * Fully on-device; the selected voice model must be downloaded first
 * (Settings → TTS → Local). Returns base64 WAV.
 *
 * Same provider contract as the other TTS clients. Bounded queue, drop-oldest.
 */

const { invoke } = window.__TAURI__.core;

const MAX_QUEUE = 10;

class LocalTTS {
    constructor() {
        this.voice = 'vi_VN-vais1000-medium';
        this.speed = 1.0;
        this.isConnected = false;
        this._queue = [];
        this._isSpeaking = false;

        this.onAudioChunk = null;
        this.onError = null;
        this.onStatusChange = null;
    }

    configure({ voice, speed }) {
        if (voice) this.voice = voice;
        if (speed !== undefined && speed !== null) this.speed = speed;
    }

    connect() {
        this.isConnected = true;
        this._setStatus('connected');
    }

    speak(text) {
        if (!text?.trim()) return;
        this._queue.push(text.trim());
        while (this._queue.length > MAX_QUEUE) this._queue.shift();
        if (!this._isSpeaking) this._processQueue();
    }

    async _processQueue() {
        if (this._queue.length === 0) {
            this._isSpeaking = false;
            return;
        }
        this._isSpeaking = true;
        const text = this._queue.shift();
        try {
            const base64Audio = await invoke('local_tts_speak', {
                text,
                voiceId: this.voice || 'vi_VN-vais1000-medium',
                speed: this.speed || 1.0,
            });
            if (base64Audio && this.onAudioChunk) this.onAudioChunk(base64Audio, true);
        } catch (err) {
            console.error('[Local TTS] Error:', err);
            this.onError?.(`本地朗读 错误：${err}`);
        }
        this._processQueue();
    }

    /** Read mode: synthesize one chunk → base64. Bypasses the live queue/callbacks. */
    async synthesize(text) {
        if (!text?.trim()) return null;
        return await invoke('local_tts_speak', {
            text: text.trim(),
            voiceId: this.voice || 'vi_VN-vais1000-medium',
            speed: this.speed || 1.0,
        });
    }

    disconnect() {
        this._queue = [];
        this._isSpeaking = false;
        this.isConnected = false;
        this._setStatus('disconnected');
    }

    _setStatus(status) {
        this.onStatusChange?.(status);
    }
}

export const localTTS = new LocalTTS();
