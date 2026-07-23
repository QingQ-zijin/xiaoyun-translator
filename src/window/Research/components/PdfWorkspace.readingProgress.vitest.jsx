import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import PdfWorkspace from './PdfWorkspace';

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('PDF 阅读位置恢复', () => {
    it('应用保存的滚动比例，且恢复完成前不会把默认第一页写回', async () => {
        const onProgress = vi.fn();
        const progress = { pageNumber: 3, scale: 1.5, scrollRatio: 0.42 };
        const { rerender } = render(
            <PdfWorkspace
                source=''
                document={{ paper: { id: 'paper-a' }, pageCount: 6 }}
                currentPage={1}
                scale={1.25}
                initialProgress={undefined}
                onProgress={onProgress}
            />
        );
        const workspace = screen.getByRole('main', { name: 'PDF 阅读区' });
        Object.defineProperties(workspace, {
            scrollHeight: { configurable: true, value: 2_000 },
            clientHeight: { configurable: true, value: 500 },
            scrollTop: { configurable: true, writable: true, value: 0 },
        });

        // 模拟 PDF 尚未拿到后端进度时出现的默认位置滚动事件。
        fireEvent.scroll(workspace);
        rerender(
            <PdfWorkspace
                source=''
                document={{ paper: { id: 'paper-a' }, pageCount: 6 }}
                currentPage={3}
                scale={1.5}
                initialProgress={progress}
                onProgress={onProgress}
            />
        );

        await waitFor(() => expect(workspace.scrollTop).toBe(630));
        await waitFor(() => expect(workspace.getAttribute('aria-busy')).toBe('false'));
        expect(onProgress).not.toHaveBeenCalled();

        workspace.scrollTop = 900;
        fireEvent.scroll(workspace);
        await waitFor(
            () =>
                expect(onProgress).toHaveBeenCalledWith({
                    pageNumber: 3,
                    scale: 1.5,
                    scrollRatio: 0.6,
                }),
            { timeout: 1_000 }
        );
    });

    it('内容揭示导致滚动高度变化后，仍按最终布局恢复保存比例', async () => {
        const onProgress = vi.fn();
        render(
            <PdfWorkspace
                source=''
                document={{ paper: { id: 'paper-layout' }, pageCount: 6 }}
                currentPage={3}
                scale={1.5}
                initialProgress={{ pageNumber: 3, scale: 1.5, scrollRatio: 0.42 }}
                onProgress={onProgress}
            />
        );
        const workspace = screen.getByRole('main', { name: 'PDF 阅读区' });
        Object.defineProperties(workspace, {
            scrollHeight: {
                configurable: true,
                get: () => (workspace.classList.contains('is-restoring-progress') ? 1_000 : 2_000),
            },
            clientHeight: { configurable: true, value: 500 },
            scrollTop: { configurable: true, writable: true, value: 0 },
        });

        await waitFor(() => expect(workspace.getAttribute('aria-busy')).toBe('false'));

        expect(workspace.classList.contains('is-restoring-progress')).toBe(false);
        expect(workspace.scrollTop).toBe(630);
        expect(onProgress).not.toHaveBeenCalled();
    });

    it('关闭论文时即使 DOM ref 已清空，也使用最后滚动快照而不是覆盖为页首', async () => {
        const onProgress = vi.fn();
        const view = render(
            <PdfWorkspace
                source=''
                document={{ paper: { id: 'paper-close' }, pageCount: 6 }}
                currentPage={4}
                scale={1.3}
                initialProgress={{ pageNumber: 4, scale: 1.3, scrollRatio: 0.25 }}
                onProgress={onProgress}
            />
        );
        const workspace = screen.getByRole('main', { name: 'PDF 阅读区' });
        Object.defineProperties(workspace, {
            scrollHeight: { configurable: true, value: 2_000 },
            clientHeight: { configurable: true, value: 500 },
            scrollTop: { configurable: true, writable: true, value: 0 },
        });

        await waitFor(() => expect(workspace.getAttribute('aria-busy')).toBe('false'));
        workspace.scrollTop = 900;
        fireEvent.scroll(workspace);
        view.unmount();

        expect(onProgress).toHaveBeenCalledTimes(1);
        expect(onProgress).toHaveBeenCalledWith({ pageNumber: 4, scale: 1.3, scrollRatio: 0.6 });
    });
});
