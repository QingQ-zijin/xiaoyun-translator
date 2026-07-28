import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    buildAiEvidence,
    classifySelection,
    clampReadingProgress,
    createSelectionAnchor,
    filterPapers,
    getVirtualPageWindow,
    normalizeAnnotationTags,
    PDF_SELECTION_DEBOUNCE_MS,
    researchJobProgress,
    sortPapers,
    summarizeAnnotations,
    shouldTranslateSelection,
    shouldConfirmEmbeddingInstall,
} from './model.js';

const papers = [
    {
        id: 'p1',
        title: 'Hippocampal memory',
        authors: 'Chen et al.',
        year: 2024,
        tags: [{ id: 'neuro', name: '神经科学' }],
    },
    { id: 'p2', title: 'Metabolic flux', authors: 'Liu et al.', year: 2023, tags: [] },
    { id: 'p3', title: 'Archived paper', authors: 'Xu', archivedAt: '2026-01-01', tags: [] },
    { id: 'p4', title: 'Trashed paper', authors: 'Wu', trashedAt: '2026-01-02', tags: [] },
    {
        id: 'p5',
        title: 'Invalid legacy lifecycle',
        archivedAt: '2026-01-01',
        trashedAt: '2026-01-02',
        tags: [],
    },
];

test('划词翻译防抖保持在五十毫秒以内', () => {
    assert.ok(PDF_SELECTION_DEBOUNCE_MS >= 16 && PDF_SELECTION_DEBOUNCE_MS <= 50);
});

test('论文检索同时匹配标题、作者、年份和标签，并隔离归档与回收站', () => {
    assert.deepEqual(
        filterPapers(papers, { query: '神经', view: 'all' }).map((paper) => paper.id),
        ['p1']
    );
    assert.deepEqual(
        filterPapers(papers, { query: 'liu', view: 'all' }).map((paper) => paper.id),
        ['p2']
    );
    assert.deepEqual(
        filterPapers(papers, { view: 'archive' }).map((paper) => paper.id),
        ['p3']
    );
    assert.deepEqual(
        filterPapers(papers, { view: 'trash' }).map((paper) => paper.id),
        ['p4', 'p5']
    );
});

test('论文可按最近打开与导入日期排序', () => {
    const dated = [
        { id: 'a', title: 'A', createdAt: '2026-07-20T00:00:00Z', lastOpenedAt: '2026-07-21T00:00:00Z' },
        { id: 'b', title: 'B', createdAt: '2026-07-10T00:00:00Z', lastOpenedAt: '2026-07-27T00:00:00Z' },
    ];
    assert.deepEqual(
        sortPapers(dated, 'lastOpenedDesc').map((paper) => paper.id),
        ['b', 'a']
    );
    assert.deepEqual(
        sortPapers(dated, 'importedDesc').map((paper) => paper.id),
        ['a', 'b']
    );
});

test('模型安装必须显式确认，研究任务进度被约束到百分比', () => {
    assert.equal(shouldConfirmEmbeddingInstall({ confirmationRequired: true, installed: false }), true);
    assert.equal(shouldConfirmEmbeddingInstall({ confirmationRequired: true, installed: true }), false);
    assert.equal(researchJobProgress({ completed: 3, total: 4 }), 75);
    assert.equal(researchJobProgress({ progress: 1.7 }), 100);
    assert.equal(researchJobProgress({ progress: -1 }), 0);
});

test('划词锚点保存上下文、偏移和归一化矩形', () => {
    const pageText = 'Before the hippocampus plays a critical role in memory. After';
    const anchor = createSelectionAnchor({
        paperId: 'p1',
        pageNumber: 2,
        quote: 'the hippocampus plays a critical role in memory',
        pageText,
        pageRect: { left: 100, top: 200, width: 500, height: 800 },
        rects: [{ left: 150, top: 280, width: 250, height: 24 }],
    });

    assert.equal(anchor.startOffset, 7);
    assert.equal(anchor.endOffset, 54);
    assert.equal(anchor.prefix, 'Before ');
    assert.equal(anchor.suffix, '. After');
    assert.deepEqual(anchor.rects, [{ x: 0.1, y: 0.1, width: 0.5, height: 0.03 }]);
});

test('页面虚拟化只保留可见页与相邻页', () => {
    assert.deepEqual(getVirtualPageWindow({ visiblePages: [4, 8], pageCount: 10, overscan: 1 }), [3, 4, 5, 7, 8, 9]);
    assert.deepEqual(getVirtualPageWindow({ visiblePages: [1], pageCount: 2, overscan: 2 }), [1, 2]);
});

test('无效选区不会触发翻译', () => {
    assert.equal(shouldTranslateSelection(' '), false);
    assert.equal(shouldTranslateSelection('—'), false);
    assert.equal(shouldTranslateSelection('Michaelis–Menten'), true);
    assert.equal(classifySelection('Michaelis–Menten'), 'vocabulary');
    assert.equal(classifySelection('β-oxidation'), 'vocabulary');
    assert.equal(classifySelection('This is a complete sentence.'), 'excerpt');
});

test('批注标签去重、限制数量，并汇总高亮、笔记和标签记录', () => {
    assert.deepEqual(normalizeAnnotationTags([' 方法 ', '方法', ' 结果', '', null]), ['方法', '结果']);

    assert.deepEqual(
        summarizeAnnotations([
            { tags: ['方法', '结果'] },
            { note: '复核此处', tags: ['方法', '讨论'] },
            { note: ' ', tags: ['结果'] },
        ]),
        {
            total: 3,
            notes: 1,
            vocabulary: 0,
            excerpts: 0,
            highlights: 2,
            tags: [
                { name: '方法', count: 2 },
                { name: '结果', count: 2 },
                { name: '讨论', count: 1 },
            ],
        }
    );
});

test('阅读进度被约束到合法范围，AI 证据携带可跳转页码', () => {
    assert.deepEqual(clampReadingProgress({ pageNumber: 99, pageCount: 16, scale: 9, scrollRatio: -1 }), {
        pageNumber: 16,
        scale: 3,
        scrollRatio: 0,
    });
    assert.deepEqual(
        buildAiEvidence({
            paperTitle: 'Memory',
            selection: { pageNumber: 2, quote: 'hippocampus' },
            pageText: 'evidence',
        }),
        {
            paperTitle: 'Memory',
            pageNumber: 2,
            quote: 'hippocampus',
            context: 'evidence',
            citationLabel: '第 2 页',
        }
    );
});
