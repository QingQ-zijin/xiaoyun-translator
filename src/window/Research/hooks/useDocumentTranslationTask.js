import { useCallback, useRef, useState } from 'react';

import {
    clearDocumentTranslation,
    getIndexedDocumentPages,
    getPdfSource,
    indexDocumentPages,
    listDocumentTranslationPages,
    saveDocumentTranslationPage,
    translateSelection,
} from '../../../domains/research/bridge';
import {
    mergeDocumentPageSources,
    translateDocumentPage,
    validCachedDocumentTranslations,
} from '../documentTranslation';
import { extractSharedPdfText } from '../pdfTextExtraction';
import { extractPdfPagesWithVision } from '../pdfVisionExtraction';

const INITIAL_TASK = Object.freeze({
    status: 'idle',
    paper: null,
    paperId: '',
    totalPages: 0,
    completedPages: 0,
    currentPage: 0,
    partialText: '',
    statusMessage: '',
    error: '',
});

function abortError(reason) {
    return reason?.name === 'AbortError' || /已暂停|cancelled|canceled|取消/iu.test(String(reason?.message ?? reason));
}

function sourcePagesFromTextDocument(document) {
    const text = String(document?.textContent ?? document?.paper?.textContent ?? '').trim();
    return text ? [{ pageNumber: 1, text }] : [];
}

export function useDocumentTranslationTask({ document, paperInsights, translationModel, onNotice }) {
    const [open, setOpen] = useState(false);
    const [targetLanguage, setTargetLanguageState] = useState('zh_cn');
    const [includeOriginal, setIncludeOriginal] = useState(true);
    const [task, setTask] = useState(INITIAL_TASK);
    const controllerRef = useRef(null);
    const pagesRef = useRef([]);
    const translatedRef = useRef(new Map());
    const taskContextRef = useRef(null);

    const prepare = useCallback(
        async (sourceDocument, language, signal) => {
            const paper = sourceDocument?.paper;
            if (!paper?.id) throw new Error('请先打开要翻译的文献');
            setTask((current) => ({
                ...current,
                status: 'preparing',
                paper,
                paperId: paper.id,
                currentPage: 0,
                partialText: '',
                error: '',
                statusMessage: '正在读取全文和已保存译文…',
            }));

            const indexedPages = await getIndexedDocumentPages(paper.id);
            let extractedPages = [];
            let pdfPageCount = 0;
            const sourceUrl = sourceDocument.documentType === 'pdf' ? getPdfSource(sourceDocument) : '';
            if (sourceDocument.documentType === 'pdf' && sourceUrl) {
                try {
                    const extracted = await extractSharedPdfText(paper.id, sourceUrl, { signal });
                    extractedPages = extracted.pages ?? [];
                    pdfPageCount = Number(extracted.pageCount) || 0;
                } catch (reason) {
                    if (abortError(reason)) throw reason;
                    // 已完成 OCR 的扫描件可以只依赖数据库页；解析失败时不覆盖可用 OCR 文本。
                    if (indexedPages.length === 0) throw reason;
                }
            } else {
                extractedPages = sourcePagesFromTextDocument(sourceDocument);
            }
            let pages = mergeDocumentPageSources(extractedPages, indexedPages);
            if (sourceDocument.documentType === 'pdf' && sourceUrl && pdfPageCount > 0) {
                const available = new Set(pages.map((page) => Number(page.pageNumber)));
                const missingPages = Array.from({ length: pdfPageCount }, (_, index) => index + 1).filter(
                    (pageNumber) => !available.has(pageNumber)
                );
                // 普通数字 PDF 偶尔存在封面或空白页，不应为少量空页启动视觉模型；
                // 文字覆盖不足 70% 时才判定为扫描件或混合型 PDF，并只 OCR 缺失页。
                const requiresVision = missingPages.length > 0 && pages.length / pdfPageCount < 0.7;
                if (requiresVision) {
                    setTask((current) => ({
                        ...current,
                        status: 'preparing',
                        totalPages: pdfPageCount,
                        statusMessage: `检测到扫描页面，正在用 Gemma 识别 0/${missingPages.length} 页…`,
                    }));
                    const vision = await extractPdfPagesWithVision(sourceUrl, {
                        pageNumbers: missingPages,
                        signal,
                        onProgress: ({ completed, total, pageNumber }) =>
                            setTask((current) => ({
                                ...current,
                                currentPage: pageNumber,
                                statusMessage: `Gemma 正在识别扫描页 ${completed}/${total}…`,
                            })),
                        // 每页完成立即写入数据库；即使中途暂停，下一次也会从缺失页继续。
                        onPage: (page) => indexDocumentPages(paper.id, [page]),
                    });
                    pages = mergeDocumentPageSources(extractedPages, indexedPages, vision.pages);
                }
            }
            if (pages.length === 0) {
                throw new Error('没有识别到可翻译文字，请确认文件未加密且页面内容清晰。');
            }

            const cached = validCachedDocumentTranslations(
                pages,
                await listDocumentTranslationPages(paper.id, language)
            );
            pagesRef.current = pages;
            translatedRef.current = new Map(cached.map((page) => [Number(page.pageNumber), page]));
            taskContextRef.current = {
                paper,
                paperId: paper.id,
                sourceUrl,
                documentType: sourceDocument.documentType,
                targetLanguage: language,
                paperInsights,
            };
            setTask((current) => ({
                ...current,
                status: cached.length === pages.length ? 'complete' : 'paused',
                paper,
                paperId: paper.id,
                totalPages: pages.length,
                completedPages: cached.length,
                currentPage: 0,
                partialText: '',
                error: '',
                statusMessage:
                    cached.length === pages.length
                        ? '已从本地读取完整译文，可直接导出 PDF。'
                        : cached.length > 0
                          ? `已恢复 ${cached.length} 页本地译文，将从下一页继续。`
                          : `已找到 ${pages.length} 个含文本的页面。`,
            }));
            return { pages, cached, sourceUrl };
        },
        [paperInsights]
    );

    const start = useCallback(async () => {
        if (!document?.paper?.id && !taskContextRef.current?.paperId) return;
        controllerRef.current?.abort();
        const controller = new AbortController();
        controllerRef.current = controller;
        const sourceDocument =
            taskContextRef.current?.paperId === document?.paper?.id &&
            taskContextRef.current?.targetLanguage === targetLanguage
                ? null
                : document;

        try {
            if (sourceDocument || pagesRef.current.length === 0) {
                await prepare(sourceDocument ?? document, targetLanguage, controller.signal);
            }
            const context = taskContextRef.current;
            const pages = pagesRef.current;
            const pending = pages.filter((page) => !translatedRef.current.has(Number(page.pageNumber)));
            if (pending.length === 0) {
                setTask((current) => ({ ...current, status: 'complete', statusMessage: '全文译文已保存在本地。' }));
                return;
            }

            setTask((current) => ({ ...current, status: 'translating', error: '', statusMessage: '' }));
            for (const page of pending) {
                if (controller.signal.aborted) break;
                setTask((current) => ({
                    ...current,
                    status: 'translating',
                    currentPage: page.pageNumber,
                    partialText: '',
                    statusMessage: `正在翻译第 ${page.pageNumber} 页…`,
                }));
                const translated = await translateDocumentPage({
                    page,
                    paperTitle: context.paper.title,
                    paperInsights: context.paperInsights,
                    targetLanguage: context.targetLanguage,
                    signal: controller.signal,
                    translateChunk: (request) =>
                        translateSelection({
                            ...request,
                            onDelta: request.onDelta,
                            onStatus: (message) =>
                                setTask((current) => ({ ...current, statusMessage: message || current.statusMessage })),
                        }),
                    onChunkProgress: ({ chunk, chunkCount, text }) =>
                        setTask((current) => ({
                            ...current,
                            partialText: text,
                            statusMessage: `第 ${page.pageNumber} 页 · ${chunk}/${chunkCount} 段`,
                        })),
                });
                const saved = await saveDocumentTranslationPage({
                    paperId: context.paperId,
                    targetLanguage: context.targetLanguage,
                    pageNumber: page.pageNumber,
                    sourceText: page.text,
                    translation: translated,
                    model: translationModel,
                });
                translatedRef.current.set(Number(page.pageNumber), saved);
                setTask((current) => ({
                    ...current,
                    completedPages: translatedRef.current.size,
                    partialText: '',
                    statusMessage: `第 ${page.pageNumber} 页已保存到本地`,
                }));
            }
            if (controller.signal.aborted) {
                setTask((current) => ({ ...current, status: 'paused', partialText: '', statusMessage: '已暂停' }));
            } else {
                setTask((current) => ({
                    ...current,
                    status: 'complete',
                    currentPage: 0,
                    partialText: '',
                    completedPages: pages.length,
                    statusMessage: '全文翻译完成，所有页面已保存在本地。',
                }));
                onNotice?.('全文翻译完成，可以导出完整 PDF');
            }
        } catch (reason) {
            if (abortError(reason) || controller.signal.aborted) {
                setTask((current) => ({ ...current, status: 'paused', partialText: '', statusMessage: '已暂停' }));
            } else {
                setTask((current) => ({
                    ...current,
                    status: 'failed',
                    partialText: '',
                    error: String(reason?.message ?? reason),
                    statusMessage: '',
                }));
            }
        } finally {
            if (controllerRef.current === controller) controllerRef.current = null;
        }
    }, [document, onNotice, prepare, targetLanguage, translationModel]);

    const pause = useCallback(() => {
        controllerRef.current?.abort();
        setTask((current) => ({ ...current, status: 'paused', statusMessage: '正在保存进度并暂停…' }));
    }, []);

    const reset = useCallback(async () => {
        const paperId = taskContextRef.current?.paperId ?? document?.paper?.id;
        if (!paperId) return;
        controllerRef.current?.abort();
        await clearDocumentTranslation(paperId, targetLanguage);
        pagesRef.current = [];
        translatedRef.current = new Map();
        taskContextRef.current = null;
        setTask({ ...INITIAL_TASK, paper: document?.paper ?? null, paperId });
        onNotice?.('已清除当前语言的全文译文，可重新翻译');
    }, [document?.paper, onNotice, targetLanguage]);

    const exportPdf = useCallback(async () => {
        const context = taskContextRef.current;
        if (!context || translatedRef.current.size !== pagesRef.current.length) return;
        setTask((current) => ({ ...current, status: 'exporting', error: '', statusMessage: '正在排版译文 PDF…' }));
        try {
            // PDFLib 与文件保存插件只在真正导出时加载，日常划词和阅读不承担这部分启动成本。
            const { buildTranslatedPdf, sanitizeTranslatedPdfFilename, saveTranslatedPdf } = await import(
                '../documentTranslationPdf'
            );
            const bytes = await buildTranslatedPdf({
                sourceUrl: context.sourceUrl,
                title: context.paper.title,
                pages: [...translatedRef.current.values()],
                includeOriginal: includeOriginal && context.documentType === 'pdf',
                onProgress: ({ completed, total }) =>
                    setTask((current) => ({ ...current, statusMessage: `正在排版 ${completed}/${total} 页…` })),
            });
            const path = await saveTranslatedPdf(
                bytes,
                sanitizeTranslatedPdfFilename(context.paper.title, context.targetLanguage)
            );
            setTask((current) => ({
                ...current,
                status: 'complete',
                statusMessage: path ? `已保存：${path}` : '已取消保存，译文仍保留在本地。',
            }));
            if (path) onNotice?.('完整译文 PDF 已生成');
            return path;
        } catch (reason) {
            setTask((current) => ({
                ...current,
                status: 'complete',
                error: `导出 PDF 失败：${String(reason?.message ?? reason)}`,
                statusMessage: '',
            }));
            return null;
        }
    }, [includeOriginal, onNotice]);

    const setTargetLanguage = useCallback((language) => {
        controllerRef.current?.abort();
        pagesRef.current = [];
        translatedRef.current = new Map();
        taskContextRef.current = null;
        setTargetLanguageState(language);
        setTask(INITIAL_TASK);
    }, []);

    const show = useCallback(() => {
        if (!document?.paper) return;
        setOpen(true);
        if (task.paperId && task.paperId !== document.paper.id && task.status !== 'translating') {
            pagesRef.current = [];
            translatedRef.current = new Map();
            taskContextRef.current = null;
            setTask({ ...INITIAL_TASK, paper: document.paper, paperId: document.paper.id });
        } else if (!task.paperId) {
            setTask((current) => ({ ...current, paper: document.paper, paperId: document.paper.id }));
        }
    }, [document?.paper, task.paperId, task.status]);

    return {
        open,
        show,
        close: () => setOpen(false),
        task,
        targetLanguage,
        setTargetLanguage,
        includeOriginal,
        setIncludeOriginal,
        start,
        pause,
        reset,
        exportPdf,
    };
}
