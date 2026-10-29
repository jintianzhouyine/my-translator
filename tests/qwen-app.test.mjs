import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';
import vm from 'node:vm';
import { QWEN_LANGS } from '../src/js/qwen-langs.js';
import { validateQwenCall } from '../src/js/qwen-call.js';
import { languageName } from '../src/js/locale.js';
import { QwenSettingsUI as RealQwenSettingsUI } from '../src/js/qwen-settings.js';

// Exercise the real controller without importing desktop-only dependencies or booting the app.
const source = readFileSync(new URL('../src/js/app.js', import.meta.url), 'utf8');
const classStart = source.indexOf('class App {');
const classEnd = source.lastIndexOf('// Initialize on DOM ready');
assert.ok(classStart >= 0 && classEnd > classStart, 'App class boundaries must be present');
const appClass = `${source.slice(classStart, classEnd)}\nApp;`;
const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

class Element {
    constructor() {
        this.value = '';
        this.style = { display: '' };
        this.dataset = {};
        this.disabled = false;
        this.checked = false;
        this.innerHTML = '';
        this.children = [];
        this.open = false;
        this.modalOpens = 0;
        const classes = new Set();
        this.classList = {
            contains: name => classes.has(name),
            toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
        };
        this.twoWayOption = { disabled: false };
    }
    querySelector(selector) { return selector === 'option[value="two_way"]' ? this.twoWayOption : null; }
    querySelectorAll() { return this.children || []; }
    get options() { return this.children; }
    addEventListener() {}
    setAttribute(name, value) { this[name] = value; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; this.value = ''; }
    showModal() { this.open = true; this.modalOpens++; }
    close() { this.open = false; }
}

const configured = {
    translation_mode: 'soniox', soniox_api_key: 'test-soniox', openai_api_key: 'test-openai',
    qwen_api_key: 'test-qwen', qwen_workspace_id: 'workspace-test', qwen_region: 'cn-beijing',
    qwen_duplex_enabled: true, qwen_my_language: 'zh', qwen_peer_language: 'en',
    qwen_output_device: 'virtual-output', qwen_glossary_outbound: {}, qwen_glossary_inbound: {},
    source_language: 'tl', target_language: 'cy', translation_type: 'two_way',
    language_a: 'ja', language_b: 'vi',
};

function fixture(initialSettings = {}) {
    let saved = { ...configured, ...initialSettings };
    const pendingSaves = [];
    const events = [];
    const started = [];
    const toasts = [];
    const chunks = [];
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
    };
    const pills = ['standard', 'qwen', 'openai'].map(engineClass => {
        const button = new Element();
        button.dataset.engineClass = engineClass;
        return button;
    });
    pills[0].classList.toggle('active', true);
    element('engine-pill').children = pills;
    element('section-qwen-options').style.display = 'none';
    element('select-translation-mode').value = 'soniox';
    element('select-translation-type').value = configured.translation_type;
    for (const [id, value] of [['select-source-lang', 'tl'], ['select-target-lang', 'cy']]) {
        element(id).innerHTML = html.match(new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`))[1];
        element(id).value = value;
    }
    const document = {
        getElementById: element,
        createElement: () => new Element(),
        querySelectorAll: selector => selector === '#engine-pill .engine-pill-btn' ? pills : [],
        querySelector: selector => selector === 'input[name="audio-source"]:checked' ? { value: 'system' } : null,
    };
    const settingsManager = {
        async load() { events.push('settings:load'); return { ...saved }; },
        onChange() {},
        get: () => ({ ...saved }),
        save(patch) {
            const pending = { ...deferred(), patch: structuredClone(patch) };
            pendingSaves.push(pending);
            events.push('settings:save');
            return pending.promise.then(() => { saved = { ...saved, ...patch }; });
        },
    };
    const App = vm.runInNewContext(appClass, {
        settingsManager, document, QWEN_LANGS, validateQwenCall, languageName,
        window: { __TAURI__: { core: {} } },
        TranscriptUI: class {
            configure() {}
            hasContent() { return false; }
        },
        QwenSettingsUI: class {
            init() { events.push('qwen-settings:init'); }
            apply(settings) { this.settings = { ...settings }; }
            setVisible(visible) { element('section-qwen-options').style.display = visible ? '' : 'none'; }
        },
        AudioFileTranslation: class {
            constructor() { this.busy = false; this.snapshot = { state: 'ready' }; }
            async start() { events.push('file:start'); }
            async cancel() { events.push('file:cancel'); }
        },
        AudioFileUI: class {
            constructor(options) { Object.assign(this, options); }
            init() {}
            onLeave() { events.push('file:pause-player'); }
            setSnapshot(snapshot) { this.snapshot = snapshot; }
        },
        getCurrentWindow: () => ({}),
        getActivity: () => 'live',
        console: { log() {}, error() {} },
        invoke: async command => { events.push(`invoke:${command}`); },
        sonioxClient: { disconnect() { events.push('soniox:disconnect'); } },
        elevenLabsTTS: { disconnect() {} }, edgeTTSRust: { disconnect() {} },
        googleTTS: {}, microsoftTTS: {}, googleFreeTTS: {}, tiktokTTS: {}, localTTS: {},
        audioPlayer: { init() {}, stop() { events.push('audio:stop'); } },
        initWindowModes() {},
        sessionStore: {
            init() { events.push('session:init'); },
            beginChunk: chunk => chunks.push(structuredClone(chunk)),
            endChunk() { events.push('session:end'); },
            async persist() { events.push('session:persist'); return 'skipped'; },
        },
    }, { filename: 'app-under-test.js' });
    const app = new App();
    app.isAppleSilicon = true;
    app.qwenSettingsUI = {
        setVisible: visible => { element('section-qwen-options').style.display = visible ? '' : 'none'; },
        read: () => Object.fromEntries(Object.entries(configured).filter(([key]) => key.startsWith('qwen_'))),
    };
    app.transcriptUI = {
        hasContent: () => false,
        showListening() {},
        clearProvisional() { events.push('transcript:clear-provisional'); },
    };
    app._showToast = (message, type) => toasts.push({ message, type });
    app._showView = view => events.push(`view:${view}`);
    app._showSettingsScreen = screen => events.push(`screen:${screen}`);
    app._updateSettingsCards = () => {};
    app._updateStatus = state => events.push(`status:${state}`);
    app._updateTranslationTypeUI = type => events.push(`translation-type:${type}`);
    for (const [method, mode] of [['_startQwenMode', 'qwen'], ['_startSonioxMode', 'soniox'], ['_startOpenAiMode', 'openai']]) {
        app[method] = async settings => started.push({ mode, settings: structuredClone(settings) });
    }
    return { app, element, document, pills, pendingSaves, started, toasts, chunks, events,
        saved: () => ({ ...saved }) };
}

function stubDesktopInitialization(app) {
    app._checkPlatformSupport = async () => {};
    app._bindEvents = () => {};
    app._bindCloseHooks = async () => {};
    app._bindKeyboardShortcuts = () => {};
    app._initReadMode = () => {};
    app._initAudioFileTranslation = () => {};
    app._initAboutTab = () => {};
    app._checkForUpdates = () => {};
}

test('cancelling file startup while live pause is pending never uploads after the pause resolves', async () => {
    const f = fixture();
    f.app._initAudioFileTranslation();
    f.app.isRunning = true;
    const paused = deferred();
    f.app.pause = () => paused.promise;
    const starting = f.app.audioFileUI.onStart({ targetLanguage: 'zh', glossaryDirection: 'none' });
    await nextTurn();
    await f.app.audioFileUI.onCancel();
    paused.resolve(); await starting;
    assert.ok(!f.events.includes('file:start'));
    assert.equal(f.app.audioFileUI.snapshot.message, '已取消启动，音频未上传。');
    assert.equal(f.app._isStartingAudioFile, false);
});

test('a running file task blocks live microphone capture and API startup', async () => {
    const f = fixture();
    f.app.audioFileTranslation = { busy: true };
    await f.app.start();
    assert.equal(f.started.length, 0);
    assert.equal(f.app.isRunning, false);
    assert.match(f.toasts[0].message, /音频文件正在处理/);
});

test('real App.init restores saved Qwen mode before the first settings visit or engine click', async () => {
    const f = fixture({ translation_mode: 'qwen' });
    stubDesktopInitialization(f.app);
    await f.app.init();
    assert.equal(f.element('live-lang').textContent, '中文 ↔ 英语');
    assert.equal(f.pills.find(button => button.dataset.engineClass === 'qwen').classList.contains('active'), true);
    assert.equal(f.pills.find(button => button.dataset.engineClass === 'standard').classList.contains('active'), false);
    for (const id of ['select-audio-source', 'section-audio-source', 'section-languages', 'btn-tts', 'btn-openai-audio']) {
        assert.equal(f.element(id).style.display, 'none', `${id} must be hidden for the saved Qwen mode`);
    }
    assert.equal(f.element('check-tts-enabled').disabled, true);
    assert.equal(f.element('section-qwen-options').style.display, '');
    assert.equal(f.app.qwenSettingsUI.settings.qwen_workspace_id, configured.qwen_workspace_id);
    assert.equal(f.pendingSaves.length, 0, 'restoring the UI must not rewrite settings');
    assert.equal(f.started.length, 0, 'restoring the UI must not start a paid session');
});

test('real App.init keeps legacy controls available when the saved engine is Soniox', async () => {
    const f = fixture();
    stubDesktopInitialization(f.app);
    await f.app.init();
    assert.equal(f.pills.find(button => button.dataset.engineClass === 'standard').classList.contains('active'), true);
    assert.equal(f.element('select-audio-source').style.display, '');
    assert.equal(f.element('section-languages').style.display, '');
    assert.equal(f.element('btn-tts').style.display, '');
    assert.equal(f.element('check-tts-enabled').disabled, false);
    assert.equal(f.element('section-qwen-options').style.display, 'none');
    assert.equal(f.pendingSaves.length, 0);
});

test('leaving settings cancels an in-flight glossary read before it can reopen the preview or replace hidden fields', async () => {
    const f = fixture({ translation_mode: 'qwen' });
    delete f.app._showView; // Exercise the real navigation method and real importer together.
    f.app.qwenSettingsUI = new RealQwenSettingsUI({ document: f.document,
        invoke: async () => assert.fail('navigation must not request audio or save settings') });
    f.app.qwenSettingsUI.apply({ qwen_glossary_outbound: { 原有: 'Original' }, qwen_glossary_inbound: { Original: '原有' } });
    f.element('settings-view').classList.toggle('active', true);
    const reading = deferred();
    const loading = f.app.qwenSettingsUI.glossaryImporter.loadFile({
        name: 'slow.txt', size: 32, arrayBuffer: () => reading.promise,
    }, 'outbound');
    assert.equal(f.element('qwen-glossary-import-status').textContent, '正在读取词表…');
    f.app._showView('overlay');
    assert.equal(f.element('settings-view').classList.contains('active'), false);
    assert.equal(f.element('overlay-view').classList.contains('active'), true);
    reading.resolve(new TextEncoder().encode('迟到词 = Late result').buffer);
    await loading;
    assert.equal(f.element('qwen-import-dialog').open, false);
    assert.equal(f.element('qwen-import-dialog').modalOpens, 0);
    assert.equal(f.app.qwenSettingsUI.glossaryImporter.pending, null);
    assert.equal(f.element('qwen-glossary-import-status').textContent, '');
    assert.equal(f.element('input-qwen-glossary-outbound').value, '原有 = Original');
    assert.equal(f.element('input-qwen-glossary-inbound').value, 'Original = 原有');
    assert.equal(f.pendingSaves.length, 0);
});

test('rapid engine clicks cannot queue competing saves and controls unlock after persistence', async () => {
    const f = fixture();
    const switching = f.app._selectEngineClass('qwen');
    assert.equal(f.element('btn-start').disabled, true);
    assert.ok(f.pills.every(button => button.disabled));
    assert.equal(f.app._selectEngineClass('standard'), undefined);
    assert.equal(f.pendingSaves.length, 1);
    assert.equal(f.saved().translation_mode, 'soniox');
    assert.equal(f.element('select-translation-mode').value, 'soniox');
    f.pendingSaves[0].resolve();
    assert.equal(await switching, true);
    assert.equal(f.saved().translation_mode, 'qwen');
    assert.equal(f.element('select-translation-mode').value, 'qwen');
    assert.equal(f.element('btn-start').disabled, false);
    assert.ok(f.pills.every(button => !button.disabled));

    const back = f.app._selectEngineClass('standard');
    f.pendingSaves[1].resolve();
    await back;
    assert.equal(f.saved().translation_mode, 'soniox');
});

test('starting during an engine save waits and launches only the newly persisted engine', async () => {
    const f = fixture();
    const switching = f.app._selectEngineClass('qwen');
    const starting = f.app.start();
    assert.equal(f.started.length, 0);
    assert.equal(f.chunks.length, 0);
    assert.equal(f.app.isRunning, false);
    f.pendingSaves[0].resolve();
    await Promise.all([switching, starting]);
    assert.deepEqual(f.started.map(call => call.mode), ['qwen']);
    assert.equal(f.started[0].settings.translation_mode, 'qwen');
    assert.deepEqual(f.chunks, [{ engine: 'qwen', sourceLang: 'en', targetLang: 'zh' }]);
    assert.ok(f.pills.every(button => button.disabled), 'running engine remains locked');
});

test('failed engine persistence restores the selected mode, reports the error and cancels a waiting start', async () => {
    const f = fixture();
    const switching = f.app._selectEngineClass('qwen');
    const starting = f.app.start();
    f.pendingSaves[0].reject(new Error('disk full'));
    assert.equal(await switching, false);
    await starting;
    assert.equal(f.saved().translation_mode, 'soniox');
    assert.equal(f.element('select-translation-mode').value, 'soniox');
    assert.equal(f.started.length, 0);
    assert.equal(f.chunks.length, 0);
    assert.equal(f.app.isRunning, false);
    assert.equal(f.element('btn-start').disabled, false);
    assert.ok(f.pills.every(button => !button.disabled));
    assert.match(f.toasts[0].message, /无法保存引擎设置.*disk full/);
    assert.equal(f.toasts[0].type, 'error');
    assert.equal(f.element('section-qwen-options').style.display, 'none');
});

test('Qwen round-trip preserves legacy language choices and two-way mode while toggling dedicated controls', async () => {
    const f = fixture();
    const sourceOptions = f.element('select-source-lang').innerHTML;
    const targetOptions = f.element('select-target-lang').innerHTML;
    const qwen = f.app._selectEngineClass('qwen');
    f.pendingSaves[0].resolve();
    await qwen;
    assert.equal(f.element('section-languages').style.display, 'none');
    assert.equal(f.element('section-audio-source').style.display, 'none');
    assert.equal(f.element('select-audio-source').style.display, 'none');
    assert.equal(f.element('section-qwen-options').style.display, '');
    assert.equal(f.element('select-translation-type').value, 'two_way');
    assert.equal(f.element('select-source-lang').innerHTML, sourceOptions);
    assert.equal(f.element('select-target-lang').innerHTML, targetOptions);
    const back = f.app._selectEngineClass('standard');
    f.pendingSaves[1].resolve();
    await back;
    assert.equal(f.element('select-source-lang').value, 'tl');
    assert.equal(f.element('select-target-lang').value, 'cy');
    assert.equal(f.element('select-translation-type').value, 'two_way');
    assert.equal(f.saved().translation_type, 'two_way');
    assert.equal(f.element('section-languages').style.display, '');
    assert.equal(f.element('section-audio-source').style.display, '');
    assert.equal(f.element('select-audio-source').style.display, '');
    assert.equal(f.element('section-qwen-options').style.display, 'none');
});

test('Qwen pause lets its controller drain capture before clearing or persisting subtitles', async () => {
    const f = fixture();
    const stopped = deferred();
    f.app.translationMode = 'qwen';
    f.app.isRunning = true;
    f.app.qwenCall = { stop: () => { f.events.push('qwen:stop'); return stopped.promise; } };
    const pausing = f.app.pause();
    assert.deepEqual(f.events, ['qwen:stop']);
    assert.equal(f.element('btn-start').disabled, true);
    stopped.resolve();
    await pausing;
    assert.ok(!f.events.includes('invoke:stop_capture'), 'legacy stop would deliver a premature native stop marker');
    assert.ok(f.events.indexOf('qwen:stop') < f.events.indexOf('transcript:clear-provisional'));
    assert.ok(f.events.indexOf('qwen:stop') < f.events.indexOf('session:persist'));
    assert.equal(f.app.isRunning, false);
    assert.equal(f.element('btn-start').disabled, false);
});

test('saving a running Qwen configuration waits for pause and reports a failed settings write without leaving the form', async () => {
    const f = fixture();
    const paused = deferred();
    f.app.isRunning = true;
    f.app.translationMode = 'qwen';
    f.element('select-translation-mode').value = 'qwen';
    f.app.pause = () => { f.events.push('qwen:pause'); return paused.promise; };
    const saving = f.app._saveSettingsFromForm();
    assert.deepEqual(f.events, ['qwen:pause']);
    assert.equal(f.pendingSaves.length, 0);
    paused.resolve();
    await nextTurn(); // Drain the cross-VM promise adoption before observing the write.
    assert.equal(f.pendingSaves.length, 1);
    assert.equal(f.pendingSaves[0].patch.translation_mode, 'qwen');
    assert.equal(f.pendingSaves[0].patch.translation_type, 'two_way');
    assert.equal(f.pendingSaves[0].patch.source_language, 'tl');
    assert.equal(f.pendingSaves[0].patch.target_language, 'cy');
    f.pendingSaves[0].reject(new Error('disk full'));
    await saving;
    assert.ok(!f.events.includes('view:overlay'));
    assert.equal(f.toasts.length, 1);
    assert.equal(f.toasts[0].type, 'error');
    assert.match(f.toasts[0].message, /保存失败.*disk full/);
});


test('live bilingual preference saves only display content without pausing a running call', async () => {
    const f = fixture({ show_original: true });
    f.app.isRunning = true;
    f.app.pause = () => { throw new Error('display-only change must not pause capture'); };
    const configurations = [];
    f.app.transcriptUI.configure = settings => configurations.push(settings);
    const save = f.app._setShowOriginal(false);
    assert.deepEqual(f.pendingSaves[0].patch, { show_original: false });
    assert.equal(f.element('btn-bilingual-subtitles').disabled, true);
    f.pendingSaves[0].resolve();
    await save;
    assert.equal(f.saved().show_original, false);
    assert.equal(f.element('check-show-original').checked, false);
    assert.equal(f.element('btn-bilingual-subtitles')['aria-pressed'], 'false');
    assert.equal(f.element('btn-bilingual-subtitles').disabled, false);
    assert.equal(configurations.at(-1).showOriginal, false);
    assert.equal(f.app.isRunning, true);
});

test('failed bilingual preference save restores the previous control state', async () => {
    const f = fixture({ show_original: true });
    f.app.transcriptUI.configure = () => {};
    f.element('check-show-original').checked = false;
    const save = f.app._setShowOriginal(false);
    f.pendingSaves[0].reject(new Error('disk full'));
    await save;
    assert.equal(f.saved().show_original, true);
    assert.equal(f.element('check-show-original').checked, true);
    assert.equal(f.element('btn-bilingual-subtitles').disabled, false);
    assert.match(f.toasts.at(-1).message, /字幕设置保存失败.*disk full/);
});

test('display-only notification preserves narration and does not reconfigure audio routing', () => {
    const f = fixture({ show_original: true });
    f.app._appliedSettings = f.saved();
    f.app.ttsEnabled = true;
    f.app.transcriptUI.configure = () => {};
    f.app._updateSourceButtons = () => { throw new Error('must not reconfigure audio'); };
    f.app._updateTTSButton = () => { throw new Error('must not reset narration'); };
    f.app._applySettings({ ...f.saved(), show_original: false });
    assert.equal(f.app.ttsEnabled, true);
    assert.equal(f.element('check-show-original').checked, false);
});
