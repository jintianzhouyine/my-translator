/**
 * Soniox WebSocket Client
 * Connects directly to wss://stt-rt.soniox.com/transcribe-websocket
 * 
 * Features:
 * - Auto-reconnect on transient errors
 * - Seamless session reset every SESSION_DURATION_MS (make-before-break)
 * - Context carryover via context.text field
 * - Speaker diarization
 * - Language identification (per-token language tags)
 * - Connection keepalive (prevents timeout during silence)
 * - Rich context support (general key-value, terms, text, translation_terms)
 * - Confidence score pass-through
 */

const SONIOX_ENDPOINT = 'wss://stt-rt.soniox.com/transcribe-websocket';

// Reconnect settings
const MAX_RECONNECT = 3;
const RECONNECT_DELAY_MS = 2000;
const CONNECT_TIMEOUT_MS = 15000;
const MAX_BUFFERED_AUDIO_BYTES = 16000 * 2 * 5;

// Session reset: 3 minutes
const SESSION_DURATION_MS = 3 * 60 * 1000;

// Keep last N chars of translations for context carryover
const CONTEXT_HISTORY_CHARS = 500;

// Keepalive: send every 15s to prevent timeout when no audio
const KEEPALIVE_INTERVAL_MS = 15000;

export class SonioxClient {
    constructor(options = {}) {
        this._WebSocket = options.WebSocket || globalThis.WebSocket;
        this._setTimeout = options.setTimeout || ((...args) => globalThis.setTimeout(...args));
        this._clearTimeout = options.clearTimeout || (timer => globalThis.clearTimeout(timer));
        this._setInterval = options.setInterval || ((...args) => globalThis.setInterval(...args));
        this._clearInterval = options.clearInterval || (timer => globalThis.clearInterval(timer));
        this._connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
        this._generation = 0;
        this._pending = null;
        this._reconnectTimer = null;
        this.ws = null;
        this.apiKey = '';
        this.isConnected = false;
        this._reconnectAttempts = 0;
        this._config = null;
        this._intentionalDisconnect = false;
        this._sessionTimer = null;
        this._keepaliveTimer = null;
        this._recentTranslations = []; // Rolling buffer of recent translations

        // Callbacks
        this.onOriginal = null;       // (text, speaker, language) => {}
        this.onTranslation = null;    // (text) => {}
        this.onProvisional = null;    // (text, speaker, language) => {}
        this.onStatusChange = null;   // (status) => {}
        this.onError = null;          // (error) => {}
        this.onFatalError = null;     // (message) => {}; caller stops capture on terminal failure
        this.onConfidence = null;     // (avgConfidence) => {}
    }

    /**
     * Connect to Soniox WebSocket
     */
    connect(config) {
        this._resetConnections();
        const { apiKey } = config;
        this.apiKey = apiKey;
        this._config = config;
        this._intentionalDisconnect = false;
        this._reconnectAttempts = 0;
        this._recentTranslations = [];

        if (!apiKey) {
            this._fatal('请先在设置中填写 API 密钥。');
            return;
        }

        this._doConnect(config);
    }

    _doConnect(config, carryoverContext = null) {
        const { apiKey, sourceLanguage, targetLanguage, customContext,
                translationType, languageA, languageB, languageHintsStrict,
                endpointDelay } = config;

        if (this._intentionalDisconnect || this._pending) return;
        const generation = this._generation;
        if (!this.isConnected) this._setStatus('connecting');
        console.log('[Soniox] Connecting to', SONIOX_ENDPOINT);

        let newWs;
        try {
            newWs = new this._WebSocket(SONIOX_ENDPOINT);
            console.log('[Soniox] WebSocket created, readyState:', newWs.readyState);
        } catch (err) {
            console.error('[Soniox] Failed to create WebSocket:', err);
            this._tryReconnect(`创建实时连接失败：${err.message}`);
            return;
        }

        const ownsSocket = () => generation === this._generation && !this._intentionalDisconnect
            && (this.ws === newWs || this._pending?.ws === newWs);
        this._pending = { ws: newWs, timer: this._setTimeout(() => {
            if (ownsSocket()) this._connectionLost(newWs, '实时连接超时');
        }, this._connectTimeoutMs) };

        newWs.onopen = () => {
            if (!ownsSocket()) return;
            console.log('[Soniox] WebSocket OPEN');

            // Build config message
            const configMsg = {
                api_key: apiKey,
                model: 'stt-rt-v5',
                audio_format: 'pcm_s16le',
                sample_rate: 16000,
                num_channels: 1,
                enable_endpoint_detection: true,
                max_endpoint_delay_ms: endpointDelay || 3000,
                enable_speaker_diarization: true,
                enable_language_identification: true,
            };

            // Language hints
            if (sourceLanguage && sourceLanguage !== 'auto') {
                configMsg.language_hints = [sourceLanguage];
            }

            // Language hints strict mode (#4)
            if (languageHintsStrict) {
                configMsg.language_hints_strict = true;
            }

            // Translation config (#5: support one-way and two-way)
            if (translationType === 'two_way' && languageA && languageB) {
                configMsg.translation = {
                    type: 'two_way',
                    language_a: languageA,
                    language_b: languageB,
                };
                // For two-way, set language hints to both languages
                configMsg.language_hints = [languageA, languageB];
            } else if (targetLanguage) {
                configMsg.translation = {
                    type: 'one_way',
                    target_language: targetLanguage,
                };
            }

            // Context: build using new API format (general, text, terms, translation_terms)
            const context = this._buildContext(customContext, carryoverContext);
            if (context) {
                configMsg.context = context;
            }

            try {
                newWs.send(JSON.stringify(configMsg));
            } catch (error) {
                this._connectionLost(newWs, `发送翻译配置失败：${error.message}`);
                return;
            }

            // A failed replacement must leave the current socket available for audio.
            const oldWs = this.ws;
            this._clearTimeout(this._pending.timer);
            this._pending = null;
            this.ws = newWs;
            this.isConnected = true;
            if (oldWs && oldWs !== newWs) this._releaseSocket(oldWs, true);
            this._clearReconnectTimer();
            this._setStatus('connected');
            this._startSessionTimer();
            this._startKeepalive();
        };

        newWs.onmessage = (event) => {
            if (!ownsSocket()) return;
            let data;
            try { data = JSON.parse(event.data); }
            catch (error) {
                console.error('Failed to parse Soniox response:', error);
                return;
            }
            if (!data || typeof data !== 'object') return;
            if (data.error_code) {
                this._handleApiError(data, newWs);
                return;
            }
            // Opening a TCP connection does not prove that the API accepted it.
            // Reset the retry budget only after a successful provider response.
            if (!data.finished) this._reconnectAttempts = 0;
            this._handleResponse(data);
            if (data.finished && ownsSocket()) this._connectionLost(newWs, '翻译会话已结束');
        };

        newWs.onerror = () => {
            if (ownsSocket()) this._connectionLost(newWs, '实时连接发生错误');
        };

        newWs.onclose = (event) => {
            if (!ownsSocket()) return;
            if (event.code === 4001 || event.code === 4003) {
                this._fatal('API 密钥无效，请在设置中检查。');
            } else if (event.code === 4002) {
                this._fatal('订阅异常，请检查你的 Soniox 账户。');
            } else {
                // A server's normal close still interrupts an active translation.
                this._connectionLost(newWs, `连接已关闭（代码：${event.code}）`);
            }
        };
    }

    /**
     * Send raw PCM audio data
     */
    sendAudio(pcmData) {
        const socket = this.ws;
        if (!socket || this._intentionalDisconnect) return;
        if (socket.readyState !== this._WebSocket.OPEN) {
            this._connectionLost(socket, '音频连接已断开');
            return;
        }
        try {
            if (socket.bufferedAmount > MAX_BUFFERED_AUDIO_BYTES) throw new Error('音频发送积压');
            socket.send(pcmData);
        } catch (error) {
            this._connectionLost(socket, `音频发送失败：${error.message}`);
        }
    }

    /** Gracefully disconnect, including pending handshakes and reconnects. */
    disconnect() {
        this._intentionalDisconnect = true;
        this._resetConnections();
        this._setStatus('disconnected');
    }

    _clearReconnectTimer() {
        if (this._reconnectTimer != null) this._clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
    }

    _releaseSocket(socket, graceful = false) {
        if (this._pending?.ws === socket) {
            this._clearTimeout(this._pending.timer);
            this._pending = null;
        }
        if (this.ws === socket) this.ws = null;
        try {
            if (graceful && socket.readyState === this._WebSocket.OPEN) socket.send(new ArrayBuffer(0));
        } catch { /* Closing must still happen when the final send fails. */ }
        try { socket.close(1000, 'Session ended'); } catch { /* Socket already gone. */ }
    }

    _resetConnections() {
        ++this._generation;
        this._clearReconnectTimer();
        this._stopSessionTimer();
        this._stopKeepalive();
        if (this._pending) this._releaseSocket(this._pending.ws);
        if (this.ws) this._releaseSocket(this.ws, true);
        this.isConnected = false;
    }

    _connectionLost(socket, reason) {
        this._releaseSocket(socket);
        this.isConnected = this.ws?.readyState === this._WebSocket.OPEN;
        if (!this.isConnected) {
            this._stopSessionTimer();
            this._stopKeepalive();
            if (this._pending) this._setStatus('connecting');
        }
        this._tryReconnect(reason);
    }

    _fatal(message) {
        if (this._intentionalDisconnect) return;
        this._intentionalDisconnect = true;
        this._resetConnections();
        this._setStatus('error');
        this.onError?.(message);
        this.onFatalError?.(message);
    }

    /**
     * Process Soniox response
     */
    _handleResponse(data) {
        if (!data.tokens || data.tokens.length === 0) return;

        let originalText = '';
        let translationText = '';
        let provisionalText = '';
        let hasEnd = false;
        let speaker = null;
        let language = null;
        let confidenceSum = 0;
        let confidenceCount = 0;

        for (const token of data.tokens) {
            if (token.text === '<end>') {
                hasEnd = true;
                continue;
            }

            if (token.speaker && token.translation_status === 'original') {
                speaker = token.speaker;
            }

            // Capture language from original tokens
            if (token.language && token.translation_status !== 'translation') {
                language = token.language;
            }

            // Track confidence scores for original final tokens
            if (token.confidence !== undefined && token.is_final && token.translation_status === 'original') {
                confidenceSum += token.confidence;
                confidenceCount++;
            }

            if (token.translation_status === 'original') {
                if (token.is_final) {
                    originalText += token.text;
                } else {
                    provisionalText += token.text;
                }
            } else if (token.translation_status === 'translation') {
                if (token.is_final) {
                    translationText += token.text;
                }
            } else if (token.translation_status === 'none') {
                // Third-language speech in two-way mode: treat as original (untranslated)
                if (token.is_final) {
                    originalText += token.text;
                } else {
                    provisionalText += token.text;
                }
            }
        }

        // Emit average confidence for this batch
        if (confidenceCount > 0) {
            const avgConfidence = confidenceSum / confidenceCount;
            this.onConfidence?.(avgConfidence);
        }

        // Emit finalized original text with speaker + language
        if (originalText.trim()) {
            this.onOriginal?.(originalText, speaker, language);
        }

        // Emit translation + store for context carryover
        if (translationText.trim()) {
            this.onTranslation?.(translationText);
            this._addToHistory(translationText);
        }

        // Emit provisional text with speaker + language
        if (provisionalText.trim()) {
            this.onProvisional?.(provisionalText, speaker, language);
        } else if (originalText.trim() || translationText.trim() || hasEnd) {
            this.onProvisional?.('');
        }
    }

    // ─── Session Timer ────────────────────────────────────────

    _startSessionTimer() {
        this._stopSessionTimer();
        this._sessionTimer = this._setTimeout(() => {
            this._sessionTimer = null;
            this._seamlessReset();
        }, SESSION_DURATION_MS);
    }

    _stopSessionTimer() {
        if (this._sessionTimer != null) {
            this._clearTimeout(this._sessionTimer);
            this._sessionTimer = null;
        }
    }

    /**
     * Seamless session reset: open new WS, switch, close old
     * Audio capture continues uninterrupted
     */
    _seamlessReset() {
        if (!this._config || this._intentionalDisconnect || this._pending || this._reconnectTimer != null) return;

        console.log('[Soniox] ♻️ Seamless session reset (every 3 min)');

        // Build carryover context from recent translations
        const carryover = this._getCarryoverContext();

        // Open new connection (make-before-break)
        this._doConnect(this._config, carryover);
    }

    // ─── Keepalive ────────────────────────────────────────────

    _startKeepalive() {
        this._stopKeepalive();
        this._keepaliveTimer = this._setInterval(() => {
            this.sendAudio(JSON.stringify({ type: 'keepalive' }));
        }, KEEPALIVE_INTERVAL_MS);
    }

    _stopKeepalive() {
        if (this._keepaliveTimer != null) {
            this._clearInterval(this._keepaliveTimer);
            this._keepaliveTimer = null;
        }
    }

    // ─── Context Builder ─────────────────────────────────────

    /**
     * Build context object using Soniox API format:
     * - general: array of {key, value} pairs (domain, topic, speakers...)
     * - text: longer unstructured context (carryover, background)
     * - terms: transcription terms (domain-specific words)
     * - translation_terms: array of {source, target} pairs
     */
    _buildContext(customContext, carryoverContext) {
        const context = {};
        let hasContent = false;

        // General key-value pairs
        const general = [];
        if (customContext?.general && Array.isArray(customContext.general)) {
            // New format: array of {key, value}
            general.push(...customContext.general);
        } else if (customContext?.domain) {
            // Legacy format: single domain string → convert to general
            general.push({ key: 'domain', value: customContext.domain });
        }
        if (general.length > 0) {
            context.general = general;
            hasContent = true;
        }

        // Transcription terms (domain-specific words for accuracy)
        if (customContext?.terms && customContext.terms.length > 0) {
            context.terms = customContext.terms;
            hasContent = true;
        }

        // Translation terms
        if (customContext?.translation_terms && customContext.translation_terms.length > 0) {
            context.translation_terms = customContext.translation_terms;
            hasContent = true;
        }

        // Text context: user-provided background + carryover
        const textParts = [];
        if (customContext?.text) {
            textParts.push(customContext.text);
        }
        if (carryoverContext) {
            textParts.push(`Recent conversation: ${carryoverContext}`);
        }
        if (textParts.length > 0) {
            context.text = textParts.join('\n\n');
            hasContent = true;
        }

        return hasContent ? context : null;
    }

    // ─── Context Carryover ────────────────────────────────────

    _addToHistory(text) {
        this._recentTranslations.push(text);
        // Trim to keep under CONTEXT_HISTORY_CHARS
        let total = this._recentTranslations.reduce((sum, t) => sum + t.length, 0);
        while (total > CONTEXT_HISTORY_CHARS && this._recentTranslations.length > 1) {
            const removed = this._recentTranslations.shift();
            total -= removed.length;
        }
    }

    _getCarryoverContext() {
        if (this._recentTranslations.length === 0) return null;
        return this._recentTranslations.join(' ').trim();
    }

    // ─── Error Handling ──────────────────────────────────────

    _handleApiError(data, socket) {
        const code = Number(data.error_code) || 0;
        const message = data.error_message || '未知 API 错误';

        console.error('Soniox API error:', code, message);

        if (code === 408 || code === 429 || code >= 500) {
            this._connectionLost(socket, code === 429 ? '请求过于频繁' : '翻译服务暂时不可用');
            return;
        }

        let userMessage = message;
        if (code === 401) {
            userMessage = '❌ API 密钥无效，请在设置中检查。';
        } else if (code === 429) {
            userMessage = '⏳ 请求过于频繁，请稍后重试。';
        } else if (code === 402) {
            userMessage = '💳 余额不足，请检查你的 Soniox 账户。';
        } else if (code === 400) {
            userMessage = `⚙️ 配置错误：${message}`;
        }

        this._fatal(userMessage);
    }

    _tryReconnect(reason) {
        if (this._intentionalDisconnect || !this._config || this._pending || this._reconnectTimer != null) return;
        if (this._reconnectAttempts >= MAX_RECONNECT) {
            if (this.isConnected) {
                // Failed rotation is not a failure of the still-working active session.
                this._reconnectAttempts = 0;
                this._setStatus('connected');
                this._startSessionTimer();
                return;
            }
            this._fatal(`${reason}，重试 ${MAX_RECONNECT} 次后仍无法连接。`);
            return;
        }

        this._reconnectAttempts++;
        const delay = RECONNECT_DELAY_MS * this._reconnectAttempts;
        const generation = this._generation;
        if (!this.isConnected) this._setStatus('connecting');
        this.onError?.(`${reason}，正在重连（${this._reconnectAttempts}/${MAX_RECONNECT}）…`);
        this._reconnectTimer = this._setTimeout(() => {
            this._reconnectTimer = null;
            if (generation === this._generation && !this._intentionalDisconnect && this._config) {
                this._doConnect(this._config, this._getCarryoverContext());
            }
        }, delay);
    }

    _setStatus(status) {
        this.onStatusChange?.(status);
    }
}

// Singleton
export const sonioxClient = new SonioxClient();
