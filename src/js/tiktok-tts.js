/**
 * TikTok TTS — unofficial endpoint via Rust (`tiktok_tts_speak`). Requires a user-supplied
 * TikTok `sessionid` cookie (Settings → TTS → TikTok). Returns base64 MP3.
 *
 * Same provider contract as edge-tts.js. Bounded queue with drop-oldest.
 */

const { invoke } = window.__TAURI__.core;

const MAX_QUEUE = 10;

class TikTokTTS {
    constructor() {
        this.voice = 'BV074_streaming';
        this.sessionId = '';
        this.isConnected = false;
        this._queue = [];
        this._isSpeaking = false;

        this.onAudioChunk = null;
        this.onError = null;
        this.onStatusChange = null;
    }

    configure({ voice, sessionId }) {
        if (voice) this.voice = voice;
        if (sessionId !== undefined) this.sessionId = sessionId;
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
            const base64Audio = await invoke('tiktok_tts_speak', {
                text,
                voice: this.voice || 'BV074_streaming',
                sessionId: this.sessionId || '',
            });
            if (this.onAudioChunk) this.onAudioChunk(base64Audio, true);
        } catch (err) {
            console.error('[TikTok TTS] Error:', err);
            this.onError?.(`TikTok TTS 错误：${err}`);
        }
        this._processQueue();
    }

    /** Read mode: synthesize one chunk → base64. Bypasses the live queue/callbacks. */
    async synthesize(text) {
        if (!text?.trim()) return null;
        return await invoke('tiktok_tts_speak', {
            text: text.trim(),
            voice: this.voice || 'BV074_streaming',
            sessionId: this.sessionId || '',
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

export const tiktokTTS = new TikTokTTS();
