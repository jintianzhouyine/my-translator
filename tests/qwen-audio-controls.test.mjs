import test from 'node:test';
import assert from 'node:assert/strict';
import { QwenAudioControls, readQwenMix } from '../src/js/qwen-audio-controls.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { resolve, reject, promise };
};
function fixture({ save, apply, initial = {} } = {}) {
    let settings = { translation_mode: 'qwen', qwen_duplex_enabled: true, ...initial };
    const elements = new Map(), writes = [], mixes = [], errors = [];
    const element = id => {
        if (!elements.has(id)) elements.set(id, { addEventListener() {} });
        return elements.get(id);
    };
    const ui = new QwenAudioControls({ document: { getElementById: element },
        getSettings: () => ({ ...settings }),
        saveSettings: async patch => {
            writes.push(patch);
            if (save) await save(patch);
            settings = { ...settings, ...patch };
            ui.apply(settings); // Matches the real SettingsManager notification order.
        },
        applyMix: async mix => { mixes.push(mix); if (apply) await apply(mix); },
        onError: error => errors.push(error), saveDelayMs: 60_000,
    });
    ui.init();
    return { ui, element, writes, mixes, errors };
}

test('restores independent switches/volumes without touching audio; hides controls outside duplex Qwen', () => {
    const f = fixture({ initial: { qwen_original_enabled: true, qwen_original_volume: 0.35,
        qwen_translated_enabled: false, qwen_translated_volume: 0.8 } });
    assert.equal(f.element('check-qwen-original').checked, true);
    assert.equal(f.element('range-qwen-original').value, '35');
    assert.equal(f.element('check-qwen-translated').checked, false);
    assert.equal(f.element('range-qwen-translated').value, '80');
    assert.equal(f.element('qwen-audio-controls').hidden, false);
    assert.equal(f.mixes.length, 0);
    assert.equal(f.writes.length, 0);
    f.ui.apply({ translation_mode: 'qwen', qwen_duplex_enabled: false });
    assert.equal(f.element('qwen-audio-controls').hidden, true);
    f.ui.apply({ translation_mode: 'soniox' });
    assert.equal(f.element('qwen-audio-controls').hidden, true);
});

test('rapid slider changes reach the live mixer and persist only the latest independent volumes', async () => {
    const f = fixture();
    f.ui.change({ originalVolume: 0.2 });
    f.ui.change({ originalVolume: 0.3 });
    f.ui.change({ translatedVolume: 0.7 });
    await f.ui.flush();
    assert.equal(f.mixes.length, 1);
    assert.equal(f.mixes[0].originalVolume, 0.3);
    assert.equal(f.mixes[0].translatedVolume, 0.7);
    assert.deepEqual(f.writes, [{ qwen_original_enabled: false, qwen_original_volume: 0.3,
        qwen_translated_enabled: true, qwen_translated_volume: 0.7 }]);
});

test('a brief mute or zero volume is never coalesced away before re-enabling', async () => {
    const f = fixture();
    f.ui.change({ translatedEnabled: false });
    f.ui.change({ translatedEnabled: true });
    await f.ui.flush();
    assert.deepEqual(f.mixes.map(mix => mix.translatedEnabled), [false, true]);
    f.ui.change({ translatedVolume: 0 });
    f.ui.change({ translatedVolume: 0.8 });
    await f.ui.flush();
    assert.deepEqual(f.mixes.slice(2).map(mix => mix.translatedVolume), [0, 0.8]);
});

test('a pending disk write cannot overwrite newer live controls and the next flush saves them', async () => {
    const pending = deferred();
    let count = 0;
    const f = fixture({ save: () => ++count === 1 ? pending.promise : undefined });
    f.ui.change({ originalEnabled: true });
    const first = f.ui.flush();
    await tick();
    f.ui.change({ originalVolume: 0.2, translatedEnabled: false });
    pending.resolve();
    await first;
    assert.equal(f.element('range-qwen-original').value, '20');
    assert.equal(f.element('check-qwen-translated').checked, false);
    await f.ui.flush();
    assert.equal(f.writes.at(-1).qwen_original_volume, 0.2);
    assert.equal(f.writes.at(-1).qwen_translated_enabled, false);
});

test('save failures preserve the actual live mix, report an error and allow a later retry', async () => {
    let failed = false;
    const f = fixture({ save: () => { if (!failed) { failed = true; throw new Error('disk full'); } } });
    await f.ui.change({ originalEnabled: true, translatedEnabled: false });
    await f.ui.flush();
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0], /disk full/);
    assert.equal(f.ui.settings().qwen_translated_enabled, false);
    await f.ui.flush();
    assert.equal(f.writes.length, 2);
});

test('bad stored volume values are finite and bounded, including exact silence', () => {
    assert.deepEqual(readQwenMix({ qwen_original_volume: NaN, qwen_translated_volume: 0 }),
        { originalEnabled: false, originalVolume: 1, translatedEnabled: true, translatedVolume: 0 });
    assert.equal(readQwenMix({ qwen_original_volume: -1 }).originalVolume, 0);
    assert.equal(readQwenMix({ qwen_translated_volume: 8 }).translatedVolume, 1);
});
