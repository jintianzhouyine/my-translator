import { QWEN_LANGS, QWEN_LANG_CODES } from './qwen-langs.js';

const BUSY_STATES = new Set(['decoding', 'connecting', 'translating', 'finishing']);
const STATES = new Set(['empty', 'ready', ...BUSY_STATES, 'completed', 'partial', 'cancelled', 'error']);
const ACTIVE_PART_STATES = new Set(['preparing', 'connecting', 'translating', 'finishing', 'retry_wait']);
const PART_LABELS = { pending: '等待处理', preparing: '准备音频', connecting: '正在连接', translating: '正在翻译',
    finishing: '收取最后字幕', retry_wait: '等待自动重试', completed: '已完成', failed: '请求失败', skipped: '已跳过失败片段', cancelled: '已取消' };
const PAGE_SIZE = 50;
const STATE_LABELS = {
    empty: '选择音频后开始翻译', ready: '本地音频已就绪，点击开始后上传', decoding: '正在读取本地音频…',
    connecting: '正在连接百炼…', translating: '正在翻译…', finishing: '正在收取最后的字幕…',
    completed: '翻译完成', partial: '部分片段未完成，可重试失败片段或导出部分结果',
    cancelled: '已取消，可导出已完成的内容', error: '处理失败，请检查提示后重试',
};

export function hasAudioSegmentTiming(segment) {
    return Number.isFinite(segment?.startMs) && Number.isFinite(segment?.endMs) &&
        segment.startMs >= 0 && segment.endMs > segment.startMs;
}

function clockTime(milliseconds) {
    const value = Math.max(0, Math.floor(milliseconds));
    const seconds = Math.floor(value / 1000);
    return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${String(value % 1000).padStart(3, '0')}`;
}

const emptyResult = () => ({ fileName: '', duration: null, fileSize: null, audioUrl: '', segments: [], parts: [], provisionals: [], splitReady: false, splitError: '', manualFiles: false });

/** View only: callbacks own decoding, cloud sessions, export dialogs and object URL lifetime. */
export class AudioFileUI {
    constructor({ document = globalThis.document, getSettings = () => ({}), onChoose = () => {},
        onStart = () => {}, onCancel = () => {}, onExport = () => {}, onOpenSettings = () => {},
        onError = () => {}, onBeforePlayback, onPickSource, onChooseFiles, onSplit, onResolvePlayback,
        onRetryPart, onSkipPart, onRetryFailed,
        schedule = globalThis.setTimeout.bind(globalThis), cancelTimer = globalThis.clearTimeout.bind(globalThis) } = {}) {
        Object.assign(this, { document, getSettings, onChoose, onStart, onCancel, onExport, onOpenSettings,
            onError, onBeforePlayback, onPickSource, onChooseFiles, onSplit, onResolvePlayback,
            onRetryPart, onSkipPart, onRetryFailed, schedule, cancelTimer });
        this.snapshot = { state: 'empty' };
        this.result = emptyResult();
        this.page = 0;
        this.partsPage = 0;
        this._splitDirty = false;
        this._playbackOffsetMs = 0;
        this._listeners = [];
        this._rows = new Map();
        this._partRows = new Map();
        this._partRequests = new Map();
        this._choiceGeneration = 0;
        this._playGeneration = 0;
        this._timer = null;
        this._region = null;
        this._message = '';
    }

    el(id) { return this.document.getElementById(id); }
    get audio() { return this.el('audio-file-player'); }

    _bind(element, event, listener) {
        if (!element) return;
        element.addEventListener(event, listener);
        this._listeners.push(() => element.removeEventListener(event, listener));
    }

    init() {
        if (this._initialized) return;
        this._initialized = true;
        this._disposed = false;
        const language = this.el('select-audio-file-language');
        language.replaceChildren();
        for (const { code, name } of QWEN_LANGS) {
            const option = this.document.createElement('option');
            option.value = code;
            option.textContent = name;
            language.append(option);
        }
        const preferred = this.getSettings()?.qwen_my_language;
        language.value = QWEN_LANG_CODES.has(preferred) ? preferred : 'zh';
        this.el('select-audio-file-glossary').value = 'none';
        this.el('select-audio-file-export-content').value = 'translated';
        this.el('select-audio-file-split-mode').value = 'auto';
        this.el('select-audio-file-split-minutes').value = '20';
        this.el('select-audio-file-parallelism').value = '2';
        this.el('select-audio-file-retries').value = '2';
        this._bind(this.el('btn-audio-file-choose'), 'click', () => {
            if (this.onPickSource) { void this._chooseSource(() => this.onPickSource()); return; }
            const input = this.el('input-audio-file');
            input.value = '';
            input.click();
        });
        this._bind(this.el('btn-audio-file-choose-parts'), 'click', () => {
            const input = this.el('input-audio-file-parts');
            input.value = '';
            input.click();
        });
        this._bind(this.el('input-audio-file-parts'), 'change', event => {
            const files = Array.from(event.target.files || []);
            if (files.length && this.onChooseFiles) void this._chooseSource(() => this.onChooseFiles(files));
        });
        for (const [id, event] of [['select-audio-file-split-mode', 'change'], ['select-audio-file-split-minutes', 'change'], ['input-audio-file-split-points', 'input']]) {
            this._bind(this.el(id), event, () => { this._splitDirty = true; this._renderControls(); });
        }
        this._bind(this.el('btn-audio-file-split'), 'click', () => { void this._applySplit(); });
        this._bind(this.el('btn-audio-file-parts-prev'), 'click', () => this._setPartsPage(this.partsPage - 1));
        this._bind(this.el('btn-audio-file-parts-next'), 'click', () => this._setPartsPage(this.partsPage + 1));
        this._bind(this.el('input-audio-file'), 'change', event => {
            const file = event.target.files?.[0];
            if (file) void this._choose(file);
        });
        this._bind(this.el('btn-audio-file-start'), 'click', () => { void this._start(); });
        this._bind(this.el('btn-audio-file-cancel'), 'click', () => { void this._cancel(); });
        this._bind(this.el('btn-audio-file-retry-failed'), 'click', () => { void this._retryFailed(); });
        this._bind(this.el('btn-audio-file-settings'), 'click', () => { void this._run(() => this.onOpenSettings()); });
        this._bind(this.el('select-audio-file-export-content'), 'change', () => this._renderControls());
        for (const format of ['srt', 'vtt', 'txt']) {
            this._bind(this.el(`btn-audio-file-export-${format}`), 'click', () => { void this._export(format); });
        }
        this._bind(this.el('btn-audio-file-prev'), 'click', () => this._setPage(this.page - 1));
        this._bind(this.el('btn-audio-file-next'), 'click', () => this._setPage(this.page + 1));
        this._bind(this.audio, 'pause', () => { if (this.audio.paused) { this._clearRegion(); this._highlight(); } });
        this._bind(this.audio, 'ended', () => { this._clearRegion(); this._highlight(); });
        this._bind(this.audio, 'seeking', () => {
            this._clearTimer();
            if (!this._region?.awaitingSeek || Math.abs(this.audio.currentTime - this._region.start) > 0.15) this._clearRegion();
        });
        this._bind(this.audio, 'seeked', () => {
            if (this._region?.awaitingSeek) this._region.awaitingSeek = false;
            this._armStop();
            this._highlight();
        });
        this._bind(this.audio, 'play', () => {
            if (this.onBeforePlayback && this._authorizedPlayGeneration !== this._playGeneration) {
                void this._authorizeNativePlayback();
            } else { this._armStop(); this._highlight(); }
        });
        this._bind(this.audio, 'ratechange', () => this._armStop());
        this._bind(this.audio, 'timeupdate', () => {
            if (this._region && this.audio.currentTime >= this._region.end) this.audio.pause();
            this._highlight();
        });
        this._render();
    }

    /** duration is seconds, progress is 0..1, segment timings are original-audio milliseconds. */
    setSnapshot(snapshot) {
        if (this._disposed || !snapshot || !STATES.has(snapshot.state)) return;
        const oldUrl = this.result.audioUrl;
        const stateChanged = snapshot.state !== this.snapshot.state;
        this.snapshot = { ...this.snapshot, ...snapshot };
        if (stateChanged && !Object.hasOwn(snapshot, 'progress')) delete this.snapshot.progress;
        if (stateChanged && !Object.hasOwn(snapshot, 'message')) delete this.snapshot.message;
        this._message = '';
        if (snapshot.state === 'empty') { this.result = emptyResult(); this._splitDirty = false; this._partRequests.clear(); }
        else if (snapshot.state === 'ready') {
            this.result = { ...emptyResult(), ...this._resultFields(snapshot) };
            if (this.result.fileSize == null && this._candidateFile?.name === this.result.fileName) {
                this.result.fileSize = this._candidateFile.size;
            }
            this.page = 0;
            if (this.result.splitReady && this.result.parts.length) this._splitDirty = false;
        } else if ((snapshot.state !== 'decoding' || snapshot.fileName === this.result.fileName) && this.result.fileName &&
            (snapshot.audioUrl ? snapshot.audioUrl === oldUrl : !snapshot.fileName || snapshot.fileName === this.result.fileName)) {
            // A failed replacement file must not erase the successfully decoded file/results.
            this.result = { ...this.result, ...this._resultFields(snapshot) };
        }
        if (oldUrl !== this.result.audioUrl || (snapshot.state === 'ready' && this._playerUrl !== this.result.audioUrl)) {
            this._partRequests.clear();
            this._setPlayerSource(this.result.audioUrl, 0);
            this.page = 0;
            this.partsPage = 0;
        }
        for (const [id, request] of this._partRequests) {
            const part = this.result.parts.find(part => part.id === id);
            if (!part || part.status !== request.status || part.attempt !== request.attempt) this._partRequests.delete(id);
        }
        this._render();
    }

    _resultFields(snapshot) {
        const fields = {};
        for (const key of ['fileName', 'duration', 'fileSize', 'audioUrl', 'splitReady', 'splitError', 'manualFiles']) {
            if (Object.hasOwn(snapshot, key) && !(key === 'audioUrl' && !snapshot[key])) fields[key] = snapshot[key];
        }
        if (Array.isArray(snapshot.segments)) fields.segments = snapshot.segments.map((segment, index) => ({
            id: String(segment.id ?? index), partId: segment.partId, sourceText: String(segment.sourceText ?? ''), text: String(segment.text ?? ''),
            startMs: segment.startMs, endMs: segment.endMs,
        }));
        if (Array.isArray(snapshot.parts)) fields.parts = snapshot.parts.map((part, index) => ({ ...part,
            id: String(part.id ?? index), label: String(part.label ?? part.fileName ?? part.name ?? ''),
        }));
        if (Array.isArray(snapshot.provisionals)) fields.provisionals = snapshot.provisionals.map(item => ({
            partId: String(item.partId ?? ''), text: String(item.text ?? ''), sourceText: String(item.sourceText ?? ''),
        }));
        return fields;
    }

    _busy() { return BUSY_STATES.has(this.snapshot.state) || !!this._choosing || !!this._starting || !!this._cancelling || !!this._splitting || !!this._retryingFailed || !!this._partDispatchCount; }

    async _run(callback) {
        try { return await callback(); }
        catch (error) { this._reportError(error); return undefined; }
    }

    _reportError(error) {
        if (this._disposed) return;
        this._message = error?.message || String(error);
        this._renderControls();
        try { Promise.resolve(this.onError(this._message)).catch(() => {}); }
        catch { /* The UI must not create another unhandled rejection. */ }
    }

    async _choose(file) {
        return this._chooseSource(() => this.onChoose(file), file);
    }

    async _chooseSource(callback, file = null) {
        if (this._busy()) return;
        const generation = ++this._choiceGeneration;
        this._choosing = true;
        this._candidateFile = file;
        this._message = '';
        this._pause();
        this._renderControls();
        try { await callback(); }
        catch (error) { if (generation === this._choiceGeneration) this._reportError(error); }
        finally {
            if (generation === this._choiceGeneration) { this._choosing = false; this._renderControls(); }
        }
    }

    async _applySplit() {
        if (this._busy() || !this.result.fileName || !this.onSplit || this.result.manualFiles) return;
        const mode = this.el('select-audio-file-split-mode').value;
        const minutes = Number(this.el('select-audio-file-split-minutes').value);
        if (!['auto', 'manual'].includes(mode) || (mode === 'auto' && ![5, 10, 20, 30].includes(minutes))) {
            this._reportError(new Error('请选择有效的分段方式和时长。'));
            return;
        }
        this._splitDirty = true;
        this._splitting = true;
        this._message = '';
        this._pause();
        this._renderControls();
        await this._run(() => this.onSplit(mode === 'auto'
            ? { mode, segmentSeconds: minutes * 60 }
            : { mode, pointsText: this.el('input-audio-file-split-points').value }));
        this._splitting = false;
        this._renderControls();
    }

    async _start() {
        if (this._busy() || !this.result.fileName || !this.result.splitReady || !this.result.parts.length || this._splitDirty) return;
        const targetLanguage = this.el('select-audio-file-language').value;
        const glossaryDirection = this.el('select-audio-file-glossary').value;
        const parallelism = Number(this.el('select-audio-file-parallelism').value);
        const maxRetries = Number(this.el('select-audio-file-retries').value);
        if (!QWEN_LANG_CODES.has(targetLanguage) || !['none', 'inbound', 'outbound'].includes(glossaryDirection)) {
            this._reportError(new Error('请选择有效的目标语言和词典。'));
            return;
        }
        if (![1, 2].includes(parallelism) || ![0, 1, 2].includes(maxRetries)) {
            this._reportError(new Error('请选择有效的处理方式和自动重试次数。'));
            return;
        }
        this._starting = true;
        this._message = '';
        this._pause();
        this._renderControls();
        await this._run(() => this.onStart({ targetLanguage, glossaryDirection, parallelism, maxRetries }));
        this._starting = false;
        this._renderControls();
    }

    async _cancel() {
        if (!this._busy() || this._cancelling) return;
        this._cancelling = true;
        this._renderControls();
        await this._run(() => this.onCancel());
        this._cancelling = false;
        this._renderControls();
    }

    _canPartAction(part, action) {
        if (!part || this._disposed || this._choosing || this._splitting || this._cancelling || this._retryingFailed ||
            this._splitDirty || this._partRequests.has(part.id)) return false;
        if (action === 'skip') return part.status === 'failed' && !!this.onSkipPart;
        return action === 'retry' && ['failed', 'skipped', 'cancelled'].includes(part.status) && !!this.onRetryPart;
    }

    async _partAction(id, action) {
        const part = this.result.parts.find(part => part.id === id);
        if (!this._canPartAction(part, action)) return;
        const request = { action, status: part.status, attempt: part.attempt };
        this._partRequests.set(id, request);
        this._partDispatchCount = (this._partDispatchCount || 0) + 1;
        this._message = '';
        this._pause();
        this._renderParts();
        this._renderControls();
        try {
            await (action === 'skip' ? this.onSkipPart(id) : this.onRetryPart(id));
            // Keep the action locked until a new controller status confirms the request.
        } catch (error) {
            if (this._partRequests.get(id) === request) this._partRequests.delete(id);
            this._reportError(error);
        } finally {
            this._partDispatchCount--;
            if (!this._disposed) { this._renderParts(); this._renderControls(); }
        }
    }

    async _retryFailed() {
        if (this._busy() || this._splitDirty || !this.onRetryFailed ||
            !this.result.parts.some(part => ['failed', 'cancelled', 'pending'].includes(part.status))) return;
        this._retryingFailed = true;
        this._message = '';
        this._pause();
        this._renderParts();
        this._renderControls();
        await this._run(() => this.onRetryFailed());
        this._retryingFailed = false;
        this._renderParts();
        this._renderControls();
    }

    _exportAllowed(format) {
        if (this._busy() || this._exporting || !this.result.segments.length) return false;
        const content = this.el('select-audio-file-export-content').value;
        if (content !== 'translated' && this.result.segments.some(segment => !segment.sourceText.trim())) return false;
        return format === 'txt' || this.result.segments.every(hasAudioSegmentTiming);
    }

    async _export(format) {
        if (!this._exportAllowed(format)) return;
        this._exporting = true;
        this._message = '';
        this._renderControls();
        await this._run(() => this.onExport({ format, content: this.el('select-audio-file-export-content').value }));
        this._exporting = false;
        this._renderControls();
    }

    _render() {
        if (!this._initialized || this._disposed) return;
        this.el('audio-file-name').textContent = this.result.fileName || '尚未选择音频';
        const metadata = [];
        if (Number.isFinite(this.result.duration) && this.result.duration > 0) metadata.push(`时长 ${clockTime(this.result.duration * 1000).slice(0, -4)}`);
        if (Number.isFinite(this.result.fileSize) && this.result.fileSize > 0) metadata.push(`${(this.result.fileSize / (1024 * 1024)).toFixed(1)} MiB`);
        this.el('audio-file-metadata').textContent = metadata.length ? metadata.join(' · ')
            : 'WAV、MP3、M4A、AAC、FLAC、OGG · 超大或长音频自动分段；手动导入的每片须不超过 100 MiB／30 分钟';
        this.el('audio-file-player-wrap').hidden = !this._playerUrl;
        this._renderParts();
        this._renderProvisionals();
        this._renderSegments();
        this._renderControls();
    }

    _renderControls() {
        if (!this._initialized || this._disposed) return;
        const busy = this._busy();
        this.el('btn-audio-file-choose').disabled = busy;
        this.el('btn-audio-file-choose-parts').disabled = busy || !this.onChooseFiles;
        this.el('select-audio-file-language').disabled = busy;
        this.el('select-audio-file-glossary').disabled = busy;
        this.el('select-audio-file-parallelism').disabled = busy;
        this.el('select-audio-file-retries').disabled = busy;
        this.el('btn-audio-file-start').disabled = busy || !this.result.fileName || !this.result.splitReady || !this.result.parts.length || this._splitDirty;
        this.el('btn-audio-file-start').textContent = this.result.segments.length ? '重新翻译' : '开始翻译';
        this.el('btn-audio-file-cancel').hidden = !busy;
        this.el('btn-audio-file-cancel').disabled = !!this._cancelling;
        this.el('btn-audio-file-cancel').textContent = this._cancelling ? '正在取消…' : '取消翻译';
        const retryFailed = this.el('btn-audio-file-retry-failed');
        retryFailed.hidden = !this.onRetryFailed || !this.result.parts.some(part => ['failed', 'cancelled', 'pending'].includes(part.status));
        retryFailed.disabled = busy || this._splitDirty || this._partRequests.size > 0;
        retryFailed.textContent = this._retryingFailed ? '正在安排重试…' : '重试未完成片段';
        const manual = this.el('select-audio-file-split-mode').value === 'manual';
        this.el('audio-file-split-duration-field').hidden = manual;
        this.el('audio-file-split-points-field').hidden = !manual;
        for (const id of ['select-audio-file-split-mode', 'select-audio-file-split-minutes', 'input-audio-file-split-points']) {
            this.el(id).disabled = busy || this.result.manualFiles;
        }
        this.el('btn-audio-file-split').disabled = busy || !this.result.fileName || !this.onSplit || this.result.manualFiles;
        this.el('btn-audio-file-split').textContent = this._splitting ? '正在分段…' : manual ? '应用分割点' : '重新分段';
        const splitStatus = this.el('audio-file-split-status');
        splitStatus.dataset.error = String(!!this.result.splitError);
        splitStatus.textContent = this.result.splitError
            ? `${this.result.splitError} 可调整分割点后重试，或导入已切分音频；当前文件与原音预览仍保留。`
            : this.result.manualFiles ? `已按文件名顺序导入 ${this.result.parts.length} 个片段，按各文件边界处理；如需调整，请重新导入切分好的文件。`
                : this._splitDirty ? '分段设置尚未应用，请点击「重新分段」或「应用分割点」后再开始翻译。'
                : this.result.splitReady && this.result.parts.length
                    ? `已分为 ${this.result.parts.length} 段，覆盖本次导入音频${Number.isFinite(this.result.duration) ? ` ${clockTime(this.result.duration * 1000).slice(0, -4)}` : ''}；译文按原时间轴合并。`
                    : this.result.fileName ? '尚未完成分段，可先试听原音，再调整分段方式或重试。'
                        : '选择音频后自动生成分段；分段操作仅在本机进行。';
        const status = this.el('audio-file-status');
        status.textContent = this._message || (this._choosing ? STATE_LABELS.decoding : this.snapshot.message || STATE_LABELS[this.snapshot.state]);
        status.dataset.error = String(!!this._message || ['error', 'partial'].includes(this.snapshot.state));
        const progress = this.el('audio-file-progress');
        progress.hidden = !busy;
        if (Number.isFinite(this.snapshot.progress)) progress.value = Math.min(1, Math.max(0, this.snapshot.progress));
        else progress.removeAttribute('value');
        for (const format of ['srt', 'vtt', 'txt']) this.el(`btn-audio-file-export-${format}`).disabled = !this._exportAllowed(format);
        this.el('select-audio-file-export-content').disabled = busy || !!this._exporting;
        const missingTiming = this.result.segments.filter(segment => !hasAudioSegmentTiming(segment)).length;
        const incomplete = this.result.parts.some(part => ['failed', 'skipped', 'cancelled', 'pending'].includes(part.status));
        this.el('audio-file-export-hint').textContent = missingTiming
            ? `有 ${missingTiming} 段时间未对齐，暂不能导出 SRT／VTT；仍可导出 TXT。`
            : this.el('select-audio-file-export-content').value !== 'translated' && this.result.segments.some(segment => !segment.sourceText.trim())
                ? '部分段落尚无原文，目前仅可导出译文。' : incomplete && !busy
                    ? '当前导出为部分结果，未完成或跳过的片段会留下时间空缺；未定稿文字不导出。' : '';
    }

    _setPartsPage(page) {
        this.partsPage = Math.min(Math.max(0, page), Math.max(0, Math.ceil(this.result.parts.length / PAGE_SIZE) - 1));
        this._renderParts();
    }

    _renderParts() {
        if (!this._initialized || this._disposed) return;
        const total = this.result.parts.length;
        this.partsPage = Math.min(this.partsPage, Math.max(0, Math.ceil(total / PAGE_SIZE) - 1));
        const first = this.partsPage * PAGE_SIZE;
        const visible = this.result.parts.slice(first, first + PAGE_SIZE);
        const signature = JSON.stringify([first, total, this.result.audioUrl, visible.map(({ progress, ...part }) => part),
            visible.map(part => [this._canPartAction(part, 'retry'), this._canPartAction(part, 'skip'), this._partRequests.get(part.id)?.action])]);
        if (signature !== this._renderedParts) {
            this._renderedParts = signature;
            const list = this.el('audio-file-parts');
            list.replaceChildren();
            this._partRows.clear();
            for (let index = first; index < Math.min(first + PAGE_SIZE, total); index++) {
                const part = this.result.parts[index];
                const row = this.document.createElement('div');
                row.className = 'audio-file-part-row';
                row.dataset.status = part.status || 'planned';
                const play = this.document.createElement('button');
                play.type = 'button';
                play.className = 'audio-file-part';
                play.textContent = `${index + 1}. ${hasAudioSegmentTiming(part) ? `${clockTime(part.startMs)} – ${clockTime(part.endMs)}` : '时间信息不完整'}${part.label ? ` · ${part.label}` : ''}`;
                play.disabled = !hasAudioSegmentTiming(part) || (!this.result.audioUrl && !this.onResolvePlayback);
                play.title = '回听这一段原始音频';
                play.addEventListener('click', () => { void this._playSegment({ ...part, partId: part.id }); });
                const status = this.document.createElement('span');
                status.className = 'audio-file-part-status';
                row.append(play, status);
                if (part.error) {
                    const error = this.document.createElement('p');
                    error.className = 'audio-file-part-error';
                    error.textContent = String(part.error);
                    row.append(error);
                }
                const actions = this.document.createElement('div');
                actions.className = 'audio-file-part-actions';
                if (['failed', 'skipped', 'cancelled'].includes(part.status) && this.onRetryPart) {
                    const retry = this.document.createElement('button');
                    retry.type = 'button';
                    retry.className = 'btn-secondary small';
                    retry.textContent = this._partRequests.get(part.id)?.action === 'retry' ? '已请求重试…' : '重试此片段';
                    retry.disabled = !this._canPartAction(part, 'retry');
                    retry.addEventListener('click', () => { void this._partAction(part.id, 'retry'); });
                    actions.append(retry);
                }
                if (part.status === 'failed' && this.onSkipPart) {
                    const skip = this.document.createElement('button');
                    skip.type = 'button';
                    skip.className = 'btn-secondary small';
                    skip.textContent = this._partRequests.get(part.id)?.action === 'skip' ? '正在跳过…' : '跳过失败片段';
                    skip.disabled = !this._canPartAction(part, 'skip');
                    skip.addEventListener('click', () => { void this._partAction(part.id, 'skip'); });
                    actions.append(skip);
                }
                if (actions.children.length) row.append(actions);
                list.append(row);
                this._partRows.set(index, { row, status });
            }
            this.el('audio-file-parts-pagination').hidden = total <= PAGE_SIZE;
            this.el('audio-file-parts-page-label').textContent = total ? `${first + 1}–${Math.min(first + PAGE_SIZE, total)} 段，共 ${total} 段` : '';
            this.el('btn-audio-file-parts-prev').disabled = this.partsPage === 0;
            this.el('btn-audio-file-parts-next').disabled = first + PAGE_SIZE >= total;
        }
        for (const [index, { row, status }] of this._partRows) {
            const part = this.result.parts[index];
            const active = Array.isArray(this.snapshot.activePartIds)
                ? this.snapshot.activePartIds.includes(part.id) : BUSY_STATES.has(this.snapshot.state) && this.snapshot.partIndex === index;
            row.classList.toggle('current', active);
            status.textContent = part.status ? `${PART_LABELS[part.status] || part.status}${part.attempt ? ` · 第 ${part.attempt} 次请求` : ''}${
                ACTIVE_PART_STATES.has(part.status) && Number.isFinite(part.progress) ? ` · ${Math.round(Math.min(1, Math.max(0, part.progress)) * 100)}%` : ''}` : '';
        }
    }

    _renderProvisionals() {
        if (!this._initialized || this._disposed) return;
        const list = this.el('audio-file-provisionals');
        const items = BUSY_STATES.has(this.snapshot.state) ? this.result.provisionals.filter(item => item.text.trim() || item.sourceText.trim()) : [];
        list.hidden = !items.length;
        const signature = JSON.stringify(items);
        if (signature === this._renderedProvisionals) return;
        this._renderedProvisionals = signature;
        list.replaceChildren();
        for (const item of items) {
            const card = this.document.createElement('div');
            card.className = 'audio-file-provisional';
            const label = this.document.createElement('span');
            const index = this.result.parts.findIndex(part => part.id === item.partId);
            label.textContent = `正在生成 · ${index < 0 ? '当前' : `第 ${index + 1} 个`}片段（未定稿）`;
            label.className = 'audio-file-segment-time';
            const source = this.document.createElement('span');
            source.className = 'audio-file-segment-source';
            source.textContent = item.sourceText;
            const target = this.document.createElement('span');
            target.className = 'audio-file-segment-target';
            target.textContent = item.text || '正在识别原文…';
            card.append(label, source, target);
            list.append(card);
        }
    }

    _setPage(page) {
        this.page = Math.min(Math.max(0, page), Math.max(0, Math.ceil(this.result.segments.length / PAGE_SIZE) - 1));
        this._renderSegments();
    }

    _renderSegments() {
        const list = this.el('audio-file-segments');
        const total = this.result.segments.length;
        this.page = Math.min(this.page, Math.max(0, Math.ceil(total / PAGE_SIZE) - 1));
        const first = this.page * PAGE_SIZE;
        const signature = JSON.stringify([this.result.audioUrl, first, total,
            this.result.segments.slice(first, first + PAGE_SIZE)]);
        if (signature === this._renderedSegments) { this._highlight(); return; }
        this._renderedSegments = signature;
        list.replaceChildren();
        this._rows.clear();
        if (!total) {
            const empty = this.document.createElement('p');
            empty.className = 'audio-file-empty';
            empty.textContent = '翻译结果将显示在这里，支持逐段回听原始音频。';
            list.append(empty);
        }
        for (let index = first; index < Math.min(first + PAGE_SIZE, total); index++) {
            const segment = this.result.segments[index];
            const row = this.document.createElement('button');
            row.type = 'button';
            row.className = 'audio-file-segment';
            row.disabled = !hasAudioSegmentTiming(segment) || (!this.result.audioUrl && !this.onResolvePlayback);
            row.title = row.disabled ? '缺少原音或可靠时间信息，无法定位播放' : '播放这一段原始音频';
            for (const [className, text] of [
                ['audio-file-segment-time', hasAudioSegmentTiming(segment) ? `${clockTime(segment.startMs)} – ${clockTime(segment.endMs)}` : '时间未对齐'],
                ['audio-file-segment-source', segment.sourceText || '暂无原文'],
                ['audio-file-segment-target', segment.text || '暂无译文'],
            ]) {
                const span = this.document.createElement('span');
                span.className = className;
                span.textContent = text;
                row.append(span);
            }
            row.addEventListener('click', () => { void this._playSegment(segment); });
            list.append(row);
            this._rows.set(index, row);
        }
        this.el('audio-file-pagination').hidden = total <= PAGE_SIZE;
        this.el('audio-file-page-label').textContent = total ? `${first + 1}–${Math.min(first + PAGE_SIZE, total)} 段，共 ${total} 段` : '';
        this.el('btn-audio-file-prev').disabled = this.page === 0;
        this.el('btn-audio-file-next').disabled = first + PAGE_SIZE >= total;
        this._highlight();
    }

    async _playSegment(segment) {
        if (!hasAudioSegmentTiming(segment) || (!this.result.audioUrl && !this.onResolvePlayback) || this._disposed) return;
        this._clearRegion();
        let generation = this._playGeneration;
        try {
            if (this.onBeforePlayback) await this.onBeforePlayback();
            if (generation !== this._playGeneration || this._disposed) return;
            const playback = this.onResolvePlayback ? await this.onResolvePlayback(segment)
                : { audioUrl: this.result.audioUrl, startMs: segment.startMs, endMs: segment.endMs, offsetMs: 0 };
            if (generation !== this._playGeneration || this._disposed) return;
            if (!playback?.audioUrl || !hasAudioSegmentTiming(playback) || !Number.isFinite(playback.offsetMs) || playback.offsetMs < 0) {
                throw new Error('无法定位原音文件或对应的播放时间。');
            }
            if (this._playerUrl !== playback.audioUrl || this._playbackOffsetMs !== playback.offsetMs) {
                this._setPlayerSource(playback.audioUrl, playback.offsetMs, playback.label);
                generation = this._playGeneration;
            } else this._setPlayerLabel(playback.label);
            this._authorizedPlayGeneration = generation;
            this._region = { start: playback.startMs / 1000, end: playback.endMs / 1000, awaitingSeek: true };
            this.audio.currentTime = this._region.start;
            await this.audio.play();
            if (generation !== this._playGeneration || this._disposed) return;
            if (!this.audio.seeking && this._region) this._region.awaitingSeek = false;
            this._armStop();
            this._highlight();
        } catch (error) {
            if (generation !== this._playGeneration) return;
            this._clearRegion();
            this._reportError(new Error(`无法播放原始音频：${error?.message || error}`));
        }
    }

    _setPlayerLabel(label) {
        this.el('audio-file-playback-label').textContent = label
            ? `原始音频 · ${label}` : '原始音频 · 点击带时间的字幕可播放对应原音';
    }

    _setPlayerSource(audioUrl, offsetMs = 0, label) {
        this._pause();
        this._playerUrl = audioUrl || '';
        this._playbackOffsetMs = offsetMs;
        if (audioUrl) this.audio.src = audioUrl;
        else this.audio.removeAttribute('src');
        this.audio.load();
        this.el('audio-file-player-wrap').hidden = !audioUrl;
        this._setPlayerLabel(label);
    }

    async _authorizeNativePlayback() {
        // Native controls can request play before an async live-session pause has finished.
        this.audio.pause();
        const generation = this._playGeneration;
        try {
            await this.onBeforePlayback();
            if (generation !== this._playGeneration || this._disposed) return;
            this._authorizedPlayGeneration = generation;
            await this.audio.play();
        } catch (error) {
            if (generation === this._playGeneration) this._reportError(new Error(`无法播放原始音频：${error?.message || error}`));
        }
    }

    _armStop() {
        this._clearTimer();
        if (!this._region || this._region.awaitingSeek || this.audio.paused || this.audio.seeking) return;
        const remaining = this._region.end - this.audio.currentTime;
        if (remaining <= 0) { this.audio.pause(); return; }
        const rate = this.audio.playbackRate > 0 ? this.audio.playbackRate : 1;
        this._timer = this.schedule(() => { this._timer = null; this._armStop(); }, Math.max(20, remaining / rate * 1000));
    }

    _clearTimer() { if (this._timer !== null) this.cancelTimer(this._timer); this._timer = null; }
    _clearRegion() { this._clearTimer(); this._region = null; ++this._playGeneration; }
    _pause() { this._clearRegion(); this.audio?.pause(); this._highlight(); }

    _highlight() {
        if (!this.audio) return;
        const milliseconds = this.audio.currentTime * 1000 + this._playbackOffsetMs;
        for (const [index, row] of this._rows) {
            const segment = this.result.segments[index];
            row.classList.toggle('playing', !this.audio.paused && hasAudioSegmentTiming(segment) &&
                milliseconds >= segment.startMs && milliseconds < segment.endMs);
        }
    }

    /** Leaving a tab pauses the original player; the controller's translation job continues. */
    onLeave() { this._pause(); }

    cleanup() {
        this._pause();
        this._disposed = true;
        ++this._choiceGeneration;
        for (const remove of this._listeners.splice(0)) remove();
        this.el('audio-file-segments')?.replaceChildren();
        this.el('audio-file-parts')?.replaceChildren();
        this.el('audio-file-provisionals')?.replaceChildren();
        this._renderedSegments = null;
        this._renderedParts = null;
        this._renderedProvisionals = null;
        this._rows.clear();
        this._partRows.clear();
        this._partRequests.clear();
        this.audio?.removeAttribute('src');
        this.audio?.load();
        this._initialized = false;
    }
}
