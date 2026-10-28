import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeGlossaryBytes, parseGlossaryFile, parseGlossaryRows, planGlossaryImport } from '../src/js/glossary-import.js';

const values = parsed => parsed.entries.map(({ source, target }) => [source, target]);

test('CSV handles BOM, CRLF, quoted commas, escaped quotes and optional headers', () => {
    const parsed = parseGlossaryFile('\uFEFF\r\nsource,target\r\n"Acme, Inc.","艾克米，有限公司"\r\n"The ""Project""", 项目 \r\n', 'terms.CSV');
    assert.deepEqual(values(parsed), [['Acme, Inc.', '艾克米，有限公司'], ['The "Project"', '项目']]);
    assert.deepEqual(parsed.entries.map(e => e.line), [3, 4]);
    assert.equal(parsed.duplicates, 0);
    assert.deepEqual(values(parseGlossaryFile('原词,译法\n品牌,Brand', '词表.csv')), [['品牌', 'Brand']]);
});

test('TSV and TXT preserve target equals signs and do not guess a different delimiter', () => {
    assert.deepEqual(values(parseGlossaryFile('Source\tTarget\n函数\t"x = y"\r商品\tItem', 'terms.tsv')), [['函数', 'x = y'], ['商品', 'Item']]);
    assert.deepEqual(values(parseGlossaryFile('\n 函数 = x = y\r\n品牌=Brand\n', 'terms.txt')), [['函数', 'x = y'], ['品牌', 'Brand']]);
    assert.throws(() => parseGlossaryFile('a\tb', 'terms.csv'), /第 1 行.*两列/);
    assert.throws(() => parseGlossaryFile('valid = 正确\nmissing separator', 'terms.txt'), /第 2 行.*格式/);
});

test('CSV errors retain physical line numbers and never drop malformed or empty fields', () => {
    const bad = [
        ['a,b\n,c', /第 2 行.*不能为空/],
        ['a,b\n"unfinished,c', /第 2 行.*未闭合/],
        ['a,b\n"two\nlines",c', /第 2 行.*换行/],
        ['a,b\n"name"suffix,c', /第 2 行.*双引号/],
        ['a,b\nna"me,c', /第 2 行.*双引号/],
        ['a,b\nname,target,note', /第 2 行.*两列/],
        ['a,b\n"",target', /第 2 行.*不能为空/],
        ['a,b\n"a=b",target', /第 2 行.*不能包含/],
        ['a,b\nname,"line\u2028break"', /第 2 行.*换行/],
    ];
    for (const [text, message] of bad) assert.throws(() => parseGlossaryFile(text, 'terms.csv'), message);
    assert.throws(() => parseGlossaryFile('\t', 'terms.tsv'), /第 1 行.*不能为空/);
    assert.throws(() => parseGlossaryFile(',', 'terms.csv'), /第 1 行.*不能为空/);
});

test('identical terms are deduplicated and conflicting translations report both source lines', () => {
    const parsed = parseGlossaryFile('产品 = Product\n 产品 = Product \nother = 其他\n产品 = Product', 'terms.txt');
    assert.equal(parsed.duplicates, 2);
    assert.equal(parsed.entries.length, 2);
    assert.throws(() => parseGlossaryFile('原词,译法\n产品,Product\n产品,Thing', 'terms.csv'), /第 3 行.*第 2 行冲突/);
});

test('JSON object and array formats preserve Unicode, escapes and line metadata', () => {
    assert.deepEqual(values(parseGlossaryFile('{"产品":"Product", "引号\\\"":"Quote", "公式":"x=y"}', 'terms.json')),
        [['产品', 'Product'], ['引号"', 'Quote'], ['公式', 'x=y']]);
    const parsed = parseGlossaryFile('[\r\n  {"target":"Product", "source":"产品"},\r\n  {"source":"品牌", "target":"Brand"}\r\n]', 'terms.json');
    assert.deepEqual(values(parsed), [['产品', 'Product'], ['品牌', 'Brand']]);
    assert.deepEqual(parsed.entries.map(e => e.line), [2, 3]);
});

test('JSON duplicate object keys are checked before they can be silently overwritten', () => {
    const parsed = parseGlossaryFile('{\n "产品":"Product",\n "\\u4ea7品":"Product"\n}', 'terms.json');
    assert.equal(parsed.duplicates, 1);
    assert.throws(() => parseGlossaryFile('{\n "产品":"Product",\n "产品":"Thing"\n}', 'terms.json'), /第 3 行.*第 2 行冲突/);
    assert.throws(() => parseGlossaryFile('[{"source":"a", "source":"b", "target":"c"}]', 'terms.json'), /第 1 行.*重复/);
});

test('JSON rejects wrong shapes, non-string values, malformed syntax and escaped cell newlines', () => {
    for (const text of ['null', '"a"', '[1]', '{"a":2}', '{"a":null}', '{"a":true}', '{"a":{}}',
        '[{"source":"a"}]', '[{"source":"a","target":"b","note":"extra"}]', '{"a":"b",}',
        '[{"source":"a","target":"b"},]', '{"a":"b"} trailing', '{"a":"\\q"}', '{"a":"unterminated']) {
        assert.throws(() => parseGlossaryFile(text, 'terms.json'), /第 \d+ 行/);
    }
    assert.throws(() => parseGlossaryFile('{\n "a":"line\\nbreak"\n}', 'terms.json'), /第 2 行.*换行/);
    assert.throws(() => parseGlossaryFile('[\n {"source":"a=b","target":"c"}\n]', 'terms.json'), /第 2 行.*不能包含/);
});

test('empty and header-only files are rejected rather than producing a destructive empty replacement', () => {
    for (const [text, name] of [['', 'a.txt'], ['\n \r\n', 'a.txt'], ['source,target\r\n', 'a.csv'], ['{}', 'a.json'], ['[]', 'a.json']]) {
        assert.throws(() => parseGlossaryFile(text, name), /第 1 行.*没有可导入/);
    }
    assert.throws(() => parseGlossaryFile('a=b', 'a.exe'), /仅支持/);
});

test('spreadsheet rows preserve row numbers and accept trailing notes while validating term cells', () => {
    const parsed = parseGlossaryRows([[], ['原词', '译法', '备注'], ['产品', 'Product', 'for sales'], [], ['品牌', 'Brand']]);
    assert.deepEqual(values(parsed), [['产品', 'Product'], ['品牌', 'Brand']]);
    assert.deepEqual(parsed.entries.map(e => e.line), [3, 5]);
    assert.throws(() => parseGlossaryRows([[], ['a', 'b'], ['', '', 'note']]), /Excel词表第 3 行.*不能为空/);
    assert.throws(() => parseGlossaryRows([['a', 12]]), /第 1 行.*文本/);
    assert.throws(() => parseGlossaryRows([['a\nb', 'c']]), /第 1 行.*换行/);
    assert.throws(() => parseGlossaryRows([['a', 'b'], ['a', 'c']], '产品表'), /产品表第 2 行.*第 1 行冲突/);
    assert.throws(() => parseGlossaryRows([]), /没有可导入/);
});

test('strict decoding supports UTF-8 and BOM-marked UTF-16 without reading outside a supplied byte view', () => {
    const text = '产品 = Product';
    assert.equal(decodeGlossaryBytes(new TextEncoder().encode('\uFEFF' + text)), text);
    const le = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]);
    assert.equal(decodeGlossaryBytes(le), text);
    const be = Buffer.from(le);
    be.swap16();
    assert.equal(decodeGlossaryBytes(be), text);
    const padded = new Uint8Array([0xFF, 0x61, 0x3D, 0x62, 0xFF]);
    assert.equal(decodeGlossaryBytes(padded.subarray(1, 4)), 'a=b');
    assert.equal(decodeGlossaryBytes(new DataView(padded.buffer, 1, 3)), 'a=b');
    assert.throws(() => decodeGlossaryBytes(new Uint8Array([0xC3, 0x28])), /编码无效/);
    assert.throws(() => decodeGlossaryBytes(new Uint8Array([0xFF, 0xFE, 0x61])), /编码无效/);
    assert.throws(() => decodeGlossaryBytes(new Uint8Array([0xFF, 0xFE, 0x00, 0xD8])), /编码无效/);
});

test('merge preview keeps existing translations by default and reports actual plus incoming values', () => {
    const existing = Object.freeze({ a: 'old', same: 'same', untouched: '保留' });
    const parsed = parseGlossaryFile('a=new\nsame=same\nadded=新增', 'terms.txt');
    const snapshot = structuredClone(parsed);
    const plan = planGlossaryImport(existing, parsed);
    assert.deepEqual(plan.glossary, { a: 'old', same: 'same', untouched: '保留', added: '新增' });
    assert.deepEqual([plan.added, plan.updated, plan.unchanged, plan.conflicts, plan.total], [1, 0, 2, 1, 4]);
    assert.deepEqual(plan.entries[0], { source: 'a', target: 'old', incomingTarget: 'new', status: 'kept' });
    assert.deepEqual(plan.entries.map(e => e.status), ['kept', 'unchanged', 'added']);
    assert.deepEqual(parsed, snapshot);
});

test('overwrite and replace plans are explicit and leave unrelated source dictionaries untouched', () => {
    const existing = Object.freeze({ a: 'old', unchanged: 'keep' });
    const incoming = parseGlossaryFile('a=new\nb=added', 'terms.txt');
    const overwritten = planGlossaryImport(existing, incoming, { conflicts: 'overwrite' });
    assert.deepEqual(overwritten.glossary, { a: 'new', unchanged: 'keep', b: 'added' });
    assert.deepEqual([overwritten.added, overwritten.updated, overwritten.conflicts], [1, 1, 1]);
    const replaced = planGlossaryImport(existing, incoming, { mode: 'replace' });
    assert.deepEqual(replaced.glossary, { a: 'new', b: 'added' });
    assert.deepEqual([replaced.added, replaced.updated, replaced.unchanged, replaced.conflicts, replaced.total], [2, 0, 0, 0, 2]);
    assert.deepEqual(existing, { a: 'old', unchanged: 'keep' });
});

test('reversal affects only the proposed import and refuses ambiguous or unrepresentable reversed sources', () => {
    const incoming = parseGlossaryFile('产品=Product\n品牌=Brand', 'terms.txt');
    const reversed = planGlossaryImport({}, incoming, { reverse: true });
    assert.deepEqual(reversed.glossary, { Product: '产品', Brand: '品牌' });
    assert.deepEqual(values(incoming), [['产品', 'Product'], ['品牌', 'Brand']]);
    assert.equal(Object.hasOwn(reversed.glossary, '产品'), false);
    assert.throws(() => planGlossaryImport({}, parseGlossaryFile('a=same\nb=same', 'terms.txt'), { reverse: true }), /反转词表第 2 行.*冲突/);
    assert.throws(() => planGlossaryImport({}, parseGlossaryFile('公式=x=y', 'terms.txt'), { reverse: true }), /反转词表第 1 行.*不能包含/);
});

test('prototype-looking terms remain ordinary own properties throughout parsing and merging', () => {
    const incoming = parseGlossaryFile('{"__proto__":"品牌", "constructor":"构造器", "toString":"名称"}', 'terms.json');
    const existing = JSON.parse('{"__proto__":"旧品牌"}');
    const plan = planGlossaryImport(existing, incoming, { conflicts: 'overwrite' });
    assert.equal(Object.getPrototypeOf(plan.glossary), Object.prototype);
    assert.equal(Object.hasOwn(plan.glossary, '__proto__'), true);
    assert.equal(plan.glossary.__proto__, '品牌');
    assert.equal(plan.glossary.constructor, '构造器');
    assert.equal(plan.glossary.toString, '名称');
    assert.equal({}.polluted, undefined);
    assert.equal(existing.__proto__, '旧品牌');
});

test('the 1000-term limit applies after deduplication and again after merging with existing terms', () => {
    const text = Array.from({ length: 1000 }, (_, i) => `term${i}=value${i}`).join('\n');
    const full = parseGlossaryFile(text + '\nterm0=value0', 'terms.txt');
    assert.equal(full.entries.length, 1000);
    assert.equal(full.duplicates, 1);
    assert.throws(() => parseGlossaryFile(text + '\nextra=value', 'terms.txt'), /第 1001 行.*1,000/);
    assert.throws(() => planGlossaryImport({ extra: 'old' }, full), /导入后.*1,000/);
    assert.equal(planGlossaryImport({ extra: 'old' }, full, { mode: 'replace' }).total, 1000);
    assert.equal(planGlossaryImport({ term0: 'old' }, full).total, 1000);
});

test('planner validates provided entries and options rather than trusting a stale or forged preview', () => {
    assert.throws(() => planGlossaryImport({}, { entries: [] }), /没有可导入/);
    assert.throws(() => planGlossaryImport({}, { entries: [{ source: 'a', target: '\n' }] }), /换行/);
    assert.throws(() => planGlossaryImport({}, parseGlossaryFile('a=b', 'a.txt'), { conflicts: 'silently-drop' }), /有效的导入方式/);
    assert.throws(() => planGlossaryImport([], parseGlossaryFile('a=b', 'a.txt')), /现有词典格式/);
});
