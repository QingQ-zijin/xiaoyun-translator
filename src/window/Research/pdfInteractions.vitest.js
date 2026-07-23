import { describe, expect, it } from 'vitest';

import {
    clusterSelectionRects,
    computeAnchoredScroll,
    computePanScroll,
    getContinuousPdfScale,
    getGesturePdfScale,
    getPointerPinchGeometry,
    shouldStartPointerPinch,
    shouldSnapSelectionGesture,
} from './pdfInteractions';

describe('PDF 平移与缩放几何', () => {
    it('按拖动反方向移动滚动位置并限制在边界内', () => {
        expect(
            computePanScroll({
                startScrollLeft: 120,
                startScrollTop: 80,
                startX: 100,
                startY: 100,
                currentX: 70,
                currentY: 150,
                maxScrollLeft: 300,
                maxScrollTop: 200,
            })
        ).toEqual({ scrollLeft: 150, scrollTop: 30 });
        expect(
            computePanScroll({
                startScrollLeft: 10,
                startScrollTop: 10,
                startX: 0,
                startY: 0,
                currentX: 200,
                currentY: -500,
                maxScrollLeft: 300,
                maxScrollTop: 200,
            })
        ).toEqual({ scrollLeft: 0, scrollTop: 200 });
    });

    it('缩放后用锚点偏差补偿滚动位置', () => {
        expect(
            computeAnchoredScroll({
                scrollLeft: 100,
                scrollTop: 200,
                anchorClientX: 480,
                anchorClientY: 360,
                targetClientX: 400,
                targetClientY: 300,
                maxScrollLeft: 500,
                maxScrollTop: 800,
            })
        ).toEqual({ scrollLeft: 180, scrollTop: 260 });
    });

    it('Ctrl+滚轮和触摸板捏合使用同一套连续缩放，并保持 50% 到 300% 的边界', () => {
        const zoomIn = getContinuousPdfScale(1.25, -80);
        const zoomOut = getContinuousPdfScale(1.25, 80);

        expect(zoomIn).toBeGreaterThan(1.25);
        expect(zoomOut).toBeLessThan(1.25);
        expect(getContinuousPdfScale(0.5, 99_999)).toBe(0.5);
        expect(getContinuousPdfScale(3, -99_999)).toBe(3);
        expect(getContinuousPdfScale(1, -3, 1)).toBeGreaterThan(1);
        expect(getContinuousPdfScale(1, 1, 2)).toBeLessThan(1);
        expect(getGesturePdfScale(1.25, 1.2)).toBe(1.5);
        expect(getGesturePdfScale(1.25, 0.8)).toBe(1);
        expect(getGesturePdfScale(3, 9)).toBe(3);
        expect(getGesturePdfScale(0.5, 0.01)).toBe(0.5);
        expect(getGesturePdfScale(1.25, undefined)).toBe(1.25);
    });

    it('未提供滚动上限时仍保留有效的平移和锚点补偿', () => {
        expect(
            computePanScroll({
                startScrollLeft: 20,
                startScrollTop: 30,
                startX: 10,
                startY: 10,
                currentX: 0,
                currentY: 0,
            })
        ).toEqual({ scrollLeft: 30, scrollTop: 40 });
        expect(
            computeAnchoredScroll({
                scrollLeft: 20,
                scrollTop: 30,
                anchorClientX: 50,
                anchorClientY: 70,
                targetClientX: 40,
                targetClientY: 50,
            })
        ).toEqual({ scrollLeft: 30, scrollTop: 50 });
    });

    it('计算双指捏合中心，并用位移阈值区分缩放与普通双指滚动', () => {
        expect(
            getPointerPinchGeometry([
                { clientX: 100, clientY: 120 },
                { clientX: 200, clientY: 120 },
            ])
        ).toEqual({ distance: 100, clientX: 150, clientY: 120 });
        expect(getPointerPinchGeometry([{ clientX: 100, clientY: 120 }])).toBeNull();
        expect(getPointerPinchGeometry(null)).toBeNull();
        expect(
            getPointerPinchGeometry([
                { clientX: 10, clientY: 10 },
                { clientX: 10, clientY: 10 },
            ])
        ).toBeNull();

        expect(shouldStartPointerPinch(100, 104)).toBe(false);
        expect(shouldStartPointerPinch(100, 108)).toBe(true);
        expect(shouldStartPointerPinch(400, 408)).toBe(false);
        expect(shouldStartPointerPinch(400, 412)).toBe(true);
        expect(shouldStartPointerPinch(0, 12)).toBe(false);
    });
});

describe('PDF 选区的视觉行判断', () => {
    const baseLine = [
        { left: 10, top: 100, width: 80, height: 12 },
        { left: 92, top: 98, width: 8, height: 7 },
    ];

    it('把正文与上下标聚为同一视觉行', () => {
        const lines = clusterSelectionRects(baseLine);
        expect(lines).toHaveLength(1);
        expect(lines[0].rects).toHaveLength(2);
    });

    it('把相邻正文行保持为不同视觉行并忽略零面积矩形', () => {
        expect(
            clusterSelectionRects([
                ...baseLine,
                { left: 10, top: 116, width: 90, height: 12 },
                { left: 0, top: 0, width: 0, height: 5 },
            ])
        ).toHaveLength(2);
        expect(clusterSelectionRects(undefined)).toEqual([]);
        expect(
            clusterSelectionRects([
                null,
                { x: 12, y: 20, width: 8, height: 6 },
                { left: 0, top: 0, width: 6, height: 4 },
                { left: 12, top: 0, width: 6, height: 4 },
            ])
        ).toMatchObject([
            { left: 0, top: 0, right: 18, bottom: 4 },
            { left: 12, top: 20, right: 20, bottom: 26 },
        ]);
    });

    it('只有多行选区且纵向偏移属于轻微抖动时才吸附', () => {
        const twoLines = [...baseLine, { left: 10, top: 116, width: 90, height: 12 }];
        expect(shouldSnapSelectionGesture({ rects: twoLines, startY: 105, endY: 109, lineHeight: 12 })).toBe(true);
        expect(shouldSnapSelectionGesture({ rects: twoLines, startY: 105, endY: 118, lineHeight: 12 })).toBe(false);
        expect(shouldSnapSelectionGesture({ rects: baseLine, startY: 105, endY: 109, lineHeight: 12 })).toBe(false);
        expect(shouldSnapSelectionGesture({ rects: twoLines, startY: 0, endY: 4 })).toBe(true);
        expect(shouldSnapSelectionGesture({ rects: twoLines, startY: 0, endY: 9, lineHeight: 40 })).toBe(true);
        expect(shouldSnapSelectionGesture({ rects: twoLines, startY: 0, endY: 15, lineHeight: 40 })).toBe(false);
        expect(shouldSnapSelectionGesture({ rects: twoLines })).toBe(true);
    });
});
