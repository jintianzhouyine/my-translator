import { decodeGlossaryBytes, parseGlossaryFile, planGlossaryImport } from './glossary-import.js';
import { openXlsxGlossary } from './glossary-xlsx.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DIRECTIONS = { outbound: '我的话 → 对方听到的译文', inbound: '对方的话 → 我阅读的字幕' };
const STATUS = { added: '新增', updated: '更新', unchanged: '相同', kept: '保留现有译法' };

/** Imports edit the settings form only. Nothing is sent to the provider until settings are saved. */
export class GlossaryImportUI {
    constructor({ document, parseExisting, format, onError = () => {}, openWorkbook = openXlsxGlossary }) {
        Object.assign(this, { document, parseExisting, format, onError, openWorkbook });
        this.generation = 0;
        this.pending = null;
    }

    el(id) { return this.document.getElementById(id); }

    init() {
        for (const direction of Object.keys(DIRECTIONS)) {
            this.el(`btn-qwen-import-${direction}`)?.addEventListener('click', () => {
                this.selectedDirection = direction;
                const input = this.el('input-qwen-glossary-file');
                input.value = '';
                input.click();
            });
        }
        this.el('input-qwen-glossary-file')?.addEventListener('change', event => {
            const file = event.target.files?.[0];
            if (file) void this.loadFile(file, this.selectedDirection);
        });
        this.el('select-qwen-import-sheet')?.addEventListener('change', () => this._readSheet());
        for (const id of ['select-qwen-import-mode', 'select-qwen-import-conflicts', 'check-qwen-import-reverse']) {
            this.el(id)?.addEventListener('change', () => this.render());
        }
        this.el('btn-qwen-import-apply')?.addEventListener('click', () => this.apply());
        this.el('btn-qwen-import-cancel')?.addEventListener('click', () => this.reset());
        this.el('qwen-import-dialog')?.addEventListener('cancel', event => {
            event.preventDefault();
            this.reset();
        });
        // Keep app-wide start/stop and settings shortcuts from acting behind the preview.
        this.el('qwen-import-dialog')?.addEventListener('keydown', event => event.stopPropagation());
    }

    reset() {
        ++this.generation;
        this.pending = null;
        const dialog = this.el('qwen-import-dialog');
        if (dialog?.open) dialog.close();
        const input = this.el('input-qwen-glossary-file');
        if (input) input.value = '';
        const status = this.el('qwen-glossary-import-status');
        if (status) status.textContent = '';
    }

    async loadFile(file, direction) {
        this.reset();
        const generation = this.generation;
        const status = this.el('qwen-glossary-import-status');
        if (status) status.textContent = '正在读取词表…';
        try {
            if (!Object.hasOwn(DIRECTIONS, direction)) throw new Error('请先选择要导入的翻译方向。');
            if (!/\.(xlsx|csv|tsv|txt|json)$/i.test(file.name)) {
                throw new Error('请选择 .xlsx、.csv、.tsv、.txt 或 .json 词表；旧版 .xls 请先另存为 .xlsx。');
            }
            if (file.size > MAX_FILE_BYTES) throw new Error('词表文件不能超过 2 MiB，请仅保留需要的术语后重试。');
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (generation !== this.generation) return;
            if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('词表文件不能超过 2 MiB。');
            const workbook = /\.xlsx$/i.test(file.name) ? this.openWorkbook(bytes) : null;
            const parsed = workbook ? null : parseGlossaryFile(decodeGlossaryBytes(bytes), file.name);
            this.pending = { direction, name: file.name, workbook, parsed, error: null };
            this.el('qwen-import-title').textContent = `导入专有名词：${DIRECTIONS[direction]}`;
            this.el('qwen-import-file-name').textContent = file.name;
            this.el('select-qwen-import-mode').value = 'merge';
            this.el('select-qwen-import-conflicts').value = 'keep';
            this.el('check-qwen-import-reverse').checked = false;
            this.el('qwen-import-sheet-field').hidden = !workbook;
            const sheet = this.el('select-qwen-import-sheet');
            sheet.replaceChildren();
            for (const name of workbook?.sheetNames || []) {
                const option = this.document.createElement('option');
                option.value = name;
                option.textContent = name;
                sheet.append(option);
            }
            if (workbook) {
                sheet.value = workbook.sheetNames[0];
                this._readSheet();
            } else this.render();
            this.el('qwen-import-dialog').showModal();
            if (status) status.textContent = '';
        } catch (error) {
            if (generation !== this.generation) return;
            this.pending = null;
            if (status) status.textContent = `导入失败：${error.message}`;
            this.onError(error.message);
        }
    }

    _readSheet() {
        if (!this.pending?.workbook) return;
        try {
            this.pending.parsed = this.pending.workbook.parseSheet(this.el('select-qwen-import-sheet').value);
            this.pending.error = null;
        } catch (error) {
            this.pending.parsed = null;
            this.pending.error = error.message;
        }
        this.render();
    }

    render() {
        if (!this.pending) return;
        const errorEl = this.el('qwen-import-error');
        const summary = this.el('qwen-import-summary');
        const body = this.el('qwen-import-preview-body');
        const apply = this.el('btn-qwen-import-apply');
        apply.disabled = true;
        errorEl.textContent = '';
        summary.textContent = '';
        body.replaceChildren();
        this.pending.plan = null;
        const mode = this.el('select-qwen-import-mode').value;
        this.el('qwen-import-conflicts-field').hidden = mode === 'replace';
        try {
            if (this.pending.error) throw new Error(this.pending.error);
            const textarea = this.el(`input-qwen-glossary-${this.pending.direction}`);
            const existing = mode === 'replace' ? {} : this.parseExisting(textarea.value, '现有词典');
            const plan = planGlossaryImport(existing, this.pending.parsed, {
                mode, conflicts: this.el('select-qwen-import-conflicts').value,
                reverse: this.el('check-qwen-import-reverse').checked,
            });
            this.pending.plan = plan;
            this.pending.existingText = textarea.value;
            const duplicates = this.pending.parsed.duplicates || 0;
            summary.textContent = mode === 'replace'
                ? `将替换此方向的现有词典，共 ${plan.total} 条。`
                : `新增 ${plan.added} 条，更新 ${plan.updated} 条，保留 ${plan.unchanged} 条；合并后共 ${plan.total} 条。`;
            if (plan.conflicts) summary.textContent += ` 同名词有 ${plan.conflicts} 条译法不同。`;
            if (duplicates) summary.textContent += ` 已去除文件内 ${duplicates} 条相同重复项。`;
            this.el('qwen-import-preview-hint').textContent = plan.entries.length > 20
                ? `以下预览前 20 条；确认后导入全部 ${plan.entries.length} 条。`
                : `以下为本次导入的 ${plan.entries.length} 条词条。`;
            for (const entry of plan.entries.slice(0, 20)) {
                const row = this.document.createElement('tr');
                for (const value of [entry.source, entry.target, STATUS[entry.status] || entry.status]) {
                    const cell = this.document.createElement('td');
                    cell.textContent = value;
                    row.append(cell);
                }
                if (entry.status === 'kept') row.title = `文件中的译法：${entry.incomingTarget}`;
                body.append(row);
            }
            apply.disabled = false;
        } catch (error) {
            errorEl.textContent = error.message;
            this.el('qwen-import-preview-hint').textContent = '';
        }
    }

    apply() {
        if (!this.pending?.plan) return;
        const textarea = this.el(`input-qwen-glossary-${this.pending.direction}`);
        if (textarea.value !== this.pending.existingText) {
            this.render();
            this.el('qwen-import-error').textContent = '现有词典刚刚发生变化，预览已刷新，请检查后再次确认。';
            return;
        }
        const { direction, plan } = this.pending;
        textarea.value = this.format(plan.glossary);
        this.reset();
        this.el('qwen-glossary-import-status').textContent =
            `已填写「${DIRECTIONS[direction]}」词典，共 ${plan.total} 条。点击「保存并关闭」后生效；运行中的翻译会先暂停。`;
    }
}
