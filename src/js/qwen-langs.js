// Qwen LiveTranslate Flash language list (60 entries).
//
// Mirrors my-translator-mobile/src/lib/languages.ts → QWEN_LANGS. Source is
// auto-detected by the model but Live Flash requires an explicit hint at
// session.update time — auto-detect stalls after a single segment on real
// mic input (verified iPhone v0.4.2, 2026-05-25). So the picker offers no
// "auto" entry when engine = qwen.
//
// Ordering: common-first (English → Vietnamese → Japanese → …), rest A-Z.

export const QWEN_LANGS = [
    { code: 'en', name: '英语' },
    { code: 'vi', name: '越南语' },
    { code: 'ja', name: '日语' },
    { code: 'ko', name: '韩语' },
    { code: 'zh', name: '中文' },
    { code: 'yue', name: '粤语' },
    { code: 'es', name: '西班牙语' },
    { code: 'fr', name: '法语' },
    { code: 'de', name: '德语' },
    { code: 'ru', name: '俄语' },
    { code: 'pt', name: '葡萄牙语' },
    { code: 'it', name: '意大利语' },
    { code: 'id', name: '印度尼西亚语' },
    { code: 'ms', name: '马来语' },
    { code: 'th', name: '泰语' },
    { code: 'hi', name: '印地语' },
    { code: 'ar', name: '阿拉伯语' },
    { code: 'tr', name: '土耳其语' },
    { code: 'nl', name: '荷兰语' },
    // A-Z rest
    { code: 'af', name: '南非荷兰语' },
    { code: 'ast', name: '阿斯图里亚斯语' },
    { code: 'az', name: '阿塞拜疆语' },
    { code: 'be', name: '白俄罗斯语' },
    { code: 'bg', name: '保加利亚语' },
    { code: 'bn', name: '孟加拉语' },
    { code: 'bs', name: '波斯尼亚语' },
    { code: 'ca', name: '加泰罗尼亚语' },
    { code: 'ceb', name: '宿务语' },
    { code: 'cs', name: '捷克语' },
    { code: 'da', name: '丹麦语' },
    { code: 'el', name: '希腊语' },
    { code: 'et', name: '爱沙尼亚语' },
    { code: 'fa', name: '波斯语' },
    { code: 'fi', name: '芬兰语' },
    { code: 'fil', name: '菲律宾语' },
    { code: 'gl', name: '加利西亚语' },
    { code: 'gu', name: '古吉拉特语' },
    { code: 'he', name: '希伯来语' },
    { code: 'hr', name: '克罗地亚语' },
    { code: 'hu', name: '匈牙利语' },
    { code: 'is', name: '冰岛语' },
    { code: 'jv', name: '爪哇语' },
    { code: 'kk', name: '哈萨克语' },
    { code: 'kn', name: '卡纳达语' },
    { code: 'ky', name: '吉尔吉斯语' },
    { code: 'lv', name: '拉脱维亚语' },
    { code: 'mk', name: '马其顿语' },
    { code: 'ml', name: '马拉雅拉姆语' },
    { code: 'mr', name: '马拉地语' },
    { code: 'nb', name: '挪威博克莫尔语' },
    { code: 'pa', name: '旁遮普语' },
    { code: 'pl', name: '波兰语' },
    { code: 'ro', name: '罗马尼亚语' },
    { code: 'sk', name: '斯洛伐克语' },
    { code: 'sl', name: '斯洛文尼亚语' },
    { code: 'sv', name: '瑞典语' },
    { code: 'sw', name: '斯瓦希里语' },
    { code: 'tg', name: '塔吉克语' },
    { code: 'uk', name: '乌克兰语' },
    { code: 'ur', name: '乌尔都语' },
];

export const QWEN_LANG_CODES = new Set(QWEN_LANGS.map((l) => l.code));
