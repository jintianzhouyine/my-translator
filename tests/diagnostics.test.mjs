import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { DiagnosticLogger, classifyDiagnosticReason } from '../src/js/diagnostics.js';

function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}

function fixture(options = {}) {
    const calls = [];
    const logger = new DiagnosticLogger({
        invoke: async (command, args) => { calls.push({ command, ...structuredClone(args) }); },
        context: () => ({ engine: 'qwen', source: 'system', generation: 7 }),
        ...options,
    });
    return { logger, calls };
}

test('diagnostic errors become fixed categories without retaining source messages', () => {
    for (const [message, expected] of [
        ['401 authentication failed', 'auth'], ['InvalidApiKey sk-private', 'auth'],
        ['API 密钥无效，请在设置中检查', 'auth'], ['insufficient_quota', 'quota'], ['账户余额不足', 'quota'],
        ['429 Rate limit exceeded', 'rate_limit'], ['请求过于频繁', 'rate_limit'],
        ['400 invalid_parameter', 'configuration'], ['音频发送积压', 'backpressure'],
        ['音频采集已停止：设备断开', 'capture'], ['译音输出失败：设备断开', 'output'],
        ['恢复系统音频设备失败', 'output'], ['connection timed out', 'timeout'],
        ['WebSocket 1006 connection lost', 'network'], ['ECONNRESET', 'network'],
        ['503 ServiceUnavailable', 'provider'], ['字幕中的私人内容', 'unknown'],
    ]) assert.equal(classifyDiagnosticReason(message), expected, message);
    assert.equal(classifyDiagnosticReason(new Error('network failed')), 'network');
});

test('record emits only allowlisted event metadata and snapshots context immediately', async () => {
    let generation = 7;
    const f = fixture({ context: () => ({ engine: 'qwen', source: 'system', generation }) });
    const details = { direction: 'outbound', state: 'connecting', reason: 'network', attempt: 2, mode: 'duplex',
        apiKey: 'private-api-key', message: 'private raw error', text: 'private subtitle', pcm: [12345],
        device: 'private device', path: '/private/recording.wav', endpoint: 'https://private.example' };
    const recording = f.logger.record('retry_scheduled', details);
    generation = 8; details.direction = 'inbound';
    await recording;
    assert.deepEqual(f.calls, [{ command: 'write_diagnostic_event', entry: {
        event: 'retry_scheduled', engine: 'qwen', source: 'system', generation: 7,
        direction: 'outbound', state: 'connecting', reason: 'network', attempt: 2, mode: 'duplex',
    } }]);
});

test('unknown events, enum values and unsafe numeric fields cannot leak through diagnostic payloads', async () => {
    const f = fixture({ context: () => ({}) });
    await f.logger.record('private-api-key', { message: 'private error' });
    assert.equal(f.calls.length, 0);
    await f.logger.record('error', {
        engine: 'private engine', source: '/private/file.wav', direction: 'private person', state: 'private state',
        reason: 'private message', mode: 'private mode', generation: Infinity, attempt: 999,
    });
    assert.deepEqual(f.calls[0].entry, { event: 'error' });
    await f.logger.record('state_changed', { generation: -1, attempt: 1.5 });
    assert.deepEqual(f.calls[1].entry, { event: 'state_changed' });
    await f.logger.record('live_started', { generation: Number.MAX_SAFE_INTEGER + 1, attempt: '2' });
    assert.deepEqual(f.calls[2].entry, { event: 'live_started' });
});

test('notice extracts retry count and a fixed reason without sending secrets, subtitles or paths', async () => {
    const f = fixture();
    const raw = 'API key sk-secret /private/voice.wav 私人字幕；连接中断，正在自动重连（2/3）…';
    await f.logger.notice(raw, { direction: 'inbound', error: raw, message: raw });
    assert.deepEqual(f.calls[0].entry, {
        event: 'retry_scheduled', engine: 'qwen', source: 'system', generation: 7,
        direction: 'inbound', reason: 'network', attempt: 2,
    });
    assert.ok(!JSON.stringify(f.calls).includes('sk-secret'));
    assert.ok(!JSON.stringify(f.calls).includes('/private/voice.wav'));
    assert.ok(!JSON.stringify(f.calls).includes('私人字幕'));
});

test('output backlog warnings stay warnings and malformed retry counters are omitted', async () => {
    const f = fixture();
    await f.logger.notice('译音播放积压，已跳过部分过期译音；字幕和通话继续。请检查输出设备。');
    assert.equal(f.calls[0].entry.event, 'warning');
    assert.equal(f.calls[0].entry.reason, 'backpressure');
    assert.equal('attempt' in f.calls[0].entry, false);
    await f.logger.notice('连接断开，正在重连（999/3）');
    assert.equal(f.calls[1].entry.event, 'retry_scheduled');
    assert.equal('attempt' in f.calls[1].entry, false);
});

test('failed and synchronously throwing native writes never reject or block later log events', async () => {
    let count = 0;
    const f = fixture({ invoke() {
        count++;
        if (count === 1) throw new Error('disk full /private/path');
        if (count === 2) return Promise.reject(new Error('permission denied'));
        return Promise.resolve();
    } });
    await assert.doesNotReject(f.logger.record('app_started'));
    await assert.doesNotReject(f.logger.record('live_started'));
    await assert.doesNotReject(f.logger.record('live_paused'));
    await assert.doesNotReject(f.logger.flush());
    assert.equal(count, 3);
});

test('native writes remain ordered and a bounded pending queue drops excess events', async () => {
    const gate = deferred();
    const entries = [];
    const f = fixture({ maxPending: 2, invoke: async (_command, { entry }) => {
        entries.push(entry.event);
        if (entries.length === 1) await gate.promise;
    } });
    const first = f.logger.record('live_started');
    const second = f.logger.record('state_changed');
    const dropped = f.logger.record('warning');
    await nextTurn();
    assert.deepEqual(entries, ['live_started']);
    await dropped;
    gate.resolve();
    await Promise.all([first, second, f.logger.flush()]);
    assert.deepEqual(entries, ['live_started', 'state_changed']);
    await f.logger.record('live_paused');
    assert.deepEqual(entries, ['live_started', 'state_changed', 'live_paused']);
});

test('a stalled log write times out without stalling translation or subsequent diagnostic calls', async () => {
    let count = 0;
    const f = fixture({ timeoutMs: 5, invoke: () => {
        count++;
        return count === 1 ? new Promise(() => {}) : Promise.resolve();
    } });
    await assert.doesNotReject(f.logger.record('app_started'));
    await assert.doesNotReject(f.logger.record('live_started'));
    assert.equal(count, 2);
});

test('broken context collection cannot interrupt the application with a diagnostic exception', async () => {
    const f = fixture({ context() { throw new Error('context unavailable'); } });
    await assert.doesNotReject(async () => f.logger.record('live_failed'));
    await assert.doesNotReject(async () => f.logger.notice('network lost'));
    await assert.doesNotReject(f.logger.flush());
});


test('unprintable error objects cannot make diagnostic notices break the application', async () => {
    const f = fixture();
    await assert.doesNotReject(async () => f.logger.notice(Object.create(null)));
    await assert.doesNotReject(f.logger.flush());
    for (const call of f.calls) {
        assert.equal(call.entry.reason, 'unknown');
        assert.equal('message' in call.entry, false);
    }
});
