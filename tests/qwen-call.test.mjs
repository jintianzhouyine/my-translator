import test from 'node:test';
import assert from 'node:assert/strict';
import { QwenCallController, validateQwenCall } from '../src/js/qwen-call.js';

const settings = {
    qwen_api_key: 'test-key', qwen_workspace_id: 'workspace-test', qwen_region: 'cn-beijing',
    qwen_duplex_enabled: true, qwen_my_language: 'zh', qwen_peer_language: 'en',
    qwen_manage_system_devices: false,
    qwen_output_device: 'Virtual Cable', qwen_microphone_device: 'Mic', qwen_system_device: 'Headphones',
    qwen_glossary_outbound: { 测试: 'test' }, qwen_glossary_inbound: { test: '测试' },
};
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ customInvoke, connect, captureDrainTimeoutMs = 25, reconnectDelayMs = 1 } = {}) {
    const calls = [], clients = [], segments = [], errors = [], statuses = [], warnings = [];
    let capture;
    const controller = new QwenCallController({
        invoke: async (name, args) => {
            calls.push({ name, args });
            if (name === 'start_duplex_capture') capture = args.onAudio;
            if (customInvoke) {
                const result = customInvoke(name, args);
                if (result !== undefined) return result;
            }
            if (name === 'start_translation_output') return 17;
            if (name === 'begin_system_audio_route') return { routeId: 'route-1', microphoneDevice: 'Physical mic', systemDevice: 'Physical headphones' };
            if (name === 'stop_duplex_capture') capture?.onmessage({ type: 'stopped' });
        },
        captureDrainTimeoutMs,
        reconnectDelayMs,
        Channel: class {},
        createClient: () => {
            const client = {
                packets: [], closed: 0,
                async connect(config) { this.config = config; if (connect) await connect(this, clients.indexOf(this)); },
                async sendAudio(bytes) { this.packets.push([...new Uint8Array(bytes)]); },
                async disconnect() { this.closed++; },
            };
            clients.push(client);
            return client;
        },
        onSegment: (...args) => segments.push(args),
        onError: (...args) => errors.push(args),
        onStateChange: state => statuses.push(state),
        onWarning: message => warnings.push(message),
    });
    return { controller, calls, clients, segments, errors, statuses, warnings, capture: () => capture };
}

async function until(predicate) {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.ok(predicate(), 'expected lifecycle transition');
}

test('Qwen reconnects only the failed direction without restarting capture or losing prior segments', async () => {
    const f = fixture();
    await f.controller.start(settings);
    const original = f.clients[0];
    original.onSegment('before', '之前', { itemId: 'same' });
    original.onError('network_error', 'network lost');
    original.onClosed('error');
    f.capture().onmessage({ type: 'audio', source: 'system', pcm: [1, 2] });
    f.capture().onmessage({ type: 'audio', source: 'microphone', pcm: [3, 4] });
    await until(() => f.clients.length === 3 && !f.controller.run.recoveries.inbound);
    assert.equal(f.errors.length, 0);
    assert.equal(f.controller.state, 'running');
    assert.equal(f.calls.filter(c => c.name === 'start_duplex_capture').length, 1);
    assert.equal(f.calls.filter(c => c.name === 'stop_duplex_capture').length, 0);
    assert.deepEqual(original.packets, []);
    assert.deepEqual(f.clients[1].packets, [[3, 4]]);
    f.clients[2].onSegment('after', '之后', { itemId: 'same' });
    assert.notEqual(f.segments[0][3].id, f.segments[1][3].id);
    original.onClosed('late old close');
    original.onSegment('stale', '过期', { itemId: 'same' });
    f.capture().onmessage({ type: 'audio', source: 'system', pcm: [5, 6] });
    assert.deepEqual(f.clients[2].packets, [[5, 6]]);
    assert.equal(f.segments.length, 2);
    await f.controller.stop();
});

test('Qwen stop cancels a scheduled reconnect and never recreates clients', async () => {
    const f = fixture({ reconnectDelayMs: 1000 });
    await f.controller.start(settings);
    f.clients[0].onClosed('network lost');
    await tick();
    await f.controller.stop();
    assert.equal(f.clients.length, 2);
    assert.equal(f.controller.run, null);
    assert.equal(f.errors.length, 0);
});

test('Qwen simultaneous direction failures recover independently and announce connected only when both are ready', async () => {
    const pending = deferred();
    const f = fixture({ connect: (_, index) => index === 3 ? pending.promise : undefined });
    await f.controller.start(settings);
    f.clients[0].onClosed('network lost');
    f.clients[1].onClosed('network lost');
    await until(() => f.clients.length === 4);
    assert.equal(f.statuses.at(-1), 'connecting');
    pending.resolve();
    await until(() => f.statuses.at(-1) === 'connected');
    assert.equal(f.errors.length, 0);
    await f.controller.stop();
});

test('Qwen repeated transient handshake failures stop after a bounded retry budget', async () => {
    const f = fixture({ connect: (_, index) => { if (index >= 2) throw new Error('connection timed out'); } });
    await f.controller.start(settings);
    f.clients[0].onClosed('network lost');
    await until(() => f.errors.length === 1);
    await f.controller.stop();
    assert.equal(f.clients.length, 5);
    assert.match(f.errors[0][1], /自动重连失败/);
    assert.equal(f.controller.run, null);
});

test('Qwen authentication errors fail immediately without retrying', async () => {
    const f = fixture();
    await f.controller.start(settings);
    f.clients[0].onError('InvalidApiKey', 'Invalid API key');
    await f.controller.stop();
    assert.equal(f.clients.length, 2);
    assert.equal(f.errors.length, 1);
});

test('Qwen stop cancels a reconnect handshake without allowing a late client to resume', async () => {
    const pending = deferred();
    const f = fixture({ connect: async (client, index) => {
        if (index >= 2) {
            client.disconnect = async () => { client.closed++; pending.reject(new Error('cancelled')); };
            await pending.promise;
        }
    } });
    await f.controller.start(settings);
    f.clients[0].onClosed('network lost');
    await until(() => f.clients.length === 3);
    await f.controller.stop();
    f.clients[2].onClosed('late close');
    f.clients[2].onSegment('late', '迟到', { itemId: '1' });
    assert.equal(f.controller.run, null);
    assert.equal(f.clients.length, 3);
    assert.equal(f.segments.length, 0);
    assert.equal(f.errors.length, 0);
});

test('Qwen repeated short-lived connections cannot reset the retry budget forever', async () => {
    const f = fixture();
    await f.controller.start(settings);
    for (let i = 0; i < 3; i++) {
        f.controller.run.clients.inbound.onClosed('network lost');
        await until(() => f.clients.length === i + 3 && !f.controller.run.recoveries.inbound);
    }
    f.controller.run.clients.inbound.onClosed('network lost');
    await until(() => f.errors.length === 1);
    await f.controller.stop();
    assert.equal(f.clients.length, 5);
    assert.match(f.errors[0][1], /自动重连失败/);
});

test('Qwen permanent error during a reconnect handshake cancels recovery without deadlock', async () => {
    const f = fixture({ connect: (client, index) => {
        if (index >= 2) {
            client.onError('InvalidApiKey', 'Invalid API key');
            throw new Error('Invalid API key');
        }
    } });
    await f.controller.start(settings);
    f.clients[0].onClosed('network lost');
    await until(() => f.errors.length === 1);
    await f.controller.stop();
    assert.equal(f.clients.length, 3);
    assert.equal(f.controller.run, null);
});

test('independent directions use different languages/glossaries and only outgoing audio is played', async () => {
    const f = fixture();
    await f.controller.start(settings);
    assert.equal(f.clients.length, 2);
    assert.deepEqual(f.clients.map(c => [c.config.targetLanguage, c.config.audioOutput]), [['zh', false], ['en', true]]);
    assert.deepEqual(f.clients[0].config.phrases, { test: '测试' });
    assert.deepEqual(f.clients[1].config.phrases, { 测试: 'test' });
    f.capture().onmessage({ type: 'audio', source: 'system', pcm: [1, 2] });
    f.capture().onmessage({ type: 'audio', source: 'microphone', pcm: [3, 4] });
    assert.deepEqual(f.clients[0].packets, [[1, 2]]);
    assert.deepEqual(f.clients[1].packets, [[3, 4]]);
    f.clients[0].onAudioChunk('AQI='); // Even an unexpected incoming audio event cannot play.
    f.clients[1].onAudioChunk('AwQ=');
    f.clients[1].onAudioChunk('BQY=');
    await tick();
    assert.deepEqual(f.calls.filter(c => c.name === 'write_translation_audio').map(c => c.args), [
        { outputId: 17, pcm: [3, 4] }, { outputId: 17, pcm: [5, 6] },
    ]);
    f.clients[0].onSegment('Hello', '你好', { itemId: 'same' });
    f.clients[1].onSegment('你好', 'Hello', { itemId: 'same' });
    assert.notEqual(f.segments[0][3].id, f.segments[1][3].id);
    await f.controller.stop();
    const played = f.calls.filter(c => c.name === 'write_translation_audio').length;
    f.clients[1].onAudioChunk('Bwg=');
    f.capture().onmessage({ type: 'audio', source: 'microphone', pcm: [9, 10] });
    await tick();
    assert.equal(f.calls.filter(c => c.name === 'write_translation_audio').length, played);
    assert.deepEqual(f.clients[1].packets, [[3, 4]]);
});

test('caption-only mode never opens the microphone or output', async () => {
    const f = fixture();
    await f.controller.start({ ...settings, qwen_duplex_enabled: false, qwen_output_device: '' });
    assert.equal(f.clients.length, 1);
    assert.equal(f.calls.find(c => c.name === 'start_duplex_capture').args.captureMicrophone, false);
    assert.equal(f.calls.some(c => c.name === 'start_translation_output'), false);
    await f.controller.stop();
});

test('failure to connect either direction rolls back output and both connections without capture', async () => {
    const f = fixture({ connect: async (_, index) => { if (index === 1) throw new Error('bad key'); } });
    await assert.rejects(f.controller.start(settings), /bad key/);
    assert.equal(f.calls.some(c => c.name === 'start_duplex_capture'), false);
    assert.ok(f.clients.every(c => c.closed > 0));
    assert.ok(f.calls.some(c => c.name === 'stop_translation_output' && c.args.outputId === 17));
    assert.equal(f.controller.run, null);
});

test('stop during native output startup disposes the late output and never connects', async () => {
    const pending = deferred();
    const f = fixture({ customInvoke: name => name === 'start_translation_output' ? pending.promise : undefined });
    const starting = f.controller.start(settings);
    const rejected = assert.rejects(starting, /取消/);
    const stopping = f.controller.stop();
    pending.resolve(91);
    await Promise.all([rejected, stopping]);
    assert.equal(f.clients.length, 0);
    assert.ok(f.calls.some(c => c.name === 'stop_translation_output' && c.args.outputId === 91));
    assert.equal(f.controller.run, null);
});

test('stop during handshake cancels clients without waiting for an audio capture', async () => {
    const pending = deferred();
    const f = fixture({ connect: async client => {
        client.disconnect = async () => { client.closed++; pending.reject(new Error('cancelled')); };
        await pending.promise;
    } });
    const starting = f.controller.start(settings);
    const rejected = assert.rejects(starting, /cancelled/);
    await tick();
    await f.controller.stop();
    await rejected;
    assert.equal(f.calls.some(c => c.name === 'start_duplex_capture'), false);
    assert.equal(f.controller.run, null);
});

test('cancel while native capture is starting cannot resurrect capture or readiness', async () => {
    const pending = deferred();
    const f = fixture({ customInvoke: name => name === 'start_duplex_capture' ? pending.promise : undefined });
    const starting = f.controller.start(settings);
    const rejected = assert.rejects(starting, /取消/);
    await tick();
    const stopping = f.controller.stop();
    pending.resolve();
    await Promise.all([rejected, stopping]);
    assert.equal(f.statuses.includes('connected'), false);
    assert.equal(f.controller.run, null);
    assert.ok(f.calls.filter(c => c.name === 'stop_duplex_capture').length >= 2);
});

test('native startup errors cannot produce a connected state', async () => {
    const f = fixture({ customInvoke: (name, args) => {
        if (name === 'start_duplex_capture') args.onAudio.onmessage({ type: 'error', source: 'system', message: 'device gone' });
    } });
    await assert.rejects(f.controller.start(settings), /device gone/);
    assert.equal(f.statuses.includes('connected'), false);
});

test('runtime capture failure shuts down both directions and reports once', async () => {
    const f = fixture();
    await f.controller.start(settings);
    f.capture().onmessage({ type: 'error', source: 'system', message: 'device removed' });
    f.clients[0].onClosed('network lost');
    await f.controller.stop();
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0][1], /device removed/);
    assert.ok(f.clients.every(c => c.closed > 0));
});

test('final source corrections drain during stop, provisional audio never plays after stop', async () => {
    const f = fixture();
    await f.controller.start(settings);
    f.clients[0].disconnect = async () => {
        f.clients[0].onSegment('corrected', '修正', { itemId: 'end' });
        f.clients[1].onAudioChunk('AQI=');
    };
    await f.controller.stop();
    assert.ok(f.segments.some(s => s[1] === 'corrected'));
    assert.equal(f.calls.some(c => c.name === 'write_translation_audio'), false);
});

test('a real playback failure still releases resources and reports the error', async () => {
    const f = fixture({ customInvoke: name => name === 'write_translation_audio' ? Promise.reject(new Error('full')) : undefined });
    await f.controller.start(settings);
    f.clients[1].onAudioChunk('AQI=');
    await tick();
    await f.controller.stop();
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0][1], /full/);
});

test('a long translated sentence can arrive in a burst without stopping either direction', async () => {
    const g = fixture();
    await g.controller.start(settings);
    g.clients[1].onAudioChunk(Buffer.alloc(24000 * 2 * 6).toString('base64'));
    await tick();
    assert.equal(g.controller.state, 'running');
    assert.equal(g.errors.length, 0);
    assert.equal(g.calls.find(c => c.name === 'write_translation_audio').args.pcm.length, 288000);
    await g.controller.stop();
});

test('excessive playback backlog warns once and discards stale queued audio while captions continue', async () => {
    const pending = deferred();
    const f = fixture({ customInvoke: name => name === 'write_translation_audio' ? pending.promise : undefined });
    await f.controller.start(settings);
    f.clients[1].onAudioChunk('AQI=');
    await tick();
    f.clients[1].onAudioChunk('AwQ=');
    f.clients[1].onAudioChunk(Buffer.alloc(24000 * 2 * 30).toString('base64'));
    f.clients[1].onAudioChunk(Buffer.alloc(24000 * 2 * 30).toString('base64'));
    assert.equal(f.controller.state, 'running');
    assert.equal(f.errors.length, 0);
    assert.equal(f.warnings.length, 1);
    f.clients[1].onSegment('continued', '继续', { itemId: 'new' });
    assert.equal(f.segments.length, 1);
    pending.resolve();
    await tick();
    assert.equal(f.calls.filter(c => c.name === 'write_translation_audio').length, 1);
    f.clients[1].onAudioChunk('BQY=');
    await tick();
    assert.equal(f.calls.filter(c => c.name === 'write_translation_audio').length, 2);
    await f.controller.stop();
});

test('native playback trimming warns without stopping capture or translation', async () => {
    const f = fixture({ customInvoke: name => name === 'write_translation_audio' ? Promise.resolve(true) : undefined });
    await f.controller.start(settings);
    f.clients[1].onAudioChunk('AQI=');
    await tick();
    assert.equal(f.controller.state, 'running');
    assert.equal(f.errors.length, 0);
    assert.equal(f.warnings.length, 1);
    assert.equal(f.calls.some(c => c.name === 'stop_duplex_capture'), false);
    await f.controller.stop();
});

test('message IDs remain unique across controller instances and preflight rejects invalid routes/languages', async () => {
    assert.throws(() => validateQwenCall({ ...settings, qwen_output_device: '' }), /输出/);
    assert.throws(() => validateQwenCall({ ...settings, qwen_peer_language: 'zh' }), /不同/);
    assert.throws(() => validateQwenCall({ ...settings, qwen_peer_language: 'af' }), /语音/);
    const f = fixture(), g = fixture();
    await f.controller.start(settings);
    f.clients[0].onSegment('a', '甲', { itemId: 'id' });
    await f.controller.stop();
    await g.controller.start(settings);
    g.clients[0].onSegment('b', '乙', { itemId: 'id' });
    await g.controller.stop();
    assert.notEqual(f.segments[0][3].id, g.segments[0][3].id);
});

test('stop accepts captured tail audio until the ordered stopped marker, even after stop IPC resolves', async () => {
    let scheduled = false;
    const f = fixture({ customInvoke: name => {
        if (name !== 'stop_duplex_capture' || scheduled) return;
        scheduled = true;
        setImmediate(() => {
            f.capture().onmessage({ type: 'audio', source: 'system', pcm: [1, 2] });
            f.capture().onmessage({ type: 'audio', source: 'microphone', pcm: [3, 4] });
            f.clients[1].onAudioChunk('BQY=');
            f.capture().onmessage({ type: 'stopped' });
            f.capture().onmessage({ type: 'audio', source: 'microphone', pcm: [7, 8] });
        });
        return Promise.resolve();
    } });
    await f.controller.start(settings);
    for (const client of f.clients) {
        client.disconnect = async () => {
            assert.equal(client.packets.length, 1, 'native tail must reach the client before session.finish');
            client.closed++;
        };
    }
    await f.controller.stop();
    assert.deepEqual(f.clients[0].packets, [[1, 2]]);
    assert.deepEqual(f.clients[1].packets, [[3, 4]]);
    assert.equal(f.calls.some(c => c.name === 'write_translation_audio'), false);
});

test('a missing capture stopped marker is bounded and late audio cannot revive a stopped call', async () => {
    const f = fixture({ customInvoke: name => name === 'stop_duplex_capture' ? Promise.resolve() : undefined,
        captureDrainTimeoutMs: 5 });
    await f.controller.start(settings);
    await f.controller.stop();
    f.capture().onmessage({ type: 'audio', source: 'microphone', pcm: [1, 2] });
    assert.deepEqual(f.clients[1].packets, []);
    assert.equal(f.controller.run, null);
});

test('capture failure discards queued tail audio while rolling back resources', async () => {
    const f = fixture({ customInvoke: name => {
        if (name === 'stop_duplex_capture' && f.capture()) {
            f.capture().onmessage({ type: 'audio', source: 'microphone', pcm: [1, 2] });
        }
    } });
    await f.controller.start(settings);
    f.capture().onmessage({ type: 'error', source: 'system', message: 'capture overflow' });
    await f.controller.stop();
    assert.deepEqual(f.clients[1].packets, []);
    assert.equal(f.errors.length, 1);
});

test('stop clears native playback before waiting for capture shutdown and its tail marker', async () => {
    const captureStopping = deferred();
    let stoppedOnce = false;
    const f = fixture({ customInvoke: name => {
        if (name === 'stop_duplex_capture' && !stoppedOnce) {
            stoppedOnce = true;
            return captureStopping.promise;
        }
    } });
    await f.controller.start(settings);
    const stopping = f.controller.stop();
    const stopNames = f.calls.map(c => c.name).filter(name => name.startsWith('stop_'));
    assert.deepEqual(stopNames, ['stop_translation_output', 'stop_duplex_capture']);
    assert.equal(f.controller.run.outputId, null);
    assert.equal(f.clients[0].closed, 0, 'translation input stays open while capture stops');
    f.capture().onmessage({ type: 'audio', source: 'microphone', pcm: [1, 2] });
    f.clients[1].onAudioChunk('AwQ=');
    f.capture().onmessage({ type: 'stopped' });
    captureStopping.resolve();
    await stopping;
    assert.deepEqual(f.clients[1].packets, [[1, 2]]);
    assert.equal(f.calls.some(c => c.name === 'write_translation_audio'), false);
});

test('system routing pins physical capture devices and restores before waiting for cloud drain', async () => {
    const disconnecting = deferred();
    const f = fixture();
    await f.controller.start({ ...settings, qwen_manage_system_devices: true, qwen_microphone_device: '' });
    const capture = f.calls.find(c => c.name === 'start_duplex_capture').args;
    assert.equal(capture.microphoneDevice, 'Physical mic');
    assert.equal(capture.systemDevice, 'Physical headphones');
    f.clients[0].disconnect = () => disconnecting.promise;
    const stopping = f.controller.stop();
    await tick();
    assert.ok(f.calls.some(c => c.name === 'end_system_audio_route' && c.args.routeId === 'route-1'));
    assert.equal(f.controller.state, 'stopping');
    disconnecting.resolve();
    await stopping;
    assert.equal(f.calls.filter(c => c.name === 'end_system_audio_route').length, 1);
});

test('failed connection restores the system devices and caption-only mode never changes defaults', async () => {
    const f = fixture({ connect: async () => { throw new Error('bad key'); } });
    await assert.rejects(f.controller.start({ ...settings, qwen_manage_system_devices: true }), /bad key/);
    assert.ok(f.calls.some(c => c.name === 'end_system_audio_route'));
    const g = fixture();
    await g.controller.start({ ...settings, qwen_manage_system_devices: true, qwen_duplex_enabled: false });
    assert.equal(g.calls.some(c => c.name === 'begin_system_audio_route'), false);
    await g.controller.stop();
});

test('cancelling during default-device switching restores a late native route', async () => {
    const pending = deferred();
    const f = fixture({ customInvoke: name => name === 'begin_system_audio_route' ? pending.promise : undefined });
    const starting = f.controller.start({ ...settings, qwen_manage_system_devices: true });
    const rejected = assert.rejects(starting, /取消/);
    const stopping = f.controller.stop();
    pending.resolve({ routeId: 'late-route', microphoneDevice: 'Physical', systemDevice: 'Headphones' });
    await Promise.all([rejected, stopping]);
    assert.ok(f.calls.some(c => c.name === 'end_system_audio_route' && c.args.routeId === 'late-route'));
    assert.equal(f.calls.some(c => c.name === 'start_translation_output'), false);
    assert.equal(f.controller.run, null);
});

test('restore errors are reported once and retried without stranding the call', async () => {
    let attempts = 0;
    const f = fixture({ customInvoke: name => {
        if (name === 'end_system_audio_route' && ++attempts === 1) return Promise.reject('device unplugged');
    } });
    await f.controller.start({ ...settings, qwen_manage_system_devices: true });
    await f.controller.stop();
    assert.equal(attempts, 2);
    assert.equal(f.warnings.length, 1);
    assert.match(f.warnings[0], /device unplugged/);
    assert.equal(f.controller.run, null);
});

test('original/translated controls are independent and muting does not stop source recognition', async () => {
    const f = fixture();
    await f.controller.start({ ...settings, qwen_original_enabled: true, qwen_translated_enabled: false,
        qwen_original_volume: 0.4, qwen_translated_volume: 0.7 });
    assert.deepEqual(f.calls.find(c => c.name === 'start_translation_output').args.mix,
        { originalEnabled: true, originalVolume: 0.4, translatedEnabled: false, translatedVolume: 0.7 });
    f.clients[1].onAudioChunk('AQI=');
    f.capture().onmessage({ type: 'audio', source: 'microphone', pcm: [1, 2] });
    await tick();
    assert.equal(f.calls.some(c => c.name === 'write_translation_audio'), false);
    assert.deepEqual(f.clients[1].packets, [[1, 2]]);
    await f.controller.setMix({ originalEnabled: false, originalVolume: 0.4, translatedEnabled: true, translatedVolume: 0.7 });
    f.clients[1].onAudioChunk('AwQ=');
    await tick();
    assert.deepEqual(f.calls.filter(c => c.name === 'write_translation_audio').map(c => c.args.pcm), [[3, 4]]);
    await f.controller.stop();
});

test('mute/unmute discards translated chunks already waiting in the IPC queue', async () => {
    const writing = deferred();
    let writes = 0;
    const f = fixture({ customInvoke: name => name === 'write_translation_audio' && ++writes === 1 ? writing.promise : undefined });
    await f.controller.start(settings);
    f.clients[1].onAudioChunk('AQI=');
    await tick();
    f.clients[1].onAudioChunk('AwQ=');
    await f.controller.setMix({ originalEnabled: false, originalVolume: 1, translatedEnabled: false, translatedVolume: 1 });
    await f.controller.setMix({ originalEnabled: false, originalVolume: 1, translatedEnabled: true, translatedVolume: 1 });
    writing.resolve();
    await tick();
    assert.equal(writes, 1, 'buffered speech from before mute must not resume');
    f.clients[1].onAudioChunk('BQY=');
    await tick();
    assert.equal(writes, 2);
    await f.controller.stop();
});

test('mix changes during native output startup are applied before capture', async () => {
    const opening = deferred();
    const f = fixture({ customInvoke: name => name === 'start_translation_output' ? opening.promise : undefined });
    const starting = f.controller.start(settings);
    await f.controller.setMix({ originalEnabled: true, originalVolume: 0.25, translatedEnabled: false, translatedVolume: 1 });
    opening.resolve(32);
    await starting;
    const update = f.calls.find(c => c.name === 'set_translation_mix');
    assert.equal(update.args.outputId, 32);
    assert.equal(update.args.originalVolume, 0.25);
    assert.equal(update.args.translatedEnabled, false);
    assert.ok(f.calls.indexOf(update) < f.calls.findIndex(c => c.name === 'start_duplex_capture'));
    await f.controller.stop();
});
