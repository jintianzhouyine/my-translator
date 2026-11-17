import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';
import vm from 'node:vm';
import { OpenAiRealtimeClient as RealOpenAiRealtimeClient } from '../src/js/openai-realtime-client.js';
import { DiagnosticLogger } from '../src/js/diagnostics.js';

const source = readFileSync(new URL('../src/js/app.js', import.meta.url), 'utf8');
const appClass = `${source.slice(source.indexOf('class App {'), source.lastIndexOf('// Initialize on DOM ready'))}\nApp;`
    .replace("await import('./openai-realtime-client.js')", 'await Promise.resolve({ OpenAiRealtimeClient: InjectedOpenAiClient })')
    .replace("await import('./openai-audio-output-queue.js')", 'await Promise.resolve({ OpenAiAudioOutputQueue: InjectedOutputQueue })');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function fixture({ diagnostics = false } = {}) {
    let now = 0, nextTimer = 0;
    const timers = new Map();
    const starts = [], clients = [], captures = [], captureErrors = [], commands = [], toasts = [], statuses = [], segments = [], diagnosticEntries = [];
    let nativeStart = async () => {};
    let captureRunning = false;
    const elements = new Map();
    const makeElement = () => ({ textContent: '', disabled: false, style: {}, handlers: {},
        classList: { add() {}, remove() {} }, addEventListener(event, listener) { this.handlers[event] = listener; },
        remove() {},
    });
    const element = id => {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
    };
    const document = { getElementById: element, querySelector: () => null, createElement: makeElement,
        body: { appendChild() {} } };
    class Channel {}
    async function invoke(command, args) {
        commands.push(command);
        if (command === 'write_diagnostic_event') diagnosticEntries.push(structuredClone(args.entry));
        if (command === 'get_diagnostic_log_info') return { directory: '/test/app-data/logs', retentionDays: 7 };
        if (command === 'openai_realtime_start') {
            const start = { channel: args.onEvent, id: starts.length + 1 };
            starts.push(start);
            return start.id;
        }
        if (command === 'start_capture') { captures.push(args.channel); captureErrors.push(args.onError); await nativeStart(); captureRunning = true; }
        if (command === 'stop_capture') captureRunning = false;
    }
    class OpenAiRealtimeClient extends RealOpenAiRealtimeClient {
        constructor() {
            super({ invoke, Channel,
                setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
                clearTimeout(id) { timers.delete(id); },
            });
            clients.push(this);
        }
    }
    const settings = { openai_api_key: 'test-key', source_language: 'en', target_language: 'zh' };
    const App = vm.runInNewContext(appClass, {
        InjectedOpenAiClient: OpenAiRealtimeClient, InjectedOutputQueue: class { flush() {} close() {} },
        invoke, Channel, document, getCurrentWindow: () => ({}), window: { __TAURI__: { core: { Channel } } },
        console: { log() {}, error() {}, warn() {} },
        sessionStore: { addSegment: (source, target) => segments.push([source, target]),
            endChunk() {}, async persist() { return 'skipped'; } },
        elevenLabsTTS: { disconnect() {} }, edgeTTSRust: { disconnect() {} }, audioPlayer: { stop() {} },
        settingsManager: { get: () => ({ ...settings }) },
        getAppVersion: async () => '0.0.0-test', PROJECT_URL: 'https://example.test/project',
        PROJECT_ISSUES_URL: 'https://example.test/issues', openProjectUrl: async () => {},
        setLiveBadge() {}, startAutoHideWatch() {}, stopAutoHideWatch() {}, requestAnimationFrame: fn => fn(),
        setTimeout: (fn, delay) => delay >= 3000 ? 0 : setTimeout(fn, delay), clearTimeout,
    });
    const app = new App();
    app.isRunning = true;
    app.translationMode = 'openai';
    app._startGeneration = 1;
    app._updateStartButton = () => {};
    app._setEnginePillLocked = () => {};
    app._showToast = (message, kind) => {
        toasts.push({ message, kind });
        if (diagnostics) App.prototype._showToast.call(app, message, kind);
    };
    app._updateStatus = state => {
        statuses.push(state);
        if (diagnostics) App.prototype._updateStatus.call(app, state);
    };
    if (diagnostics) app.diagnostics = new DiagnosticLogger({ invoke, context: () => ({
        engine: app.translationMode, source: app.currentSource, generation: app._startGeneration,
    }) });
    app.transcriptUI = { setProvisional() {}, setSourceProvisional() {}, addOriginal() {}, addTranslation() {},
        clearSourceProvisional() {}, clearProvisional() {} };
    async function tick(ms) {
        now += ms;
        for (const [id, timer] of [...timers]) {
            if (timer.at <= now && timers.has(id)) { timers.delete(id); timer.fn(); }
        }
        await nextTurn();
    }
    const event = (index, event) => starts[index].channel.onmessage(event);
    async function start() {
        const starting = app._startOpenAiMode(settings, app._startGeneration);
        await nextTurn();
        event(starts.length - 1, { type: 'status', state: 'ready' });
        await starting;
    }
    return { app, starts, clients, captures, captureErrors, commands, statuses, toasts, segments, timers, settings, tick, event, start, diagnosticEntries, element,
        setNativeStart: fn => { nativeStart = fn; }, captureRunning: () => captureRunning };
}

test('OpenAI fatal error immediately clears running state and releases capture once', async () => {
    const f = fixture(); await f.start();
    f.event(0, { type: 'error', code: 'invalid_api_key', message: 'Invalid API key' });
    assert.equal(f.app.isRunning, false);
    await f.app._pausePromise; await nextTurn();
    assert.equal(f.app.openAiClient, null);
    assert.equal(f.commands.filter(command => command === 'stop_capture').length, 1);
    assert.equal(f.statuses.at(-1), 'error');
    assert.equal(f.timers.size, 0);
});

test('pause during OpenAI startup cannot start capture after a late ready event', async () => {
    const f = fixture();
    const starting = f.app._startOpenAiMode(f.settings, 1);
    await nextTurn();
    const pausing = f.app.pause();
    f.event(0, { type: 'status', state: 'ready' });
    await pausing; await starting;
    assert.equal(f.app.isRunning, false);
    assert.equal(f.captures.length, 0);
    assert.equal(f.app.openAiClient, null);
    assert.equal(f.timers.size, 0);
});

test('pause during module loading does not create a connection', async () => {
    const f = fixture();
    const starting = f.app._startOpenAiMode(f.settings, 1);
    await f.app.pause(); await starting;
    assert.equal(f.starts.length, 0);
    assert.equal(f.captures.length, 0);
});

test('OpenAI transient recovery keeps one capture channel and does not pause the application', async () => {
    const f = fixture(); await f.start();
    f.event(0, { type: 'closed', reason: 'network lost' });
    assert.equal(f.app.isRunning, true);
    assert.equal(f.statuses.at(-1), 'connecting');
    await f.tick(1000);
    f.event(1, { type: 'status', state: 'ready' });
    await nextTurn();
    assert.equal(f.starts.length, 2);
    assert.equal(f.clients.length, 1);
    assert.equal(f.captures.length, 1);
    assert.equal(f.app.isRunning, true);
    assert.equal(f.statuses.at(-1), 'connected');
    assert.ok(!f.commands.includes('stop_capture'));
    await f.app.pause();
});

test('old OpenAI callbacks cannot stop or add text to a new mode', async () => {
    const f = fixture(); await f.start();
    const client = f.clients[0];
    const oldAudio = f.captures[0];
    await f.app.pause();
    f.app.translationMode = 'soniox';
    f.app.isRunning = true;
    const beforeStatuses = f.statuses.length, beforeCommands = f.commands.length;
    client.onError('late_error', 'old failure');
    client.onClosed('old close');
    client.onStatusChange('connecting');
    client.onSegment('old source', 'old translation');
    oldAudio.onmessage([1, 2]);
    await nextTurn();
    assert.equal(f.app.isRunning, true);
    assert.equal(f.statuses.length, beforeStatuses);
    assert.equal(f.commands.length, beforeCommands);
    assert.deepEqual(f.segments, []);
});

test('pause cancels retry before a newly selected mode can be affected', async () => {
    const f = fixture(); await f.start();
    f.event(0, { type: 'closed', reason: 'network lost' });
    await f.app.pause();
    f.app.translationMode = 'qwen'; f.app.isRunning = true;
    await f.tick(60000);
    assert.equal(f.starts.length, 1);
    assert.equal(f.captures.length, 1);
    assert.equal(f.app.isRunning, true);
});

test('pause waits for an in-flight capture startup before its final stop', async () => {
    const f = fixture();
    const captureStarted = deferred();
    let nativeCaptureRunning = false;
    f.setNativeStart(async () => { await captureStarted.promise; nativeCaptureRunning = true; });
    const starting = f.app._startOpenAiMode(f.settings, 1);
    await nextTurn();
    f.event(0, { type: 'status', state: 'ready' });
    await nextTurn();
    assert.equal(f.captures.length, 1);
    let pauseFinished = false;
    const pausing = f.app.pause().then(() => { pauseFinished = true; });
    await nextTurn();
    assert.equal(pauseFinished, false, 'pause must not finish before pending native capture startup');
    captureStarted.resolve();
    await starting; await pausing;
    assert.equal(nativeCaptureRunning, true);
    assert.equal(f.captureRunning(), false, 'the late capture must receive a final stop');
});


test('native capture failure clears the running state and stale errors cannot stop a later run', async () => {
    const f = fixture(); await f.start();
    f.captureErrors[0].onmessage('device disconnected');
    assert.equal(f.app.isRunning, false);
    await f.app._pausePromise;
    assert.equal(f.captureRunning(), false);
    assert.match(f.toasts[0].message, /device disconnected/);
    f.app.isRunning = true;
    await f.start();
    f.captureErrors[0].onmessage('late device error');
    assert.equal(f.app.isRunning, true);
    assert.equal(f.captureRunning(), true);
    await f.app.pause();
});


test('automatic failure logs its category and automatic pause without raw provider data', async () => {
    const f = fixture({ diagnostics: true }); await f.start();
    f.event(0, { type: 'error', code: 'invalid_api_key', message: 'Invalid API key sk-private /private/audio.wav 私人字幕' });
    await f.app._pausePromise; await nextTurn(); await f.app.diagnostics.flush();
    assert.ok(f.diagnosticEntries.some(entry => entry.event === 'warning' && entry.reason === 'auth'));
    assert.ok(f.diagnosticEntries.some(entry => entry.event === 'live_failed' && entry.reason === 'auto_failure'));
    assert.ok(f.diagnosticEntries.some(entry => entry.event === 'live_paused' && entry.reason === 'auto_failure'));
    for (const entry of f.diagnosticEntries) {
        assert.equal(entry.engine, 'openai');
        assert.equal(entry.source, 'system');
        assert.equal('message' in entry, false);
    }
    assert.ok(!JSON.stringify(f.diagnosticEntries).includes('sk-private'));
    assert.ok(!JSON.stringify(f.diagnosticEntries).includes('/private/audio.wav'));
    assert.ok(!JSON.stringify(f.diagnosticEntries).includes('私人字幕'));
});

test('manual pause logs requested rather than a provider failure', async () => {
    const f = fixture({ diagnostics: true }); await f.start();
    await f.app.pause(); await f.app.diagnostics.flush();
    assert.ok(f.diagnosticEntries.some(entry => entry.event === 'live_paused' && entry.reason === 'requested'));
    assert.ok(!f.diagnosticEntries.some(entry => entry.event === 'live_failed'));
});

test('retry and restoration produce diagnostic state changes while repeated status callbacks are deduplicated', async () => {
    const f = fixture({ diagnostics: true }); await f.start();
    f.clients[0].onStatusChange('ready');
    f.clients[0].onStatusChange('ready');
    f.event(0, { type: 'closed', reason: 'network lost' });
    await f.tick(1000);
    f.event(1, { type: 'status', state: 'ready' });
    await nextTurn(); await f.app.diagnostics.flush();
    assert.deepEqual(f.diagnosticEntries.filter(entry => entry.event === 'state_changed').map(entry => entry.state),
        ['connecting', 'connected', 'connecting', 'connected']);
    const retry = f.diagnosticEntries.find(entry => entry.event === 'retry_scheduled');
    assert.equal(retry.attempt, 1);
    assert.equal(retry.reason, 'network');
    assert.ok(!f.diagnosticEntries.some(entry => entry.event === 'live_paused'));
    await f.app.pause(); await f.app.diagnostics.flush();
});

test('About opens the diagnostic directory after flushing logs without pausing live translation', async () => {
    const f = fixture({ diagnostics: true }); await f.start();
    f.app._initAboutTab();
    await nextTurn();
    assert.equal(f.element('diagnostic-log-path').textContent, '/test/app-data/logs');
    const commandStart = f.commands.length;
    void f.app.diagnostics.record('warning', { reason: 'network' });
    await f.element('btn-open-logs').handlers.click();
    const commands = f.commands.slice(commandStart);
    assert.ok(commands.indexOf('write_diagnostic_event') < commands.indexOf('open_diagnostic_log_dir'));
    assert.equal(commands.filter(command => command === 'open_diagnostic_log_dir').length, 1);
    assert.ok(!commands.includes('stop_capture'));
    assert.ok(!commands.includes('openai_realtime_stop'));
    assert.equal(f.app.isRunning, true);
    assert.equal(f.element('btn-open-logs').disabled, false);
    await f.app.pause(); await f.app.diagnostics.flush();
});
