import { QWEN_LANGS, QWEN_LANG_CODES, QWEN_SPEECH_LANGS, QWEN_SPEECH_LANG_CODES } from './qwen-langs.js';
import { GlossaryImportUI } from './glossary-import-ui.js';

const REGIONS = new Set(['cn-beijing', 'ap-southeast-1']);
const DEVICE_FIELDS = {
    qwen_microphone_device: 'select-qwen-microphone',
    qwen_system_device: 'select-qwen-system-device',
    qwen_output_device: 'select-qwen-output-device',
};

/** Parse a user-maintained directional glossary. Only the first '=' separates it. */
export function parseQwenGlossary(text, label = '术语词典') {
    const entries = [];
    const seen = new Set();
    for (const [index, raw] of String(text ?? '').split(/\r?\n/).entries()) {
        const line = raw.trim();
        if (!line) continue;
        const separator = line.indexOf('=');
        const source = separator < 0 ? '' : line.slice(0, separator).trim();
        const target = separator < 0 ? '' : line.slice(separator + 1).trim();
        if (!source || !target) {
            throw new Error(`${label}第 ${index + 1} 行请填写「原词 = 指定译法」，两边均不能为空。`);
        }
        if (seen.has(source)) throw new Error(`${label}第 ${index + 1} 行的原词「${source}」重复，请保留一个译法。`);
        seen.add(source);
        entries.push([source, target]);
        if (entries.length > 1000) throw new Error(`${label}最多填写 1,000 条，请删减后保存。`);
    }
    // fromEntries treats __proto__ as a normal own property rather than a setter.
    return Object.fromEntries(entries);
}

export function formatQwenGlossary(phrases) {
    if (!phrases || typeof phrases !== 'object' || Array.isArray(phrases)) return '';
    return Object.entries(phrases).map(([source, target]) => `${source} = ${target}`).join('\n');
}

/** Shared validation for saved settings and the form, before opening a paid session. */
export function validateQwenSettings(settings) {
    if (!REGIONS.has(settings.qwen_region)) throw new Error('请选择 Qwen 服务地域（北京或新加坡）。');
    const workspace = settings.qwen_workspace_id?.trim() || '';
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(workspace)) {
        throw new Error('请填写有效的百炼业务空间 ID（字母、数字或连字符），不要填写网址。');
    }
    if (!QWEN_LANG_CODES.has(settings.qwen_my_language)) throw new Error('请选择 Qwen 支持的字幕语言。');
    if (settings.qwen_duplex_enabled !== false) {
        if (!QWEN_SPEECH_LANG_CODES.has(settings.qwen_peer_language)) {
            throw new Error('对方听到的语言必须支持 Qwen 语音输出，请重新选择。');
        }
        if (settings.qwen_my_language === settings.qwen_peer_language) {
            throw new Error('双向翻译时，请为双方选择不同的语言。');
        }
        if (!settings.qwen_output_device?.trim()) {
            throw new Error('请先选择「发给对方的译音输出」虚拟设备，或关闭双向通话以仅显示字幕。');
        }
    }
}

/** Qwen-only form controls. Never requests audio permissions or changes system devices. */
export class QwenSettingsUI {
    constructor({ invoke, onError = () => {}, document: doc = globalThis.document }) {
        this.invoke = invoke;
        this.onError = onError;
        this.document = doc;
        this.devices = null;
        this._refreshGeneration = 0;
        this._initialized = false;
        this._hasRequestedDevices = false;
        this.glossaryImporter = new GlossaryImportUI({ document: doc, onError,
            parseExisting: parseQwenGlossary, format: formatQwenGlossary });
    }

    _element(id) { return this.document.getElementById(id); }

    init() {
        if (this._initialized) return;
        this._initialized = true;
        this.glossaryImporter.init();
        this._fillLanguages('select-qwen-my-language', QWEN_LANGS, 'zh');
        this._fillLanguages('select-qwen-peer-language', QWEN_SPEECH_LANGS, 'en');
        this._element('check-qwen-duplex')?.addEventListener('change', () => this._updateDuplexUI());
        this._element('btn-qwen-refresh-devices')?.addEventListener('click', () => {
            this.refreshDevices().catch(error => this.onError(error.message));
        });
        this._updateDuplexUI();
    }

    _fillLanguages(id, languages, selected) {
        const select = this._element(id);
        if (!select) return;
        select.replaceChildren();
        for (const language of languages) this._addOption(select, language.code, language.name);
        this._preserveValue(select, selected, `不支持的语言（${selected}）`);
    }

    _addOption(select, value, label) {
        const option = this.document.createElement('option');
        option.value = value;
        option.textContent = label;
        select.append(option);
        return option;
    }

    _preserveValue(select, value, missingLabel) {
        if (value && !Array.from(select.options).some(option => option.value === value)) {
            this._addOption(select, value, missingLabel);
        }
        select.value = value;
    }

    apply(settings) {
        this.init();
        this.glossaryImporter.reset();
        const values = {
            'input-qwen-workspace': settings.qwen_workspace_id ?? '',
            'select-qwen-region': settings.qwen_region ?? 'cn-beijing',
            'input-qwen-glossary-outbound': formatQwenGlossary(settings.qwen_glossary_outbound),
            'input-qwen-glossary-inbound': formatQwenGlossary(settings.qwen_glossary_inbound),
        };
        for (const [id, value] of Object.entries(values)) {
            const element = this._element(id);
            if (element) element.value = value;
        }
        this._element('check-qwen-duplex').checked = settings.qwen_duplex_enabled !== false;
        this._fillLanguages('select-qwen-my-language', QWEN_LANGS, settings.qwen_my_language ?? 'zh');
        this._fillLanguages('select-qwen-peer-language', QWEN_SPEECH_LANGS, settings.qwen_peer_language ?? 'en');
        for (const [field, id] of Object.entries(DEVICE_FIELDS)) {
            const select = this._element(id);
            if (select) this._preserveValue(select, settings[field] ?? '', `已保存的设备（${settings[field]}）`);
        }
        this._renderDevices();
        this._updateDuplexUI();
    }

    setVisible(active) {
        if (!active) this.glossaryImporter.reset();
        const panel = this._element('section-qwen-options');
        if (panel) panel.style.display = active ? '' : 'none';
        if (active && !this._hasRequestedDevices) {
            this.refreshDevices().catch(error => this.onError(error.message));
        }
    }

    _updateDuplexUI() {
        const duplex = this._element('check-qwen-duplex')?.checked !== false;
        for (const element of this.document.querySelectorAll('[data-qwen-duplex-field]')) {
            element.style.display = duplex ? '' : 'none';
        }
        const hint = this._element('qwen-direction-hint');
        if (hint) hint.textContent = duplex
            ? '对方的话在本机显示字幕，你的译音发送到下方指定的设备。'
            : '仅采集对方的声音并显示字幕，不采集你的麦克风，也不生成译音。';
    }

    async refreshDevices() {
        const generation = ++this._refreshGeneration;
        this._hasRequestedDevices = true;
        const button = this._element('btn-qwen-refresh-devices');
        const status = this._element('qwen-device-status');
        if (button) button.disabled = true;
        if (status) status.textContent = '正在读取音频设备…';
        try {
            const devices = await this.invoke('list_audio_devices');
            if (generation !== this._refreshGeneration) return;
            if (!devices || !Array.isArray(devices.inputs) || !Array.isArray(devices.outputs)) {
                throw new Error('无法读取音频设备，请在桌面应用中刷新重试。');
            }
            this.devices = devices;
            // Read current selection at completion: do not overwrite edits made during the request.
            this._renderDevices();
            if (status) status.textContent = devices.outputs.length
                ? '设备列表已更新；请确认会议软件中的麦克风和扬声器设置。'
                : '未发现播放设备。安装或连接设备后，点击「刷新设备」。';
        } catch (error) {
            if (generation !== this._refreshGeneration) return;
            if (status) status.textContent = '设备读取失败，已保留原选择。请刷新重试。';
            throw error;
        } finally {
            if (generation === this._refreshGeneration && button) button.disabled = false;
        }
    }

    _renderDevices() {
        if (!this.devices) return;
        const choices = [
            ['select-qwen-microphone', this.devices.inputs, '系统默认麦克风'],
            ['select-qwen-system-device', this.devices.outputs, '系统默认播放设备'],
            ['select-qwen-output-device', this.devices.outputs, '请选择虚拟音频设备…'],
        ];
        for (const [id, devices, placeholder] of choices) {
            const select = this._element(id);
            if (!select) continue;
            const selected = select.value;
            select.replaceChildren();
            this._addOption(select, '', placeholder);
            for (const device of devices) {
                this._addOption(select, device.id, `${device.name}${device.is_default ? '（系统默认）' : ''}`);
            }
            this._preserveValue(select, selected, `设备不可用（${selected}），请重新选择`);
        }
        const selectable = this.devices.supports_system_device_selection === true;
        const system = this._element('qwen-system-device-field');
        if (system) system.style.display = selectable ? '' : 'none';
        const hint = this._element('qwen-system-device-hint');
        if (hint) hint.textContent = selectable
            ? '这里选择会议软件的扬声器（建议耳机），不能与发给对方的译音输出相同。'
            : '自动采集系统中播放的会议声音。macOS 会排除本软件自身的译音；请授予系统音频采集权限。';
    }

    read({ validateConnection = true } = {}) {
        const value = id => this._element(id)?.value ?? '';
        const settings = {
            qwen_workspace_id: value('input-qwen-workspace').trim(),
            qwen_region: value('select-qwen-region'),
            qwen_duplex_enabled: this._element('check-qwen-duplex')?.checked !== false,
            qwen_my_language: value('select-qwen-my-language'),
            qwen_peer_language: value('select-qwen-peer-language'),
            qwen_microphone_device: value('select-qwen-microphone'),
            // A saved Windows loopback endpoint does not apply to macOS system capture.
            qwen_system_device: this.devices?.supports_system_device_selection === false
                ? '' : value('select-qwen-system-device'),
            qwen_output_device: value('select-qwen-output-device'),
            qwen_glossary_outbound: parseQwenGlossary(value('input-qwen-glossary-outbound'), '发给对方的词典'),
            qwen_glossary_inbound: parseQwenGlossary(value('input-qwen-glossary-inbound'), '本机字幕词典'),
        };
        if (validateConnection) {
            validateQwenSettings(settings);
            if (this.devices?.supports_system_device_selection && settings.qwen_system_device &&
                !this.devices.outputs.some(device => device.id === settings.qwen_system_device)) {
                throw new Error('对方声音所在的播放设备已不可用，请刷新设备并重新选择。');
            }
            if (settings.qwen_duplex_enabled && this.devices) {
                const output = this.devices.outputs.find(device => device.id === settings.qwen_output_device);
                if (!output) throw new Error('所选译音输出设备已不可用，请刷新设备并重新选择。');
                const microphone = settings.qwen_microphone_device
                    ? this.devices.inputs.find(device => device.id === settings.qwen_microphone_device)
                    : this.devices.inputs.find(device => device.is_default);
                if (settings.qwen_microphone_device && !microphone) {
                    throw new Error('所选麦克风已不可用，请刷新设备并重新选择。');
                }
                if (microphone?.id === output.id) {
                    throw new Error('我的麦克风不能使用译音输出设备，请选择真实麦克风，避免译音被重复翻译。');
                }
                if (this.devices.supports_system_device_selection) {
                    const system = settings.qwen_system_device
                        ? this.devices.outputs.find(device => device.id === settings.qwen_system_device)
                        : this.devices.outputs.find(device => device.is_default);
                    if (system?.id === output.id) throw new Error('对方声音的播放设备与译音输出不能相同，否则译音会被重复翻译。');
                }
            }
        }
        return settings;
    }
}
