import { createPdfDocumentOptions, loadPdfRuntime } from './pdfRuntime';
import { deriveOutlineFromPages, extractNativePdfOutline } from './pdfOutline';

const PDF_YIELD_INTERVAL = 4;
const SHARED_EXTRACTION_TTL_MS = 30_000;
const sharedExtractions = new Map();

function createAbortError() {
    if (typeof DOMException === 'function') return new DOMException('PDF 全文提取已取消', 'AbortError');
    const error = new Error('PDF 全文提取已取消');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw createAbortError();
}

/**
 * 等待 PDF.js 异步操作时同步响应取消信号；底层 Promise 仍由后续资源销毁负责终止。
 */
function awaitWithAbort(promise, signal) {
    if (!signal) return Promise.resolve(promise);
    if (signal.aborted) return Promise.reject(createAbortError());

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            callback(value);
        };
        const onAbort = () => finish(reject, createAbortError());

        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise).then(
            (value) => finish(resolve, value),
            (error) => finish(reject, error)
        );
    });
}

async function safelyCall(method, owner) {
    if (typeof method !== 'function') return;
    try {
        await method.call(owner);
    } catch {
        // 清理失败不能覆盖原始解析结果或错误；PDF.js 的 destroy/cleanup 本身允许重复调用。
    }
}

function normalizePageText(items) {
    return (Array.isArray(items) ? items : [])
        .map((item) => `${String(item?.str ?? '')}${item?.hasEOL ? '\n' : ' '}`)
        .join('')
        .replace(/\r\n?/gu, '\n')
        .split('\n')
        .map((line) => line.replace(/[\t\f\v ]+/gu, ' ').trimEnd())
        .join('\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();
}

function yieldToEventLoop(signal) {
    return awaitWithAbort(new Promise((resolve) => setTimeout(resolve, 0)), signal);
}

/**
 * 无渲染地提取 PDF 全文，供导入后的后台索引与概要任务复用。
 *
 * @param {string} source PDF.js 可读取的 URL。
 * @param {{ signal?: AbortSignal }} options 取消控制。
 * @returns {Promise<{pages: Array<{pageNumber: number, text: string}>, pageCount: number, textPageCount: number, totalCharacters: number}>}
 */
export async function extractPdfText(source, { signal } = {}) {
    const safeSource = String(source ?? '').trim();
    if (!safeSource) throw new TypeError('PDF 来源不能为空');
    throwIfAborted(signal);

    let loadingTask = null;
    let pdfDocument = null;
    try {
        const pdfjs = await awaitWithAbort(loadPdfRuntime(), signal);
        throwIfAborted(signal);
        loadingTask = pdfjs.getDocument(createPdfDocumentOptions(safeSource));
        pdfDocument = await awaitWithAbort(loadingTask.promise, signal);
        throwIfAborted(signal);

        const pageCount = Math.max(0, Math.trunc(Number(pdfDocument?.numPages) || 0));
        const nativeOutline = await awaitWithAbort(extractNativePdfOutline(pdfDocument), signal);
        const pages = [];
        let totalCharacters = 0;

        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
            throwIfAborted(signal);
            let page = null;
            try {
                page = await awaitWithAbort(pdfDocument.getPage(pageNumber), signal);
                const textContent = await awaitWithAbort(page.getTextContent(), signal);
                const text = normalizePageText(textContent?.items);
                if (text) {
                    pages.push({ pageNumber, text });
                    totalCharacters += text.length;
                }
            } finally {
                await safelyCall(page?.cleanup, page);
            }

            // 长论文每处理四页主动让出一次事件循环，避免阻塞阅读与划词交互。
            if (pageNumber % PDF_YIELD_INTERVAL === 0 && pageNumber < pageCount) {
                await yieldToEventLoop(signal);
            }
        }

        return {
            pages,
            pageCount,
            textPageCount: pages.length,
            totalCharacters,
            outline: nativeOutline.length ? nativeOutline : deriveOutlineFromPages(pages, pageCount, 'text'),
        };
    } finally {
        // 无论成功、解析失败还是取消，都主动释放文档、加载任务和 PDF.js worker。
        await safelyCall(pdfDocument?.destroy, pdfDocument);
        await safelyCall(loadingTask?.destroy, loadingTask);
    }
}

/**
 * 同一论文的后台概要与阅读器共享一次全文解析，避免为长 PDF 同时创建两套
 * PDF.js worker。结果短暂保留，足够让稍后挂载的阅读器复用，但不会长期占用内存。
 */
function releaseSharedExtraction(job, consumer) {
    if (!job?.consumers?.delete(consumer) || job.settled || job.consumers.size > 0) return;
    if (sharedExtractions.get(job.paperId) === job) sharedExtractions.delete(job.paperId);
    job.controller.abort();
}

function subscribeToSharedExtraction(job, signal) {
    const consumer = Symbol('pdf-text-consumer');
    job.consumers.add(consumer);
    const pending = awaitWithAbort(job.promise, signal);
    return pending.finally(() => releaseSharedExtraction(job, consumer));
}

function cancelSharedExtraction(job) {
    if (!job) return;
    if (job.expiryTimer) clearTimeout(job.expiryTimer);
    if (!job.settled) job.controller.abort();
}

export function extractSharedPdfText(paperId, source, { signal } = {}) {
    const safePaperId = String(paperId ?? '').trim();
    const safeSource = String(source ?? '').trim();
    if (!safePaperId) throw new TypeError('论文 ID 不能为空');
    if (!safeSource) throw new TypeError('PDF 来源不能为空');

    const existing = sharedExtractions.get(safePaperId);
    if (existing?.source === safeSource) return subscribeToSharedExtraction(existing, signal);
    if (existing) {
        sharedExtractions.delete(safePaperId);
        cancelSharedExtraction(existing);
    }

    const controller = new AbortController();
    const job = {
        paperId: safePaperId,
        source: safeSource,
        controller,
        promise: null,
        consumers: new Set(),
        settled: false,
        expiryTimer: null,
    };
    job.promise = extractPdfText(safeSource, { signal: controller.signal });
    const scheduleExpiry = () => {
        job.expiryTimer = setTimeout(() => {
            if (sharedExtractions.get(safePaperId) === job) sharedExtractions.delete(safePaperId);
        }, SHARED_EXTRACTION_TTL_MS);
    };
    // 成功结果短暂复用；失败结果立即移除，确保用户重试时会重新读取文件。
    // 同时注册两类出口，避免拒绝产生未处理的派生 Promise。
    void job.promise.then(
        () => {
            job.settled = true;
            scheduleExpiry();
        },
        () => {
            job.settled = true;
            if (sharedExtractions.get(safePaperId) === job) sharedExtractions.delete(safePaperId);
        }
    );
    sharedExtractions.set(safePaperId, job);
    return subscribeToSharedExtraction(job, signal);
}

export function resetSharedPdfTextExtractionsForTests() {
    for (const job of sharedExtractions.values()) {
        cancelSharedExtraction(job);
    }
    sharedExtractions.clear();
}
