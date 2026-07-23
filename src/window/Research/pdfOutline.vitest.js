import { describe, expect, it, vi } from 'vitest';

import {
    deriveOutlineFromContents,
    deriveOutlineFromPages,
    extractNativePdfOutline,
    finalizeOutline,
} from './pdfOutline';

describe('PDF 章节目录解析', () => {
    it('解析嵌套书签、命名 destination 与页引用，并计算章节结束页', async () => {
        const chapterRef = { num: 8, gen: 0 };
        const pdfDocument = {
            numPages: 40,
            getOutline: vi.fn().mockResolvedValue([
                {
                    title: '1 Introduction',
                    dest: 'intro',
                    items: [{ title: '1.1 Background', dest: [chapterRef, { name: 'XYZ' }], items: [] }],
                },
                { title: '2 Methods', dest: [19, { name: 'XYZ' }], items: [] },
            ]),
            getDestination: vi.fn().mockResolvedValue([{ num: 2, gen: 0 }, { name: 'XYZ' }]),
            getPageIndex: vi.fn(async (reference) => (reference === chapterRef ? 7 : 2)),
        };

        await expect(extractNativePdfOutline(pdfDocument)).resolves.toEqual([
            {
                title: '1 Introduction',
                pageNumber: 3,
                endPage: 19,
                level: 1,
                source: 'native',
                confidence: 1,
            },
            {
                title: '1.1 Background',
                pageNumber: 8,
                endPage: 19,
                level: 2,
                source: 'native',
                confidence: 1,
            },
            {
                title: '2 Methods',
                pageNumber: 20,
                endPage: 40,
                level: 1,
                source: 'native',
                confidence: 1,
            },
        ]);
    });

    it('损坏书签只跳过自身，不影响其他可验证目录项', async () => {
        const pdfDocument = {
            numPages: 12,
            getOutline: vi.fn().mockResolvedValue([
                { title: 'Broken', dest: 'broken', items: [] },
                { title: 'Results', dest: [4, { name: 'Fit' }], items: [] },
            ]),
            getDestination: vi.fn().mockRejectedValue(new Error('bad destination')),
        };

        await expect(extractNativePdfOutline(pdfDocument)).resolves.toEqual([
            {
                title: 'Results',
                pageNumber: 5,
                endPage: 12,
                level: 1,
                source: 'native',
                confidence: 1,
            },
        ]);
    });

    it('无书签时从章节编号和标准章节名生成保守目录，并过滤重复页眉', () => {
        const pages = [
            { pageNumber: 1, text: 'MY BOOK\nCHAPTER 1 Introduction\nOrdinary sentence.' },
            { pageNumber: 2, text: 'MY BOOK\n1.1 Background\nMore body text.' },
            { pageNumber: 3, text: 'MY BOOK\n2 Methods\nBody.' },
        ];

        expect(deriveOutlineFromPages(pages, 9)).toEqual([
            {
                title: 'CHAPTER 1 Introduction',
                pageNumber: 1,
                endPage: 2,
                level: 1,
                source: 'text',
                confidence: 0.72,
            },
            {
                title: '1.1 Background',
                pageNumber: 2,
                endPage: 2,
                level: 2,
                source: 'text',
                confidence: 0.72,
            },
            {
                title: '2 Methods',
                pageNumber: 3,
                endPage: 9,
                level: 1,
                source: 'text',
                confidence: 0.72,
            },
        ]);
    });

    it('规范页码、层级并按下一个同级章节计算范围', () => {
        expect(
            finalizeOutline(
                [
                    { title: '第一章', pageNumber: -2, level: 0, confidence: 2 },
                    { title: '第一节', pageNumber: 3, level: 2, confidence: 0.6 },
                    { title: '第二章', pageNumber: 8, level: 1, confidence: 0.8 },
                ],
                10
            )
        ).toMatchObject([
            { pageNumber: 1, endPage: 7, level: 1, confidence: 1 },
            { pageNumber: 3, endPage: 7, level: 2, confidence: 0.6 },
            { pageNumber: 8, endPage: 10, level: 1, confidence: 0.8 },
        ]);
    });

    it('识别 Markdown 与 TeX 的章节标题并移除语法标记', () => {
        expect(
            deriveOutlineFromPages(
                [
                    {
                        pageNumber: 1,
                        text: '# 全书标题\n## 第一部分\n\\chapter{实验方法}\n\\section{样本处理}',
                    },
                ],
                1
            )
        ).toMatchObject([
            { title: '全书标题', level: 1 },
            { title: '第一部分', level: 2 },
            { title: '实验方法', level: 1 },
            { title: '样本处理', level: 2 },
        ]);
    });

    it('从书籍目录页换算印刷页码，并避免把目录页本身当作跳转目标', () => {
        const pages = [
            {
                pageNumber: 4,
                text: 'CONTENTS\n1. Overview 1\n1.1 Capsule History of Dynamics 2\n2. Flows on the Line 15\n2.1 Fixed Points and Stability 18',
            },
            { pageNumber: 11, text: 'OVERVIEW\n1. Overview\n1.0 Chaos, Fractals, and Dynamics' },
            { pageNumber: 12, text: '1.1 Capsule History of Dynamics\n正文' },
            { pageNumber: 25, text: '2. Flows on the Line\n正文' },
            { pageNumber: 28, text: '2.1 Fixed Points and Stability\n正文' },
        ];

        expect(deriveOutlineFromContents(pages, 40)).toMatchObject([
            { title: '1. Overview', pageNumber: 11, level: 1, source: 'contents', confidence: 0.98 },
            {
                title: '1.1. Capsule History of Dynamics',
                pageNumber: 12,
                level: 2,
                source: 'contents',
                confidence: 0.98,
            },
            { title: '2. Flows on the Line', pageNumber: 25, level: 1, source: 'contents', confidence: 0.98 },
            {
                title: '2.1. Fixed Points and Stability',
                pageNumber: 28,
                level: 2,
                source: 'contents',
                confidence: 0.98,
            },
        ]);
        expect(deriveOutlineFromPages(pages, 40).every((item) => item.pageNumber > 4)).toBe(true);
    });

    it('识别扫描书中被拆字的目录标题和两位章节号', () => {
        const pages = [
            {
                pageNumber: 4,
                text: [
                    'C O N T E N T S',
                    '1. Overview 1',
                    '1.0 Chaos, Fractals, and Dynamics 1',
                    'Flows on the Line 15',
                    '2.0 Introduction 15',
                    '11. Fractals 398',
                    '1 1.0 Introduction 398',
                ].join('\n'),
            },
            { pageNumber: 11, text: 'OVERVIEW\n1.0 Chaos, Fractals, and Dynamics' },
            { pageNumber: 23, text: 'FLOWS ON THE LINE\n2.0 Introduction' },
            { pageNumber: 406, text: 'FRACTALS\n11.0 Introduction' },
        ];

        const outline = deriveOutlineFromContents(pages, 505);
        expect(outline).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ title: '1.0. Chaos, Fractals, and Dynamics', pageNumber: 11 }),
                expect.objectContaining({ title: '2. Flows on the Line', pageNumber: 23 }),
                expect.objectContaining({ title: '2.0. Introduction', pageNumber: 23 }),
                expect.objectContaining({ title: '11.0. Introduction', pageNumber: 406 }),
            ])
        );
        expect(outline.every((item) => item.pageNumber !== 4)).toBe(true);
    });

    it('忽略后文重复页眉形成的异常页码偏移', () => {
        const pages = [
            {
                pageNumber: 4,
                text: [
                    'C O N T E N T S',
                    '3. Bifurcations 44',
                    '3.0 Introduction 44',
                    '3.1 Saddle-Node Bifurcation 45',
                    '4. Flows on the Circle 93',
                    '4.0 Introduction 93',
                    '4.1 Examples and Definitions 93',
                ].join('\n'),
            },
            { pageNumber: 52, text: '3.0 Introduction' },
            { pageNumber: 53, text: '3.1 Saddle-Node Bifurcation' },
            { pageNumber: 101, text: '4.0 Introduction\n4.1 Examples and Definitions' },
            { pageNumber: 122, text: '4. Flows on the Circle' },
        ];

        expect(deriveOutlineFromContents(pages, 505)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ title: '4. Flows on the Circle', pageNumber: 101 }),
                expect.objectContaining({ title: '4.0. Introduction', pageNumber: 101 }),
                expect.objectContaining({ title: '4.1. Examples and Definitions', pageNumber: 101 }),
            ])
        );
    });
});
