import {
    generatePaperInsights,
    getDocument,
    getPaperInsights,
    getPdfSource,
    indexDocumentPages,
    isTauriRuntime,
    isTranslationActive,
    markDocumentTextIndexComplete,
    replaceDocumentOutline,
    syncPaperReferences,
    updateDocumentPageCount,
} from '../../domains/research/bridge';
import { extractSharedPdfText } from './pdfTextExtraction';

const GENERATION_POLL_MS = 500;
const DEFERRED_RETRY_MS = 750;
const DEFERRED = Symbol('deferred-paper-insights');
const queuedJobs = new Map();
const textPreparations = new Map();
const pendingJobs = [];
let queueRunning = false;
let retryTimer = null;

export function hasReadyPaperInsights(insights) {
    const payload = insights?.payload && typeof insights.payload === 'object' ? insights.payload : insights;
    return insights?.status === 'ready' && Boolean(String(payload?.summary ?? '').trim());
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForRunningGeneration(paperId, insights) {
    let current = insights;
    while (current?.status === 'generating') {
        await delay(GENERATION_POLL_MS);
        current = await getPaperInsights(paperId);
    }
    return current;
}

function prepareTextOnce(paperId, producer) {
    const existing = textPreparations.get(paperId);
    if (existing) return existing;

    const preparation = Promise.resolve().then(producer);
    textPreparations.set(paperId, preparation);
    void preparation.catch(() => {
        if (textPreparations.get(paperId) === preparation) textPreparations.delete(paperId);
    });
    return preparation;
}

function prepareExtractedText(paperId, extraction) {
    return prepareTextOnce(paperId, async () => {
        const pageCount = Math.max(0, Number(extraction?.pageCount) || 0);
        const pages = Array.isArray(extraction?.pages) ? extraction.pages : [];
        if (pages.length > 0) await indexDocumentPages(paperId, pages);
        if (pageCount > 0) await markDocumentTextIndexComplete(paperId, pageCount);
    });
}

function preparePaperText(paperId) {
    return prepareTextOnce(paperId, async () => {
        const document = await getDocument(paperId);
        const textContent = String(document?.textContent ?? '').trim();
        if (textContent) {
            await indexDocumentPages(paperId, [{ pageNumber: 1, text: textContent }]);
            return;
        }

        if (document?.documentType !== 'pdf') return;
        const source = getPdfSource(document);
        if (!source) throw new Error('导入的 PDF 缺少可读取的本地来源');
        const extracted = await extractSharedPdfText(paperId, source);
        if (extracted.pageCount > 0) await updateDocumentPageCount(paperId, extracted.pageCount);
        if (extracted.pages.length > 0) await indexDocumentPages(paperId, extracted.pages);
        if (extracted.outline?.length > 0) {
            await replaceDocumentOutline(paperId, extracted.outline);
        }
        const tailStart = Math.max(1, extracted.pageCount - 23);
        const referencePages = extracted.pages.filter((page) => page.pageNumber <= 2 || page.pageNumber >= tailStart);
        if (referencePages.length > 0) await syncPaperReferences(paperId, referencePages);
        if (extracted.pageCount > 0) {
            await markDocumentTextIndexComplete(paperId, extracted.pageCount);
        }
    });
}

async function processPaperInsightsJob(job) {
    const { paperId } = job;
    let stored = await getPaperInsights(paperId);
    if (!isTauriRuntime()) return stored;
    if (!job.revalidate && hasReadyPaperInsights(stored) && job.contentKind !== 'book') return stored;

    const contentKind = String(job.contentKind ?? 'paper').toLocaleLowerCase();
    if (contentKind === 'book') {
        // 书籍先在后台建立全文索引与可校验目录；章节概要在用户打开章节时按需生成并持久化。
        // 避免把数百页书籍压成一次“论文概要”，也避免导入后长时间独占本地模型。
        await preparePaperText(paperId);
        return getPaperInsights(paperId);
    }
    stored = await waitForRunningGeneration(paperId, stored);
    if (!job.revalidate && hasReadyPaperInsights(stored)) return stored;

    if (!job.revalidate) {
        await preparePaperText(paperId);
        stored = await waitForRunningGeneration(paperId, await getPaperInsights(paperId));
        if (hasReadyPaperInsights(stored)) return stored;
    }

    // 前台翻译活跃时只轮转队列，不调用研究模型；翻译与概要之间的最终竞态
    // 仍由 Rust 的 active counter、取消标志和 idle wait 共同兜底。
    if (await isTranslationActive()) return DEFERRED;
    try {
        return await generatePaperInsights(paperId, { force: false });
    } catch (reason) {
        const latest = await getPaperInsights(paperId).catch(() => null);
        if (latest?.status === 'paused') return DEFERRED;
        throw reason;
    }
}

function schedulePump(delayMs = 0) {
    if (queueRunning || retryTimer != null || pendingJobs.length === 0) return;
    if (delayMs > 0) {
        retryTimer = setTimeout(() => {
            retryTimer = null;
            void pumpQueue();
        }, delayMs);
        return;
    }
    void pumpQueue();
}

async function pumpQueue() {
    if (queueRunning || pendingJobs.length === 0) return;
    queueRunning = true;
    const job = pendingJobs.shift();
    let deferred = false;
    try {
        const result = await processPaperInsightsJob(job);
        if (result === DEFERRED) {
            deferred = true;
            pendingJobs.push(job);
        } else {
            queuedJobs.delete(job.paperId);
            job.resolve(result);
        }
    } catch (reason) {
        queuedJobs.delete(job.paperId);
        job.reject(reason);
    } finally {
        queueRunning = false;
        // 每次被前台翻译延后都低频轮转到队尾，既不忙轮询，也不会让后续论文永久饥饿。
        schedulePump(deferred ? DEFERRED_RETRY_MS : 0);
    }
}

function enqueuePaperInsights(paperId, { revalidate = false, contentKind } = {}) {
    const safePaperId = String(paperId ?? '').trim();
    if (!safePaperId) return Promise.reject(new TypeError('论文 ID 不能为空'));
    const existing = queuedJobs.get(safePaperId);
    if (existing) {
        existing.revalidate ||= revalidate;
        if (contentKind) existing.contentKind = contentKind;
        return existing.promise;
    }

    let resolve;
    let reject;
    const promise = new Promise((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
    });
    const job = { paperId: safePaperId, promise, resolve, reject, revalidate, contentKind };
    queuedJobs.set(safePaperId, job);
    pendingJobs.push(job);
    schedulePump();
    return promise;
}

export function enqueueImportedPaperInsights(paperId, options) {
    return enqueuePaperInsights(paperId, options);
}

export function enqueuePreparedPaperInsights(paperId, extraction, options) {
    const safePaperId = String(paperId ?? '').trim();
    if (!safePaperId) return Promise.reject(new TypeError('论文 ID 不能为空'));
    void prepareExtractedText(safePaperId, extraction).catch(() => undefined);
    return enqueuePaperInsights(safePaperId, options);
}

export function enqueueImportedPapersInsights(papers, options) {
    return (Array.isArray(papers) ? papers : [])
        .map((paper) => ({
            paperId: String(paper?.id ?? '').trim(),
            contentKind: String(paper?.contentKind ?? '').trim() || undefined,
        }))
        .filter(({ paperId }) => Boolean(paperId))
        .map(({ paperId, contentKind }) => ({
            paperId,
            promise: enqueueImportedPaperInsights(paperId, { ...options, contentKind }),
        }));
}

export function resetPaperInsightsQueueForTests() {
    if (retryTimer != null) clearTimeout(retryTimer);
    retryTimer = null;
    queueRunning = false;
    pendingJobs.splice(0, pendingJobs.length);
    queuedJobs.clear();
    textPreparations.clear();
}
