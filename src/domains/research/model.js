// PDF.js 在 mouseup 后已经完成单行选区收敛，旧的 180 ms 只会让用户感觉应用“愣住”。
// 保留一个很短的窗口用于合并触摸板/鼠标产生的连续 selectionchange，同时依靠 AbortController
// 取消旧请求，因此不需要用长防抖牺牲响应速度。
export const PDF_SELECTION_DEBOUNCE_MS = 40;
export const PDF_PAGE_OVERSCAN = 1;
export const UNCLASSIFIED_PROJECT_ID = '__unclassified__';
export const DEFAULT_PAPER_SORT = 'lastOpenedDesc';
export const RESEARCH_AI_INTENTS = Object.freeze({
    PAPER_QA: 'paper_qa',
    EXPLAIN_SELECTION: 'explain_selection',
});
export const PAPER_SORT_OPTIONS = Object.freeze([
    { value: 'lastOpenedDesc', label: '最近打开' },
    { value: 'lastOpenedAsc', label: '最久未打开' },
    { value: 'importedDesc', label: '最近导入' },
    { value: 'importedAsc', label: '最早导入' },
]);

const MULTI_SPACE_RE = /\s+/gu;
const TAG_NAME_COLLATOR = new Intl.Collator('zh-CN', { sensitivity: 'base' });
const PAPER_TITLE_COLLATOR = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const PAPER_SORT_VALUES = new Set(PAPER_SORT_OPTIONS.map(({ value }) => value));

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
        const isArchived = !isTrashed && Boolean(paper.archivedAt);
        if (view === 'trash') {
            if (!isTrashed) return false;
        } else if (view === 'archive') {
            if (!isArchived) return false;
        } else if (isTrashed || isArchived) {
            return false;
        }
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

export function normalizePaperSort(value) {
    const normalized = String(value ?? '').trim();
    return PAPER_SORT_VALUES.has(normalized) ? normalized : DEFAULT_PAPER_SORT;
}

function paperTimestamp(paper, fields) {
    for (const field of fields) {
        const timestamp = Date.parse(String(paper?.[field] ?? ''));
        if (Number.isFinite(timestamp)) return timestamp;
    }
    return 0;
}

/**
 * 论文排序始终返回新数组，避免筛选结果被原地修改。最近打开以数据库记录的
 * lastOpenedAt 为准；旧数据缺少该字段时回退到导入时间和更新时间。
 */
export function sortPapers(papers, sortMode = DEFAULT_PAPER_SORT) {
    const mode = normalizePaperSort(sortMode);
    const imported = mode.startsWith('imported');
    const ascending = mode.endsWith('Asc');
    const fields = imported ? ['createdAt', 'updatedAt'] : ['lastOpenedAt', 'createdAt', 'updatedAt'];
    return (Array.isArray(papers) ? papers : [])
        .map((paper, index) => ({ paper, index, timestamp: paperTimestamp(paper, fields) }))
        .sort((left, right) => {
            const timeOrder = ascending ? left.timestamp - right.timestamp : right.timestamp - left.timestamp;
            if (timeOrder) return timeOrder;
            const titleOrder = PAPER_TITLE_COLLATOR.compare(
                String(left.paper?.title ?? ''),
                String(right.paper?.title ?? '')
            );
            return titleOrder || left.index - right.index;
        })
        .map(({ paper }) => paper);
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
            (left, right) => right.count - left.count || TAG_NAME_COLLATOR.compare(left.name, right.name)
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

function buildSelectionContext(selection, pageText, limit = 8_000) {
    const quote = String(selection?.quote ?? '')
        .replace(MULTI_SPACE_RE, ' ')
        .trim();
    const prefix = String(selection?.prefix ?? '')
        .replace(MULTI_SPACE_RE, ' ')
        .trim();
    const suffix = String(selection?.suffix ?? '')
        .replace(MULTI_SPACE_RE, ' ')
        .trim();

    // PDF.js 已在创建选区锚点时提取了紧邻选区的前后文；它比整页开头更能
    // 消除术语和代词歧义，也避免长页面把真正相关的句子截掉。
    if (prefix || suffix) {
        if (quote.length >= limit) return quote.slice(0, limit);
        const separatorCount = Number(Boolean(prefix && quote)) + Number(Boolean(suffix && (prefix || quote)));
        const remaining = Math.max(0, limit - quote.length - separatorCount);
        let prefixBudget = Math.floor(remaining / 2);
        let suffixBudget = remaining - prefixBudget;
        if (prefix.length < prefixBudget) suffixBudget += prefixBudget - prefix.length;
        if (suffix.length < suffixBudget) prefixBudget += suffixBudget - suffix.length;
        const selectedPrefix = prefixBudget > 0 ? prefix.slice(-prefixBudget) : '';
        const selectedSuffix = suffixBudget > 0 ? suffix.slice(0, suffixBudget) : '';
        return [selectedPrefix, quote, selectedSuffix].filter(Boolean).join(' ');
    }

    const normalizedPageText = String(pageText ?? '')
        .replace(MULTI_SPACE_RE, ' ')
        .trim();
    if (!normalizedPageText) return quote.slice(0, limit);
    if (!quote) return normalizedPageText.slice(0, limit);

    // 兼容旧锚点或外部调用：没有 prefix/suffix 时，在整页中定位选区并截取
    // 一个以选区为中心的窗口，而不是固定取页面前 8,000 字符。
    const quoteOffset = normalizedPageText.indexOf(quote);
    if (quoteOffset < 0) return normalizedPageText.slice(0, limit);
    const contextRadius = Math.max(0, Math.floor((limit - quote.length) / 2));
    const start = Math.max(0, quoteOffset - contextRadius);
    const end = Math.min(normalizedPageText.length, quoteOffset + quote.length + contextRadius);
    return normalizedPageText.slice(start, end);
}

export function buildAiEvidence({ paperTitle = '', selection, pageText = '', intent = RESEARCH_AI_INTENTS.PAPER_QA }) {
    const pageNumber = selection?.pageNumber ?? 1;
    const quote = String(selection?.quote ?? '').trim();
    const context = buildSelectionContext(selection, pageText);
    const normalizedIntent =
        intent === RESEARCH_AI_INTENTS.EXPLAIN_SELECTION
            ? RESEARCH_AI_INTENTS.EXPLAIN_SELECTION
            : RESEARCH_AI_INTENTS.PAPER_QA;
    return {
        intent: normalizedIntent,
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
