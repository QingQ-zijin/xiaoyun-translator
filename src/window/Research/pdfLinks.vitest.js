import { describe, expect, it, vi } from 'vitest';

import {
    createPdfLinkService,
    getPdfDestinationPosition,
    normalizePdfExternalUrl,
    resolvePdfDestination,
} from './pdfLinks';

function mockPage(width = 600, height = 800) {
    return {
        getViewport: vi.fn(() => ({
            width,
            height,
            rawDims: { pageWidth: width, pageHeight: height },
            convertToViewportPoint: (x, y) => [x, height - y],
        })),
    };
}

describe('PDF 原生 destination 解析', () => {
    it('解析 named destination 和对象页引用', async () => {
        const reference = { num: 113, gen: 0 };
        const explicitDestination = [reference, { name: 'FitR' }, 39, 187, 290, 177];
        const pdfDocument = {
            numPages: 13,
            getDestination: vi.fn(async () => explicitDestination),
            cachedPageNumber: vi.fn(() => null),
            getPageIndex: vi.fn(async () => 12),
        };

        await expect(resolvePdfDestination(pdfDocument, 'lbib10')).resolves.toEqual({
            pageNumber: 13,
            explicitDestination,
        });
        expect(pdfDocument.getDestination).toHaveBeenCalledWith('lbib10');
        expect(pdfDocument.getPageIndex).toHaveBeenCalledWith(reference);
    });

    it('支持整数页引用、缓存页码，并拒绝损坏或越界的 destination', async () => {
        await expect(resolvePdfDestination({ numPages: 8 }, [3, { name: 'Fit' }])).resolves.toMatchObject({
            pageNumber: 4,
        });

        const reference = { num: 8, gen: 0 };
        await expect(
            resolvePdfDestination(
                {
                    numPages: 8,
                    cachedPageNumber: () => 6,
                    getPageIndex: vi.fn(),
                },
                [reference, { name: 'Fit' }]
            )
        ).resolves.toMatchObject({ pageNumber: 6 });

        await expect(resolvePdfDestination({ numPages: 2 }, [5, { name: 'Fit' }])).resolves.toBeNull();
        await expect(resolvePdfDestination({ numPages: 2 }, 'missing')).resolves.toBeNull();
        await expect(resolvePdfDestination(null, [0, { name: 'Fit' }])).resolves.toBeNull();
    });

    it('把 XYZ、FitH 和 FitR 坐标转换为页面内相对位置', () => {
        const page = mockPage();
        expect(getPdfDestinationPosition(page, [0, { name: 'XYZ' }, 120, 600, null])).toEqual({
            destinationType: 'XYZ',
            leftRatio: 0.2,
            topRatio: 0.25,
        });
        expect(getPdfDestinationPosition(page, [0, { name: 'FitH' }, 400])).toEqual({
            destinationType: 'FitH',
            leftRatio: 0,
            topRatio: 0.5,
        });
        expect(getPdfDestinationPosition(page, [0, { name: 'FitR' }, 60, 200, 300, 400])).toEqual({
            destinationType: 'FitR',
            leftRatio: 0.1,
            topRatio: 0.5,
        });
    });
});

describe('PDF 外链安全策略', () => {
    it.each([
        ['https://example.com/paper?q=1', 'https://example.com/paper?q=1'],
        ['http://example.com', 'http://example.com/'],
        ['mailto:author@example.com', 'mailto:author@example.com'],
    ])('允许 %s', (input, expected) => {
        expect(normalizePdfExternalUrl(input)).toBe(expected);
    });

    it.each(['javascript:alert(1)', 'file:///C:/secret.txt', 'data:text/html,test', '/relative', 'https://'])(
        '拒绝不安全或无效地址 %s',
        (input) => {
            expect(normalizePdfExternalUrl(input)).toBe('');
        }
    );

    it('只给安全 URI 绑定受控打开回调', async () => {
        const onExternalUrl = vi.fn(async () => {});
        const service = createPdfLinkService({ onExternalUrl });
        const safeLink = document.createElement('a');
        const unsafeLink = document.createElement('a');

        service.addLinkAttributes(safeLink, 'https://example.com/article');
        expect(safeLink.target).toBe('_blank');
        expect(safeLink.rel).toContain('noopener');
        expect(safeLink.onclick({ preventDefault: vi.fn(), stopPropagation: vi.fn() })).toBe(false);
        await Promise.resolve();
        expect(onExternalUrl).toHaveBeenCalledWith('https://example.com/article');

        service.addLinkAttributes(unsafeLink, 'javascript:alert(1)');
        expect(unsafeLink.hasAttribute('href')).toBe(false);
        expect(unsafeLink.getAttribute('aria-disabled')).toBe('true');
    });
});

describe('PDF link service 调度', () => {
    it('解析目标页与精确位置后通知阅读器', async () => {
        const page = mockPage();
        const onDestination = vi.fn();
        const pdfDocument = {
            numPages: 13,
            getDestination: vi.fn(async () => [{ num: 113, gen: 0 }, { name: 'FitH' }, 600]),
            getPageIndex: vi.fn(async () => 12),
            getPage: vi.fn(async () => page),
        };
        const service = createPdfLinkService({ pdfDocument, onDestination });

        await expect(service.goToDestination('lbib10')).resolves.toMatchObject({
            pageNumber: 13,
            destinationType: 'FitH',
            topRatio: 0.25,
        });
        expect(onDestination).toHaveBeenCalledWith(expect.objectContaining({ pageNumber: 13, topRatio: 0.25 }));
    });

    it('连续点击时只提交最后一次异步 destination', async () => {
        let resolveFirst;
        const firstDestination = new Promise((resolve) => {
            resolveFirst = resolve;
        });
        const onDestination = vi.fn();
        const pdfDocument = {
            numPages: 4,
            getDestination: vi.fn((name) =>
                name === 'slow' ? firstDestination : Promise.resolve([2, { name: 'Fit' }])
            ),
            getPage: vi.fn(async () => mockPage()),
        };
        const service = createPdfLinkService({ pdfDocument, onDestination });

        const first = service.goToDestination('slow');
        const second = service.goToDestination('fast');
        resolveFirst([0, { name: 'Fit' }]);

        await expect(second).resolves.toMatchObject({ pageNumber: 3 });
        await expect(first).resolves.toBeNull();
        expect(onDestination).toHaveBeenCalledTimes(1);
        expect(onDestination).toHaveBeenCalledWith(expect.objectContaining({ pageNumber: 3 }));
    });

    it('只转发受支持的 NamedAction，并把解析错误交给错误回调', async () => {
        const onNamedAction = vi.fn();
        const onError = vi.fn();
        const service = createPdfLinkService({
            pdfDocument: {
                numPages: 1,
                getDestination: vi.fn(async () => {
                    throw new Error('broken destination');
                }),
            },
            onNamedAction,
            onError,
        });

        expect(service.executeNamedAction('NextPage')).toBe(true);
        expect(service.executeNamedAction('Print')).toBe(false);
        expect(onNamedAction).toHaveBeenCalledOnce();
        await expect(service.goToDestination('broken')).resolves.toBeNull();
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'broken destination' }));
    });
});
