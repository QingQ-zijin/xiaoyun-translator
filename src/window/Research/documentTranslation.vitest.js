import { describe, expect, it, vi } from 'vitest';

import {
    documentTranslationProgress,
    mergeDocumentPageSources,
    splitDocumentTranslationChunks,
    translateDocumentPage,
    validCachedDocumentTranslations,
} from './documentTranslation';

describe('通篇翻译文本管线', () => {
    it('按段落和完整句子分块，不破坏 Markdown 与 LaTeX', () => {
        const source = [
            `**Result.** The flux is $v_i = 3$. ${'Another complete scientific sentence. '.repeat(10)}`,
            `第二段保留公式 $$\\frac{dE}{dt}=k(1-E)$$。${'这里是完整的学术句子。'.repeat(16)}`,
        ].join('\n\n');
        const chunks = splitDocumentTranslationChunks(source, 60);

        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.join('\n\n')).toContain('**Result.**');
        expect(chunks.join('\n\n')).toContain('$v_i = 3$');
        expect(chunks.join('\n\n')).toContain('$$\\frac{dE}{dt}=k(1-E)$$');
    });

    it('合并 PDF.js、OCR 与数据库页面时保留每页最完整文本并按页排序', () => {
        expect(
            mergeDocumentPageSources(
                [
                    { pageNumber: 2, text: 'short' },
                    { pageNumber: 4, text: '' },
                ],
                [
                    { pageNumber: 1, text: 'first' },
                    { pageNumber: 2, text: 'a much longer second page' },
                ]
            )
        ).toEqual([
            { pageNumber: 1, text: 'first' },
            { pageNumber: 2, text: 'a much longer second page' },
        ]);
    });

    it('只复用原文完全一致且译文非空的持久化页面', () => {
        const pages = [
            { pageNumber: 1, text: 'source one' },
            { pageNumber: 2, text: 'source two changed' },
        ];
        const cached = validCachedDocumentTranslations(pages, [
            { pageNumber: 1, sourceText: 'source one', translation: '译文一' },
            { pageNumber: 2, sourceText: 'source two', translation: '旧译文' },
            { pageNumber: 3, sourceText: 'missing', translation: '多余页面' },
        ]);

        expect(cached).toEqual([{ pageNumber: 1, sourceText: 'source one', translation: '译文一' }]);
    });

    it('逐段流式翻译整页，并把相邻段落作为独立上下文传给模型', async () => {
        const translateChunk = vi.fn(async ({ selection, onDelta }) => {
            const translated = `译：${selection.quote}`;
            onDelta(translated.slice(0, 8));
            onDelta(translated);
            return translated;
        });
        const progress = vi.fn();
        const source = `${'First academic sentence. '.repeat(60)}\n\n${'Second scientific sentence. '.repeat(60)}`;

        const result = await translateDocumentPage({
            page: { pageNumber: 7, text: source },
            paperTitle: 'Academic paper',
            paperInsights: { terms: [{ term: 'flux', translation: '通量' }] },
            targetLanguage: 'zh_cn',
            translateChunk,
            onChunkProgress: progress,
        });

        expect(translateChunk.mock.calls.length).toBeGreaterThan(1);
        expect(translateChunk).toHaveBeenCalledWith(
            expect.objectContaining({
                selection: expect.objectContaining({ pageNumber: 7 }),
                targetLanguage: 'zh_cn',
            })
        );
        expect(result.split('\n\n').every((part) => part.startsWith('译：'))).toBe(true);
        expect(progress.mock.calls.at(-1)[0].text).toBe(result);
    });

    it('进度对越界值做安全收敛', () => {
        expect(documentTranslationProgress(10, 12)).toEqual({ total: 10, completed: 10, percent: 100 });
        expect(documentTranslationProgress(0, -1)).toEqual({ total: 0, completed: 0, percent: 0 });
    });
});
