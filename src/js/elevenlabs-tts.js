/**
 * ElevenLabs TTS — WebSocket streaming client
 * Uses Flash v2.5 model for ultra-low-latency text-to-speech
 */

class ElevenLabsTTS {
    constructor() {
        this.ws = null;
        this.apiKey = null;
        this.voiceId = null;
        this.modelId = 'eleven_flash_v2_5';
        this.outputFormat = 'mp3_44100_128';
        this.isConnected = false;

        // Callbacks
        this.onAudioChunk = null;   // (base64Audio, isFinal) => void
        this.onError = null;        // (errorMsg) => void
        this.onStatusChange = null; // (status) => void  — 'connecting'|'connected'|'disconnected'|'error'

        // Queue text while WS is connecting
        this._textQueue = [];
        this._reconnectAttempts = 0;
        this._maxReconnectAttempts = 3;
        this._intentionalClose = false;

        // Instrumentation
        this._sendTimestamps = {};  // text -> timestamp
        this._stats = { requests: 0, totalTTFB: 0, minTTFB: Infinity, maxTTFB: 0, chunks: 0, totalAudioBytes: 0 };
    }

    /**
     * Configure TTS client (call before connect)
     */
    configure({ apiKey, voiceId }) {
        this.apiKey = apiKey;
        this.voiceId = voiceId || 'FTYCiQT21H9XQvhRu0ch'; // MinhTrung Vietnamese male
    }

    /**
     * Open WebSocket connection to ElevenLabs
     */
    connect() {
        if (!this.apiKey || !this.voiceId) {
            console.warn('[ElevenLabs] Missing apiKey or voiceId');
            return;
        }

        if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
            return; // Already connected or connecting
        }

        this._intentionalClose = false;
        this._setStatus('connecting');

        const url = `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream-input`
            + `?model_id=${this.modelId}`
            + `&output_format=${this.outputFormat}`;

        console.log('[ElevenLabs] Connecting to:', url.replace(/xi-api-key=[^&]+/, 'xi-api-key=***'));

        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
            console.log('[ElevenLabs] WebSocket connected');
            this.isConnected = true;
            this._reconnectAttempts = 0;

            // Send BOS (Beginning of Stream) message with config
            this.ws.send(JSON.stringify({
                text: ' ',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                },
                xi_api_key: this.apiKey,
            }));

            this._setStatus('connected');

            // Flush any queued text
            this._flushQueue();
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                if (data.audio && this.onAudioChunk) {
                    // Measure TTFB for first chunk of each request
                    const pendingKey = Object.keys(this._sendTimestamps)[0];
                    if (pendingKey && this._sendTimestamps[pendingKey]) {
                        const ttfb = performance.now() - this._sendTimestamps[pendingKey];
                        this._stats.requests++;
                        this._stats.totalTTFB += ttfb;
                        this._stats.minTTFB = Math.min(this._stats.minTTFB, ttfb);
                        this._stats.maxTTFB = Math.max(this._stats.maxTTFB, ttfb);
                        console.log(`[ElevenLabs] TTFB: ${ttfb.toFixed(0)}ms for "${pendingKey.substring(0, 40)}..."`);
                        delete this._sendTimestamps[pendingKey];
                    }

                    // Track audio data
                    this._stats.chunks++;
                    this._stats.totalAudioBytes += data.audio.length * 0.75; // base64 -> bytes approx

                    this.onAudioChunk(data.audio, data.isFinal || false);
                }

                if (data.error) {
                    console.error('[ElevenLabs] Server error:', data.error);
                    this.onError?.(`朗读错误：${data.error}`);
                }
            } catch (e) {
                console.warn('[ElevenLabs] Failed to parse message:', e);
            }
        };

        this.ws.onerror = (err) => {
            console.error('[ElevenLabs] WebSocket error:', err);
            this.onError?.('朗读服务连接错误');
            this._setStatus('error');
        };

        this.ws.onclose = (event) => {
            console.log(`[ElevenLabs] WebSocket closed: code=${event.code} reason="${event.reason}"`);
            this.isConnected = false;

            if (this._intentionalClose) {
                this._setStatus('disconnected');
                return;
            }

            // Auto-reconnect on unexpected close
            if (this._reconnectAttempts < this._maxReconnectAttempts) {
                this._reconnectAttempts++;
                const delay = this._reconnectAttempts * 2000;
                console.log(`[ElevenLabs] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})`);
                setTimeout(() => this.connect(), delay);
            } else {
                this._setStatus('disconnected');
                this.onError?.('多次重试后仍无法连接朗读服务');
            }
        };
    }

    /**
     * Send text to be spoken. Handles queueing if WS not ready.
     * @param {string} text - Text to speak
     */
    speak(text) {
        if (!text?.trim()) return;

        if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
            this._sendText(text);
        } else {
            // Queue and connect if needed
            this._textQueue.push(text);
            if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
                this.connect();
            }
        }
    }

    /**
     * Send text chunk to ElevenLabs
     */
    _sendText(text) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        // Record send timestamp for TTFB measurement
        this._sendTimestamps[text] = performance.now();

        this.ws.send(JSON.stringify({
            text: text + ' ',  // trailing space helps with prosody
            flush: true,       // force immediate generation (don't wait for more text)
        }));
    }

    /**
     * Flush queued text
     */
    _flushQueue() {
        while (this._textQueue.length > 0) {
            const text = this._textQueue.shift();
            this._sendText(text);
        }
    }

    /**
     * Gracefully disconnect
     */
    disconnect() {
        this._intentionalClose = true;
        this._textQueue = [];

        // Log stats before disconnect
        if (this._stats.requests > 0) {
            const avgTTFB = this._stats.totalTTFB / this._stats.requests;
            console.log(`[ElevenLabs] Session stats:`);
            console.log(`  Requests: ${this._stats.requests}`);
            console.log(`  TTFB avg: ${avgTTFB.toFixed(0)}ms, min: ${this._stats.minTTFB.toFixed(0)}ms, max: ${this._stats.maxTTFB.toFixed(0)}ms`);
            console.log(`  Audio chunks: ${this._stats.chunks}`);
            console.log(`  Audio data: ${(this._stats.totalAudioBytes / 1024).toFixed(1)}KB`);
        }

        if (this.ws) {
            // Send EOS (End of Stream)
            if (this.ws.readyState === WebSocket.OPEN) {
                try {
                    this.ws.send(JSON.stringify({ text: '' }));
                } catch (e) {
                    // Ignore send errors during close
                }
            }
            this.ws.close();
            this.ws = null;
        }

        this.isConnected = false;
        this._reconnectAttempts = 0;
        this._setStatus('disconnected');
    }

    _setStatus(status) {
        this.onStatusChange?.(status);
    }
}

export const elevenLabsTTS = new ElevenLabsTTS();
