import { describe, expect, it } from 'vitest';

import { plainTranslationForPdf, sanitizeTranslatedPdfFilename, wrapTranslationLines } from './documentTranslationPdf';

describe('完整译文 PDF 排版', () => {
    it('清理非法文件名并保留明确的目标语言后缀', () => {
        expect(sanitizeTranslatedPdfFilename('Flux: <analysis>?', 'zh_cn')).toBe('Flux analysis-zh_cn-全文译文.pdf');
    });

    it('把 Markdown 转成适合 PDF 的可读纯文本，同时保留公式内容', () => {
        expect(plainTranslationForPdf('## **结论**\n- 通量为 `$v_i$`\n[来源](https://example.test)')).toBe(
            '结论\n• 通量为 $v_i$\n来源 (https://example.test)'
        );
    });

    it('按测量宽度换行并保留自然段空行', () => {
        const context = { measureText: (value) => ({ width: [...String(value)].length * 10 }) };
        const lines = wrapTranslationLines(context, '第一段很长的内容\n\nsecond paragraph', 60);

        expect(lines).toContain('');
        expect(lines.every((line) => [...line].length <= 6)).toBe(true);
    });

    it('中文排版不会把逗号、句号放在新行开头', () => {
        const context = { measureText: (value) => ({ width: [...String(value)].length * 10 }) };
        const lines = wrapTranslationLines(context, '第一行内容很长，而且逗号不应落在下一行。结论同样如此。', 70);

        expect(lines.some((line) => /^[，。]/u.test(line))).toBe(false);
        expect(lines.join('')).toBe('第一行内容很长，而且逗号不应落在下一行。结论同样如此。');
    });
});
