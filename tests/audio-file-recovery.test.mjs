import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { AudioFileTranslation, exportAudioFileText } from '../src/js/audio-file-translation.js';

const settings = { qwen_api_key: 'test-key', qwen_workspace_id: 'workspace', qwen_region: 'cn-beijing' };
const options = { targetLanguage: 'zh', glossaryDirection: 'none', parallelism: 1, maxRetries: 0 };
const test = (name, run) => nodeTest(name, { timeout: 5000 }, run);
const aborted = () => new DOMException('cancelled', 'AbortError');
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
async function until(predicate, label = 'condition') {
    for (let n = 0; n < 500; n++) {
        if (predicate()) return;
        await tick();
    }
    assert.fail(`did not reach ${label}`);
}
async function tolerateRefusal(callback) {
    try { await callback(); } catch { /* Inapplicable actions may reject or be ignored. */ }
}

function fixture({ duration = 1, prepare, connect, send, finish, sleep, onChange } = {}) {
    const clients = [], preparations = [], snapshots = [], delays = [], delayEvents = [], connectionStarts = [], events = [];
    const resources = { preparing: 0, maxPreparing: 0, pcm: 0, maxPcm: 0, connections: 0, maxConnections: 0 };
    let clock = 0, controller;
    const source = {
        fileName: 'recording.wav', duration, fileSize: 1024, audioUrl: 'blob:recording',
        async preparePart(part, { signal }) {
            preparations.push({ ...part });
            events.push(`prepare:${part.id}`);
            resources.preparing++;
            resources.maxPreparing = Math.max(resources.maxPreparing, resources.preparing);
            let prepared;
            try {
                await tick();
                if (prepare) await prepare(part, signal);
                resources.pcm++;
                resources.maxPcm = Math.max(resources.maxPcm, resources.pcm);
                let disposed = false;
                prepared = {
                    sampleRate: 16000, totalSamples: Math.round(part.duration * 16000),
                    async pcmChunk(_start, count) { return new Uint8Array(count * 2).fill(1); },
                    async dispose() {
                        if (disposed) return;
                        disposed = true;
                        resources.pcm--;
                        events.push(`dispose:${part.id}`);
                    },
                };
                return prepared;
            } finally { resources.preparing--; }
        },
        async dispose() { events.push('source:dispose'); },
    };
    controller = new AudioFileTranslation({
        openSource: async () => source,
        createClient() {
            const index = clients.length + 1;
            let connected = false;
            const client = {
                index, sentSamples: 0, closed: false,
                async connect(config) {
                    this.config = config;
                    connectionStarts.push(clock);
                    events.push(`connect:${index}`);
                    if (connect) await connect(client, index);
                    connected = true;
                    resources.connections++;
                    resources.maxConnections = Math.max(resources.maxConnections, resources.connections);
                },
                async sendAudio(bytes) {
                    if (bytes[0]) this.sentSamples += bytes.byteLength / 2;
                    if (send) await send(client, bytes);
                },
                emit(text = `translated ${index}`, itemId = 'target') {
                    this.onSegment(`source ${index}`, text, { itemId, sourceItemId: 'source', startMs: 10, endMs: 80 });
                },
                async finish() {
                    events.push(`finish:${index}`);
                    if (finish) await finish(client, index);
                    else client.emit();
                    this.onClosed('finished');
                },
                async disconnect() {
                    if (connected) { connected = false; resources.connections--; }
                    this.closed = true;
                    events.push(`disconnect:${index}`);
                },
            };
            clients.push(client);
            return client;
        },
        now: () => clock,
        async sleep(ms, signal) {
            delays.push(ms);
            delayEvents.push({ ms, statuses: controller.snapshot.parts.map(part => part.status) });
            if (signal.aborted) throw aborted();
            if (sleep) await sleep(ms, signal);
            await tick();
            clock += Math.max(0, ms);
            if (signal.aborted) throw aborted();
        },
        onChange(snapshot) {
            snapshots.push(structuredClone(snapshot));
            onChange?.(snapshot, controller);
        },
    });
    return { controller, source, clients, preparations, snapshots, delays, delayEvents, connectionStarts, events, resources };
}

test('parallel translation bounds native preparation, PCM caches and paid sessions while retaining source offsets', async () => {
    const gate = deferred();
    const f = fixture({ duration: 3, finish: async (client, index) => {
        if (index <= 2) await gate.promise;
        client.emit();
    } });
    await f.controller.chooseNative();
    f.controller.split({ mode: 'auto', segmentSeconds: 1 });
    const running = f.controller.start(settings, { ...options, parallelism: 2 });
    await until(() => f.resources.connections === 2, 'two concurrent sessions');
    assert.equal(f.preparations.length, 2, 'a third PCM cache must not be prepared while two parts are active');
    assert.equal(f.resources.maxPreparing, 1, 'native preparation commands must be serialized');
    assert.equal(f.resources.maxPcm, 2);
    gate.resolve();
    await running;
    assert.equal(f.controller.snapshot.state, 'completed');
    assert.equal(f.resources.maxConnections, 2);
    assert.equal(f.resources.pcm, 0);
    assert.equal(f.resources.connections, 0);
    assert.deepEqual(f.controller.snapshot.segments.map(segment => segment.startMs), [10, 1010, 2010]);
    assert.equal(f.clients.reduce((sum, client) => sum + client.sentSamples, 0), 3 * 16000);
});

test('accelerated mode subdivides a single long plan without introducing gaps or losing the source timeline', async () => {
    const f = fixture({ duration: 65 });
    await f.controller.chooseNative();
    assert.equal(f.controller.snapshot.parts.length, 1);
    await f.controller.start(settings, { ...options, parallelism: 2 });
    const parts = f.controller.snapshot.parts;
    assert.equal(parts.length, 2);
    assert.equal(parts[0].startMs, 0);
    assert.equal(parts[0].endMs, parts[1].startMs);
    assert.equal(parts.at(-1).endMs, 65000);
    assert.ok(parts.every(part => part.duration <= 120 && part.status === 'completed'));
    assert.equal(f.clients.reduce((sum, client) => sum + client.sentSamples, 0), 65 * 16000);
});

test('transient failures retry only the failed part with bounded backoff and replace its previous partial captions', async () => {
    const f = fixture({ finish: (client, index) => {
        client.emit(index < 3 ? `partial attempt ${index}` : 'recovered translation');
        if (index < 3) throw new Error('network connection reset');
    } });
    await f.controller.chooseNative();
    await f.controller.start(settings, { ...options, maxRetries: 2 });
    assert.equal(f.clients.length, 3);
    assert.deepEqual(f.delayEvents.filter(event => event.statuses.includes('retry_wait')).map(event => event.ms), [2000, 5000],
        'retry backoff must remain 2s then 5s, independently of connection-rate waits');
    assert.equal(f.controller.snapshot.parts[0].attempt, 3);
    assert.equal(f.controller.snapshot.state, 'completed');
    assert.deepEqual(f.controller.snapshot.segments.map(segment => segment.text), ['recovered translation']);
    const saved = structuredClone(f.controller.snapshot.segments);
    f.clients[0].emit('late stale first attempt');
    f.clients[1].onError('network_error', 'late stale error');
    f.clients[0].onClosed('error');
    assert.deepEqual(f.controller.snapshot.segments, saved);
    assert.equal(f.controller.snapshot.state, 'completed');
    assert.equal(f.resources.pcm, 0);
    assert.equal(f.resources.connections, 0);
});

test('exhausted retries preserve partial text and allow other parts to complete', async () => {
    const f = fixture({ duration: 2, finish: (client, index) => {
        client.emit(index <= 3 ? 'first part partial' : 'second part complete');
        if (index <= 3) throw new Error('network timeout');
    } });
    await f.controller.chooseNative();
    f.controller.split({ mode: 'auto', segmentSeconds: 1 });
    await f.controller.start(settings, { ...options, maxRetries: 2 });
    assert.equal(f.clients.length, 4);
    assert.deepEqual(f.controller.snapshot.parts.map(part => part.status), ['failed', 'completed']);
    assert.equal(f.controller.snapshot.state, 'partial');
    assert.deepEqual(f.controller.snapshot.segments.map(segment => segment.text), ['first part partial', 'second part complete']);
    assert.equal(f.controller.busy, false);
});

test('authentication, invalid parameters and quota errors are not automatically retried', async () => {
    for (const message of ['401 Unauthorized: invalid API key', '400 invalid parameter', 'insufficient quota']) {
        const f = fixture({ connect: () => { throw new Error(message); } });
        await f.controller.chooseNative();
        await f.controller.start(settings, { ...options, maxRetries: 2 });
        assert.equal(f.clients.length, 1, message);
        assert.equal(f.controller.snapshot.parts[0].status, 'failed', message);
        assert.deepEqual(f.delays.filter(ms => ms >= 1000), [], message);
    }
});

test('a local decoding failure opens no paid request and is not automatically retried', async () => {
    const f = fixture({ prepare: () => { throw new Error('音频分段解码失败'); } });
    await f.controller.chooseNative();
    await f.controller.start(settings, { ...options, maxRetries: 2 });
    assert.equal(f.preparations.length, 1);
    assert.equal(f.clients.length, 0);
    assert.equal(f.controller.snapshot.parts[0].status, 'failed');
    assert.equal(f.resources.pcm, 0);
});

test('a permanent authentication failure prevents queued parts from opening more paid sessions', async () => {
    const f = fixture({ duration: 3, connect: () => { throw new Error('401 Unauthorized: invalid API key test-key'); } });
    await f.controller.chooseNative();
    f.controller.split({ mode: 'auto', segmentSeconds: 1 });
    await f.controller.start(settings, { ...options, maxRetries: 2 });
    assert.equal(f.clients.length, 1);
    assert.equal(f.controller.snapshot.state, 'partial');
    assert.equal(f.controller.snapshot.segments.length, 0);
    assert.doesNotMatch(JSON.stringify(f.controller.snapshot), /test-key/, 'provider errors displayed in the UI must redact the configured API key');
    assert.equal(f.resources.pcm, 0);
    assert.equal(f.resources.connections, 0);
});

test('skip applies only to a failed request, makes no new request and preserves the time gap in exported captions', async () => {
    const f = fixture({ duration: 3, connect: (_client, index) => {
        if (index === 2) throw new Error('network timeout');
    } });
    await f.controller.chooseNative();
    f.controller.split({ mode: 'auto', segmentSeconds: 1 });
    await f.controller.start(settings, options);
    const failed = f.controller.snapshot.parts.find(part => part.status === 'failed');
    assert.ok(failed);
    const calls = f.clients.length;
    await f.controller.skipPart(failed.id);
    assert.equal(f.clients.length, calls);
    assert.equal(f.controller.snapshot.parts.find(part => part.id === failed.id).status, 'skipped');
    assert.equal(f.controller.snapshot.state, 'partial');
    assert.deepEqual(f.controller.snapshot.segments.map(segment => segment.startMs), [10, 2010]);
    const srt = exportAudioFileText(f.controller.snapshot.segments, { format: 'srt' });
    assert.match(srt, /00:00:02,010 --> 00:00:02,080/);
    assert.doesNotMatch(srt, /00:00:01,/);
    await f.controller.retryFailed();
    assert.equal(f.clients.length, calls, 'bulk retry must not undo the user decision to skip a failed request');
});

test('an active request cannot be skipped; skipping a failed request does not interrupt another active one', async () => {
    const gate = deferred();
    const f = fixture({ duration: 2, connect: (_client, index) => {
        if (index === 1) throw new Error('network timeout');
    }, finish: async client => { await gate.promise; client.emit('still running part completed'); } });
    await f.controller.chooseNative();
    f.controller.split({ mode: 'auto', segmentSeconds: 1 });
    const running = f.controller.start(settings, { ...options, parallelism: 2 });
    await until(() => f.controller.snapshot.parts.some(part => part.status === 'failed') && f.resources.connections === 1, 'one failed and one active request');
    const failed = f.controller.snapshot.parts.find(part => part.status === 'failed');
    const active = f.controller.snapshot.parts.find(part => !['failed', 'completed', 'skipped', 'cancelled', 'pending'].includes(part.status));
    assert.ok(active);
    await tolerateRefusal(() => f.controller.skipPart(active.id));
    assert.notEqual(f.controller.snapshot.parts.find(part => part.id === active.id).status, 'skipped');
    await f.controller.skipPart(failed.id);
    assert.equal(f.clients.length, 2);
    assert.equal(f.resources.connections, 1);
    gate.resolve();
    await running;
    assert.deepEqual(f.controller.snapshot.parts.map(part => part.status).sort(), ['completed', 'skipped']);
    assert.deepEqual(f.controller.snapshot.segments.map(segment => segment.text), ['still running part completed']);
});

test('manual retry replaces only the failed part and preserves completed translations and the original options', async () => {
    const f = fixture({ duration: 2, finish: (client, index) => {
        client.emit(index === 3 ? 'retry succeeded' : `saved ${index}`);
        if (index === 1) throw new Error('network timeout');
    } });
    await f.controller.chooseNative();
    f.controller.split({ mode: 'auto', segmentSeconds: 1 });
    await f.controller.start(settings, options);
    const failed = f.controller.snapshot.parts.find(part => part.status === 'failed');
    const completed = f.controller.snapshot.segments.find(segment => segment.text === 'saved 2');
    await f.controller.retryPart(failed.id);
    await until(() => !f.controller.busy, 'manual retry completion');
    assert.equal(f.clients.length, 3);
    assert.equal(f.controller.snapshot.state, 'completed');
    assert.deepEqual(f.controller.snapshot.segments.find(segment => segment.text === 'saved 2'), completed);
    assert.deepEqual(f.controller.snapshot.segments.map(segment => segment.text), ['retry succeeded', 'saved 2']);
    assert.deepEqual(f.clients[2].config, f.clients[0].config);
});

test('a busy manual retry is queued once and cannot exceed the configured concurrency', async () => {
    const gate = deferred();
    const f = fixture({ duration: 2, connect: (_client, index) => {
        if (index === 1) throw new Error('network timeout');
    }, finish: async (client, index) => { if (index === 2) await gate.promise; client.emit(); } });
    await f.controller.chooseNative();
    f.controller.split({ mode: 'auto', segmentSeconds: 1 });
    const running = f.controller.start(settings, { ...options, parallelism: 2 });
    await until(() => f.controller.snapshot.parts.some(part => part.status === 'failed') && f.resources.connections === 1, 'failed part while another is active');
    const failed = f.controller.snapshot.parts.find(part => part.status === 'failed');
    await f.controller.retryPart(failed.id);
    await tolerateRefusal(() => f.controller.retryPart(failed.id));
    gate.resolve();
    await running;
    assert.equal(f.clients.length, 3, 'double clicking must not schedule duplicate paid attempts');
    assert.equal(f.controller.snapshot.state, 'completed');
    assert.ok(f.resources.maxConnections <= 2);
    assert.ok(f.resources.maxPcm <= 2);
});

test('provisional translations are visible early but never become exported or retained final captions', async () => {
    const gate = deferred(), seen = deferred();
    const f = fixture({ finish: async client => {
        client.onProvisional('unfinished draft', { itemId: 'target', sourceItemId: 'source', sourceText: 'source in progress', startMs: 10 });
        seen.resolve();
        await gate.promise;
        client.emit('confirmed translation');
    } });
    await f.controller.chooseNative();
    const running = f.controller.start(settings, options);
    await seen.promise;
    assert.equal(f.controller.snapshot.segments.length, 0);
    assert.ok(f.controller.snapshot.provisionals.some(segment => segment.text === 'unfinished draft'));
    assert.throws(() => exportAudioFileText(f.controller.snapshot.segments, { format: 'txt' }), /暂无/);
    gate.resolve();
    await running;
    assert.equal(f.controller.snapshot.provisionals.length, 0);
    assert.equal(exportAudioFileText(f.controller.snapshot.segments, { format: 'txt' }).trim(), 'confirmed translation');
});

test('cancelling automatic-retry backoff prevents another paid attempt and releases all resources', async () => {
    const waiting = deferred();
    const f = fixture({ connect: () => { throw new Error('network timeout'); }, sleep: async (ms, signal) => {
        if (ms < 1000) return;
        waiting.resolve();
        await new Promise((resolve, reject) => {
            if (signal.aborted) reject(aborted());
            else signal.addEventListener('abort', () => reject(aborted()), { once: true });
        });
    } });
    await f.controller.chooseNative();
    const running = f.controller.start(settings, { ...options, maxRetries: 2 });
    await waiting.promise;
    await f.controller.cancel();
    await running;
    assert.equal(f.clients.length, 1);
    assert.equal(f.controller.snapshot.state, 'cancelled');
    assert.equal(f.controller.busy, false);
    assert.equal(f.resources.pcm, 0);
    assert.equal(f.resources.connections, 0);
});

test('retrying after cancellation processes only unfinished parts and preserves completed subtitles', async () => {
    const gate = deferred(), waiting = deferred();
    const f = fixture({ duration: 3, finish: async (client, index) => {
        if (index === 2) { waiting.resolve(); await gate.promise; }
        client.emit();
    } });
    await f.controller.chooseNative();
    f.controller.split({ mode: 'auto', segmentSeconds: 1 });
    const running = f.controller.start(settings, options);
    await waiting.promise;
    const completed = structuredClone(f.controller.snapshot.segments);
    assert.equal(completed.length, 1);
    await f.controller.cancel();
    gate.resolve();
    await running;
    assert.equal(f.clients.length, 2);
    assert.deepEqual(f.controller.snapshot.parts.map(part => part.status), ['completed', 'cancelled', 'cancelled']);
    assert.deepEqual(f.controller.snapshot.segments, completed);
    await f.controller.retryFailed();
    assert.equal(f.clients.length, 4, 'the previously completed first part must not be billed again');
    assert.equal(f.controller.snapshot.state, 'completed');
    assert.deepEqual(f.controller.snapshot.segments[0], completed[0]);
    assert.deepEqual(f.controller.snapshot.segments.map(segment => segment.startMs), [10, 1010, 2010]);
});

test('disposing the source during preparation still cleans up late PCM without reopening a request or losing the run outcome', async () => {
    const entered = deferred(), late = deferred();
    const f = fixture({ duration: 3, prepare: async () => { entered.resolve(); await late.promise; } });
    await f.controller.chooseNative();
    f.controller.split({ mode: 'auto', segmentSeconds: 1 });
    const running = f.controller.start(settings, { ...options, parallelism: 2 });
    await entered.promise;
    await f.controller.dispose();
    assert.equal(f.controller.audio, null);
    late.resolve();
    await running;
    assert.equal(f.controller.snapshot.state, 'cancelled');
    assert.ok(Number.isFinite(f.controller.snapshot.progress));
    assert.equal(f.clients.length, 0);
    assert.equal(f.preparations.length, 1, 'the second queued native preparation must observe cancellation');
    assert.equal(f.resources.pcm, 0);
    assert.equal(f.resources.preparing, 0);
    assert.equal(f.events.filter(event => event === 'source:dispose').length, 1);
    assert.equal(f.events.filter(event => event.startsWith('dispose:')).length, 1);
    assert.equal(f.controller.busy, false);
});

test('a shorter failed retry cannot erase the earlier useful partials; a successful retry replaces them atomically', async () => {
    const gate = deferred(), staged = deferred();
    const f = fixture({ finish: async (client, index) => {
        if (index === 1) {
            client.emit('saved A', 'a');
            client.emit('saved B', 'b');
            throw new Error('network timeout');
        }
        if (index === 2) {
            client.emit('shorter new A', 'a');
            throw new Error('network timeout');
        }
        client.emit('successful replacement', 'new');
        staged.resolve();
        await gate.promise;
    } });
    await f.controller.chooseNative();
    await f.controller.start(settings, options);
    const partId = f.controller.snapshot.parts[0].id;
    const original = structuredClone(f.controller.snapshot.segments);
    assert.match(exportAudioFileText(original, { format: 'txt' }), /saved A\nsaved B/);
    await f.controller.retryPart(partId);
    assert.equal(f.controller.snapshot.parts[0].status, 'failed');
    assert.deepEqual(f.controller.snapshot.segments, original);
    assert.doesNotMatch(exportAudioFileText(f.controller.snapshot.segments, { format: 'txt' }), /shorter/);
    const retrying = f.controller.retryPart(partId);
    await staged.promise;
    assert.deepEqual(f.controller.snapshot.segments, original, 'even the new final text cannot replace old partials until session.finish is confirmed');
    gate.resolve();
    await retrying;
    assert.equal(f.controller.snapshot.state, 'completed');
    assert.equal(exportAudioFileText(f.controller.snapshot.segments, { format: 'txt' }).trim(), 'successful replacement');
});

test('protocol and payload close codes are not automatically retried merely because the error mentions a connection', async () => {
    for (const code of [1002, 1003, 1007, 1008, 1009]) {
        const f = fixture({ connect: () => { throw new Error(`WebSocket connection closed: ${code}`); } });
        await f.controller.chooseNative();
        await f.controller.start(settings, { ...options, maxRetries: 2 });
        assert.equal(f.clients.length, 1, `close code ${code}`);
        assert.equal(f.controller.snapshot.parts[0].status, 'failed');
        assert.deepEqual(f.delayEvents.filter(event => event.statuses.includes('retry_wait')), []);
    }
});

test('a close code that explicitly identifies throttling is retried with backoff', async () => {
    const f = fixture({ connect: (_client, index) => {
        if (index === 1) throw new Error('WebSocket connection closed: 1008 Throttling: rate limit exceeded');
    } });
    await f.controller.chooseNative();
    await f.controller.start(settings, { ...options, maxRetries: 1 });
    assert.equal(f.clients.length, 2);
    assert.equal(f.controller.snapshot.state, 'completed');
    assert.deepEqual(f.delayEvents.filter(event => event.statuses.includes('retry_wait')).map(event => event.ms), [2000]);
});

test('connection starts share a minimum interval and rolling budget across many short parts', async () => {
    const f = fixture({ duration: 12 });
    await f.controller.chooseNative();
    f.controller.split({ mode: 'auto', segmentSeconds: 1 });
    await f.controller.start(settings, { ...options, parallelism: 2 });
    assert.equal(f.clients.length, 12);
    assert.equal(f.controller.snapshot.state, 'completed');
    const starts = f.connectionStarts;
    for (let index = 1; index < starts.length; index++) {
        assert.ok(starts[index] - starts[index - 1] >= 7500, `connection ${index + 1} started too soon: ${starts}`);
    }
    for (const end of starts) {
        assert.ok(starts.filter(time => time > end - 60000 && time <= end).length <= 8,
            `more than eight requests in a rolling minute ending at ${end}: ${starts}`);
    }
    assert.ok(f.resources.maxConnections <= 2);
    assert.equal(f.resources.pcm, 0);
});
