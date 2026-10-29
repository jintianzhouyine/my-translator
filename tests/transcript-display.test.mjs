import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptUI } from '../src/js/ui.js';
import { QwenTranscriptAssembler } from '../src/js/qwen-realtime-client.js';

const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
class Element {
    constructor() {
        this.innerHTML = '';
        this.children = [];
        this.scrollHeight = this.clientHeight = 100;
        this.scrollTop = 0;
        this.style = { setProperty() {} };
        this.classes = new Set();
        this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    }
    set textContent(value) { this.innerHTML = escape(value); }
    appendChild(child) { this.children.push(child); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
}
function fixture(provider = 'qwen') {
    const overlay = new Element();
    globalThis.document = { createElement: () => new Element(), getElementById: () => overlay };
    const ui = new TranscriptUI(new Element());
    ui.provider = provider;
    return { ui, overlay, html: () => ui.contentEl?.innerHTML || '' };
}

test('bilingual single view pairs escaped source and target; switching content retains both texts in history', () => {
    const f = fixture('soniox');
    f.ui.addOriginal('Hello <script>');
    f.ui.addTranslation('你好 <script>');
    assert.match(f.html(), /seg-original">Hello &lt;script&gt;/);
    assert.match(f.html(), /seg-translated">你好 &lt;script&gt;/);
    f.ui.configure({ showOriginal: false });
    assert.doesNotMatch(f.html(), /Hello|seg-original/);
    assert.match(f.html(), /你好/);
    assert.equal(f.ui.sessionLog[0].original, 'Hello <script>');
    f.ui.configure({ showOriginal: true });
    assert.match(f.html(), /Hello/);
    assert.equal(f.ui.sessionLog.length, 1);
});

test('hiding originals collapses dual view and restoring bilingual content preserves the chosen layout', () => {
    const f = fixture();
    f.ui.upsertQwenSegment({ id: 'one', original: 'hello', translation: '你好', isFinal: true });
    f.ui.configure({ viewMode: 'dual' });
    assert.equal(f.overlay.classes.has('dual-view'), true);
    assert.match(f.html(), /panel-source/);
    f.ui.configure({ showOriginal: false });
    assert.equal(f.ui.viewMode, 'dual');
    assert.equal(f.overlay.classes.has('dual-view'), false);
    assert.doesNotMatch(f.html(), /panel-source|hello/);
    assert.match(f.html(), /你好/);
    f.ui.configure({ showOriginal: true });
    assert.equal(f.overlay.classes.has('dual-view'), true);
    assert.match(f.html(), /panel-source.*hello/);
});

test('Qwen delayed ASR fills the correct bilingual row without duplicating or fabricating source', () => {
    const f = fixture();
    const assembler = new QwenTranscriptAssembler({
        onProvisional: (translation, meta) => f.ui.upsertQwenSegment({ id: meta.itemId, original: meta.sourceText, translation }),
        onSegment: (original, translation, meta) => f.ui.upsertQwenSegment({ id: meta.itemId, original, translation, isFinal: true }),
    });
    assembler.handle({ type: 'conversation.item.created', item: { id: 'target1', role: 'assistant' }, previous_item_id: 'source1' });
    assembler.handle({ type: 'response.text.done', item_id: 'target1', text: '你好' });
    assert.match(f.html(), /等待原文/);
    assert.equal(f.ui.segments[0].original, '');
    assembler.handle({ type: 'conversation.item.created', item: { id: 'target2', role: 'assistant' }, previous_item_id: 'source2' });
    assembler.handle({ type: 'response.text.done', item_id: 'target2', text: '再见' });
    assembler.handle({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'source2', transcript: 'Goodbye' });
    assembler.handle({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'source1', delta: 'Hel' });
    assert.equal(f.ui.segments.find(s => s.id === 'target1').original, 'Hel');
    assembler.handle({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'source1', transcript: 'Hello' });
    assert.equal(f.ui.segments.length, 2);
    assert.equal(f.ui.sessionLog.length, 2);
    assert.match(f.html(), /seg-original">Hello<\/div><div class="seg-translated">你好/);
    assert.match(f.html(), /seg-original">Goodbye<\/div><div class="seg-translated">再见/);
    assert.doesNotMatch(f.html(), /等待原文/);
});

test('source-only provisional is visible only in bilingual mode and cannot leak across clearing the transcript', () => {
    const f = fixture('openai');
    f.ui.setSourceProvisional('source first');
    assert.ok(f.ui.hasContent());
    assert.match(f.html(), /source first/);
    f.ui.configure({ showOriginal: false });
    assert.doesNotMatch(f.html(), /source first/);
    f.ui.setProvisional('target later');
    assert.match(f.html(), /seg-translated">target later/);
    f.ui.configure({ showOriginal: true });
    assert.match(f.html(), /source first/);
    f.ui.clear();
    f.ui.setProvisional('next target');
    assert.doesNotMatch(f.html(), /source first/);
    f.ui.setSourceProvisional('another source');
    f.ui.showPlaceholder();
    f.ui.setProvisional('third target');
    assert.doesNotMatch(f.html(), /another source/);
});

test('translation-only mode hides Soniox pending source and still renders the completed translation', () => {
    const f = fixture('soniox');
    f.ui.configure({ showOriginal: false });
    f.ui.setProvisional('recognizing source');
    assert.doesNotMatch(f.html(), /recognizing source/);
    f.ui.addOriginal('final source');
    assert.doesNotMatch(f.html(), /final source/);
    f.ui.clearProvisional();
    f.ui.addTranslation('译文');
    assert.match(f.html(), /译文/);
    assert.doesNotMatch(f.html(), /final source/);
});
