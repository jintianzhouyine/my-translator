import test from 'node:test';
import assert from 'node:assert/strict';

const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { resolve, reject, promise };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

test('concurrent settings patches merge at execution time instead of losing the selected engine', async () => {
    const requests = [];
    globalThis.window = { __TAURI__: { core: { invoke: async (name, args) => {
        if (name === 'get_settings') return { translation_mode: 'soniox' };
        const request = { ...deferred(), settings: args.newSettings };
        requests.push(request);
        await request.promise;
    } } } };
    const { settingsManager } = await import('../src/js/settings.js?concurrent-test');
    await settingsManager.load();
    const first = settingsManager.save({ translation_mode: 'qwen', engine_selection_completed: true });
    const second = settingsManager.save({ qwen_original_volume: 0.35 });
    await tick();
    assert.equal(requests.length, 1);
    requests[0].resolve();
    await first;
    await tick();
    assert.equal(requests[1].settings.translation_mode, 'qwen');
    assert.equal(requests[1].settings.engine_selection_completed, true);
    requests[1].resolve();
    await second;
    assert.equal(settingsManager.get().qwen_original_volume, 0.35);
    assert.equal(settingsManager.get().translation_mode, 'qwen');
});

test('a failed settings write does not poison subsequent saves or change the cached profile', async () => {
    let attempts = 0;
    globalThis.window = { __TAURI__: { core: { invoke: async (name) => {
        if (name === 'get_settings') return { translation_mode: 'soniox' };
        if (++attempts === 1) throw new Error('disk full');
    } } } };
    const { settingsManager } = await import('../src/js/settings.js?failed-test');
    await settingsManager.load();
    const failed = settingsManager.save({ translation_mode: 'qwen' });
    const second = settingsManager.save({ qwen_original_enabled: true });
    await assert.rejects(failed, /disk full/);
    await second;
    assert.equal(settingsManager.get().translation_mode, 'soniox');
    assert.equal(settingsManager.get().qwen_original_enabled, true);
});
