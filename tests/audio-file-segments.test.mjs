import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { AudioFileTranslation, exportAudioFileText } from '../src/js/audio-file-translation.js';

const settings = { qwen_api_key: 'test', qwen_workspace_id: 'workspace', qwen_region: 'cn-beijing' };
const options = { targetLanguage: 'zh', glossaryDirection: 'none', parallelism: 1, maxRetries: 0 };
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function fixture({ duration = 2, prepare, connect, finish, disposePart, pcmChunk } = {}) {
    const events = [], clients = [], snapshots = [], preparations = [];
    const prepared = part => ({
        sampleRate: 16000, totalSamples: Math.round(part.duration * 16000),
        async pcmChunk(start, count) {
            events.push(`read:${part.id}:${start}`);
            if (pcmChunk) return await pcmChunk(part, start, count);
            return new Uint8Array(count * 2).fill(1);
        },
        async dispose() {
            events.push(`dispose:${part.id}`);
            if (disposePart) await disposePart(part);
        },
    });
    const source = {
        fileName: 'source.wav', fileSize: 101 * 1024 * 1024, audioUrl: 'blob:source', duration,
        async preparePart(part, { signal }) {
            events.push(`prepare:${part.id}`);
            preparations.push({ ...part });
            return prepare ? await prepare(part, signal, prepared) : prepared(part);
        },
        async dispose() { events.push('dispose:source'); },
    };
    const controller = new AudioFileTranslation({
        openSource: async () => source,
        createClient() {
            const index = clients.length + 1;
            const client = {
                sent: [],
                async connect(cfg) { events.push(`connect:${index}`); this.config = cfg; if (connect) await connect(client, index, clients); },
                async sendAudio(bytes) { this.sent.push(bytes); },
                async finish() {
                    events.push(`finish:${index}`);
                    if (finish) await finish(client, index, clients);
                    else this.onSegment(`source ${index}`, `译文 ${index}`, { itemId: 'target', sourceItemId: 'source', startMs: 10, endMs: 80 });
                    this.onClosed('finished');
                },
                async disconnect() { events.push(`disconnect:${index}`); },
            };
            clients.push(client);
            return client;
        },
        onChange: snapshot => snapshots.push(snapshot), sleep: async () => {}, now: () => 0,
    });
    return { controller, source, prepared, events, clients, snapshots, preparations };
}

test('native large-source selection only plans metadata and does not decode or open a paid session', async () => {
    const f = fixture({ duration: 31 * 60 });
    await f.controller.chooseNative();
    assert.deepEqual(f.events, []);
    assert.equal(f.clients.length, 0);
    assert.equal(f.controller.snapshot.splitReady, true);
    assert.deepEqual(f.controller.snapshot.parts.map(part => [part.startMs, part.endMs]), [[0, 1200000], [1200000, 1860000]]);
    f.controller.split({ mode: 'manual', pointsText: '00:10:00,00:20:00' });
    assert.equal(f.controller.snapshot.parts.length, 3);
    assert.deepEqual(f.events, [], 'changing the plan remains local and metadata-only');
});

test('sequential parts release PCM before preparing the next part and restore global subtitle offsets', async () => {
    const f = fixture();
    await f.controller.chooseNative();
    f.controller.split({ mode: 'auto', segmentSeconds: 1 });
    await f.controller.start(settings, options);
    assert.equal(f.controller.snapshot.state, 'completed');
    assert.equal(f.controller.snapshot.progress, 1);
    assert.equal(f.clients.length, 2);
    assert.ok(f.clients.every(client => client.config.audioOutput === false));
    assert.deepEqual(f.events.filter(event => !event.startsWith('read:')), [
        'prepare:part-1', 'connect:1', 'finish:1', 'disconnect:1', 'dispose:part-1',
        'prepare:part-2', 'connect:2', 'finish:2', 'disconnect:2', 'dispose:part-2',
    ]);
    assert.deepEqual(f.controller.snapshot.segments.map(segment => [segment.id, segment.sourceItemId, segment.startMs, segment.endMs]), [
        ['part-1:target', 'part-1:source', 10, 80], ['part-2:target', 'part-2:source', 1010, 1080],
    ]);
    const sentSamples = f.clients.reduce((sum, client) => sum + client.sent.filter(bytes => bytes[0] === 1).reduce((n, bytes) => n + bytes.byteLength / 2, 0), 0);
    assert.equal(sentSamples, 32000, 'each original sample is sent once; silent finish tails are separate');
    assert.match(exportAudioFileText(f.controller.snapshot.segments, { format: 'srt' }), /00:00:01,010 --> 00:00:01,080/);
});

test('multiple target items group within their own source part while late callbacks cannot corrupt the next part', async () => {
    const f = fixture({
        connect: (_client, index, clients) => {
            if (index === 2) {
                clients[0].onSegment('stale', '过期译文', { itemId: 'target', sourceItemId: 'source', startMs: 0, endMs: 1 });
                clients[0].onError('late_error', 'old connection error');
                clients[0].onClosed('error');
            }
        },
        finish: (client, index) => {
            const meta = { sourceItemId: 'source', startMs: 10, endMs: 100 };
            client.onSegment(`source ${index}`, `first ${index}`, { ...meta, itemId: 'target' });
            client.onSegment(`source ${index}`, `second ${index}`, { ...meta, itemId: 'another' });
            client.onSegment(`source ${index}`, `corrected ${index}`, { ...meta, itemId: 'target' });
        },
    });
    await f.controller.chooseNative(); f.controller.split({ mode: 'auto', segmentSeconds: 1 });
    await f.controller.start(settings, options);
    assert.equal(f.controller.snapshot.state, 'completed');
    assert.deepEqual(f.controller.snapshot.segments.map(segment => segment.text), ['corrected 1\nsecond 1', 'corrected 2\nsecond 2']);
    assert.deepEqual(f.controller.snapshot.segments.map(segment => segment.startMs), [10, 1010]);
});

test('invalid replanning preserves existing text and prevents the previous valid plan from being used', async () => {
    const f = fixture(); await f.controller.chooseNative(); await f.controller.start(settings, options);
    const previous = structuredClone(f.controller.snapshot.segments);
    const oldParts = structuredClone(f.controller.snapshot.parts);
    f.controller.split({ mode: 'manual', pointsText: '0' });
    assert.equal(f.controller.snapshot.splitReady, false);
    assert.ok(f.controller.snapshot.splitError);
    assert.deepEqual(f.controller.snapshot.parts, oldParts);
    assert.deepEqual(f.controller.snapshot.segments, previous);
    await assert.rejects(f.controller.start(settings, options), /分段/);
    assert.equal(f.clients.length, 1);
    f.controller.split({ mode: 'manual', pointsText: '1' });
    assert.equal(f.controller.snapshot.splitReady, true);
    assert.deepEqual(f.controller.snapshot.segments, previous, 'valid plans preserve prior results until a new run starts');
    await f.controller.start(settings, options);
    assert.equal(f.controller.snapshot.segments.length, 2);
    assert.equal(f.clients.length, 3);
});

test('a later preparation failure keeps the plan retryable, preserves translations and opens no extra connection', async () => {
    const f = fixture({ prepare: (part, _signal, prepared) => {
        if (part.id === 'part-2') throw new Error('decoder failed');
        return prepared(part);
    } });
    await f.controller.chooseNative(); f.controller.split({ mode: 'auto', segmentSeconds: 1 });
    await f.controller.start(settings, options);
    assert.equal(f.controller.snapshot.state, 'partial');
    assert.equal(f.controller.snapshot.splitReady, true);
    assert.match(f.controller.snapshot.parts[1].error, /decoder failed/);
    assert.equal(f.controller.snapshot.parts[1].status, 'failed');
    assert.equal(f.controller.snapshot.segments.length, 1);
    assert.equal(f.clients.length, 1);
    assert.ok(f.events.indexOf('dispose:part-1') < f.events.indexOf('prepare:part-2'));
});

test('invalid prepared duration and short asynchronous PCM reads cannot be reported as a complete file', async () => {
    const wrongDuration = fixture({ prepare: (part, _signal, prepared) => ({ ...prepared(part), totalSamples: 1 }) });
    await wrongDuration.controller.chooseNative();
    await wrongDuration.controller.start(settings, options);
    assert.equal(wrongDuration.controller.snapshot.splitReady, true);
    assert.equal(wrongDuration.controller.snapshot.parts[0].status, 'failed');
    assert.equal(wrongDuration.clients.length, 0);
    assert.ok(wrongDuration.events.includes('dispose:part-1'));
    const shortRead = fixture({ pcmChunk: () => new Uint8Array(2) });
    await shortRead.controller.chooseNative();
    await shortRead.controller.start(settings, options);
    assert.equal(shortRead.controller.snapshot.state, 'partial');
    assert.match(shortRead.controller.snapshot.parts[0].error, /读取不完整/);
    assert.equal(shortRead.clients[0].sent.length, 0);
    assert.equal(shortRead.events.some(event => event.startsWith('finish:')), false);
    assert.ok(shortRead.events.includes('dispose:part-1'));
});

test('a failed strict finish marks only that part incomplete and continues subsequent parts', async () => {
    const f = fixture({ duration: 3, finish: (client, index) => {
        client.onSegment(`source ${index}`, `译文 ${index}`, { itemId: 'target', startMs: 10, endMs: 50 });
        if (index === 2) throw new Error('finish not confirmed');
    } });
    await f.controller.chooseNative(); f.controller.split({ mode: 'auto', segmentSeconds: 1 });
    await f.controller.start(settings, options);
    assert.equal(f.controller.snapshot.state, 'partial');
    assert.match(f.controller.snapshot.parts[1].error, /finish not confirmed/);
    assert.equal(f.controller.snapshot.parts[1].status, 'failed');
    assert.equal(f.controller.snapshot.segments.length, 3);
    assert.equal(f.preparations.length, 3);
    assert.equal(f.clients.length, 3);
    assert.ok(f.events.includes('dispose:part-2'));
    assert.equal(f.controller.busy, false);
});

test('cancelling a pending preparation disposes the late PCM without starting any session', async () => {
    const pending = deferred(); let signal;
    const f = fixture({ prepare: (_part, inputSignal) => { signal = inputSignal; return pending.promise; } });
    await f.controller.chooseNative(); f.controller.split({ mode: 'auto', segmentSeconds: 1 });
    const running = f.controller.start(settings, options);
    await tick(); await f.controller.cancel();
    assert.equal(signal.aborted, true);
    pending.resolve(f.prepared(f.controller.snapshot.parts[0]));
    await running;
    assert.equal(f.controller.snapshot.state, 'cancelled');
    assert.equal(f.clients.length, 0);
    assert.equal(f.preparations.length, 1);
    assert.ok(f.events.includes('dispose:part-1'));
});

test('cancelling an asynchronous PCM read prevents its upload and every subsequent part', async () => {
    const pending = deferred(), reading = deferred();
    const f = fixture({ pcmChunk: (_part, _start, count) => { reading.resolve(count); return pending.promise; } });
    await f.controller.chooseNative(); f.controller.split({ mode: 'auto', segmentSeconds: 1 });
    const running = f.controller.start(settings, options);
    const count = await reading.promise;
    await f.controller.cancel();
    pending.resolve(new Uint8Array(count * 2));
    await running;
    assert.equal(f.controller.snapshot.state, 'cancelled');
    assert.equal(f.clients[0].sent.length, 0);
    assert.equal(f.preparations.length, 1);
    assert.ok(f.events.includes('dispose:part-1'));
});

test('cancellation between parts waits for PCM disposal and cannot start the next preparation', async () => {
    const releasing = deferred(), release = deferred();
    const f = fixture({ disposePart: async part => { if (part.id === 'part-1') { releasing.resolve(); await release.promise; } } });
    await f.controller.chooseNative(); f.controller.split({ mode: 'auto', segmentSeconds: 1 });
    const running = f.controller.start(settings, options);
    await releasing.promise; await f.controller.cancel(); release.resolve(); await running;
    assert.equal(f.controller.snapshot.state, 'cancelled');
    assert.equal(f.controller.snapshot.segments.length, 1);
    assert.equal(f.preparations.length, 1);
    assert.equal(f.clients.length, 1);
    assert.equal(f.controller.busy, false);
});

test('cancelled or invalid native replacement preserves the old source and cleans the new handle', async () => {
    const f = fixture(); await f.controller.chooseNative(); await f.controller.start(settings, options);
    const oldResults = structuredClone(f.controller.snapshot.segments);
    const pending = deferred(); let lateDisposed = 0;
    f.controller.openSource = () => pending.promise;
    const choosing = f.controller.chooseNative(); await f.controller.cancel();
    pending.resolve({ ...f.source, fileName: 'late.wav', async dispose() { lateDisposed++; } });
    await choosing;
    assert.equal(lateDisposed, 1);
    assert.equal(f.controller.audio, f.source);
    assert.deepEqual(f.controller.snapshot.segments, oldResults);
    assert.equal(f.events.includes('dispose:source'), false);
    f.controller.openSource = async () => ({ ...f.source, duration: 86401, async dispose() { lateDisposed++; } });
    await f.controller.chooseNative();
    assert.equal(lateDisposed, 2);
    assert.equal(f.controller.audio, f.source);
    assert.deepEqual(f.controller.snapshot.segments, oldResults);
    await f.controller.dispose();
    assert.ok(f.events.includes('dispose:source'));
});

test('manual files are probed locally, naturally ordered, decoded lazily and mapped back to their own players', async () => {
    const f = fixture();
    const probes = [], decodes = [], previewDisposals = [];
    f.controller.probe = async file => {
        probes.push(file.name);
        return { fileName: file.name, duration: .2, audioUrl: `blob:${file.name}`, async dispose() { previewDisposals.push(file.name); } };
    };
    f.controller.decode = async file => {
        decodes.push(file.name);
        return { sampleRate: 16000, totalSamples: 3200, async pcmChunk(_start, count) { return new Uint8Array(count * 2); }, async dispose() {} };
    };
    const files = [{ name: 'clip10.wav', size: 10 }, { name: 'clip2.wav', size: 20 }, { name: 'clip1.wav', size: 30 }];
    await f.controller.chooseFiles(files);
    assert.deepEqual(probes, ['clip1.wav', 'clip2.wav', 'clip10.wav']);
    assert.deepEqual(files.map(file => file.name), ['clip10.wav', 'clip2.wav', 'clip1.wav']);
    assert.deepEqual(decodes, []);
    assert.equal(f.clients.length, 0);
    assert.equal(f.controller.snapshot.manualFiles, true);
    assert.deepEqual(f.controller.snapshot.parts.map(part => [part.startMs, part.endMs]), [[0, 200], [200, 400], [400, 600]]);
    assert.throws(() => f.controller.split({ mode: 'auto' }), /文件边界/);
    await f.controller.start(settings, options);
    assert.deepEqual(decodes, probes);
    assert.deepEqual(f.controller.resolvePlayback({ partId: 'part-3', startMs: 450, endMs: 550 }), {
        audioUrl: 'blob:clip10.wav', startMs: 50, endMs: 150, offsetMs: 400, label: 'clip10.wav',
    });
    assert.deepEqual(previewDisposals, [], 'successful translation retains previews for click-to-play');
    await f.controller.dispose();
    assert.deepEqual(previewDisposals, probes);
});

test('a failed manual metadata probe disposes earlier previews without replacing existing audio', async () => {
    const f = fixture(); await f.controller.chooseNative();
    const disposed = [];
    f.controller.probe = async file => {
        if (file.name === 'part2.wav') throw new Error('bad metadata');
        return { fileName: file.name, duration: .2, audioUrl: `blob:${file.name}`, async dispose() { disposed.push(file.name); } };
    };
    await f.controller.chooseFiles([{ name: 'part1.wav', size: 1 }, { name: 'part2.wav', size: 1 }]);
    assert.deepEqual(disposed, ['part1.wav']);
    assert.equal(f.controller.audio, f.source);
    assert.equal(f.controller.snapshot.splitReady, true);
    assert.match(f.controller.snapshot.message, /bad metadata/);
    assert.equal(f.clients.length, 0);
});
