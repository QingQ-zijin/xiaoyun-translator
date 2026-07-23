import { clusterSelectionRects } from './pdfInteractions';

const TEXT_NODE = 3;

function directTextNode(element) {
    return [...(element?.childNodes ?? [])].find(
        (node) => node.nodeType === TEXT_NODE && String(node.textContent ?? '').length > 0
    );
}

function normalizedElementRect(element) {
    const rect = element?.getBoundingClientRect?.();
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
    };
}

function verticalMatch(left, right) {
    const overlap = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
    const overlapRatio = overlap / Math.max(1, Math.min(left.height, right.height));
    const centerDistance = Math.abs((left.top + left.bottom - right.top - right.bottom) / 2);
    return overlapRatio >= 0.35 || centerDistance <= Math.max(left.height, right.height) * 0.42;
}

function textFragments(layer) {
    return [...(layer?.querySelectorAll?.('span') ?? [])]
        .filter((element) => !element.querySelector('span'))
        .map((element) => ({ element, node: directTextNode(element), rect: normalizedElementRect(element) }))
        .filter((fragment) => fragment.node && fragment.rect);
}

function elementFromTarget(target) {
    if (target?.nodeType === TEXT_NODE) return target.parentElement;
    return target;
}

/**
 * 记录按下点所在的 PDF.js 文本片段和整条视觉行。
 * WebView2 的原生 Selection 端点可能落到 DOM 顺序中的后续段落，因此不能把它当作单行拖选的真实终点。
 */
export function capturePdfVisualLine(layer, target, startX, startY) {
    const fragments = textFragments(layer);
    if (fragments.length === 0) return null;

    const targetElement = elementFromTarget(target)?.closest?.('span');
    let startFragment = fragments.find((fragment) => fragment.element === targetElement);
    if (!startFragment) {
        startFragment = fragments.reduce((closest, fragment) => {
            const verticalDistance =
                startY < fragment.rect.top
                    ? fragment.rect.top - startY
                    : startY > fragment.rect.bottom
                      ? startY - fragment.rect.bottom
                      : 0;
            const horizontalDistance =
                startX < fragment.rect.left
                    ? fragment.rect.left - startX
                    : startX > fragment.rect.right
                      ? startX - fragment.rect.right
                      : 0;
            const distance = verticalDistance * 4 + horizontalDistance;
            return !closest || distance < closest.distance ? { fragment, distance } : closest;
        }, null)?.fragment;
    }
    if (!startFragment) return null;

    // 以上下标的较小矩形为起点时，先通过迭代扩展找到同一基线上的正文片段。
    const lineFragments = [startFragment];
    let changed = true;
    while (changed) {
        changed = false;
        fragments.forEach((fragment) => {
            if (lineFragments.includes(fragment)) return;
            if (lineFragments.some((member) => verticalMatch(member.rect, fragment.rect))) {
                lineFragments.push(fragment);
                changed = true;
            }
        });
    }
    lineFragments.sort((left, right) => left.rect.left - right.rect.left || left.rect.top - right.rect.top);

    const lineRect = lineFragments.reduce(
        (bounds, fragment) => ({
            left: Math.min(bounds.left, fragment.rect.left),
            right: Math.max(bounds.right, fragment.rect.right),
            top: Math.min(bounds.top, fragment.rect.top),
            bottom: Math.max(bounds.bottom, fragment.rect.bottom),
            width: 0,
            height: 0,
        }),
        { ...startFragment.rect }
    );
    lineRect.width = lineRect.right - lineRect.left;
    lineRect.height = lineRect.bottom - lineRect.top;

    return {
        layer,
        fragments: lineFragments,
        lineRect,
        startFragment,
        startCaret: caretForFragmentPoint(startFragment, startX),
    };
}

function measuredBoundaryX(fragment, offset) {
    const { element, node, rect } = fragment;
    if (offset <= 0) return rect.left;
    if (offset >= node.length) return rect.right;
    const documentRef = element.ownerDocument;
    const range = documentRef?.createRange?.();
    if (!range?.getClientRects) return null;
    try {
        range.setStart(node, 0);
        range.setEnd(node, offset);
        const rects = [...range.getClientRects()].filter((candidate) => candidate.width > 0 || candidate.height > 0);
        return rects.at(-1)?.right ?? range.getBoundingClientRect?.().right ?? null;
    } catch {
        return null;
    } finally {
        range?.detach?.();
    }
}

function caretForFragmentPoint(fragment, x) {
    const { node, rect } = fragment;
    const length = node.length;
    if (length === 0 || x <= rect.left) return { node, offset: 0 };
    if (x >= rect.right) return { node, offset: length };

    let bestOffset = Math.round(((x - rect.left) / Math.max(1, rect.width)) * length);
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset <= length; offset += 1) {
        const boundaryX = measuredBoundaryX(fragment, offset);
        if (!Number.isFinite(boundaryX)) continue;
        const distance = Math.abs(boundaryX - x);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestOffset = offset;
        }
    }
    return { node, offset: Math.min(length, Math.max(0, bestOffset)) };
}

function closestFragmentAtX(fragments, x) {
    return fragments.reduce((closest, fragment) => {
        const distance =
            x < fragment.rect.left ? fragment.rect.left - x : x > fragment.rect.right ? x - fragment.rect.right : 0;
        return !closest || distance < closest.distance ? { fragment, distance } : closest;
    }, null)?.fragment;
}

function createRangeBetweenCarets(documentRef, first, second) {
    if (!documentRef?.createRange || !first?.node || !second?.node) return null;
    const range = documentRef.createRange();
    try {
        range.setStart(first.node, first.offset);
        range.setEnd(second.node, second.offset);
        if (range.collapsed && (first.node !== second.node || first.offset !== second.offset)) {
            range.setStart(second.node, second.offset);
            range.setEnd(first.node, first.offset);
        }
        return range;
    } catch {
        return null;
    }
}

function rangeBelongsToLine(range, visualLine) {
    if (!range || range.collapsed || !visualLine) return false;
    const allowedElements = new Set(visualLine.fragments.map((fragment) => fragment.element));
    const startElement = elementFromTarget(range.startContainer)?.closest?.('span');
    const endElement = elementFromTarget(range.endContainer)?.closest?.('span');
    if (!allowedElements.has(startElement) || !allowedElements.has(endElement)) return false;

    const rects = [...(range.getClientRects?.() ?? [])].filter((rect) => rect.width > 0 && rect.height > 0);
    if (rects.length === 0 || clusterSelectionRects(rects).length !== 1) return false;
    const tolerance = Math.max(2, visualLine.lineRect.height * 0.2);
    if (
        rects.some(
            (rect) =>
                rect.bottom < visualLine.lineRect.top - tolerance || rect.top > visualLine.lineRect.bottom + tolerance
        )
    )
        return false;

    const lineCharacterBudget = visualLine.fragments.reduce((total, fragment) => total + fragment.node.length, 0);
    return range.toString().trim().length <= lineCharacterBudget + visualLine.fragments.length * 2;
}

function sameNodeFallbackRange(documentRef, visualLine, endX) {
    const start = visualLine?.startCaret;
    const startFragment = visualLine?.startFragment;
    if (!start || !startFragment) return null;
    let end = caretForFragmentPoint(startFragment, endX);
    if (end.offset === start.offset && startFragment.node.length > 0) {
        end = {
            node: startFragment.node,
            offset: Math.min(startFragment.node.length, start.offset + (endX >= startFragment.rect.left ? 1 : -1)),
        };
        if (end.offset === start.offset) end.offset = Math.max(0, start.offset - 1);
    }
    return createRangeBetweenCarets(documentRef, start, end);
}

/**
 * 按视觉行重建水平拖选，并在提交前验证 Range。验证失败时最多保留起点文本节点内的安全选区，
 * 绝不把 WebView2 意外扩展出的后续段落交给翻译模型。
 */
export function rebuildPdfSingleLineRange(visualLine, endX) {
    if (!visualLine?.fragments?.length) return null;
    const documentRef = visualLine.layer?.ownerDocument;
    const endFragment = closestFragmentAtX(visualLine.fragments, endX);
    const endCaret = endFragment ? caretForFragmentPoint(endFragment, endX) : null;
    const candidate = createRangeBetweenCarets(documentRef, visualLine.startCaret, endCaret);
    if (rangeBelongsToLine(candidate, visualLine)) return candidate;

    const fallback = sameNodeFallbackRange(documentRef, visualLine, endX);
    return rangeBelongsToLine(fallback, visualLine) ? fallback : null;
}

/**
 * 优先采用按视觉行重建的安全 Range；若重建暂时失败，则仅在浏览器原生 Range
 * 已被验证仍属于同一视觉行时保留它。这样既不会误收后续段落，也不会丢弃 WebView2
 * 已经正确提交的原生选区。
 */
export function resolvePdfHorizontalRange(visualLine, endX, nativeRange, rebuildRange = rebuildPdfSingleLineRange) {
    const rebuiltRange = rebuildRange(visualLine, endX);
    if (rebuiltRange) return rebuiltRange;
    return rangeBelongsToLine(nativeRange, visualLine) ? nativeRange : null;
}

export function isNearHorizontalPdfGesture(startY, endY, lineHeight) {
    const jitterLimit = Math.min(14, Math.max(6, (Number(lineHeight) || 12) * 0.8));
    return Math.abs((Number(endY) || 0) - (Number(startY) || 0)) <= jitterLimit;
}
