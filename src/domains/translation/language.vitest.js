import { describe, expect, it } from 'vitest';

import { getLanguageLabel, LANGUAGE_OPTIONS, resolveAcademicTargetLanguage } from './language';

describe('精简语言列表', () => {
    it('提供自动检测、中文和英文学术阅读常用项', () => {
        expect(getLanguageLabel('auto')).toBe('自动检测');
        expect(getLanguageLabel('zh_cn')).toBe('简体中文');
        expect(LANGUAGE_OPTIONS.some((item) => item.value === 'en')).toBe(true);
        expect(getLanguageLabel('unknown')).toBe('unknown');
    });

    it('不存在重复语言键', () => {
        expect(new Set(LANGUAGE_OPTIONS.map((item) => item.value)).size).toBe(LANGUAGE_OPTIONS.length);
    });

    it('同语种选区自动切换为真正的翻译方向', () => {
        expect(resolveAcademicTargetLanguage('研究生招生工作管理规定', 'zh_cn')).toBe('en');
        expect(resolveAcademicTargetLanguage('Michaelis–Menten kinetics', 'en')).toBe('zh_cn');
        expect(resolveAcademicTargetLanguage('Michaelis–Menten kinetics', 'ja')).toBe('ja');
    });

    it('公式或纯数字无法可靠判定时保留用户目标语言', () => {
        expect(resolveAcademicTargetLanguage('$v_i = 10$', 'zh_cn')).toBe('zh_cn');
    });
});
