// 仅使用本机规则的语言检测，不访问任何在线翻译服务。

const KANA = /[\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FD-\u30FF\u31F0-\u31FF\uFF66-\uFF9D]/u;
const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF\uD7B0-\uD7FF]/u;
const HAN_CHARACTERS = /[\u3400-\u4DBF\u4E00-\u9FFF]/gu;
const ASCII_LATIN_WITH_SCIENTIFIC_PUNCTUATION = /^[\x00-\x7F\u2010-\u2015\u2212\u00B1\u00D7\u00F7]*$/u;
const ENGLISH_FUNCTION_WORDS = new Set([
    'a', 'an', 'the', 'this', 'that', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'and', 'or', 'but', 'for', 'from', 'with', 'into', 'onto', 'to', 'of', 'in', 'on', 'by', 'as', 'at',
    'their', 'our', 'your', 'its', 'has', 'have', 'had', 'can', 'could', 'would', 'should', 'will', 'may',
    'might', 'among', 'owing',
]);
const ENGLISH_EXCLUSIVE_WORDS = new Set([
    'the', 'this', 'that', 'these', 'those', 'with', 'from', 'their', 'owing', 'among', 'into', 'onto',
]);
const ENGLISH_TECHNICAL_TERMS = new Set([
    'translation', 'steady', 'state', 'turnover', 'flux', 'cellular', 'penetration', 'drug', 'delivery',
    'gene', 'expression', 'kinetics', 'enzyme', 'reaction', 'metabolite', 'protein', 'rna', 'dna', 'clinical',
    'toxicity', 'stability', 'michaelis', 'menten',
]);
const HAN_SCRIPT = /[\u3400-\u4DBF\u4E00-\u9FFF]/u;
const CYRILLIC_SCRIPT = /[\u0400-\u052F]/u;
const HEBREW_SCRIPT = /[\u0590-\u05FF]/u;
const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/u;
const DEVANAGARI_SCRIPT = /[\u0900-\u097F]/u;
const THAI_SCRIPT = /[\u0E00-\u0E7F]/u;
const SIMPLIFIED_CHINESE_FEATURES = new Set([
    '这', '为', '个', '们', '发', '与', '从', '对', '时', '会', '学', '说', '现', '进', '过', '还', '种', '样',
    '应', '实', '验', '证', '开', '关', '问', '国', '间', '点', '无', '书', '买', '东', '乐', '习', '乡', '产',
    '亲', '仅', '体', '来', '张',
]);
const CHINESE_FUNCTION_MARKERS = [
    '的', '了', '在', '是', '和', '与', '为', '这', '那', '有', '将', '把', '被', '也', '就', '都', '而', '及', '我们', '可以',
];

// 为首个翻译请求提供高置信语言提示，低置信文本再按文字系统保守回退。
export function detectFast(text) {
    const normalized = String(text ?? '').trim();
    if (KANA.test(normalized)) return 'ja';
    if (HANGUL.test(normalized)) return 'ko';

    const hanCharacters = normalized.match(HAN_CHARACTERS) ?? [];
    const simplifiedChineseFeatures = new Set(
        [...normalized].filter((character) => SIMPLIFIED_CHINESE_FEATURES.has(character))
    );
    const chineseFunctionMarkerCount = CHINESE_FUNCTION_MARKERS.filter((marker) => normalized.includes(marker)).length;
    if (
        hanCharacters.length >= 12
        && simplifiedChineseFeatures.size >= 2
        && chineseFunctionMarkerCount >= 2
    ) {
        return 'zh_cn';
    }

    const latinWords = normalized.toLowerCase().match(/[a-z]+/gu) ?? [];
    const distinctFunctionWords = new Set(latinWords.filter((word) => ENGLISH_FUNCTION_WORDS.has(word)));
    const distinctTechnicalTerms = new Set(latinWords.filter((word) => ENGLISH_TECHNICAL_TERMS.has(word)));
    const hasExclusiveEnglishWord = latinWords.some((word) => ENGLISH_EXCLUSIVE_WORDS.has(word));
    if (
        /[A-Za-z]/u.test(normalized)
        && ASCII_LATIN_WITH_SCIENTIFIC_PUNCTUATION.test(normalized)
        && (
            hasExclusiveEnglishWord
            || distinctFunctionWords.size >= 2
            || distinctTechnicalTerms.size >= 2
            || (distinctFunctionWords.size >= 1 && distinctTechnicalTerms.size >= 1 && latinWords.length >= 4)
            || /^hello$/iu.test(normalized)
        )
    ) {
        return 'en';
    }
    return '';
}

export function detectByScript(text) {
    const normalized = String(text ?? '').trim();
    if (KANA.test(normalized)) return 'ja';
    if (HANGUL.test(normalized)) return 'ko';
    if (HAN_SCRIPT.test(normalized)) return 'zh_cn';
    if (CYRILLIC_SCRIPT.test(normalized)) return 'ru';
    if (HEBREW_SCRIPT.test(normalized)) return 'he';
    if (ARABIC_SCRIPT.test(normalized)) return 'ar';
    if (DEVANAGARI_SCRIPT.test(normalized)) return 'hi';
    if (THAI_SCRIPT.test(normalized)) return 'th';
    if (/[A-Za-z]/u.test(normalized)) return 'en';
    return '';
}

export default async function detect(text) {
    return detectFast(text) || detectByScript(text) || 'en';
}
