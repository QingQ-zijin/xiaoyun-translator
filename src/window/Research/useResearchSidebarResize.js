import { useCallback, useEffect, useRef, useState } from 'react';

export const DEFAULT_RESEARCH_SIDEBAR_WIDTH = 274;
export const MIN_RESEARCH_SIDEBAR_WIDTH = 220;
export const MAX_RESEARCH_SIDEBAR_WIDTH = 440;

const STORAGE_KEY = 'xiaoyun.research.sidebar-width';
const COLLAPSED_STORAGE_KEY = 'xiaoyun.research.sidebar-collapsed:v1';
const RAIL_WIDTH = 92;
const MIN_READER_WIDTH = 430;

export function clampResearchSidebarWidth(value, viewportWidth = globalThis.innerWidth) {
    const viewportMaximum = Math.max(
        MIN_RESEARCH_SIDEBAR_WIDTH,
        (Number(viewportWidth) || 1280) - RAIL_WIDTH - MIN_READER_WIDTH
    );
    const maximum = Math.min(MAX_RESEARCH_SIDEBAR_WIDTH, viewportMaximum);
    return Math.round(
        Math.min(maximum, Math.max(MIN_RESEARCH_SIDEBAR_WIDTH, Number(value) || DEFAULT_RESEARCH_SIDEBAR_WIDTH))
    );
}

export function sidebarWidthFromKey(key, current, { shiftKey = false, viewportWidth = globalThis.innerWidth } = {}) {
    const step = shiftKey ? 32 : 12;
    if (key === 'ArrowLeft') return clampResearchSidebarWidth(current - step, viewportWidth);
    if (key === 'ArrowRight') return clampResearchSidebarWidth(current + step, viewportWidth);
    if (key === 'Home') return clampResearchSidebarWidth(MIN_RESEARCH_SIDEBAR_WIDTH, viewportWidth);
    if (key === 'End') return clampResearchSidebarWidth(MAX_RESEARCH_SIDEBAR_WIDTH, viewportWidth);
    return null;
}

function initialWidth() {
    try {
        return clampResearchSidebarWidth(globalThis.localStorage?.getItem(STORAGE_KEY));
    } catch {
        return DEFAULT_RESEARCH_SIDEBAR_WIDTH;
    }
}

function initialCollapsed() {
    try {
        return globalThis.localStorage?.getItem(COLLAPSED_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

export function useResearchSidebarResize() {
    const [width, setWidth] = useState(initialWidth);
    const [collapsed, setCollapsed] = useState(initialCollapsed);
    const cleanupDragRef = useRef(() => {});

    useEffect(() => {
        try {
            globalThis.localStorage?.setItem(STORAGE_KEY, String(width));
        } catch {
            // 浏览器禁用本地存储时仍允许本次会话调整宽度。
        }
    }, [width]);

    useEffect(() => {
        try {
            globalThis.localStorage?.setItem(COLLAPSED_STORAGE_KEY, String(collapsed));
        } catch {
            // 浏览器禁用本地存储时，折叠状态仅在本次会话内生效。
        }
    }, [collapsed]);

    useEffect(() => {
        const handleResize = () => setWidth((current) => clampResearchSidebarWidth(current));
        globalThis.addEventListener?.('resize', handleResize);
        return () => globalThis.removeEventListener?.('resize', handleResize);
    }, []);

    useEffect(() => () => cleanupDragRef.current(), []);

    const onPointerDown = useCallback(
        (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            cleanupDragRef.current();
            const startX = event.clientX;
            const startWidth = width;
            const pointerId = event.pointerId;
            const separator = event.currentTarget;
            let cleaned = false;
            const handleMove = (moveEvent) => {
                if (pointerId != null && moveEvent.pointerId != null && moveEvent.pointerId !== pointerId) return;
                setWidth(clampResearchSidebarWidth(startWidth + moveEvent.clientX - startX));
            };
            const cleanup = () => {
                if (cleaned) return;
                cleaned = true;
                cleanupDragRef.current = () => {};
                globalThis.removeEventListener?.('pointermove', handleMove);
                globalThis.removeEventListener?.('pointerup', handleEnd);
                globalThis.removeEventListener?.('pointercancel', handleEnd);
                globalThis.removeEventListener?.('blur', cleanup);
                separator?.removeEventListener?.('lostpointercapture', cleanup);
                globalThis.document?.documentElement?.classList.remove('is-resizing-research-sidebar');
                try {
                    if (pointerId != null && separator?.hasPointerCapture?.(pointerId)) {
                        separator.releasePointerCapture(pointerId);
                    }
                } catch {
                    // WebView 在窗口失焦时可能已隐式释放捕获；清理仍应继续。
                }
            };
            const handleEnd = (endEvent) => {
                if (pointerId != null && endEvent.pointerId != null && endEvent.pointerId !== pointerId) return;
                cleanup();
            };
            cleanupDragRef.current = cleanup;
            try {
                if (pointerId != null) separator?.setPointerCapture?.(pointerId);
            } catch {
                // 不支持指针捕获的 WebView 仍使用窗口级监听完成拖动。
            }
            globalThis.document?.documentElement?.classList.add('is-resizing-research-sidebar');
            globalThis.addEventListener?.('pointermove', handleMove);
            globalThis.addEventListener?.('pointerup', handleEnd);
            globalThis.addEventListener?.('pointercancel', handleEnd);
            globalThis.addEventListener?.('blur', cleanup, { once: true });
            separator?.addEventListener?.('lostpointercapture', cleanup, { once: true });
        },
        [width]
    );

    const onKeyDown = useCallback((event) => {
        setWidth((current) => {
            const next = sidebarWidthFromKey(event.key, current, { shiftKey: event.shiftKey });
            if (next == null) return current;
            event.preventDefault();
            return next;
        });
    }, []);

    const reset = useCallback(() => setWidth(clampResearchSidebarWidth(DEFAULT_RESEARCH_SIDEBAR_WIDTH)), []);
    const toggleCollapsed = useCallback(() => setCollapsed((current) => !current), []);

    return {
        width,
        collapsed,
        toggleCollapsed,
        rootStyle: { '--app-context-sidebar-width': `${width}px` },
        separatorProps: {
            role: 'separator',
            tabIndex: 0,
            'aria-label': '调整论文侧栏宽度',
            'aria-orientation': 'vertical',
            'aria-valuemin': MIN_RESEARCH_SIDEBAR_WIDTH,
            'aria-valuemax': clampResearchSidebarWidth(MAX_RESEARCH_SIDEBAR_WIDTH),
            'aria-valuenow': width,
            onPointerDown,
            onKeyDown,
            onDoubleClick: reset,
        },
    };
}
