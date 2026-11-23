import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptUI } from '../src/js/ui.js';
import { desktopSubtitlePayload } from '../src/js/desktop-subtitles.js';

globalThis.window = { __TAURI__: { core: { invoke: async () => {} } } };
const { SessionStore } = await import('../src/js/session-store.js');

test('interleaved directions and late source corrections update their own rows and persisted segments', () => {
    const ui = new TranscriptUI({});
    ui._render = () => {};
    ui._removeListening = () => {};
    const store = new SessionStore();
    store.init({ engine: 'qwen', sourceLang: 'en', targetLang: 'zh' });
    store.beginChunk();
    ui.upsertQwenSegment({ id: 'in:1', direction: 'inbound', translation: '你好' });
    ui.upsertQwenSegment({ id: 'out:1', direction: 'outbound', translation: 'Hello' });
    assert.equal(ui.sessionLog.length, 0, 'provisionals are not saved as final');
    const update = (id, source, target, direction) => {
        ui.upsertQwenSegment({ id, direction, original: source, translation: target, isFinal: true });
        store.upsertSegment(id, source, target, { direction });
    };
    update('out:1', '你好', 'Hello', 'outbound');
    update('in:1', '', '你好', 'inbound');
    update('in:1', 'Hello there', '你好', 'inbound');
    update('in:1', 'Hello there', '你好', 'inbound');
    assert.equal(ui.segments.length, 2);
    assert.equal(ui.sessionLog.length, 2);
    assert.equal(store.currentChunk.segments.length, 2);
    assert.equal(ui.segments.find(s => s.id === 'in:1').original, 'Hello there');
    assert.equal(store.currentChunk.segments.find(s => s.id === 'out:1').src, '你好');
    assert.match(store._toMarkdown(), /我 → 对方/);
    assert.match(store._toMarkdown(), /对方 → 我/);
    // A correction to a row outside the display window updates history without resurrecting it.
    ui.segments = ui.segments.filter(s => s.id !== 'in:1');
    update('in:1', 'Hello!', '你好', 'inbound');
    assert.equal(ui.segments.length, 1);
    assert.equal(ui.sessionLog.find(s => s.id === 'in:1').original, 'Hello!');
    ui.upsertQwenSegment({ id: 'out:pending', direction: 'outbound', translation: 'unfinished' });
    ui.clearProvisional();
    assert.equal(ui.segments.length, 1);
    assert.equal(ui.sessionLog.length, 2);
    store.endChunk();
});

test('transcript change notifications retain both texts independently of main-window display settings', () => {
    globalThis.document = { getElementById: () => null };
    const ui = new TranscriptUI({ innerHTML: '', style: { setProperty() {} } });
    ui._ensureContent = () => {};
    ui._removeListening = () => {};
    ui._renderSingle = () => {};
    const snapshots = [];
    ui.onChange = snapshot => snapshots.push(snapshot);
    ui.provider = 'qwen';
    ui.configure({ showOriginal: false });
    ui.upsertQwenSegment({ id: 'out:1', direction: 'outbound', original: '你好', translation: 'Hello' });
    const provisional = snapshots.at(-1);
    assert.equal(provisional.provider, 'qwen');
    assert.equal(provisional.segments[0].original, '你好');
    assert.equal(provisional.segments[0].translation, 'Hello');
    assert.equal(provisional.segments[0].direction, 'outbound');
    assert.notEqual(provisional.segments[0], ui.segments[0], 'subscribers must not receive mutable transcript entries');
    ui.upsertQwenSegment({ id: 'out:1', direction: 'outbound', original: '你好啊', translation: 'Hello there', isFinal: true });
    assert.equal(snapshots.at(-1).segments[0].status, 'translated');
    assert.equal(provisional.segments[0].translation, 'Hello');
    ui.clear();
    assert.equal(snapshots.at(-1).segments.length, 0);
    assert.equal(snapshots.at(-1).provisionalText, '');
});

test('source and target provisional changes and clearing are forwarded to desktop consumers', () => {
    globalThis.document = { getElementById: () => null };
    const ui = new TranscriptUI({ innerHTML: '', style: { setProperty() {} } });
    ui._ensureContent = () => {};
    ui._removeListening = () => {};
    ui._renderSingle = () => {};
    const snapshots = [];
    ui.onChange = snapshot => snapshots.push(structuredClone(snapshot));
    ui.provider = 'openai';
    ui.setSourceProvisional('说话中');
    ui.setProvisional('Speaking');
    assert.equal(snapshots.at(-1).sourceProvisionalText, '说话中');
    assert.equal(snapshots.at(-1).provisionalText, 'Speaking');
    ui.clearProvisional();
    assert.equal(snapshots.at(-1).sourceProvisionalText, '');
    assert.equal(snapshots.at(-1).provisionalText, '');
});

test('switching capture source retains each sentence identity when desktop subtitles filter speakers', () => {
    globalThis.document = { getElementById: () => null };
    const ui = new TranscriptUI({ innerHTML: '', style: { setProperty() {} } });
    ui._ensureContent = () => {};
    ui._removeListening = () => {};
    ui._renderSingle = () => {};
    let snapshot;
    ui.onChange = value => { snapshot = value; };
    ui.audioSource = 'system';
    ui.addOriginal('Peer words');
    ui.addTranslation('对方的话');
    ui.audioSource = 'microphone';
    ui.addOriginal('我的话');
    ui.addTranslation('My words');
    assert.equal(snapshot.audioSource, 'microphone');
    assert.equal(snapshot.segments[0].audioSource, 'system');
    assert.equal(snapshot.segments[1].audioSource, 'microphone');
    const settings = { desktop_subtitle_enabled: true, desktop_subtitle_content: 'both' };
    const peer = desktopSubtitlePayload({ ...settings, desktop_subtitle_speaker: 'peer' }, snapshot);
    const self = desktopSubtitlePayload({ ...settings, desktop_subtitle_speaker: 'self' }, snapshot);
    assert.equal(peer.original, 'Peer words');
    assert.equal(peer.speaker, '对方');
    assert.equal(self.original, '我的话');
    assert.equal(self.speaker, '我');
});
