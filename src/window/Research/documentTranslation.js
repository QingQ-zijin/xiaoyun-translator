const DEFAULT_CHUNK_CHARACTERS = 1_800;

function normalizedText(value) {
    return String(value ?? '')
        .replace(/\r\n?/gu, '\n')
        .split('\n')
        .map((line) => line.replace(/[\t\f\v ]+/gu, ' ').trimEnd())
        .join('\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();
}

function splitLongParagraph(paragraph, limit) {
    const sentences = paragraph.split(/(?<=[.!?。！？；;])\s+/u).filter(Boolean);
    if (sentences.length <= 1) {
        const characters = [...paragraph];
        return Array.from({ length: Math.ceil(characters.length / limit) }, (_, index) =>
            characters.slice(index * limit, (index + 1) * limit).join('')
        );
    }

    const parts = [];
    let current = '';
    for (const sentence of sentences) {
        if (current && [...`${current} ${sentence}`].length > limit) {
            parts.push(current);
            current = '';
        }
        if ([...sentence].length > limit) {
            if (current) parts.push(current);
            parts.push(...splitLongParagraph(sentence, limit));
            current = '';
        } else {
            current = current ? `${current} ${sentence}` : sentence;
        }
    }
    if (current) parts.push(current);
    return parts;
}

/**
 * 按自然段和句末切分整页，禁止在固定字符边界直接截断学术句子。
 */
export function splitDocumentTranslationChunks(text, limit = DEFAULT_CHUNK_CHARACTERS) {
    const safeLimit = Math.max(240, Number(limit) || DEFAULT_CHUNK_CHARACTERS);
    const paragraphs = normalizedText(text)
        .split(/\n{2,}/u)
        .filter(Boolean);
    const chunks = [];
    let current = '';
    for (const paragraph of paragraphs.flatMap((item) => splitLongParagraph(item, safeLimit))) {
        const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
        if (current && [...candidate].length > safeLimit) {
            chunks.push(current);
            current = paragraph;
        } else {
            current = candidate;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

export function mergeDocumentPageSources(...pageCollections) {
    const byPage = new Map();
    for (const collection of pageCollections) {
        for (const page of Array.isArray(collection) ? collection : []) {
            const pageNumber = Math.max(1, Number(page?.pageNumber) || 1);
            const text = normalizedText(page?.text);
            if (!text) continue;
            const existing = byPage.get(pageNumber);
            // PDF.js 的完整文本层优先；OCR/数据库页只补足缺失页面。
            if (!existing || text.length > existing.text.length) byPage.set(pageNumber, { pageNumber, text });
        }
    }
    return [...byPage.values()].sort((left, right) => left.pageNumber - right.pageNumber);
}

export function validCachedDocumentTranslations(pages, cachedPages) {
    const sourceByPage = new Map((pages ?? []).map((page) => [Number(page.pageNumber), normalizedText(page.text)]));
    return (cachedPages ?? [])
        .filter((page) => {
            const source = sourceByPage.get(Number(page.pageNumber));
            return source && source === normalizedText(page.sourceText) && normalizedText(page.translation);
        })
        .sort((left, right) => Number(left.pageNumber) - Number(right.pageNumber));
}

function createAbortError() {
    if (typeof DOMException === 'function') return new DOMException('全文翻译已暂停', 'AbortError');
    const error = new Error('全文翻译已暂停');
    error.name = 'AbortError';
    return error;
}

export async function translateDocumentPage({
    page,
    paperTitle,
    paperInsights,
    targetLanguage,
    signal,
    translateChunk,
    onChunkProgress,
}) {
    if (!page?.text) throw new Error('待翻译页面没有文本');
    if (typeof translateChunk !== 'function') throw new TypeError('缺少全文翻译函数');
    const chunks = splitDocumentTranslationChunks(page.text);
    const translations = [];
    for (let index = 0; index < chunks.length; index += 1) {
        if (signal?.aborted) throw createAbortError();
        const chunk = chunks[index];
        const translated = await translateChunk({
            selection: {
                quote: chunk,
                pageNumber: page.pageNumber,
                prefix: chunks[index - 1]?.slice(-500) ?? '',
                suffix: chunks[index + 1]?.slice(0, 500) ?? '',
            },
            paperTitle,
            paperInsights,
            targetLanguage,
            signal,
            onDelta: (text) =>
                onChunkProgress?.({
                    chunk: index + 1,
                    chunkCount: chunks.length,
                    text: [...translations, normalizedText(text)].filter(Boolean).join('\n\n'),
                }),
        });
        if (signal?.aborted) throw createAbortError();
        const text = normalizedText(translated);
        if (!text) throw new Error(`第 ${page.pageNumber} 页第 ${index + 1} 段返回空译文`);
        translations.push(text);
        onChunkProgress?.({
            chunk: index + 1,
            chunkCount: chunks.length,
            text: translations.join('\n\n'),
        });
    }
    return translations.join('\n\n');
}

export function documentTranslationProgress(totalPages, completedPages) {
    const total = Math.max(0, Number(totalPages) || 0);
    const completed = Math.min(total, Math.max(0, Number(completedPages) || 0));
    return {
        total,
        completed,
        percent: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
}

export { normalizedText as normalizeDocumentTranslationText };
