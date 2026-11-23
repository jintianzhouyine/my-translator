import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopSubtitles, desktopSubtitlePayload } from '../src/js/desktop-subtitles.js';
import { initDesktopSubtitleWindow, renderDesktopSubtitle } from '../src/js/desktop-subtitle-window.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { resolve, reject, promise };
};
const enabled = { desktop_subtitle_enabled: true };
const self = { id: 'self', original: '我说的话', translation: 'What I said', direction: 'outbound', status: 'translated' };
const peer = { id: 'peer', original: 'Your words', translation: '对方的话', direction: 'inbound', status: 'translated' };

test('desktop subtitles default off and independently select original, translation or both', () => {
    assert.deepEqual(desktopSubtitlePayload({}, { segments: [self] }), {
        enabled: false, original: '', translation: '', speaker: '',
    });
    assert.deepEqual(desktopSubtitlePayload(enabled, { segments: [self] }), {
        enabled: true, original: self.original, translation: self.translation, speaker: '我',
    });
    assert.equal(desktopSubtitlePayload({ ...enabled, desktop_subtitle_content: 'original' }, { segments: [self] }).translation, '');
    assert.equal(desktopSubtitlePayload({ ...enabled, desktop_subtitle_content: 'translation' }, { segments: [self] }).original, '');
    assert.equal(desktopSubtitlePayload({ ...enabled, desktop_subtitle_content: 'invalid' }, { segments: [self] }).translation, self.translation);
});

test('duplex speaker filtering keeps IDs in recognition order when older source text arrives late', () => {
    const snapshot = { segments: [self, peer, { ...self, id: 'new-self', original: '新句子', translation: 'New sentence' }] };
    assert.equal(desktopSubtitlePayload(enabled, snapshot).original, '新句子');
    assert.equal(desktopSubtitlePayload({ ...enabled, desktop_subtitle_speaker: 'peer' }, snapshot).original, peer.original);
    snapshot.segments[0].original = '较早的原文晚到';
    assert.equal(desktopSubtitlePayload(enabled, snapshot).original, '新句子');
    snapshot.segments.push({ ...peer, id: 'new-peer', original: 'Latest peer', translation: '最新对方' });
    assert.equal(desktopSubtitlePayload({ ...enabled, desktop_subtitle_speaker: 'both' }, snapshot).original, 'Latest peer');
});

test('single-input identity follows capture source and mixed capture never guesses self or peer', () => {
    const segment = { original: 'source', translation: 'target' };
    assert.equal(desktopSubtitlePayload(enabled, { segments: [segment], audioSource: 'microphone' }).speaker, '我');
    assert.equal(desktopSubtitlePayload(enabled, { segments: [segment], audioSource: 'system' }).original, '');
    assert.equal(desktopSubtitlePayload({ ...enabled, desktop_subtitle_speaker: 'peer' }, { segments: [segment], audioSource: 'system' }).speaker, '对方');
    assert.equal(desktopSubtitlePayload(enabled, { segments: [segment], audioSource: 'both' }).original, '');
    assert.equal(desktopSubtitlePayload({ ...enabled, desktop_subtitle_speaker: 'both' }, { segments: [segment], audioSource: 'both' }).speaker, '混合音频');
});

test('retained segments preserve speaker identity when the next capture changes audio source', () => {
    const oldPeer = { original: 'Earlier peer', translation: '之前对方', audioSource: 'system' };
    const oldSelf = { original: '之前自己', translation: 'Earlier self', audioSource: 'microphone' };
    const microphone = { segments: [oldPeer], audioSource: 'microphone' };
    assert.equal(desktopSubtitlePayload(enabled, microphone).original, '');
    assert.equal(desktopSubtitlePayload({ ...enabled, desktop_subtitle_speaker: 'peer' }, microphone).speaker, '对方');
    const system = { segments: [oldSelf], audioSource: 'system' };
    assert.equal(desktopSubtitlePayload(enabled, system).speaker, '我');
    assert.equal(desktopSubtitlePayload({ ...enabled, desktop_subtitle_speaker: 'peer' }, system).original, '');
    const mixed = { segments: [{ ...oldSelf, audioSource: 'both' }], audioSource: 'microphone' };
    assert.equal(desktopSubtitlePayload(enabled, mixed).original, '');
    assert.equal(desktopSubtitlePayload({ ...enabled, desktop_subtitle_speaker: 'both' }, mixed).speaker, '混合音频');
    assert.equal(desktopSubtitlePayload(enabled, { segments: [{ ...self, audioSource: 'system' }] }).speaker, '我',
        'explicit duplex direction remains authoritative');
});

test('live provisional text keeps source and target roles and clearing it restores the last final', () => {
    const snapshot = { audioSource: 'microphone', segments: [{ original: 'old', translation: '旧句子' }],
        provider: 'openai', provisionalText: 'new translation', sourceProvisionalText: 'new source' };
    assert.deepEqual(desktopSubtitlePayload(enabled, snapshot), {
        enabled: true, original: 'new source', translation: 'new translation', speaker: '我',
    });
    assert.equal(desktopSubtitlePayload(enabled, { ...snapshot, provider: 'soniox' }).original, 'new translation');
    assert.equal(desktopSubtitlePayload(enabled, { ...snapshot, provider: 'soniox' }).translation, '');
    assert.equal(desktopSubtitlePayload(enabled, { ...snapshot, provisionalText: '', sourceProvisionalText: '' }).translation, '旧句子');
});

test('Qwen provisional source/translation segments are filtered together', () => {
    const snapshot = { segments: [self, { ...peer, status: 'provisional' }], provider: 'qwen' };
    assert.equal(desktopSubtitlePayload(enabled, snapshot).original, self.original);
    assert.equal(desktopSubtitlePayload({ ...enabled, desktop_subtitle_speaker: 'peer' }, snapshot).translation, peer.translation);
});

test('controller coalesces pending snapshots and serializes IPC so the newest update wins', async () => {
    const first = deferred();
    const writes = [];
    const controller = new DesktopSubtitles({ invoke: async (command, { payload }) => {
        assert.equal(command, 'set_desktop_subtitle');
        writes.push(payload);
        if (writes.length === 1) await first.promise;
    } });
    const flushing = controller.configure(enabled);
    await tick();
    controller.update({ segments: [self] });
    controller.update({ segments: [self, { ...self, id: 'new', original: 'newest' }] });
    assert.equal(writes.length, 1);
    first.resolve();
    await flushing;
    assert.equal(writes.length, 2);
    assert.equal(writes.at(-1).original, 'newest');
    await controller.configure({ ...enabled, desktop_subtitle_content: 'translation' });
    assert.equal(writes.at(-1).original, '');
    assert.equal(writes.at(-1).translation, self.translation);
    await controller.configure({ ...enabled, desktop_subtitle_enabled: false });
    assert.equal(writes.at(-1).enabled, false);
});

test('an update in the native-write completion microtasks cannot be stranded', async () => {
    const writes = [];
    const controller = new DesktopSubtitles({ invoke: (_, { payload }) => {
        writes.push(payload);
        if (writes.length === 1) {
            queueMicrotask(() => queueMicrotask(() => controller.update({ segments: [self] })));
        }
    } });
    await controller.configure(enabled);
    await tick();
    assert.equal(writes.at(-1).original, self.original);
    assert.equal(writes.length, 2);
});

test('controller copies transcript state and clear removes old subtitles before another session', async () => {
    const writes = [];
    const controller = new DesktopSubtitles({ invoke: async (_, { payload }) => { writes.push(payload); } });
    await controller.configure(enabled);
    const segment = { ...self };
    await controller.update({ segments: [segment] });
    segment.original = 'unexpected mutation';
    await controller.configure({ ...enabled, desktop_subtitle_content: 'original' });
    assert.equal(writes.at(-1).original, self.original);
    await controller.clear();
    assert.deepEqual(writes.at(-1), { enabled: true, original: '', translation: '', speaker: '' });
});

test('failed native writes report once, retry identical snapshots and recover for later changes', async () => {
    const errors = [], writes = [];
    let failing = true;
    const controller = new DesktopSubtitles({ invoke: async (_, { payload }) => {
        writes.push(payload);
        if (failing) throw new Error('native unavailable');
    }, onError: error => errors.push(error) });
    await controller.configure(enabled);
    await controller.configure(enabled);
    assert.equal(writes.length, 2);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /native unavailable/);
    failing = false;
    await controller.configure(enabled);
    await controller.update({ segments: [self] });
    assert.equal(writes.at(-1).original, self.original);
    failing = true;
    await controller.clear();
    assert.equal(errors.length, 2);
});

function documentFixture() {
    const elements = new Map();
    const doc = { getElementById(id) {
        if (!elements.has(id)) elements.set(id, {
            textContent: '', hidden: false, classes: new Set(), events: {},
            classList: { toggle(key, value) { const classes = elements.get(id).classes; if (value) classes.add(key); else classes.delete(key); } },
            addEventListener(event, callback) { this.events[event] = callback; },
            set innerHTML(_) { throw new Error('Recognition text must not become HTML'); },
        });
        return elements.get(id);
    } };
    return { doc, element: id => doc.getElementById(id) };
}

test('native overlay renders speech as text and toggles the requested lines', () => {
    const f = documentFixture();
    renderDesktopSubtitle(f.doc, { original: '<img src=x onerror=alert(1)>', translation: '译文', speaker: '我' });
    assert.equal(f.element('subtitle-original').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(f.element('subtitle-lines').classes.has('bilingual'), true);
    assert.equal(f.element('subtitle-empty').hidden, true);
    renderDesktopSubtitle(f.doc, { translation: 'only translation' });
    assert.equal(f.element('subtitle-original').hidden, true);
    assert.equal(f.element('subtitle-translation').hidden, false);
    assert.equal(f.element('subtitle-lines').classes.has('bilingual'), false);
    renderDesktopSubtitle(f.doc, {});
    assert.equal(f.element('subtitle-empty').hidden, false);
});

test('native overlay subscribes before initial read and never replaces a newer push with stale cached text', async () => {
    const f = documentFixture(), initial = deferred(), calls = [];
    let onUpdate;
    const tauri = { core: { invoke: async command => {
        calls.push(command);
        if (command === 'get_desktop_subtitle') return initial.promise;
    } }, window: { getCurrentWindow: () => ({
        listen: async (_, callback) => { onUpdate = callback; },
        startDragging: async () => { calls.push('drag'); },
    }) } };
    const ready = initDesktopSubtitleWindow({ doc: f.doc, tauri });
    await tick();
    onUpdate({ payload: { original: 'newest' } });
    initial.resolve({ original: 'old cache' });
    await ready;
    assert.equal(f.element('subtitle-original').textContent, 'newest');
    f.element('subtitle-close').events.click();
    await tick();
    assert.equal(calls.at(-1), 'close_desktop_subtitle');
    f.element('desktop-subtitle').events.pointerdown({ button: 0, target: { closest: () => null } });
    await tick();
    assert.equal(calls.at(-1), 'drag');
    f.element('desktop-subtitle').events.pointerdown({ button: 0, target: { closest: () => ({}) } });
    await tick();
    assert.equal(calls.filter(call => call === 'drag').length, 1);
});
