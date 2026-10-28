const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1600;
const ACTIVE = new Set(['preparing', 'connecting', 'translating', 'finishing', 'retry_wait']);
const RETRYABLE = new Set(['failed', 'cancelled', 'skipped']);
const abortError = () => new DOMException('已取消', 'AbortError');

/** Subdivide only within the user's boundaries. Uploaded pre-cut files keep their file boundaries. */
export function planTranslationJobs(parts, { parallelism = 2, fixedParts = false } = {}) {
    return parts.flatMap(part => {
        const samples = Math.round((part.endMs - part.startMs) * 16);
        let count = parallelism === 2 && !fixedParts ? Math.ceil(samples / (120 * SAMPLE_RATE)) : 1;
        if (parallelism === 2 && !fixedParts && parts.length === 1 && samples > 30 * SAMPLE_RATE) count = Math.max(2, count);
        return Array.from({ length: count }, (_, index) => {
            const start = Math.round(part.startMs * 16) + Math.round(samples * index / count);
            const end = Math.round(part.startMs * 16) + Math.round(samples * (index + 1) / count);
            return { ...part, id: count === 1 ? part.id : `${part.id}.${index + 1}`,
                sourcePartId: fixedParts ? part.id : undefined,
                startMs: start / 16, endMs: end / 16, duration: (end - start) / SAMPLE_RATE,
                status: 'pending', attempt: 0, progress: 0, error: '' };
        });
    });
}

export function classifyAudioFileError(error) {
    if (error?.local) return { retry: false, fatal: false };
    const text = `${error?.code || ''} ${error?.message || error}`;
    if (/\b(?:400|401|402|403|404|405|415|422)\b|InvalidApiKey|InvalidParam|invalid[_ -]?(?:api[_ -]?key|parameter|argument|workspace|payload|input)|unauthori[sz]ed|forbidden|authentication|access.?denied|insufficient[_ -]?(?:quota|balance)|arrearage|quota.?exhaust|余额|欠费|无效.*(?:密钥|参数)|鉴权|没有权限|请填写|地域须为|目标语言无效|语音检测方式无效|收尾等待时间须|术语.*(?:超过|不能为空|过大)/i.test(text)) return { retry: false, fatal: true };
    if (/\b(?:1002|1003|1007|1008|1009)\b/.test(text) && !/throttl|rate.?limit|限流/i.test(text)) return { retry: false, fatal: false };
    if (/\b(?:408|429|5\d\d)\b|throttl|rate.?limit|timeout|timed.?out|network|connection|connect_failed|audio_send_failed|audio_backpressure|ServiceUnavailable|ModelServiceFailed|ECONN|socket|限流|超时|网络|连接|断开|积压/i.test(text)) return { retry: true, fatal: false };
    return { retry: false, fatal: false };
}

export class AudioFileRunner {
    constructor(owner, config, options, parts) {
        Object.assign(this, { owner, config, options, parts });
        this.audio = owner.audio;
        this.previews = new Map();
        this.prepareTail = Promise.resolve();
        this.active = new Set();
        this.operation = null;
    }

    _error(error) {
        const message = String(error?.message || error || '未知错误');
        return this.config.apiKey ? message.split(this.config.apiKey).join('[已隐藏密钥]').slice(0, 500) : message.slice(0, 500);
    }

    _publish(patch = {}) {
        const activePartIds = this.parts.filter(part => ACTIVE.has(part.status)).map(part => part.id);
        const completed = this.parts.filter(part => part.status === 'completed').length;
        const failed = this.parts.filter(part => part.status === 'failed').length;
        const skipped = this.parts.filter(part => part.status === 'skipped').length;
        const processed = this.parts.reduce((sum, part) => sum + part.duration * (['completed', 'skipped'].includes(part.status) ? 1 : part.progress), 0);
        this.owner._emit({ parts: this.parts.map(part => ({ ...part })), activePartIds,
            partIndex: Math.max(0, this.parts.findIndex(part => ACTIVE.has(part.status))), partCount: this.parts.length,
            progress: Math.min(1, processed / this.audio.duration), provisionals: [...this.previews.values()],
            partial: this.parts.some(part => part.status !== 'completed'),
            message: `已完成 ${completed}/${this.parts.length} 段${activePartIds.length ? `，正在处理 ${activePartIds.length} 段` : ''}${failed ? `，${failed} 段失败，可重试或跳过` : ''}${skipped ? `，${skipped} 段已跳过` : ''}。`, ...patch });
    }

    _summary(cancelled = false) {
        const incomplete = this.parts.filter(part => part.status !== 'completed');
        const missing = this.owner.snapshot.segments.filter(segment => segment.startMs == null || segment.endMs == null).length;
        this._publish({ state: cancelled ? 'cancelled' : incomplete.length ? 'partial' : 'completed',
            ...(cancelled ? { message: '已取消，已完成的译文保留；可重试未完成的片段，无需整份重来。' }
                : !incomplete.length ? { message: missing ? `全部分段已处理；${missing} 段未返回完整时间戳，可导出文字。`
                    : `全部 ${this.parts.length} 个音频片段翻译完成，共 ${this.owner.snapshot.segments.length} 段字幕。` } : {}) });
    }

    async _prepare(part, signal) {
        const previous = this.prepareTail;
        let release;
        this.prepareTail = new Promise(resolve => { release = resolve; });
        await previous;
        try {
            if (signal.aborted) throw abortError();
            return await this.owner._preparePart(this.audio, part, signal);
        } finally { release(); }
    }

    async _reserveConnection(signal) {
        // All retries share this rolling budget across runs. Leave room below the account's 10 RPM.
        const owner = this.owner;
        const previous = owner.connectionTail || Promise.resolve();
        let release;
        owner.connectionTail = new Promise(resolve => { release = resolve; });
        await previous;
        try {
            if (signal.aborted) throw abortError();
            const now = owner.now();
            owner.connectionTimes = (owner.connectionTimes || []).filter(time => time > now - 60000);
            const intervalWait = owner.lastConnectionAt == null ? 0 : owner.lastConnectionAt + 7500 - now;
            const windowWait = owner.connectionTimes.length >= 8 ? owner.connectionTimes.at(-8) + 60001 - now : 0;
            const delay = Math.max(0, intervalWait, windowWait);
            if (delay > 0) await owner.sleep(delay, signal);
            if (signal.aborted) throw abortError();
            owner.lastConnectionAt = owner.now();
            owner.connectionTimes.push(owner.lastConnectionAt);
        } finally { release(); }
    }

    _commit(part, staged) {
        for (const [id, segment] of this.owner.segments) if (segment.jobId === part.id) this.owner.segments.delete(id);
        for (const [id, segment] of staged) this.owner.segments.set(id, segment);
    }

    async _attempt(part, op) {
        const attempt = { abort: new AbortController(), client: null, current: true, finishing: false, error: null };
        const stop = () => {
            attempt.abort.abort();
            if (attempt.client) attempt.closePromise ||= Promise.resolve().then(() => attempt.client.disconnect()).catch(() => {});
            return attempt.closePromise;
        };
        attempt.stop = stop;
        this.active.add(attempt);
        op.abort.signal.addEventListener('abort', stop, { once: true });
        if (op.abort.signal.aborted) stop();
        const active = () => attempt.current && !op.cancelled && !op.fatal && !attempt.error;
        const check = () => { if (!active() || attempt.abort.signal.aborted) throw attempt.error || abortError(); };
        const fail = (code, message) => {
            if (!attempt.current || attempt.error || op.cancelled) return;
            attempt.error = Object.assign(new Error(message), { code });
            attempt.abort.abort();
        };
        const staged = new Map();
        const hadPrevious = [...this.owner.segments.values()].some(segment => segment.jobId === part.id);
        let prepared;
        let success = false;
        try {
            part.status = 'preparing'; this._publish(); check();
            try {
                prepared = await this._prepare(part, attempt.abort.signal); check();
                if (prepared.sampleRate !== SAMPLE_RATE || !Number.isSafeInteger(prepared.totalSamples) || prepared.totalSamples <= 0 ||
                    Math.abs(prepared.totalSamples / SAMPLE_RATE - part.duration) > 0.25) throw new Error('解码片段时长与原范围不一致，请调整切分点或另存为 WAV。');
            } catch (error) {
                const normalized = error instanceof Error ? error : new Error(String(error));
                if (!op.cancelled) normalized.local = true;
                throw normalized;
            }
            check();
            part.status = 'connecting'; this._publish();
            await this._reserveConnection(attempt.abort.signal); check();
            const client = this.owner.createClient(); attempt.client = client;
            client.onError = (code, message) => fail(code, message);
            client.onClosed = reason => {
                if (active() && !attempt.finishing) fail('connection_closed', `翻译连接提前关闭（${reason || '未知原因'}）`);
            };
            client.onProvisional = (text, meta = {}) => {
                if (!active() || !text?.trim()) return;
                this.previews.set(part.id, { partId: part.id, text, sourceText: meta.sourceText || '' });
                this._publish();
            };
            client.onSegment = (sourceText, text, meta = {}) => {
                if (!active() || !text?.trim() || !meta.itemId) return;
                const id = `${part.id}:${meta.itemId}`;
                const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
                const limit = part.endMs - part.startMs;
                const startMs = valid(meta.startMs) && meta.startMs < limit ? Math.round(part.startMs + meta.startMs) : null;
                const endMs = valid(meta.endMs) ? Math.round(part.startMs + Math.min(meta.endMs, limit)) : null;
                staged.set(id, { id, jobId: part.id, partId: part.sourcePartId || part.id, sourceText, text,
                    sourceItemId: meta.sourceItemId ? `${part.id}:${meta.sourceItemId}` : null,
                    startMs, endMs: startMs != null && endMs > startMs ? endMs : null, order: part.startMs + staged.size / 1000 });
                if (!hadPrevious) this._commit(part, staged);
                this.previews.delete(part.id);
                this._publish();
            };
            await client.connect(this.config); check();
            part.status = 'translating'; this._publish();
            let lastProgress = -Infinity;
            for (let start = 0; start < prepared.totalSamples; start += CHUNK_SAMPLES) {
                check();
                const began = this.owner.now(); // Include PCM IPC time in pacing; no extra wait for file reads.
                const count = Math.min(CHUNK_SAMPLES, prepared.totalSamples - start);
                const bytes = await prepared.pcmChunk(start, count); check();
                if (bytes.byteLength !== count * 2) throw Object.assign(new Error('音频片段读取不完整'), { local: true });
                await client.sendAudio(bytes); check();
                part.progress = (start + count) / prepared.totalSamples;
                if (this.owner.now() - lastProgress >= 250) { lastProgress = this.owner.now(); this._publish(); }
                await this.owner.sleep(count / 16 - (this.owner.now() - began), attempt.abort.signal);
            }
            attempt.finishing = true;
            part.status = 'finishing'; this._publish();
            for (let n = 0; n < 10; n++) {
                check();
                const began = this.owner.now();
                await client.sendAudio(new Uint8Array(CHUNK_SAMPLES * 2));
                await this.owner.sleep(100 - (this.owner.now() - began), attempt.abort.signal);
            }
            await client.finish(); check();
            this._commit(part, staged);
            success = true;
        } catch (error) {
            // A failed retry must not replace earlier useful text with a shorter failed attempt.
            // Only a confirmed successful retry may atomically replace old partials.
            if (staged.size && !hadPrevious) this._commit(part, staged);
            throw attempt.error || error;
        } finally {
            attempt.current = false;
            attempt.finishing = true;
            this.previews.delete(part.id);
            await stop();
            try { await prepared?.dispose(); } catch { /* Preserve the actual translation outcome. */ }
            op.abort.signal.removeEventListener('abort', stop);
            this.active.delete(attempt);
            if (success) { part.status = 'completed'; part.progress = 1; part.error = ''; }
        }
    }

    async _job(part, op) {
        let retries = 0;
        while (!op.cancelled && !op.fatal) {
            part.attempt++;
            part.error = '';
            part.progress = 0;
            try { await this._attempt(part, op); break; }
            catch (error) {
                if (op.cancelled || op.fatal) { part.status = 'cancelled'; break; }
                part.error = this._error(error);
                const policy = classifyAudioFileError(error);
                if (policy.fatal) {
                    part.status = 'failed'; op.fatal = part.error; op.abort.abort(); break;
                }
                if (policy.retry && retries < this.options.maxRetries) {
                    const delay = [2000, 5000][retries++];
                    part.status = 'retry_wait'; this._publish();
                    try { await this.owner.sleep(delay, op.abort.signal); }
                    catch { part.status = 'cancelled'; break; }
                    continue;
                }
                part.status = 'failed'; break;
            }
        }
        if (op.cancelled && part.status !== 'completed') part.status = 'cancelled';
        this._publish();
    }

    async run() {
        if (this.operation) return;
        const op = { abort: new AbortController(), cancelled: false, fatal: null, runner: this };
        this.operation = op;
        this.owner.operation = op;
        this._publish({ state: 'translating', targetLanguage: this.config.targetLanguage, splitError: '' });
        const tasks = new Set();
        try {
            while (!op.cancelled && !op.fatal) {
                while (tasks.size < this.options.parallelism) {
                    const part = this.parts.find(part => part.status === 'pending');
                    if (!part) break;
                    part.status = 'preparing';
                    const task = this._job(part, op).finally(() => tasks.delete(task));
                    tasks.add(task);
                }
                if (!tasks.size) break;
                await Promise.race(tasks);
            }
            await Promise.allSettled(tasks);
            for (const part of this.parts) {
                if (part.status === 'pending' || ACTIVE.has(part.status)) {
                    part.status = op.fatal ? 'failed' : 'cancelled';
                    if (op.fatal) part.error = `未发送：${op.fatal}`;
                }
            }
        } finally {
            this.previews.clear();
            this.operation = null;
            if (this.owner.operation === op) this.owner.operation = null;
            this._summary(op.cancelled);
        }
    }

    async cancel() {
        const op = this.operation;
        if (!op) return;
        op.cancelled = true;
        op.abort.abort();
        this._publish({ state: 'finishing', message: '正在取消并关闭连接…' });
        await Promise.allSettled([...this.active].map(attempt => attempt.stop()));
    }

    retryPart(id) {
        const part = this.parts.find(part => part.id === id);
        if (!part || !RETRYABLE.has(part.status)) throw new Error('只能重试失败、已跳过或已取消的片段。');
        part.status = 'pending'; part.error = ''; part.progress = 0;
        this._publish();
        if (!this.operation) return this.run();
    }

    retryFailed() {
        if (this.operation) throw new Error('请先等待当前任务完成。');
        const parts = this.parts.filter(part => ['failed', 'cancelled', 'pending'].includes(part.status));
        if (!parts.length) return;
        for (const part of parts) { part.status = 'pending'; part.error = ''; part.progress = 0; }
        return this.run();
    }

    skipPart(id) {
        const part = this.parts.find(part => part.id === id);
        if (part?.status !== 'failed') throw new Error('只能跳过请求已失败的片段，正常处理中的片段不能跳过。');
        part.status = 'skipped';
        if (this.operation) this._publish(); else this._summary();
    }
}
