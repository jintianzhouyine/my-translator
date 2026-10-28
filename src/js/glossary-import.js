// Pure file parsing and preview planning. No settings or opposite-direction dictionary is mutated.
const MAX_TERMS = 1000;
const CELL_NEWLINE = /[\r\n\u0085\u2028\u2029]/;

function invalid(message, line = 1, label = '词表') {
    throw new Error(`${label}第 ${line} 行：${message}`);
}

function term(source, target, line = 1, label = '词表') {
    if (typeof source !== 'string' || typeof target !== 'string') invalid('原词和译法必须是文本。', line, label);
    if (CELL_NEWLINE.test(source) || CELL_NEWLINE.test(target)) invalid('原词和译法单元格不能包含换行。', line, label);
    source = source.trim();
    target = target.trim();
    if (!source || !target) invalid('原词和译法均不能为空。', line, label);
    if (source.includes('=')) invalid('原词不能包含「=」，译法可以包含。', line, label);
    return { source, target, line };
}

function uniqueTerms(entries, label = '词表') {
    const seen = new Map();
    let duplicates = 0;
    for (const entry of entries) {
        const item = term(entry.source, entry.target, entry.line, label);
        const previous = seen.get(item.source);
        if (previous) {
            if (previous.target !== item.target) {
                invalid(`原词「${item.source}」有不同译法，与第 ${previous.line} 行冲突。`, item.line, label);
            }
            duplicates++;
        } else {
            seen.set(item.source, item);
            if (seen.size > MAX_TERMS) invalid('每份词典最多 1,000 条，请减少词条后导入。', item.line, label);
        }
    }
    if (!seen.size) invalid('没有可导入的词条，请填写原词和译法。', 1, label);
    return { entries: [...seen.values()], duplicates };
}

function isHeader(source, target) {
    if (typeof source !== 'string' || typeof target !== 'string') return false;
    const pair = [source.trim().toLowerCase(), target.trim().toLowerCase()];
    return (pair[0] === 'source' && pair[1] === 'target') || (pair[0] === '原词' && pair[1] === '译法');
}

/** Spreadsheet rows: first two columns are terms; later columns may contain notes. */
export function parseGlossaryRows(rows, label = 'Excel词表') {
    if (!Array.isArray(rows)) invalid('词表必须包含二维行数据。', 1, label);
    const entries = [];
    let first = true;
    for (const [index, row] of rows.entries()) {
        if (!Array.isArray(row)) invalid('这一行不是有效的单元格数据。', index + 1, label);
        if (row.every(value => value == null || (typeof value === 'string' && !value.trim()))) continue;
        const [source, target] = row;
        if (first && isHeader(source, target)) { first = false; continue; }
        first = false;
        entries.push(term(source ?? '', target ?? '', index + 1, label));
    }
    return uniqueTerms(entries, label);
}

function parseDelimitedLine(raw, delimiter, line) {
    const cells = [];
    let cell = '';
    let quoted = false;
    let closed = false;
    for (let index = 0; index < raw.length; index++) {
        const char = raw[index];
        if (quoted) {
            if (char === '"') {
                if (raw[index + 1] === '"') { cell += '"'; index++; }
                else { quoted = false; closed = true; }
            } else cell += char;
        } else if (char === delimiter) {
            cells.push(cell); cell = ''; closed = false;
        } else if (char === '"') {
            if (closed || cell.trim()) invalid('双引号格式无效；带引号的单元格须完整引用。', line);
            cell = ''; quoted = true;
        } else if (closed) {
            if (!/[ \t]/.test(char)) invalid('闭合双引号后只能有分隔符或空白。', line);
        } else cell += char;
    }
    if (quoted) invalid('双引号未闭合，或单元格包含换行；请将每个词条放在同一行。', line);
    cells.push(cell);
    if (cells.length !== 2) invalid('每行必须恰好有两列：原词、译法。', line);
    return cells;
}

function parseDelimited(text, delimiter) {
    const entries = [];
    let first = true;
    for (const [index, raw] of text.split(/\r\n|\n|\r/).entries()) {
        if (!raw.trim() && !raw.includes(delimiter)) continue;
        const [source, target] = parseDelimitedLine(raw, delimiter, index + 1);
        if (first && isHeader(source, target)) { first = false; continue; }
        first = false;
        entries.push(term(source, target, index + 1));
    }
    return entries;
}

// A small shape-specific JSON reader preserves duplicate object keys and physical line numbers.
// JSON.parse alone would silently discard conflicting duplicate keys before validation.
class JsonGlossaryReader {
    constructor(text) { this.text = text; this.index = 0; this.line = 1; }

    whitespace() {
        while (/[ \t\r\n]/.test(this.text[this.index] || '\0')) {
            if (this.text[this.index] === '\n') this.line++;
            else if (this.text[this.index] === '\r' && this.text[this.index + 1] !== '\n') this.line++;
            this.index++;
        }
    }

    take(char) {
        this.whitespace();
        if (this.text[this.index] !== char) invalid(`JSON 格式无效，预期「${char}」。`, this.line);
        this.index++;
    }

    consume(char) {
        this.whitespace();
        if (this.text[this.index] !== char) return false;
        this.index++;
        return true;
    }

    string() {
        this.whitespace();
        const line = this.line;
        const start = this.index;
        if (this.text[this.index++] !== '"') invalid('JSON 的原词、译法和字段名必须使用双引号字符串。', line);
        while (this.index < this.text.length) {
            const char = this.text[this.index++];
            if (char.charCodeAt(0) < 32) invalid('JSON 字符串不能包含未转义的换行或控制字符。', line);
            if (char === '\\') {
                if (this.index >= this.text.length || this.text[this.index].charCodeAt(0) < 32) {
                    invalid('JSON 字符串转义格式无效。', line);
                }
                this.index++;
            } else if (char === '"') {
                try { return { value: JSON.parse(this.text.slice(start, this.index)), line }; }
                catch { invalid('JSON 字符串转义格式无效。', line); }
            }
        }
        invalid('JSON 字符串的双引号未闭合。', line);
    }

    pairs() {
        this.take('{');
        const entries = [];
        if (this.consume('}')) return entries;
        do {
            const source = this.string();
            this.take(':');
            const target = this.string();
            entries.push(term(source.value, target.value, source.line));
            if (this.consume('}')) return entries;
            this.take(',');
        } while (true);
    }

    entry() {
        this.whitespace();
        const line = this.line;
        this.take('{');
        const fields = new Map();
        if (!this.consume('}')) {
            do {
                const field = this.string();
                if (!['source', 'target'].includes(field.value)) invalid('JSON 词条只支持 source 和 target 字段。', field.line);
                if (fields.has(field.value)) invalid(`JSON 字段「${field.value}」重复。`, field.line);
                this.take(':');
                fields.set(field.value, this.string().value);
                if (this.consume('}')) break;
                this.take(',');
            } while (true);
        }
        if (!fields.has('source') || !fields.has('target')) invalid('JSON 词条必须同时包含 source 和 target。', line);
        return term(fields.get('source'), fields.get('target'), line);
    }

    read() {
        this.whitespace();
        let entries;
        if (this.text[this.index] === '{') entries = this.pairs();
        else if (this.text[this.index] === '[') {
            this.take('[');
            entries = [];
            if (!this.consume(']')) {
                do {
                    entries.push(this.entry());
                    if (this.consume(']')) break;
                    this.take(',');
                } while (true);
            }
        } else invalid('JSON 须为原词到译法的对象，或包含 source、target 的对象数组。', this.line);
        this.whitespace();
        if (this.index !== this.text.length) invalid('JSON 结束后存在多余内容。', this.line);
        return entries;
    }
}

/** Decode UTF-8, or UTF-16 with an explicit BOM; reject corrupt bytes instead of replacing them. */
export function decodeGlossaryBytes(bytes) {
    let view;
    if (bytes instanceof ArrayBuffer) view = new Uint8Array(bytes);
    else if (ArrayBuffer.isView(bytes)) view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    else throw new Error('词表文件必须以字节数据读取。');
    let encoding = 'utf-8';
    if (view[0] === 0xFF && view[1] === 0xFE) encoding = 'utf-16le';
    else if (view[0] === 0xFE && view[1] === 0xFF) encoding = 'utf-16be';
    try { return new TextDecoder(encoding, { fatal: true }).decode(view).replace(/^\uFEFF/, ''); }
    catch { throw new Error('词表文件编码无效，请另存为 UTF-8 或带 BOM 的 UTF-16 后重试。'); }
}

export function parseGlossaryFile(text, filename = 'glossary.txt') {
    if (typeof text !== 'string') invalid('文件内容必须是文本。');
    text = text.replace(/^\uFEFF/, '');
    const extension = String(filename).split('.').at(-1).toLowerCase();
    let entries;
    if (extension === 'csv' || extension === 'tsv') entries = parseDelimited(text, extension === 'csv' ? ',' : '\t');
    else if (extension === 'json') entries = new JsonGlossaryReader(text).read();
    else if (extension === 'txt') {
        entries = [];
        for (const [index, raw] of text.split(/\r\n|\n|\r/).entries()) {
            if (!raw.trim()) continue;
            const separator = raw.indexOf('=');
            if (separator < 0) invalid('请使用「原词 = 译法」格式。', index + 1);
            entries.push(term(raw.slice(0, separator), raw.slice(separator + 1), index + 1));
        }
    } else throw new Error('文本词表仅支持 CSV、TSV、TXT 和 JSON 文件。');
    return uniqueTerms(entries);
}

/** Build a complete proposed glossary without mutating existing settings or parsed entries. */
export function planGlossaryImport(existingObject, parsed, { mode = 'merge', conflicts = 'keep', reverse = false } = {}) {
    if (!['merge', 'replace'].includes(mode) || !['keep', 'overwrite'].includes(conflicts) || typeof reverse !== 'boolean') {
        throw new Error('请选择有效的导入方式和冲突处理方式。');
    }
    if (!parsed || !Array.isArray(parsed.entries)) throw new Error('请先解析有效的词表文件。');
    const incoming = uniqueTerms(parsed.entries.map(entry => reverse
        ? { source: entry.target, target: entry.source, line: entry.line }
        : { ...entry }), reverse ? '反转词表' : '词表');
    if (!existingObject || typeof existingObject !== 'object' || Array.isArray(existingObject)) {
        throw new Error('现有词典格式无效。');
    }
    const glossary = new Map();
    if (mode === 'merge') {
        const existing = Object.entries(existingObject);
        if (existing.length) {
            for (const entry of uniqueTerms(existing.map(([source, target], index) => ({ source, target, line: index + 1 })), '现有词典').entries) {
                glossary.set(entry.source, entry.target);
            }
        }
    }
    const result = { added: 0, updated: 0, unchanged: 0, conflicts: 0, entries: [] };
    for (const { source, target } of incoming.entries) {
        let status;
        if (!glossary.has(source)) {
            glossary.set(source, target);
            result.added++;
            status = 'added';
        } else if (glossary.get(source) === target) {
            result.unchanged++;
            status = 'unchanged';
        } else {
            result.conflicts++;
            if (conflicts === 'overwrite') {
                glossary.set(source, target);
                result.updated++;
                status = 'updated';
            } else {
                result.unchanged++;
                status = 'kept';
            }
        }
        result.entries.push({ source, target: glossary.get(source), incomingTarget: target, status });
    }
    if (glossary.size > MAX_TERMS) throw new Error('导入后词典超过 1,000 条，请减少词条或选择替换现有词典。');
    return { glossary: Object.fromEntries(glossary), ...result, total: glossary.size };
}
