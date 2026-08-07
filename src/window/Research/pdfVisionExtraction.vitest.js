import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pdfMocks = vi.hoisted(() => ({
    destroyDocument: vi.fn(),
    destroyLoading: vi.fn(),
    cleanupPage: vi.fn(),
}));

vi.mock('./pdfRuntime', () => ({
    createPdfDocumentOptions: (source) => ({ url: source }),
    loadPdfRuntime: vi.fn(async () => ({
        getDocument: () => ({
            destroy: pdfMocks.destroyLoading,
            promise: Promise.resolve({
                numPages: 3,
                destroy: pdfMocks.destroyDocument,
                getPage: async () => ({
                    cleanup: pdfMocks.cleanupPage,
                    getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
                    render: () => ({ promise: Promise.resolve() }),
                }),
            }),
        }),
    })),
}));

import { extractPdfPagesWithVision } from './pdfVisionExtraction';

let originalGetContext;
let originalToDataUrl;

beforeEach(() => {
    vi.clearAllMocks();
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    originalToDataUrl = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({}));
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/jpeg;base64,page');
});

afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toDataURL = originalToDataUrl;
});

describe('扫描 PDF 多模态文字提取', () => {
    it('只识别指定缺失页，并在每页完成时立即交给持久化回调', async () => {
        const recognize = vi.fn(async ({ image }) => `识别结果 ${image}`);
        const onPage = vi.fn();
        const onProgress = vi.fn();

        const result = await extractPdfPagesWithVision('asset://scan.pdf', {
            pageNumbers: [3, 1, 3],
            recognize,
            onPage,
            onProgress,
        });

        expect(result.pages.map((page) => page.pageNumber)).toEqual([1, 3]);
        expect(recognize).toHaveBeenCalledTimes(2);
        expect(onPage).toHaveBeenCalledTimes(2);
        expect(onProgress).toHaveBeenLastCalledWith({ completed: 2, total: 2, pageNumber: 3 });
        expect(pdfMocks.destroyDocument).toHaveBeenCalledOnce();
        expect(pdfMocks.destroyLoading).toHaveBeenCalledOnce();
    });
});
