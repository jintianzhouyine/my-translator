import { parseGlossaryRows } from './glossary-import.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_SHEET_ROWS = 10002; // Allow blank rows while bounding work; net terms are limited to 1,000.
const MAX_ZIP_ENTRIES = 256;
const MAX_SHEETS = 64;

function fail(message) { throw new Error(message); }
function corrupt() { fail('Excel 文件损坏或不是有效的 .xlsx 文件，请用 Excel 重新另存后导入。'); }

function bytesCopy(bytes) {
    let view;
    if (bytes instanceof ArrayBuffer) view = new Uint8Array(bytes);
    else if (ArrayBuffer.isView(bytes)) view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    else fail('Excel 文件必须以字节数据读取。');
    if (view.byteLength > MAX_FILE_BYTES) fail('Excel 文件不能超过 2 MiB，请仅保留需要导入的词表。');
    if (view.byteLength < 22) corrupt();
    return new Uint8Array(view); // Own the bytes: sheet switching must not observe caller mutations.
}

// Inspect ZIP metadata before SheetJS decompresses the workbook. This is a size
// gate, not another spreadsheet reader; SheetJS handles ZIP inflation and OOXML.
function checkZip(bytes) {
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = offset => data.getUint16(offset, true);
    const u32 = offset => data.getUint32(offset, true);
    if (u32(0) !== 0x04034B50) fail('仅支持未加密的 .xlsx 文件，请不要选择旧版 .xls 或修改文件扩展名。');
    let end = bytes.length - 22;
    const earliest = Math.max(0, bytes.length - 22 - 65535);
    for (; end >= earliest; end--) {
        if (u32(end) === 0x06054B50 && end + 22 + u16(end + 20) === bytes.length) break;
    }
    if (end < earliest) corrupt();
    const count = u16(end + 10);
    const directorySize = u32(end + 12);
    const directoryStart = u32(end + 16);
    if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count || count === 65535 || directoryStart === 0xFFFFFFFF) corrupt();
    if (!count || count > MAX_ZIP_ENTRIES) fail('Excel 文件结构过大，请仅保留需要的工作表后重试。');
    if (directoryStart + directorySize !== end) corrupt();
    let position = directoryStart;
    let expanded = 0;
    const names = new Set();
    const spans = [];
    function checkExtra(start, length) {
        for (let cursor = start; cursor < start + length;) {
            if (cursor + 4 > start + length) corrupt();
            const id = u16(cursor);
            const size = u16(cursor + 2);
            if (id === 1) fail('此 Excel 使用 ZIP64 格式，请另存为普通 .xlsx 词表。');
            cursor += 4 + size;
            if (cursor > start + length) corrupt();
        }
    }
    for (let index = 0; index < count; index++) {
        if (position + 46 > end || u32(position) !== 0x02014B50) corrupt();
        const flags = u16(position + 8);
        const method = u16(position + 10);
        const compressed = u32(position + 20);
        const size = u32(position + 24);
        const nameLength = u16(position + 28);
        const extraLength = u16(position + 30);
        const commentLength = u16(position + 32);
        const local = u32(position + 42);
        const next = position + 46 + nameLength + extraLength + commentLength;
        if (next > end || local + 30 > directoryStart || u16(position + 34)) corrupt();
        if (flags & 0x2041) fail('不支持加密的 Excel 文件，请先取消密码保护。');
        if (method !== 0 && method !== 8) fail('Excel 压缩格式不受支持，请重新另存为 .xlsx。');
        if (method === 8 && compressed < 2) corrupt();
        if (size > MAX_ENTRY_BYTES || (expanded += size) > MAX_EXPANDED_BYTES || size > compressed * 200 + 65536) {
            fail('Excel 解压后的内容过大，请仅保留词表，移除图片和多余工作表后重试。');
        }
        const name = new TextDecoder().decode(bytes.subarray(position + 46, position + 46 + nameLength));
        if (!name || names.has(name)) corrupt();
        names.add(name);
        checkExtra(position + 46 + nameLength, extraLength);
        if (u32(local) !== 0x04034B50 || u16(local + 6) !== flags || u16(local + 8) !== method || u16(local + 26) !== nameLength) corrupt();
        const localExtra = u16(local + 28);
        const start = local + 30 + nameLength + localExtra;
        if (start + compressed > directoryStart) corrupt();
        for (let n = 0; n < nameLength; n++) {
            if (bytes[local + 30 + n] !== bytes[position + 46 + n]) corrupt();
        }
        checkExtra(local + 30 + nameLength, localExtra);
        const localCompressed = u32(local + 18);
        const localSize = u32(local + 22);
        if ((localCompressed && localCompressed !== compressed) || (localSize && localSize !== size)) corrupt();
        if (!(flags & 8) && (localCompressed !== compressed || localSize !== size)) corrupt();
        if (method === 0 && compressed !== size) corrupt();
        if (method === 8 && !size && !(compressed === 2 && bytes[start] === 3 && bytes[start + 1] === 0)) corrupt();
        // Streaming ZIP writers may leave these fields zero. Supplying the
        // checked central-directory sizes bounds SheetJS's inflate allocation.
        data.setUint32(local + 18, compressed, true);
        data.setUint32(local + 22, size, true);
        spans.push([local, start + compressed]);
        position = next;
    }
    if (position !== end || !names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) corrupt();
    spans.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) corrupt();
}

function xmlText(file) {
    if (!file?.content || file.content.length > MAX_ENTRY_BYTES) corrupt();
    try { return new TextDecoder('utf-8', { fatal: true }).decode(file.content); }
    catch { corrupt(); }
}
function attribute(attributes, name) {
    return new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`).exec(attributes)?.[2];
}
function xmlValue(value) {
    return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
        const fixed = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
        if (fixed[entity]) return fixed[entity];
        const code = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
        if (!Number.isSafeInteger(code) || code > 0x10FFFF) corrupt();
        return String.fromCodePoint(code);
    });
}
function selectedSheetXml(workbook, index) {
    const id = workbook.Workbook?.Sheets?.[index]?.id;
    if (!id) corrupt();
    const relationships = xmlText(workbook.files?.['xl/_rels/workbook.xml.rels']);
    for (const match of relationships.matchAll(/<(?:[\w.-]+:)?Relationship\b([^>]*)>/g)) {
        if (xmlValue(attribute(match[1], 'Id') || '') !== id) continue;
        const target = xmlValue(attribute(match[1], 'Target') || '');
        if (!target || attribute(match[1], 'TargetMode') === 'External') corrupt();
        const url = new URL(target, 'https://glossary.invalid/xl/workbook.xml');
        if (url.origin !== 'https://glossary.invalid' || url.search || url.hash) corrupt();
        const path = decodeURIComponent(url.pathname.slice(1));
        return xmlText(workbook.files?.[path]);
    }
    corrupt();
}

function checkAddress(address, xlsx, label) {
    if (!/^[A-Z]+[1-9]\d*(?::[A-Z]+[1-9]\d*)?$/.test(address)) corrupt();
    const range = xlsx.utils.decode_range(address);
    if (range.e.c > 16383 || range.s.c > range.e.c || range.s.r > range.e.r) corrupt();
    if (range.e.r >= MAX_SHEET_ROWS) fail(`${label}超过 ${MAX_SHEET_ROWS} 行（含表头和空行），请整理为最多 1,000 条词条后导入。`);
    return range.e.r;
}
function checkActualRows(xml, xlsx, label) {
    // sheetRows intentionally bounds parsing, so inspect original references:
    // understated/absent dimensions must not hide data or uncached formulas.
    let nextRow = 0;
    let nextColumn = 0;
    let currentCell = null;
    let maximum = -1;
    let rowCount = 0;
    for (const match of xml.matchAll(/<(\/?)(?:[\w.-]+:)?(dimension|row|c|f)\b([^>]*)>/g)) {
        const [, closing, tag, attributes] = match;
        if (closing) { if (tag === 'c') currentCell = null; continue; }
        const reference = attribute(attributes, tag === 'dimension' ? 'ref' : 'r');
        if (tag === 'row') {
            if (++rowCount > MAX_SHEET_ROWS) fail(`${label}超过 10,002 个物理行（含空行），请整理后导入。词条上限为 1,000 条。`);
            if (reference && !/^[1-9]\d*$/.test(reference)) corrupt();
            nextRow = reference ? Number(reference) - 1 : nextRow;
            if (nextRow >= MAX_SHEET_ROWS) fail(`${label}第 ${nextRow + 1} 行超出 10,002 个物理行上限（含空行），请整理后导入。`);
            maximum = Math.max(maximum, nextRow++);
            nextColumn = 0;
            currentCell = null;
        } else if (tag === 'c') {
            if (reference) {
                maximum = Math.max(maximum, checkAddress(reference, xlsx, label));
                currentCell = xlsx.utils.decode_cell(reference);
            } else currentCell = { r: Math.max(0, nextRow - 1), c: nextColumn };
            nextColumn = currentCell.c + 1;
        } else if (tag === 'f' && currentCell && currentCell.c < 2) {
            fail(`${label}第 ${currentCell.r + 1} 行 ${currentCell.c === 0 ? 'A' : 'B'} 列是公式，请复制并粘贴为文本或值后导入。`);
        } else if (reference) maximum = Math.max(maximum, checkAddress(reference, xlsx, label));
    }
    return maximum;
}

/** List workbook names first; parse only the explicitly selected sheet on demand. */
export function openXlsxGlossary(bytes, { xlsx = globalThis.XLSX } = {}) {
    if (!xlsx?.read || !xlsx?.utils?.sheet_to_json) fail('Excel 读取组件尚未加载，请重新打开设置后重试。');
    const input = bytesCopy(bytes);
    checkZip(input);
    let metadata;
    try { metadata = xlsx.read(input, { type: 'array', bookSheets: true, WTF: true }); }
    catch { corrupt(); }
    const sheetNames = Array.from(metadata.SheetNames || []);
    if (!sheetNames.length) fail('Excel 文件没有可选择的工作表。');
    if (sheetNames.length > MAX_SHEETS) fail('Excel 工作表超过 64 个，请仅保留需要导入的工作表。');
    return {
        sheetNames: [...sheetNames],
        parseSheet(name) {
            const index = sheetNames.indexOf(name);
            if (index < 0) fail('请选择文件中存在的工作表。');
            const label = `工作表「${name}」`;
            let workbook;
            try {
                workbook = xlsx.read(input, {
                    type: 'array', sheets: [index], sheetRows: MAX_SHEET_ROWS,
                    bookFiles: true, cellFormula: true, cellText: true,
                    cellHTML: false, dense: false, WTF: true,
                });
            } catch { corrupt(); }
            const sheet = Object.hasOwn(workbook.Sheets || {}, name) ? workbook.Sheets[name] : undefined;
            if (!sheet) fail(`${label}不是可导入的单元格工作表，请选择其他工作表。`);
            let lastRow = checkActualRows(selectedSheetXml(workbook, index), xlsx, label);
            for (const range of [sheet['!ref'], sheet['!fullref']]) {
                if (range) lastRow = Math.max(lastRow, checkAddress(range, xlsx, label));
            }
            const noteRows = new Set();
            for (const [address, cell] of Object.entries(sheet)) {
                if (address.startsWith('!')) continue;
                lastRow = Math.max(lastRow, checkAddress(address, xlsx, label));
                const point = xlsx.utils.decode_cell(address);
                if (point.c < 2 && (cell.f !== undefined || cell.F !== undefined)) {
                    fail(`${label}第 ${point.r + 1} 行 ${point.c === 0 ? 'A' : 'B'} 列是公式，请复制并粘贴为文本或值后导入。`);
                }
                if (point.c < 2 && cell.t === 'e') fail(`${label}第 ${point.r + 1} 行 ${point.c === 0 ? 'A' : 'B'} 列包含 Excel 错误值。`);
                if (point.c > 1 && cell.v != null && String(cell.v).trim()) noteRows.add(point.r);
            }
            if (lastRow < 0) fail(`${label}为空，请选择包含原词和译法的工作表。`);
            const rows = xlsx.utils.sheet_to_json(sheet, {
                header: 1, raw: false, defval: '', blankrows: true,
                range: { s: { r: 0, c: 0 }, e: { r: lastRow, c: 1 } },
            });
            // Ignore note text, but do not silently drop a malformed notes-only row.
            for (const row of noteRows) if (!rows[row]?.some(value => String(value).trim())) (rows[row] ||= []).push('备注');
            return parseGlossaryRows(rows, label);
        },
    };
}
