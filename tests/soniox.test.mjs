import test from 'node:test';
import assert from 'node:assert/strict';
import { SonioxClient } from '../src/js/soniox.js';

const config = { apiKey: 'test-key', sourceLanguage: 'en', targetLanguage: 'zh' };

function fixture() {
    let now = 0, nextId = 0;
    const timers = new Map();
    const schedule = (callback, delay, interval = false) => {
        const id = ++nextId;
        timers.set(id, { callback, at: now + delay, delay, interval });
        return id;
    };
    const tick = delay => {
        const end = now + delay;
        for (;;) {
            const next = [...timers.entries()].filter(([, timer]) => timer.at <= end)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            const [id, timer] = next;
            now = timer.at;
            if (timer.interval) timer.at += timer.delay;
            else timers.delete(id);
            timer.callback();
        }
        now = end;
    };
    const sockets = [];
    class Socket {
        static OPEN = 1;
        constructor() {
            this.readyState = 0;
            this.sent = [];
            this.closeCount = 0;
            this.bufferedAmount = 0;
            sockets.push(this);
        }
        send(data) {
            if (this.failSend || this.readyState !== Socket.OPEN) throw new Error('send failed');
            this.sent.push(data);
        }
        close() { this.closeCount++; this.readyState = 3; this.onclose?.({ code: 1000 }); }
        open() { this.readyState = Socket.OPEN; this.onopen?.(); }
        message(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
        remoteClose(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
    }
    const client = new SonioxClient({ WebSocket: Socket,
        setTimeout: (callback, delay) => schedule(callback, delay), clearTimeout: id => timers.delete(id),
        setInterval: (callback, delay) => schedule(callback, delay, true), clearInterval: id => timers.delete(id),
    });
    const statuses = [], errors = [], fatals = [], translations = [];
    client.onStatusChange = status => statuses.push(status);
    client.onError = error => errors.push(error);
    client.onFatalError = error => fatals.push(error);
    client.onTranslation = text => translations.push(text);
    return { client, sockets, tick, timers, statuses, errors, fatals, translations };
}

test('a remote normal close reconnects and audio resumes on the replacement', () => {
    const f = fixture();
    f.client.connect(config);
    f.sockets[0].open();
    f.sockets[0].remoteClose(1000);
    assert.equal(f.client.isConnected, false);
    assert.equal(f.statuses.at(-1), 'connecting');
    f.tick(2000);
    f.sockets[1].open();
    const audio = new Uint8Array([1, 2]).buffer;
    f.client.sendAudio(audio);
    assert.equal(f.sockets[1].sent.at(-1), audio);
    assert.equal(f.client.isConnected, true);
    assert.equal(f.fatals.length, 0);
    f.client.disconnect();
});

test('finished preserves the last translation and starts only one replacement', () => {
    const f = fixture();
    f.client.connect(config);
    const first = f.sockets[0];
    first.open();
    first.message({ finished: true, tokens: [{ text: '最后一句', is_final: true, translation_status: 'translation' }] });
    first.remoteClose(1000);
    assert.deepEqual(f.translations, ['最后一句']);
    f.tick(2000);
    assert.equal(f.sockets.length, 2);
    f.client.disconnect();
});

test('disconnect cancels an in-flight handshake and ignores its delayed callbacks', () => {
    const f = fixture();
    f.client.connect(config);
    const first = f.sockets[0];
    f.client.disconnect();
    first.open();
    first.message({ tokens: [{ text: 'stale', is_final: true, translation_status: 'translation' }] });
    first.remoteClose(1006);
    f.tick(20000);
    assert.equal(first.closeCount, 1);
    assert.equal(first.sent.length, 0);
    assert.equal(f.sockets.length, 1);
    assert.equal(f.client.isConnected, false);
    assert.equal(f.timers.size, 0);
    assert.deepEqual(f.translations, []);
});

test('a previous reconnect cannot start another connection after stop and restart', () => {
    const f = fixture();
    f.client.connect(config);
    const first = f.sockets[0];
    first.open();
    first.remoteClose(1006);
    f.client.disconnect();
    f.client.connect(config);
    f.sockets[1].open();
    first.remoteClose(1006);
    first.onerror?.();
    f.tick(10000);
    assert.equal(f.sockets.length, 2);
    assert.equal(f.client.ws, f.sockets[1]);
    assert.equal(f.client.isConnected, true);
    f.client.disconnect();
});

test('timed-out handshakes retry within a bound and report a terminal failure once', () => {
    const f = fixture();
    f.client.connect(config);
    f.tick(72000); // Initial 15s + three retries (2s/4s/6s + 15s each).
    assert.equal(f.sockets.length, 4);
    assert.ok(f.sockets.every(socket => socket.closeCount === 1));
    assert.equal(f.fatals.length, 1);
    assert.match(f.fatals[0], /重试 3 次/);
    assert.equal(f.statuses.at(-1), 'error');
    assert.equal(f.timers.size, 0);
    f.sockets.at(-1).remoteClose();
    assert.equal(f.fatals.length, 1);
});

test('opening a socket without a successful API response does not reset retry attempts', () => {
    const f = fixture();
    f.client.connect(config);
    for (let attempt = 0; attempt <= 3; attempt++) {
        const socket = f.sockets.at(-1);
        socket.open();
        socket.message({ error_code: 503, error_message: 'temporarily unavailable' });
        if (attempt < 3) f.tick(2000 * (attempt + 1));
    }
    assert.equal(f.sockets.length, 4);
    assert.equal(f.fatals.length, 1);
    assert.equal(f.timers.size, 0);
});

test('a healthy provider response resets the retry budget', () => {
    const f = fixture();
    f.client.connect(config);
    f.sockets[0].remoteClose(1006);
    f.tick(2000);
    f.sockets[1].open();
    f.sockets[1].message({ tokens: [] });
    f.sockets[1].remoteClose(1006);
    f.tick(2000);
    assert.equal(f.sockets.length, 3);
    f.client.disconnect();
});

test('failed session rotation keeps the current socket connected and accepting audio', () => {
    const f = fixture();
    f.client.connect(config);
    const first = f.sockets[0];
    first.open();
    f.tick(180000);
    assert.equal(f.sockets.length, 2);
    f.sockets[1].remoteClose(1006);
    assert.equal(f.client.ws, first);
    assert.equal(f.client.isConnected, true);
    const audio = new Uint8Array([3, 4]).buffer;
    f.client.sendAudio(audio);
    assert.equal(first.sent.at(-1), audio);
    f.tick(2000);
    f.sockets[2].open();
    assert.equal(first.closeCount, 1);
    first.remoteClose(1000);
    assert.equal(f.client.ws, f.sockets[2]);
    assert.equal(f.client.isConnected, true);
    f.client.disconnect();
});

test('disconnect during rotation closes both active and pending sockets', () => {
    const f = fixture();
    f.client.connect(config);
    f.sockets[0].open();
    f.tick(180000);
    f.client.disconnect();
    f.sockets[1].open();
    assert.ok(f.sockets.every(socket => socket.closeCount === 1));
    assert.equal(f.sockets[1].sent.length, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.client.isConnected, false);
});

test('timeout error plus socket close schedules only one reconnect', () => {
    const f = fixture();
    f.client.connect(config);
    const first = f.sockets[0];
    first.open();
    first.message({ error_code: 408 });
    first.remoteClose(1000);
    first.onerror?.();
    f.tick(2000);
    assert.equal(f.sockets.length, 2);
    assert.equal(f.errors.length, 1);
    f.client.disconnect();
});

test('permanent API failures release resources and notify the owner to stop capture', () => {
    for (const code of [400, 401, 402]) {
        const f = fixture();
        f.client.connect(config);
        f.sockets[0].open();
        f.sockets[0].message({ error_code: code, error_message: 'invalid' });
        f.tick(20000);
        assert.equal(f.fatals.length, 1);
        assert.equal(f.client.isConnected, false);
        assert.equal(f.timers.size, 0);
        assert.equal(f.sockets.length, 1);
    }
});

test('failed audio sends and stalled outbound buffers recover without throwing into capture', () => {
    for (const failure of ['failSend', 'bufferedAmount']) {
        const f = fixture();
        f.client.connect(config);
        f.sockets[0].open();
        f.sockets[0][failure] = failure === 'failSend' ? true : 160001;
        assert.doesNotThrow(() => f.client.sendAudio(new Uint8Array([1, 2]).buffer));
        f.tick(2000);
        assert.equal(f.sockets.length, 2);
        assert.equal(f.fatals.length, 0);
        f.client.disconnect();
    }
});
