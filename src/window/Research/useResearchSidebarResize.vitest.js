import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_RESEARCH_SIDEBAR_WIDTH,
    MAX_RESEARCH_SIDEBAR_WIDTH,
    MIN_RESEARCH_SIDEBAR_WIDTH,
    clampResearchSidebarWidth,
    sidebarWidthFromKey,
    useResearchSidebarResize,
} from './useResearchSidebarResize';

afterEach(() => {
    cleanup();
    localStorage.clear();
    document.documentElement.classList.remove('is-resizing-research-sidebar');
});

function dispatchPointerEvent(type, values) {
    const event = new Event(type);
    Object.entries(values).forEach(([key, value]) => Object.defineProperty(event, key, { value }));
    window.dispatchEvent(event);
}

describe('论文侧栏拖动宽度', () => {
    it('限制在可阅读范围内，并为正文保留至少 430px', () => {
        expect(clampResearchSidebarWidth(10, 1280)).toBe(MIN_RESEARCH_SIDEBAR_WIDTH);
        expect(clampResearchSidebarWidth(999, 1280)).toBe(MAX_RESEARCH_SIDEBAR_WIDTH);
        expect(clampResearchSidebarWidth(999, 760)).toBe(238);
        expect(clampResearchSidebarWidth(null, 1280)).toBe(DEFAULT_RESEARCH_SIDEBAR_WIDTH);
    });

    it('支持键盘微调、快速调整和恢复边界', () => {
        expect(sidebarWidthFromKey('ArrowRight', 274, { viewportWidth: 1280 })).toBe(286);
        expect(sidebarWidthFromKey('ArrowLeft', 274, { shiftKey: true, viewportWidth: 1280 })).toBe(242);
        expect(sidebarWidthFromKey('Home', 300, { viewportWidth: 1280 })).toBe(MIN_RESEARCH_SIDEBAR_WIDTH);
        expect(sidebarWidthFromKey('End', 300, { viewportWidth: 1280 })).toBe(MAX_RESEARCH_SIDEBAR_WIDTH);
        expect(sidebarWidthFromKey('Enter', 300, { viewportWidth: 1280 })).toBeNull();
    });

    it('捕获拖动指针，并在窗口失焦时可靠释放监听与样式', () => {
        const separator = document.createElement('div');
        let captured = false;
        separator.setPointerCapture = vi.fn(() => {
            captured = true;
        });
        separator.hasPointerCapture = vi.fn(() => captured);
        separator.releasePointerCapture = vi.fn(() => {
            captured = false;
        });
        const { result } = renderHook(() => useResearchSidebarResize());

        act(() => {
            result.current.separatorProps.onPointerDown({
                button: 0,
                clientX: 300,
                pointerId: 7,
                currentTarget: separator,
                preventDefault: vi.fn(),
            });
        });

        expect(separator.setPointerCapture).toHaveBeenCalledWith(7);
        expect(document.documentElement.classList.contains('is-resizing-research-sidebar')).toBe(true);

        act(() => dispatchPointerEvent('pointermove', { clientX: 340, pointerId: 7 }));
        expect(result.current.width).toBe(DEFAULT_RESEARCH_SIDEBAR_WIDTH + 40);

        act(() => window.dispatchEvent(new Event('blur')));
        expect(separator.releasePointerCapture).toHaveBeenCalledWith(7);
        expect(document.documentElement.classList.contains('is-resizing-research-sidebar')).toBe(false);

        act(() => dispatchPointerEvent('pointermove', { clientX: 380, pointerId: 7 }));
        expect(result.current.width).toBe(DEFAULT_RESEARCH_SIDEBAR_WIDTH + 40);
    });

    it('折叠后保留原宽度，重新挂载仍记住折叠状态', () => {
        const first = renderHook(() => useResearchSidebarResize());
        expect(first.result.current.collapsed).toBe(false);

        act(() => first.result.current.toggleCollapsed());
        expect(first.result.current.collapsed).toBe(true);
        expect(first.result.current.width).toBe(DEFAULT_RESEARCH_SIDEBAR_WIDTH);
        first.unmount();

        const restored = renderHook(() => useResearchSidebarResize());
        expect(restored.result.current.collapsed).toBe(true);
        act(() => restored.result.current.toggleCollapsed());
        expect(restored.result.current.collapsed).toBe(false);
        expect(restored.result.current.width).toBe(DEFAULT_RESEARCH_SIDEBAR_WIDTH);
    });
});
