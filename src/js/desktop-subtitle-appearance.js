export const DESKTOP_SUBTITLE_FONT_FAMILIES = Object.freeze({
    system: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
    sans: 'Arial, "Helvetica Neue", "Microsoft YaHei", sans-serif',
    serif: 'Georgia, "Times New Roman", "Songti SC", "SimSun", serif',
    mono: '"SFMono-Regular", Consolas, "Liberation Mono", "Microsoft YaHei", monospace',
});

function bounded(value, fallback, min, max) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Normalize the IPC appearance too; font strings and colors never become arbitrary CSS. */
export function normalizeDesktopSubtitleAppearance(appearance = {}) {
    const value = appearance && typeof appearance === 'object' ? appearance : {};
    return {
        opacity: bounded(value.opacity, 1, 0.2, 1),
        fontFamily: Object.hasOwn(DESKTOP_SUBTITLE_FONT_FAMILIES, value.fontFamily) ? value.fontFamily : 'system',
        fontSize: Math.round(bounded(value.fontSize, 32, 16, 64)),
        color: typeof value.color === 'string' && /^#[\da-f]{6}$/i.test(value.color) ? value.color.toLowerCase() : '#fff4a8',
        bold: value.bold !== false,
        italic: value.italic === true,
    };
}

export function readDesktopSubtitleAppearance(settings = {}) {
    return normalizeDesktopSubtitleAppearance({
        opacity: settings.desktop_subtitle_opacity,
        fontFamily: settings.desktop_subtitle_font_family,
        fontSize: settings.desktop_subtitle_font_size,
        color: settings.desktop_subtitle_font_color,
        bold: settings.desktop_subtitle_font_bold,
        italic: settings.desktop_subtitle_font_italic,
    });
}

/** Prefer fewer complete lines before reducing an oversized font to fit the window. */
export function desktopSubtitleTextLayout({ fontSize = 32, availableHeight = 136, bilingual = false } = {}) {
    const requestedSize = bounded(fontSize, 32, 16, 64);
    const height = typeof availableHeight === 'number' && Number.isFinite(availableHeight) ? Math.max(1, availableHeight) : 136;
    const sourceRatio = bilingual ? 0.78 : 0;
    const gap = bilingual ? Math.min(5, height / 10) : 0;
    let lines = 2;
    if (requestedSize * 1.32 * (lines + sourceRatio) + gap > height) lines = 1;
    const size = Math.min(requestedSize, (height - gap) / (1.32 * (lines + sourceRatio)));
    return { fontSize: size, sourceFontSize: size * 0.78, lines, gap };
}
