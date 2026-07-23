import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    extractSharedPdfText: vi.fn(),
    generatePaperInsights: vi.fn(),
    getDocument: vi.fn(),
    getPaperInsights: vi.fn(),
    getPdfSource: vi.fn(),
    indexDocumentPages: vi.fn(),
    isTauriRuntime: vi.fn(() => true),
    isTranslationActive: vi.fn(() => false),
    markDocumentTextIndexComplete: vi.fn(),
    replaceDocumentOutline: vi.fn(),
    syncPaperReferences: vi.fn(),
    updateDocumentPageCount: vi.fn(),
}));

vi.mock('../../domains/research/bridge', () => ({
    generatePaperInsights: mocks.generatePaperInsights,
    getDocument: mocks.getDocument,
    getPaperInsights: mocks.getPaperInsights,
    getPdfSource: mocks.getPdfSource,
    indexDocumentPages: mocks.indexDocumentPages,
    isTauriRuntime: mocks.isTauriRuntime,
    isTranslationActive: mocks.isTranslationActive,
    markDocumentTextIndexComplete: mocks.markDocumentTextIndexComplete,
    replaceDocumentOutline: mocks.replaceDocumentOutline,
    syncPaperReferences: mocks.syncPaperReferences,
    updateDocumentPageCount: mocks.updateDocumentPageCount,
}));
vi.mock('./pdfTextExtraction', () => ({ extractSharedPdfText: mocks.extractSharedPdfText }));

import {
    enqueueImportedPaperInsights,
    enqueueImportedPapersInsights,
    enqueuePreparedPaperInsights,
    resetPaperInsightsQueueForTests,
} from './paperInsightsQueue';

describe('导入后论文概要队列', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetPaperInsightsQueueForTests();
        mocks.getPaperInsights.mockResolvedValue({ status: 'not_started', payload: { summary: '' } });
        mocks.isTranslationActive.mockResolvedValue(false);
        mocks.generatePaperInsights.mockImplementation(async (paperId) => ({
            paperId,
            status: 'ready',
            payload: { summary: `${paperId} 概要` },
        }));
        mocks.getPdfSource.mockReturnValue('asset://paper.pdf');
        mocks.indexDocumentPages.mockResolvedValue(1);
        mocks.markDocumentTextIndexComplete.mockResolvedValue(undefined);
        mocks.replaceDocumentOutline.mockResolvedValue([]);
        mocks.syncPaperReferences.mockResolvedValue({ outbound: [], inbound: [] });
        mocks.updateDocumentPageCount.mockResolvedValue(undefined);
    });

    afterEach(() => vi.useRealTimers());

    it('PDF 导入后无渲染提取全文、建立索引并使用非强制模式生成', async () => {
        mocks.getDocument.mockResolvedValue({ documentType: 'pdf', textContent: '' });
        mocks.extractSharedPdfText.mockResolvedValue({
            pages: [{ pageNumber: 1, text: 'metabolic flux' }],
            pageCount: 3,
            textPageCount: 1,
            totalCharacters: 14,
            outline: [
                {
                    title: 'INTRODUCTION',
                    pageNumber: 1,
                    endPage: 3,
                    level: 1,
                    source: 'text',
                    confidence: 0.72,
                },
            ],
        });

        await expect(enqueueImportedPaperInsights('paper-1')).resolves.toMatchObject({ status: 'ready' });

        expect(mocks.extractSharedPdfText).toHaveBeenCalledWith('paper-1', 'asset://paper.pdf');
        expect(mocks.updateDocumentPageCount).toHaveBeenCalledWith('paper-1', 3);
        expect(mocks.indexDocumentPages).toHaveBeenCalledWith('paper-1', [{ pageNumber: 1, text: 'metabolic flux' }]);
        expect(mocks.replaceDocumentOutline).toHaveBeenCalledWith('paper-1', [
            expect.objectContaining({ title: 'INTRODUCTION', pageNumber: 1, endPage: 3 }),
        ]);
        expect(mocks.syncPaperReferences).toHaveBeenCalledWith('paper-1', [{ pageNumber: 1, text: 'metabolic flux' }]);
        expect(mocks.markDocumentTextIndexComplete).toHaveBeenCalledWith('paper-1', 3);
        expect(mocks.generatePaperInsights).toHaveBeenCalledWith('paper-1', { force: false });
    });

    it('Markdown、DOCX 与 TeX 正文直接索引后生成，不加载 PDF.js', async () => {
        mocks.getDocument.mockResolvedValue({ documentType: 'markdown', textContent: '# 结果\n\n代谢通量增加。' });

        await enqueueImportedPaperInsights('paper-text');

        expect(mocks.indexDocumentPages).toHaveBeenCalledWith('paper-text', [
            { pageNumber: 1, text: '# 结果\n\n代谢通量增加。' },
        ]);
        expect(mocks.extractSharedPdfText).not.toHaveBeenCalled();
        expect(mocks.generatePaperInsights).toHaveBeenCalledWith('paper-text', { force: false });
    });

    it('已经保存的 ready 概要直接复用，不再提取、索引或调用模型', async () => {
        const cached = { status: 'ready', payload: { summary: '已保存概要' }, cached: true };
        mocks.getPaperInsights.mockResolvedValue(cached);

        await expect(enqueueImportedPaperInsights('paper-cached')).resolves.toBe(cached);

        expect(mocks.getDocument).not.toHaveBeenCalled();
        expect(mocks.extractSharedPdfText).not.toHaveBeenCalled();
        expect(mocks.indexDocumentPages).not.toHaveBeenCalled();
        expect(mocks.generatePaperInsights).not.toHaveBeenCalled();
    });

    it('书籍导入时只建立全文索引和目录，章节概要留到阅读时按需生成', async () => {
        mocks.getDocument.mockResolvedValue({
            paper: { id: 'book-1', contentKind: 'book' },
            documentType: 'pdf',
            textContent: '',
        });
        mocks.extractSharedPdfText.mockResolvedValue({
            pages: [
                { pageNumber: 1, text: 'CONTENTS' },
                { pageNumber: 11, text: '1.0 Introduction' },
            ],
            pageCount: 505,
            textPageCount: 505,
            totalCharacters: 32,
            outline: [
                {
                    title: '1.0 Introduction',
                    pageNumber: 11,
                    endPage: 22,
                    level: 1,
                    source: 'contents',
                    confidence: 0.98,
                },
            ],
        });

        const [{ promise }] = enqueueImportedPapersInsights([
            { id: 'book-1', title: 'Nonlinear Dynamics and Chaos', contentKind: 'book' },
        ]);
        await expect(promise).resolves.toMatchObject({ status: 'not_started' });

        expect(mocks.extractSharedPdfText).toHaveBeenCalledWith('book-1', 'asset://paper.pdf');
        expect(mocks.indexDocumentPages).toHaveBeenCalledWith('book-1', [
            { pageNumber: 1, text: 'CONTENTS' },
            { pageNumber: 11, text: '1.0 Introduction' },
        ]);
        expect(mocks.replaceDocumentOutline).toHaveBeenCalledWith('book-1', [
            expect.objectContaining({ title: '1.0 Introduction', pageNumber: 11, endPage: 22 }),
        ]);
        expect(mocks.markDocumentTextIndexComplete).toHaveBeenCalledWith('book-1', 505);
        expect(mocks.generatePaperInsights).not.toHaveBeenCalled();
    });

    it('OCR 完成后绕过 ready 短路并让后端按最新正文哈希重校验概要', async () => {
        const cached = { status: 'ready', payload: { summary: 'OCR 前概要' }, cached: true };
        const refreshed = { status: 'ready', payload: { summary: 'OCR 后概要' }, cached: false };
        mocks.getPaperInsights.mockResolvedValue(cached);
        mocks.generatePaperInsights.mockResolvedValue(refreshed);

        await expect(enqueueImportedPaperInsights('paper-ocr-completed', { revalidate: true })).resolves.toBe(
            refreshed
        );

        expect(mocks.getDocument).not.toHaveBeenCalled();
        expect(mocks.extractSharedPdfText).not.toHaveBeenCalled();
        expect(mocks.indexDocumentPages).not.toHaveBeenCalled();
        expect(mocks.generatePaperInsights).toHaveBeenCalledWith('paper-ocr-completed', { force: false });
    });

    it('同一论文重复入队复用同一个 Promise 和同一次生成', async () => {
        let finish;
        mocks.getDocument.mockReturnValue(new Promise((resolve) => (finish = resolve)));

        const first = enqueueImportedPaperInsights('paper-deduplicated');
        const second = enqueueImportedPaperInsights('paper-deduplicated');
        expect(second).toBe(first);

        finish({ documentType: 'markdown', textContent: '正文' });
        await first;
        expect(mocks.generatePaperInsights).toHaveBeenCalledTimes(1);
    });

    it('批量导入按单并发顺序处理，前项失败也不阻塞后项', async () => {
        const order = [];
        mocks.getDocument.mockImplementation(async (paperId) => {
            order.push(`start:${paperId}`);
            if (paperId === 'paper-a') throw new Error('损坏文档');
            return { documentType: 'markdown', textContent: `正文 ${paperId}` };
        });

        const jobs = enqueueImportedPapersInsights([{ id: 'paper-a' }, { id: 'paper-b' }]);
        await expect(jobs[0].promise).rejects.toThrow('损坏文档');
        await expect(jobs[1].promise).resolves.toMatchObject({ paperId: 'paper-b' });
        expect(order).toEqual(['start:paper-a', 'start:paper-b']);
    });

    it('前一篇模型尚未完成时不会开始处理后一篇', async () => {
        let finishFirst;
        const firstGeneration = new Promise((resolve) => {
            finishFirst = resolve;
        });
        mocks.getDocument.mockImplementation(async (paperId) => ({
            documentType: 'markdown',
            textContent: `正文 ${paperId}`,
        }));
        mocks.generatePaperInsights.mockImplementation((paperId) => {
            if (paperId === 'paper-a') return firstGeneration;
            return Promise.resolve({ paperId, status: 'ready', payload: { summary: '第二篇概要' } });
        });

        const jobs = enqueueImportedPapersInsights([{ id: 'paper-a' }, { id: 'paper-b' }]);
        await vi.waitFor(() => expect(mocks.generatePaperInsights).toHaveBeenCalledWith('paper-a', { force: false }));
        expect(mocks.getDocument).not.toHaveBeenCalledWith('paper-b');

        finishFirst({ paperId: 'paper-a', status: 'ready', payload: { summary: '第一篇概要' } });
        await Promise.all(jobs.map((job) => job.promise));
        expect(mocks.getDocument).toHaveBeenCalledWith('paper-b');
    });

    it('被划词翻译抢占后保持低优先级并自动重试', async () => {
        vi.useFakeTimers();
        mocks.getDocument.mockResolvedValue({ documentType: 'markdown', textContent: '正文' });
        mocks.getPaperInsights
            .mockResolvedValueOnce({ status: 'not_started', payload: { summary: '' } })
            .mockResolvedValueOnce({ status: 'not_started', payload: { summary: '' } })
            .mockResolvedValueOnce({ status: 'paused', payload: { summary: '' } })
            .mockResolvedValue({ status: 'not_started', payload: { summary: '' } });
        mocks.generatePaperInsights
            .mockRejectedValueOnce(new Error('任意本地化错误文本'))
            .mockResolvedValueOnce({ paperId: 'paper-retry', status: 'ready', payload: { summary: '重试成功' } });

        const pending = enqueueImportedPaperInsights('paper-retry');
        await vi.runAllTimersAsync();
        await expect(pending).resolves.toMatchObject({ status: 'ready' });
        expect(mocks.generatePaperInsights).toHaveBeenCalledTimes(2);
    });

    it('前台翻译持续活跃时只轮转任务，不会重启研究模型', async () => {
        vi.useFakeTimers();
        mocks.getDocument.mockResolvedValue({ documentType: 'markdown', textContent: '正文' });
        mocks.isTranslationActive
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValue(false);

        const pending = enqueueImportedPaperInsights('paper-long-translation');
        await vi.runAllTimersAsync();
        await expect(pending).resolves.toMatchObject({ status: 'ready' });
        expect(mocks.isTranslationActive).toHaveBeenCalledTimes(4);
        expect(mocks.generatePaperInsights).toHaveBeenCalledOnce();
    });

    it('连续翻译期间多篇论文轮转准备，后续论文不会被第一篇饿死', async () => {
        vi.useFakeTimers();
        const order = [];
        mocks.getDocument.mockImplementation(async (paperId) => {
            order.push(`prepare:${paperId}`);
            return { documentType: 'markdown', textContent: `正文 ${paperId}` };
        });
        mocks.isTranslationActive.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
        mocks.generatePaperInsights.mockImplementation(async (paperId) => {
            order.push(`generate:${paperId}`);
            return { paperId, status: 'ready', payload: { summary: `${paperId} 概要` } };
        });

        const jobs = enqueueImportedPapersInsights([{ id: 'paper-a' }, { id: 'paper-b' }]);
        await vi.runAllTimersAsync();
        await Promise.all(jobs.map((job) => job.promise));

        expect(order.indexOf('prepare:paper-b')).toBeLessThan(order.indexOf('generate:paper-a'));
        expect(mocks.generatePaperInsights).toHaveBeenCalledTimes(2);
    });

    it('第二篇已由阅读器准备全文时升级队列状态且只索引一次', async () => {
        let finishFirst;
        const firstGeneration = new Promise((resolve) => {
            finishFirst = resolve;
        });
        mocks.getDocument.mockImplementation(async (paperId) => ({
            documentType: 'markdown',
            textContent: `后台正文 ${paperId}`,
        }));
        mocks.generatePaperInsights.mockImplementation((paperId) => {
            if (paperId === 'paper-a') return firstGeneration;
            return Promise.resolve({ paperId, status: 'ready', payload: { summary: '第二篇概要' } });
        });

        const first = enqueueImportedPaperInsights('paper-a');
        const queuedSecond = enqueueImportedPaperInsights('paper-b');
        const preparedSecond = enqueuePreparedPaperInsights('paper-b', {
            pageCount: 2,
            pages: [{ pageNumber: 1, text: '阅读器已提取的正文' }],
        });
        expect(preparedSecond).toBe(queuedSecond);
        await vi.waitFor(() =>
            expect(mocks.indexDocumentPages).toHaveBeenCalledWith('paper-b', [
                { pageNumber: 1, text: '阅读器已提取的正文' },
            ])
        );

        finishFirst({ paperId: 'paper-a', status: 'ready', payload: { summary: '第一篇概要' } });
        await Promise.all([first, queuedSecond]);
        expect(mocks.getDocument).not.toHaveBeenCalledWith('paper-b');
        expect(mocks.indexDocumentPages.mock.calls.filter(([paperId]) => paperId === 'paper-b')).toHaveLength(1);
        expect(mocks.markDocumentTextIndexComplete).toHaveBeenCalledWith('paper-b', 2);
    });
});
