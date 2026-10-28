// Planning only. Every boundary is an integer sample on the decoded 16 kHz timeline.
const SAMPLE_RATE = 16000;
const MAX_DURATION_SECONDS = 24 * 60 * 60;
const MAX_SEGMENT_SECONDS = 30 * 60;
const MAX_SEGMENTS = 500;

function durationSamples(durationSeconds) {
    if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new Error('音频时长必须是大于零的有效秒数。');
    }
    if (durationSeconds > MAX_DURATION_SECONDS) throw new Error('音频总时长最多支持 24 小时。');
    const samples = Math.round(durationSeconds * SAMPLE_RATE);
    if (samples < 1) throw new Error('音频时长不足一个 16 kHz 采样点，无法分段。');
    return samples;
}

function boundarySamples(boundaries, durationSeconds, totalSamples) {
    if (!Array.isArray(boundaries)) throw new Error('手动分割点必须是秒数数组。');
    if (boundaries.length + 1 > MAX_SEGMENTS) throw new Error('分段数量最多为 500 段，请减少分割点。');
    const sorted = boundaries.map(value => {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= durationSeconds) {
            throw new Error('每个分割点必须大于 0 且小于音频总时长，不要填写起点或终点。');
        }
        const sample = Math.round(value * SAMPLE_RATE);
        if (sample <= 0 || sample >= totalSamples) {
            throw new Error('分割点过于接近音频起点或终点，按采样精度对齐后会产生空片段。');
        }
        return sample;
    }).sort((left, right) => left - right);
    for (let index = 1; index < sorted.length; index++) {
        if (sorted[index] === sorted[index - 1]) {
            throw new Error('分割点重复，或按 16 kHz 采样精度对齐后重合，请只保留一个。');
        }
    }
    return sorted;
}

function parsePoint(value, line) {
    const invalid = () => { throw new Error(`第 ${line} 行的分割点「${value}」无效，请使用秒数、分:秒或时:分:秒。`); };
    const fields = value.split(':');
    if (fields.length === 1) {
        if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) invalid();
        const seconds = Number(value);
        if (!Number.isFinite(seconds)) invalid();
        return seconds;
    }
    if (fields.length !== 2 && fields.length !== 3) invalid();
    const secondsText = fields.at(-1);
    if (!/^\d{1,2}(?:\.\d+)?$/.test(secondsText) || Number(secondsText) >= 60) invalid();
    if (fields.length === 2) {
        if (!/^\d+$/.test(fields[0])) invalid();
        const seconds = Number(fields[0]) * 60 + Number(secondsText);
        if (!Number.isFinite(seconds)) invalid();
        return seconds;
    }
    if (!/^\d+$/.test(fields[0]) || !/^\d{1,2}$/.test(fields[1]) || Number(fields[1]) >= 60) invalid();
    const seconds = Number(fields[0]) * 3600 + Number(fields[1]) * 60 + Number(secondsText);
    if (!Number.isFinite(seconds)) invalid();
    return seconds;
}

/** Comma/newline-separated offsets. Returns sorted, sample-aligned seconds, never endpoints. */
export function parseAudioSplitPoints(text, durationSeconds) {
    const totalSamples = durationSamples(durationSeconds);
    if (typeof text !== 'string') throw new Error('请以文本填写手动分割点。');
    const points = [];
    for (const [index, raw] of text.split(/\r\n|\r|\n/).entries()) {
        if (!raw.trim()) continue;
        for (const token of raw.split(/[,，]/)) {
            const value = token.trim();
            if (!value) throw new Error(`第 ${index + 1} 行存在空分割点，请删除多余的逗号。`);
            points.push(parsePoint(value, index + 1));
            if (points.length >= MAX_SEGMENTS) throw new Error('分段数量最多为 500 段，请减少分割点。');
        }
    }
    return boundarySamples(points, durationSeconds, totalSamples).map(sample => sample / SAMPLE_RATE);
}

/**
 * Cover the entire source with adjoining segments. Missing boundaries means automatic splitting;
 * an explicit [] means one manual segment. Millisecond offsets can use 0.0625 ms sample precision.
 */
export function planAudioSegments(durationSeconds, { segmentSeconds = 1200, boundaries } = {}) {
    const totalSamples = durationSamples(durationSeconds);
    let points;
    if (boundaries !== undefined) {
        points = boundarySamples(boundaries, durationSeconds, totalSamples);
    } else {
        if (typeof segmentSeconds !== 'number' || !Number.isFinite(segmentSeconds) || segmentSeconds <= 0 || segmentSeconds > MAX_SEGMENT_SECONDS) {
            throw new Error('自动分段时长必须大于 0 且不超过 30 分钟。');
        }
        const segmentSamples = Math.round(segmentSeconds * SAMPLE_RATE);
        if (segmentSamples < 1) throw new Error('分段时长不足一个 16 kHz 采样点。');
        const count = Math.ceil(totalSamples / segmentSamples);
        if (count > MAX_SEGMENTS) throw new Error('分段数量超过 500 段，请增加每段时长。');
        points = Array.from({ length: count - 1 }, (_, index) => (index + 1) * segmentSamples);
    }
    const edges = [0, ...points, totalSamples];
    return edges.slice(1).map((end, index) => {
        const start = edges[index];
        if (end - start > MAX_SEGMENT_SECONDS * SAMPLE_RATE) {
            throw new Error(`第 ${index + 1} 段超过 30 分钟，请增加分割点。`);
        }
        return { id: `part-${index + 1}`, startMs: start * 1000 / SAMPLE_RATE,
            endMs: end * 1000 / SAMPLE_RATE, duration: (end - start) / SAMPLE_RATE };
    });
}
