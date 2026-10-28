import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQwenGlossary, formatQwenGlossary, validateQwenSettings, QwenSettingsUI } from '../src/js/qwen-settings.js';
import { QWEN_LANG_CODES, QWEN_SPEECH_LANG_CODES } from '../src/js/qwen-langs.js';

test('directional glossaries preserve Unicode and equals in target text without prototype mutation', () => {
    const glossary = parseQwenGlossary('\n 产品名 = ProductName\r\n公式 = x = y\n__proto__ = 品牌\n');
    assert.equal(glossary['产品名'], 'ProductName');
    assert.equal(glossary['公式'], 'x = y');
    assert.equal(Object.getPrototypeOf(glossary), Object.prototype);
    assert.equal(glossary.__proto__, '品牌');
    assert.deepEqual(parseQwenGlossary(formatQwenGlossary(glossary)), glossary);
    assert.equal(Object.hasOwn(glossary, 'ProductName'), false, 'must not invent reverse mappings');
});

test('invalid, ambiguous and oversized glossaries are rejected with line information', () => {
    assert.throws(() => parseQwenGlossary('有效 = valid\n缺失译法'), /第 2 行/);
    assert.throws(() => parseQwenGlossary('词 = 一\n词 = 二'), /重复/);
    assert.throws(() => parseQwenGlossary(' = target'), /不能为空/);
    assert.throws(() => parseQwenGlossary('source = '), /不能为空/);
    const entries = Array.from({ length: 1000 }, (_, i) => `术语${i} = term${i}`);
    assert.equal(Object.keys(parseQwenGlossary(entries.join('\n'))).length, 1000);
    assert.throws(() => parseQwenGlossary([...entries, '额外 = extra'].join('\n')), /1,000/);
});

const configured = {
    qwen_workspace_id: 'workspace-test', qwen_region: 'cn-beijing',
    qwen_my_language: 'zh', qwen_peer_language: 'en',
    qwen_duplex_enabled: true, qwen_output_device: 'virtual-id',
};

test('caption-only accepts text targets; outbound rejects text-only targets and unspecified output', () => {
    assert.equal(QWEN_LANG_CODES.size, 60);
    assert.equal(QWEN_SPEECH_LANG_CODES.size, 29);
    assert.doesNotThrow(() => validateQwenSettings({ ...configured, qwen_duplex_enabled: false, qwen_my_language: 'yue', qwen_output_device: '' }));
    assert.throws(() => validateQwenSettings({ ...configured, qwen_peer_language: 'yue' }), /语音输出/);
    assert.throws(() => validateQwenSettings({ ...configured, qwen_output_device: '' }), /虚拟设备/);
    assert.throws(() => validateQwenSettings({ ...configured, qwen_workspace_id: 'example.com/path' }), /业务空间 ID/);
    assert.throws(() => validateQwenSettings({ ...configured, qwen_peer_language: 'zh' }), /不同/);
    assert.throws(() => validateQwenSettings({ ...configured, qwen_duplex_enabled: undefined, qwen_output_device: '' }), /虚拟设备/);
    assert.doesNotThrow(() => validateQwenSettings({ ...configured, qwen_duplex_enabled: false, qwen_peer_language: 'zh', qwen_output_device: '' }));
});

// Minimal select semantics for testing async device enumeration independently of a browser.
class Element {
    constructor() { this.options = []; this.style = {}; this.value = ''; this.checked = true; }
    append(option) { this.options.push(option); }
    replaceChildren() { this.options = []; this.value = ''; }
    addEventListener() {}
}
function fakeDocument() {
    const elements = new Map();
    return {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, new Element());
            return elements.get(id);
        },
        createElement: () => new Element(),
        querySelectorAll: () => [],
    };
}
const devices = {
    inputs: [{ id: 'mic', name: '麦克风', is_default: true }],
    outputs: [{ id: 'headphones', name: '耳机', is_default: true }, { id: 'virtual-id', name: '虚拟输出', is_default: false }],
    supports_system_device_selection: true,
};

test('the settings form rejects identical duplex target languages before saving', () => {
    const doc = fakeDocument();
    const ui = new QwenSettingsUI({ document: doc, invoke: async () => devices });
    ui.apply({ ...configured, qwen_peer_language: 'zh' });
    assert.throws(() => ui.read(), /不同/);
    doc.getElementById('check-qwen-duplex').checked = false;
    assert.equal(ui.read().qwen_peer_language, 'zh');
});

test('enumeration preserves edits made while it runs, and missing saved outputs never silently fall back', async () => {
    let resolve;
    const doc = fakeDocument();
    const ui = new QwenSettingsUI({ document: doc, invoke: () => new Promise(done => { resolve = done; }) });
    ui.apply(configured);
    const pending = ui.refreshDevices();
    doc.getElementById('select-qwen-output-device').value = 'unplugged-device';
    resolve(devices);
    await pending;
    const select = doc.getElementById('select-qwen-output-device');
    assert.equal(select.value, 'unplugged-device');
    assert.match(select.options.at(-1).textContent, /设备不可用/);
    assert.throws(() => ui.read(), /已不可用/);
});

test('stale enumeration results do not replace a newer refresh, and same-device feedback is rejected', async () => {
    const resolves = [];
    const doc = fakeDocument();
    const ui = new QwenSettingsUI({ document: doc, invoke: () => new Promise(done => resolves.push(done)) });
    ui.apply(configured);
    const first = ui.refreshDevices();
    const second = ui.refreshDevices();
    resolves[1](devices);
    await second;
    resolves[0]({ ...devices, outputs: [] });
    await first;
    assert.equal(ui.devices.outputs.length, 2);
    doc.getElementById('select-qwen-output-device').value = 'headphones';
    assert.throws(() => ui.read(), /不能相同/);
});

test('initialization does not enumerate devices before Qwen is selected', () => {
    let calls = 0;
    const ui = new QwenSettingsUI({ document: fakeDocument(), invoke: () => { calls++; return devices; } });
    ui.init();
    ui.apply(configured);
    ui.setVisible(false);
    assert.equal(calls, 0);
});

test('saved Windows capture device is cleared when the platform uses automatic system capture', async () => {
    const ui = new QwenSettingsUI({ document: fakeDocument(), invoke: async () => ({
        ...devices, supports_system_device_selection: false,
    }) });
    ui.apply({ ...configured, qwen_system_device: 'old-windows-output' });
    await ui.refreshDevices();
    assert.equal(ui.read().qwen_system_device, '');
    assert.equal(ui.read().qwen_output_device, 'virtual-id');
});

test('missing capture devices and a microphone that receives our own translated output are rejected', async () => {
    const doc = fakeDocument();
    const ui = new QwenSettingsUI({ document: doc, invoke: async () => ({
        ...devices, inputs: [...devices.inputs, { id: 'virtual-id', name: '虚拟输入' }],
    }) });
    ui.apply({ ...configured, qwen_microphone_device: 'unplugged-mic' });
    await ui.refreshDevices();
    assert.throws(() => ui.read(), /麦克风已不可用/);
    doc.getElementById('select-qwen-microphone').value = 'virtual-id';
    assert.throws(() => ui.read(), /真实麦克风/);
    doc.getElementById('select-qwen-microphone').value = '';
    doc.getElementById('select-qwen-system-device').value = 'unplugged-headphones';
    doc.getElementById('check-qwen-duplex').checked = false;
    assert.throws(() => ui.read(), /播放设备已不可用/);
});

test('settings loading migrates an older profile and saves both directional dictionaries independently', async () => {
    let saved = { translation_mode: 'soniox', soniox_api_key: 'existing-test-key' };
    globalThis.window = { __TAURI__: { core: { invoke: async (command, args) => {
        if (command === 'get_settings') return structuredClone(saved);
        if (command === 'save_settings') saved = structuredClone(args.newSettings);
    } } } };
    const { settingsManager } = await import('../src/js/settings.js');
    await settingsManager.load();
    assert.equal(settingsManager.get().qwen_region, 'cn-beijing');
    assert.equal(settingsManager.get().qwen_duplex_enabled, true);
    assert.equal(settingsManager.get().qwen_output_device, '');
    await settingsManager.save({
        ...configured,
        qwen_glossary_outbound: { '产品名': 'ProductName' },
        qwen_glossary_inbound: { ProductName: '产品名称' },
    });
    await settingsManager.load();
    assert.equal(settingsManager.get().soniox_api_key, 'existing-test-key');
    assert.deepEqual(settingsManager.get().qwen_glossary_outbound, { '产品名': 'ProductName' });
    assert.deepEqual(settingsManager.get().qwen_glossary_inbound, { ProductName: '产品名称' });
});
