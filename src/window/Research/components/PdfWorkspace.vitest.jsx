import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import PdfWorkspace from './PdfWorkspace';

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.getSelection()?.removeAllRanges();
});

function setupNativeSelectionHarness(paperId) {
    const onSelection = vi.fn();
    render(
        <PdfWorkspace
            source=''
            document={{
                paper: { id: paperId },
                documentType: 'markdown',
                textContent: 'Alpha beta gamma',
                pageCount: 1,
            }}
            currentPage={1}
            scale={1.25}
            onSelection={onSelection}
        />
    );
    const workspace = screen.getByRole('main', { name: '文献阅读区' });
    const page = document.querySelector('.text-document-page');
    const paragraph = screen.getByText('Alpha beta gamma');
    const rect = { left: 20, top: 80, right: 180, bottom: 98, width: 160, height: 18 };
    page.getBoundingClientRect = () => ({ left: 0, top: 0, right: 720, bottom: 900, width: 720, height: 900 });
    workspace.getBoundingClientRect = () => ({ left: 0, top: 0, right: 900, bottom: 700, width: 900, height: 700 });
    const range = document.createRange();
    range.setStart(paragraph.firstChild, 0);
    range.setEnd(paragraph.firstChild, 10);
    range.getClientRects = () => [rect];
    range.getBoundingClientRect = () => rect;
    const browserSelection = window.getSelection();
    browserSelection.removeAllRanges();
    const frames = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    return { onSelection, workspace, paragraph, range, browserSelection, frames };
}

describe('PDF 文内笔记标记', () => {
    it.each([
        ['excerpt', '摘录'],
        ['vocabulary', '摘词'],
    ])('%s 只保留正文高亮，不渲染遮挡文字的书签按钮', (kind, tag) => {
        const annotation = {
            id: `${kind}-1`,
            paperId: 'demo-memory',
            pageNumber: 2,
            kind,
            color: kind === 'excerpt' ? 'amber' : 'blue',
            quote: 'selected sentence',
            tags: [tag],
            rects: [{ x: 0.2, y: 0.3, width: 0.24, height: 0.03 }],
        };
        const { container } = render(
            <PdfWorkspace
                source=''
                document={{ paper: { id: 'demo-memory' }, pageCount: 2 }}
                currentPage={2}
                scale={1.25}
                annotations={[annotation]}
            />
        );

        const mark = container.querySelector('.pdf-annotation-mark');
        expect(mark).not.toBeNull();
        expect(mark.classList.contains('has-tags')).toBe(false);
        expect(mark.getAttribute('data-tag-count')).toBeNull();
        expect(container.querySelector(`[data-annotation-id="${annotation.id}"]`)).toBeNull();
        expect(screen.queryByRole('button', { name: /打开批注操作/u })).toBeNull();
    });

    it('在首个批注矩形旁显示可点击的批注标签，并把删除操作收进标签菜单', () => {
        const annotation = {
            id: 'note-1',
            paperId: 'demo-memory',
            pageNumber: 2,
            kind: 'note',
            color: 'green',
            quote: 'selected sentence',
            note: '这是一条关键笔记',
            tags: ['方法学'],
            rects: [{ x: 0.2, y: 0.3, width: 0.24, height: 0.03 }],
        };
        const onAnnotationActivate = vi.fn();
        render(
            <PdfWorkspace
                source=''
                document={{ paper: { id: 'demo-memory' }, pageCount: 2 }}
                currentPage={2}
                scale={1.25}
                annotations={[annotation]}
                onAnnotationActivate={onAnnotationActivate}
            />
        );

        const marker = screen.getByRole('button', { name: '查看第 2 页笔记，标签 方法学' });
        expect(marker.querySelector('svg')).not.toBeNull();
        expect(marker.getAttribute('data-tooltip')).toContain('这是一条关键笔记');
        expect(screen.queryByRole('menuitem', { name: /删除笔记/u })).toBeNull();
        fireEvent.click(marker);
        expect(onAnnotationActivate).toHaveBeenCalledWith(annotation);
        expect(screen.getByRole('menuitem', { name: '删除笔记：selected sentence' })).toBeTruthy();
    });

    it('纯高亮初始不显示垃圾桶，点开批注标签后才可取消', () => {
        const onAnnotationDelete = vi.fn();
        const annotation = {
            id: 'highlight-1',
            pageNumber: 2,
            kind: 'highlight',
            color: 'rose',
            quote: 'selected sentence',
            rects: [{ x: 0.2, y: 0.3, width: 0.24, height: 0.03 }],
        };
        render(
            <PdfWorkspace
                source=''
                document={{ paper: { id: 'demo-memory' }, pageCount: 2 }}
                currentPage={2}
                scale={1.25}
                annotations={[annotation]}
                onAnnotationDelete={onAnnotationDelete}
            />
        );

        expect(screen.queryByRole('menuitem', { name: /取消高亮/u })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: '打开批注操作：selected sentence' }));
        fireEvent.click(screen.getByRole('menuitem', { name: '取消高亮：selected sentence' }));
        expect(onAnnotationDelete).toHaveBeenCalledWith(annotation);
    });

    it('点到批注菜单外会收起删除操作', () => {
        const annotation = {
            id: 'highlight-outside',
            pageNumber: 2,
            kind: 'highlight',
            quote: 'outside close',
            rects: [{ x: 0.2, y: 0.3, width: 0.24, height: 0.03 }],
        };
        render(
            <PdfWorkspace
                source=''
                document={{ paper: { id: 'demo-memory' }, pageCount: 2 }}
                currentPage={2}
                scale={1.25}
                annotations={[annotation]}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: '打开批注操作：outside close' }));
        expect(screen.getByRole('menu', { name: '批注操作' })).toBeTruthy();
        fireEvent.pointerDown(document.body);
        expect(screen.queryByRole('menu', { name: '批注操作' })).toBeNull();
    });

    it('摘录定位使用页内矩形坐标，而不是只跳到页首', () => {
        const workspaceRef = { current: null };
        const onPageChange = vi.fn();
        const { container } = render(
            <PdfWorkspace
                ref={workspaceRef}
                source=''
                document={{
                    paper: { id: 'annotation-position' },
                    documentType: 'markdown',
                    textContent: '定位测试正文',
                    pageCount: 1,
                }}
                currentPage={1}
                scale={1.25}
                onPageChange={onPageChange}
            />
        );
        const workspace = screen.getByRole('main', { name: '文献阅读区' });
        const page = container.querySelector('.text-document-page');
        workspace.scrollTop = 200;
        Object.defineProperties(workspace, {
            clientHeight: { configurable: true, value: 600 },
            scrollHeight: { configurable: true, value: 2000 },
        });
        workspace.getBoundingClientRect = () => ({ left: 0, top: 0, right: 900, bottom: 600, width: 900, height: 600 });
        page.getBoundingClientRect = () => ({ left: 0, top: 300, right: 650, bottom: 1100, width: 650, height: 800 });
        workspace.scrollTo = vi.fn(({ top }) => {
            workspace.scrollTop = top;
        });
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
            callback(0);
            return 1;
        });

        workspaceRef.current.goToAnnotation({ pageNumber: 1, rects: [{ y: 0.5 }] });

        expect(onPageChange).toHaveBeenCalledWith(1);
        expect(workspace.scrollTo).toHaveBeenCalledWith({ top: 780, behavior: 'smooth' });
    });

    it('直接阅读 Markdown 文档并复用划词与批注页坐标', async () => {
        const onPageCountChange = vi.fn();
        const onPageText = vi.fn();
        const onDocumentPages = vi.fn();
        render(
            <PdfWorkspace
                source=''
                document={{
                    paper: { id: 'markdown-paper' },
                    documentType: 'markdown',
                    textContent: '# 方法\n\n代谢通量满足 $v_{in}=v_{out}$。',
                    pageCount: 1,
                }}
                currentPage={1}
                scale={1.25}
                onPageCountChange={onPageCountChange}
                onPageText={onPageText}
                onDocumentPages={onDocumentPages}
            />
        );

        expect(screen.getByRole('main', { name: '文献阅读区' })).toBeTruthy();
        expect(screen.getByRole('heading', { name: '方法' })).toBeTruthy();
        await waitFor(() => expect(onPageCountChange).toHaveBeenCalledWith(1));
        expect(onPageText).toHaveBeenCalledWith(1, expect.stringContaining('代谢通量'));
        expect(onDocumentPages).toHaveBeenCalledWith({
            pages: [{ pageNumber: 1, text: expect.stringContaining('代谢通量') }],
            pageCount: 1,
            textPageCount: 1,
            totalCharacters: '# 方法\n\n代谢通量满足 $v_{in}=v_{out}$。'.length,
            outline: [
                {
                    title: '方法',
                    pageNumber: 1,
                    endPage: 1,
                    level: 1,
                    source: 'text',
                    confidence: 0.72,
                },
            ],
        });
    });

    it('没有 PDF.js span 的 Markdown 文本仍可通过原生 Range 划词', () => {
        const onSelection = vi.fn();
        const { container } = render(
            <PdfWorkspace
                source=''
                document={{
                    paper: { id: 'markdown-selection' },
                    documentType: 'markdown',
                    textContent: 'Alpha beta gamma',
                    pageCount: 1,
                }}
                currentPage={1}
                scale={1.25}
                onSelection={onSelection}
            />
        );
        const workspace = screen.getByRole('main', { name: '文献阅读区' });
        const page = container.querySelector('.text-document-page');
        const paragraph = screen.getByText('Alpha beta gamma');
        const rect = { left: 20, top: 80, right: 180, bottom: 98, width: 160, height: 18 };
        page.getBoundingClientRect = () => ({ left: 0, top: 0, right: 720, bottom: 900, width: 720, height: 900 });
        workspace.getBoundingClientRect = () => ({ left: 0, top: 0, right: 900, bottom: 700, width: 900, height: 700 });
        const range = document.createRange();
        range.setStart(paragraph.firstChild, 0);
        range.setEnd(paragraph.firstChild, 10);
        range.getClientRects = () => [rect];
        range.getBoundingClientRect = () => rect;
        const browserSelection = window.getSelection();
        browserSelection.removeAllRanges();
        browserSelection.addRange(range);
        const frames = [];
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
            frames.push(callback);
            return frames.length;
        });
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

        fireEvent.pointerDown(paragraph, { button: 0, pointerId: 31, clientX: 24, clientY: 88 });
        // PointerDown 会清理旧手势但保留浏览器正在构建的原生 Selection。
        browserSelection.removeAllRanges();
        browserSelection.addRange(range);
        fireEvent.pointerUp(workspace, { button: 0, pointerId: 31, clientX: 120, clientY: 88 });
        frames.shift()(0);

        expect(onSelection).toHaveBeenCalledOnce();
        expect(onSelection.mock.calls[0][0]).toMatchObject({
            paperId: 'markdown-selection',
            pageNumber: 1,
            quote: 'Alpha beta',
        });
    });

    it('拖出阅读区后松手仍由全局 PointerUp 收尾，后续 MouseUp 不会重复提交', () => {
        const { onSelection, paragraph, range, browserSelection, frames } =
            setupNativeSelectionHarness('outside-release');
        fireEvent.pointerDown(paragraph, { button: 0, pointerId: 41, clientX: 24, clientY: 88 });
        browserSelection.addRange(range);

        fireEvent.pointerUp(document.body, { button: 0, pointerId: 41, clientX: 920, clientY: 720 });
        fireEvent.mouseUp(document.body, { button: 0, clientX: 920, clientY: 720 });

        expect(frames).toHaveLength(1);
        frames.shift()(0);
        expect(onSelection).toHaveBeenCalledOnce();
        expect(onSelection.mock.calls[0][0].quote).toBe('Alpha beta');
    });

    it('不匹配的 PointerUp 与 PointerCancel 不会清除主手势，随后正确松手只提交一次', () => {
        const { onSelection, paragraph, range, browserSelection, frames } =
            setupNativeSelectionHarness('multi-pointer');
        fireEvent.pointerDown(paragraph, { button: 0, pointerId: 51, clientX: 24, clientY: 88 });
        browserSelection.addRange(range);

        fireEvent.pointerUp(document.body, { button: 0, pointerId: 99, clientX: 80, clientY: 88 });
        fireEvent.pointerCancel(window, { pointerId: 99 });
        expect(frames).toHaveLength(0);

        fireEvent.pointerUp(document.body, { button: 0, pointerId: 51, clientX: 120, clientY: 88 });
        fireEvent.mouseUp(document.body, { button: 0, clientX: 120, clientY: 88 });
        expect(frames).toHaveLength(1);
        frames.shift()(0);
        expect(onSelection).toHaveBeenCalledOnce();
    });

    it('触摸板捏合与 Ctrl/Command+滚轮连续缩放，普通双指滚动不被阅读器拦截', async () => {
        const onScaleChange = vi.fn();
        const { container } = render(
            <PdfWorkspace
                source=''
                document={{ paper: { id: 'trackpad-zoom' }, pageCount: 2 }}
                currentPage={2}
                scale={1.25}
                onScaleChange={onScaleChange}
            />
        );
        const workspace = screen.getByRole('main', { name: 'PDF 阅读区' });
        const page = container.querySelector('.demo-pdf-page');
        page.getBoundingClientRect = () => ({
            left: 100,
            top: 80,
            right: 750,
            bottom: 872,
            width: 650,
            height: 792,
        });
        workspace.getBoundingClientRect = () => ({
            left: 0,
            top: 0,
            right: 900,
            bottom: 700,
            width: 900,
            height: 700,
        });
        const previousElementFromPoint = document.elementFromPoint;
        document.elementFromPoint = vi.fn(() => page);
        try {
            const regularScroll = new WheelEvent('wheel', {
                bubbles: true,
                cancelable: true,
                deltaY: 48,
                clientX: 320,
                clientY: 260,
            });
            expect(workspace.dispatchEvent(regularScroll)).toBe(true);
            expect(onScaleChange).not.toHaveBeenCalled();

            const trackpadPinch = new WheelEvent('wheel', {
                bubbles: true,
                cancelable: true,
                ctrlKey: true,
                deltaY: -80,
                clientX: 320,
                clientY: 260,
            });
            expect(workspace.dispatchEvent(trackpadPinch)).toBe(false);
            await waitFor(() => expect(onScaleChange).toHaveBeenCalled());
            const zoomedInScale = onScaleChange.mock.calls.at(-1)[0];
            expect(zoomedInScale).toBeGreaterThan(1.25);

            const macCommandWheel = new WheelEvent('wheel', {
                bubbles: true,
                cancelable: true,
                metaKey: true,
                deltaY: 80,
                clientX: 320,
                clientY: 260,
            });
            const callsBeforeCommandWheel = onScaleChange.mock.calls.length;
            expect(workspace.dispatchEvent(macCommandWheel)).toBe(false);
            await waitFor(() => expect(onScaleChange.mock.calls.length).toBeGreaterThan(callsBeforeCommandWheel));
            expect(onScaleChange.mock.calls.at(-1)[0]).toBeLessThan(zoomedInScale);
        } finally {
            document.elementFromPoint = previousElementFromPoint;
        }
    });

    it('触摸指针在同向移动时保持滚动，间距明确变化后才启动锚点缩放', async () => {
        const onScaleChange = vi.fn();
        const { container } = render(
            <PdfWorkspace
                source=''
                document={{ paper: { id: 'pointer-pinch' }, pageCount: 2 }}
                currentPage={2}
                scale={1.25}
                onScaleChange={onScaleChange}
            />
        );
        const workspace = screen.getByRole('main', { name: 'PDF 阅读区' });
        const page = container.querySelector('.demo-pdf-page');
        page.getBoundingClientRect = () => ({
            left: 100,
            top: 80,
            right: 750,
            bottom: 872,
            width: 650,
            height: 792,
        });
        const previousElementFromPoint = document.elementFromPoint;
        document.elementFromPoint = vi.fn(() => page);
        try {
            fireEvent.pointerDown(workspace, {
                pointerType: 'touch',
                pointerId: 71,
                button: 0,
                clientX: 200,
                clientY: 240,
            });
            fireEvent.pointerDown(workspace, {
                pointerType: 'touch',
                pointerId: 72,
                button: 0,
                clientX: 300,
                clientY: 240,
            });
            fireEvent.pointerMove(workspace, {
                pointerType: 'touch',
                pointerId: 71,
                clientX: 210,
                clientY: 260,
            });
            fireEvent.pointerMove(workspace, {
                pointerType: 'touch',
                pointerId: 72,
                clientX: 310,
                clientY: 260,
            });
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(onScaleChange).not.toHaveBeenCalled();

            fireEvent.pointerMove(workspace, {
                pointerType: 'touch',
                pointerId: 71,
                clientX: 180,
                clientY: 260,
            });
            await waitFor(() => expect(onScaleChange).toHaveBeenCalled());
            expect(onScaleChange.mock.calls.at(-1)[0]).toBeGreaterThan(1.25);

            fireEvent.pointerUp(workspace, {
                pointerType: 'touch',
                pointerId: 71,
                button: 0,
                clientX: 180,
                clientY: 260,
            });
            fireEvent.pointerUp(workspace, {
                pointerType: 'touch',
                pointerId: 72,
                button: 0,
                clientX: 310,
                clientY: 260,
            });
        } finally {
            document.elementFromPoint = previousElementFromPoint;
        }
    });

    it('gesture 捏合事件阻止 WebView 页面缩放，并围绕指针更新 PDF 比例', async () => {
        const onScaleChange = vi.fn();
        const { container } = render(
            <PdfWorkspace
                source=''
                document={{ paper: { id: 'demo-memory' }, pageCount: 2 }}
                currentPage={2}
                scale={1.25}
                onScaleChange={onScaleChange}
            />
        );
        const workspace = screen.getByRole('main', { name: 'PDF 阅读区' });
        const page = container.querySelector('.demo-pdf-page');
        const previousElementFromPoint = document.elementFromPoint;
        document.elementFromPoint = vi.fn(() => page);
        try {
            const start = new Event('gesturestart', { bubbles: true, cancelable: true });
            Object.defineProperties(start, {
                clientX: { value: 320 },
                clientY: { value: 260 },
                scale: { value: 1 },
            });
            expect(workspace.dispatchEvent(start)).toBe(false);

            const change = new Event('gesturechange', { bubbles: true, cancelable: true });
            Object.defineProperties(change, {
                clientX: { value: 320 },
                clientY: { value: 260 },
                scale: { value: 1.2 },
            });
            expect(workspace.dispatchEvent(change)).toBe(false);
            await waitFor(() => expect(onScaleChange).toHaveBeenCalledWith(1.5));
        } finally {
            document.elementFromPoint = previousElementFromPoint;
        }
    });

    it('WebView2 延迟提交 Selection 时在后续帧复核并正常弹出划词结果', () => {
        const onSelection = vi.fn();
        const { container } = render(
            <PdfWorkspace
                source=''
                document={{ paper: { id: 'selection-paper' }, pageCount: 2 }}
                currentPage={2}
                scale={1.25}
                onSelection={onSelection}
            />
        );
        const workspace = screen.getByRole('main', { name: 'PDF 阅读区' });
        const page = container.querySelector('.demo-pdf-page');
        const layer = container.querySelector('[data-pdf-selection-layer]');
        const target = layer.querySelector('p span');
        const rect = { left: 10, top: 100, right: 210, bottom: 114, width: 200, height: 14, x: 10, y: 100 };
        target.getBoundingClientRect = () => rect;
        page.getBoundingClientRect = () => ({
            ...rect,
            left: 0,
            top: 0,
            right: 650,
            bottom: 792,
            width: 650,
            height: 792,
        });
        workspace.getBoundingClientRect = () => ({ left: 0, top: 0, right: 900, bottom: 700, width: 900, height: 700 });

        const range = document.createRange();
        range.setStart(target.firstChild, 0);
        range.setEnd(target.firstChild, Math.min(8, target.firstChild.length));
        range.getClientRects = () => [rect];
        range.getBoundingClientRect = () => rect;
        const browserSelection = window.getSelection();
        browserSelection.removeAllRanges();

        const frames = [];
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
            frames.push(callback);
            return frames.length;
        });
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

        fireEvent.pointerDown(target, { button: 0, pointerId: 12, clientX: 18, clientY: 105 });
        // 纵向偏移模拟多行拖选；第一帧 Selection 仍折叠，旧实现会在这里永久丢失本次选择。
        fireEvent.pointerUp(workspace, { button: 0, pointerId: 12, clientX: 120, clientY: 128 });
        expect(frames).toHaveLength(1);
        frames.shift()(0);
        expect(onSelection).not.toHaveBeenCalled();
        expect(frames).toHaveLength(1);

        browserSelection.addRange(range);
        frames.shift()(16);

        expect(onSelection).toHaveBeenCalledOnce();
        expect(onSelection.mock.calls[0][0]).toMatchObject({
            paperId: 'selection-paper',
            pageNumber: 2,
            quote: range.toString(),
        });
    });

    it('捏合缩放会使尚未提交的选区复核失效，避免缩放后误弹翻译窗', () => {
        const onSelection = vi.fn();
        const { container } = render(
            <PdfWorkspace
                source=''
                document={{ paper: { id: 'zoom-selection-paper' }, pageCount: 2 }}
                currentPage={2}
                scale={1.25}
                onSelection={onSelection}
            />
        );
        const workspace = screen.getByRole('main', { name: 'PDF 阅读区' });
        const target = container.querySelector('[data-pdf-selection-layer] p span');
        target.getBoundingClientRect = () => ({
            left: 10,
            top: 100,
            right: 210,
            bottom: 114,
            width: 200,
            height: 14,
        });
        const frames = [];
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
            frames.push(callback);
            return frames.length;
        });
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

        fireEvent.pointerDown(target, { button: 0, pointerId: 21, clientX: 18, clientY: 105 });
        fireEvent.pointerUp(workspace, { button: 0, pointerId: 21, clientX: 120, clientY: 128 });
        const pendingSelectionCommit = frames.shift();
        const gesture = new Event('gesturestart', { bubbles: true, cancelable: true });
        Object.defineProperties(gesture, {
            clientX: { value: 320 },
            clientY: { value: 260 },
            scale: { value: 1 },
        });
        workspace.dispatchEvent(gesture);
        pendingSelectionCommit(0);

        expect(onSelection).not.toHaveBeenCalled();
    });
});
