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

// Session reset: 3 minutes
const SESSION_DURATION_MS = 3 * 60 * 1000;

// Keep last N chars of translations for context carryover
const CONTEXT_HISTORY_CHARS = 500;

// Keepalive: send every 15s to prevent timeout when no audio
const KEEPALIVE_INTERVAL_MS = 15000;

export class SonioxClient {
    constructor() {
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
        this.onConfidence = null;     // (avgConfidence) => {}
    }

    /**
     * Connect to Soniox WebSocket
     */
    connect(config) {
        const { apiKey } = config;
        this.apiKey = apiKey;
        this._config = config;
        this._intentionalDisconnect = false;
        this._reconnectAttempts = 0;
        this._recentTranslations = [];

        if (!apiKey) {
            this._setStatus('error');
            this.onError?.('请先在设置中填写 API 密钥。');
            return;
        }

        this._doConnect(config);
    }

    _doConnect(config, carryoverContext = null) {
        const { apiKey, sourceLanguage, targetLanguage, customContext,
                translationType, languageA, languageB, languageHintsStrict,
                endpointDelay } = config;

        this._setStatus('connecting');
        console.log('[Soniox] Connecting to', SONIOX_ENDPOINT);

        let newWs;
        try {
            newWs = new WebSocket(SONIOX_ENDPOINT);
            console.log('[Soniox] WebSocket created, readyState:', newWs.readyState);
        } catch (err) {
            console.error('[Soniox] Failed to create WebSocket:', err);
            this._setStatus('error');
            this.onError?.(`创建实时连接失败：${err.message}`);
            return;
        }

        newWs.onopen = () => {
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

            console.log('[Soniox] Sending config (model:', configMsg.model, ')');
            newWs.send(JSON.stringify(configMsg));

            // Make-before-break: close old WS AFTER new one is ready
            const oldWs = this.ws;
            if (oldWs && oldWs !== newWs) {
                console.log('[Soniox] Seamless switch: closing old WebSocket');
                try {
                    if (oldWs.readyState === WebSocket.OPEN) {
                        oldWs.send(new ArrayBuffer(0)); // graceful close signal
                    }
                    oldWs._isOld = true; // mark so onclose doesn't trigger reconnect
                    oldWs.close(1000, 'Session reset');
                } catch (e) {
                    // ignore
                }
            }

            // Switch to new WS
            this.ws = newWs;
            this.isConnected = true;
            this._reconnectAttempts = 0;
            this._setStatus('connected');
            console.log('[Soniox] Connected and config sent');

            // Start session timer & keepalive
            this._startSessionTimer();
            this._startKeepalive();
        };

        newWs.onmessage = (event) => {
            // Ignore messages from old WebSocket
            if (newWs._isOld) return;

            try {
                const data = JSON.parse(event.data);

                if (data.error_code) {
                    this._handleApiError(data);
                    return;
                }

                this._handleResponse(data);
            } catch (err) {
                console.error('Failed to parse Soniox response:', err);
            }
        };

        newWs.onerror = (event) => {
            if (newWs._isOld) return;
            console.error('[Soniox] WebSocket ERROR:', event);
            this.onError?.('实时连接发生错误');
        };

        newWs.onclose = (event) => {
            // Ignore close events from old WebSocket during seamless switch
            if (newWs._isOld) {
                console.log('[Soniox] Old WebSocket closed (expected)');
                return;
            }

            console.log('[Soniox] WebSocket CLOSED, code:', event.code, 'reason:', event.reason, 'wasClean:', event.wasClean);
            this.isConnected = false;

            // Only null out ws if this is the current one
            if (this.ws === newWs) {
                this.ws = null;
            }

            if (this._intentionalDisconnect) {
                this._setStatus('disconnected');
                return;
            }

            // Handle close codes
            if (event.code === 1000) {
                this._setStatus('disconnected');
            } else if (event.code === 1006) {
                this._tryReconnect('连接意外断开');
            } else if (event.code === 4001 || event.code === 4003) {
                this._setStatus('error');
                this.onError?.('API 密钥无效，请在设置中检查。');
            } else if (event.code === 4029) {
                this._setStatus('error');
                this.onError?.('请求过于频繁，请稍后重试。');
            } else if (event.code === 4002) {
                this._setStatus('error');
                this.onError?.('订阅异常，请检查你的 Soniox 账户。');
            } else {
                this._tryReconnect(`连接已关闭（代码：${event.code}）`);
            }
        };
    }

    /**
     * Send raw PCM audio data
     */
    sendAudio(pcmData) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(pcmData);
        }
    }

    /**
     * Gracefully disconnect
     */
    disconnect() {
        this._intentionalDisconnect = true;
        this._stopSessionTimer();
        this._stopKeepalive();

        if (this.ws) {
            try {
                if (this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(new ArrayBuffer(0));
                }
                this.ws.close(1000, 'User disconnected');
            } catch (err) {
                console.error('Error during disconnect:', err);
            }
            this.ws = null;
        }
        this.isConnected = false;
        this._setStatus('disconnected');
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
        this._sessionTimer = setTimeout(() => {
            this._seamlessReset();
        }, SESSION_DURATION_MS);
    }

    _stopSessionTimer() {
        if (this._sessionTimer) {
            clearTimeout(this._sessionTimer);
            this._sessionTimer = null;
        }
    }

    /**
     * Seamless session reset: open new WS, switch, close old
     * Audio capture continues uninterrupted
     */
    _seamlessReset() {
        if (!this._config || this._intentionalDisconnect) return;

        console.log('[Soniox] ♻️ Seamless session reset (every 3 min)');

        // Build carryover context from recent translations
        const carryover = this._getCarryoverContext();

        // Open new connection (make-before-break)
        this._doConnect(this._config, carryover);
    }

    // ─── Keepalive ────────────────────────────────────────────

    _startKeepalive() {
        this._stopKeepalive();
        this._keepaliveTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'keepalive' }));
            }
        }, KEEPALIVE_INTERVAL_MS);
    }

    _stopKeepalive() {
        if (this._keepaliveTimer) {
            clearInterval(this._keepaliveTimer);
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

    _handleApiError(data) {
        const code = data.error_code || 0;
        const message = data.error_message || '未知 API 错误';

        console.error('Soniox API error:', code, message);

        if (code === 408) {
            this._tryReconnect('请求超时');
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

        this._setStatus('error');
        this.onError?.(userMessage);
    }

    _tryReconnect(reason) {
        if (this._reconnectAttempts >= MAX_RECONNECT) {
            this._setStatus('error');
            this.onError?.(`${reason}，重试 ${MAX_RECONNECT} 次后仍无法连接。`);
            return;
        }

        this._reconnectAttempts++;
        const delay = RECONNECT_DELAY_MS * this._reconnectAttempts;

        console.log(`Reconnecting (${this._reconnectAttempts}/${MAX_RECONNECT}) in ${delay}ms...`);
        this._setStatus('connecting');
        this.onError?.(`${reason}，正在重连（${this._reconnectAttempts}/${MAX_RECONNECT}）…`);

        setTimeout(() => {
            if (!this._intentionalDisconnect && this._config) {
                const carryover = this._getCarryoverContext();
                this._doConnect(this._config, carryover);
            }
        }, delay);
    }

    _setStatus(status) {
        this.onStatusChange?.(status);
    }
}

// Singleton
export const sonioxClient = new SonioxClient();
