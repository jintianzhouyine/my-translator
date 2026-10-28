import test from 'node:test';
import assert from 'node:assert/strict';
import { QwenRealtimeClient, QwenTranscriptAssembler } from '../src/js/qwen-realtime-client.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const config = { apiKey: 'test-key', workspaceId: 'workspace-123', region: 'cn-beijing', targetLanguage: 'en', audioOutput: true, phrases: { '灰度发布': 'canary release' } };
class Channel { onmessage() {} }
function harness(overrides = {}, options = {}) {
    const calls = [];
    let channel;
    const invoke = async (command, args) => {
        calls.push({ command, args });
        if (command === 'qwen_realtime_start') channel = args.onEvent;
        if (overrides[command]) return overrides[command](args);
        if (command === 'qwen_realtime_start') return 7;
        if (command === 'qwen_realtime_stop') channel?.onmessage({ type: 'closed', reason: 'stopped' });
    };
    const client = new QwenRealtimeClient({ invoke, Channel, connectTimeoutMs: 100, disconnectTimeoutMs: 50, ...options });
    const emit = event => channel.onmessage(event);
    return { client, calls, emit, channel: () => channel };
}
async function connected(h, cfg = config) {
    const ready = h.client.connect(cfg);
    await tick();
    h.emit({ type: 'status', state: 'ready' });
    await ready;
}
function collector() {
    const finals = [], provisional = [], sources = [];
    const assembler = new QwenTranscriptAssembler({
        onSegment: (...args) => finals.push(args),
        onProvisional: (...args) => provisional.push(args),
        onSourceProvisional: (...args) => sources.push(args),
    });
    return { assembler, finals, provisional, sources, emit: event => assembler.handle(event) };
}

// Provider events can interleave between directions/speakers; ordering is not a pairing key.
test('pairs interleaved translations with their explicit source IDs', () => {
    const h = collector();
    h.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 's1', transcript: '第一句' });
    h.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 's2', transcript: '第二句' });
    h.emit({ type: 'conversation.item.created', previous_item_id: 's2', item: { id: 't2', role: 'assistant' } });
    h.emit({ type: 'conversation.item.created', previous_item_id: 's1', item: { id: 't1', role: 'assistant' } });
    h.emit({ type: 'response.text.delta', item_id: 't2', response_id: 'r2', delta: 'Second' });
    h.emit({ type: 'response.text.delta', item_id: 't1', response_id: 'r1', delta: 'First' });
    h.emit({ type: 'response.text.done', item_id: 't2', text: 'Second.' });
    h.emit({ type: 'response.text.done', item_id: 't1', text: 'First.' });
    assert.deepEqual(h.finals.map(([source, target]) => [source, target]), [['第二句', 'Second.'], ['第一句', 'First.']]);
    assert.equal(h.provisional.at(-1)[1].sourceText, '第一句');
});

test('late source and link update one finalized item instead of pairing a different speaker', () => {
    const h = collector();
    h.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'unrelated', transcript: '不可配对' });
    h.emit({ type: 'response.audio_transcript.done', item_id: 't1', transcript: 'Hello' });
    assert.equal(h.finals[0][0], '');
    h.emit({ type: 'conversation.item.created', previous_item_id: 's1', item: { id: 't1', role: 'assistant' } });
    h.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 's1', transcript: '你好' });
    h.emit({ type: 'input_audio_buffer.speech_started', item_id: 's1', speaker_id: 2 });
    assert.equal(h.finals.at(-1)[0], '你好');
    assert.equal(h.finals.at(-1)[2].speakerId, '2');
    assert.ok(h.finals.every(([, , meta]) => meta.itemId === 't1'));
    const count = h.finals.length;
    h.emit({ type: 'response.audio_transcript.done', item_id: 't1', transcript: 'Hello' });
    h.emit({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [{ id: 't1', role: 'assistant', content: [{ transcript: 'Hello' }] }] } });
    assert.equal(h.finals.length, count);
});

test('response.done finalizes only its own response and never a failed response', () => {
    const h = collector();
    h.emit({ type: 'response.text.delta', item_id: 't1', response_id: 'r1', delta: 'one' });
    h.emit({ type: 'response.text.delta', item_id: 't2', response_id: 'r2', delta: 'two' });
    h.emit({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
    assert.equal(h.finals.length, 1);
    assert.equal(h.finals[0][1], 'one');
    h.emit({ type: 'response.done', response: { id: 'r2', status: 'failed' } });
    assert.equal(h.finals.length, 1);
});

test('accumulates 3.8 deltas, ignores deltas after final, and bounds session history', () => {
    const h = collector();
    h.emit({ type: 'response.text.delta', item_id: 't1', delta: 'Hel' });
    h.emit({ type: 'response.text.delta', item_id: 't1', delta: 'lo' });
    assert.equal(h.provisional.at(-1)[0], 'Hello');
    h.emit({ type: 'response.text.done', item_id: 't1', text: 'Hello' });
    h.emit({ type: 'response.text.delta', item_id: 't1', delta: ' duplicate' });
    assert.equal(h.finals.at(-1)[1], 'Hello');
    for (let i = 0; i < 1000; i++) {
        h.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: `source-${i}`, transcript: 'source' });
        h.emit({ type: 'response.text.done', item_id: `target-${i}`, text: 'target' });
    }
    assert.ok(h.assembler.sources.size <= 256);
    assert.ok(h.assembler.targets.size <= 256);
    assert.ok(h.assembler.retired.size <= 512);
});

test('connect resolves only after backend ID and provider ready, with 3.8 config', async () => {
    const h = harness();
    let settled = false;
    const connection = h.client.connect(config).then(() => { settled = true; });
    await tick();
    assert.equal(settled, false);
    assert.equal(h.client.isConnected, false);
    h.emit({ type: 'status', state: 'connecting' });
    await tick();
    assert.equal(settled, false);
    h.emit({ type: 'status', state: 'ready' });
    await connection;
    assert.equal(h.client.isConnected, true);
    assert.deepEqual(h.calls[0].args.config, { api_key: 'test-key', workspace_id: 'workspace-123', region: 'cn-beijing', target_language: 'en', audio_output: true, phrases: { '灰度发布': 'canary release' }, turn_detection: 'speaker_detection', finish_timeout_ms: null });
    await h.client.disconnect();
});

test('ready event arriving before IPC ID does not start sending early', async () => {
    const start = deferred();
    const h = harness({ qwen_realtime_start: () => start.promise });
    const connection = h.client.connect(config);
    await tick();
    h.emit({ type: 'status', state: 'ready' });
    assert.equal(h.client.isConnected, false);
    start.resolve(23);
    await connection;
    assert.equal(h.client.sessionId, 23);
    await h.client.disconnect();
});

test('cancel during start rejects connect and stops a late backend session', async () => {
    const start = deferred();
    const h = harness({ qwen_realtime_start: () => start.promise });
    const connection = h.client.connect(config);
    const rejected = assert.rejects(connection, /取消/);
    await tick();
    const stale = h.channel();
    await h.client.disconnect();
    await rejected;
    start.resolve(99);
    await tick();
    assert.equal(h.calls.filter(call => call.command === 'qwen_realtime_stop').length, 1);
    assert.equal(h.calls.at(-1).args.sessionId, 99);
    stale.onmessage({ type: 'status', state: 'ready' });
    assert.equal(h.client.isConnected, false);
});

test('provider error before ready rejects connect and emits one error and one close', async () => {
    const h = harness();
    const errors = [], closed = [];
    h.client.onError = (...args) => errors.push(args);
    h.client.onClosed = reason => closed.push(reason);
    const connection = h.client.connect(config);
    const rejected = assert.rejects(connection, /InvalidApiKey/);
    await tick();
    h.emit({ type: 'error', code: 'session_failed', message: 'InvalidApiKey' });
    await rejected;
    await tick();
    assert.equal(errors.length, 1);
    assert.equal(closed.length, 1);
    assert.equal(h.client.isConnected, false);
    await h.client.disconnect();
});

test('provider close before ready rejects connect', async () => {
    const h = harness();
    const connection = h.client.connect(config);
    const rejected = assert.rejects(connection, /就绪前/);
    await tick();
    h.emit({ type: 'closed', reason: 'remote_close' });
    await rejected;
    await h.client.disconnect();
});

test('graceful disconnect receives final text but never promotes unfinished provisional text', async () => {
    let h;
    h = harness({ qwen_realtime_stop: () => {
        h.emit({ type: 'protocol', event: { type: 'response.text.done', item_id: 't1', text: 'completed' } });
        h.emit({ type: 'closed', reason: 'stopped' });
    } });
    const finals = [];
    h.client.onSegment = (...args) => finals.push(args);
    await connected(h);
    h.emit({ type: 'protocol', event: { type: 'response.text.delta', item_id: 't1', delta: 'complet' } });
    h.emit({ type: 'protocol', event: { type: 'response.text.delta', item_id: 't2', delta: 'never finalized' } });
    await h.client.disconnect();
    assert.equal(finals.length, 1);
    assert.equal(finals[0][1], 'completed');
});

test('old channel cannot mutate a newly connected session', async () => {
    const h = harness();
    await connected(h);
    const oldChannel = h.channel();
    await h.client.disconnect();
    await connected(h);
    const finals = [];
    h.client.onSegment = (...args) => finals.push(args);
    oldChannel.onmessage({ type: 'protocol', event: { type: 'response.text.done', item_id: 'old', text: 'stale' } });
    oldChannel.onmessage({ type: 'closed', reason: 'late_close' });
    assert.equal(finals.length, 0);
    assert.equal(h.client.isConnected, true);
    await h.client.disconnect();
});

test('outgoing audio remains ordered even when IPC completion is delayed', async () => {
    const first = deferred();
    const h = harness({ qwen_realtime_send_audio: args => args.pcm[0] === 1 ? first.promise : undefined });
    await connected(h);
    const one = h.client.sendAudio(new Uint8Array([1, 0]));
    const two = h.client.sendAudio(new Uint8Array([2, 0]));
    await tick();
    assert.equal(h.calls.filter(call => call.command === 'qwen_realtime_send_audio').length, 1);
    first.resolve();
    await Promise.all([one, two]);
    assert.deepEqual(h.calls.filter(call => call.command === 'qwen_realtime_send_audio').map(call => call.args.pcm), [[1, 0], [2, 0]]);
    await h.client.disconnect();
});

test('audio backpressure is bounded and surfaces an error instead of silently dropping speech', async () => {
    const blocked = deferred();
    const h = harness({ qwen_realtime_send_audio: () => blocked.promise });
    const errors = [];
    h.client.onError = code => errors.push(code);
    await connected(h);
    const sends = Array.from({ length: 17 }, () => h.client.sendAudio(new Uint8Array([1, 0])).catch(error => error));
    blocked.resolve();
    await Promise.all(sends);
    assert.deepEqual(errors, ['audio_backpressure']);
    assert.equal(h.client.isConnected, false);
    await h.client.disconnect();
});

test('audio callback supplies raw PCM metadata and close does not duplicate', async () => {
    const h = harness();
    const audio = [], closed = [];
    h.client.onAudioChunk = (...args) => audio.push(args);
    h.client.onClosed = reason => closed.push(reason);
    await connected(h);
    h.emit({ type: 'audio', audio: 'AAE=', item_id: 'target', response_id: 'response' });
    assert.equal(audio[0][0], 'AAE=');
    assert.equal(audio[0][1].sampleRate, 24000);
    await h.client.disconnect();
    assert.equal(closed.length, 1);
});

test('a stalled send from a closed session cannot block audio in the next session', async () => {
    const stalled = deferred();
    let nextId = 0;
    const h = harness({
        qwen_realtime_start: () => ++nextId,
        qwen_realtime_send_audio: args => args.sessionId === 1 ? stalled.promise : undefined,
    });
    await connected(h);
    const oldSend = h.client.sendAudio(new Uint8Array([1, 0]));
    await tick();
    h.emit({ type: 'closed', reason: 'remote_close' });
    await connected(h);
    const newSend = h.client.sendAudio(new Uint8Array([2, 0]));
    await newSend;
    assert.equal(h.calls.filter(call => call.command === 'qwen_realtime_send_audio').at(-1).args.sessionId, 2);
    stalled.resolve();
    await oldSend;
    await h.client.disconnect();
});

test('configuration timeout rejects connect and cleans up a late session ID', async () => {
    const start = deferred();
    const h = harness({ qwen_realtime_start: () => start.promise });
    h.client._connectTimeout = 5;
    const connection = h.client.connect(config);
    await assert.rejects(connection, /超时/);
    start.resolve(55);
    await tick();
    assert.equal(h.calls.filter(call => call.command === 'qwen_realtime_stop').length, 1);
    assert.equal(h.calls.at(-1).args.sessionId, 55);
    await h.client.disconnect();
});

test('source audio timestamps update the correct finalized translation even when late or out of order', () => {
    const h = collector();
    h.emit({ type: 'response.text.done', item_id: 'target', text: 'Translated' });
    h.emit({ type: 'conversation.item.created', previous_item_id: 'source', item: { id: 'target', role: 'assistant' } });
    h.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'other', audio_end_ms: 9000 });
    assert.equal(h.finals.at(-1)[2].endMs, null);
    h.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'source', audio_end_ms: 1200 });
    assert.equal(h.finals.at(-1)[2].endMs, 1200);
    h.emit({ type: 'input_audio_buffer.speech_started', item_id: 'source', audio_start_ms: 0, speaker_id: 2 });
    assert.deepEqual([h.finals.at(-1)[2].startMs, h.finals.at(-1)[2].endMs], [0, 1200]);
    const count = h.finals.length;
    h.emit({ type: 'input_audio_buffer.speech_started', item_id: 'source', audio_start_ms: 0, speaker_id: 2 });
    h.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'source', audio_end_ms: -1 });
    h.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'source', audio_end_ms: '2000' });
    assert.equal(h.finals.length, count, 'duplicate or invalid timing cannot change the final result');
    assert.ok(h.finals.every(([, , meta]) => meta.itemId === 'target'));
});

test('cached source timing and text survive source eviction and a later timing correction', () => {
    const h = collector();
    h.emit({ type: 'input_audio_buffer.speech_started', item_id: 'source', audio_start_ms: 25 });
    h.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'source', audio_end_ms: 1200 });
    h.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'source', transcript: '原文' });
    h.emit({ type: 'conversation.item.created', previous_item_id: 'source', item: { id: 'target', role: 'assistant' } });
    h.emit({ type: 'response.text.done', item_id: 'target', text: 'Translation' });
    for (let i = 0; i < 300; i++) h.emit({ type: 'input_audio_buffer.speech_started', item_id: `other-${i}`, audio_start_ms: 5000 + i });
    assert.equal(h.assembler.sources.has('source'), false);
    assert.deepEqual([h.assembler.metadata('target').startMs, h.assembler.metadata('target').endMs], [25, 1200]);
    h.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'source', audio_end_ms: 1500 });
    assert.equal(h.finals.at(-1)[0], '原文');
    assert.deepEqual([h.finals.at(-1)[2].startMs, h.finals.at(-1)[2].endMs], [25, 1500]);
});

test('file configuration forwards server VAD and its bounded drain timeout', async () => {
    const h = harness();
    await connected(h, { ...config, audioOutput: false, turnDetection: 'server_vad', finishTimeoutMs: 30000 });
    assert.equal(h.calls[0].args.config.turn_detection, 'server_vad');
    assert.equal(h.calls[0].args.config.finish_timeout_ms, 30000);
    assert.equal(h.calls[0].args.config.audio_output, false);
    assert.equal(h.client._operation.finishTimeout, 42000);
    await h.client.disconnect();
});

test('finish drains accepted audio in order and accepts only a provider-confirmed completed session', async () => {
    const sent = deferred();
    let h;
    h = harness({
        qwen_realtime_send_audio: () => sent.promise,
        qwen_realtime_stop: () => {
            h.emit({ type: 'protocol', event: { type: 'response.text.done', item_id: 'final', text: 'Complete' } });
            h.emit({ type: 'closed', reason: 'finished' });
        },
    });
    const finals = [], closes = [];
    h.client.onSegment = (...args) => finals.push(args);
    h.client.onClosed = reason => closes.push(reason);
    await connected(h);
    const sending = h.client.sendAudio(new Uint8Array([1, 0]));
    const finishing = h.client.finish();
    const repeated = h.client.finish();
    await tick();
    assert.equal(h.calls.some(call => call.command === 'qwen_realtime_stop'), false);
    sent.resolve();
    await Promise.all([sending, finishing, repeated]);
    assert.equal(h.calls.filter(call => call.command === 'qwen_realtime_stop').length, 1);
    assert.deepEqual(closes, ['finished']);
    assert.equal(finals[0][1], 'Complete');
    assert.equal(h.client._operation, null);
});

test('finish waits for the provider event even when stop IPC returns first', async () => {
    const h = harness({ qwen_realtime_stop: () => undefined });
    await connected(h);
    let completed = false;
    const finishing = h.client.finish().then(() => { completed = true; });
    await tick();
    assert.equal(completed, false);
    h.emit({ type: 'closed', reason: 'finished' });
    await finishing;
    assert.equal(completed, true);
});

test('finish rejects silent stop timeouts and ordinary closes rather than reporting a complete file', async () => {
    const silent = harness({ qwen_realtime_stop: () => undefined }, { finishTimeoutMs: 5 });
    await connected(silent);
    await assert.rejects(silent.client.finish(), /收尾超时/);
    assert.equal(silent.client._operation, null);
    const closed = harness();
    await connected(closed);
    await assert.rejects(closed.client.finish(), /未确认/);
});

test('a provider error during file drain rejects finish even if a later close claims finished', async () => {
    let h, count = 0;
    h = harness({ qwen_realtime_stop: () => {
        if (++count === 1) h.emit({ type: 'error', code: 'failed', message: 'translation failed' });
        h.emit({ type: 'closed', reason: 'finished' });
    } });
    await connected(h);
    await assert.rejects(h.client.finish(), /translation failed/);
    assert.equal(h.client._operation, null);
});

test('an accepted audio send failing during finish cannot be swallowed by the send queue', async () => {
    const sent = deferred();
    let h;
    h = harness({ qwen_realtime_send_audio: () => sent.promise,
        qwen_realtime_stop: () => h.emit({ type: 'closed', reason: 'finished' }) });
    await connected(h);
    const sending = assert.rejects(h.client.sendAudio(new Uint8Array([1, 0])), /send failed/);
    const finishing = assert.rejects(h.client.finish(), /send failed/);
    sent.reject(new Error('send failed'));
    await Promise.all([sending, finishing]);
});

test('cancelling a finishing file rejects completion and late events cannot affect a new connection', async () => {
    const firstStop = deferred();
    let h, count = 0;
    h = harness({ qwen_realtime_stop: () => {
        if (++count === 1) return firstStop.promise;
        h.emit({ type: 'closed', reason: 'stopped' });
    } });
    await connected(h);
    const oldChannel = h.channel();
    const finishing = assert.rejects(h.client.finish(), /未确认/);
    await tick();
    await h.client.disconnect();
    await finishing;
    await connected(h);
    firstStop.resolve();
    oldChannel.onmessage({ type: 'closed', reason: 'finished' });
    await tick();
    assert.equal(h.client.isConnected, true);
    await h.client.disconnect();
});
