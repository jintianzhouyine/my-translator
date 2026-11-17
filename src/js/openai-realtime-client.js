// OpenAI Realtime Translate WebSocket client (via Tauri Rust backend).
// A logical live session survives transport reconnections without restarting capture.
import { isRecoverableRealtimeError } from './realtime-recovery.js';

export class OpenAiRealtimeClient {
    constructor({ invoke = globalThis.window?.__TAURI__?.core?.invoke,
        Channel = globalThis.window?.__TAURI__?.core?.Channel,
        connectTimeoutMs = 20000, reconnectDelayMs = 1000, maxReconnects = 3,
        stableConnectionMs = 30000, disconnectTimeoutMs = 8000, sendTimeoutMs = 10000,
        setTimeout: setTimer = globalThis.setTimeout, clearTimeout: clearTimer = globalThis.clearTimeout } = {}) {
        Object.assign(this, { _invoke: invoke, _Channel: Channel, connectTimeoutMs, reconnectDelayMs,
            maxReconnects, stableConnectionMs, disconnectTimeoutMs, sendTimeoutMs,
            _setTimer: setTimer, _clearTimer: clearTimer });
        this.sessionId = null;
        this.channel = null;
        this.outputQueue = null;
        this.isConnected = false;
        this._run = null;
        this.onStatusChange = () => {};
        this.onSegment = () => {};
        this.onProvisional = () => {};
        this.onSourceProvisional = () => {};
        this.onError = () => {};
        this.onWarning = () => {};
        this.onClosed = () => {};
        this._provisionalBuffer = '';
        this._sourceBuffer = '';
        this._pendingSourceFinals = [];
        this._muted = false;
    }

    setMuted(muted) {
        this._muted = !!muted;
        if (this._muted) this.outputQueue?.flush();
    }

    connect(cfg, outputQueue) {
        if (this._run) return Promise.reject(new Error('上一通 OpenAI 翻译仍在运行。'));
        this.outputQueue = outputQueue;
        this._muted = cfg.audioOutput === false;
        this._provisionalBuffer = '';
        this._sourceBuffer = '';
        this._pendingSourceFinals = [];
        const run = { cfg: { ...cfg }, closing: false, retries: 0, settled: false, attempt: null };
        const connected = new Promise((resolve, reject) => Object.assign(run, { resolve, reject }));
        this._run = run;
        this._connectAttempt(run);
        return connected;
    }

    _isActive(run, attempt) {
        return this._run === run && !run.closing && run.attempt === attempt && !attempt.closed;
    }

    _connectAttempt(run) {
        if (this._run !== run || run.closing) return;
        const attempt = { id: null, ready: false, closed: false, queuedBytes: 0, sendTail: Promise.resolve() };
        attempt.closedPromise = new Promise(resolve => { attempt.resolveClosed = resolve; });
        run.attempt = attempt;
        this.onStatusChange('connecting');
        attempt.timer = this._setTimer(() => {
            this._failAttempt(run, attempt, 'connect_timeout', 'OpenAI 连接超时');
        }, this.connectTimeoutMs);
        const channel = new this._Channel();
        this.channel = channel;
        channel.onmessage = evt => this._handleEvent(run, attempt, evt);
        const cfg = run.cfg;
        Promise.resolve().then(() => this._invoke('openai_realtime_start', {
            config: {
                api_key: cfg.apiKey,
                source_language: cfg.sourceLanguage || 'auto',
                target_language: cfg.targetLanguage,
                voice: cfg.voice || null,
                audio_output: cfg.audioOutput !== false,
            },
            onEvent: channel,
        })).then(id => {
            attempt.id = id;
            // Stop may run before IPC returns its ID, or the native session may close first.
            if (!this._isActive(run, attempt)) {
                void this._stopBackend(attempt);
                return;
            }
            this.sessionId = id;
            this._ready(run, attempt);
        }).catch(error => this._failAttempt(run, attempt, 'connect_failed', String(error)));
    }

    _ready(run, attempt) {
        if (!this._isActive(run, attempt) || !attempt.ready || attempt.id == null || this.isConnected) return;
        this._clearTimer(attempt.timer);
        this.isConnected = true;
        // A handshake alone does not reset the retry budget: repeated ready/close loops must terminate.
        run.stableTimer = this._setTimer(() => {
            if (this._isActive(run, attempt)) run.retries = 0;
        }, this.stableConnectionMs);
        if (!run.settled) {
            run.settled = true;
            run.resolve();
        }
        this.onStatusChange('ready');
    }

    _closeAttempt(run, attempt) {
        attempt.closed = true;
        attempt.resolveClosed();
        this._clearTimer(attempt.timer);
        this._clearTimer(run.stableTimer);
        this.isConnected = false;
        this.sessionId = null;
        this.flushPending();
        this.outputQueue?.flush();
        return this._stopBackend(attempt);
    }

    _failAttempt(run, attempt, code, message) {
        if (!this._isActive(run, attempt)) return;
        const cleanup = this._closeAttempt(run, attempt);
        const retryable = isRecoverableRealtimeError(code, message);
        if (!retryable || run.retries >= this.maxReconnects) {
            run.closing = true;
            this._run = null;
            const detail = retryable ? `${message}；自动重连失败，请检查网络后重新开始。` : message;
            if (!run.settled) {
                run.settled = true;
                run.reject(new Error(detail));
            }
            this.onStatusChange('error');
            this.onError(code, detail);
            this.onClosed(detail);
            return;
        }
        run.retries++;
        this.onStatusChange('connecting');
        this.onWarning(`OpenAI 连接中断，正在重连（${run.retries}/${this.maxReconnects}）…`);
        run.retryTimer = this._setTimer(() => {
            // Backoff and cleanup can overlap, but do not open another billable socket until
            // the previous native worker has stopped (or its bounded cleanup has expired).
            void cleanup.then(() => this._connectAttempt(run));
        }, this.reconnectDelayMs * run.retries);
    }

    sendAudio(arrayBuffer) {
        const run = this._run;
        const attempt = run?.attempt;
        if (!this.isConnected || !attempt || !this._isActive(run, attempt)) return Promise.resolve();
        const bytes = Array.from(new Uint8Array(arrayBuffer));
        // Bound the IPC queue to five seconds of 16 kHz PCM. A stalled send must not silently
        // accumulate memory or leave an apparently running translator permanently deaf.
        if (attempt.queuedBytes + bytes.length > 16000 * 2 * 5) {
            this._failAttempt(run, attempt, 'audio_backpressure', 'OpenAI 音频发送积压');
            return Promise.resolve();
        }
        attempt.queuedBytes += bytes.length;
        const sending = attempt.sendTail.then(async () => {
            if (!this._isActive(run, attempt)) return;
            let timer;
            try {
                await Promise.race([
                    this._invoke('openai_realtime_send_audio', { sessionId: attempt.id, pcm: bytes }),
                    attempt.closedPromise,
                    new Promise((_, reject) => {
                        timer = this._setTimer(() => reject(new Error('OpenAI 音频发送超时')), this.sendTimeoutMs);
                    }),
                ]);
            } finally { this._clearTimer(timer); }
        }).catch(error => {
            this._failAttempt(run, attempt, 'audio_send_failed', String(error));
        }).finally(() => { attempt.queuedBytes -= bytes.length; });
        attempt.sendTail = sending;
        return sending;
    }

    _stopBackend(attempt) {
        if (attempt.id == null) return Promise.resolve();
        if (attempt.stopping) return attempt.stopping;
        attempt.stopping = (async () => {
            let timer;
            try {
                await Promise.race([
                    this._invoke('openai_realtime_stop', { sessionId: attempt.id }),
                    new Promise(resolve => { timer = this._setTimer(resolve, this.disconnectTimeoutMs); }),
                ]);
            } catch { /* Native cleanup also runs on transport exit. */ }
            finally { this._clearTimer(timer); }
        })();
        return attempt.stopping;
    }

    /**
     * If there's an in-flight partial translation that never got finalized
     * (user pressed Stop mid-sentence), emit it as a final segment so it's
     * persisted instead of lost. Safe to call multiple times.
     */
    flushPending() {
        // Emit any queued source finals as source-only segments (no translation
        // arrived for them yet). Then emit a final pair using whatever in-flight
        // buffers remain — keeps stop-mid-sentence text from being silently dropped.
        try {
            while (this._pendingSourceFinals.length > 1) {
                this.onSegment(this._pendingSourceFinals.shift(), '');
            }
            const tgt = this._provisionalBuffer;
            const src = this._pendingSourceFinals.shift() || this._sourceBuffer;
            this._provisionalBuffer = '';
            this._sourceBuffer = '';
            if (tgt || src) this.onSegment(src, tgt);
        } catch (e) {
            console.error('[OpenAI flush]', e);
        }
    }

    async disconnect() {
        const run = this._run;
        if (!run) return;
        run.closing = true;
        this._run = null;
        this._clearTimer(run.retryTimer);
        this._clearTimer(run.stableTimer);
        if (!run.settled) {
            run.settled = true;
            run.reject(new Error('OpenAI 翻译启动已取消。'));
        }
        if (run.attempt) await this._closeAttempt(run, run.attempt);
        this.channel = null;
    }

    _handleEvent(run, attempt, evt) {
        if (!this._isActive(run, attempt)) return;
        switch (evt.type) {
            case 'status':
                if (evt.state === 'ready') {
                    attempt.ready = true;
                    this._ready(run, attempt);
                } else {
                    this.onStatusChange(evt.state, evt.message);
                }
                break;
            case 'transcript':
                if (evt.is_final) {
                    // Prefer the next queued source final (authoritative, full text
                    // from whisper). Fall back to accumulated deltas if the source
                    // .done event hasn't arrived yet.
                    const sourceText = this._pendingSourceFinals.shift() || this._sourceBuffer;
                    this._provisionalBuffer = '';
                    this._sourceBuffer = '';
                    this.onSegment(sourceText, evt.text);
                } else {
                    this._provisionalBuffer += evt.text;
                    this.onProvisional(this._provisionalBuffer);
                }
                break;
            case 'source_transcript':
                if (evt.is_final) {
                    // Whisper finalized the input chunk — queue the full transcript
                    // for pairing with the next translated final. Drop the delta
                    // buffer since we now have the authoritative text.
                    this._pendingSourceFinals.push(evt.text);
                    this._sourceBuffer = '';
                    this.onSourceProvisional(evt.text);
                } else {
                    this._sourceBuffer += evt.text;
                    this.onSourceProvisional(this._sourceBuffer);
                }
                break;
            case 'audio_chunk':
                if (!this._muted) this.outputQueue?.push(evt.pcm_base64);
                break;
            case 'error':
                this._failAttempt(run, attempt, evt.code, evt.message);
                break;
            case 'closed':
                this._failAttempt(run, attempt, 'connection_closed', evt.reason || 'OpenAI 连接已断开');
                break;
        }
    }
}
