function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || 0));
}

/**
 * 将鼠标 Ctrl+滚轮与 Windows 触摸板捏合统一为连续缩放比例。
 * `deltaMode` 兼容像素、行和整页三种滚轮单位，并限制单次突变。
 */
export function getContinuousPdfScale(scale, deltaY, deltaMode = 0) {
    const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? 320 : 1;
    const normalizedDelta = clamp(Number(deltaY) * unit, -240, 240);
    const next = (Number(scale) || 1.25) * Math.exp(-normalizedDelta * 0.0022);
    return Math.round(clamp(next, 0.5, 3) * 1000) / 1000;
}

/** 将 gesture 事件的累计倍率映射到与滚轮相同的 50%—300% 阅读缩放范围。 */
export function getGesturePdfScale(startScale, gestureScale) {
    const numericGestureScale = Number(gestureScale);
    const factor = Number.isFinite(numericGestureScale) && numericGestureScale > 0 ? numericGestureScale : 1;
    const next = (Number(startScale) || 1.25) * clamp(factor, 0.2, 5);
    return Math.round(clamp(next, 0.5, 3) * 1000) / 1000;
}

/**
 * 从两个触摸指针计算捏合的距离和中心点。触摸板在 WebView2 中通常表现为
 * `ctrlKey + wheel`，这里补足触屏及会暴露 PointerEvent 的设备。
 */
export function getPointerPinchGeometry(points) {
    const pair = Array.from(points ?? []).slice(0, 2);
    if (pair.length !== 2) return null;
    const [first, second] = pair;
    const deltaX = Number(second.clientX) - Number(first.clientX);
    const deltaY = Number(second.clientY) - Number(first.clientY);
    const distance = Math.hypot(deltaX, deltaY);
    if (!Number.isFinite(distance) || distance <= 0) return null;
    return {
        distance,
        clientX: (Number(first.clientX) + Number(second.clientX)) / 2,
        clientY: (Number(first.clientY) + Number(second.clientY)) / 2,
    };
}

/** 只有两指间距出现明确变化时才接管手势，避免把普通双指滚动误判为缩放。 */
export function shouldStartPointerPinch(startDistance, currentDistance) {
    const start = Number(startDistance);
    const current = Number(currentDistance);
    if (!(start > 0) || !(current > 0)) return false;
    return Math.abs(current - start) >= Math.max(6, start * 0.025);
}

export function computePanScroll({
    startScrollLeft,
    startScrollTop,
    startX,
    startY,
    currentX,
    currentY,
    maxScrollLeft = Number.POSITIVE_INFINITY,
    maxScrollTop = Number.POSITIVE_INFINITY,
}) {
    return {
        scrollLeft: clamp(startScrollLeft - (currentX - startX), 0, maxScrollLeft),
        scrollTop: clamp(startScrollTop - (currentY - startY), 0, maxScrollTop),
    };
}

export function computeAnchoredScroll({
    scrollLeft,
    scrollTop,
    anchorClientX,
    anchorClientY,
    targetClientX,
    targetClientY,
    maxScrollLeft = Number.POSITIVE_INFINITY,
    maxScrollTop = Number.POSITIVE_INFINITY,
}) {
    return {
        scrollLeft: clamp(scrollLeft + anchorClientX - targetClientX, 0, maxScrollLeft),
        scrollTop: clamp(scrollTop + anchorClientY - targetClientY, 0, maxScrollTop),
    };
}

function normalizeRect(rect) {
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    const left = Number(rect.left ?? rect.x) || 0;
    const top = Number(rect.top ?? rect.y) || 0;
    const width = Number(rect.width) || 0;
    const height = Number(rect.height) || 0;
    return { left, top, right: left + width, bottom: top + height, width, height };
}

export function clusterSelectionRects(rects) {
    const normalized = (Array.isArray(rects) ? rects : [])
        .map(normalizeRect)
        .filter(Boolean)
        .sort((a, b) => a.top - b.top || a.left - b.left);
    const lines = [];

    normalized.forEach((rect) => {
        const rectCenter = (rect.top + rect.bottom) / 2;
        const line = lines.find((candidate) => {
            const overlap = Math.min(candidate.bottom, rect.bottom) - Math.max(candidate.top, rect.top);
            const overlapRatio = overlap / Math.max(1, Math.min(candidate.height, rect.height));
            const centerDistance = Math.abs(candidate.center - rectCenter);
            return overlapRatio >= 0.35 || centerDistance <= Math.max(candidate.height, rect.height) * 0.42;
        });
        if (!line) {
            lines.push({
                top: rect.top,
                bottom: rect.bottom,
                left: rect.left,
                right: rect.right,
                height: rect.height,
                center: rectCenter,
                rects: [rect],
            });
            return;
        }
        line.top = Math.min(line.top, rect.top);
        line.bottom = Math.max(line.bottom, rect.bottom);
        line.left = Math.min(line.left, rect.left);
        line.right = Math.max(line.right, rect.right);
        line.height = line.bottom - line.top;
        line.center = (line.top + line.bottom) / 2;
        line.rects.push(rect);
    });

    return lines.sort((a, b) => a.top - b.top || a.left - b.left);
}

export function shouldSnapSelectionGesture({ rects, startY, endY, lineHeight }) {
    if (clusterSelectionRects(rects).length < 2) return false;
    const jitterLimit = clamp((Number(lineHeight) || 0) * 0.8, 6, 14);
    return Math.abs((Number(endY) || 0) - (Number(startY) || 0)) <= jitterLimit;
}
