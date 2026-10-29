import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Updater, compareVersions, getAppVersion } from '../src/js/updater.js';
import { LATEST_RELEASE_API, PROJECT_URL, PROJECT_ISSUES_URL } from '../src/js/project-links.js';

const release = (tag = 'v0.10.4', overrides = {}) => ({ tag_name: tag, body: '发布说明', draft: false, prerelease: false, ...overrides });
const response = data => ({ ok: true, status: 200, json: async () => data });
const makeUpdater = (options = {}) => new Updater({ getVersion: async () => '0.10.3', fetchRelease: async () => response(release()), ...options });

test('release comparison handles numeric components, stable promotion and build metadata', () => {
    assert.equal(compareVersions('v0.10.3', '0.9.9'), 1);
    assert.equal(compareVersions('0.10.3', '0.10.3+local'), 0);
    assert.equal(compareVersions('v0.10.3', '0.10.4'), -1);
    assert.equal(compareVersions('0.10.4', '0.10.4-rc.1'), 1);
    assert.equal(compareVersions('0.10.4-rc.10', '0.10.4-rc.2'), 1);
    assert.throws(() => compareVersions('banana', '0.10.3'), /无法识别版本号/);
});

test('checks only this fork and opens the release page without installing or using an API-provided URL', async () => {
    const opened = [], checks = [], calls = [];
    const updater = makeUpdater({
        fetchRelease: async (url, options) => {
            calls.push({ url, options });
            return response(release('v0.10.4', { html_url: 'https://unrelated.example/download' }));
        },
        openUrl: async url => opened.push(url),
    });
    updater.onUpdateFound = (version, notes) => checks.push([version, notes]);
    assert.equal((await updater.checkForUpdates()).version, '0.10.4');
    assert.equal(calls[0].url, LATEST_RELEASE_API);
    assert.equal(calls[0].options.cache, 'no-store');
    assert.equal(calls[0].options.signal.aborted, false);
    assert.deepEqual(checks, [['0.10.4', '发布说明']]);
    await updater.openReleasePage();
    assert.deepEqual(opened, [`${PROJECT_URL}/releases/tag/v0.10.4`]);
});

test('equal or older remote releases never offer an update or a downgrade', async () => {
    for (const tag of ['v0.10.3', 'v0.9.9']) {
        const updater = makeUpdater({ fetchRelease: async () => response(release(tag)) });
        const completed = [];
        updater.onCheckComplete = (...args) => completed.push(args);
        assert.equal(await updater.checkForUpdates(), null);
        assert.deepEqual(completed, [[false, null]]);
        await assert.rejects(updater.openReleasePage(), /请先检查/);
    }
});

test('network failures clear a previously found release and are distinguishable from up-to-date', async () => {
    let failing = false;
    const updater = makeUpdater({ fetchRelease: async () => {
        if (failing) throw new Error('network unavailable');
        return response(release());
    } });
    await updater.checkForUpdates();
    failing = true;
    const errors = [], completed = [];
    updater.onError = error => errors.push(error);
    updater.onCheckComplete = (...args) => completed.push(args);
    assert.equal(await updater.checkForUpdates(), null);
    assert.equal(updater.updateAvailable, null);
    assert.equal(errors[0].message, 'network unavailable');
    assert.equal(completed[0][0], false);
    assert.equal(completed[0][1], errors[0]);
});

test('rate limits, missing releases and server failures produce actionable errors', async () => {
    for (const [status, expected] of [[403, /限制/], [429, /限制/], [404, /尚无/], [502, /HTTP 502/]]) {
        const updater = makeUpdater({ fetchRelease: async () => ({ ok: false, status }) });
        let error;
        updater.onError = value => { error = value; };
        await updater.checkForUpdates();
        assert.match(error.message, expected);
    }
});

test('draft, prerelease, malformed versions and invalid JSON are not presented as a successful check', async () => {
    const cases = [release('v0.10.4', { draft: true }), release('v0.10.4', { prerelease: true }), release('next'), null];
    for (const data of cases) {
        const updater = makeUpdater({ fetchRelease: async () => response(data) });
        let completion;
        updater.onCheckComplete = (...args) => { completion = args; };
        await updater.checkForUpdates();
        assert.equal(completion[0], false);
        assert.ok(completion[1] instanceof Error);
    }
});

test('aborts a slow release request and permits retry', async () => {
    let calls = 0;
    const updater = makeUpdater({ timeoutMs: 10, fetchRelease: async (_url, { signal }) => {
        calls++;
        if (calls > 1) return response(release());
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    } });
    let error;
    updater.onError = value => { error = value; };
    assert.equal(await updater.checkForUpdates(), null);
    assert.match(error.message, /超时/);
    assert.equal((await updater.checkForUpdates()).version, '0.10.4');
});

test('repeated checks reuse the pending request', async () => {
    let complete, calls = 0;
    const updater = makeUpdater({ fetchRelease: async () => {
        calls++;
        return new Promise(resolve => { complete = resolve; });
    } });
    const first = updater.checkForUpdates();
    const second = updater.checkForUpdates();
    assert.equal(first, second);
    await Promise.resolve();
    complete(response(release()));
    await first;
    assert.equal(calls, 1);
});

test('reads the installed version from the desktop API and falls back only to the native version command', async () => {
    const original = globalThis.window;
    try {
        globalThis.window = { __TAURI__: { app: { getVersion: async () => '0.10.5' } } };
        assert.equal(await getAppVersion(), '0.10.5');
        globalThis.window = { __TAURI__: { core: { invoke: async command => { assert.equal(command, 'plugin:app|version'); return '0.10.6'; } } } };
        assert.equal(await getAppVersion(), '0.10.6');
        globalThis.window = {};
        await assert.rejects(getAppVersion(), /无法读取应用版本/);
    } finally { globalThis.window = original; }
});

const source = readFileSync(new URL('../src/js/app.js', import.meta.url), 'utf8');
const appClass = source.slice(source.indexOf('class App {'), source.lastIndexOf('// Initialize on DOM ready')) + '\nApp;';
function uiFixture(updater = makeUpdater()) {
    const elements = new Map(), opened = [], timers = [];
    const element = id => {
        if (!elements.has(id)) {
            const classes = new Set();
            elements.set(id, { textContent: '', style: {}, disabled: false, handlers: {},
                classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
                addEventListener(name, handler) { this.handlers[name] = handler; },
            });
        }
        return elements.get(id);
    };
    const App = vm.runInNewContext(appClass, {
        updater, PROJECT_URL, PROJECT_ISSUES_URL, getAppVersion: async () => '0.10.3',
        openProjectUrl: async url => opened.push(url),
        document: { getElementById: element, querySelector: () => null },
        setTimeout: callback => timers.push(callback),
    });
    const app = Object.create(App.prototype);
    app._showToast = () => {};
    return { app, element, opened, timers };
}

test('update UI preserves a failed check instead of replacing it with latest-version success', async () => {
    const { app, element } = uiFixture(makeUpdater({ fetchRelease: async () => { throw new Error('offline'); } }));
    await app._checkForUpdates();
    app._pendingUpdateVersion = '0.10.4';
    await app._triggerUpdateCheck();
    assert.match(element('update-status-text').textContent, /检查更新失败：offline/);
    assert.equal(element('btn-check-update').disabled, false);
    assert.equal(element('btn-check-update').classList.contains('spinning'), false);
    assert.equal(element('update-actions').style.display, 'none');
    assert.equal(app._pendingUpdateVersion, null);
});

test('successful no-update check clears stale actions and shows current-version status', async () => {
    const { app, element } = uiFixture(makeUpdater({ fetchRelease: async () => response(release('v0.10.3')) }));
    await app._checkForUpdates();
    app._pendingUpdateVersion = '0.10.4';
    await app._triggerUpdateCheck();
    assert.match(element('update-status-text').textContent, /当前已是最新版本/);
    assert.equal(element('update-actions').style.display, 'none');
    assert.equal(element('settings-badge').style.display, 'none');
});

test('about links use the current fork and display the actual version', async () => {
    const { app, element, opened } = uiFixture();
    app._initAboutTab();
    await Promise.resolve();
    assert.equal(element('about-version').textContent, 'v0.10.3');
    for (const [id, url] of [['link-github', PROJECT_URL], ['link-issues', PROJECT_ISSUES_URL]]) {
        assert.equal(element(id).href, url);
        await element(id).handlers.click({ preventDefault() {} });
    }
    assert.deepEqual(opened, [PROJECT_URL, PROJECT_ISSUES_URL]);
});
