function clampUnit(value) {
    return Math.min(1, Math.max(0, Number(value) || 0));
}

export function normalizedPdfPoint(pageRect, clientX, clientY) {
    const width = Math.max(1, Number(pageRect?.width) || 0);
    const height = Math.max(1, Number(pageRect?.height) || 0);
    return {
        x: clampUnit((Number(clientX) - Number(pageRect?.left || 0)) / width),
        y: clampUnit((Number(clientY) - Number(pageRect?.top || 0)) / height),
    };
}

export function findAnnotationAtPdfPoint(annotations, pageRect, clientX, clientY) {
    if (!pageRect || !(pageRect.width > 0) || !(pageRect.height > 0)) return null;
    const point = normalizedPdfPoint(pageRect, clientX, clientY);
    const candidates = (Array.isArray(annotations) ? annotations : []).flatMap((annotation, index) => {
        const hitRect = (Array.isArray(annotation?.rects) ? annotation.rects : []).find((rect) => {
            const left = clampUnit(rect?.x);
            const top = clampUnit(rect?.y);
            const right = clampUnit(left + Math.max(0, Number(rect?.width) || 0));
            const bottom = clampUnit(top + Math.max(0, Number(rect?.height) || 0));
            return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
        });
        if (!hitRect) return [];
        const kind = String(annotation?.kind ?? '').trim();
        const priority = String(annotation?.note ?? '').trim() ? 4 : kind === 'text' ? 3 : kind === 'note' ? 2 : 1;
        const area = Math.max(0, Number(hitRect.width) || 0) * Math.max(0, Number(hitRect.height) || 0);
        return [{ annotation, priority, area, index }];
    });
    candidates.sort(
        (left, right) => right.priority - left.priority || left.area - right.area || left.index - right.index
    );
    return candidates[0]?.annotation ?? null;
}

export function createPdfTextAnnotation({ paperId, pageNumber, pageRect, clientX, clientY, color = 'violet' }) {
    const point = normalizedPdfPoint(pageRect, clientX, clientY);
    const normalizedWidth = Math.min(0.38, Math.max(0.2, 240 / Math.max(1, Number(pageRect?.width) || 1)));
    const normalizedHeight = Math.min(0.16, Math.max(0.055, 46 / Math.max(1, Number(pageRect?.height) || 1)));
    return {
        paperId,
        pageNumber: Math.max(1, Number(pageNumber) || 1),
        kind: 'text',
        quote: '',
        note: '',
        tags: [],
        color,
        rects: [
            {
                x: Math.min(1 - normalizedWidth, point.x),
                y: Math.min(1 - normalizedHeight, point.y),
                width: normalizedWidth,
                height: normalizedHeight,
            },
        ],
    };
}
