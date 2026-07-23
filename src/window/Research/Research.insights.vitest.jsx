import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    generatePaperInsights: vi.fn(),
    generateChapterInsights: vi.fn(),
    getPaperInsights: vi.fn(),
    indexDocumentPages: vi.fn(),
    listPendingPaperInsights: vi.fn(),
    listChapterInsights: vi.fn(),
    rebuildDocumentOutline: vi.fn(),
    replaceDocumentOutline: vi.fn(),
    updateDocumentPageCount: vi.fn(),
    jobListener: null,
}));

vi.mock('../../domains/research/bridge', async () => {
    const actual = await vi.importActual('../../domains/research/bridge');
    return {
        ...actual,
        generatePaperInsights: mocks.generatePaperInsights,
        getDocument: vi.fn().mockResolvedValue({
            paper: { id: 'paper-1', title: '测试论文', pageCount: 2, progress: {} },
            documentType: 'pdf',
            pageCount: 2,
            progress: {},
        }),
        generateChapterInsights: mocks.generateChapterInsights,
        getPaperInsights: mocks.getPaperInsights,
        getPdfSource: vi.fn(() => 'asset://paper.pdf'),
        getTranslationStatus: vi.fn().mockResolvedValue({ model: 'test-model', ready: true, message: '已就绪' }),
        indexDocumentPages: mocks.indexDocumentPages,
        isTauriRuntime: () => true,
        isTranslationActive: vi.fn().mockResolvedValue(false),
        listAnnotations: vi.fn().mockResolvedValue([]),
        listChapterInsights: mocks.listChapterInsights,
        listPendingPaperInsights: mocks.listPendingPaperInsights,
        listPaperRelations: vi.fn().mockResolvedValue({ outbound: [], inbound: [] }),
        rebuildDocumentOutline: mocks.rebuildDocumentOutline,
        replaceDocumentOutline: mocks.replaceDocumentOutline,
        saveReadingProgress: vi.fn().mockResolvedValue(undefined),
        subscribeToPdfDrops: vi.fn().mockResolvedValue(() => {}),
        subscribeToResearchJobs: vi.fn().mockImplementation(async (listener) => {
            mocks.jobListener = listener;
            return () => {};
        }),
        syncPaperReferences: vi.fn().mockResolvedValue({ outbound: [], inbound: [] }),
        updateDocumentPageCount: mocks.updateDocumentPageCount,
    };
});

vi.mock('./hooks/useResearchLibrary', () => ({
    useResearchLibrary: () => ({
        papers: [{ id: 'paper-1', title: '测试论文', pageCount: 2, tags: [], projects: [] }],
        visiblePapers: [{ id: 'paper-1', title: '测试论文', pageCount: 2, tags: [], projects: [] }],
        tags: [],
        projects: [],
        query: '',
        view: 'all',
        activeTagId: '',
        activeProjectId: '',
        loading: false,
        importing: false,
        error: '',
        setQuery: vi.fn(),
        setView: vi.fn(),
        setActiveTagId: vi.fn(),
        setActiveProjectId: vi.fn(),
        selectProject: vi.fn(),
        addProject: vi.fn(),
        editProject: vi.fn(),
        removeProject: vi.fn(),
        importPaths: vi.fn().mockResolvedValue([]),
        updatePaperTags: vi.fn(),
        updatePaperProjects: vi.fn(),
        moveToTrash: vi.fn(),
        restore: vi.fn(),
        deletePermanently: vi.fn(),
    }),
}));

vi.mock('./components/AppRail', () => ({ default: () => null }));
vi.mock('./components/SelectionContextMenu', () => ({ default: () => null }));
vi.mock('./components/SelectionTranslationPopover', () => ({ default: () => null }));
vi.mock('./components/AnnotationEditorPopover', () => ({ default: () => null }));

vi.mock('./components/LibrarySidebar', () => ({
    default: ({ mode, insights, outline, chapterInsightState, onSelectChapter }) => {
        if (mode !== 'reader') return null;
        const payload = insights?.payload ?? insights ?? {};
        return (
            <aside aria-label='概要状态'>
                <output>{insights?.status}</output>
                <p>{payload.summary ?? ''}</p>
                {outline?.[0] ? (
                    <button
                        type='button'
                        onClick={() => onSelectChapter?.(outline[0], 0)}
                    >
                        生成首章概要
                    </button>
                ) : null}
                <p>{chapterInsightState?.insight?.payload?.summary ?? ''}</p>
            </aside>
        );
    },
}));

vi.mock('./components/PaperLibrary', () => ({
    default: ({ onOpen }) => (
        <button
            type='button'
            onClick={() => onOpen('paper-1')}
        >
            打开测试论文
        </button>
    ),
}));

vi.mock('./components/ReaderTopbar', () => ({
    default: ({ paper }) => <header>当前论文：{paper.title}</header>,
    getOllamaModelDisplayName: (model) => model,
    getTranslationStatusPresentation: () => ({ state: 'ready', color: 'green', label: '就绪' }),
}));

vi.mock('./components/PdfWorkspace', async () => {
    const React = await vi.importActual('react');
    return {
        default: React.forwardRef(function MockPdfWorkspace({ document, onDocumentPages, onOutline }, ref) {
            React.useImperativeHandle(ref, () => ({ flushProgress: vi.fn(), goToPage: vi.fn(), search: vi.fn() }));
            React.useEffect(() => {
                const outline = [
                    {
                        title: 'Introduction',
                        pageNumber: 1,
                        endPage: 2,
                        level: 1,
                        source: 'native',
                        confidence: 1,
                    },
                ];
                void onOutline?.(outline);
                void onDocumentPages?.({
                    pages: [{ pageNumber: 1, text: 'metabolic flux analysis' }],
                    pageCount: 2,
                    textPageCount: 1,
                    totalCharacters: 24,
                    outline,
                });
            }, [document.paper.id, onDocumentPages, onOutline]);
            return <main>PDF 阅读区</main>;
        }),
    };
});

import Research from './index';

beforeEach(() => {
    vi.clearAllMocks();
    mocks.indexDocumentPages.mockResolvedValue(1);
    mocks.listPendingPaperInsights.mockResolvedValue([]);
    mocks.listChapterInsights.mockResolvedValue([]);
    mocks.generateChapterInsights.mockResolvedValue({ status: 'not_started', payload: { summary: '', terms: [] } });
    mocks.replaceDocumentOutline.mockImplementation(async (_paperId, outline) => outline);
    mocks.rebuildDocumentOutline.mockResolvedValue([]);
    mocks.updateDocumentPageCount.mockResolvedValue(undefined);
    mocks.jobListener = null;
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('导入后概要生成与重开复用', () => {
    it('全文索引完成后自动使用非强制模式生成并显示持久化结果', async () => {
        mocks.getPaperInsights.mockResolvedValue({ status: 'not_started', payload: { summary: '' } });
        mocks.generatePaperInsights.mockResolvedValue({
            status: 'ready',
            cached: false,
            payload: { summary: '已自动保存的论文概要' },
        });

        render(<Research embedded />);
        fireEvent.click(await screen.findByRole('button', { name: '打开测试论文' }));

        await screen.findByText('已自动保存的论文概要');
        expect(mocks.indexDocumentPages).toHaveBeenCalledWith('paper-1', [
            { pageNumber: 1, text: 'metabolic flux analysis' },
        ]);
        expect(mocks.generatePaperInsights).toHaveBeenCalledOnce();
        expect(mocks.generatePaperInsights).toHaveBeenCalledWith('paper-1', { force: false });
    });

    it('重新打开已有 ready 概要时始终显示缓存且不再调用模型', async () => {
        mocks.getPaperInsights.mockResolvedValue({
            status: 'ready',
            cached: true,
            payload: { summary: '数据库中的既有概要' },
        });

        render(<Research embedded />);
        fireEvent.click(await screen.findByRole('button', { name: '打开测试论文' }));

        expect(await screen.findByText('数据库中的既有概要')).toBeTruthy();
        expect(mocks.generatePaperInsights).not.toHaveBeenCalled();
        expect(screen.getByRole('status').textContent).toBe('ready');
    });

    it('PDF 书签一经解析就持久化，全文回调不会重复写入相同目录', async () => {
        mocks.getPaperInsights.mockResolvedValue({ status: 'ready', payload: { summary: '缓存概要' } });

        render(<Research embedded />);
        fireEvent.click(await screen.findByRole('button', { name: '打开测试论文' }));

        await vi.waitFor(() => expect(mocks.replaceDocumentOutline).toHaveBeenCalledOnce());
        expect(mocks.updateDocumentPageCount).toHaveBeenCalledWith('paper-1', 2);
        expect(mocks.replaceDocumentOutline).toHaveBeenCalledWith('paper-1', [
            expect.objectContaining({ title: 'Introduction', pageNumber: 1, source: 'native' }),
        ]);
    });

    it('扫描全文完成后重建目录并重新排队读取持久化概要', async () => {
        mocks.getPaperInsights.mockResolvedValue({ status: 'ready', payload: { summary: '缓存概要' } });
        mocks.rebuildDocumentOutline.mockResolvedValue([
            { title: '第一章', pageNumber: 1, endPage: 2, level: 1, source: 'ocr', confidence: 0.7 },
        ]);

        render(<Research embedded />);
        fireEvent.click(await screen.findByRole('button', { name: '打开测试论文' }));
        await vi.waitFor(() => expect(mocks.jobListener).toEqual(expect.any(Function)));
        mocks.jobListener({
            paperId: 'paper-1',
            jobId: 'ocr-book-1',
            kind: 'ocr-document',
            state: 'completed',
            message: '整篇 OCR 已完成',
        });

        await vi.waitFor(() => expect(mocks.rebuildDocumentOutline).toHaveBeenCalledWith('paper-1', 'ocr'));
    });

    it('点击章节后按需调用 Gemma，完成结果留在章节状态中', async () => {
        mocks.getPaperInsights.mockResolvedValue({ status: 'ready', payload: { summary: '缓存概要' } });
        mocks.generateChapterInsights.mockResolvedValue({
            ordinal: 0,
            title: 'Introduction',
            startPage: 1,
            endPage: 2,
            status: 'ready',
            cached: false,
            payload: { summary: '本章介绍研究背景。', terms: [] },
        });

        render(<Research embedded />);
        fireEvent.click(await screen.findByRole('button', { name: '打开测试论文' }));
        fireEvent.click(await screen.findByRole('button', { name: '生成首章概要' }));

        expect(await screen.findByText('本章介绍研究背景。')).toBeTruthy();
        expect(mocks.generateChapterInsights).toHaveBeenCalledWith(
            'paper-1',
            expect.objectContaining({ ordinal: 0, title: 'Introduction', pageNumber: 1, endPage: 2 }),
            { force: false }
        );
    });

    it('启动恢复查询临时失败后按退避自动重试', async () => {
        vi.useFakeTimers();
        mocks.listPendingPaperInsights.mockRejectedValueOnce(new Error('数据库暂时忙')).mockResolvedValueOnce([]);

        render(<Research embedded />);
        await vi.waitFor(() => expect(mocks.listPendingPaperInsights).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(10_000);
        expect(mocks.listPendingPaperInsights).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
    });
});
