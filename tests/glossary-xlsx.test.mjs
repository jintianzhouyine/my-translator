import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { openXlsxGlossary } from '../src/js/glossary-xlsx.js';

const vendorSource = fs.readFileSync(new URL('../src/js/vendor/xlsx.mini.min.js', import.meta.url), 'utf8');
const XLSX = vm.runInNewContext(`${vendorSource}\nXLSX;`, { Uint8Array, ArrayBuffer });
function book(sheets, { compression = true } = {}) {
    const workbook = XLSX.utils.book_new();
    for (const [name, rows] of Object.entries(sheets)) {
        XLSX.utils.book_append_sheet(workbook, Array.isArray(rows) ? XLSX.utils.aoa_to_sheet(rows) : rows, name);
    }
    return XLSX.write(workbook, { type: 'array', bookType: 'xlsx', compression });
}
function read(bytes) { return openXlsxGlossary(bytes, { xlsx: XLSX }); }
function rewriteXml(bytes, path, change) {
    const archive = XLSX.CFB.read(new Uint8Array(bytes), { type: 'array' });
    const file = archive.FileIndex[archive.FullPaths.indexOf(archive.FullPaths[0] + path)];
    assert.ok(file, `fixture must contain ${path}`);
    file.content = new TextEncoder().encode(change(new TextDecoder().decode(file.content)));
    file.size = file.content.length;
    return new Uint8Array(XLSX.CFB.write(archive, { type: 'array', fileType: 'zip', compression: true }));
}

// These tests load the exact browser vendor file and create actual zipped OOXML.
test('the pinned vendor version and checksum match the distribution record', () => {
    assert.equal(XLSX.version, '0.20.3');
    assert.equal(createHash('sha256').update(vendorSource).digest('hex'), '0cb353f830d7288385492c83d277b058ddeac664ca51cf1393aa1fd3e2b70939');
});

test('lists sheet names first and parses only the selected sheet while preserving text and display format', () => {
    const outgoing = XLSX.utils.aoa_to_sheet([
        ['原词', '译法', '备注'],
        ['灰度发布', 'canary release', '部署术语'],
        ['带,逗号"引号', 'commas, and "quotes"'],
        [1, '编号一'],
    ]);
    outgoing.A4.z = '000';
    const incoming = XLSX.utils.aoa_to_sheet([['source', 'target'], ['canary release', '灰度发布']]);
    const bytes = book({ 发给对方: outgoing, 本机字幕: incoming });
    const calls = [];
    const tracked = { ...XLSX, read(input, options) { calls.push(options); return XLSX.read(input, options); } };
    const opened = openXlsxGlossary(bytes, { xlsx: tracked });
    assert.deepEqual(opened.sheetNames, ['发给对方', '本机字幕']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bookSheets, true);
    const parsed = opened.parseSheet('发给对方');
    assert.deepEqual(parsed.entries, [
        { source: '灰度发布', target: 'canary release', line: 2 },
        { source: '带,逗号"引号', target: 'commas, and "quotes"', line: 3 },
        { source: '001', target: '编号一', line: 4 },
    ]);
    assert.equal(calls[1].sheetRows, 10002);
    assert.deepEqual(calls[1].sheets, [0]);
    assert.deepEqual(opened.parseSheet('本机字幕').entries, [{ source: 'canary release', target: '灰度发布', line: 2 }]);
    assert.deepEqual(calls[2].sheets, [1]);
});

test('a malformed unselected worksheet does not prevent selecting a valid worksheet', () => {
    const formula = XLSX.utils.aoa_to_sheet([['原词', '译法'], ['词', '译法']]);
    formula.B2 = { t: 's', f: '"缓存译法"', v: '缓存译法' };
    const opened = read(book({ 公式表: formula, 正常表: [['词', 'term']] }));
    assert.equal(opened.parseSheet('正常表').entries.length, 1);
    assert.throws(() => opened.parseSheet('公式表'), /第 2 行 B 列是公式/);
});

test('rejects both source and target formulas, including formulas without cached values', () => {
    for (const address of ['A2', 'B2']) {
        for (const cached of [true, false]) {
            const sheet = XLSX.utils.aoa_to_sheet([['原词', '译法'], ['词', 'term']]);
            sheet[address] = { t: 's', f: '"formula"', ...(cached ? { v: 'cached' } : {}) };
            assert.throws(() => read(book({ 词表: sheet })).parseSheet('词表'), new RegExp(`第 2 行 ${address[0]} 列是公式`));
        }
    }
    const notes = XLSX.utils.aoa_to_sheet([['词', 'term', '备注']]);
    notes.C1 = { t: 'n', f: '1+1', v: 2 };
    assert.equal(read(book({ 备注公式: notes })).parseSheet('备注公式').entries.length, 1);
});

test('empty sheets, wrong names and missing term cells show explicit errors', () => {
    const opened = read(book({ 空表: [], 只有表头: [['原词', '译法']], 缺少译法: [['原词', '译法'], ['词']] }));
    assert.throws(() => opened.parseSheet('不存在'), /存在的工作表/);
    assert.throws(() => opened.parseSheet('空表'), /为空|没有可导入/);
    assert.throws(() => opened.parseSheet('只有表头'), /没有可导入/);
    assert.throws(() => opened.parseSheet('缺少译法'), /第 2 行.*不能为空/);
    assert.throws(() => read(book({ 词表: [['原词', '译法'], ['', '', '只有备注']] })).parseSheet('词表'), /第 2 行.*不能为空/);
});

test('blank rows keep Excel row numbers and invalid duplicate mappings are not hidden', () => {
    const opened = read(book({ 词表: [[], ['原词', '译法'], ['词', 'term'], [], ['词', 'other']] }));
    assert.throws(() => opened.parseSheet('词表'), /第 5 行.*第 3 行冲突/);
    assert.deepEqual(read(book({ 词表: [[], ['原词', '译法'], ['词', 'term'], ['词', 'term']] })).parseSheet('词表'), {
        entries: [{ source: '词', target: 'term', line: 3 }], duplicates: 1,
    });
});

test('accepts 1,000 terms and rejects overflow instead of silently truncating', () => {
    const terms = Array.from({ length: 1000 }, (_, i) => [`术语${i}`, `term${i}`]);
    assert.equal(read(book({ 词表: [['原词', '译法'], ...terms] })).parseSheet('词表').entries.length, 1000);
    assert.throws(() => read(book({ 词表: [['原词', '译法'], ...terms, ['额外', 'extra']] })).parseSheet('词表'), /1,000/);
    assert.throws(() => read(book({ 词表: [['原词', '译法'], ...terms, ['额外', 'extra'], ['再额外', 'another']] })).parseSheet('词表'), /1,000|1002/);
});

test('detects understated, absent and enormous worksheet dimensions before returning partial data', () => {
    const sheet = XLSX.utils.aoa_to_sheet([['原词', '译法'], ['词', 'term']]);
    sheet.A10004 = { t: 's', v: '漏掉的词' };
    sheet.B10004 = { t: 's', v: 'hidden term' };
    sheet['!ref'] = 'A1:B10004';
    const original = book({ 词表: sheet });
    for (const dimension of ['<dimension ref="A1:B2"/>', '']) {
        const modified = rewriteXml(original, 'xl/worksheets/sheet1.xml', xml => xml.replace(/<dimension[^>]*\/>/, dimension));
        assert.throws(() => read(modified).parseSheet('词表'), /10004|1,000/);
    }
    const huge = rewriteXml(book({ 词表: [['词', 'term']] }), 'xl/worksheets/sheet1.xml', xml => xml.replace(/<dimension[^>]*\/>/, '<dimension ref="A1:XFD1048576"/>'));
    assert.throws(() => read(huge).parseSheet('词表'), /10002|1,000/);
});

test('cells outside an understated range are imported when they remain within the row limit', () => {
    const original = book({ 词表: [['原词', '译法'], ['词一', 'one'], ['词二', 'two']] });
    const modified = rewriteXml(original, 'xl/worksheets/sheet1.xml', xml => xml.replace(/<dimension[^>]*\/>/, '<dimension ref="A1:B2"/>'));
    assert.equal(read(modified).parseSheet('词表').entries.length, 2);
});

test('rejects oversized files and suspicious ZIP expansion before asking SheetJS to read them', () => {
    let reads = 0;
    const fake = { ...XLSX, read() { reads++; throw new Error('should not read'); } };
    assert.throws(() => openXlsxGlossary(new Uint8Array(2 * 1024 * 1024 + 1), { xlsx: fake }), /2 MiB/);
    const input = new Uint8Array(book({ 词表: [['词', 'term']] }));
    const view = new DataView(input.buffer);
    let central = -1;
    for (let i = 0; i + 46 < input.length; i++) if (view.getUint32(i, true) === 0x02014B50) { central = i; break; }
    assert.ok(central >= 0);
    view.setUint32(central + 24, 100 * 1024 * 1024, true);
    assert.throws(() => openXlsxGlossary(input, { xlsx: fake }), /解压后的内容过大/);
    assert.equal(reads, 0);
});

test('corrupt files, text disguised as Excel and missing vendor are rejected', () => {
    assert.throws(() => read(new TextEncoder().encode('not a spreadsheet file at all')), /\.xlsx/);
    const valid = new Uint8Array(book({ 词表: [['词', 'term']] }));
    assert.throws(() => read(valid.subarray(0, valid.length - 5)), /损坏/);
    const broken = rewriteXml(valid, 'xl/workbook.xml', () => '<not-a-workbook/>');
    assert.throws(() => read(broken), /损坏|工作表/);
    assert.throws(() => openXlsxGlossary(valid, { xlsx: {} }), /组件尚未加载/);
});

test('the workbook retains its own bytes and sheet list across caller mutations', () => {
    const bytes = new Uint8Array(book({ 词表: [['词', 'term']] }, { compression: false }));
    const opened = read(bytes);
    bytes.fill(0);
    opened.sheetNames.push('虚构');
    assert.equal(opened.parseSheet('词表').entries.length, 1);
    assert.throws(() => opened.parseSheet('虚构'), /存在的工作表/);
});

test('a thousand terms with blank rows remain complete below the physical row limit', () => {
    const rows = [['原词', '译法']];
    for (let index = 0; index < 1000; index++) {
        if (index % 100 === 0) rows.push([]);
        rows.push([`词${index}`, `term${index}`]);
    }
    const result = read(book({ 词表: rows })).parseSheet('词表');
    assert.equal(result.entries.length, 1000);
    assert.equal(result.entries.at(-1).line, 1011);
});

test('the downloadable template contains three usable text mappings', () => {
    const bytes = fs.readFileSync(new URL('../docs/examples/qwen-terms.xlsx', import.meta.url));
    const template = read(bytes);
    assert.deepEqual(template.sheetNames, ['专有名词']);
    assert.equal(template.parseSheet('专有名词').entries.length, 3);
});
