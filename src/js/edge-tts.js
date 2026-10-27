/**
 * Edge TTS via Rust — Frontend module
 * Calls Rust backend to proxy Edge TTS WebSocket (avoids browser header limitations).
 * Returns base64 MP3 audio, played via audioPlayer.
 */

const { invoke } = window.__TAURI__.core;

class EdgeTTSRust {
    constructor() {
        this.voice = 'vi-VN-HoaiMyNeural';
        this.speed = 20; // percentage: +20% default
        this.isConnected = false;
        this._queue = [];
        this._isSpeaking = false;

        // Same callback interface as other TTS providers
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
        console.log('[Edge TTS] Ready via Rust proxy');
    }

    speak(text) {
        if (!text?.trim()) return;
        this._queue.push(text.trim());
        if (!this._isSpeaking) {
            this._processQueue();
        }
    }

    async _processQueue() {
        if (this._queue.length === 0) {
            this._isSpeaking = false;
            return;
        }

        this._isSpeaking = true;
        const text = this._queue.shift();
        const startTime = performance.now();

        try {
            const base64Audio = await invoke('edge_tts_speak', {
                text: text,
                voice: this.voice,
                rate: this.speed,
            });

            const elapsed = performance.now() - startTime;
            console.log(`[Edge TTS] Audio received in ${elapsed.toFixed(0)}ms`);

            if (this.onAudioChunk) {
                this.onAudioChunk(base64Audio, true);
            }
        } catch (err) {
            console.error('[Edge TTS] Error:', err);
            this.onError?.(`Edge TTS 错误：${err}`);
        }

        // Process next in queue
        this._processQueue();
    }

    /** Read mode: synthesize one chunk → base64. Bypasses the live queue/callbacks. */
    async synthesize(text) {
        if (!text?.trim()) return null;
        return await invoke('edge_tts_speak', {
            text: text.trim(),
            voice: this.voice,
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

export const edgeTTSRust = new EdgeTTSRust();
