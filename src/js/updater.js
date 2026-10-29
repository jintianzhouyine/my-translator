/** Check this fork's published releases; installation is performed by the user. */
import { LATEST_RELEASE_API, PROJECT_URL, openProjectUrl } from './project-links.js';

function parseVersion(value) {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value));
    if (!match) throw new Error(`无法识别版本号：${value}`);
    return { numbers: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split('.') || [] };
}

/** Positive when candidate is newer. Build metadata does not affect precedence. */
export function compareVersions(candidate, current) {
    const a = parseVersion(candidate), b = parseVersion(current);
    for (let index = 0; index < 3; index++) {
        if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
    }
    if (!a.prerelease.length || !b.prerelease.length) return Number(!a.prerelease.length) - Number(!b.prerelease.length);
    for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
        const x = a.prerelease[index], y = b.prerelease[index];
        if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
        if (x === y) continue;
        const xNumeric = /^\d+$/.test(x), yNumeric = /^\d+$/.test(y);
        if (xNumeric && yNumeric) return BigInt(x) > BigInt(y) ? 1 : -1;
        if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
        return x > y ? 1 : -1;
    }
    return 0;
}

export async function getAppVersion() {
    const app = globalThis.window?.__TAURI__?.app;
    const invoke = globalThis.window?.__TAURI__?.core?.invoke;
    if (!app?.getVersion && !invoke) throw new Error('当前环境无法读取应用版本，请在桌面应用中检查更新。');
    const version = await (app?.getVersion ? app.getVersion() : invoke('plugin:app|version'));
    parseVersion(version);
    return version;
}

export class Updater {
    constructor({ fetchRelease = (...args) => globalThis.fetch(...args), getVersion = getAppVersion,
        openUrl = openProjectUrl, timeoutMs = 15000 } = {}) {
        this.fetchRelease = fetchRelease;
        this.getVersion = getVersion;
        this.openUrl = openUrl;
        this.timeoutMs = timeoutMs;
        this.updateAvailable = null;
        this.onUpdateFound = null;
        this.onCheckComplete = null; // callback(hasUpdate, error); failure is not "up to date".
        this.onError = null;
        this._checking = null;
    }

    checkForUpdates() {
        if (this._checking) return this._checking;
        this._checking = this._check().finally(() => { this._checking = null; });
        return this._checking;
    }

    async _check() {
        this.updateAvailable = null;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const currentVersion = await this.getVersion();
            parseVersion(currentVersion);
            const response = await this.fetchRelease(LATEST_RELEASE_API, {
                headers: { Accept: 'application/vnd.github+json' },
                cache: 'no-store', signal: controller.signal,
            });
            if (response.status === 403 || response.status === 429) throw new Error('GitHub 暂时限制了请求，请稍后重试。');
            if (response.status === 404) throw new Error('当前仓库尚无可用的正式发布版本。');
            if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}，请稍后重试。`);
            const release = await response.json();
            if (!release || typeof release !== 'object' || release.draft || release.prerelease || !/^v?\d+\.\d+\.\d+$/.test(release.tag_name || '')) {
                throw new Error('GitHub 返回的正式版本信息无效。');
            }
            if (compareVersions(release.tag_name, currentVersion) > 0) {
                this.updateAvailable = {
                    version: release.tag_name.replace(/^v/, ''),
                    body: typeof release.body === 'string' ? release.body : '',
                    url: `${PROJECT_URL}/releases/tag/${encodeURIComponent(release.tag_name)}`,
                };
                this.onUpdateFound?.(this.updateAvailable.version, this.updateAvailable.body);
            }
            this.onCheckComplete?.(Boolean(this.updateAvailable), null);
            return this.updateAvailable;
        } catch (error) {
            const reported = controller.signal.aborted
                ? new Error('连接 GitHub 超时，请检查网络后重试。')
                : error instanceof Error ? error : new Error(String(error));
            this.onError?.(reported);
            this.onCheckComplete?.(false, reported);
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    async openReleasePage() {
        if (!this.updateAvailable) throw new Error('请先检查是否有新版本。');
        await this.openUrl(this.updateAvailable.url);
    }
}

export const updater = new Updater();
