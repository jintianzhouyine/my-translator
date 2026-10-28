import test from 'node:test';
import assert from 'node:assert/strict';
import { GlossaryImportUI } from '../src/js/glossary-import-ui.js';
import { parseGlossaryRows } from '../src/js/glossary-import.js';
import { QwenSettingsUI, parseQwenGlossary, formatQwenGlossary } from '../src/js/qwen-settings.js';

class Element {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.listeners = new Map();
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.hidden = false;
        this.open = false;
        this.style = {};
        this.clicks = 0;
        this.modalOpens = 0;
        this._text = '';
    }
    get options() { return this.children; }
    get textContent() { return this._text; }
    set textContent(value) { this._text = String(value); this.children = []; }
    set innerHTML(_) { throw new Error('Untrusted glossary text must never be assigned to innerHTML'); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; this.value = ''; }
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }
    emit(type, data = {}) {
        const event = { target: this, defaultPrevented: false, propagationStopped: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() { this.propagationStopped = true; }, ...data };
        for (const listener of this.listeners.get(type) || []) listener(event);
        return event;
    }
    click() { if (!this.disabled) { this.clicks++; this.emit('click'); } }
    showModal() { this.open = true; this.modalOpens++; }
    close() { this.open = false; }
}

function fakeDocument() {
    const elements = new Map();
    const document = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, new Element());
            return elements.get(id);
        },
        createElement: tag => new Element(tag),
        querySelectorAll: () => [],
    };
    return document;
}

function file(name, text, overrides = {}) {
    const bytes = new TextEncoder().encode(text);
    return { name, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer, ...overrides };
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function fixture({ outbound = '原有 = Original', inbound = 'Original = 原有', openWorkbook } = {}) {
    const document = fakeDocument();
    const el = id => document.getElementById(id);
    const errors = [];
    el('input-qwen-glossary-outbound').value = outbound;
    el('input-qwen-glossary-inbound').value = inbound;
    el('btn-qwen-import-apply').disabled = true;
    const ui = new GlossaryImportUI({ document, parseExisting: parseQwenGlossary, format: formatQwenGlossary,
        onError: error => errors.push(error), ...(openWorkbook ? { openWorkbook } : {}) });
    ui.init();
    return { ui, document, el, errors,
        glossary: direction => parseQwenGlossary(el(`input-qwen-glossary-${direction}`).value) };
}

for (const direction of ['outbound', 'inbound']) {
    test(`native file input imports only the ${direction} textarea after explicit confirmation`, async t => {
        let requests = 0;
        t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('Network not expected'); });
        const f = fixture();
        const before = { outbound: f.glossary('outbound'), inbound: f.glossary('inbound') };
        const other = direction === 'outbound' ? 'inbound' : 'outbound';
        let loading;
        const loadFile = f.ui.loadFile.bind(f.ui);
        f.ui.loadFile = (...args) => { loading = loadFile(...args); return loading; };
        f.el(`btn-qwen-import-${direction}`).click();
        assert.equal(f.el('input-qwen-glossary-file').clicks, 1);
        f.el('input-qwen-glossary-file').files = [file('terms.txt', '产品 = Product')];
        f.el('input-qwen-glossary-file').emit('change');
        await loading;
        assert.equal(f.el('qwen-import-dialog').open, true);
        assert.deepEqual(f.glossary(direction), before[direction], 'preview cannot edit the form');
        assert.deepEqual(f.glossary(other), before[other]);
        f.el('btn-qwen-import-apply').click();
        assert.deepEqual(f.glossary(direction), { ...before[direction], 产品: 'Product' });
        assert.deepEqual(f.glossary(other), before[other], 'opposite-direction dictionary stays unchanged');
        assert.equal(f.el('qwen-import-dialog').open, false);
        assert.match(f.el('qwen-glossary-import-status').textContent, /保存并关闭/);
        assert.equal(requests, 0, 'import confirmation never contacts the translation API');
    });
}

test('merge preview supports keeping or overwriting conflicts, and replacement removes old entries', async () => {
    const f = fixture({ outbound: '原有 = Original\n共享 = Old' });
    await f.ui.loadFile(file('terms.txt', '共享 = New\n新增 = Added'), 'outbound');
    assert.deepEqual(f.ui.pending.plan.glossary, { 原有: 'Original', 共享: 'Old', 新增: 'Added' });
    assert.match(f.el('qwen-import-summary').textContent, /同名词有 1 条译法不同/);
    const kept = f.el('qwen-import-preview-body').children[0];
    assert.equal(kept.children[2].textContent, '保留现有译法');
    assert.equal(kept.title, '文件中的译法：New');
    f.el('select-qwen-import-conflicts').value = 'overwrite';
    f.el('select-qwen-import-conflicts').emit('change');
    assert.deepEqual(f.ui.pending.plan.glossary, { 原有: 'Original', 共享: 'New', 新增: 'Added' });
    assert.match(f.el('qwen-import-summary').textContent, /更新 1 条/);
    f.el('select-qwen-import-mode').value = 'replace';
    f.el('select-qwen-import-mode').emit('change');
    assert.equal(f.el('qwen-import-conflicts-field').hidden, true);
    assert.deepEqual(f.ui.pending.plan.glossary, { 共享: 'New', 新增: 'Added' });
    assert.deepEqual(f.glossary('outbound'), { 原有: 'Original', 共享: 'Old' });
    f.el('btn-qwen-import-apply').click();
    assert.deepEqual(f.glossary('outbound'), { 共享: 'New', 新增: 'Added' });
});

for (const conflicts of ['keep', 'overwrite']) {
    test(`confirmed merge uses ${conflicts} conflict handling and retains unrelated existing entries`, async () => {
        const f = fixture({ outbound: '保留词 = Retained\n共享 = Old' });
        await f.ui.loadFile(file('terms.txt', '共享 = New\n新增 = Added'), 'outbound');
        f.el('select-qwen-import-conflicts').value = conflicts;
        f.el('select-qwen-import-conflicts').emit('change');
        f.el('btn-qwen-import-apply').click();
        assert.deepEqual(f.glossary('outbound'), { 保留词: 'Retained', 共享: conflicts === 'keep' ? 'Old' : 'New', 新增: 'Added' });
        assert.deepEqual(f.glossary('inbound'), { Original: '原有' });
    });
}

test('reverse changes only the selected import and resets for the next file', async () => {
    const f = fixture();
    await f.ui.loadFile(file('terms.csv', 'source,target\n产品,Product'), 'inbound');
    f.el('check-qwen-import-reverse').checked = true;
    f.el('check-qwen-import-reverse').emit('change');
    assert.deepEqual(f.ui.pending.plan.glossary, { Original: '原有', Product: '产品' });
    f.el('btn-qwen-import-apply').click();
    assert.deepEqual(f.glossary('outbound'), { 原有: 'Original' });
    assert.deepEqual(f.glossary('inbound'), { Original: '原有', Product: '产品' });
    await f.ui.loadFile(file('next.txt', '下一词 = Next'), 'outbound');
    assert.equal(f.el('check-qwen-import-reverse').checked, false);
    assert.deepEqual(f.ui.pending.plan.glossary, { 原有: 'Original', 下一词: 'Next' });
});

test('cancel and Escape leave the dictionaries untouched and dialog shortcuts cannot reach the app', async () => {
    const f = fixture();
    const original = f.el('input-qwen-glossary-outbound').value;
    await f.ui.loadFile(file('terms.txt', '产品 = Product'), 'outbound');
    f.el('btn-qwen-import-cancel').click();
    assert.equal(f.ui.pending, null);
    assert.equal(f.el('qwen-import-dialog').open, false);
    assert.equal(f.el('input-qwen-glossary-outbound').value, original);
    await f.ui.loadFile(file('terms.txt', '产品 = Product'), 'outbound');
    const key = f.el('qwen-import-dialog').emit('keydown', { key: 'Enter' });
    assert.equal(key.propagationStopped, true);
    const escape = f.el('qwen-import-dialog').emit('cancel');
    assert.equal(escape.defaultPrevented, true);
    assert.equal(f.el('qwen-import-dialog').open, false);
    assert.equal(f.el('input-qwen-glossary-outbound').value, original);
});

test('unsupported, oversized and unreadable files preserve the original dictionaries', async () => {
    const cases = [
        [file('legacy.xls', '', { arrayBuffer: () => assert.fail('unsupported file must not be read') }), /旧版 .xls/],
        [file('large.csv', '', { size: 2 * 1024 * 1024 + 1, arrayBuffer: () => assert.fail('large file must not be read') }), /2 MiB/],
        [file('large.txt', '', { size: 1, arrayBuffer: async () => new ArrayBuffer(2 * 1024 * 1024 + 1) }), /2 MiB/],
        [file('unreadable.txt', '', { arrayBuffer: async () => { throw new Error('文件已被移动'); } }), /文件已被移动/],
        [file('invalid.txt', '没有分隔符'), /原词 = 译法/],
    ];
    for (const [input, message] of cases) {
        const f = fixture();
        await f.ui.loadFile(input, 'outbound');
        assert.equal(f.ui.pending, null);
        assert.equal(f.el('qwen-import-dialog').open, false);
        assert.match(f.errors[0], message);
        assert.deepEqual(f.glossary('outbound'), { 原有: 'Original' });
        assert.deepEqual(f.glossary('inbound'), { Original: '原有' });
    }
});

test('cancelling an async read prevents both a late preview and a late read error from reappearing', async () => {
    for (const reject of [false, true]) {
        const f = fixture();
        const reading = deferred();
        const loading = f.ui.loadFile(file('slow.txt', '', { arrayBuffer: () => reading.promise }), 'outbound');
        f.ui.reset();
        if (reject) reading.reject(new Error('late error'));
        else reading.resolve(new TextEncoder().encode('产品 = Product').buffer);
        await loading;
        assert.equal(f.el('qwen-import-dialog').modalOpens, 0);
        assert.equal(f.ui.pending, null);
        assert.equal(f.errors.length, 0);
        assert.equal(f.el('qwen-glossary-import-status').textContent, '');
        assert.deepEqual(f.glossary('outbound'), { 原有: 'Original' });
    }
});

test('a newer file wins over an older asynchronous read', async () => {
    const f = fixture();
    const reading = deferred();
    const old = f.ui.loadFile(file('old.txt', '', { arrayBuffer: () => reading.promise }), 'outbound');
    await f.ui.loadFile(file('new.txt', '新词 = New'), 'inbound');
    reading.resolve(new TextEncoder().encode('旧词 = Old').buffer);
    await old;
    assert.equal(f.ui.pending.name, 'new.txt');
    assert.equal(f.ui.pending.direction, 'inbound');
    assert.equal(f.el('qwen-import-dialog').modalOpens, 1);
    f.el('btn-qwen-import-apply').click();
    assert.deepEqual(f.glossary('inbound'), { Original: '原有', 新词: 'New' });
    assert.deepEqual(f.glossary('outbound'), { 原有: 'Original' });
});

test('applying new saved Qwen settings cancels an in-flight import without sending or saving anything', async () => {
    const document = fakeDocument();
    let nativeCalls = 0;
    const settingsUI = new QwenSettingsUI({ document, invoke: async () => { nativeCalls++; } });
    settingsUI.apply({ qwen_glossary_outbound: { 原有: 'Original' } });
    const reading = deferred();
    const loading = settingsUI.glossaryImporter.loadFile(file('slow.txt', '', { arrayBuffer: () => reading.promise }), 'outbound');
    settingsUI.apply({ qwen_glossary_outbound: { 最新: 'Latest' } });
    reading.resolve(new TextEncoder().encode('旧词 = Old').buffer);
    await loading;
    assert.equal(document.getElementById('qwen-import-dialog').modalOpens, 0);
    assert.deepEqual(parseQwenGlossary(document.getElementById('input-qwen-glossary-outbound').value), { 最新: 'Latest' });
    assert.equal(document.getElementById('qwen-glossary-import-status').textContent, '');
    assert.equal(nativeCalls, 0);
});

test('editing the target textarea after preview requires reviewing the refreshed plan before applying', async () => {
    const f = fixture();
    await f.ui.loadFile(file('terms.txt', '产品 = Product'), 'outbound');
    f.el('input-qwen-glossary-outbound').value = '用户修改 = UserEdit';
    f.el('btn-qwen-import-apply').click();
    assert.equal(f.el('qwen-import-dialog').open, true);
    assert.deepEqual(f.glossary('outbound'), { 用户修改: 'UserEdit' });
    assert.match(f.el('qwen-import-error').textContent, /预览已刷新/);
    assert.deepEqual(f.ui.pending.plan.glossary, { 用户修改: 'UserEdit', 产品: 'Product' });
    f.el('btn-qwen-import-apply').click();
    assert.deepEqual(f.glossary('outbound'), { 用户修改: 'UserEdit', 产品: 'Product' });
    assert.equal(f.el('qwen-import-dialog').open, false);
});

test('an invalid first worksheet keeps the workbook available so another worksheet can be imported', async () => {
    const parsedSheets = [];
    const f = fixture({ openWorkbook: bytes => {
        assert.ok(bytes instanceof Uint8Array);
        return { sheetNames: ['坏工作表', '好工作表'], parseSheet(name) {
            parsedSheets.push(name);
            if (name === '坏工作表') throw new Error('坏工作表第 2 行缺少译法');
            return parseGlossaryRows([['原词', '译法'], ['产品', 'Product']]);
        } };
    } });
    await f.ui.loadFile(file('terms.xlsx', 'test bytes'), 'outbound');
    assert.equal(f.el('qwen-import-dialog').open, true);
    assert.equal(f.el('qwen-import-sheet-field').hidden, false);
    assert.equal(f.el('btn-qwen-import-apply').disabled, true);
    assert.match(f.el('qwen-import-error').textContent, /第 2 行缺少译法/);
    assert.deepEqual(f.el('select-qwen-import-sheet').options.map(option => option.value), ['坏工作表', '好工作表']);
    f.el('select-qwen-import-sheet').value = '好工作表';
    f.el('select-qwen-import-sheet').emit('change');
    assert.deepEqual(parsedSheets, ['坏工作表', '好工作表']);
    assert.equal(f.el('btn-qwen-import-apply').disabled, false);
    assert.equal(f.el('qwen-import-error').textContent, '');
    f.el('btn-qwen-import-apply').click();
    assert.deepEqual(f.glossary('outbound'), { 原有: 'Original', 产品: 'Product' });
});

test('HTML-looking terms and filenames appear as literal text, never HTML nodes', async () => {
    const f = fixture();
    const source = '<img src=x onerror=alert(1)>';
    // Equals signs are valid in targets; sources deliberately exclude them.
    const safeSource = '<script>alert(1)</script>';
    await f.ui.loadFile(file('<img>.json', JSON.stringify({ [safeSource]: source })), 'outbound');
    assert.equal(f.el('qwen-import-file-name').textContent, '<img>.json');
    const row = f.el('qwen-import-preview-body').children[0];
    assert.equal(row.tagName, 'TR');
    assert.deepEqual(row.children.map(cell => cell.tagName), ['TD', 'TD', 'TD']);
    assert.equal(row.children[0].textContent, safeSource);
    assert.equal(row.children[1].textContent, source);
    assert.equal(row.children[0].children.length, 0);
    assert.equal(row.children[1].children.length, 0);
    assert.equal(f.errors.length, 0);
});

test('a merge over 1,000 entries disables confirmation but a valid replacement can proceed', async () => {
    const existing = Array.from({ length: 1000 }, (_, i) => `词${i} = Term${i}`).join('\n');
    const f = fixture({ outbound: existing });
    await f.ui.loadFile(file('one-more.txt', '额外 = Extra'), 'outbound');
    assert.equal(f.el('qwen-import-dialog').open, true);
    assert.equal(f.el('btn-qwen-import-apply').disabled, true);
    assert.equal(f.ui.pending.plan, null);
    assert.match(f.el('qwen-import-error').textContent, /超过 1,000 条/);
    f.ui.apply();
    assert.equal(f.el('input-qwen-glossary-outbound').value, existing);
    f.el('select-qwen-import-mode').value = 'replace';
    f.el('select-qwen-import-mode').emit('change');
    assert.equal(f.el('btn-qwen-import-apply').disabled, false);
    f.el('btn-qwen-import-apply').click();
    assert.deepEqual(f.glossary('outbound'), { 额外: 'Extra' });
});

test('the preview displays only 20 rows while confirmation imports the complete valid plan', async () => {
    const f = fixture({ outbound: '' });
    const terms = Array.from({ length: 21 }, (_, i) => `词${i} = Term${i}`).join('\n');
    await f.ui.loadFile(file('terms.txt', terms), 'outbound');
    assert.equal(f.el('qwen-import-preview-body').children.length, 20);
    assert.match(f.el('qwen-import-preview-hint').textContent, /前 20 条.*全部 21 条/);
    f.el('btn-qwen-import-apply').click();
    assert.equal(Object.keys(f.glossary('outbound')).length, 21);
    assert.equal(f.glossary('outbound')['词20'], 'Term20');
});
