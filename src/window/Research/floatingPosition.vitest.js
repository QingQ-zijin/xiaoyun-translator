import { describe, expect, it } from 'vitest';

import { clampFloatingPosition, computeFloatingPosition, mergeClientRects } from './floatingPosition';

describe('选区浮层定位', () => {
    it('下方空间足够时优先放在选区下方并水平居中', () => {
        expect(
            computeFloatingPosition({
                anchorRect: { left: 400, top: 200, right: 500, bottom: 220 },
                floatingSize: { width: 360, height: 240 },
                viewportWidth: 1000,
                viewportHeight: 800,
            })
        ).toMatchObject({ left: 270, top: 230, placement: 'bottom' });
    });

    it('下方空间不足时翻到选区上方', () => {
        expect(
            computeFloatingPosition({
                anchorRect: { left: 400, top: 700, right: 500, bottom: 720 },
                floatingSize: { width: 360, height: 200 },
                viewportWidth: 1000,
                viewportHeight: 800,
            })
        ).toMatchObject({ left: 270, top: 490, placement: 'top' });
    });

    it('浮层大于下方空间时选择可见面积更大且不遮挡选区的一侧', () => {
        expect(
            computeFloatingPosition({
                anchorRect: { left: 5, top: 5, right: 25, bottom: 25 },
                floatingSize: { width: 500, height: 400 },
                viewportWidth: 320,
                viewportHeight: 240,
            })
        ).toEqual({
            left: 35,
            top: 12,
            placement: 'right',
            maxWidth: 273,
            maxHeight: 216,
        });
    });

    it('使用完整多行选区作为避让范围，而不是只避让鼠标所在行', () => {
        const result = computeFloatingPosition({
            anchorRect: { left: 650, top: 350, right: 730, bottom: 370 },
            avoidRect: { left: 360, top: 180, right: 760, bottom: 380 },
            floatingSize: { width: 430, height: 300 },
            viewportWidth: 1200,
            viewportHeight: 900,
            boundaryRect: { left: 300, top: 100, right: 1100, bottom: 820 },
        });

        expect(result.placement).toBe('bottom');
        expect(result.top).toBe(390);
        expect(result.top).toBeGreaterThanOrEqual(380 + 10);
    });

    it('合并多行 DOMRect 得到完整选区包围盒', () => {
        expect(
            mergeClientRects([
                { left: 120, top: 80, right: 360, bottom: 102, width: 240, height: 22 },
                { left: 80, top: 104, right: 410, bottom: 126, width: 330, height: 22 },
            ])
        ).toEqual({ left: 80, top: 80, right: 410, bottom: 126, width: 330, height: 46 });
    });

    it('拖动位置会被限制在阅读工作区内', () => {
        expect(
            clampFloatingPosition({
                left: -200,
                top: 900,
                floatingSize: { width: 430, height: 300 },
                viewportWidth: 1200,
                viewportHeight: 900,
                boundaryRect: { left: 300, top: 100, right: 1100, bottom: 820 },
            })
        ).toEqual({ left: 312, top: 508, maxWidth: 776, maxHeight: 696 });
    });

    it('支持阅读区边界与右键菜单的起点对齐', () => {
        expect(
            computeFloatingPosition({
                anchorRect: { left: 980, top: 300, right: 980, bottom: 300 },
                floatingSize: { width: 190, height: 180 },
                viewportWidth: 1200,
                viewportHeight: 900,
                boundaryRect: { left: 300, top: 100, right: 1000, bottom: 800 },
                align: 'start',
                gap: 4,
            })
        ).toMatchObject({ left: 798, top: 304, placement: 'bottom' });
    });
});
