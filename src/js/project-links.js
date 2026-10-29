/** Links owned by this fork. Keep third-party model downloads separate. */
export const PROJECT_REPOSITORY = 'jintianzhouyine/my-translator';
export const PROJECT_URL = `https://github.com/${PROJECT_REPOSITORY}`;
export const PROJECT_ISSUES_URL = `${PROJECT_URL}/issues`;
export const PROJECT_RELEASES_URL = `${PROJECT_URL}/releases`;
export const LATEST_RELEASE_API = `https://api.github.com/repos/${PROJECT_REPOSITORY}/releases/latest`;

export async function openProjectUrl(url) {
    const openUrl = globalThis.window?.__TAURI__?.opener?.openUrl;
    if (openUrl) return openUrl(url);
    if (typeof globalThis.window?.open !== 'function') throw new Error('无法打开浏览器，请通过 GitHub 项目仓库查看发布版本。');
    globalThis.window.open(url, '_blank', 'noopener,noreferrer');
}
