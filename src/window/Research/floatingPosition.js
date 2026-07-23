const DEFAULT_MARGIN = 12;
const DEFAULT_GAP = 10;

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
    if (maximum < minimum) return minimum;
    return Math.min(maximum, Math.max(minimum, value));
}

function normalizeRect(rect = {}) {
    const left = finiteNumber(rect.left ?? rect.x);
    const top = finiteNumber(rect.top ?? rect.y);
    const width = Math.max(0, finiteNumber(rect.width, finiteNumber(rect.right) - left));
    const height = Math.max(0, finiteNumber(rect.height, finiteNumber(rect.bottom) - top));
    const right = finiteNumber(rect.right, left + width);
    const bottom = finiteNumber(rect.bottom, top + height);
    return {
        left: Math.min(left, right),
        top: Math.min(top, bottom),
        right: Math.max(left, right),
        bottom: Math.max(top, bottom),
        width: Math.abs(right - left),
        height: Math.abs(bottom - top),
    };
}

function normalizeBoundary({ boundaryRect, viewportWidth, viewportHeight, margin = DEFAULT_MARGIN }) {
    const width = Math.max(1, finiteNumber(viewportWidth, 1));
    const height = Math.max(1, finiteNumber(viewportHeight, 1));
    const rawBoundary = boundaryRect ?? { left: 0, top: 0, right: width, bottom: height };
    const boundaryLeft = clamp(finiteNumber(rawBoundary.left), 0, width);
    const boundaryTop = clamp(finiteNumber(rawBoundary.top), 0, height);
    const boundaryRight = clamp(finiteNumber(rawBoundary.right, width), boundaryLeft, width);
    const boundaryBottom = clamp(finiteNumber(rawBoundary.bottom, height), boundaryTop, height);
    const safeMargin = Math.max(0, finiteNumber(margin, DEFAULT_MARGIN));
    return {
        left: boundaryLeft + safeMargin,
        top: boundaryTop + safeMargin,
        right: Math.max(boundaryLeft + safeMargin, boundaryRight - safeMargin),
        bottom: Math.max(boundaryTop + safeMargin, boundaryBottom - safeMargin),
    };
}

/** 将多行文字的 DOMRect 合并成完整选区包围盒。 */
export function mergeClientRects(rects = []) {
    const normalized = Array.from(rects)
        .map((rect) => normalizeRect(rect))
        .filter((rect) => rect.width > 0 && rect.height > 0);
    if (normalized.length === 0) return null;
    const left = Math.min(...normalized.map((rect) => rect.left));
    const top = Math.min(...normalized.map((rect) => rect.top));
    const right = Math.max(...normalized.map((rect) => rect.right));
    const bottom = Math.max(...normalized.map((rect) => rect.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** 将拖动后的浮窗钳制在阅读工作区与视口的交集内。 */
export function clampFloatingPosition({
    left,
    top,
    floatingSize,
    viewportWidth,
    viewportHeight,
    boundaryRect,
    margin = DEFAULT_MARGIN,
} = {}) {
    const boundary = normalizeBoundary({ boundaryRect, viewportWidth, viewportHeight, margin });
    const availableWidth = Math.max(1, boundary.right - boundary.left);
    const availableHeight = Math.max(1, boundary.bottom - boundary.top);
    const width = Math.min(availableWidth, Math.max(1, finiteNumber(floatingSize?.width, availableWidth)));
    const height = Math.min(availableHeight, Math.max(1, finiteNumber(floatingSize?.height, availableHeight)));
    return {
        left: clamp(finiteNumber(left, boundary.left), boundary.left, boundary.right - width),
        top: clamp(finiteNumber(top, boundary.top), boundary.top, boundary.bottom - height),
        maxWidth: availableWidth,
        maxHeight: availableHeight,
    };
}

function verticalCandidate({ placement, avoid, anchor, requestedWidth, requestedHeight, boundary, gap, align }) {
    const maxWidth = Math.max(1, boundary.right - boundary.left);
    const maxHeight = Math.max(
        1,
        placement === 'bottom' ? boundary.bottom - avoid.bottom - gap : avoid.top - gap - boundary.top
    );
    const width = Math.min(requestedWidth, maxWidth);
    const height = Math.min(requestedHeight, maxHeight);
    const requestedLeft = align === 'start' ? anchor.left : anchor.left + (anchor.right - anchor.left) / 2 - width / 2;
    return {
        left: clamp(requestedLeft, boundary.left, boundary.right - width),
        top: placement === 'bottom' ? avoid.bottom + gap : avoid.top - gap - height,
        placement,
        maxWidth,
        maxHeight,
        fits: requestedWidth <= maxWidth && requestedHeight <= maxHeight,
        area: width * height,
    };
}

function horizontalCandidate({ placement, avoid, anchor, requestedWidth, requestedHeight, boundary, gap }) {
    const maxWidth = Math.max(
        1,
        placement === 'right' ? boundary.right - avoid.right - gap : avoid.left - gap - boundary.left
    );
    const maxHeight = Math.max(1, boundary.bottom - boundary.top);
    const width = Math.min(requestedWidth, maxWidth);
    const height = Math.min(requestedHeight, maxHeight);
    const requestedTop = anchor.top + (anchor.bottom - anchor.top) / 2 - height / 2;
    return {
        left: placement === 'right' ? avoid.right + gap : avoid.left - gap - width,
        top: clamp(requestedTop, boundary.top, boundary.bottom - height),
        placement,
        maxWidth,
        maxHeight,
        fits: requestedWidth <= maxWidth && requestedHeight <= maxHeight,
        area: width * height,
    };
}

/**
 * 计算选区浮层的位置。
 *
 * 候选顺序为下、上、右、左；优先使用可完整容纳浮窗的候选。如果四侧均不足，
 * 选择可见面积最大的一侧并缩小浮窗，使默认位置仍不会覆盖完整文字选区。
 */
export function computeFloatingPosition({
    anchorRect,
    avoidRect,
    floatingSize,
    viewportWidth,
    viewportHeight,
    boundaryRect,
    gap = DEFAULT_GAP,
    margin = DEFAULT_MARGIN,
    align = 'center',
} = {}) {
    const boundary = normalizeBoundary({ boundaryRect, viewportWidth, viewportHeight, margin });
    const availableWidth = Math.max(1, boundary.right - boundary.left);
    const availableHeight = Math.max(1, boundary.bottom - boundary.top);
    const requestedWidth = Math.min(availableWidth, Math.max(1, finiteNumber(floatingSize?.width, availableWidth)));
    const requestedHeight = Math.min(availableHeight, Math.max(1, finiteNumber(floatingSize?.height, availableHeight)));
    const anchor = normalizeRect(anchorRect);
    const avoid = normalizeRect(avoidRect ?? anchorRect);
    const safeGap = Math.max(0, finiteNumber(gap, DEFAULT_GAP));
    const candidates = [
        verticalCandidate({
            placement: 'bottom',
            avoid,
            anchor,
            requestedWidth,
            requestedHeight,
            boundary,
            gap: safeGap,
            align,
        }),
        verticalCandidate({
            placement: 'top',
            avoid,
            anchor,
            requestedWidth,
            requestedHeight,
            boundary,
            gap: safeGap,
            align,
        }),
        horizontalCandidate({
            placement: 'right',
            avoid,
            anchor,
            requestedWidth,
            requestedHeight,
            boundary,
            gap: safeGap,
        }),
        horizontalCandidate({
            placement: 'left',
            avoid,
            anchor,
            requestedWidth,
            requestedHeight,
            boundary,
            gap: safeGap,
        }),
    ];
    const selected =
        candidates.find((candidate) => candidate.fits) ??
        candidates.reduce((best, candidate) => {
            if (!best || candidate.area > best.area) return candidate;
            return best;
        }, null);

    return {
        left: selected.left,
        top: selected.top,
        placement: selected.placement,
        maxWidth: selected.maxWidth,
        maxHeight: selected.maxHeight,
    };
}
