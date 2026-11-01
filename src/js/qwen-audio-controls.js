const FIELDS = ['qwen_original_enabled', 'qwen_original_volume', 'qwen_translated_enabled', 'qwen_translated_volume'];

function volume(value) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

export function readQwenMix(settings = {}) {
    return {
        originalEnabled: settings.qwen_original_enabled === true,
        originalVolume: volume(settings.qwen_original_volume),
        translatedEnabled: settings.qwen_translated_enabled !== false,
        translatedVolume: volume(settings.qwen_translated_volume),
    };
}

export function mixSettings(mix) {
    return {
        qwen_original_enabled: mix.originalEnabled,
        qwen_original_volume: mix.originalVolume,
        qwen_translated_enabled: mix.translatedEnabled,
        qwen_translated_volume: mix.translatedVolume,
    };
}

export function isQwenMixSetting(key) { return FIELDS.includes(key); }

/** Live output controls. Input changes affect audio immediately; writes are coalesced. */
export class QwenAudioControls {
    constructor({ document: doc = globalThis.document, getSettings, saveSettings, applyMix,
        onError = () => {}, saveDelayMs = 200 }) {
        Object.assign(this, { document: doc, getSettings, saveSettings, applyMix, onError, saveDelayMs });
        this.mix = readQwenMix(getSettings());
        this._revision = 0;
        this._savedRevision = 0;
        this._audioTail = Promise.resolve();
        this._saveTail = Promise.resolve();
    }

    _element(id) { return this.document.getElementById(id); }

    init() {
        for (const source of ['original', 'translated']) {
            this._element(`check-qwen-${source}`)?.addEventListener('change', event => {
                this.change({ [`${source}Enabled`]: event.target.checked });
            });
            this._element(`range-qwen-${source}`)?.addEventListener('input', event => {
                this.change({ [`${source}Volume`]: Number(event.target.value) / 100 });
            });
        }
        this.apply(this.getSettings());
    }

    apply(settings) {
        if (this._revision === this._savedRevision) this.mix = readQwenMix(settings);
        this.setVisible(settings.translation_mode === 'qwen' && settings.qwen_duplex_enabled !== false);
        this._render();
    }

    setVisible(visible) {
        const panel = this._element('qwen-audio-controls');
        if (panel) panel.hidden = !visible;
    }

    settings() { return mixSettings(this.mix); }

    _render() {
        for (const source of ['original', 'translated']) {
            const enabled = this.mix[`${source}Enabled`];
            const percent = Math.round(this.mix[`${source}Volume`] * 100);
            const toggle = this._element(`check-qwen-${source}`);
            const slider = this._element(`range-qwen-${source}`);
            const label = this._element(`value-qwen-${source}`);
            if (toggle) toggle.checked = enabled;
            if (slider) slider.value = String(percent);
            if (label) label.textContent = `${percent}%`;
        }
        const status = this._element('qwen-mix-status');
        if (status) status.textContent = !this.mix.originalEnabled && !this.mix.translatedEnabled
            ? '发给对方的声音已关闭；识别和字幕继续。'
            : this.mix.originalEnabled && this.mix.translatedEnabled
                ? '原声和译音一起发给对方；译音稍后到达，可能与原声重叠。'
                : this.mix.originalEnabled ? '将你的麦克风原声发给对方。' : '将翻译后的语音发给对方。';
    }

    change(patch) {
        this.mix = readQwenMix(mixSettings({ ...this.mix, ...patch }));
        const revision = ++this._revision;
        const mix = { ...this.mix };
        // A brief mute must still flush stale speech, even if another change follows immediately.
        const preserve = Object.hasOwn(patch, 'originalEnabled') || Object.hasOwn(patch, 'translatedEnabled')
            || mix.originalVolume === 0 || mix.translatedVolume === 0;
        this._render();
        this._audioTail = this._audioTail.then(async () => {
            // Skip intermediate slider positions if the native command is still pending.
            if (revision !== this._revision && !preserve) return;
            try { await this.applyMix(mix); }
            catch (error) { this.onError(`声音调整失败：${error.message || error}`); }
        });
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => { void this.flush(); }, this.saveDelayMs);
        return this._audioTail;
    }

    async flush() {
        clearTimeout(this._saveTimer);
        this._saveTail = this._saveTail.then(async () => {
            const revision = this._revision;
            if (revision === this._savedRevision) return;
            try {
                await this.saveSettings(this.settings());
                this._savedRevision = revision;
            } catch (error) {
                // Keep the visible controls consistent with the actual live mix.
                this.onError(`音量设置保存失败：${error.message || error}；本次通话仍按当前音量输出。`);
            }
        });
        await Promise.all([this._audioTail, this._saveTail]);
    }
}
