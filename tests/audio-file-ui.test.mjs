import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { AudioFileUI, hasAudioSegmentTiming } from '../src/js/audio-file-ui.js';

class Element {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.listeners = new Map();
        this.attributes = new Map();
        this.dataset = {};
        this.value = '';
        this.textContent = '';
        this.hidden = false;
        this.disabled = false;
        this.clicks = 0;
        const classes = new Set();
        this.classList = { contains: name => classes.has(name), toggle(name, enabled) {
            enabled ? classes.add(name) : classes.delete(name);
        } };
    }
    set innerHTML(_) { throw new Error('Audio metadata and transcripts must use textContent'); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    emit(type) { for (const listener of this.listeners.get(type) || []) listener({ target: this }); }
    click() { if (!this.disabled) { this.clicks++; this.emit('click'); } }
    removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this.src = ''; }
}

class Audio extends Element {
    constructor() {
        super('audio');
        this._time = 0;
        this.paused = true;
        this.seeking = false;
        this.playbackRate = 1;
        this.playCalls = 0;
        this.pauseCalls = 0;
        this.loads = 0;
    }
    set currentTime(value) { this._time = value; this.seeking = true; this.emit('seeking'); }
    get currentTime() { return this._time; }
    finishSeek() { this.seeking = false; this.emit('seeked'); }
    play() { this.playCalls++; this.paused = false; this.emit('play'); return this.playResult || Promise.resolve(); }
    pause() { this.pauseCalls++; this.paused = true; this.emit('pause'); }
    load() { this.loads++; this._time = 0; this.seeking = false; }
    advance(time) { this._time = time; this.emit('timeupdate'); }
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const segment = { id: '1', sourceText: 'Hello', text: '你好', startMs: 1000, endMs: 3000 };
const ready = { state: 'ready', fileName: 'meeting.wav', duration: 12, audioUrl: 'blob:first', segments: [],
    splitReady: true, parts: [{ id: 'part-1', startMs: 0, endMs: 12000, duration: 12 }] };

function fixture(overrides = {}) {
    const elements = new Map();
    const audio = new Audio();
    elements.set('audio-file-player', audio);
    const el = id => {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
    };
    const document = { getElementById: el, createElement: tag => new Element(tag) };
    const calls = { choose: [], chooseFiles: [], split: [], start: [], cancel: 0, export: [], settings: 0, errors: [], retry: [], skip: [], retryFailed: 0 };
    const timers = new Map();
    let nextTimer = 1;
    const ui = new AudioFileUI({ document, getSettings: () => ({ qwen_my_language: 'en' }),
        onChoose: file => calls.choose.push(file),
        onChooseFiles: files => calls.chooseFiles.push(files),
        onSplit: options => calls.split.push(options),
        onStart: options => calls.start.push(options),
        onCancel: () => { calls.cancel++; },
        onExport: options => calls.export.push(options),
        onOpenSettings: () => { calls.settings++; },
        onRetryPart: id => calls.retry.push(id),
        onSkipPart: id => calls.skip.push(id),
        onRetryFailed: () => { calls.retryFailed++; },
        onError: error => calls.errors.push(error),
        schedule(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
        cancelTimer: id => timers.delete(id),
        ...overrides,
    });
    ui.init();
    return { ui, el, audio, calls, timers, elements, runTimer() {
        const [id, timer] = timers.entries().next().value;
        timers.delete(id);
        timer.callback();
        return timer.delay;
    } };
}

test('initialization offers supported targets and choosing a file only requests local preparation', async () => {
    const f = fixture();
    assert.equal(f.el('select-audio-file-language').children.length, 60);
    assert.equal(f.el('select-audio-file-language').value, 'en');
    assert.equal(f.el('select-audio-file-glossary').value, 'none');
    assert.equal(f.el('btn-audio-file-start').disabled, true);
    assert.deepEqual(f.calls.start, []);
    f.el('btn-audio-file-choose').click();
    assert.equal(f.el('input-audio-file').clicks, 1);
    const file = { name: '<meeting>.wav', size: 1024 * 1024 };
    f.el('input-audio-file').files = [file];
    f.el('input-audio-file').emit('change');
    await nextTurn();
    assert.deepEqual(f.calls.choose, [file]);
    assert.deepEqual(f.calls.start, []);
    f.ui.setSnapshot({ ...ready, fileName: file.name });
    assert.equal(f.el('audio-file-name').textContent, file.name);
    assert.match(f.el('audio-file-metadata').textContent, /00:00:12.*1.0 MiB/);
    assert.equal(f.audio.src, 'blob:first');
    assert.equal(f.el('btn-audio-file-start').disabled, false);
});

test('start uses the selected target and explicitly selected saved dictionary, with no auto-reversal', async () => {
    const starting = deferred();
    const requests = [];
    const f = fixture({ onStart: options => { requests.push(options); return starting.promise; } });
    f.ui.setSnapshot(ready);
    f.el('select-audio-file-language').value = 'ja';
    f.el('select-audio-file-glossary').value = 'outbound';
    const pending = f.ui._start();
    assert.deepEqual(requests, [{ targetLanguage: 'ja', glossaryDirection: 'outbound', parallelism: 2, maxRetries: 2 }]);
    assert.equal(f.el('btn-audio-file-start').disabled, true);
    assert.equal(f.el('btn-audio-file-choose').disabled, true);
    assert.equal(f.el('btn-audio-file-cancel').hidden, false);
    await f.ui._start();
    assert.equal(requests.length, 1);
    starting.resolve();
    await pending;
    f.el('select-audio-file-language').value = 'unsupported';
    await f.ui._start();
    assert.equal(requests.length, 1);
    assert.match(f.calls.errors[0], /有效的目标语言/);
});

test('failed replacement decode preserves the previous file, player and completed translations until a new ready result', async () => {
    const f = fixture();
    f.ui.setSnapshot(ready);
    f.ui.setSnapshot({ state: 'completed', segments: [segment] });
    f.ui.setSnapshot({ state: 'decoding', fileName: 'bad.mp3', audioUrl: '', segments: [], message: '正在解码新文件' });
    assert.equal(f.el('audio-file-name').textContent, 'meeting.wav');
    assert.equal(f.audio.src, 'blob:first');
    assert.equal(f.el('audio-file-segments').children[0].children[2].textContent, '你好');
    f.ui.setSnapshot({ state: 'error', fileName: 'bad.mp3', audioUrl: '', segments: [], message: '不支持此格式' });
    assert.equal(f.ui.result.segments.length, 1);
    assert.equal(f.el('audio-file-name').textContent, 'meeting.wav');
    assert.equal(f.el('btn-audio-file-export-txt').disabled, false);
    assert.equal(f.el('audio-file-status').textContent, '不支持此格式');
    f.ui.setSnapshot({ ...ready, fileName: 'new.wav', audioUrl: 'blob:second', duration: 20 });
    assert.equal(f.el('audio-file-name').textContent, 'new.wav');
    assert.equal(f.audio.src, 'blob:second');
    assert.equal(f.ui.result.segments.length, 0);
});

test('actual timing drives original-audio seek and bounded playback; text resembling HTML remains literal', async () => {
    const f = fixture();
    const textSegment = { ...segment, sourceText: '<script>source</script>', text: '<img src=x onerror=alert(1)>' };
    f.ui.setSnapshot(ready);
    f.ui.setSnapshot({ state: 'completed', segments: [textSegment] });
    const row = f.el('audio-file-segments').children[0];
    assert.match(row.children[0].textContent, /00:00:01.000 – 00:00:03.000/);
    assert.equal(row.children[1].textContent, textSegment.sourceText);
    assert.equal(row.children[2].textContent, textSegment.text);
    row.click();
    f.audio.finishSeek();
    await nextTurn();
    assert.equal(f.audio.currentTime, 1);
    assert.equal(f.audio.playCalls, 1);
    assert.equal(row.classList.contains('playing'), true);
    assert.equal(f.timers.size, 1);
    assert.equal([...f.timers.values()][0].delay, 2000);
    f.audio._time = 3;
    f.runTimer();
    assert.equal(f.audio.paused, true);
    assert.equal(f.timers.size, 0);
    assert.equal(row.classList.contains('playing'), false);
});

test('manual seeking, pausing, replacing the file and leaving the tab cancel segment playback timers', async () => {
    const f = fixture();
    f.ui.setSnapshot(ready);
    f.ui.setSnapshot({ state: 'completed', segments: [segment] });
    const play = async () => { const playing = f.ui._playSegment(segment); f.audio.finishSeek(); await playing; assert.equal(f.timers.size, 1); };
    await play();
    f.audio.currentTime = 6;
    f.audio.finishSeek();
    assert.equal(f.timers.size, 0);
    await play();
    f.audio.pause();
    assert.equal(f.timers.size, 0);
    await play();
    f.ui.onLeave();
    assert.equal(f.audio.paused, true);
    assert.equal(f.timers.size, 0);
    assert.equal(f.calls.cancel, 0, 'leaving pauses the local player but does not cancel the cloud job');
    await play();
    f.ui.setSnapshot({ ...ready, audioUrl: 'blob:new', fileName: 'new.wav' });
    assert.equal(f.audio.paused, true);
    assert.equal(f.timers.size, 0);
});

test('playback rejection and a late play promise cannot leave a stop timer behind after leaving', async () => {
    const f = fixture();
    f.ui.setSnapshot(ready);
    f.audio.playResult = Promise.reject(new Error('codec unavailable'));
    await f.ui._playSegment(segment);
    assert.match(f.calls.errors[0], /无法播放原始音频.*codec unavailable/);
    assert.equal(f.timers.size, 0);
    const play = deferred();
    f.audio.playResult = play.promise;
    const pending = f.ui._playSegment(segment);
    f.ui.onLeave();
    play.resolve();
    await pending;
    assert.equal(f.timers.size, 0);
    assert.equal(f.audio.paused, true);
});

test('missing, inverted and invented string timings disable segment playback and timed export while TXT remains available', async () => {
    const f = fixture();
    f.ui.setSnapshot(ready);
    const incomplete = [
        { ...segment, startMs: null }, { ...segment, endMs: 1000 },
        { ...segment, startMs: '1000' }, { ...segment, startMs: -1 },
    ];
    assert.ok(incomplete.every(item => !hasAudioSegmentTiming(item)));
    f.ui.setSnapshot({ state: 'completed', segments: [segment, ...incomplete] });
    assert.equal(f.el('audio-file-segments').children[1].disabled, true);
    assert.equal(f.el('audio-file-segments').children[1].children[0].textContent, '时间未对齐');
    assert.equal(f.el('btn-audio-file-export-srt').disabled, true);
    assert.equal(f.el('btn-audio-file-export-vtt').disabled, true);
    assert.equal(f.el('btn-audio-file-export-txt').disabled, false);
    assert.match(f.el('audio-file-export-hint').textContent, /4 段时间未对齐/);
    await f.ui._export('srt');
    assert.deepEqual(f.calls.export, []);
    await f.ui._export('txt');
    assert.deepEqual(f.calls.export, [{ format: 'txt', content: 'translated' }]);
    await f.ui._playSegment(incomplete[0]);
    assert.equal(f.audio.playCalls, 0);
});

test('export delegates the selected format/content without downloading or synthesizing audio', async () => {
    const f = fixture();
    f.ui.setSnapshot(ready);
    f.ui.setSnapshot({ state: 'completed', segments: [segment] });
    for (const [format, content] of [['srt', 'translated'], ['vtt', 'bilingual'], ['txt', 'original']]) {
        f.el('select-audio-file-export-content').value = content;
        f.el('select-audio-file-export-content').emit('change');
        f.el(`btn-audio-file-export-${format}`).click();
        await nextTurn();
    }
    assert.deepEqual(f.calls.export, [{ format: 'srt', content: 'translated' }, { format: 'vtt', content: 'bilingual' }, { format: 'txt', content: 'original' }]);
    assert.equal(f.audio.playCalls, 0);
    f.ui.setSnapshot({ state: 'completed', segments: [{ ...segment, sourceText: '' }] });
    assert.equal(f.el('btn-audio-file-export-txt').disabled, true, 'missing original text cannot produce an original-only export');
    f.el('select-audio-file-export-content').value = 'bilingual';
    f.el('select-audio-file-export-content').emit('change');
    assert.equal(f.el('btn-audio-file-export-srt').disabled, true);
    assert.equal(f.el('btn-audio-file-export-txt').disabled, true);
    assert.match(f.el('audio-file-export-hint').textContent, /仅可导出译文/);
    f.el('select-audio-file-export-content').value = 'translated';
    f.el('select-audio-file-export-content').emit('change');
    assert.equal(f.el('btn-audio-file-export-srt').disabled, false);
});

test('progress and cancel state stay visible until the controller finishes, with no duplicate cancel calls', async () => {
    const cancelling = deferred();
    let cancels = 0;
    const f = fixture({ onCancel: () => { cancels++; return cancelling.promise; } });
    f.ui.setSnapshot(ready);
    f.ui.setSnapshot({ state: 'translating', progress: 0.4, message: '已处理 40%' });
    assert.equal(f.el('audio-file-progress').value, 0.4);
    assert.equal(f.el('audio-file-progress').hidden, false);
    assert.equal(f.el('audio-file-status').textContent, '已处理 40%');
    const pending = f.ui._cancel();
    assert.equal(f.el('btn-audio-file-cancel').disabled, true);
    await f.ui._cancel();
    assert.equal(cancels, 1);
    f.ui.setSnapshot({ state: 'finishing', message: '正在取消…' });
    assert.equal(f.el('btn-audio-file-start').disabled, true);
    f.ui.setSnapshot({ state: 'cancelled', segments: [segment] });
    cancelling.resolve();
    await pending;
    assert.equal(f.el('btn-audio-file-cancel').hidden, true);
    assert.equal(f.el('audio-file-progress').hidden, true);
    assert.equal(f.el('btn-audio-file-export-txt').disabled, false);
});

test('bounded pages keep all segments exportable and highlight the correct visible segment', () => {
    const f = fixture();
    f.ui.setSnapshot(ready);
    const segments = Array.from({ length: 125 }, (_, i) => ({ id: String(i), sourceText: `source${i}`, text: `译文${i}`, startMs: i * 1000, endMs: (i + 1) * 1000 }));
    f.ui.setSnapshot({ state: 'completed', segments });
    assert.equal(f.el('audio-file-segments').children.length, 50);
    assert.equal(f.el('audio-file-pagination').hidden, false);
    f.el('btn-audio-file-next').click();
    assert.equal(f.el('audio-file-segments').children.length, 50);
    assert.equal(f.el('audio-file-segments').children[0].children[2].textContent, '译文50');
    f.audio.paused = false;
    f.audio.advance(51.2);
    assert.equal(f.el('audio-file-segments').children[1].classList.contains('playing'), true);
    f.el('btn-audio-file-next').click();
    assert.equal(f.el('audio-file-segments').children.length, 25);
    assert.equal(f.el('btn-audio-file-next').disabled, true);
    assert.equal(f.ui.result.segments.length, 125);
    assert.match(f.el('audio-file-page-label').textContent, /101–125.*125/);
});

test('frequent progress snapshots retain existing result nodes and update only changed text or timing', () => {
    const f = fixture();
    f.ui.setSnapshot(ready);
    f.ui.setSnapshot({ state: 'translating', segments: [segment], progress: 0.1 });
    const row = f.el('audio-file-segments').children[0];
    for (let i = 0; i < 10; i++) {
        f.ui.setSnapshot({ state: 'translating', segments: [{ ...segment }], progress: i / 10 });
        assert.equal(f.el('audio-file-segments').children[0], row);
    }
    f.audio.paused = false;
    f.audio.advance(1.2);
    assert.equal(row.classList.contains('playing'), true);
    assert.equal(f.el('audio-file-segments').children[0], row);
    f.ui.setSnapshot({ state: 'translating', segments: [{ ...segment, text: '你好！' }] });
    assert.notEqual(f.el('audio-file-segments').children[0], row);
    assert.equal(f.el('audio-file-segments').children[0].children[2].textContent, '你好！');
});

test('segment playback waits for the parent audio-routing hook and leaving cancels a pending permission', async () => {
    const gates = [];
    const f = fixture({ onBeforePlayback: () => { const gate = deferred(); gates.push(gate); return gate.promise; } });
    f.ui.setSnapshot(ready);
    const first = f.ui._playSegment(segment);
    assert.equal(f.audio.playCalls, 0);
    f.ui.onLeave();
    gates[0].resolve();
    await first;
    assert.equal(f.audio.playCalls, 0);
    const second = f.ui._playSegment(segment);
    gates[1].resolve();
    await nextTurn();
    f.audio.finishSeek();
    await second;
    assert.equal(f.audio.playCalls, 1);
    assert.equal(f.audio.currentTime, 1);
    assert.equal(f.timers.size, 1);
});

test('native audio controls also await the parent hook without a play-event loop or late resume', async () => {
    const gates = [];
    const f = fixture({ onBeforePlayback: () => { const gate = deferred(); gates.push(gate); return gate.promise; } });
    f.ui.setSnapshot(ready);
    await f.audio.play();
    assert.equal(f.audio.paused, true);
    assert.equal(gates.length, 1);
    f.ui.onLeave();
    gates[0].resolve();
    await nextTurn();
    assert.equal(f.audio.playCalls, 1);
    assert.equal(f.audio.paused, true);
    await f.audio.play();
    gates[1].resolve();
    await nextTurn();
    assert.equal(f.audio.paused, false);
    assert.equal(f.audio.playCalls, 3, 'two native requests plus one authorized resume');
    assert.equal(gates.length, 2, 'authorized resume must not request permission again');
});

test('rejected action callbacks are reported without losing old results or leaking rejected promises', async () => {
    const errors = [];
    const fail = async () => { throw new Error('action failed'); };
    const f = fixture({ onChoose: fail, onStart: fail, onCancel: fail, onExport: fail, onOpenSettings: fail,
        onError: async message => { errors.push(message); throw new Error('error reporter also failed'); } });
    f.ui.setSnapshot(ready);
    f.ui.setSnapshot({ state: 'completed', segments: [segment] });
    await f.ui._choose({ name: 'bad.mp3' });
    await f.ui._start();
    await f.ui._export('txt');
    f.el('btn-audio-file-settings').click();
    await nextTurn();
    f.ui.setSnapshot({ state: 'translating' });
    await f.ui._cancel();
    await nextTurn();
    assert.equal(errors.length, 5);
    assert.equal(f.ui.result.fileName, 'meeting.wav');
    assert.equal(f.ui.result.segments.length, 1);
    assert.equal(f.el('audio-file-status').textContent, 'action failed');
});

test('cleanup removes listeners, pauses playback and ignores a late file-selection rejection', async () => {
    const reading = deferred();
    const f = fixture({ onChoose: () => reading.promise });
    f.ui.setSnapshot(ready);
    const pending = f.ui._choose({ name: 'slow.wav' });
    f.ui.cleanup();
    reading.reject(new Error('late failure'));
    await pending;
    assert.equal(f.audio.paused, true);
    assert.equal(f.audio.src, '');
    assert.equal(f.timers.size, 0);
    assert.equal(f.el('audio-file-segments').children.length, 0);
    assert.ok([...f.audio.listeners.values()].every(listeners => listeners.size === 0));
    assert.deepEqual(f.calls.errors, []);
});

test('native source picking bypasses the browser file reader and failure leaves manual multi-file import available', async () => {
    let picks = 0;
    const f = fixture({ onPickSource: async () => { picks++; throw new Error('自动读取不可用，请手动导入已切分文件'); } });
    f.ui.setSnapshot(ready);
    f.ui.setSnapshot({ state: 'completed', segments: [segment] });
    f.el('btn-audio-file-choose').click();
    await nextTurn();
    assert.equal(picks, 1);
    assert.equal(f.el('input-audio-file').clicks, 0);
    assert.deepEqual(f.calls.choose, []);
    assert.equal(f.el('btn-audio-file-choose-parts').disabled, false);
    assert.equal(f.ui.result.fileName, 'meeting.wav');
    assert.equal(f.ui.result.segments.length, 1);
    assert.match(f.calls.errors[0], /手动导入/);
    f.el('btn-audio-file-choose-parts').click();
    const files = [{ name: '02.mp3' }, { name: '01.mp3' }];
    f.el('input-audio-file-parts').files = files;
    f.el('input-audio-file-parts').emit('change');
    await nextTurn();
    assert.deepEqual(f.calls.chooseFiles, [files], 'controller owns sorting; the UI passes the selected files without inventing an order');
    assert.deepEqual(f.calls.start, []);
});

test('automatic and manual split settings are local-only and unapplied changes block paid translation', async () => {
    const requests = [];
    let f;
    f = fixture({ onSplit: async options => {
        requests.push(options);
        f.ui.setSnapshot({ ...ready, parts: [{ id: 'a', startMs: 0, endMs: 5000, duration: 5 }, { id: 'b', startMs: 5000, endMs: 12000, duration: 7 }] });
    } });
    f.ui.setSnapshot(ready);
    assert.equal(f.el('select-audio-file-split-minutes').value, '20');
    await f.ui._applySplit();
    assert.deepEqual(requests[0], { mode: 'auto', segmentSeconds: 1200 });
    assert.equal(f.el('btn-audio-file-start').disabled, false);
    f.el('select-audio-file-split-minutes').value = '5';
    f.el('select-audio-file-split-minutes').emit('change');
    assert.equal(f.el('btn-audio-file-start').disabled, true);
    await f.ui._start();
    assert.deepEqual(f.calls.start, []);
    await f.ui._applySplit();
    assert.deepEqual(requests[1], { mode: 'auto', segmentSeconds: 300 });
    f.el('select-audio-file-split-mode').value = 'manual';
    f.el('select-audio-file-split-mode').emit('change');
    f.el('input-audio-file-split-points').value = '00:00:05';
    f.el('input-audio-file-split-points').emit('input');
    assert.equal(f.el('audio-file-split-points-field').hidden, false);
    assert.equal(f.el('audio-file-split-duration-field').hidden, true);
    assert.equal(f.el('btn-audio-file-start').disabled, true);
    await f.ui._applySplit();
    assert.deepEqual(requests[2], { mode: 'manual', pointsText: '00:00:05' });
    assert.match(f.el('audio-file-split-status').textContent, /2 段.*本次导入音频/);
    assert.equal(f.el('audio-file-parts').children.length, 2);
    assert.equal(f.el('btn-audio-file-start').disabled, false);
    assert.deepEqual(f.calls.start, []);
});

test('failed automatic planning preserves preview and exposes manual retry without enabling translation', async () => {
    const f = fixture({ onSplit: async () => { throw new Error('时间点必须递增'); } });
    f.ui.setSnapshot({ ...ready, splitReady: false, splitError: '自动分段失败', parts: [] });
    assert.equal(f.audio.src, 'blob:first');
    assert.equal(f.el('audio-file-player-wrap').hidden, false);
    assert.equal(f.el('btn-audio-file-start').disabled, true);
    assert.equal(f.el('btn-audio-file-split').disabled, false);
    assert.equal(f.el('btn-audio-file-choose-parts').disabled, false);
    assert.match(f.el('audio-file-split-status').textContent, /自动分段失败.*原音预览仍保留/);
    f.el('select-audio-file-split-mode').value = 'manual';
    f.el('select-audio-file-split-mode').emit('change');
    f.el('input-audio-file-split-points').value = '00:00:08\n00:00:03';
    await f.ui._applySplit();
    assert.match(f.calls.errors[0], /递增/);
    assert.equal(f.el('btn-audio-file-start').disabled, true);
    assert.equal(f.audio.src, 'blob:first');
    assert.equal(f.el('btn-audio-file-split').disabled, false);
    await f.ui._start();
    assert.deepEqual(f.calls.start, []);
});

test('ready plans can translate without a single audio URL when a manual-file resolver owns playback', async () => {
    const f = fixture({ onResolvePlayback: async () => ({ audioUrl: 'blob:part-1', startMs: 0, endMs: 1000, offsetMs: 0 }) });
    f.ui.setSnapshot({ ...ready, audioUrl: '' });
    assert.equal(f.el('btn-audio-file-start').disabled, false);
    await f.ui._start();
    assert.equal(f.calls.start.length, 1);
});

test('manual-file playback preserves source part IDs and uses local times while highlighting global subtitles', async () => {
    const f = fixture({ onResolvePlayback: async item => {
        assert.equal(item.partId, 'part-2');
        return { audioUrl: 'blob:part-2', startMs: item.startMs - 10000,
            endMs: item.endMs - 10000, offsetMs: 10000, label: '02.mp3' };
    } });
    f.ui.setSnapshot({ ...ready, duration: 20 });
    const globalSegment = { ...segment, partId: 'part-2', startMs: 11000, endMs: 13000 };
    f.ui.setSnapshot({ state: 'completed', segments: [globalSegment] });
    const playing = f.ui._playSegment(f.ui.result.segments[0]);
    await nextTurn();
    f.audio.finishSeek();
    await playing;
    assert.equal(f.audio.src, 'blob:part-2');
    assert.equal(f.audio.currentTime, 1);
    assert.equal(f.ui._playbackOffsetMs, 10000);
    assert.match(f.el('audio-file-playback-label').textContent, /02.mp3/);
    assert.equal(f.el('audio-file-segments').children[0].classList.contains('playing'), true);
    f.ui.setSnapshot({ state: 'translating', audioUrl: 'blob:first', progress: 0.8, segments: [globalSegment] });
    assert.equal(f.audio.src, 'blob:part-2', 'progress must not reset the current clip to the first file');
    f.audio._time = 3;
    f.runTimer();
    assert.equal(f.audio.paused, true);
});

test('leaving while resolving a manual clip prevents late source replacement and playback', async () => {
    const resolving = deferred();
    const f = fixture({ onResolvePlayback: () => resolving.promise });
    f.ui.setSnapshot(ready);
    const playing = f.ui._playSegment(segment);
    f.ui.onLeave();
    resolving.resolve({ audioUrl: 'blob:late', startMs: 1000, endMs: 3000, offsetMs: 0 });
    await playing;
    assert.equal(f.audio.src, 'blob:first');
    assert.equal(f.audio.playCalls, 0);
});

test('part timelines stay bounded, show exact ranges and filenames, and highlight the current cloud part', () => {
    const f = fixture();
    const parts = Array.from({ length: 105 }, (_, i) => ({ id: `part-${i}`, startMs: i * 1000, endMs: (i + 1) * 1000,
        duration: 1, fileName: `${i}.mp3` }));
    f.ui.setSnapshot({ ...ready, duration: 105, parts });
    assert.equal(f.el('audio-file-parts').children.length, 50);
    assert.match(f.el('audio-file-parts').children[0].children[0].textContent, /00:00:00.000 – 00:00:01.000.*0.mp3/);
    const row = f.el('audio-file-parts').children[1];
    f.ui.setSnapshot({ state: 'translating', parts, partIndex: 1, partCount: 105, progress: 0.1 });
    assert.equal(f.el('audio-file-parts').children[1], row);
    assert.equal(row.classList.contains('current'), true);
    f.el('btn-audio-file-parts-next').click();
    f.el('btn-audio-file-parts-next').click();
    assert.equal(f.el('audio-file-parts').children.length, 5);
    assert.match(f.el('audio-file-parts-page-label').textContent, /101–105.*105/);
    assert.equal(f.el('btn-audio-file-parts-next').disabled, true);
});

test('imported clip plans use file boundaries and timeline playback supplies the source part ID', async () => {
    const resolved = [];
    const f = fixture({ onResolvePlayback: async item => {
        resolved.push(item);
        return { audioUrl: 'blob:first', startMs: 0, endMs: 12000, offsetMs: 0 };
    } });
    f.ui.setSnapshot({ ...ready, manualFiles: true });
    assert.equal(f.el('select-audio-file-split-mode').disabled, true);
    assert.equal(f.el('btn-audio-file-split').disabled, true);
    assert.equal(f.el('btn-audio-file-start').disabled, false);
    assert.match(f.el('audio-file-split-status').textContent, /文件边界处理.*重新导入/);
    await f.ui._applySplit();
    assert.deepEqual(f.calls.split, []);
    f.el('audio-file-parts').children[0].children[0].click();
    await nextTurn();
    assert.equal(resolved[0].partId, 'part-1');
    f.audio.finishSeek();
    assert.equal(f.audio.playCalls, 1);
});

const buttonsIn = element => [
    ...(element.tagName === 'BUTTON' ? [element] : []), ...element.children.flatMap(buttonsIn),
];

test('processing preferences reach start and invalid speed/retry values cannot start a paid session', async () => {
    const f = fixture();
    f.ui.setSnapshot(ready);
    assert.equal(f.el('select-audio-file-parallelism').value, '2');
    assert.equal(f.el('select-audio-file-retries').value, '2');
    f.el('select-audio-file-parallelism').value = '1';
    f.el('select-audio-file-retries').value = '0';
    await f.ui._start();
    assert.deepEqual(f.calls.start[0], { targetLanguage: 'en', glossaryDirection: 'none', parallelism: 1, maxRetries: 0 });
    f.el('select-audio-file-parallelism').value = '8';
    await f.ui._start();
    f.el('select-audio-file-parallelism').value = '2';
    f.el('select-audio-file-retries').value = '-1';
    await f.ui._start();
    assert.equal(f.calls.start.length, 1);
    assert.equal(f.calls.errors.length, 2);
    f.ui.setSnapshot({ state: 'translating' });
    assert.equal(f.el('select-audio-file-parallelism').disabled, true);
    assert.equal(f.el('select-audio-file-retries').disabled, true);
});

test('skip is offered only for failed requests, never current, pending, finished or cancelled parts', async () => {
    const f = fixture();
    const statuses = ['pending', 'preparing', 'connecting', 'translating', 'finishing', 'retry_wait', 'completed', 'failed', 'skipped', 'cancelled'];
    const parts = statuses.map((status, i) => ({ id: status, status, attempt: 3, startMs: i * 1000, endMs: (i + 1) * 1000,
        duration: 1, ...(status === 'failed' ? { error: '<network> timeout' } : {}) }));
    f.ui.setSnapshot({ ...ready, parts });
    f.ui.setSnapshot({ state: 'translating', parts, activePartIds: ['translating', 'connecting'] });
    for (let i = 0; i < statuses.length; i++) {
        const row = f.el('audio-file-parts').children[i];
        const skip = buttonsIn(row).find(button => button.textContent === '跳过失败片段');
        assert.equal(!!skip, statuses[i] === 'failed', statuses[i]);
        await f.ui._partAction(statuses[i], 'skip');
    }
    assert.deepEqual(f.calls.skip, ['failed']);
    assert.match(f.el('audio-file-parts').children[7].children[1].textContent, /请求失败.*第 3 次请求/);
    assert.equal(f.el('audio-file-parts').children[7].children[2].textContent, '<network> timeout');
    assert.equal(f.el('audio-file-parts').children[3].classList.contains('current'), true);
    assert.equal(f.el('audio-file-parts').children[2].classList.contains('current'), true);
    assert.equal(f.el('audio-file-parts').children[0].classList.contains('current'), false);
});

test('retry a failed part while another is translating; duplicate actions remain locked until a changed status', async () => {
    const retrying = deferred();
    const retried = [];
    const f = fixture({ onRetryPart: id => { retried.push(id); return retrying.promise; } });
    const failed = { id: 'failed', startMs: 0, endMs: 1000, status: 'failed', attempt: 3 };
    const active = { id: 'active', startMs: 1000, endMs: 2000, status: 'translating', attempt: 1, progress: 0.2 };
    f.ui.setSnapshot({ ...ready, parts: [failed, active] });
    f.ui.setSnapshot({ state: 'translating', parts: [failed, active], activePartIds: ['active'] });
    const action = f.ui._partAction('failed', 'retry');
    await f.ui._partAction('failed', 'retry');
    await f.ui._partAction('failed', 'skip');
    assert.deepEqual(retried, ['failed']);
    assert.deepEqual(f.calls.skip, []);
    assert.equal(f.el('btn-audio-file-choose').disabled, true);
    retrying.resolve();
    await action;
    await f.ui._partAction('failed', 'retry');
    assert.deepEqual(retried, ['failed'], 'resolved dispatch alone does not permit duplicate retries');
    f.ui.setSnapshot({ state: 'translating', parts: [{ ...failed, status: 'pending' }, active] });
    assert.equal(f.ui._partRequests.size, 0);
    assert.equal(buttonsIn(f.el('audio-file-parts').children[0]).length, 1, 'queued part only exposes playback');
});

test('rejected retry actions unlock controls and leave completed subtitles exportable', async () => {
    const f = fixture({ onRetryPart: async () => { throw new Error('重试连接失败'); } });
    f.ui.setSnapshot({ ...ready, parts: [{ ...ready.parts[0], status: 'failed', error: 'timeout' }] });
    f.ui.setSnapshot({ state: 'partial', segments: [segment] });
    await f.ui._partAction('part-1', 'retry');
    assert.equal(f.ui._partRequests.size, 0);
    assert.equal(f.el('btn-audio-file-choose').disabled, false);
    assert.equal(f.el('btn-audio-file-export-srt').disabled, false);
    assert.deepEqual(f.ui.result.segments, [{ ...segment, partId: undefined }]);
    assert.match(f.calls.errors[0], /重试连接失败/);
});

test('partial results export normally while retry-all excludes a skipped-only result and guards duplicate dispatch', async () => {
    const retrying = deferred();
    let retries = 0;
    const f = fixture({ onRetryFailed: () => { retries++; return retrying.promise; } });
    f.ui.setSnapshot({ ...ready, parts: [{ ...ready.parts[0], status: 'skipped' }] });
    f.ui.setSnapshot({ state: 'partial', segments: [segment] });
    assert.equal(f.el('btn-audio-file-retry-failed').hidden, true);
    await f.ui._retryFailed();
    assert.equal(retries, 0);
    assert.match(f.el('audio-file-export-hint').textContent, /部分结果.*时间空缺/);
    await f.ui._export('srt');
    assert.deepEqual(f.calls.export, [{ format: 'srt', content: 'translated' }]);
    f.ui.setSnapshot({ state: 'partial', parts: [{ ...ready.parts[0], status: 'failed' }] });
    assert.equal(f.el('btn-audio-file-retry-failed').disabled, false);
    const action = f.ui._retryFailed();
    await f.ui._retryFailed();
    assert.equal(retries, 1);
    assert.equal(f.el('btn-audio-file-retry-failed').disabled, true);
    retrying.resolve();
    await action;
});

test('provisional streaming text stays separate from final subtitles and disappears at terminal states', async () => {
    const f = fixture();
    f.ui.setSnapshot(ready);
    f.ui.setSnapshot({ state: 'translating', provisionals: [{ partId: 'part-1', text: '<未定稿>', sourceText: 'Partial source' }] });
    const provisional = f.el('audio-file-provisionals').children[0];
    assert.equal(f.el('audio-file-provisionals').hidden, false);
    assert.match(provisional.children[0].textContent, /第 1 个片段（未定稿）/);
    assert.equal(provisional.children[2].textContent, '<未定稿>');
    assert.equal(f.ui.result.segments.length, 0);
    assert.equal(f.el('btn-audio-file-export-txt').disabled, true);
    f.ui.setSnapshot({ state: 'partial', segments: [segment] });
    assert.equal(f.el('audio-file-provisionals').hidden, true);
    assert.equal(f.el('audio-file-provisionals').children.length, 0);
    assert.equal(f.ui.result.segments[0].text, '你好');
    await f.ui._export('txt');
    assert.equal(f.calls.export.length, 1);
});

test('same-file decoding refreshes job states and changing only progress keeps retry buttons stable', () => {
    const f = fixture();
    const failed = { ...ready.parts[0], status: 'failed', attempt: 1, error: 'timeout', progress: 0.2 };
    f.ui.setSnapshot(ready);
    f.ui.setSnapshot({ ...ready, state: 'decoding', parts: [failed], activePartIds: [] });
    assert.equal(f.ui.result.parts[0].status, 'failed');
    const row = f.el('audio-file-parts').children[0];
    for (let i = 0; i < 10; i++) {
        f.ui.setSnapshot({ state: 'translating', parts: [{ ...failed, progress: i / 10 }] });
        assert.equal(f.el('audio-file-parts').children[0], row);
    }
});
