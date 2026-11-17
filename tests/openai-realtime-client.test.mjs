import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { OpenAiRealtimeClient } from '../src/js/openai-realtime-client.js';

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function fixture(options = {}) {
    let now = 0, nextTimer = 0;
    const timers = new Map();
    const starts = [], stops = [], sends = [], statuses = [], warnings = [], errors = [], closes = [], segments = [];
    let sendImpl = async () => {};
    let stopImpl = async () => {};
    const client = new OpenAiRealtimeClient({
        Channel: class {},
        invoke(command, args) {
            if (command === 'openai_realtime_start') {
                const start = { ...deferred(), channel: args.onEvent, config: args.config };
                starts.push(start);
                return start.promise;
            }
            if (command === 'openai_realtime_stop') { stops.push(args.sessionId); return stopImpl(args); }
            if (command === 'openai_realtime_send_audio') { sends.push(args); return sendImpl(args); }
            throw new Error(command);
        },
        setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        ...options,
    });
    client.onStatusChange = state => statuses.push(state);
    client.onWarning = message => warnings.push(message);
    client.onError = (code, message) => errors.push({ code, message });
    client.onClosed = reason => closes.push(reason);
    client.onSegment = (source, target) => segments.push([source, target]);
    const output = { flushed: 0, audio: [], flush() { this.flushed++; }, push(chunk) { this.audio.push(chunk); } };
    const cfg = { apiKey: 'test-key', sourceLanguage: 'en', targetLanguage: 'zh', audioOutput: false };
    const begin = () => client.connect(cfg, output);
    const event = (index, event) => starts[index].channel.onmessage(event);
    async function ready(index = starts.length - 1, id = index + 1) {
        event(index, { type: 'status', state: 'ready' });
        starts[index].resolve(id);
        await nextTurn();
    }
    async function tick(ms) {
        now += ms;
        for (const [id, timer] of [...timers]) {
            if (timer.at <= now && timers.has(id)) { timers.delete(id); timer.fn(); }
        }
        await nextTurn();
    }
    return { client, starts, stops, sends, statuses, warnings, errors, closes, segments, timers, output,
        begin, event, ready, tick, setSend: fn => { sendImpl = fn; }, setStop: fn => { stopImpl = fn; } };
}

test('connect waits for native ready as well as the returned session ID', async () => {
    const f = fixture();
    let resolved = false;
    const connecting = f.begin().then(() => { resolved = true; });
    await nextTurn();
    f.starts[0].resolve(11);
    await nextTurn();
    assert.equal(resolved, false);
    assert.equal(f.client.isConnected, false);
    await f.client.sendAudio(new Uint8Array([1, 2]).buffer);
    assert.equal(f.sends.length, 0);
    f.event(0, { type: 'status', state: 'ready' });
    await connecting;
    assert.equal(f.client.sessionId, 11);
    assert.equal(f.client.isConnected, true);
    assert.deepEqual(f.statuses, ['connecting', 'ready']);
    await f.client.disconnect();
});

test('ready before the session ID cannot send to an unknown native session', async () => {
    const f = fixture();
    const connecting = f.begin();
    await nextTurn();
    f.event(0, { type: 'status', state: 'ready' });
    assert.equal(f.client.isConnected, false);
    await f.ready(); await connecting;
    await f.client.sendAudio(new Uint8Array([1, 2]).buffer);
    assert.equal(f.sends[0].sessionId, 1);
    await f.client.disconnect();
});

test('close before start IPC returns cannot resurrect the failed session', async () => {
    const f = fixture();
    const connecting = f.begin();
    await nextTurn();
    f.event(0, { type: 'closed', reason: 'remote_close' });
    f.starts[0].resolve(7);
    await nextTurn();
    assert.equal(f.client.isConnected, false);
    assert.ok(f.stops.includes(7));
    assert.equal(f.warnings.length, 1);
    await f.tick(1000);
    await f.ready(1, 8); await connecting;
    assert.equal(f.client.sessionId, 8);
    assert.equal(f.closes.length, 0);
    await f.client.disconnect();
});

test('Stop during startup rejects the pending start and cleans up its late native ID', async () => {
    const f = fixture();
    const connecting = f.begin();
    const rejected = assert.rejects(connecting, /取消/);
    await nextTurn();
    await f.client.disconnect();
    await rejected;
    f.starts[0].resolve(3);
    f.event(0, { type: 'status', state: 'ready' });
    await nextTurn();
    assert.deepEqual(f.stops, [3]);
    assert.equal(f.client.isConnected, false);
    assert.equal(f.errors.length, 0);
    assert.equal(f.closes.length, 0);
    assert.equal(f.timers.size, 0);
});

test('Stop cancels a scheduled retry and stale callbacks cannot affect the next run', async () => {
    const f = fixture();
    const first = f.begin(); await nextTurn(); await f.ready(); await first;
    f.event(0, { type: 'closed', reason: 'network lost' });
    await f.client.disconnect();
    await f.tick(60000);
    assert.equal(f.starts.length, 1);
    const second = f.begin(); await nextTurn(); await f.ready(1); await second;
    f.event(0, { type: 'closed', reason: 'old close' });
    f.event(0, { type: 'error', code: 'invalid_api_key', message: 'old error' });
    f.event(0, { type: 'transcript', is_final: true, text: 'old transcript' });
    assert.equal(f.client.isConnected, true);
    assert.equal(f.errors.length, 0);
    assert.deepEqual(f.segments, []);
    await f.client.disconnect();
});

test('duplicate native terminal events create one retry', async () => {
    const f = fixture();
    const starting = f.begin(); await nextTurn(); await f.ready(); await starting;
    f.event(0, { type: 'closed', reason: '1000: session expired' });
    f.event(0, { type: 'closed', reason: 'session_ended' });
    f.event(0, { type: 'error', code: 'session_failed', message: 'socket error' });
    assert.equal(f.warnings.length, 1);
    assert.equal(f.errors.length, 0);
    await f.tick(1000);
    assert.equal(f.starts.length, 2);
    await f.ready(1);
    await f.client.disconnect();
});

test('permanent authentication errors stop immediately without auto-retry', async () => {
    const f = fixture();
    const connecting = f.begin();
    const rejected = assert.rejects(connecting, /Invalid API key/);
    await nextTurn();
    f.starts[0].resolve(1);
    f.event(0, { type: 'error', code: 'invalid_api_key', message: 'Invalid API key' });
    await rejected;
    await f.tick(60000);
    assert.equal(f.starts.length, 1);
    assert.equal(f.errors.length, 1);
    assert.equal(f.closes.length, 1);
    assert.equal(f.client.isConnected, false);
    assert.equal(f.timers.size, 0);
});

test('repeated ready/close loops exhaust the retry budget and stop truthfully', async () => {
    const f = fixture({ maxReconnects: 2 });
    const connecting = f.begin(); await nextTurn(); await f.ready(); await connecting;
    for (let index = 0; index < 3; index++) {
        f.event(index, { type: 'closed', reason: 'network lost' });
        if (index < 2) { await f.tick((index + 1) * 1000); await f.ready(index + 1); }
    }
    await f.tick(60000);
    assert.equal(f.starts.length, 3);
    assert.equal(f.warnings.length, 2);
    assert.equal(f.errors.length, 1);
    assert.equal(f.closes.length, 1);
    assert.equal(f.client.isConnected, false);
    assert.equal(f.timers.size, 0);
});

test('a stable connection restores the retry budget for a later interruption', async () => {
    const f = fixture({ maxReconnects: 1 });
    const connecting = f.begin(); await nextTurn(); await f.ready(); await connecting;
    f.event(0, { type: 'closed', reason: 'network lost' });
    await f.tick(1000); await f.ready(1);
    await f.tick(30000);
    f.event(1, { type: 'closed', reason: 'network lost later' });
    await f.tick(1000); await f.ready(2);
    assert.equal(f.errors.length, 0);
    assert.equal(f.starts.length, 3);
    await f.client.disconnect();
});

test('failed audio IPC triggers recovery instead of leaving capture silently discarded', async () => {
    const f = fixture();
    const connecting = f.begin(); await nextTurn(); await f.ready(); await connecting;
    f.setSend(async () => { throw new Error('native session missing'); });
    await f.client.sendAudio(new Uint8Array([1, 2]).buffer);
    assert.equal(f.warnings.length, 1);
    assert.equal(f.client.isConnected, false);
    assert.equal(f.errors.length, 0);
    await f.tick(1000); await f.ready(1);
    f.setSend(async () => {});
    await f.client.sendAudio(new Uint8Array([3, 4]).buffer);
    assert.equal(f.sends.at(-1).sessionId, 2);
    await f.client.disconnect();
});

test('stalled audio IPC times out and later queued chunks cannot cross into a new connection', async () => {
    const f = fixture();
    const connecting = f.begin(); await nextTurn(); await f.ready(); await connecting;
    const stalled = deferred(); f.setSend(() => stalled.promise);
    const sending = f.client.sendAudio(new Uint8Array([1, 2]).buffer);
    const queued = f.client.sendAudio(new Uint8Array([3, 4]).buffer);
    await nextTurn(); await f.tick(10000); await sending; await queued;
    assert.equal(f.warnings.length, 1);
    assert.equal(f.sends.length, 1);
    await f.tick(1000); await f.ready(1);
    stalled.resolve(); await nextTurn();
    assert.equal(f.sends.length, 1);
    assert.equal(f.client.isConnected, true);
    await f.client.disconnect();
});

test('connection timeout retries and Stop releases all scheduled timers', async () => {
    const f = fixture();
    const connecting = f.begin(); const rejected = assert.rejects(connecting, /取消/);
    await nextTurn(); await f.tick(20000);
    assert.equal(f.warnings.length, 1);
    await f.client.disconnect(); await rejected;
    await f.tick(60000);
    assert.equal(f.starts.length, 1);
    assert.equal(f.timers.size, 0);
});

test('reconnect preserves partial text once and never pairs old source text with new translation', async () => {
    const f = fixture();
    const connecting = f.begin(); await nextTurn(); await f.ready(); await connecting;
    f.event(0, { type: 'source_transcript', text: 'first source', is_final: true });
    f.event(0, { type: 'transcript', text: 'first partial', is_final: false });
    f.event(0, { type: 'closed', reason: 'network lost' });
    f.event(0, { type: 'closed', reason: 'duplicate' });
    assert.deepEqual(f.segments, [['first source', 'first partial']]);
    await f.tick(1000); await f.ready(1);
    f.event(1, { type: 'transcript', text: 'new translation', is_final: true });
    assert.deepEqual(f.segments, [['first source', 'first partial'], ['', 'new translation']]);
    await f.client.disconnect();
});

test('muted text-only calls continue suppressing audio after recovery', async () => {
    const f = fixture();
    const connecting = f.begin(); await nextTurn(); await f.ready(); await connecting;
    f.event(0, { type: 'audio_chunk', pcm_base64: 'AAAA' });
    f.event(0, { type: 'closed', reason: 'network lost' });
    await f.tick(1000); await f.ready(1);
    f.event(1, { type: 'audio_chunk', pcm_base64: 'AAAA' });
    assert.deepEqual(f.output.audio, []);
    await f.client.disconnect();
});


test('bounded audio backlog reconnects and clears queued data without replaying it', async () => {
    const f = fixture();
    const connecting = f.begin(); await nextTurn(); await f.ready(); await connecting;
    const stalled = deferred(); f.setSend(() => stalled.promise);
    const sending = f.client.sendAudio(new Uint8Array(16000 * 2 * 5).buffer);
    await nextTurn();
    await f.client.sendAudio(new Uint8Array([1, 2]).buffer);
    await sending;
    assert.equal(f.warnings.length, 1);
    assert.equal(f.client.isConnected, false);
    await f.tick(1000); await f.ready(1);
    stalled.reject(new Error('late IPC failure'));
    await nextTurn();
    assert.equal(f.client.isConnected, true);
    assert.equal(f.errors.length, 0);
    assert.equal(f.sends.length, 1);
    await f.client.disconnect();
});


test('reconnect waits for native cleanup after backoff and Stop cancels that wait', async () => {
    const f = fixture();
    const connecting = f.begin(); await nextTurn(); await f.ready(); await connecting;
    const cleanup = deferred(); f.setStop(() => cleanup.promise);
    f.event(0, { type: 'closed', reason: 'network lost' });
    await f.tick(1000);
    assert.equal(f.starts.length, 1, 'old socket cleanup must precede a new billable session');
    const stopping = f.client.disconnect();
    cleanup.resolve(); await stopping; await nextTurn();
    assert.equal(f.starts.length, 1, 'Stop cancels a retry already waiting for cleanup');
    assert.equal(f.client.isConnected, false);
    assert.equal(f.timers.size, 0);
});

test('reconnect starts after delayed native cleanup finishes', async () => {
    const f = fixture();
    const connecting = f.begin(); await nextTurn(); await f.ready(); await connecting;
    const cleanup = deferred(); f.setStop(() => cleanup.promise);
    f.event(0, { type: 'closed', reason: 'network lost' });
    await f.tick(1000);
    assert.equal(f.starts.length, 1);
    cleanup.resolve(); await nextTurn();
    assert.equal(f.starts.length, 2);
    await f.ready(1);
    assert.equal(f.client.isConnected, true);
    f.setStop(async () => {});
    await f.client.disconnect();
});
