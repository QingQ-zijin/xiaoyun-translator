import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
    convertFileSrc: vi.fn((path) => `asset://${path}`),
    listen: vi.fn(),
    openDialog: vi.fn(),
    onDragDropEvent: vi.fn(),
    dragDropHandler: null,
    synthesizeSpeech: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    convertFileSrc: mocks.convertFileSrc,
    invoke: mocks.invoke,
    Channel: class TestChannel {
        onmessage = null;
    },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('@tauri-apps/api/webview', () => ({
    getCurrentWebview: () => ({ onDragDropEvent: mocks.onDragDropEvent }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.openDialog }));
vi.mock('../translation', () => ({ synthesizeSpeech: mocks.synthesizeSpeech }));

import {
    analyzePaperFigure,
    askPaper,
    archivePapers,
    cancelPaperInsights,
    choosePdfPaths,
    createProject,
    defineTerm,
    deleteProject,
    deleteGlossaryEntry,
    generatePaperInsights,
    generateChapterInsights,
    getChapterInsights,
    getDocument,
    getPaperInsights,
    getPdfSource,
    importPapers,
    indexDocumentPages,
    rebuildDocumentOutline,
    replaceDocumentOutline,
    isTranslationActive,
    listChapterInsights,
    listGlossary,
    listPapers,
    listPendingPaperInsights,
    listProjects,
    movePapersToTrash,
    openPdfExternalUrl,
    restorePapers,
    setPaperProjects,
    saveGlossaryEntry,
    subscribeToDocumentDrops,
    subscribeToPdfDrops,
    translateSelection,
    unarchivePapers,
    updateProject,
} from './bridge';

const selection = {
    quote: 'graduate admissions management',
    pageNumber: 5,
    prefix: 'previous context',
    suffix: 'next context',
};

beforeEach(() => {
    delete window.__TAURI__;
    delete window.__TAURI_METADATA__;
    window.__TAURI_INTERNALS__ = {};
    mocks.invoke.mockReset();
    mocks.convertFileSrc.mockClear();
    mocks.listen.mockReset();
    mocks.openDialog.mockReset();
    mocks.dragDropHandler = null;
    mocks.onDragDropEvent.mockReset();
    mocks.onDragDropEvent.mockImplementation((handler) => {
        mocks.dragDropHandler = handler;
        return Promise.resolve(() => {});
    });
});

describe('PDF 外部链接 bridge', () => {
    it('桌面端只把规范化后的安全 URL 交给 Rust', async () => {
        mocks.invoke.mockResolvedValue(undefined);

        await expect(openPdfExternalUrl('  https://example.com/paper?q=1  ')).resolves.toBe(
            'https://example.com/paper?q=1'
        );
        expect(mocks.invoke).toHaveBeenCalledWith('research_open_external_url', {
            url: 'https://example.com/paper?q=1',
        });
    });

    it('演示环境使用新窗口打开，并在调用前拒绝危险协议', async () => {
        delete window.__TAURI_INTERNALS__;
        const open = vi.fn();
        vi.stubGlobal('open', open);

        await expect(openPdfExternalUrl('mailto:author@example.com')).resolves.toBe('mailto:author@example.com');
        expect(open).toHaveBeenCalledWith('mailto:author@example.com', '_blank', 'noopener,noreferrer');
        await expect(openPdfExternalUrl('javascript:alert(1)')).rejects.toThrow(
            'PDF 外部链接只允许使用 http、https 或 mailto'
        );
        expect(open).toHaveBeenCalledOnce();
    });
});

afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    vi.unstubAllGlobals();
});

describe('论文阅读器划词翻译 bridge', () => {
    it('执行真实 helper 路径并传递选区、上下文、语言和增量结果', async () => {
        mocks.invoke.mockResolvedValue({ text: '研究生招生管理' });
        const onDelta = vi.fn();

        await expect(
            translateSelection({
                selection,
                paperTitle: 'Admissions Policy',
                paperInsights: {
                    payload: {
                        summary: 'A paper about admissions policy and graduate education.',
                        terms: [
                            {
                                term: 'graduate admissions',
                                translation: '研究生招生',
                                annotation: 'Higher-education admissions terminology.',
                            },
                            { term: 'unrelated term', translation: '无关术语' },
                        ],
                    },
                },
                sourceLanguage: 'en',
                targetLanguage: 'zh_cn',
                onDelta,
            })
        ).resolves.toBe('研究生招生管理');

        expect(mocks.invoke).toHaveBeenCalledOnce();
        expect(mocks.invoke).toHaveBeenCalledWith(
            'research_translate_selection',
            expect.objectContaining({
                text: 'graduate admissions management',
                pageNumber: 5,
                paperTitle: 'Admissions Policy',
                paperSummary: 'A paper about admissions policy and graduate education.',
                paperTerms: [
                    {
                        term: 'graduate admissions',
                        translation: '研究生招生',
                        annotation: 'Higher-education admissions terminology.',
                    },
                ],
                contextBefore: 'previous context',
                contextAfter: 'next context',
                sourceLanguage: 'en',
                targetLanguage: 'zh_cn',
                requestId: expect.any(String),
                onEvent: expect.any(Object),
            })
        );
        expect(onDelta).toHaveBeenCalledWith('研究生招生管理');
    });

    it('只发送有助于当前选区的缓存术语，并对论文上下文做长度限制', async () => {
        mocks.invoke.mockResolvedValue({ text: 'TMFA 生成的通量分布不包含热力学不可行的反应或途径。' });
        const quote =
            'TMFA produces flux distributions that do not contain any thermodynamically infeasible reactions or pathways.';

        await translateSelection({
            selection: {
                quote,
                pageNumber: 2,
                prefix: `ignored-${'a'.repeat(700)}`,
                suffix: `${'b'.repeat(700)}-ignored`,
            },
            paperTitle: 'Thermodynamics-Based Metabolic Flux Analysis',
            paperInsights: {
                summary: `${'summary '.repeat(200)}tail`,
                terms: [
                    { term: 'flux distribution', translation: '通量分布', annotation: '代谢网络中的通量分布。' },
                    { term: 'protein folding', translation: '蛋白质折叠' },
                ],
            },
        });

        expect(mocks.invoke).toHaveBeenCalledWith(
            'research_translate_selection',
            expect.objectContaining({
                paperTitle: 'Thermodynamics-Based Metabolic Flux Analysis',
                paperSummary: expect.stringMatching(/^summary /u),
                paperTerms: [
                    { term: 'flux distribution', translation: '通量分布', annotation: '代谢网络中的通量分布。' },
                ],
                contextBefore: expect.stringMatching(/^a{600}$/u),
                contextAfter: expect.stringMatching(/^b{600}$/u),
            })
        );
        const payload = mocks.invoke.mock.calls[0][1];
        expect(payload.paperSummary).toHaveLength(800);
    });

    it('不会回退到浏览器 fetch，并把网络失败显示为中文', async () => {
        const browserFetch = vi.fn();
        vi.stubGlobal('fetch', browserFetch);
        mocks.invoke.mockRejectedValue(new TypeError('Failed to fetch'));

        await expect(translateSelection({ selection, paperTitle: 'Admissions Policy' })).rejects.toThrow(
            '论文划词翻译失败：无法连接本地翻译服务，请确认 Ollama 正在运行。'
        );
        expect(browserFetch).not.toHaveBeenCalled();
    });

    it('旧后端缺少命令时给出升级提示', async () => {
        mocks.invoke.mockRejectedValue(new Error('Command research_translate_selection not found'));

        await expect(translateSelection({ selection, paperTitle: 'Admissions Policy' })).rejects.toThrow(
            '当前程序后端不支持论文划词翻译，请安装最新版本后重试。'
        );
    });

    it('中文论文选区不会向桌面后端发送同语种目标', async () => {
        mocks.invoke.mockResolvedValue({ text: 'Graduate admissions administration regulations.' });

        await translateSelection({
            selection: { ...selection, quote: '研究生招生工作管理规定' },
            paperTitle: '招生规定',
            targetLanguage: 'zh_cn',
        });

        expect(mocks.invoke).toHaveBeenCalledWith(
            'research_translate_selection',
            expect.objectContaining({ targetLanguage: 'en' })
        );
    });
});

describe('论文阅读器选区解释 bridge', () => {
    it('显式传递 explain_selection 意图并优先发送选区邻近上下文', async () => {
        mocks.invoke.mockResolvedValue({
            answer: '异质性指研究对象在性质或功能上的差异。',
            citations: [],
            refused: false,
            retrievalMode: 'contextual',
        });

        await expect(
            askPaper({
                paperId: 'paper-1',
                question: '解释所选内容',
                paperTitle: 'Metabolic heterogeneity',
                selection: {
                    pageNumber: 8,
                    quote: 'heterogeneity',
                    prefix: 'intra-tissue metabolic',
                    suffix: 'across cooperative mechanisms',
                },
                pageText: `irrelevant ${'x'.repeat(9_000)}`,
                intent: 'explain_selection',
            })
        ).resolves.toMatchObject({
            answer: '异质性指研究对象在性质或功能上的差异。',
            citations: [],
            retrievalMode: 'contextual',
        });

        expect(mocks.invoke).toHaveBeenCalledWith('research_ai_query', {
            paperId: 'paper-1',
            question: '解释所选内容',
            evidence: {
                intent: 'explain_selection',
                paperTitle: 'Metabolic heterogeneity',
                pageNumber: 8,
                quote: 'heterogeneity',
                context: 'intra-tissue metabolic heterogeneity across cooperative mechanisms',
                citationLabel: '第 8 页',
            },
        });
    });

    it('请求已取消时不会进入后端', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(
            askPaper({
                paperId: 'paper-1',
                question: '解释所选内容',
                selection,
                intent: 'explain_selection',
                signal: controller.signal,
            })
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.invoke).not.toHaveBeenCalled();
    });
});

describe('论文词库与图像分析 bridge', () => {
    it('词库通过结构化命令增删查，并保留论文范围', async () => {
        mocks.invoke
            .mockResolvedValueOnce([{ id: 'g1', paperId: 'paper-1', term: 'flux' }])
            .mockResolvedValueOnce({ id: 'g1', paperId: 'paper-1', term: 'flux', translation: '通量' })
            .mockResolvedValueOnce(undefined);

        await listGlossary({ paperId: 'paper-1', query: 'Flux' });
        await saveGlossaryEntry({ paperId: 'paper-1', term: 'flux', translation: '通量' });
        await deleteGlossaryEntry('g1');

        expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'research_list_glossary', {
            paperId: 'paper-1',
            query: 'flux',
        });
        expect(mocks.invoke).toHaveBeenNthCalledWith(
            2,
            'research_save_glossary_entry',
            expect.objectContaining({ entry: expect.objectContaining({ paperId: 'paper-1', term: 'flux' }) })
        );
        expect(mocks.invoke).toHaveBeenNthCalledWith(3, 'research_delete_glossary_entry', { entryId: 'g1' });
    });

    it('图像分析把整页图像、右键焦点和论文上下文交给 Gemma', async () => {
        class TestImage {
            naturalWidth = 100;
            naturalHeight = 200;
            decode = vi.fn().mockResolvedValue(undefined);
        }
        vi.stubGlobal('Image', TestImage);
        const drawImage = vi.fn();
        const context = {
            drawImage,
            save: vi.fn(),
            restore: vi.fn(),
            beginPath: vi.fn(),
            arc: vi.fn(),
            moveTo: vi.fn(),
            lineTo: vi.fn(),
            stroke: vi.fn(),
            set strokeStyle(_value) {},
            set lineWidth(_value) {},
            set shadowColor(_value) {},
            set shadowBlur(_value) {},
        };
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
        vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,FOCUSED');
        mocks.invoke.mockResolvedValue({ analysis: '### 图像主旨\n稳态通量关系', model: 'gemma4:e4b' });

        await analyzePaperFigure({
            paperId: 'paper-1',
            paperTitle: 'TMFA',
            pageNumber: 3,
            pageText: 'Figure 1 describes flux balance.',
            imageDataUrl: 'data:image/png;base64,ORIGINAL',
            focusX: 0.25,
            focusY: 0.75,
        });

        expect(drawImage).toHaveBeenCalledOnce();
        expect(mocks.invoke).toHaveBeenCalledWith('research_analyze_figure', {
            paperId: 'paper-1',
            paperTitle: 'TMFA',
            pageNumber: 3,
            pageText: 'Figure 1 describes flux balance.',
            imageDataUrl: 'data:image/png;base64,FOCUSED',
            focusX: 0.25,
            focusY: 0.75,
        });
    });
});

describe('多格式文献导入 bridge', () => {
    it('选择对话框同时开放 PDF、Markdown、DOCX 与 TeX，并过滤无关文件', async () => {
        mocks.openDialog.mockResolvedValue([
            'C:\\Papers\\paper.pdf',
            'C:\\Papers\\notes.md',
            'C:\\Papers\\appendix.markdown',
            'C:\\Papers\\draft.docx',
            'C:\\Papers\\source.tex',
            'C:\\Papers\\ignored.txt',
            'C:\\Papers\\paper.pdf',
        ]);

        await expect(choosePdfPaths()).resolves.toEqual([
            'C:\\Papers\\paper.pdf',
            'C:\\Papers\\notes.md',
            'C:\\Papers\\appendix.markdown',
            'C:\\Papers\\draft.docx',
            'C:\\Papers\\source.tex',
        ]);
        expect(mocks.openDialog).toHaveBeenCalledWith(
            expect.objectContaining({
                title: '导入论文',
                multiple: true,
                directory: false,
                filters: [
                    {
                        name: '支持的文献',
                        extensions: ['pdf', 'md', 'markdown', 'docx', 'tex'],
                    },
                ],
            })
        );
    });

    it('把全部受支持格式一次性交给后端且不再只保留 PDF', async () => {
        mocks.invoke.mockResolvedValue([]);
        const paths = ['a.pdf', 'b.MD', 'c.markdown', 'd.docx', 'e.tex', 'f.txt', 'a.pdf'];

        await expect(importPapers(paths)).resolves.toEqual([]);

        expect(mocks.invoke).toHaveBeenCalledOnce();
        expect(mocks.invoke).toHaveBeenCalledWith('research_import_papers', {
            paths: ['a.pdf', 'b.MD', 'c.markdown', 'd.docx', 'e.tex'],
            contentKind: 'paper',
        });
    });

    it('传递书籍类型并直接采用后端持久化后的字段', async () => {
        mocks.invoke.mockResolvedValueOnce([{ id: 'book-1', title: 'Chaos', contentKind: 'book' }]);

        await expect(importPapers(['chaos.pdf'], 'book')).resolves.toEqual([
            expect.objectContaining({ id: 'book-1', contentKind: 'book' }),
        ]);
        expect(mocks.invoke).toHaveBeenLastCalledWith('research_import_papers', {
            paths: ['chaos.pdf'],
            contentKind: 'book',
        });

        mocks.invoke.mockResolvedValueOnce([{ id: 'book-1', title: 'Chaos', contentKind: 'book' }]);
        await expect(listPapers()).resolves.toEqual([expect.objectContaining({ id: 'book-1', contentKind: 'book' })]);
    });

    it('演示模式为不同格式生成正确的文档元数据与可读文本', async () => {
        delete window.__TAURI_INTERNALS__;

        const imported = await importPapers([
            'D:\\Library\\paper.pdf',
            'D:\\Library\\notes.md',
            'D:\\Library\\draft.docx',
            'D:\\Library\\source.tex',
        ]);

        expect(imported).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ title: 'paper', sourceFormat: 'pdf', documentType: 'pdf', textContent: '' }),
                expect.objectContaining({
                    title: 'notes',
                    sourceFormat: 'markdown',
                    documentType: 'markdown',
                    textContent: expect.stringContaining('# notes'),
                }),
                expect.objectContaining({
                    title: 'draft',
                    sourceFormat: 'docx',
                    documentType: 'text',
                    textContent: expect.stringContaining('DOCX'),
                }),
                expect.objectContaining({
                    title: 'source',
                    sourceFormat: 'tex',
                    documentType: 'tex',
                    textContent: expect.stringContaining('TEX'),
                }),
            ])
        );

        const markdown = imported.find((paper) => paper.sourceFormat === 'markdown');
        await expect(getDocument(markdown.id)).resolves.toMatchObject({
            paper: expect.objectContaining({ id: markdown.id }),
            path: '',
            sourcePath: 'D:\\Library\\notes.md',
            sourceFormat: 'markdown',
            documentType: 'markdown',
            textContent: expect.stringContaining('# notes'),
            importWarning: '',
        });
    });

    it('只为真正的 PDF 文档生成可加载资源地址', () => {
        expect(getPdfSource({ documentType: 'pdf', path: 'C:\\Library\\paper.pdf' })).toBe(
            'asset://C:\\Library\\paper.pdf'
        );
        expect(getPdfSource({ documentType: 'markdown', path: 'C:\\Library\\notes.md' })).toBe('');
        expect(getPdfSource({ documentType: 'text', path: 'C:\\Library\\draft.docx' })).toBe('');
        expect(getPdfSource({ path: 'C:\\Library\\legacy.pdf' })).toBe('');
        expect(mocks.convertFileSrc).toHaveBeenCalledOnce();
    });

    it('拖放入口接受全部文献格式并保留旧导出名', async () => {
        const callback = vi.fn();
        await subscribeToDocumentDrops(callback);
        mocks.dragDropHandler({
            payload: {
                type: 'drop',
                paths: ['a.pdf', 'b.md', 'c.markdown', 'd.docx', 'e.TEX', 'ignored.png'],
            },
        });

        expect(callback).toHaveBeenCalledWith(['a.pdf', 'b.md', 'c.markdown', 'd.docx', 'e.TEX']);
        expect(subscribeToPdfDrops).toBe(subscribeToDocumentDrops);
    });
});

describe('论文批量生命周期 bridge', () => {
    it('规范化并去重 ID，且每种批量操作只调用一次后端命令', async () => {
        mocks.invoke.mockImplementation((_command, { paperIds }) => Promise.resolve(paperIds));

        await expect(archivePapers([' paper-a ', 'paper-a', 'paper-b'])).resolves.toEqual(['paper-a', 'paper-b']);
        await expect(unarchivePapers(['paper-a', 'paper-b'])).resolves.toEqual(['paper-a', 'paper-b']);
        await expect(movePapersToTrash(['paper-a', 'paper-b'])).resolves.toEqual(['paper-a', 'paper-b']);
        await expect(restorePapers(['paper-a', 'paper-b'])).resolves.toEqual(['paper-a', 'paper-b']);

        expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'research_archive_papers', {
            paperIds: ['paper-a', 'paper-b'],
        });
        expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'research_unarchive_papers', {
            paperIds: ['paper-a', 'paper-b'],
        });
        expect(mocks.invoke).toHaveBeenNthCalledWith(3, 'research_move_papers_to_trash', {
            paperIds: ['paper-a', 'paper-b'],
        });
        expect(mocks.invoke).toHaveBeenNthCalledWith(4, 'research_restore_papers', {
            paperIds: ['paper-a', 'paper-b'],
        });
    });

    it('先去重再限制批次，并在 IPC 前拒绝空 ID、空批次和超大批次', async () => {
        mocks.invoke.mockImplementation((_command, { paperIds }) => Promise.resolve(paperIds));
        await expect(archivePapers(Array.from({ length: 501 }, () => ' paper-a '))).resolves.toEqual(['paper-a']);
        expect(mocks.invoke).toHaveBeenCalledOnce();
        mocks.invoke.mockClear();

        await expect(archivePapers([])).rejects.toThrow('至少选择');
        await expect(archivePapers(['paper-a', '  '])).rejects.toThrow('不能为空');
        await expect(archivePapers(Array.from({ length: 501 }, (_, index) => `paper-${index}`))).rejects.toThrow(
            '最多批量处理 500'
        );
        expect(mocks.invoke).not.toHaveBeenCalled();
    });

    it('演示模式保持归档与回收站互斥，并在缺失 ID 时整批不修改', async () => {
        delete window.__TAURI_INTERNALS__;
        try {
            await expect(archivePapers([' demo-memory ', 'demo-memory'])).resolves.toEqual(['demo-memory']);
            let paper = (await listPapers()).find((candidate) => candidate.id === 'demo-memory');
            expect(paper.archivedAt).toBeTruthy();
            expect(paper.trashedAt).toBeNull();
            expect((await listPapers({ includeTrashed: false })).some((candidate) => candidate.id === paper.id)).toBe(
                false
            );

            await movePapersToTrash(['demo-memory']);
            paper = (await listPapers()).find((candidate) => candidate.id === 'demo-memory');
            expect(paper.archivedAt).toBeNull();
            expect(paper.trashedAt).toBeTruthy();

            await restorePapers(['demo-memory']);
            await expect(archivePapers(['demo-memory', 'missing-paper'])).rejects.toThrow('missing-paper');
            paper = (await listPapers()).find((candidate) => candidate.id === 'demo-memory');
            expect(paper.archivedAt).toBeNull();
            expect(paper.trashedAt).toBeNull();

            await archivePapers(['demo-memory']);
            await unarchivePapers(['demo-memory']);
            paper = (await listPapers()).find((candidate) => candidate.id === 'demo-memory');
            expect(paper.archivedAt).toBeNull();
            expect(paper.trashedAt).toBeNull();
        } finally {
            await restorePapers(['demo-memory']);
        }
    });
});

describe('论文概要与词典 bridge', () => {
    it('批量索引会清理空白页并调用单次后端事务', async () => {
        mocks.invoke.mockResolvedValue(2);

        await expect(
            indexDocumentPages('paper-1', [
                { pageNumber: 1, text: '  first   page  ' },
                { pageNumber: 2, text: '   ' },
                { pageNumber: 3, text: 'third\n\n\npage' },
            ])
        ).resolves.toBe(2);

        expect(mocks.invoke).toHaveBeenCalledWith('research_index_pages', {
            paperId: 'paper-1',
            pages: [
                { pageNumber: 1, text: 'first page' },
                { pageNumber: 3, text: 'third\n\npage' },
            ],
        });
    });

    it('超长文档按固定页数分批索引，避免单次 IPC 携带整本正文', async () => {
        mocks.invoke.mockResolvedValue(32);
        const pages = Array.from({ length: 65 }, (_, index) => ({
            pageNumber: index + 1,
            text: `第 ${index + 1} 页`,
        }));

        await expect(indexDocumentPages('paper-long', pages)).resolves.toBe(96);
        expect(mocks.invoke).toHaveBeenCalledTimes(3);
        expect(mocks.invoke.mock.calls.map(([, args]) => args.pages.length)).toEqual([32, 32, 1]);
    });

    it('目录保存前规范标题、层级、页码和置信度', async () => {
        mocks.invoke.mockImplementation((_command, args) => Promise.resolve(args.outline));

        await expect(
            replaceDocumentOutline('paper-1', [
                { title: '  1   Introduction  ', pageNumber: 2, level: 0, source: 'native', confidence: 2 },
                { title: '   ', pageNumber: 3 },
            ])
        ).resolves.toEqual([
            {
                title: '1 Introduction',
                pageNumber: 2,
                endPage: 2,
                level: 1,
                source: 'native',
                confidence: 1,
            },
        ]);
        expect(mocks.invoke).toHaveBeenCalledWith('research_replace_document_outline', {
            paperId: 'paper-1',
            outline: expect.any(Array),
        });
    });

    it('全文 OCR 完成后可从本地文本块保守重建目录', async () => {
        mocks.invoke.mockResolvedValueOnce([{ title: '第一章', pageNumber: 3 }]);

        await expect(rebuildDocumentOutline('paper-scan', 'OCR')).resolves.toEqual([
            { title: '第一章', pageNumber: 3 },
        ]);
        expect(mocks.invoke).toHaveBeenCalledWith('research_rebuild_document_outline', {
            paperId: 'paper-scan',
            source: 'ocr',
        });
    });

    it('读取、强制重建、取消概要与词典均只通过桌面后端', async () => {
        mocks.invoke
            .mockResolvedValueOnce({ status: 'ready' })
            .mockResolvedValueOnce({ status: 'generating' })
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce({ term: 'flux', phonetics: [], senses: [] });

        await expect(getPaperInsights('paper-1')).resolves.toEqual({ status: 'ready' });
        await expect(generatePaperInsights('paper-1', { force: true })).resolves.toEqual({ status: 'generating' });
        await expect(cancelPaperInsights('paper-1')).resolves.toBe(true);
        await expect(
            defineTerm({
                selection: { quote: 'flux', prefix: 'metabolic ', suffix: ' balance' },
                targetLanguage: 'zh_cn',
            })
        ).resolves.toMatchObject({ term: 'flux' });

        expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'research_get_paper_insights', { paperId: 'paper-1' });
        expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'research_generate_paper_insights', {
            paperId: 'paper-1',
            force: true,
        });
        expect(mocks.invoke).toHaveBeenNthCalledWith(3, 'research_cancel_paper_insights', {
            paperId: 'paper-1',
        });
        expect(mocks.invoke).toHaveBeenNthCalledWith(4, 'research_define_term', {
            term: 'flux',
            contextBefore: 'metabolic ',
            contextAfter: ' balance',
            targetLanguage: 'zh_cn',
            requestId: expect.stringMatching(/^define-term-/u),
        });
    });

    it('章节概要请求规范物理页范围并使用独立持久化命令', async () => {
        mocks.invoke
            .mockResolvedValueOnce([{ ordinal: 0, status: 'ready' }])
            .mockResolvedValueOnce({ ordinal: 2, status: 'not_started' })
            .mockResolvedValueOnce({ ordinal: 2, status: 'ready' });

        await expect(listChapterInsights('paper-1')).resolves.toHaveLength(1);
        await expect(
            getChapterInsights('paper-1', {
                index: 2,
                title: '  Methods  ',
                pageNumber: 7,
                endPage: 4,
            })
        ).resolves.toMatchObject({ ordinal: 2, status: 'not_started' });
        await expect(
            generateChapterInsights(
                'paper-1',
                { ordinal: 2, title: 'Methods', pageNumber: 7, endPage: 12 },
                { force: true }
            )
        ).resolves.toMatchObject({ ordinal: 2, status: 'ready' });

        expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'research_list_chapter_insights', { paperId: 'paper-1' });
        expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'research_get_chapter_insights', {
            paperId: 'paper-1',
            ordinal: 2,
            title: 'Methods',
            startPage: 7,
            endPage: 7,
        });
        expect(mocks.invoke).toHaveBeenNthCalledWith(3, 'research_generate_chapter_insights', {
            paperId: 'paper-1',
            ordinal: 2,
            title: 'Methods',
            startPage: 7,
            endPage: 12,
            force: true,
        });
    });

    it('启动时只从桌面后端读取持久化的待生成概要队列', async () => {
        mocks.invoke.mockResolvedValue(['paper-a', 'paper-b']);

        await expect(listPendingPaperInsights()).resolves.toEqual(['paper-a', 'paper-b']);
        expect(mocks.invoke).toHaveBeenCalledOnce();
        expect(mocks.invoke).toHaveBeenCalledWith('research_list_pending_paper_insights', {});
    });

    it('概要队列从桌面后端读取前台翻译活跃状态', async () => {
        mocks.invoke.mockResolvedValue(true);

        await expect(isTranslationActive()).resolves.toBe(true);
        expect(mocks.invoke).toHaveBeenCalledWith('research_is_translation_active', {});
    });

    it('中止词典请求时把同一 requestId 通知 Rust，避免旧模型继续占用翻译队列', async () => {
        const controller = new AbortController();
        let resolveDefinition;
        const pendingDefinition = new Promise((resolve) => {
            resolveDefinition = resolve;
        });
        mocks.invoke.mockImplementation((command) => {
            if (command === 'research_define_term') return pendingDefinition;
            return Promise.resolve();
        });

        const pending = defineTerm({
            selection: { quote: 'flux', prefix: 'metabolic ', suffix: ' balance' },
            targetLanguage: 'zh_cn',
            signal: controller.signal,
        });
        const requestId = mocks.invoke.mock.calls[0][1].requestId;
        controller.abort();
        expect(mocks.invoke).toHaveBeenCalledWith('research_cancel_define_term', { requestId });
        resolveDefinition({ term: 'flux' });
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });
});

describe('论文项目分类 bridge', () => {
    it('完整暴露项目增删改查与论文归类命令', async () => {
        mocks.invoke
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce({ id: 'project-1', name: '代谢研究' })
            .mockResolvedValueOnce({ id: 'project-1', name: '代谢建模' })
            .mockResolvedValueOnce([{ id: 'project-1', name: '代谢建模' }])
            .mockResolvedValueOnce(undefined);

        await expect(listProjects()).resolves.toEqual([]);
        await createProject({ name: '  代谢研究  ', color: '#AABBCC', description: '  研究说明  ' });
        await updateProject('project-1', {
            name: '代谢建模',
            color: '#123456',
            description: '模型与方法',
        });
        await setPaperProjects('paper-1', ['project-1', 'project-1']);
        await deleteProject('project-1');

        expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'research_list_projects', {});
        expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'research_create_project', {
            name: '代谢研究',
            color: '#aabbcc',
            description: '研究说明',
        });
        expect(mocks.invoke).toHaveBeenNthCalledWith(3, 'research_update_project', {
            projectId: 'project-1',
            name: '代谢建模',
            color: '#123456',
            description: '模型与方法',
        });
        expect(mocks.invoke).toHaveBeenNthCalledWith(4, 'research_set_paper_projects', {
            paperId: 'paper-1',
            projectIds: ['project-1'],
        });
        expect(mocks.invoke).toHaveBeenNthCalledWith(5, 'research_delete_project', {
            projectId: 'project-1',
        });
    });

    it('在调用后端前严格拒绝非法项目字段', async () => {
        await expect(createProject({ name: '', color: '#7664e9' })).rejects.toThrow('项目名称需为 1–80 个字符');
        await expect(createProject({ name: '项目', color: 'purple' })).rejects.toThrow('项目颜色必须是 #RRGGBB 格式');
        await expect(
            updateProject('project-1', { name: '项目\n换行', color: '#7664e9', description: '' })
        ).rejects.toThrow('项目名称不能包含换行符或控制字符');
        await expect(setPaperProjects('paper-1', [''])).rejects.toThrow('项目 ID 不能为空');
        expect(mocks.invoke).not.toHaveBeenCalled();
    });
});
