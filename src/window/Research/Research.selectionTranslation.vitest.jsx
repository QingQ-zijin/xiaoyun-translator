import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMocks = vi.hoisted(() => ({
    translateSelection: vi.fn(),
    askPaper: vi.fn(),
    speakText: vi.fn(),
}));

const speechMocks = vi.hoisted(() => ({
    cancel: vi.fn(),
    run: vi.fn(),
}));

vi.mock('../../domains/research/bridge', async () => {
    const actual = await vi.importActual('../../domains/research/bridge');
    return {
        ...actual,
        getDocument: vi.fn().mockResolvedValue({
            paper: { id: 'paper-selection', title: '选择稳定性测试', pageCount: 2, progress: {} },
            documentType: 'pdf',
            pageCount: 2,
            progress: {},
        }),
        getPaperInsights: vi.fn().mockResolvedValue({ status: 'ready', payload: { summary: '测试概要' } }),
        getPdfSource: vi.fn(() => 'asset://selection.pdf'),
        getTranslationStatus: vi.fn().mockResolvedValue({ model: 'test-model', ready: true, message: '已就绪' }),
        isTauriRuntime: () => true,
        listAnnotations: vi.fn().mockResolvedValue([]),
        listPendingPaperInsights: vi.fn().mockResolvedValue([]),
        listPaperRelations: vi.fn().mockResolvedValue({ outbound: [], inbound: [] }),
        saveReadingProgress: vi.fn().mockResolvedValue(undefined),
        subscribeToPdfDrops: vi.fn().mockResolvedValue(() => {}),
        subscribeToResearchJobs: vi.fn().mockResolvedValue(() => {}),
        translateSelection: bridgeMocks.translateSelection,
        askPaper: bridgeMocks.askPaper,
        speakText: bridgeMocks.speakText,
    };
});

vi.mock('../../hooks/useVoice', () => ({
    cancelSpeechRequest: speechMocks.cancel,
    useSpeechRequest: () => speechMocks.run,
}));

vi.mock('./hooks/useResearchLibrary', () => ({
    useResearchLibrary: () => ({
        papers: [{ id: 'paper-selection', title: '选择稳定性测试', pageCount: 2, tags: [], projects: [] }],
        visiblePapers: [{ id: 'paper-selection', title: '选择稳定性测试', pageCount: 2, tags: [], projects: [] }],
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
vi.mock('./components/LibrarySidebar', () => ({ default: () => null }));
vi.mock('./components/SelectionContextMenu', () => ({ default: () => null }));
vi.mock('./components/AnnotationEditorPopover', () => ({ default: () => null }));

vi.mock('./components/PaperLibrary', () => ({
    default: ({ onOpen }) => (
        <button
            type='button'
            onClick={() => onOpen('paper-selection')}
        >
            打开选择测试论文
        </button>
    ),
}));

vi.mock('./components/ReaderTopbar', () => ({
    default: ({ paper }) => <header>{paper.title}</header>,
    getOllamaModelDisplayName: (model) => model,
    getTranslationStatusPresentation: () => ({ state: 'ready', color: 'green', label: '就绪' }),
}));

const overlay = {
    anchorRect: { left: 120, right: 180, top: 120, bottom: 138, width: 60, height: 18 },
    selectionRect: { left: 100, right: 260, top: 100, bottom: 140, width: 160, height: 40 },
    boundaryRect: { left: 0, right: 900, top: 0, bottom: 700 },
};

vi.mock('./components/PdfWorkspace', async () => {
    const React = await vi.importActual('react');
    return {
        default: React.forwardRef(function MockPdfWorkspace({ onSelection }, ref) {
            React.useImperativeHandle(ref, () => ({ flushProgress: vi.fn(), goToPage: vi.fn(), search: vi.fn() }));
            const select = (quote) =>
                onSelection(
                    {
                        paperId: 'paper-selection',
                        pageNumber: 1,
                        quote,
                        prefix: 'Context before.',
                        suffix: 'Context after.',
                        rects: [],
                    },
                    `Context before. ${quote} Context after.`,
                    overlay
                );
            return (
                <main>
                    <button
                        type='button'
                        onClick={() => select('First sentence.')}
                    >
                        选择第一句
                    </button>
                    <button
                        type='button'
                        onClick={() => select('Second sentence.')}
                    >
                        选择第二句
                    </button>
                </main>
            );
        }),
    };
});

vi.mock('./components/SelectionTranslationPopover', () => ({
    default: ({ open, loading, error, value, onRetry, onClose, onSpeak, onExplain, aiState }) =>
        open ? (
            <aside aria-label='论文划词翻译状态'>
                {loading ? <span role='status'>正在翻译</span> : null}
                {error ? <span role='alert'>{error}</span> : null}
                {error ? (
                    <button
                        type='button'
                        onClick={onRetry}
                    >
                        重试
                    </button>
                ) : null}
                <output data-testid='selection-translation'>{value}</output>
                {aiState?.answer ? <output data-testid='selection-explanation'>{aiState.answer}</output> : null}
                <button
                    type='button'
                    onClick={() => onSpeak?.('First sentence.', { source: true })}
                >
                    朗读选择
                </button>
                <button
                    type='button'
                    onClick={onExplain}
                >
                    解释选择
                </button>
                <button
                    type='button'
                    onClick={onClose}
                >
                    关闭划词翻译
                </button>
            </aside>
        ) : null,
}));

import Research from './index';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function openReader() {
    render(<Research embedded />);
    fireEvent.click(await screen.findByRole('button', { name: '打开选择测试论文' }, { timeout: 5_000 }));
    await screen.findByRole('button', { name: '选择第一句' }, { timeout: 5_000 });
}

beforeEach(() => {
    vi.clearAllMocks();
    speechMocks.run.mockImplementation(async (loadAudio) => {
        await loadAudio();
        return true;
    });
    bridgeMocks.speakText.mockResolvedValue(new Uint8Array([1, 2, 3]));
    bridgeMocks.askPaper.mockResolvedValue({
        answer: '基于选区上下文的通用解释。',
        citations: [],
        refused: false,
        retrievalMode: 'contextual',
    });
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('论文划词翻译请求时序', () => {
    it('连续快速选择会取消旧请求，旧流与旧完成态都不能覆盖最新请求', async () => {
        const first = deferred();
        const second = deferred();
        bridgeMocks.translateSelection.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        await openReader();
        vi.useFakeTimers();

        fireEvent.click(screen.getByRole('button', { name: '选择第一句' }));
        await act(async () => vi.advanceTimersByTimeAsync(41));
        const firstRequest = bridgeMocks.translateSelection.mock.calls[0][0];

        fireEvent.click(screen.getByRole('button', { name: '选择第二句' }));
        expect(firstRequest.signal.aborted).toBe(true);
        await act(async () => vi.advanceTimersByTimeAsync(41));
        const secondRequest = bridgeMocks.translateSelection.mock.calls[1][0];
        expect(secondRequest.signal.aborted).toBe(false);

        await act(async () => {
            firstRequest.onDelta('不应出现的旧译文');
            first.resolve('不应出现的旧译文');
            await Promise.resolve();
        });
        expect(screen.getByTestId('selection-translation').textContent).toBe('');
        expect(screen.getByText('正在翻译')).toBeTruthy();

        await act(async () => {
            secondRequest.onDelta('最新流式译文');
            second.resolve('最新完整译文');
            await Promise.resolve();
        });
        expect(screen.getByTestId('selection-translation').textContent).toBe('最新完整译文');
        expect(screen.queryByText('正在翻译')).toBeNull();
    });

    it('悬挂请求会给出明确错误，并可在原选区重试恢复', async () => {
        const hung = deferred();
        const retried = deferred();
        bridgeMocks.translateSelection.mockReturnValueOnce(hung.promise).mockReturnValueOnce(retried.promise);
        await openReader();
        vi.useFakeTimers();

        fireEvent.click(screen.getByRole('button', { name: '选择第一句' }));
        await act(async () => vi.advanceTimersByTimeAsync(41));
        const firstRequest = bridgeMocks.translateSelection.mock.calls[0][0];
        await act(async () => vi.advanceTimersByTimeAsync(20_001));

        expect(firstRequest.signal.aborted).toBe(true);
        expect(screen.getByRole('alert').textContent).toContain('等待超过 20 秒');
        fireEvent.click(screen.getByRole('button', { name: '重试' }));
        await act(async () => vi.advanceTimersByTimeAsync(41));
        const retryRequest = bridgeMocks.translateSelection.mock.calls[1][0];
        expect(retryRequest.signal.aborted).toBe(false);

        await act(async () => {
            retryRequest.onDelta('恢复中的译文');
            retried.resolve('重试成功');
            await retried.promise;
        });
        vi.useRealTimers();
        await waitFor(
            () => {
                expect(screen.queryByRole('alert')).toBeNull();
                expect(screen.getByTestId('selection-translation').textContent).toBe('重试成功');
            },
            { timeout: 5_000 }
        );
    });

    it('自动启动 Ollama 时展示恢复状态并延长冷启动等待窗口', async () => {
        const recovering = deferred();
        bridgeMocks.translateSelection.mockReturnValueOnce(recovering.promise);
        await openReader();
        vi.useFakeTimers();

        fireEvent.click(screen.getByRole('button', { name: '选择第一句' }));
        await act(async () => vi.advanceTimersByTimeAsync(41));
        const request = bridgeMocks.translateSelection.mock.calls[0][0];

        await act(async () => {
            request.onStatus('Ollama 已退出，正在自动启动本地 AI…');
            await Promise.resolve();
        });

        await act(async () => vi.advanceTimersByTimeAsync(20_001));
        expect(request.signal.aborted).toBe(false);

        await act(async () => vi.advanceTimersByTimeAsync(110_000));
        expect(request.signal.aborted).toBe(true);
        expect(screen.getByRole('alert').textContent).toContain('自动启动超过 130 秒');
    });

    it('关闭浮窗会立即中断在飞请求，旧流不能重新打开结果', async () => {
        const active = deferred();
        bridgeMocks.translateSelection.mockReturnValueOnce(active.promise);
        await openReader();
        vi.useFakeTimers();

        fireEvent.click(screen.getByRole('button', { name: '选择第一句' }));
        await act(async () => vi.advanceTimersByTimeAsync(41));
        const request = bridgeMocks.translateSelection.mock.calls[0][0];

        fireEvent.click(screen.getByRole('button', { name: '关闭划词翻译' }));
        expect(request.signal.aborted).toBe(true);
        expect(screen.queryByLabelText('论文划词翻译状态')).toBeNull();

        await act(async () => {
            request.onDelta('不应恢复的旧译文');
            active.resolve('不应恢复的旧译文');
            await Promise.resolve();
        });
        expect(screen.queryByLabelText('论文划词翻译状态')).toBeNull();
    });

    it('论文划词朗读会把合成音频交给共享播放器，并在关闭时停止', async () => {
        bridgeMocks.translateSelection.mockResolvedValue('第一句。');
        await openReader();
        vi.useFakeTimers();

        fireEvent.click(screen.getByRole('button', { name: '选择第一句' }));
        await act(async () => vi.advanceTimersByTimeAsync(41));
        fireEvent.click(screen.getByRole('button', { name: '朗读选择' }));
        await act(async () => {
            await Promise.resolve();
        });
        expect(bridgeMocks.speakText).toHaveBeenCalledWith('First sentence.', 'en');
        expect(speechMocks.run).toHaveBeenCalledOnce();

        fireEvent.click(screen.getByRole('button', { name: '关闭划词翻译' }));
        expect(speechMocks.cancel).toHaveBeenCalled();
    });

    it('解释选区跳过嵌入安装阻塞，并保留上下文解释模式', async () => {
        bridgeMocks.translateSelection.mockResolvedValue('第一句。');
        await openReader();
        vi.useFakeTimers();

        fireEvent.click(screen.getByRole('button', { name: '选择第一句' }));
        await act(async () => vi.advanceTimersByTimeAsync(41));
        fireEvent.click(screen.getByRole('button', { name: '解释选择' }));
        await act(async () => {
            await Promise.resolve();
        });
        expect(screen.getByTestId('selection-explanation').textContent).toContain('通用解释');
        expect(bridgeMocks.askPaper).toHaveBeenCalledWith(
            expect.objectContaining({
                intent: 'explain_selection',
                selection: expect.objectContaining({ quote: 'First sentence.' }),
            })
        );
    });
});
