import { QwenRealtimeClient } from './qwen-realtime-client.js';
import { QWEN_LANG_CODES } from './qwen-langs.js';
import { decodeAudioFile, probeAudioFile } from './audio-file-decode.js';
import { planAudioSegments, parseAudioSplitPoints } from './audio-file-split.js';
import { AudioFileRunner, planTranslationJobs } from './audio-file-runner.js';

const abortError = () => new DOMException('已取消', 'AbortError');

function wait(ms, signal) {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
        const done = () => { signal.removeEventListener('abort', cancelled); resolve(); };
        const timer = setTimeout(done, Math.max(0, ms));
        const cancelled = () => { clearTimeout(timer); signal.removeEventListener('abort', cancelled); reject(abortError()); };
        signal.addEventListener('abort', cancelled, { once: true });
    });
}

export function audioFileConfig(settings, { targetLanguage, glossaryDirection = 'none' }) {
    if (!QWEN_LANG_CODES.has(targetLanguage)) throw new Error('请选择有效的目标语言。');
    if (!['none', 'inbound', 'outbound'].includes(glossaryDirection)) throw new Error('请选择有效的术语词典。');
    if (!settings.qwen_api_key?.trim() || !settings.qwen_workspace_id?.trim()) {
        throw new Error('请先在设置中填写并保存 Qwen 百炼 API 密钥和业务空间 ID。');
    }
    return {
        apiKey: settings.qwen_api_key, workspaceId: settings.qwen_workspace_id,
        region: settings.qwen_region || 'cn-beijing', targetLanguage,
        audioOutput: false, turnDetection: 'server_vad', finishTimeoutMs: 30000,
        phrases: glossaryDirection === 'none' ? {} : structuredClone(settings[`qwen_glossary_${glossaryDirection}`] || {}),
    };
}

/** Owns file resources and an independent, paced Qwen session; never captures a microphone. */
export class AudioFileTranslation {
    constructor({ decode = decodeAudioFile, probe = probeAudioFile, openSource,
        createClient = () => new QwenRealtimeClient(), onChange = () => {},
        sleep = wait, now = () => performance.now() } = {}) {
        Object.assign(this, { decode, probe, openSource, createClient, onChange, sleep, now });
        this.audio = null;
        this.operation = null;
        this.segments = new Map();
        this.plannedParts = [];
        this.runner = null;
        this.snapshot = { state: 'empty', fileName: '', duration: 0, progress: 0, segments: [], audioUrl: '',
            message: '', parts: [], splitReady: false, splitError: '', partIndex: 0, partCount: 0 };
    }

    get busy() { return this.operation !== null; }

    _emit(patch = {}) {
        const groups = new Map();
        for (const segment of this.segments.values()) {
            const key = segment.sourceItemId ? `source:${segment.sourceItemId}` : `target:${segment.id}`;
            const group = groups.get(key);
            if (!group) groups.set(key, { ...segment });
            else {
                group.text += `\n${segment.text}`;
                if (segment.sourceText) group.sourceText = segment.sourceText;
                if (segment.startMs != null) group.startMs = segment.startMs;
                if (segment.endMs != null) group.endMs = segment.endMs;
            }
        }
        this.snapshot = { ...this.snapshot, ...patch, segments: [...groups.values()].sort((a, b) =>
            (a.startMs ?? Infinity) - (b.startMs ?? Infinity) || a.order - b.order) };
        this.onChange(this.snapshot);
    }

    choose(file) { return this._choose(signal => this.decode(file, { signal })); }
    chooseNative() {
        if (!this.openSource) throw new Error('当前环境不能自动读取大文件，请手动导入已切分的音频片段。');
        return this._choose(signal => this.openSource({ signal }));
    }

    chooseFiles(files) {
        return this._choose(async signal => {
            if (!files?.length || files.length > 500) throw new Error('请一次选择 1 至 500 个连续音频片段。');
            const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
            const items = [];
            try {
                let startSample = 0;
                for (const file of sorted) {
                    if (signal.aborted) throw abortError();
                    const preview = await this.probe(file, { signal });
                    items.push({ file, preview });
                    const samples = Math.round(preview.duration * 16000);
                    const startMs = startSample / 16;
                    startSample += samples;
                    if (startSample > 24 * 3600 * 16000) throw new Error('片段合计最长支持 24 小时。');
                    items.at(-1).part = { id: `part-${items.length}`, startMs, endMs: startSample / 16,
                        duration: samples / 16000, label: preview.fileName };
                }
                return {
                    fileName: items.length === 1 ? items[0].preview.fileName : `${items[0].preview.fileName} 等 ${items.length} 个片段`,
                    fileSize: items.reduce((sum, item) => sum + item.file.size, 0),
                    duration: startSample / 16000, audioUrl: items[0].preview.audioUrl,
                    fixedParts: items.map(item => item.part),
                    async preparePart(part, { signal }) {
                        const item = items.find(item => item.part.id === part.id);
                        if (!item) throw new Error('找不到音频片段，请重新导入。');
                        return await this._decode(item.file, { signal });
                    },
                    _decode: this.decode,
                    resolvePlayback(segment) {
                        const item = items.find(item => item.part.id === segment.partId);
                        if (!item) throw new Error('找不到该字幕的原始音频片段。');
                        return { audioUrl: item.preview.audioUrl, startMs: segment.startMs - item.part.startMs,
                            endMs: segment.endMs - item.part.startMs, offsetMs: item.part.startMs, label: item.preview.fileName };
                    },
                    async dispose() { for (const item of items) await item.preview.dispose(); },
                };
            } catch (error) { for (const item of items) await item.preview.dispose(); throw error; }
        });
    }

    async _choose(load) {
        if (this.busy) throw new Error('请等待当前任务完成，或先取消。');
        const previous = this.snapshot;
        const op = { abort: new AbortController(), cancelled: false };
        this.operation = op;
        this._emit({ state: 'decoding', message: '正在本机读取音频信息并规划分段…' });
        let source;
        try {
            source = await load(op.abort.signal);
            if (!source || op.cancelled || this.operation !== op) {
                await source?.dispose(); source = null;
                this._emit({ ...previous, message: '已取消选择，保留之前的音频与结果。' });
                return;
            }
            const parts = source.fixedParts || planAudioSegments(source.duration);
            const old = this.audio;
            this.audio = source; source = null;
            this.segments.clear();
            this.plannedParts = parts.map(part => ({ ...part }));
            this.runner = null;
            this._emit({ provisionals: [], partial: false, activePartIds: [], state: 'ready', fileName: this.audio.fileName, duration: this.audio.duration,
                fileSize: this.audio.fileSize, audioUrl: this.audio.audioUrl, progress: 0,
                parts, splitReady: true, splitError: '', manualFiles: !!this.audio.fixedParts,
                partIndex: 0, partCount: parts.length,
                message: `已准备 ${parts.length} 段，覆盖完整音频。点击开始后依次翻译。` });
            try { await old?.dispose(); } catch { /* New source remains usable if old cache cleanup fails. */ }
        } catch (error) {
            try { await source?.dispose(); } catch {}
            this._emit({ ...previous, message: op.cancelled ? '已取消读取，保留之前的音频与结果。'
                : `自动准备失败：${error.message || error}。可重试，或手动导入已切分文件。` });
        } finally {
            if (this.operation === op) this.operation = null;
            this._emit();
        }
    }

    split({ mode, segmentSeconds = 1200, pointsText = '' }) {
        if (this.busy) throw new Error('请先完成或取消当前任务。');
        if (!this.audio) throw new Error('请先选择音频。');
        if (this.audio.fixedParts) throw new Error('已导入的片段按文件边界处理；如需调整，请重新导入切分好的文件。');
        try {
            if (!['auto', 'manual'].includes(mode)) throw new Error('请选择自动或手动分段。');
            const parts = planAudioSegments(this.audio.duration, mode === 'manual'
                ? { boundaries: parseAudioSplitPoints(pointsText, this.audio.duration) } : { segmentSeconds });
            this.plannedParts = parts.map(part => ({ ...part }));
            this.runner = null;
            this._emit({ provisionals: [], activePartIds: [], state: 'ready', parts, splitReady: true, splitError: '', partCount: parts.length,
                partIndex: 0, progress: 0, message: `分段已更新：共 ${parts.length} 段，覆盖完整音频。再次开始时替换当前译文。` });
        } catch (error) {
            this._emit({ splitReady: false, splitError: error.message || String(error),
                message: '分段未应用，请调整分割点或重新自动分段。之前的译文仍可导出。' });
        }
    }

    resolvePlayback(segment) {
        if (!this.audio) throw new Error('原音频已关闭。');
        return this.audio.resolvePlayback?.(segment) || { audioUrl: this.audio.audioUrl,
            startMs: segment.startMs, endMs: segment.endMs, offsetMs: 0, label: this.audio.fileName };
    }

    async _preparePart(audio, part, signal) {
        if (audio.preparePart) return await audio.preparePart(part, { signal });
        const start = Math.round(part.startMs * 16);
        const end = Math.min(audio.totalSamples, Math.round(part.endMs * 16));
        return { sampleRate: audio.sampleRate, totalSamples: end - start,
            pcmChunk: (offset, count) => audio.pcmChunk(start + offset, count), dispose() {} };
    }

    async start(settings, options) {
        if (this.busy) throw new Error('音频任务正在处理中。');
        if (!this.audio || !this.snapshot.splitReady) throw new Error('请先选择音频并完成分段。');
        const { parallelism = 2, maxRetries = 2 } = options || {};
        if (![1, 2].includes(parallelism) || ![0, 1, 2].includes(maxRetries)) throw new Error('请选择有效的处理方式与重试次数。');
        const config = audioFileConfig(settings, options);
        const parts = planTranslationJobs(this.plannedParts, { parallelism, fixedParts: !!this.audio.fixedParts });
        this.segments.clear();
        this.runner = new AudioFileRunner(this, config, { ...options, parallelism, maxRetries }, parts);
        await this.runner.run();
    }

    _refreshRetryConfig(settings) {
        if (!this.runner || !this.audio || !this.snapshot.splitReady) throw new Error('请先开始文件翻译，或重新选择音频。');
        // Keep the original language/dictionary direction. Updated credentials can repair a failed request.
        if (settings && !this.busy) this.runner.config = audioFileConfig(settings, this.runner.options);
    }

    retryPart(id, settings) {
        this._refreshRetryConfig(settings);
        return this.runner.retryPart(id);
    }

    retryFailed(settings) {
        this._refreshRetryConfig(settings);
        return this.runner.retryFailed();
    }

    skipPart(id) {
        this._refreshRetryConfig();
        return this.runner.skipPart(id);
    }

    async cancel() {
        if (this.operation?.runner) return this.operation.runner.cancel();
        const op = this.operation;
        if (!op) return;
        op.cancelled = true;
        op.abort.abort();
    }

    async dispose() {
        await this.cancel();
        await this.audio?.dispose();
        this.audio = null;
    }
}

const cleanText = value => String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n');
const timestamp = (ms, separator) => {
    ms = Math.round(ms);
    const seconds = Math.floor(ms / 1000);
    return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}${separator}${String(ms % 1000).padStart(3, '0')}`;
};

export function exportAudioFileText(segments, { format, content = 'translated' }) {
    if (!['srt', 'vtt', 'txt'].includes(format) || !['translated', 'original', 'bilingual'].includes(content)) throw new Error('无效的导出格式。');
    if (!segments.length) throw new Error('暂无可导出的结果。');
    const ordered = [...segments].sort((a, b) => (a.startMs ?? Infinity) - (b.startMs ?? Infinity) || (a.order || 0) - (b.order || 0));
    const texts = ordered.map(segment => {
        const source = cleanText(segment.sourceText), target = cleanText(segment.text);
        if ((content !== 'translated' && !source) || (content !== 'original' && !target)) throw new Error('部分段落缺少所选文字，请等待原文与译文完整后导出，或切换导出内容。');
        return content === 'bilingual' ? `${source}\n${target}` : content === 'original' ? source : target;
    });
    if (format === 'txt') return texts.join('\n\n') + '\n';
    const cues = ordered.map((segment, index) => {
        if (!Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs) || segment.startMs < 0 || segment.endMs <= segment.startMs) {
            throw new Error('部分段落缺少准确时间戳，暂不能导出字幕；可先导出 TXT。');
        }
        const separator = format === 'srt' ? ',' : '.';
        const text = texts[index].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `${index + 1}\n${timestamp(segment.startMs, separator)} --> ${timestamp(segment.endMs, separator)}\n${text}`;
    });
    return (format === 'vtt' ? 'WEBVTT\n\n' : '') + cues.join('\n\n') + '\n\n';
}
