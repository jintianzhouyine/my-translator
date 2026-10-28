import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptUI } from '../src/js/ui.js';

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
