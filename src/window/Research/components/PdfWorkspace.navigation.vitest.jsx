import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => {
    const page = {
        getViewport: ({ scale }) => ({ width: 650 * scale, height: 792 * scale }),
        getTextContent: vi.fn().mockResolvedValue({ items: [{ str: 'page text', hasEOL: false }] }),
        render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
        cleanup: vi.fn(),
    };
    const document = {
        numPages: 30,
        annotationStorage: {},
        getPage: vi.fn().mockResolvedValue(page),
        getOptionalContentConfig: vi.fn().mockResolvedValue({}),
    };
    class TextLayerBuilder {
        constructor() {
            this.div = globalThis.document.createElement('div');
            this.div.className = 'textLayer';
        }
        render() {
            return Promise.resolve();
        }
        cancel() {}
    }
    class AnnotationLayerBuilder {
        constructor({ pdfPage }) {
            this.pdfPage = pdfPage;
            this.div = globalThis.document.createElement('div');
            this.div.className = 'annotationLayer';
        }
        render() {
            return Promise.resolve();
        }
        cancel() {}
    }
    return { page, document, TextLayerBuilder, AnnotationLayerBuilder };
});

vi.mock('../pdfRuntime', () => ({
    createPdfDocumentOptions: (source) => ({ url: source }),
    loadPdfRuntime: vi.fn().mockResolvedValue({
        getDocument: () => ({ promise: Promise.resolve(runtimeMocks.document), destroy: vi.fn() }),
    }),
    loadPdfTextLayerBuilder: vi.fn().mockResolvedValue(runtimeMocks.TextLayerBuilder),
    loadPdfAnnotationLayerBuilder: vi.fn().mockResolvedValue(runtimeMocks.AnnotationLayerBuilder),
}));

vi.mock('../pdfOutline', () => ({
    deriveOutlineFromPages: () => [],
    extractNativePdfOutline: vi.fn().mockResolvedValue([]),
}));

vi.mock('../pdfTextExtraction', () => ({
    extractSharedPdfText: vi.fn().mockResolvedValue({ pages: [], pageCount: 30, textPageCount: 0, totalCharacters: 0 }),
}));

import PdfWorkspace from './PdfWorkspace';

let observerCallback;

beforeEach(() => {
    observerCallback = null;
    globalThis.IntersectionObserver = class IntersectionObserver {
        constructor(callback) {
            observerCallback = callback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({});
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete globalThis.IntersectionObserver;
});

describe('PDF 稳定跳页', () => {
    it('远距离跳页瞬时定位，observer 的沿途页不会反写当前页', async () => {
        const ref = { current: null };
        const onPageChange = vi.fn();
        const { container } = render(
            <PdfWorkspace
                ref={ref}
                source='mock.pdf'
                document={{ paper: { id: 'long-book' }, pageCount: 30, textIndexComplete: true }}
                currentPage={1}
                scale={1.25}
                onPageChange={onPageChange}
            />
        );

        await waitFor(() => expect(container.querySelectorAll('.pdf-page')).toHaveLength(30));
        await waitFor(() => expect(observerCallback).toBeTypeOf('function'));
        const workspace = container.querySelector('.pdf-workspace');
        const page20 = container.querySelector('[data-page-number="20"]');
        const page2 = container.querySelector('[data-page-number="2"]');
        const page3 = container.querySelector('[data-page-number="3"]');
        Object.defineProperties(workspace, {
            clientHeight: { configurable: true, value: 700 },
            clientWidth: { configurable: true, value: 900 },
            scrollHeight: { configurable: true, value: 30_000 },
            scrollWidth: { configurable: true, value: 1_200 },
            scrollTop: { configurable: true, writable: true, value: 0 },
            scrollLeft: { configurable: true, writable: true, value: 0 },
        });
        workspace.getBoundingClientRect = () => ({ left: 0, top: 0, right: 900, bottom: 700, width: 900, height: 700 });
        page20.getBoundingClientRect = () => ({
            left: 125,
            top: 19_000,
            right: 775,
            bottom: 19_792,
            width: 650,
            height: 792,
        });
        workspace.scrollTo = vi.fn(({ top, left }) => {
            workspace.scrollTop = top;
            workspace.scrollLeft = left;
        });

        act(() => ref.current.goToPage(20));
        expect(onPageChange).toHaveBeenCalledTimes(1);
        expect(onPageChange).toHaveBeenLastCalledWith(20);
        expect(workspace.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 18_986, behavior: 'auto' }));

        act(() => {
            observerCallback([
                { target: page2, isIntersecting: true, intersectionRatio: 0.75 },
                { target: page3, isIntersecting: true, intersectionRatio: 0.9 },
            ]);
        });
        expect(onPageChange).toHaveBeenCalledTimes(1);
        expect(onPageChange).toHaveBeenLastCalledWith(20);
        expect(page20.classList.contains('is-rendered')).toBe(true);
    });
});
