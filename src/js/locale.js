// Display labels only. Keep language codes and voice IDs unchanged for APIs.
const languageNames = typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['zh-CN'], { type: 'language' })
    : null;

export function languageName(code) {
    if (!code || code === 'auto') return '自动检测';
    try {
        return languageNames?.of(code) || code;
    } catch {
        return code;
    }
}

export function genderName(gender) {
    return { Female: '女声', Male: '男声' }[gender] || gender;
}

export function voiceDisplayName(name) {
    return String(name)
        .replace('Tiếng Việt', '越南语')
        .replace('English (US)', '英语（美国）')
        .replace('(medium)', '（中等品质）')
        .replace('(low)', '（基础品质）')
        .replace('(custom)', '（自定义）');
}
