import { describe, expect, it } from 'vitest';

import {
    capturePdfVisualLine,
    isNearHorizontalPdfGesture,
    rebuildPdfSingleLineRange,
    resolvePdfHorizontalRange,
} from './pdfSelection';

function setRect(element, { left, top, width, height }) {
    const rect = { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top };
    element.getBoundingClientRect = () => rect;
}

function installRangeRects() {
    const originalCreateRange = document.createRange.bind(document);
    document.createRange = () => {
        const range = originalCreateRange();
        range.getClientRects = () => {
            if (range.collapsed) return [];
            const common = range.commonAncestorContainer;
            const elements =
                common.nodeType === Node.TEXT_NODE
                    ? [common.parentElement]
                    : [...common.querySelectorAll('span')].filter((element) => {
                          try {
                              return range.intersectsNode(element);
                          } catch {
                              return false;
                          }
                      });
            return elements.map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 0);
        };
        range.getBoundingClientRect = () => range.getClientRects()[0] ?? new DOMRect();
        return range;
    };
    return () => {
        document.createRange = originalCreateRange;
    };
}

function createLayer(order = ['first', 'last', 'later']) {
    const layer = document.createElement('div');
    layer.dataset.pdfSelectionLayer = 'true';
    const definitions = {
        first: { text: 'alpha beta', rect: { left: 10, top: 100, width: 80, height: 12 } },
        last: { text: ' gamma', rect: { left: 92, top: 100, width: 62, height: 12 } },
        later: {
            text: ` ${'unexpected later paragraph '.repeat(180)}`,
            rect: { left: 10, top: 118, width: 300, height: 12 },
        },
    };
    const elements = {};
    order.forEach((name) => {
        const span = document.createElement('span');
        span.textContent = definitions[name].text;
        setRect(span, definitions[name].rect);
        layer.append(span);
        elements[name] = span;
    });
    document.body.append(layer);
    return { layer, elements };
}

describe('PDF.js 视觉行选区重建', () => {
    it('按起点命中的文本 span 收集同一视觉行，并排除下一行', () => {
        const { layer, elements } = createLayer();
        const visualLine = capturePdfVisualLine(layer, elements.first, 12, 105);

        expect(visualLine.fragments.map((fragment) => fragment.element)).toEqual([elements.first, elements.last]);
        expect(visualLine.lineRect).toMatchObject({ left: 10, right: 154, top: 100, bottom: 112 });
    });

    it('同一视觉行的 DOM 顺序连续时重建跨 span Range', () => {
        const restoreRange = installRangeRects();
        try {
            const { layer, elements } = createLayer();
            const visualLine = capturePdfVisualLine(layer, elements.first, 12, 105);
            const range = rebuildPdfSingleLineRange(visualLine, 150);

            expect(range).not.toBeNull();
            expect(range.startContainer).toBe(elements.first.firstChild);
            expect(range.endContainer).toBe(elements.last.firstChild);
            expect(range.toString()).not.toContain('unexpected later paragraph');
        } finally {
            restoreRange();
        }
    });

    it('DOM 顺序夹入后续行导致候选 Range 扩张时，仅回退到起点文本节点', () => {
        const restoreRange = installRangeRects();
        try {
            const { layer, elements } = createLayer(['first', 'later', 'last']);
            const visualLine = capturePdfVisualLine(layer, elements.first, 12, 105);
            const range = rebuildPdfSingleLineRange(visualLine, 150);

            expect(range).not.toBeNull();
            expect(range.startContainer).toBe(elements.first.firstChild);
            expect(range.endContainer).toBe(elements.first.firstChild);
            expect(range.toString()).not.toContain('unexpected later paragraph');
            expect(range.toString().length).toBeLessThanOrEqual(elements.first.textContent.length);
        } finally {
            restoreRange();
        }
    });

    it('视觉行重建暂时失败时保留已经有效的同一行原生 Range', () => {
        const restoreRange = installRangeRects();
        try {
            const { layer, elements } = createLayer();
            const visualLine = capturePdfVisualLine(layer, elements.first, 12, 105);
            const nativeRange = document.createRange();
            nativeRange.setStart(elements.first.firstChild, 1);
            nativeRange.setEnd(elements.last.firstChild, 4);

            const resolved = resolvePdfHorizontalRange(visualLine, 150, nativeRange, () => null);

            expect(resolved).toBe(nativeRange);
            expect(resolved.toString()).not.toContain('unexpected later paragraph');
        } finally {
            restoreRange();
        }
    });

    it('视觉行重建失败时拒绝跨入后续行的不安全原生 Range', () => {
        const restoreRange = installRangeRects();
        try {
            const { layer, elements } = createLayer(['first', 'later', 'last']);
            const visualLine = capturePdfVisualLine(layer, elements.first, 12, 105);
            const nativeRange = document.createRange();
            nativeRange.setStart(elements.first.firstChild, 1);
            nativeRange.setEnd(elements.last.firstChild, 4);

            expect(resolvePdfHorizontalRange(visualLine, 150, nativeRange, () => null)).toBeNull();
        } finally {
            restoreRange();
        }
    });

    it('只把轻微纵向抖动视为水平单行手势', () => {
        expect(isNearHorizontalPdfGesture(100, 106, 12)).toBe(true);
        expect(isNearHorizontalPdfGesture(100, 116, 12)).toBe(false);
    });
});
