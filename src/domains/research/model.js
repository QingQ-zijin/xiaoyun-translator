// PDF.js 在 mouseup 后已经完成单行选区收敛，旧的 180 ms 只会让用户感觉应用“愣住”。
// 保留一个很短的窗口用于合并触摸板/鼠标产生的连续 selectionchange，同时依靠 AbortController
// 取消旧请求，因此不需要用长防抖牺牲响应速度。
export const PDF_SELECTION_DEBOUNCE_MS = 40;
export const PDF_PAGE_OVERSCAN = 1;
export const UNCLASSIFIED_PROJECT_ID = '__unclassified__';

const MULTI_SPACE_RE = /\s+/gu;

export function normalizeSearchText(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .replace(MULTI_SPACE_RE, ' ')
        .trim()
        .toLocaleLowerCase();
}

export function filterPapers(papers, { query = '', view = 'all', tagId = '', projectId = '' } = {}) {
    const normalizedQuery = normalizeSearchText(query);
    return (Array.isArray(papers) ? papers : []).filter((paper) => {
        const isTrashed = Boolean(paper.trashedAt);
        if (view === 'trash' ? !isTrashed : isTrashed) return false;
        if (view === 'tagged' && !(paper.tags?.length > 0)) return false;
        if (tagId && !paper.tags?.some((tag) => String(tag.id) === String(tagId))) return false;
        if (projectId === UNCLASSIFIED_PROJECT_ID && paper.projects?.length > 0) return false;
        if (
            projectId &&
            projectId !== UNCLASSIFIED_PROJECT_ID &&
            !paper.projects?.some((project) => String(project.id) === String(projectId))
        ) {
            return false;
        }
        if (!normalizedQuery) return true;

        const searchKey = normalizeSearchText(
            [
                paper.title,
                paper.authors,
                paper.year,
                ...(paper.tags ?? []).map((tag) => tag.name),
                ...(paper.projects ?? []).map((project) => project.name),
            ].join(' ')
        );
        return searchKey.includes(normalizedQuery);
    });
}

export function shouldTranslateSelection(text) {
    const normalized = String(text ?? '')
        .replace(MULTI_SPACE_RE, ' ')
        .trim();
    if (normalized.length < 2 || normalized.length > 8_000) return false;
    return /[\p{L}\p{N}]/u.test(normalized);
}

const LEXICAL_CHARACTERS_RE = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’\-–—./·+\s]*$/u;
const SENTENCE_PUNCTUATION_RE = /[.!?。！？;；：:]|\n/u;

/**
 * 区分词汇/短语与句子摘录。连接号、长破折号和希腊字母均视为科学词条的一部分，
 * 因而 Michaelis–Menten、β-oxidation 不会被错误送入句子模式。
 */
export function classifySelection(text) {
    const value = String(text ?? '')
        .normalize('NFKC')
        .replace(MULTI_SPACE_RE, ' ')
        .trim();
    if (!value) return 'none';
    const tokens = value.split(' ').filter(Boolean);
    if (
        value.length <= 96 &&
        tokens.length <= 6 &&
        !SENTENCE_PUNCTUATION_RE.test(value) &&
        LEXICAL_CHARACTERS_RE.test(value)
    ) {
        return 'vocabulary';
    }
    return 'excerpt';
}

export function annotationKind(annotation) {
    const explicit = String(annotation?.kind ?? '').trim();
    if (['vocabulary', 'excerpt', 'note', 'highlight'].includes(explicit)) return explicit;
    return String(annotation?.note ?? '').trim() ? 'note' : 'highlight';
}

export function normalizeAnnotationTags(values) {
    const seen = new Set();
    return (Array.isArray(values) ? values : [])
        .map((value) => String(value ?? '').trim())
        .filter((value) => {
            if (!value) return false;
            const key = value.normalize('NFKC').toLocaleLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, 20);
}

export function summarizeAnnotations(annotations) {
    const safeAnnotations = Array.isArray(annotations) ? annotations : [];
    const tagCounts = new Map();
    let notes = 0;
    let vocabulary = 0;
    let excerpts = 0;
    let highlights = 0;
    safeAnnotations.forEach((annotation) => {
        const kind = annotationKind(annotation);
        if (kind === 'vocabulary') vocabulary += 1;
        else if (kind === 'excerpt') excerpts += 1;
        else if (kind === 'note') notes += 1;
        else highlights += 1;
        normalizeAnnotationTags(annotation?.tags).forEach((tag) => {
            const key = tag.normalize('NFKC').toLocaleLowerCase();
            const current = tagCounts.get(key);
            tagCounts.set(key, { name: current?.name ?? tag, count: (current?.count ?? 0) + 1 });
        });
    });
    return {
        total: safeAnnotations.length,
        notes,
        vocabulary,
        excerpts,
        highlights,
        tags: [...tagCounts.values()].sort(
            (left, right) => right.count - left.count || left.name.localeCompare(right.name)
        ),
    };
}

export function normalizeSelectionRects(rects, pageRect) {
    if (!pageRect?.width || !pageRect?.height) return [];
    return (Array.isArray(rects) ? rects : [])
        .filter((rect) => rect && rect.width > 0 && rect.height > 0)
        .map((rect) => ({
            x: Math.max(0, Math.min(1, (rect.left - pageRect.left) / pageRect.width)),
            y: Math.max(0, Math.min(1, (rect.top - pageRect.top) / pageRect.height)),
            width: Math.max(0, Math.min(1, rect.width / pageRect.width)),
            height: Math.max(0, Math.min(1, rect.height / pageRect.height)),
        }));
}

export function createSelectionAnchor({
    paperId,
    pageNumber,
    quote,
    pageText = '',
    rects = [],
    pageRect,
    color = 'violet',
    contextRadius = 180,
}) {
    const normalizedQuote = String(quote ?? '')
        .replace(MULTI_SPACE_RE, ' ')
        .trim();
    const normalizedPageText = String(pageText ?? '')
        .replace(MULTI_SPACE_RE, ' ')
        .trim();
    const startOffset = normalizedPageText.indexOf(normalizedQuote);
    const resolvedStart = Math.max(0, startOffset);
    const resolvedEnd = startOffset >= 0 ? startOffset + normalizedQuote.length : 0;

    return {
        paperId,
        pageNumber: Math.max(1, Number(pageNumber) || 1),
        quote: normalizedQuote,
        prefix: startOffset >= 0 ? normalizedPageText.slice(Math.max(0, startOffset - contextRadius), startOffset) : '',
        suffix:
            startOffset >= 0
                ? normalizedPageText.slice(
                      resolvedEnd,
                      Math.min(normalizedPageText.length, resolvedEnd + contextRadius)
                  )
                : '',
        startOffset: startOffset >= 0 ? resolvedStart : null,
        endOffset: startOffset >= 0 ? resolvedEnd : null,
        rects: pageRect ? normalizeSelectionRects(rects, pageRect) : rects,
        color,
    };
}

export function getVirtualPageWindow({ visiblePages, pageCount, overscan = PDF_PAGE_OVERSCAN }) {
    const count = Math.max(0, Number(pageCount) || 0);
    const result = new Set();
    for (const page of visiblePages ?? []) {
        const pageNumber = Number(page);
        if (!Number.isFinite(pageNumber)) continue;
        for (let offset = -overscan; offset <= overscan; offset += 1) {
            const candidate = pageNumber + offset;
            if (candidate >= 1 && candidate <= count) result.add(candidate);
        }
    }
    return [...result].sort((a, b) => a - b);
}

export function clampReadingProgress({ pageNumber, pageCount, scale = 1.25, scrollRatio = 0 }) {
    const count = Math.max(1, Number(pageCount) || 1);
    return {
        pageNumber: Math.min(count, Math.max(1, Number(pageNumber) || 1)),
        scale: Math.min(3, Math.max(0.5, Number(scale) || 1.25)),
        scrollRatio: Math.min(1, Math.max(0, Number(scrollRatio) || 0)),
    };
}

export function buildAiEvidence({ paperTitle = '', selection, pageText = '' }) {
    const pageNumber = selection?.pageNumber ?? 1;
    const quote = String(selection?.quote ?? '').trim();
    const context = String(pageText ?? '')
        .replace(MULTI_SPACE_RE, ' ')
        .trim()
        .slice(0, 8_000);
    return {
        paperTitle: String(paperTitle ?? '').trim(),
        pageNumber,
        quote,
        context,
        citationLabel: `第 ${pageNumber} 页`,
    };
}

export function shouldConfirmEmbeddingInstall(status) {
    return Boolean(status?.confirmationRequired && !status?.installed);
}

export function researchJobProgress(job) {
    const explicit = Number(job?.progress);
    const calculated = Number(job?.completed) / Math.max(1, Number(job?.total) || 1);
    const ratio = Number.isFinite(explicit) ? explicit : calculated;
    return Math.max(0, Math.min(100, Math.round((Number.isFinite(ratio) ? ratio : 0) * 100)));
}
