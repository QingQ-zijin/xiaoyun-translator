/**
 * 规范化译文展示前的基础输入状态。
 *
 * @param {unknown} value 原始译文
 * @returns {string} 去除流式光标后的 Markdown 原文
 */
export function normalizeTranslationForDisplay(value) {
    if (typeof value !== 'string') {
        return '';
    }

    return value.replace(/_$/, '');
}
