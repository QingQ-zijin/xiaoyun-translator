import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMocks = vi.hoisted(() => ({
    deleteAnnotation: vi.fn(),
    saveAnnotation: vi.fn(),
    sequence: 0,
}));

const papers = [
    { id: 'demo-memory', title: '论文 A', pageCount: 1, progress: {}, tags: [], projects: [] },
    { id: 'paper-b', title: '论文 B', pageCount: 1, progress: {}, tags: [], projects: [] },
];

vi.mock('../../domains/research/bridge', async () => {
    const actual = await vi.importActual('../../domains/research/bridge');
    return {
        ...actual,
        isTauriRuntime: () => false,
        getTranslationStatus: vi.fn().mockResolvedValue({ model: 'test-model', ready: true, message: '已就绪' }),
        getSemanticStatus: vi.fn().mockResolvedValue({ ready: false }),
        getDocument: vi.fn(async (paperId) => ({
            paper: papers.find((paper) => paper.id === paperId),
            pageCount: 1,
            progress: {},
        })),
        getPdfSource: vi.fn(() => ''),
        listAnnotations: vi.fn().mockResolvedValue([]),
        listPaperRelations: vi.fn().mockResolvedValue({ outbound: [], inbound: [] }),
        getPaperInsights: vi.fn().mockResolvedValue({ status: 'ready', summary: '测试概要', terms: [] }),
        cancelPaperInsights: vi.fn().mockResolvedValue(undefined),
        subscribeToResearchJobs: vi.fn().mockResolvedValue(() => {}),
        subscribeToPdfDrops: vi.fn().mockResolvedValue(() => {}),
        translateSelection: vi.fn().mockResolvedValue('测试译文'),
        defineTerm: vi.fn().mockResolvedValue(null),
        saveAnnotation: bridgeMocks.saveAnnotation,
        deleteAnnotation: bridgeMocks.deleteAnnotation,
        saveReadingProgress: vi.fn().mockResolvedValue(undefined),
    };
});

vi.mock('./hooks/useResearchLibrary', () => ({
    useResearchLibrary: () => ({
        papers,
        visiblePapers: papers,
        tags: [],
        projects: [],
        query: '',
        view: 'all',
        activeTagId: '',
        activeProjectId: '',
        importing: false,
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
vi.mock('./components/LibrarySidebar', () => ({ default: () => null }));
vi.mock('./components/PaperLibrary', () => ({ default: () => <div>论文库</div> }));
vi.mock('./components/SelectionContextMenu', () => ({ default: () => null }));

vi.mock('./components/ReaderTopbar', () => ({
    default: ({ paper, onPaperChange }) => (
        <header>
            <span>当前论文：{paper.title}</span>
            <input aria-label='阅读器搜索框' />
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
        default: React.forwardRef(function MockPdfWorkspace({ annotations, onAnnotationDelete }, ref) {
            React.useImperativeHandle(ref, () => ({ goToPage: vi.fn(), search: vi.fn() }));
            const first = annotations[0];
            return (
                <main aria-label='测试阅读区'>
                    <span>批注 {annotations.length}</span>
                    <span>笔记内容：{first?.note || '无'}</span>
                    {first ? (
                        <button
                            type='button'
                            onClick={() => onAnnotationDelete(first)}
                        >
                            删除当前批注
                        </button>
                    ) : null}
                </main>
            );
        }),
    };
});

vi.mock('./components/SelectionTranslationPopover', () => ({
    default: ({ onHighlight }) => (
        <button
            type='button'
            onClick={() => onHighlight({ color: 'violet' })}
        >
            创建测试高亮
        </button>
    ),
}));

vi.mock('./components/AnnotationEditorPopover', () => ({
    default: ({ onSave }) => (
        <button
            type='button'
            onClick={() =>
                onSave({
                    id: 'annotation-1',
                    paperId: 'demo-memory',
                    pageNumber: 2,
                    kind: 'note',
                    quote: '测试选区',
                    note: '已编辑',
                    tags: [],
                    rects: [],
                })
            }
        >
            编辑测试批注
        </button>
    ),
}));

import Research from './index';

beforeEach(() => {
    bridgeMocks.sequence = 0;
    bridgeMocks.deleteAnnotation.mockReset().mockResolvedValue(undefined);
    bridgeMocks.saveAnnotation.mockReset().mockImplementation(async (annotation) => ({
        ...annotation,
        id: annotation.id ?? `annotation-${++bridgeMocks.sequence}`,
    }));
});

afterEach(cleanup);

describe('论文批注界面撤销链路', () => {
    it('显式要求返回论文库时不再载入浏览器演示论文', async () => {
        render(
            <Research
                embedded
                startInLibrary
            />
        );

        expect(await screen.findByText('论文库')).toBeTruthy();
        expect(screen.queryByText(/当前论文：/u)).toBeNull();
    });

    it('依次撤销编辑、删除和创建，并同步更新可见批注', async () => {
        render(<Research embedded />);
        await screen.findByText('当前论文：论文 A');

        fireEvent.click(screen.getByRole('button', { name: '创建测试高亮' }));
        await screen.findByText('批注 1');

        fireEvent.click(screen.getByRole('button', { name: '编辑测试批注' }));
        await screen.findByText('笔记内容：已编辑');
        fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
        await screen.findByText('笔记内容：测试译文');

        fireEvent.click(screen.getByRole('button', { name: '删除当前批注' }));
        await screen.findByText('批注 0');
        fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
        await screen.findByText('批注 1');

        fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
        await screen.findByText('批注 0');
        expect(screen.getByRole('status').textContent).toContain('已撤销最近一次创建');
        await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), { timeout: 5_000 });
        expect(bridgeMocks.deleteAnnotation).toHaveBeenCalledTimes(2);
    });

    it('输入框保留系统撤销，切换论文后清空旧论文的撤销栈', async () => {
        render(<Research embedded />);
        await screen.findByText('当前论文：论文 A');
        fireEvent.click(screen.getByRole('button', { name: '创建测试高亮' }));
        await screen.findByText('批注 1');

        const input = screen.getByRole('textbox', { name: '阅读器搜索框' });
        fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
        expect(bridgeMocks.deleteAnnotation).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: '切换到论文 B' }));
        await screen.findByText('当前论文：论文 B');
        fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
        await waitFor(() => expect(bridgeMocks.deleteAnnotation).not.toHaveBeenCalled());
    });
});
