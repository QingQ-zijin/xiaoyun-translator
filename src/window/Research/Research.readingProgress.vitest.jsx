import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
    papers: [
        { id: 'demo-memory', title: '论文 A', pageCount: 12, tags: [], projects: [] },
        { id: 'paper-b', title: '论文 B', pageCount: 18, tags: [], projects: [] },
    ],
    progressByPaper: new Map(),
    getDocument: vi.fn(),
    saveReadingProgress: vi.fn(),
    isTauri: false,
}));

vi.mock('../../domains/research/bridge', async () => {
    const actual = await vi.importActual('../../domains/research/bridge');
    return {
        ...actual,
        isTauriRuntime: () => testState.isTauri,
        getTranslationStatus: vi.fn().mockResolvedValue({ model: 'test-model', ready: true, message: '已就绪' }),
        getDocument: testState.getDocument,
        getPdfSource: vi.fn(() => ''),
        listAnnotations: vi.fn().mockResolvedValue([]),
        listPaperRelations: vi.fn().mockResolvedValue({ outbound: [], inbound: [] }),
        getPaperInsights: vi.fn().mockResolvedValue({ status: 'ready', summary: '测试概要', terms: [] }),
        cancelPaperInsights: vi.fn().mockResolvedValue(undefined),
        subscribeToResearchJobs: vi.fn().mockResolvedValue(() => {}),
        subscribeToPdfDrops: vi.fn().mockResolvedValue(() => {}),
        translateSelection: vi.fn().mockResolvedValue('测试译文'),
        defineTerm: vi.fn().mockResolvedValue(null),
        saveReadingProgress: testState.saveReadingProgress,
    };
});

vi.mock('./hooks/useResearchLibrary', () => ({
    useResearchLibrary: () => ({
        papers: testState.papers,
        visiblePapers: testState.papers,
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
    default: ({ mode, onBack }) =>
        mode === 'reader' ? (
            <button
                type='button'
                onClick={onBack}
            >
                返回论文库
            </button>
        ) : null,
}));

vi.mock('./components/PaperLibrary', () => ({
    default: ({ onOpen }) => (
        <main aria-label='测试论文库'>
            <button
                type='button'
                onClick={() => onOpen('demo-memory')}
            >
                打开论文 A
            </button>
            <button
                type='button'
                onClick={() => onOpen('paper-b')}
            >
                打开论文 B
            </button>
        </main>
    ),
}));

vi.mock('./components/ReaderTopbar', () => ({
    default: ({ paper, onPaperChange }) => (
        <header>
            <span>当前论文：{paper.title}</span>
            <button
                type='button'
                onClick={() => onPaperChange('demo-memory')}
            >
                切换到论文 A
            </button>
            <button
                type='button'
                onClick={() => onPaperChange('paper-b')}
            >
                切换到论文 B
            </button>
        </header>
    ),
    getOllamaModelDisplayName: (model) => model,
    getTranslationStatusPresentation: () => ({ state: 'ready', color: 'green', label: '就绪' }),
}));

vi.mock('./components/PdfWorkspace', async () => {
    const React = await vi.importActual('react');
    return {
        default: React.forwardRef(function MockPdfWorkspace(
            { document, currentPage, scale, initialProgress, onPageChange, onScaleChange, onProgress },
            ref
        ) {
            React.useImperativeHandle(ref, () => ({ goToPage: vi.fn(), search: vi.fn() }));
            const paperId = document.paper.id;
            return (
                <main aria-label='测试阅读区'>
                    <output>
                        paper={paperId};page={currentPage};scale={scale};scroll={initialProgress?.scrollRatio}
                    </output>
                    <button
                        type='button'
                        onClick={() => {
                            onPageChange(9);
                            onScaleChange(1.4);
                            onProgress({ pageNumber: 9, scale: 1.4, scrollRatio: 0.61 });
                        }}
                    >
                        模拟继续阅读论文 B
                    </button>
                </main>
            );
        }),
    };
});

import Research from './index';

beforeEach(() => {
    testState.papers = [
        { id: 'demo-memory', title: '论文 A', pageCount: 12, tags: [], projects: [] },
        { id: 'paper-b', title: '论文 B', pageCount: 18, tags: [], projects: [] },
    ];
    testState.isTauri = false;
    testState.progressByPaper.clear();
    testState.progressByPaper.set('demo-memory', { pageNumber: 7, scale: 1.6, scrollRatio: 0.42 });
    testState.progressByPaper.set('paper-b', { pageNumber: 3, scale: 0.95, scrollRatio: 0.18 });
    testState.getDocument.mockReset().mockImplementation(async (paperId) => {
        const paper = testState.papers.find((item) => item.id === paperId);
        const progress = { ...testState.progressByPaper.get(paperId) };
        return { paper: { ...paper, progress }, pageCount: paper.pageCount, progress };
    });
    testState.saveReadingProgress.mockReset().mockImplementation(async (paperId, progress) => {
        testState.progressByPaper.set(paperId, { ...progress });
        return progress;
    });
});

afterEach(cleanup);

describe('论文阅读进度恢复', () => {
    it('按论文分别恢复页码、缩放和滚动位置，切换及返回论文库后重开仍保持', async () => {
        const view = render(<Research embedded />);

        expect(await screen.findByText('paper=demo-memory;page=7;scale=1.6;scroll=0.42')).toBeTruthy();
        expect(testState.saveReadingProgress).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: '切换到论文 B' }));
        expect(await screen.findByText('paper=paper-b;page=3;scale=0.95;scroll=0.18')).toBeTruthy();
        expect(testState.saveReadingProgress).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: '模拟继续阅读论文 B' }));
        await waitFor(() =>
            expect(testState.saveReadingProgress).toHaveBeenCalledWith('paper-b', {
                pageNumber: 9,
                scale: 1.4,
                scrollRatio: 0.61,
            })
        );

        fireEvent.click(screen.getByRole('button', { name: '切换到论文 A' }));
        expect(await screen.findByText('paper=demo-memory;page=7;scale=1.6;scroll=0.42')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: '切换到论文 B' }));
        expect(await screen.findByText('paper=paper-b;page=9;scale=1.4;scroll=0.61')).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: '返回论文库' }));
        await screen.findByRole('main', { name: '测试论文库' });
        fireEvent.click(screen.getByRole('button', { name: '打开论文 B' }));
        expect(await screen.findByText('paper=paper-b;page=9;scale=1.4;scroll=0.61')).toBeTruthy();

        view.unmount();
        render(
            <Research
                embedded
                startInLibrary
            />
        );
        fireEvent.click(await screen.findByRole('button', { name: '打开论文 B' }));
        expect(await screen.findByText('paper=paper-b;page=9;scale=1.4;scroll=0.61')).toBeTruthy();
        expect(testState.saveReadingProgress).toHaveBeenCalledTimes(1);
    });

    it('桌面端进入论文库时只自动打开一次最近阅读论文，主动返回后停留在管理页', async () => {
        testState.isTauri = true;
        testState.papers = [testState.papers[1], testState.papers[0]];

        render(<Research embedded />);

        expect(await screen.findByText('paper=paper-b;page=3;scale=0.95;scroll=0.18')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: '返回论文库' }));
        expect(await screen.findByRole('main', { name: '测试论文库' })).toBeTruthy();
        await waitFor(() => expect(screen.queryByText(/paper=paper-b/u)).toBeNull());
    });
});
