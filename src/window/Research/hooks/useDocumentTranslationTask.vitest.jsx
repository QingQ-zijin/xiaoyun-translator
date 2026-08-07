import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    clearDocumentTranslation: vi.fn(),
    getIndexedDocumentPages: vi.fn(),
    indexDocumentPages: vi.fn(),
    listDocumentTranslationPages: vi.fn(),
    saveDocumentTranslationPage: vi.fn(),
    translateSelection: vi.fn(),
    extractSharedPdfText: vi.fn(),
}));

vi.mock('../../../domains/research/bridge', () => ({
    clearDocumentTranslation: mocks.clearDocumentTranslation,
    getIndexedDocumentPages: mocks.getIndexedDocumentPages,
    getPdfSource: () => 'asset://paper.pdf',
    indexDocumentPages: mocks.indexDocumentPages,
    listDocumentTranslationPages: mocks.listDocumentTranslationPages,
    saveDocumentTranslationPage: mocks.saveDocumentTranslationPage,
    translateSelection: mocks.translateSelection,
}));

vi.mock('../pdfTextExtraction', () => ({
    extractSharedPdfText: mocks.extractSharedPdfText,
}));

import { useDocumentTranslationTask } from './useDocumentTranslationTask';

const document = {
    documentType: 'pdf',
    paper: { id: 'paper-full', title: 'Full Translation', pageCount: 2 },
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getIndexedDocumentPages.mockResolvedValue([
        { pageNumber: 1, text: 'page one source' },
        { pageNumber: 2, text: 'page two source' },
    ]);
    mocks.extractSharedPdfText.mockResolvedValue({
        pages: [
            { pageNumber: 1, text: 'page one source' },
            { pageNumber: 2, text: 'page two source' },
        ],
    });
    mocks.listDocumentTranslationPages.mockResolvedValue([
        {
            paperId: 'paper-full',
            targetLanguage: 'zh_cn',
            pageNumber: 1,
            sourceText: 'page one source',
            translation: '第一页译文',
        },
    ]);
    mocks.translateSelection.mockImplementation(async ({ selection, onDelta }) => {
        const translated = `译文：${selection.quote}`;
        onDelta?.(translated);
        return translated;
    });
    mocks.saveDocumentTranslationPage.mockImplementation(async (page) => ({
        ...page,
        createdAt: 'now',
        updatedAt: 'now',
    }));
    mocks.clearDocumentTranslation.mockResolvedValue(2);
});

afterEach(cleanup);

describe('全文翻译持久任务', () => {
    it('复用已保存页面，仅翻译缺失页，并在每页完成后立即持久化', async () => {
        const onNotice = vi.fn();
        const { result } = renderHook(() =>
            useDocumentTranslationTask({
                document,
                paperInsights: { summary: '领域上下文', terms: [{ term: 'flux', translation: '通量' }] },
                translationModel: 'gemma4:e4b',
                onNotice,
            })
        );

        act(() => result.current.show());
        await act(async () => result.current.start());

        await waitFor(() => expect(result.current.task.status).toBe('complete'));
        expect(result.current.task.completedPages).toBe(2);
        expect(mocks.translateSelection).toHaveBeenCalledOnce();
        expect(mocks.translateSelection.mock.calls[0][0].selection.quote).toBe('page two source');
        expect(mocks.saveDocumentTranslationPage).toHaveBeenCalledWith(
            expect.objectContaining({
                paperId: 'paper-full',
                pageNumber: 2,
                sourceText: 'page two source',
                translation: '译文：page two source',
                model: 'gemma4:e4b',
            })
        );
        expect(onNotice).toHaveBeenCalledWith('全文翻译完成，可以导出完整 PDF');
    });

    it('清除当前语言的断点译文后回到空闲状态', async () => {
        const { result } = renderHook(() =>
            useDocumentTranslationTask({ document, paperInsights: {}, translationModel: 'gemma4:e4b' })
        );

        await act(async () => result.current.reset());

        expect(mocks.clearDocumentTranslation).toHaveBeenCalledWith('paper-full', 'zh_cn');
        expect(result.current.task.status).toBe('idle');
        expect(result.current.task.paperId).toBe('paper-full');
    });
});
