import {
    DESKTOP_SUBTITLE_FONT_FAMILIES, normalizeDesktopSubtitleAppearance, desktopSubtitleTextLayout,
} from './desktop-subtitle-appearance.js';

function applyAppearance(doc, payload) {
    const appearance = normalizeDesktopSubtitleAppearance(payload.appearance);
    const root = doc.getElementById('desktop-subtitle');
    const lines = doc.getElementById('subtitle-lines');
    const rootStyle = doc.defaultView?.getComputedStyle?.(root);
    const topPadding = Number.parseFloat(rootStyle?.paddingTop) || 30;
    const bottomPadding = Number.parseFloat(rootStyle?.paddingBottom) || 12;
    const availableHeight = (root.clientHeight || 178) - topPadding - bottomPadding;
    const layout = desktopSubtitleTextLayout({ fontSize: appearance.fontSize, availableHeight,
        bilingual: !!(payload.original && payload.translation) });
    lines.classList.toggle('one-line', layout.lines === 1);
    lines.style.opacity = String(appearance.opacity);
    for (const [name, value] of Object.entries({
        '--subtitle-font-family': DESKTOP_SUBTITLE_FONT_FAMILIES[appearance.fontFamily],
        '--subtitle-font-size': `${layout.fontSize}px`,
        '--subtitle-source-font-size': `${layout.sourceFontSize}px`,
        '--subtitle-line-clamp': String(layout.lines),
        '--subtitle-line-gap': `${layout.gap}px`,
        '--subtitle-font-color': appearance.color,
        '--subtitle-font-weight': appearance.bold ? '700' : '400',
        '--subtitle-font-style': appearance.italic ? 'italic' : 'normal',
    })) lines.style.setProperty(name, value);
}

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
    const locked = payload.locked === true;
    doc.getElementById('desktop-subtitle').classList.toggle('is-locked', locked);
    doc.getElementById('subtitle-controls').hidden = locked;
    doc.getElementById('subtitle-lock').disabled = locked;
    applyAppearance(doc, payload);
}

export async function initDesktopSubtitleWindow({ doc = document, tauri = window.__TAURI__ } = {}) {
    const invoke = tauri.core.invoke;
    const appWindow = tauri.window.getCurrentWindow();
    let updateCount = 0;
    let currentPayload = {};
    let locking = false;
    const render = payload => {
        currentPayload = payload || {};
        renderDesktopSubtitle(doc, currentPayload);
    };
    const hint = doc.getElementById('subtitle-hint');
    const reportError = error => { hint.textContent = `操作失败：${error.message || error}`; };
    await appWindow.listen('desktop-subtitle-update', event => {
        updateCount++;
        render(event.payload);
    });
    const beforeRead = updateCount;
    try {
        const payload = await invoke('get_desktop_subtitle');
        // A newer pushed update takes precedence over a slow initial read.
        if (updateCount === beforeRead) render(payload);
    } catch (error) { reportError(error); }

    doc.getElementById('subtitle-close').addEventListener('click', () => {
        if (currentPayload.locked === true) return;
        void invoke('close_desktop_subtitle').catch(reportError);
    });
    doc.getElementById('subtitle-lock').addEventListener('click', async () => {
        if (currentPayload.locked === true || locking) return;
        locking = true;
        const button = doc.getElementById('subtitle-lock');
        button.disabled = true;
        try { await invoke('lock_desktop_subtitle'); }
        catch (error) { reportError(error); }
        finally { locking = false; button.disabled = currentPayload.locked === true; }
    });
    doc.getElementById('desktop-subtitle').addEventListener('pointerdown', event => {
        if (currentPayload.locked === true || event.button !== 0 || event.target.closest('button')) return;
        void appWindow.startDragging().catch(reportError);
    });
    doc.defaultView?.addEventListener?.('resize', () => renderDesktopSubtitle(doc, currentPayload));
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    void initDesktopSubtitleWindow().catch(error => {
        document.getElementById('subtitle-hint').textContent = `字幕初始化失败：${error.message || error}`;
    });
}
