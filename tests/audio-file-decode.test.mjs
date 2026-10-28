import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioFileDecoder } from '../src/js/audio-file-decode.js';

const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function decoded(channels = [[0, 0.5, -0.5, 1]]) {
    const data = channels.map(channel => Float32Array.from(channel));
    return { sampleRate: 16000, numberOfChannels: data.length, length: data[0].length,
        duration: data[0].length / 16000, getChannelData: index => data[index] };
}
function harness({ duration = 1, metadataEvent = 'loadedmetadata', decode, read } = {}) {
    const observed = { reads: 0, decodes: 0, creates: [], revoked: [], audio: [], contexts: 0 };
    const timers = new Map();
    let timerId = 0;
    class FakeAudio {
        constructor() { this.duration = duration; this.listeners = new Map(); this.src = ''; observed.audio.push(this); }
        addEventListener(type, listener) {
            if (!this.listeners.has(type)) this.listeners.set(type, new Set());
            this.listeners.get(type).add(listener);
        }
        removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
        emit(type) { for (const listener of this.listeners.get(type) || []) listener(); }
        load() { if (this.src && metadataEvent) queueMicrotask(() => this.emit(metadataEvent)); }
        removeAttribute(name) { if (name === 'src') this.src = ''; }
        play() { assert.fail('Decoding must never play audio'); }
    }
    const run = createAudioFileDecoder({
        createAudioElement: () => new FakeAudio(),
        createOfflineContext: () => {
            observed.contexts++;
            return { decodeAudioData(buffer) { observed.decodes++; assert.ok(buffer instanceof ArrayBuffer); return decode ? decode() : Promise.resolve(decoded()); } };
        },
        urlApi: {
            createObjectURL(file) { observed.creates.push(file); return `blob:test/${observed.creates.length}`; },
            revokeObjectURL(url) { observed.revoked.push(url); },
        },
        setTimer(callback) { const id = ++timerId; timers.set(id, callback); return id; },
        clearTimer(id) { timers.delete(id); },
    });
    const file = { name: '会议录音.wav', size: 8, arrayBuffer() { observed.reads++; return read ? read() : Promise.resolve(new ArrayBuffer(8)); } };
    return { run, file, observed, timers, expire() { for (const callback of [...timers.values()]) callback(); } };
}
function samples(pcm) {
    const data = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    return Array.from({ length: pcm.byteLength / 2 }, (_, i) => data.getInt16(i * 2, true));
}
function cleanMetadata(h) {
    assert.equal(h.observed.audio[0].src, '');
    assert.equal([...h.observed.audio[0].listeners.values()].reduce((n, listeners) => n + listeners.size, 0), 0);
    assert.equal(h.timers.size, 0);
}

test('retains the original Blob URL, exposes sample-based duration and converts only requested PCM chunks', async () => {
    const h = harness({ decode: () => Promise.resolve(decoded([[-2, -1, -0.5, 0, 0.5, 1, 2, NaN, Infinity]])) });
    const audio = await h.run(h.file);
    assert.equal(audio.audioUrl, 'blob:test/1');
    assert.equal(audio.fileName, '会议录音.wav');
    assert.equal(audio.sampleRate, 16000);
    assert.equal(audio.totalSamples, 9);
    assert.equal(audio.duration, 9 / 16000);
    assert.deepEqual(samples(audio.pcmChunk(0, 9)), [-32768, -32768, -16384, 0, 16384, 32767, 32767, 0, 0]);
    assert.deepEqual(samples(audio.pcmChunk(2, 3)), [-16384, 0, 16384]);
    assert.equal(audio.pcmChunk(8, 5).length, 2);
    assert.equal(audio.pcmChunk(9, 5).length, 0);
    assert.equal(h.observed.revoked.length, 0);
    cleanMetadata(h);
    audio.dispose(); audio.dispose();
    assert.deepEqual(h.observed.revoked, ['blob:test/1']);
    assert.throws(() => audio.pcmChunk(0, 1), /已释放/);
});

test('stereo is downmixed without shifting the sample origin or copying a whole PCM track', async () => {
    const h = harness({ decode: () => Promise.resolve(decoded([[1, -1, 0.75], [-1, 1, 0.25]])) });
    const audio = await h.run(h.file);
    assert.deepEqual(samples(audio.pcmChunk(0, 3)), [0, 0, 16384]);
    assert.throws(() => audio.pcmChunk(-1, 2), /位置或长度/);
    assert.throws(() => audio.pcmChunk(0.5, 2), /位置或长度/);
    assert.throws(() => audio.pcmChunk(0, 80001), /5 秒/);
    assert.throws(() => audio.pcmChunk(4, 1), /位置或长度/);
    audio.dispose();
});

test('manual piece probing reads only metadata and retains a playable URL without decoding all pieces', async () => {
    const h = harness({duration:1200});
    const source = await h.run.probe(h.file);
    assert.equal(source.duration,1200);
    assert.equal(h.observed.reads,0);
    assert.equal(h.observed.decodes,0);
    assert.equal(h.observed.contexts,0);
    assert.equal(source.audioUrl,'blob:test/1');
    source.dispose(); source.dispose();
    assert.deepEqual(h.observed.revoked,['blob:test/1']);
});

test('invalid extensions, empty and oversized files fail before making a URL or reading bytes', async () => {
    for (const [patch, message] of [[{ name: 'file.exe' }, /支持 WAV/], [{ size: 0 }, /非空/], [{ size: 100 * 1024 * 1024 + 1 }, /100 MiB/]]) {
        const h = harness();
        await assert.rejects(h.run({ ...h.file, ...patch }), message);
        assert.equal(h.observed.creates.length, 0);
        assert.equal(h.observed.reads, 0);
        assert.equal(h.observed.decodes, 0);
    }
});

test('metadata bounds are checked before allocating the file buffer or invoking the decoder', async () => {
    for (const duration of [0, NaN, Infinity, 1800.01]) {
        const h = harness({ duration });
        await assert.rejects(h.run(h.file), /时长|30 分钟/);
        assert.equal(h.observed.reads, 0);
        assert.equal(h.observed.contexts, 0);
        assert.deepEqual(h.observed.revoked, ['blob:test/1']);
        cleanMetadata(h);
    }
});

test('unsupported metadata and decoder failures are friendly and release the original URL', async () => {
    const h = harness({ metadataEvent: 'error' });
    await assert.rejects(h.run(h.file), /当前系统无法读取/);
    assert.equal(h.observed.reads, 0);
    assert.deepEqual(h.observed.revoked, ['blob:test/1']);
    cleanMetadata(h);
    const decodeFailure = harness({ decode: () => Promise.reject(new Error('OS decoder internal error')) });
    await assert.rejects(decodeFailure.run(decodeFailure.file), /当前系统无法解码/);
    assert.deepEqual(decodeFailure.observed.revoked, ['blob:test/1']);
    cleanMetadata(decodeFailure);
});

test('decoded duration, channels, sample rate and frame limits are validated independently of metadata', async () => {
    for (const patch of [
        { numberOfChannels: 3 }, { numberOfChannels: 0 }, { sampleRate: 44100 }, { length: 0 },
        { duration: NaN }, { duration: 0.5 }, { length: 16000 * 1800 + 1, duration: 1800 + 1 / 16000 },
    ]) {
        const h = harness({ decode: () => Promise.resolve({ ...decoded(), ...patch }) });
        await assert.rejects(h.run(h.file), /声道|采样率|时长|30 分钟/);
        assert.deepEqual(h.observed.revoked, ['blob:test/1']);
    }
});

test('already cancelled selection never creates resources', async () => {
    const h = harness();
    const controller = new AbortController(); controller.abort();
    await assert.rejects(h.run(h.file, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(h.observed.creates.length, 0);
    assert.equal(h.observed.reads, 0);
});

test('cancellation during metadata removes listeners and revokes URL once', async () => {
    const h = harness({ metadataEvent: null });
    const controller = new AbortController();
    const pending = h.run(h.file, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    h.observed.audio[0].emit('loadedmetadata');
    await tick();
    assert.equal(h.observed.reads, 0);
    assert.deepEqual(h.observed.revoked, ['blob:test/1']);
    cleanMetadata(h);
});

test('cancellation during arrayBuffer ignores late bytes and never starts decoding', async () => {
    const bytes = deferred();
    const h = harness({ read: () => bytes.promise });
    const controller = new AbortController();
    const pending = h.run(h.file, { signal: controller.signal });
    await tick();
    assert.equal(h.observed.reads, 1);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    bytes.resolve(new ArrayBuffer(8));
    await tick();
    assert.equal(h.observed.decodes, 0);
    assert.deepEqual(h.observed.revoked, ['blob:test/1']);
    cleanMetadata(h);
});

test('cancellation during unabortable browser decode ignores both late success and late failure', async () => {
    for (const failure of [false, true]) {
        const decode = deferred();
        const h = harness({ decode: () => decode.promise });
        const controller = new AbortController();
        const pending = h.run(h.file, { signal: controller.signal });
        await tick();
        assert.equal(h.observed.decodes, 1);
        controller.abort();
        await assert.rejects(pending, { name: 'AbortError' });
        if (failure) decode.reject(new Error('late browser failure')); else decode.resolve(decoded());
        await tick();
        assert.deepEqual(h.observed.revoked, ['blob:test/1']);
        cleanMetadata(h);
    }
});

test('metadata and decode timeouts clean up resources even if callbacks arrive later', async () => {
    const metadata = harness({ metadataEvent: null });
    const metadataPromise = metadata.run(metadata.file);
    metadata.expire();
    await assert.rejects(metadataPromise, /信息超时/);
    metadata.observed.audio[0].emit('loadedmetadata');
    cleanMetadata(metadata);
    const late = deferred();
    const h = harness({ decode: () => late.promise });
    const pending = h.run(h.file);
    await tick();
    h.expire();
    await assert.rejects(pending, /解码超时/);
    late.resolve(decoded());
    await tick();
    assert.deepEqual(h.observed.revoked, ['blob:test/1']);
    cleanMetadata(h);
});

test('file read failures and empty decoded input release the URL', async () => {
    for (const read of [() => Promise.reject(new Error('permission denied')), () => Promise.resolve(new ArrayBuffer(0))]) {
        const h = harness({ read });
        await assert.rejects(h.run(h.file), /读取音频文件|内容为空/);
        assert.equal(h.observed.decodes, 0);
        assert.deepEqual(h.observed.revoked, ['blob:test/1']);
        cleanMetadata(h);
    }
});
