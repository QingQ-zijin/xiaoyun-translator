import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    loadPdfRuntime: vi.fn(),
}));

vi.mock('./pdfRuntime', async (importOriginal) => ({
    ...(await importOriginal()),
    loadPdfRuntime: mocks.loadPdfRuntime,
}));

import { extractPdfText, extractSharedPdfText, resetSharedPdfTextExtractionsForTests } from './pdfTextExtraction';

function createPage(items) {
    return {
        cleanup: vi.fn(),
        getTextContent: vi.fn().mockResolvedValue({ items }),
    };
}

function prepareDocument(pages, overrides = {}) {
    const pdfDocument = {
        destroy: vi.fn().mockResolvedValue(undefined),
        getPage: vi.fn(async (pageNumber) => pages[pageNumber - 1]),
        numPages: pages.length,
        ...overrides,
    };
    const loadingTask = {
        destroy: vi.fn().mockResolvedValue(undefined),
        promise: Promise.resolve(pdfDocument),
    };
    const getDocument = vi.fn(() => loadingTask);
    mocks.loadPdfRuntime.mockResolvedValue({ getDocument });
    return { getDocument, loadingTask, pdfDocument };
}

describe('无渲染 PDF 全文提取', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetSharedPdfTextExtractionsForTests();
    });

    afterEach(() => resetSharedPdfTextExtractionsForTests());

    it('逐页规范文本、忽略空白页并每四页让出事件循环', async () => {
        const pages = [
            createPage([
                { str: 'Thermodynamic', hasEOL: false },
                { str: '   flux', hasEOL: true },
                { str: 'analysis', hasEOL: false },
            ]),
            createPage([{ str: '   ', hasEOL: true }]),
            createPage([{ str: 'Page three', hasEOL: false }]),
            createPage([{ str: 'Page four', hasEOL: false }]),
            createPage([{ str: 'Page five', hasEOL: false }]),
        ];
        const { getDocument, loadingTask, pdfDocument } = prepareDocument(pages);
        const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

        const result = await extractPdfText('asset://paper.pdf');

        expect(result).toEqual({
            pages: [
                { pageNumber: 1, text: 'Thermodynamic flux\nanalysis' },
                { pageNumber: 3, text: 'Page three' },
                { pageNumber: 4, text: 'Page four' },
                { pageNumber: 5, text: 'Page five' },
            ],
            pageCount: 5,
            textPageCount: 4,
            totalCharacters: 'Thermodynamic flux\nanalysisPage threePage fourPage five'.length,
            outline: [],
        });
        expect(getDocument).toHaveBeenCalledWith({
            url: 'asset://paper.pdf',
            enableXfa: true,
            wasmUrl: '/pdfjs-wasm/',
            canvasMaxAreaInBytes: 64_000_000,
        });
        expect(pdfDocument.getPage).toHaveBeenCalledTimes(5);
        pages.forEach((page) => expect(page.cleanup).toHaveBeenCalledOnce());
        expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 0);
        expect(pdfDocument.destroy).toHaveBeenCalledOnce();
        expect(loadingTask.destroy).toHaveBeenCalledOnce();
        timeoutSpy.mockRestore();
    });

    it('加载失败时仍销毁 loading task', async () => {
        const loadingTask = {
            destroy: vi.fn().mockResolvedValue(undefined),
            promise: Promise.reject(new Error('PDF 已损坏')),
        };
        mocks.loadPdfRuntime.mockResolvedValue({ getDocument: vi.fn(() => loadingTask) });

        await expect(extractPdfText('asset://broken.pdf')).rejects.toThrow('PDF 已损坏');
        expect(loadingTask.destroy).toHaveBeenCalledOnce();
    });

    it('逐页解析失败时清理当前页并销毁文档与 loading task', async () => {
        const firstPage = createPage([{ str: '第一页', hasEOL: false }]);
        const secondPage = createPage([]);
        secondPage.getTextContent.mockRejectedValue(new Error('文字层读取失败'));
        const { loadingTask, pdfDocument } = prepareDocument([firstPage, secondPage]);

        await expect(extractPdfText('asset://partial.pdf')).rejects.toThrow('文字层读取失败');
        expect(firstPage.cleanup).toHaveBeenCalledOnce();
        expect(secondPage.cleanup).toHaveBeenCalledOnce();
        expect(pdfDocument.destroy).toHaveBeenCalledOnce();
        expect(loadingTask.destroy).toHaveBeenCalledOnce();
    });

    it('提取进行中取消会立即返回 AbortError 并释放所有已创建资源', async () => {
        let finishReading;
        let notifyStarted;
        const started = new Promise((resolve) => {
            notifyStarted = resolve;
        });
        const page = createPage([]);
        page.getTextContent.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finishReading = resolve;
                    notifyStarted();
                })
        );
        const { loadingTask, pdfDocument } = prepareDocument([page]);
        const controller = new AbortController();
        const pending = extractPdfText('asset://large.pdf', { signal: controller.signal });

        await started;
        controller.abort();

        await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'PDF 全文提取已取消' });
        expect(page.cleanup).toHaveBeenCalledOnce();
        expect(pdfDocument.destroy).toHaveBeenCalledOnce();
        expect(loadingTask.destroy).toHaveBeenCalledOnce();
        finishReading({ items: [] });
    });

    it('请求开始前已取消时不会加载 PDF.js', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(extractPdfText('asset://paper.pdf', { signal: controller.signal })).rejects.toMatchObject({
            name: 'AbortError',
        });
        expect(mocks.loadPdfRuntime).not.toHaveBeenCalled();
    });

    it('资源清理失败不会覆盖成功结果', async () => {
        const page = createPage([{ str: '仍然成功', hasEOL: false }]);
        const { loadingTask, pdfDocument } = prepareDocument([page]);
        pdfDocument.destroy.mockRejectedValue(new Error('文档已销毁'));
        loadingTask.destroy.mockRejectedValue(new Error('任务已销毁'));

        await expect(extractPdfText('asset://paper.pdf')).resolves.toEqual({
            pages: [{ pageNumber: 1, text: '仍然成功' }],
            pageCount: 1,
            textPageCount: 1,
            totalCharacters: 4,
            outline: [],
        });
    });

    it('优先返回 PDF 自带书签目录并解析物理页码', async () => {
        const page = createPage([{ str: '正文', hasEOL: false }]);
        const reference = { num: 12, gen: 0 };
        prepareDocument([page], {
            getOutline: vi.fn().mockResolvedValue([{ title: 'Introduction', dest: [reference], items: [] }]),
            getPageIndex: vi.fn().mockResolvedValue(0),
        });

        await expect(extractPdfText('asset://book.pdf')).resolves.toMatchObject({
            outline: [
                {
                    title: 'Introduction',
                    pageNumber: 1,
                    endPage: 1,
                    level: 1,
                    source: 'native',
                    confidence: 1,
                },
            ],
        });
    });

    it('后台队列与阅读器对同一论文复用一次全文解析', async () => {
        const page = createPage([{ str: '共享全文', hasEOL: false }]);
        const { getDocument } = prepareDocument([page]);

        const background = extractSharedPdfText('paper-1', 'asset://paper.pdf');
        const reader = extractSharedPdfText('paper-1', 'asset://paper.pdf');

        await expect(Promise.all([background, reader])).resolves.toHaveLength(2);
        expect(getDocument).toHaveBeenCalledOnce();
        expect(page.getTextContent).toHaveBeenCalledOnce();
    });

    it('最后一个订阅者取消后立即中止共享全文解析并销毁 PDF 资源', async () => {
        let notifyStarted;
        const started = new Promise((resolve) => {
            notifyStarted = resolve;
        });
        const page = createPage([]);
        page.getTextContent.mockImplementation(
            () =>
                new Promise(() => {
                    notifyStarted();
                })
        );
        const { loadingTask, pdfDocument } = prepareDocument([page]);
        const controller = new AbortController();
        const pending = extractSharedPdfText('paper-cancel', 'asset://large.pdf', { signal: controller.signal });

        await started;
        controller.abort();

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => {
            expect(pdfDocument.destroy).toHaveBeenCalledOnce();
            expect(loadingTask.destroy).toHaveBeenCalledOnce();
        });
    });

    it('一个阅读器取消不会中止仍被另一个订阅者使用的共享解析', async () => {
        let finishReading;
        let notifyStarted;
        const started = new Promise((resolve) => {
            notifyStarted = resolve;
        });
        const page = createPage([]);
        page.getTextContent.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finishReading = resolve;
                    notifyStarted();
                })
        );
        const { getDocument } = prepareDocument([page]);
        const firstController = new AbortController();
        const secondController = new AbortController();
        const first = extractSharedPdfText('paper-shared-cancel', 'asset://shared.pdf', {
            signal: firstController.signal,
        });
        const second = extractSharedPdfText('paper-shared-cancel', 'asset://shared.pdf', {
            signal: secondController.signal,
        });

        await started;
        firstController.abort();
        await expect(first).rejects.toMatchObject({ name: 'AbortError' });
        finishReading({ items: [{ str: '仍由第二个阅读器使用', hasEOL: false }] });

        await expect(second).resolves.toMatchObject({
            pages: [{ pageNumber: 1, text: '仍由第二个阅读器使用' }],
        });
        expect(getDocument).toHaveBeenCalledOnce();
    });

    it('共享解析失败后立即释放缓存，下一次重试会重新读取文件', async () => {
        const failedTask = {
            destroy: vi.fn().mockResolvedValue(undefined),
            promise: Promise.reject(new Error('临时读取失败')),
        };
        const page = createPage([{ str: '重试成功', hasEOL: false }]);
        const pdfDocument = {
            destroy: vi.fn().mockResolvedValue(undefined),
            getPage: vi.fn().mockResolvedValue(page),
            numPages: 1,
        };
        const successfulTask = {
            destroy: vi.fn().mockResolvedValue(undefined),
            promise: Promise.resolve(pdfDocument),
        };
        const getDocument = vi.fn().mockReturnValueOnce(failedTask).mockReturnValueOnce(successfulTask);
        mocks.loadPdfRuntime.mockResolvedValue({ getDocument });

        await expect(extractSharedPdfText('paper-retry', 'asset://paper.pdf')).rejects.toThrow('临时读取失败');
        await expect(extractSharedPdfText('paper-retry', 'asset://paper.pdf')).resolves.toMatchObject({
            pages: [{ pageNumber: 1, text: '重试成功' }],
        });
        expect(getDocument).toHaveBeenCalledTimes(2);
    });
});
