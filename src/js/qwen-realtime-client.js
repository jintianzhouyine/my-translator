// Qwen 3.8 LiveTranslate. Two instances can run independently for a call.
// Provider source/translation items are associated by IDs, never by arrival order.

const MAX_ITEMS = 256;
const MAX_PENDING_AUDIO = 16;

export class QwenTranscriptAssembler {
    constructor(callbacks = {}) {
        this.callbacks = callbacks;
        this.sources = new Map();
        this.targets = new Map();
        this.retired = new Set();
    }

    clear() {
        this.sources.clear();
        this.targets.clear();
        this.retired.clear();
    }

    _source(id) {
        if (!id) return null;
        if (!this.sources.has(id)) this.sources.set(id, { text: '', speakerId: null, final: false, startMs: null, endMs: null });
        if (this.sources.size > MAX_ITEMS) this.sources.delete(this.sources.keys().next().value);
        return this.sources.get(id);
    }

    _target(id, responseId) {
        if (!id || this.retired.has(id)) return null;
        if (!this.targets.has(id)) {
            this.targets.set(id, { text: '', sourceItemId: null, responseId: null, final: false, emitted: null, sourceText: '', speakerId: null, startMs: null, endMs: null });
        }
        if (this.targets.size > MAX_ITEMS) {
            const oldest = this.targets.keys().next().value;
            this.targets.delete(oldest);
            this.retired.add(oldest);
            if (this.retired.size > MAX_ITEMS * 2) this.retired.delete(this.retired.values().next().value);
        }
        const target = this.targets.get(id);
        if (responseId) target.responseId = responseId;
        return target;
    }

    metadata(id) {
        const target = this.targets.get(id);
        const source = target && this.sources.get(target.sourceItemId);
        return {
            itemId: id || null,
            sourceItemId: target?.sourceItemId || null,
            speakerId: source?.speakerId ?? target?.speakerId ?? null,
            sourceText: source?.text || target?.sourceText || '',
            startMs: source?.startMs ?? target?.startMs ?? null,
            endMs: source?.endMs ?? target?.endMs ?? null,
            sampleRate: 24000,
        };
    }

    _emit(id) {
        const target = this.targets.get(id);
        if (!target) return;
        const meta = this.metadata(id);
        target.sourceText = meta.sourceText;
        target.speakerId = meta.speakerId;
        target.startMs = meta.startMs;
        target.endMs = meta.endMs;
        if (target.final) {
            if (!target.text.trim()) return;
            const fingerprint = JSON.stringify([target.text, meta.sourceText, meta.sourceItemId, meta.speakerId, meta.startMs, meta.endMs]);
            if (fingerprint === target.emitted) return;
            target.emitted = fingerprint;
            this.callbacks.onSegment?.(meta.sourceText, target.text, meta);
        } else {
            this.callbacks.onProvisional?.(target.text, meta);
        }
    }

    _sourceChanged(id) {
        const source = this.sources.get(id);
        if (!source) return;
        this.callbacks.onSourceProvisional?.(source.text, {
            itemId: id, sourceItemId: id, speakerId: source.speakerId, sourceText: source.text, isFinal: source.final,
            startMs: source.startMs, endMs: source.endMs,
        });
        for (const [targetId, target] of this.targets) {
            if (target.sourceItemId === id) this._emit(targetId);
        }
    }

    _finishItem(item, responseId) {
        if (!item?.id || item.role === 'user') return;
        const target = this._target(item.id, responseId);
        if (!target) return;
        const content = (item.content || []).map(part => part.text ?? part.transcript ?? '').join('');
        if (content) target.text = content;
        target.final = true;
        this._emit(item.id);
    }

    handle(event) {
        if (!event || typeof event !== 'object') return;
        const id = event.item_id;
        switch (event.type) {
            case 'input_audio_buffer.speech_started':
            case 'input_audio_buffer.speech_stopped': {
                const source = this._source(id);
                if (!source) return;
                if (event.speaker_id != null) source.speakerId = String(event.speaker_id);
                // Provider offsets refer to the input audio timeline, never event arrival time.
                if (Number.isFinite(event.audio_start_ms) && event.audio_start_ms >= 0) source.startMs = event.audio_start_ms;
                if (Number.isFinite(event.audio_end_ms) && event.audio_end_ms >= 0) source.endMs = event.audio_end_ms;
                this._sourceChanged(id);
                break;
            }
            case 'conversation.item.input_audio_transcription.delta':
            case 'conversation.item.input_audio_transcription.completed': {
                const source = this._source(id);
                if (!source) return;
                if (event.type.endsWith('.completed')) {
                    if (typeof event.transcript === 'string') source.text = event.transcript;
                    source.final = true;
                } else if (!source.final) {
                    source.text += event.delta || '';
                }
                this._sourceChanged(id);
                break;
            }
            case 'conversation.item.created': {
                const item = event.item;
                if (item?.role !== 'assistant') return;
                const target = this._target(item.id, event.response_id);
                if (!target) return;
                if (event.previous_item_id) target.sourceItemId = event.previous_item_id;
                this._emit(item.id);
                break;
            }
            case 'response.text.delta':
            case 'response.audio_transcript.delta': {
                const target = this._target(id, event.response_id);
                if (!target || target.final) return;
                target.text += event.delta || '';
                this._emit(id);
                break;
            }
            case 'response.text.done':
            case 'response.audio_transcript.done': {
                const target = this._target(id, event.response_id);
                if (!target) return;
                const text = event.text ?? event.transcript;
                if (typeof text === 'string') target.text = text;
                target.final = true;
                this._emit(id);
                break;
            }
            case 'response.output_item.done':
                this._finishItem(event.item, event.response_id);
                break;
            case 'response.done': {
                const response = event.response;
                if (response?.status && response.status !== 'completed') return;
                for (const item of response?.output || []) this._finishItem(item, response.id);
                if (response?.id) {
                    for (const [targetId, target] of this.targets) {
                        if (target.responseId === response.id) {
                            target.final = true;
                            this._emit(targetId);
                        }
                    }
                }
                break;
            }
        }
    }
}

export class QwenRealtimeClient {
    constructor(options = {}) {
        const core = globalThis.window?.__TAURI__?.core;
        this._invoke = options.invoke || core?.invoke;
        this._Channel = options.Channel || core?.Channel;
        this._connectTimeout = options.connectTimeoutMs ?? 40000;
        this._disconnectTimeout = options.disconnectTimeoutMs ?? 22000;
        this._finishTimeout = options.finishTimeoutMs ?? null;
        this.sessionId = null;
        this.channel = null;
        this.isConnected = false;
        this.onStatusChange = () => {};
        this.onSegment = () => {};
        this.onProvisional = () => {};
        this.onSourceProvisional = () => {};
        this.onAudioChunk = () => {};
        this.onError = () => {};
        this.onClosed = () => {};
        this._operation = null;
        this._assembler = new QwenTranscriptAssembler({
            onSegment: (...args) => this.onSegment(...args),
            onProvisional: (...args) => this.onProvisional(...args),
            onSourceProvisional: (...args) => this.onSourceProvisional(...args),
        });
    }

    async connect(cfg) {
        if (this._operation) await this.disconnect();
        if (!this._invoke || !this._Channel) throw new Error('Qwen 需要桌面应用运行环境');
        this._assembler.clear();
        const operation = { id: null, ready: false, closing: false, closed: false, settled: false, errorReported: false, sendTail: Promise.resolve(), pendingAudio: 0,
            finishTimeout: this._finishTimeout ?? Math.min(30000, Math.max(1000, cfg.finishTimeoutMs ?? 8000)) + 12000 };
        const ready = new Promise((resolve, reject) => { operation.resolve = resolve; operation.reject = reject; });
        operation.closedPromise = new Promise(resolve => { operation.resolveClosed = resolve; });
        this._operation = operation;
        const channel = new this._Channel();
        this.channel = channel;
        channel.onmessage = event => {
            if (this._operation === operation && !operation.closed) this._handleEvent(event, operation);
        };
        operation.timer = setTimeout(() => this._fail(operation, 'connect_timeout', 'Qwen 连接或配置确认超时'), this._connectTimeout);
        // IPC may return after a user cancels. Always close that late-created backend session.
        Promise.resolve().then(() => this._invoke('qwen_realtime_start', {
            config: {
                api_key: cfg.apiKey,
                workspace_id: cfg.workspaceId,
                region: cfg.region || 'cn-beijing',
                target_language: cfg.targetLanguage,
                audio_output: Boolean(cfg.audioOutput),
                phrases: cfg.phrases || {},
                turn_detection: cfg.turnDetection || 'speaker_detection',
                finish_timeout_ms: cfg.finishTimeoutMs ?? null,
            },
            onEvent: channel,
        })).then(id => {
            operation.id = id;
            if (this._operation !== operation || operation.closing || operation.closed) {
                this._stopBackend(id).catch(() => {});
                return;
            }
            this.sessionId = id;
            this._resolveReady(operation);
        }).catch(error => {
            if (this._operation === operation && !operation.closing && !operation.closed) {
                this._fail(operation, 'connect_failed', String(error));
            }
        });
        return ready;
    }

    _resolveReady(operation) {
        if (!operation.ready || operation.id == null || operation.closing || operation.closed || operation.settled) return;
        operation.settled = true;
        clearTimeout(operation.timer);
        this.isConnected = true;
        operation.resolve();
    }

    _fail(operation, code, message) {
        if (this._operation !== operation || operation.closed) return;
        if (!operation.settled) {
            operation.settled = true;
            operation.reject(new Error(message));
        }
        clearTimeout(operation.timer);
        this.isConnected = false;
        operation.errorMessage = message;
        if (!operation.errorReported) {
            operation.errorReported = true;
            this.onError(code, message);
        }
        // Errors invalidate further audio/transcripts. Cleanup is still required if start IPC is pending.
        operation.closing = true;
        if (operation.id != null) this._stopBackend(operation.id).catch(() => {}).finally(() => this._closed(operation, 'error'));
        else this._closed(operation, 'error');
    }

    _closed(operation, reason) {
        if (operation.closed) return;
        operation.closed = true;
        operation.closeReason = reason;
        clearTimeout(operation.timer);
        if (!operation.settled) {
            operation.settled = true;
            operation.reject(new Error(operation.closing ? 'Qwen 连接已取消' : 'Qwen 在就绪前关闭了连接'));
        }
        operation.resolveClosed();
        if (this._operation === operation) {
            this.isConnected = false;
            this.sessionId = null;
            this.onClosed(reason);
        }
    }

    async sendAudio(arrayBuffer) {
        const operation = this._operation;
        if (!this.isConnected || !operation || operation.closing || operation.closed) return;
        const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
        if (!bytes.byteLength) return;
        if (bytes.byteLength % 2 || bytes.byteLength > 32000) throw new Error('Qwen 音频分片格式或长度无效');
        if (operation.pendingAudio >= MAX_PENDING_AUDIO) {
            const message = 'Qwen 音频发送积压，请检查网络后重新开始';
            this._fail(operation, 'audio_backpressure', message);
            throw new Error(message);
        }
        operation.pendingAudio++;
        const pcm = Array.from(bytes);
        const send = operation.sendTail.then(async () => {
            if (this._operation !== operation || operation.closed || operation.errorReported) return;
            await this._invoke('qwen_realtime_send_audio', { sessionId: operation.id, pcm });
        });
        operation.sendTail = send.catch(() => {});
        try {
            await send;
        } catch (error) {
            operation.sendError = error;
            if ((!operation.closing || operation.finishing) && !operation.closed) this._fail(operation, 'audio_send_failed', String(error));
            throw error;
        } finally {
            operation.pendingAudio--;
        }
    }

    async _stopBackend(id) {
        let timer;
        try {
            await Promise.race([
                this._invoke('qwen_realtime_stop', { sessionId: id }),
                new Promise(resolve => { timer = setTimeout(resolve, this._disconnectTimeout); }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    async disconnect() {
        const operation = this._operation;
        if (!operation) return;
        if (operation.disconnectPromise) return operation.disconnectPromise;
        operation.closing = true;
        this.isConnected = false;
        clearTimeout(operation.timer);
        if (!operation.settled) {
            operation.settled = true;
            operation.reject(new Error('Qwen 连接已取消'));
        }
        operation.disconnectPromise = (async () => {
            if (operation.id != null && !operation.closed) {
                // Deliver already accepted IPC audio before session.finish, preserving the last phrase.
                let timer;
                try {
                    await Promise.race([operation.sendTail, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
                } finally { clearTimeout(timer); }
                await this._stopBackend(operation.id);
            }
            this._closed(operation, 'stopped');
            if (this._operation === operation) {
                this._operation = null;
                this.sessionId = null;
                this.channel = null;
                this._assembler.clear();
            }
        })();
        return operation.disconnectPromise;
    }

    /** EOF for a file: success requires the provider's session.finished, never a local timeout. */
    async finish() {
        const operation = this._operation;
        if (operation?.finishPromise) return operation.finishPromise;
        if (!operation || !this.isConnected || operation.closing || operation.closed || operation.id == null) {
            throw new Error('Qwen 会话未就绪或已经结束，无法确认文件翻译完成。');
        }
        operation.finishing = true;
        operation.closing = true;
        this.isConnected = false;
        clearTimeout(operation.timer);
        operation.finishPromise = (async () => {
            let timer;
            const drain = (async () => {
                await operation.sendTail;
                if (operation.sendError) throw operation.sendError;
                if (operation.errorReported) throw new Error(operation.errorMessage || 'Qwen 翻译失败');
                await this._stopBackend(operation.id);
                await operation.closedPromise;
                if (operation.errorReported || operation.closeReason !== 'finished') {
                    throw new Error(operation.errorMessage || 'Qwen 未确认文件翻译完成。');
                }
            })();
            // A close/error can interrupt a stalled accepted send; a confirmed close still
            // waits for the entire drain promise so an IPC failure cannot become success.
            const closed = operation.closedPromise.then(() => {
                if (operation.errorReported || operation.closeReason !== 'finished') {
                    throw new Error(operation.errorMessage || 'Qwen 未确认文件翻译完成。');
                }
                return drain;
            });
            try {
                await Promise.race([drain, closed, new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Qwen 文件翻译收尾超时，结果可能不完整。')), operation.finishTimeout);
                })]);
            } catch (error) {
                // If an accepted send stalled, still tell the backend to release the session.
                this._stopBackend(operation.id).catch(() => {});
                this._closed(operation, 'finish_failed');
                throw error;
            } finally {
                clearTimeout(timer);
                if (this._operation === operation) {
                    this._operation = null;
                    this.sessionId = null;
                    this.channel = null;
                    this._assembler.clear();
                }
            }
        })();
        return operation.finishPromise;
    }

    // Retained for callers which used the older client. Provisional text is not a completed translation.
    flushPending() {}

    _handleEvent(event, operation) {
        switch (event.type) {
            case 'status':
                if (operation.closing) return;
                if (event.state === 'ready') {
                    operation.ready = true;
                    this._resolveReady(operation);
                }
                this.onStatusChange(event.state, event.message);
                break;
            case 'protocol':
                if (!operation.errorReported) this._assembler.handle(event.event);
                break;
            case 'audio':
                if (!operation.errorReported) {
                    this.onAudioChunk(event.audio, { ...this._assembler.metadata(event.item_id), responseId: event.response_id || null });
                }
                break;
            case 'error':
                this._fail(operation, event.code, event.message);
                break;
            case 'closed':
                this._closed(operation, event.reason);
                break;
        }
    }
}
