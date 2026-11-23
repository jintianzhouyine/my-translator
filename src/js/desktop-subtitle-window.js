/** All recognition text goes through textContent, including in the native overlay. */
export function renderDesktopSubtitle(doc, payload = {}) {
    const original = typeof payload.original === 'string' ? payload.original : '';
    const translation = typeof payload.translation === 'string' ? payload.translation : '';
    const source = doc.getElementById('subtitle-original');
    const target = doc.getElementById('subtitle-translation');
    source.textContent = original;
    source.hidden = !original;
    target.textContent = translation;
    target.hidden = !translation;
    doc.getElementById('subtitle-speaker').textContent = typeof payload.speaker === 'string' ? payload.speaker : '';
    doc.getElementById('subtitle-empty').hidden = !!(original || translation);
    doc.getElementById('subtitle-lines').classList.toggle('bilingual', !!(original && translation));
}

export async function initDesktopSubtitleWindow({ doc = document, tauri = window.__TAURI__ } = {}) {
    const invoke = tauri.core.invoke;
    const appWindow = tauri.window.getCurrentWindow();
    let updateCount = 0;
    const hint = doc.getElementById('subtitle-hint');
    const reportError = error => { hint.textContent = `操作失败：${error.message || error}`; };
    await appWindow.listen('desktop-subtitle-update', event => {
        updateCount++;
        renderDesktopSubtitle(doc, event.payload);
    });
    const beforeRead = updateCount;
    try {
        const payload = await invoke('get_desktop_subtitle');
        // A newer pushed update takes precedence over a slow initial read.
        if (updateCount === beforeRead) renderDesktopSubtitle(doc, payload || {});
    } catch (error) { reportError(error); }

    doc.getElementById('subtitle-close').addEventListener('click', () => {
        void invoke('close_desktop_subtitle').catch(reportError);
    });
    doc.getElementById('desktop-subtitle').addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.target.closest('button')) return;
        void appWindow.startDragging().catch(reportError);
    });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    void initDesktopSubtitleWindow().catch(error => {
        document.getElementById('subtitle-hint').textContent = `字幕初始化失败：${error.message || error}`;
    });
}
