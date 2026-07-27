import { describe, expect, it } from 'vitest';

import {
    classifySelection,
    buildAiEvidence,
    clampReadingProgress,
    createSelectionAnchor,
    filterPapers,
    getVirtualPageWindow,
    normalizeSearchText,
    normalizeAnnotationTags,
    normalizeSelectionRects,
    PDF_SELECTION_DEBOUNCE_MS,
    researchJobProgress,
    shouldTranslateSelection,
    shouldConfirmEmbeddingInstall,
    summarizeAnnotations,
    UNCLASSIFIED_PROJECT_ID,
} from './model';

describe('论文阅读纯函数', () => {
    it('划词翻译防抖保持在一帧附近，不阻塞浮窗响应', () => {
        expect(PDF_SELECTION_DEBOUNCE_MS).toBeGreaterThanOrEqual(16);
        expect(PDF_SELECTION_DEBOUNCE_MS).toBeLessThanOrEqual(50);
    });

    it('规范化检索并隔离归档、回收站与标签', () => {
        const papers = [
            {
                id: 'a',
                title: 'Metabolic Flux',
                authors: 'Liu',
                year: 2026,
                tags: [{ id: 'm', name: '方法学' }],
                projects: [{ id: 'project-1', name: '代谢研究' }],
            },
            { id: 'c', title: 'Unsorted Paper', authors: 'Wang', tags: [], projects: [] },
            { id: 'b', title: 'Archived Paper', authors: 'Zhang', archivedAt: 'archived', tags: [] },
            { id: 'd', title: 'Trashed Paper', authors: 'Wu', trashedAt: 'trashed', tags: [] },
            {
                id: 'e',
                title: 'Invalid Legacy State',
                authors: 'Xu',
                archivedAt: 'archived',
                trashedAt: 'trashed',
                tags: [],
            },
        ];
        expect(normalizeSearchText('  Ｆｌｕｘ  ')).toBe('flux');
        expect(filterPapers(papers, { query: 'liu', view: 'all' }).map((paper) => paper.id)).toEqual(['a']);
        expect(filterPapers(papers, { view: 'tagged', tagId: 'm' }).map((paper) => paper.id)).toEqual(['a']);
        expect(filterPapers(papers, { view: 'archive' }).map((paper) => paper.id)).toEqual(['b']);
        expect(filterPapers(papers, { view: 'trash' }).map((paper) => paper.id)).toEqual(['d', 'e']);
        expect(filterPapers(papers, { projectId: 'project-1' }).map((paper) => paper.id)).toEqual(['a']);
        expect(filterPapers(papers, { projectId: UNCLASSIFIED_PROJECT_ID }).map((paper) => paper.id)).toEqual(['c']);
        expect(filterPapers(papers, { query: '代谢研究' }).map((paper) => paper.id)).toEqual(['a']);
        expect(filterPapers(null)).toEqual([]);
        expect(filterPapers(papers, { query: 'missing', view: 'all' })).toEqual([]);
    });

    it('创建可重锚定的选区并归一化矩形', () => {
        const pageRect = { left: 10, top: 20, width: 200, height: 100 };
        const rects = normalizeSelectionRects([{ left: 30, top: 40, width: 60, height: 10 }, { width: 0 }], pageRect);
        expect(rects).toEqual([{ x: 0.1, y: 0.2, width: 0.3, height: 0.1 }]);
        expect(normalizeSelectionRects(rects, null)).toEqual([]);

        const anchor = createSelectionAnchor({
            paperId: 'paper',
            pageNumber: 2,
            quote: 'Michaelis–Menten',
            pageText: 'before Michaelis–Menten after',
            rects: [{ left: 30, top: 40, width: 60, height: 10 }],
            pageRect,
        });
        expect(anchor).toMatchObject({ paperId: 'paper', pageNumber: 2, prefix: 'before ', suffix: ' after' });
        expect(anchor.startOffset).toBeGreaterThanOrEqual(0);
        expect(createSelectionAnchor({ quote: 'missing', pageText: 'page' })).toMatchObject({
            pageNumber: 1,
            startOffset: null,
            endOffset: null,
            prefix: '',
            suffix: '',
            rects: [],
        });
    });

    it('约束虚拟页、选区、进度和证据', () => {
        expect(getVirtualPageWindow({ visiblePages: [1, 3], pageCount: 4 })).toEqual([1, 2, 3, 4]);
        expect(getVirtualPageWindow({ visiblePages: ['x'], pageCount: 4 })).toEqual([]);
        expect(getVirtualPageWindow({ pageCount: 4 })).toEqual([]);
        expect(shouldTranslateSelection('A')).toBe(false);
        expect(shouldTranslateSelection('Michaelis–Menten')).toBe(true);
        expect(shouldTranslateSelection('!@')).toBe(false);
        expect(shouldTranslateSelection('x'.repeat(8_001))).toBe(false);
        expect(clampReadingProgress({ pageNumber: 99, pageCount: 4, scale: 9, scrollRatio: -2 })).toEqual({
            pageNumber: 4,
            scale: 3,
            scrollRatio: 0,
        });
        expect(
            buildAiEvidence({
                paperTitle: ' Paper ',
                selection: { pageNumber: 3, quote: ' evidence ' },
                pageText: ' context ',
            })
        ).toEqual({
            paperTitle: 'Paper',
            pageNumber: 3,
            quote: 'evidence',
            context: 'context',
            citationLabel: '第 3 页',
        });
        expect(clampReadingProgress({})).toEqual({ pageNumber: 1, scale: 1.25, scrollRatio: 0 });
        expect(clampReadingProgress({ pageNumber: 0, pageCount: 0, scale: 0.1, scrollRatio: 2 })).toEqual({
            pageNumber: 1,
            scale: 0.5,
            scrollRatio: 1,
        });
        expect(buildAiEvidence({ pageText: 'x'.repeat(9_000) }).context).toHaveLength(8_000);
        expect(buildAiEvidence({})).toEqual({
            paperTitle: '',
            pageNumber: 1,
            quote: '',
            context: '',
            citationLabel: '第 1 页',
        });
        expect(normalizeSelectionRects(null, { left: 0, top: 0, width: 10, height: 10 })).toEqual([]);
    });

    it('要求显式授权嵌入模型安装并约束任务进度', () => {
        expect(shouldConfirmEmbeddingInstall({ confirmationRequired: true, installed: false })).toBe(true);
        expect(shouldConfirmEmbeddingInstall({ confirmationRequired: false, installed: false })).toBe(false);
        expect(researchJobProgress({ completed: 2, total: 5 })).toBe(40);
        expect(researchJobProgress({ progress: 2 })).toBe(100);
        expect(researchJobProgress({ progress: -0.2 })).toBe(0);
        expect(researchJobProgress({ completed: 'not-a-number', total: 0 })).toBe(0);
    });

    it('规范化批注标签并汇总笔记、高亮和大小写等价标签', () => {
        expect(normalizeAnnotationTags([' 方法学 ', '方法学', 'METHOD', 'method', '', null])).toEqual([
            '方法学',
            'METHOD',
        ]);
        expect(normalizeAnnotationTags(null)).toEqual([]);
        expect(normalizeAnnotationTags(Array.from({ length: 25 }, (_, index) => `标签${index}`))).toHaveLength(20);
        expect(classifySelection('Michaelis–Menten')).toBe('vocabulary');
        expect(classifySelection('β-oxidation')).toBe('vocabulary');
        expect(classifySelection('This is a complete sentence.')).toBe('excerpt');
        expect(classifySelection('')).toBe('none');

        expect(
            summarizeAnnotations([
                { note: ' 机制解释 ', tags: ['机制', '代谢'] },
                { note: '', tags: ['机制', 'METHOD'] },
                { kind: 'vocabulary', tags: ['method', null] },
                { kind: 'excerpt', tags: ['摘录'] },
            ])
        ).toEqual({
            total: 4,
            notes: 1,
            vocabulary: 1,
            excerpts: 1,
            highlights: 1,
            tags: [
                { name: '机制', count: 2 },
                { name: 'METHOD', count: 2 },
                { name: '代谢', count: 1 },
                { name: '摘录', count: 1 },
            ],
        });
        expect(summarizeAnnotations(null)).toEqual({
            total: 0,
            notes: 0,
            vocabulary: 0,
            excerpts: 0,
            highlights: 0,
            tags: [],
        });
    });
});
