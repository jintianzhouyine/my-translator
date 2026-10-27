/**
 * Microsoft v2 TTS — Trudio-style. Synthesis reuses the existing Rust `edge_tts_speak`
 * command (same readaloud/edge/v1 endpoint); the difference from "Edge TTS — Free" is a
 * dynamically-fetched full voice list (vi + en) via `microsoft_list_voices`.
 *
 * Same provider contract as edge-tts.js: configure/connect/speak/disconnect + callbacks.
 * Queue is bounded with drop-oldest so a slow network can't lag a real-time overlay.
 */

const { invoke } = window.__TAURI__.core;

const MAX_QUEUE = 10;

class MicrosoftTTS {
    constructor() {
        this.voice = 'vi-VN-HoaiMyNeural';
        this.speed = 20; // percent
        this.isConnected = false;
        this._queue = [];
        this._isSpeaking = false;

        this.onAudioChunk = null;
        this.onError = null;
        this.onStatusChange = null;
    }

    configure({ voice, speed }) {
        if (voice) this.voice = voice;
        if (speed !== undefined) this.speed = speed;
    }

    connect() {
        this.isConnected = true;
        this._setStatus('connected');
    }

    /** Fetch full vi+en voice list from Microsoft. Throws on failure (caller uses fallback). */
    async listVoices() {
        const json = await invoke('microsoft_list_voices');
        return JSON.parse(json);
    }

    speak(text) {
        if (!text?.trim()) return;
        this._queue.push(text.trim());
        // Drop-oldest: in a live overlay, stale lines are worse than skipped ones.
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
            const base64Audio = await invoke('edge_tts_speak', {
                text,
                voice: this.voice || 'vi-VN-HoaiMyNeural',
                rate: this.speed,
            });
            if (this.onAudioChunk) this.onAudioChunk(base64Audio, true);
        } catch (err) {
            console.error('[Microsoft v2 TTS] Error:', err);
            this.onError?.(`Microsoft v2 TTS 错误：${err}`);
        }
        this._processQueue();
    }

    /** Read mode: synthesize one chunk → base64. Reuses edge_tts_speak like the live path. */
    async synthesize(text) {
        if (!text?.trim()) return null;
        return await invoke('edge_tts_speak', {
            text: text.trim(),
            voice: this.voice || 'vi-VN-HoaiMyNeural',
            rate: this.speed,
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

export const microsoftTTS = new MicrosoftTTS();
