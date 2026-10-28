const SAMPLE_RATE = 16000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_DURATION = 30 * 60;
const MAX_CHUNK_SAMPLES = SAMPLE_RATE * 5;
const EXTENSIONS = new Set(['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg']);

function aborted() {
    const error = new Error('音频文件读取已取消。');
    error.name = 'AbortError';
    return error;
}
function checkAbort(signal) { if (signal?.aborted) throw aborted(); }
function checkDuration(duration) {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取有效的音频时长，请选择完整的音频文件。');
    if (duration > MAX_DURATION) throw new Error('音频最长支持 30 分钟，请先分段后再导入。');
}

/** Factory keeps browser resources injectable without requiring an audio device in tests. */
export function createAudioFileDecoder({
    createAudioElement = () => document.createElement('audio'),
    createOfflineContext = () => {
        const Context = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
        if (!Context) throw new Error('当前系统不支持本地音频解码，请更新应用或系统后重试。');
        return new Context(1, 1, SAMPLE_RATE);
    },
    urlApi = globalThis.URL,
    setTimer = globalThis.setTimeout.bind(globalThis),
    clearTimer = globalThis.clearTimeout.bind(globalThis),
    metadataTimeoutMs = 15000,
    decodeTimeoutMs = 60000,
} = {}) {
    function wait(promise, signal, timeoutMs, timeoutMessage) {
        return new Promise((resolve, reject) => {
            let finished = false;
            let timer;
            const complete = (callback, value) => {
                if (finished) return;
                finished = true;
                clearTimer(timer);
                signal?.removeEventListener('abort', cancel);
                callback(value);
            };
            const cancel = () => complete(reject, aborted());
            // Attach handlers even when already cancelled: late browser decode
            // failures must never become unhandled rejections or restore a file.
            Promise.resolve(promise).then(value => complete(resolve, value), error => complete(reject, error));
            if (signal?.aborted) return cancel();
            signal?.addEventListener('abort', cancel, { once: true });
            timer = setTimer(() => complete(reject, new Error(timeoutMessage)), timeoutMs);
        });
    }

    async function metadata(audioUrl, signal) {
        const audio = createAudioElement();
        let ready;
        let failed;
        try {
            const promise = new Promise((resolve, reject) => {
                ready = () => resolve(audio.duration);
                failed = () => reject(new Error('当前系统无法读取此音频格式，或文件已损坏。请转为 WAV、MP3 或 M4A 后重试。'));
                audio.addEventListener('loadedmetadata', ready);
                audio.addEventListener('error', failed);
                audio.preload = 'metadata';
                audio.src = audioUrl;
                audio.load();
            });
            const duration = await wait(promise, signal, metadataTimeoutMs, '读取音频信息超时，请检查文件是否完整后重试。');
            checkDuration(duration);
            return duration;
        } finally {
            audio.removeEventListener('loadedmetadata', ready);
            audio.removeEventListener('error', failed);
            audio.removeAttribute('src');
            // Release the metadata reader's reference without playing the file.
            try { audio.load(); } catch { /* The metadata request is already settled. */ }
        }
    }

    async function probe(file, { signal } = {}) {
        checkAbort(signal);
        if (!file || typeof file.arrayBuffer !== 'function' || !Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('请选择非空的本地音频文件。');
        if (file.size > MAX_FILE_BYTES) throw new Error('手动导入的每个片段须小于 100 MiB；大文件请使用「选择本地音频」自动分段。');
        const fileName = String(file.name || '音频文件');
        if (!EXTENSIONS.has(fileName.split('.').at(-1).toLowerCase())) throw new Error('请选择 WAV、MP3、M4A、AAC、FLAC 或 OGG 音频片段。');
        const audioUrl = urlApi.createObjectURL(file);
        let released = false;
        const dispose = () => { if (!released) { released = true; urlApi.revokeObjectURL(audioUrl); } };
        try {
            const duration = await metadata(audioUrl, signal);
            checkAbort(signal);
            return { fileName, fileSize: file.size, duration, audioUrl, dispose };
        } catch (error) { dispose(); throw error; }
    }

    const decodeAudioFile = async function (file, { signal } = {}) {
        checkAbort(signal);
        if (!file || typeof file.arrayBuffer !== 'function' || !Number.isSafeInteger(file.size) || file.size <= 0) {
            throw new Error('请选择非空的本地音频文件。');
        }
        if (file.size > MAX_FILE_BYTES) throw new Error('音频文件不能超过 100 MiB，请先压缩或分段后再导入。');
        const fileName = String(file.name || '音频文件');
        if (!EXTENSIONS.has(fileName.split('.').at(-1).toLowerCase())) {
            throw new Error('支持 WAV、MP3、M4A、AAC、FLAC 和 OGG 音频文件；实际格式兼容性取决于当前系统。');
        }
        let audioUrl;
        let channels;
        let disposed = false;
        const dispose = () => {
            if (disposed) return;
            disposed = true;
            channels = null;
            if (audioUrl) urlApi.revokeObjectURL(audioUrl);
        };
        try {
            audioUrl = urlApi.createObjectURL(file);
            await metadata(audioUrl, signal);
            checkAbort(signal);
            let encoded;
            try {
                encoded = await wait(file.arrayBuffer(), signal, decodeTimeoutMs, '读取音频文件超时，请重新选择文件。');
            } catch (error) {
                if (error?.name === 'AbortError') throw error;
                throw new Error(`无法读取音频文件：${error?.message || '读取失败'}`);
            }
            checkAbort(signal);
            if (!(encoded instanceof ArrayBuffer) || !encoded.byteLength || encoded.byteLength > MAX_FILE_BYTES) {
                throw new Error('音频文件内容为空或超过 100 MiB，请重新选择文件。');
            }
            const context = createOfflineContext();
            let decoded;
            try {
                decoded = await wait(context.decodeAudioData(encoded), signal, decodeTimeoutMs, '音频解码超时，请缩短文件后重试。');
            } catch (error) {
                if (error?.name === 'AbortError' || error?.message?.includes('超时')) throw error;
                throw new Error('当前系统无法解码此音频，或文件已损坏。请转为 WAV、MP3 或 M4A 后重试。');
            } finally {
                // decodeAudioData may detach its input. Never retain the full
                // compressed file alongside the returned decoded channel data.
                encoded = null;
            }
            checkAbort(signal);
            if (decoded?.sampleRate !== SAMPLE_RATE || !Number.isSafeInteger(decoded.length) || decoded.length <= 0) {
                throw new Error('音频解码后的采样率或长度无效，无法准确建立字幕时间轴。');
            }
            if (![1, 2].includes(decoded.numberOfChannels)) throw new Error('仅支持单声道或双声道音频，请先转换声道后重试。');
            checkDuration(decoded.duration);
            if (Math.abs(decoded.duration - decoded.length / SAMPLE_RATE) > 1 / SAMPLE_RATE) {
                throw new Error('音频解码后的时长与样本数不一致，无法准确建立字幕时间轴。');
            }
            const totalSamples = decoded.length;
            const duration = totalSamples / SAMPLE_RATE;
            checkDuration(duration);
            channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
            if (channels.some(channel => channel.length !== totalSamples)) throw new Error('音频声道长度不一致，无法建立可靠的字幕时间轴。');
            decoded = null;
            return {
                fileName, duration, sampleRate: SAMPLE_RATE, totalSamples, audioUrl,
                pcmChunk(startSample, count) {
                    if (disposed) throw new Error('音频文件已释放，请重新选择文件。');
                    if (!Number.isSafeInteger(startSample) || !Number.isSafeInteger(count) || startSample < 0 || startSample > totalSamples || count < 0) {
                        throw new Error('音频分块位置或长度无效。');
                    }
                    if (count > MAX_CHUNK_SAMPLES) throw new Error('单次音频分块不能超过 5 秒。');
                    const length = Math.min(count, totalSamples - startSample);
                    const pcm = new Uint8Array(length * 2);
                    const data = new DataView(pcm.buffer);
                    for (let index = 0; index < length; index++) {
                        let sample = channels[0][startSample + index];
                        if (channels.length === 2) sample = (sample + channels[1][startSample + index]) / 2;
                        sample = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
                        data.setInt16(index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
                    }
                    return pcm;
                },
                dispose,
            };
        } catch (error) {
            dispose();
            throw error;
        }
    };
    decodeAudioFile.probe = probe;
    return decodeAudioFile;
}

export const decodeAudioFile = createAudioFileDecoder();
export const probeAudioFile = decodeAudioFile.probe;
