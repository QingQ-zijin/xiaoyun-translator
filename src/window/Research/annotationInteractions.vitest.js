import { describe, expect, it } from 'vitest';

import { createPdfTextAnnotation, findAnnotationAtPdfPoint, normalizedPdfPoint } from './annotationInteractions';

const PAGE_RECT = { left: 100, top: 50, width: 800, height: 1000 };

describe('PDF 页内批注交互', () => {
    it('把点击坐标约束为页内归一化坐标', () => {
        expect(normalizedPdfPoint(PAGE_RECT, 500, 550)).toEqual({ x: 0.5, y: 0.5 });
        expect(normalizedPdfPoint(PAGE_RECT, -20, 2200)).toEqual({ x: 0, y: 1 });
    });

    it('重叠批注优先打开有内容的关联笔记，而不是底层纯高亮', () => {
        const rects = [{ x: 0.2, y: 0.3, width: 0.3, height: 0.05 }];
        const highlight = { id: 'highlight-1', kind: 'highlight', note: '', rects };
        const note = { id: 'note-1', kind: 'note', note: '关联笔记', rects };

        expect(findAnnotationAtPdfPoint([highlight, note], PAGE_RECT, 340, 370)).toBe(note);
    });

    it('创建页内文字时靠近右下角也不会超出页面', () => {
        const annotation = createPdfTextAnnotation({
            paperId: 'paper-1',
            pageNumber: 20,
            pageRect: PAGE_RECT,
            clientX: 895,
            clientY: 1045,
        });

        expect(annotation).toMatchObject({ paperId: 'paper-1', pageNumber: 20, kind: 'text', quote: '', note: '' });
        const rect = annotation.rects[0];
        expect(rect.x + rect.width).toBeLessThanOrEqual(1);
        expect(rect.y + rect.height).toBeLessThanOrEqual(1);
    });
});
