const languageMaps = {
    Linux: {
        auto: 'auto',
        zh_cn: 'chi_sim',
        zh_tw: 'chi_tra',
        en: 'eng',
        yue: 'chi_sim',
        ja: 'jpn',
        ko: 'kor',
        fr: 'fra',
        es: 'spa',
        ru: 'rus',
        de: 'deu',
        it: 'ita',
        tr: 'tur',
        pt_pt: 'por',
        pt_br: 'por',
        vi: 'vie',
        id: 'ind',
        th: 'tha',
        ms: 'msa',
        ar: 'ara',
        hi: 'hin',
        uk: 'ukr',
        he: 'heb',
    },
    Windows_NT: {
        auto: 'auto',
        zh_cn: 'zh-CN',
        zh_tw: 'zh-TW',
        en: 'en-US',
        yue: 'zh-HK',
        ja: 'ja-JP',
        ko: 'ko-KR',
        fr: 'fr-FR',
        es: 'es-ES',
        ru: 'ru-RU',
        de: 'de-DE',
        it: 'it-IT',
        tr: 'tr-TR',
        pt_pt: 'pt-PT',
        pt_br: 'pt-BR',
        vi: 'vi-VN',
        id: 'id-ID',
        th: 'th-TH',
        ms: 'ms-MY',
        ar: 'ar-SA',
        hi: 'hi-IN',
        uk: 'uk-UA',
        he: 'he-IL',
    },
    Darwin: {
        auto: 'auto',
        zh_cn: 'zh-Hans',
        zh_tw: 'zh-Hant',
        en: 'en-US',
        yue: 'zh-Hans',
        ja: 'ja-JP',
        ko: 'ko-KR',
        fr: 'fr-FR',
        es: 'es-ES',
        ru: 'ru-RU',
        de: 'de-DE',
        it: 'it-IT',
        tr: 'tr-TR',
        pt_pt: 'pt-PT',
        pt_br: 'pt-BR',
        vi: 'vi-VN',
        id: 'id-ID',
        th: 'th-TH',
        ms: 'ms-MY',
        ar: 'ar-SA',
        hi: 'hi-IN',
        uk: 'uk-UA',
        he: 'he-IL',
    },
};

function mapLanguage(osType, language) {
    const languageMap = languageMaps[osType];
    if (!languageMap) throw new Error(`Unsupported operating system: ${osType}`);
    const mappedLanguage = languageMap[language];
    if (!mappedLanguage) throw new Error(`Unsupported OCR language: ${language}`);
    return mappedLanguage;
}

async function postprocess(result, language, osType, detectLanguage) {
    if (osType === 'Darwin') return result.trim();

    const isAutoChinese = language === 'auto' && (await detectLanguage(result)) === 'zh_cn';
    const removeSpaces =
        isAutoChinese || language === 'zh_cn' || language === 'zh_tw' || (osType === 'Windows_NT' && language === 'ja');

    return (removeSpaces ? result.replaceAll(' ', '') : result).trim();
}

async function recognize(command, args, language, dependencies) {
    const { osType, invokeCommand, detectLanguage } = dependencies;
    const result = await invokeCommand(command, {
        ...args,
        lang: mapLanguage(osType, language),
    });
    return postprocess(result, language, osType, detectLanguage);
}

/** 识别调用方提供的当前 base64，避免并发请求复用共享截图。 */
export async function recognizeSystemImage(base64, language, dependencies) {
    return recognize('system_ocr_base64', { image: base64 }, language, dependencies);
}

/** 保留原系统 OCR 入口，用于识别 Pot 已保存的共享截图文件。 */
export async function recognizeSystemScreenshot(language, dependencies) {
    return recognize('system_ocr', {}, language, dependencies);
}
