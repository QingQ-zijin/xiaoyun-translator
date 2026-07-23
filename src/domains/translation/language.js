import { detectByScript } from '../../utils/lang_detect';

const LANGUAGE_LABELS = Object.freeze({
    auto: '自动检测',
    zh_cn: '简体中文',
    zh_tw: '繁體中文',
    en: '英语',
    ja: '日语',
    ko: '韩语',
    de: '德语',
    fr: '法语',
    es: '西班牙语',
    ru: '俄语',
});

export const LANGUAGE_OPTIONS = Object.freeze(
    Object.keys(LANGUAGE_LABELS).map((value) => ({ value, label: LANGUAGE_LABELS[value] }))
);

export function getLanguageLabel(value) {
    return LANGUAGE_LABELS[value] ?? value;
}

function languageFamily(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace('-', '_')
        .replace(/^zh_(cn|hans|tw|hant)$/u, 'zh');
}

// 翻译场景不允许源语言与目标语言相同，避免小模型把任务误解为改写或摘要。
export function resolveAcademicTargetLanguage(text, requestedTarget = 'zh_cn') {
    const detectedSource = detectByScript(text);
    if (!detectedSource || languageFamily(detectedSource) !== languageFamily(requestedTarget)) {
        return requestedTarget;
    }
    return detectedSource === 'en' ? 'zh_cn' : 'en';
}
