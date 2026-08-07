import { extractText } from '../../domains/vision';
import { createPdfDocumentOptions, loadPdfRuntime } from './pdfRuntime';

const MAX_OCR_PIXELS = 12_000_000;
const OCR_TARGET_WIDTH = 1700;

function abortError() {
    if (typeof DOMException === 'function') return new DOMException('扫描 PDF 识别已取消', 'AbortError');
    const error = new Error('扫描 PDF 识别已取消');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
}

async function safelyCall(method, owner) {
    if (typeof method !== 'function') return;
    try {
        await method.call(owner);
    } catch {
        // 资源清理不能覆盖已经生成的 OCR 结果。
    }
}

function normalizeOcrText(value) {
    return String(value ?? '')
        .replace(/\r\n?/gu, '\n')
        .replace(/^```(?:markdown|text)?\s*|\s*```$/giu, '')
        .split('\n')
        .map((line) => line.replace(/[\t\f\v ]+/gu, ' ').trimEnd())
        .join('\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();
}

async function renderPageImage(page) {
    const baseViewport = page.getViewport({ scale: 1 });
    const requestedScale = Math.min(2.8, Math.max(1.35, OCR_TARGET_WIDTH / Math.max(1, baseViewport.width)));
    const scale = Math.min(
        requestedScale,
        Math.sqrt(MAX_OCR_PIXELS / Math.max(1, baseViewport.width * baseViewport.height))
    );
    const viewport = page.getViewport({ scale });
    const canvas = globalThis.document?.createElement?.('canvas');
    if (!canvas) throw new Error('当前环境无法渲染扫描 PDF 页面');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
    if (!context) throw new Error('当前环境无法创建 PDF 页面画布');
    try {
        await page.render({ canvasContext: context, viewport }).promise;
        return canvas.toDataURL('image/jpeg', 0.9);
    } finally {
        canvas.width = 0;
        canvas.height = 0;
    }
}

/**
 * 仅识别 PDF.js 没有文字层的页面。每完成一页立即回调，调用方可持久化后再继续，
 * 因而长书籍中途暂停或程序重启时不必从第一页重新进行多模态识别。
 */
export async function extractPdfPagesWithVision(
    source,
    { pageNumbers = [], signal, onProgress, onPage, recognize = extractText } = {}
) {
    const safeSource = String(source ?? '').trim();
    if (!safeSource) throw new TypeError('PDF 来源不能为空');
    throwIfAborted(signal);

    let loadingTask = null;
    let pdfDocument = null;
    try {
        const pdfjs = await loadPdfRuntime();
        throwIfAborted(signal);
        loadingTask = pdfjs.getDocument(createPdfDocumentOptions(safeSource));
        pdfDocument = await loadingTask.promise;
        const pageCount = Math.max(0, Math.trunc(Number(pdfDocument?.numPages) || 0));
        const targets = [...new Set(pageNumbers.map(Number))]
            .filter((pageNumber) => Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= pageCount)
            .sort((left, right) => left - right);
        const pages = [];

        for (let index = 0; index < targets.length; index += 1) {
            throwIfAborted(signal);
            const pageNumber = targets[index];
            let page = null;
            try {
                onProgress?.({ completed: index, total: targets.length, pageNumber });
                page = await pdfDocument.getPage(pageNumber);
                const image = await renderPageImage(page);
                throwIfAborted(signal);
                const text = normalizeOcrText(await recognize({ image, language: 'auto', mode: 'auto', signal }));
                if (text) {
                    const item = { pageNumber, text };
                    pages.push(item);
                    await onPage?.(item);
                }
                onProgress?.({ completed: index + 1, total: targets.length, pageNumber });
            } finally {
                await safelyCall(page?.cleanup, page);
            }
            if (index % 2 === 1) await new Promise((resolve) => setTimeout(resolve, 0));
        }
        return { pages, pageCount };
    } finally {
        await safelyCall(pdfDocument?.destroy, pdfDocument);
        await safelyCall(loadingTask?.destroy, loadingTask);
    }
}
