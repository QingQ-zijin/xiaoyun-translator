import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    instances: [],
    renderError: null,
    loadPdfAnnotationLayerBuilder: vi.fn(),
}));

vi.mock('../pdfRuntime', () => ({
    loadPdfAnnotationLayerBuilder: mocks.loadPdfAnnotationLayerBuilder,
}));

import PdfNativeLinkLayer from './PdfNativeLinkLayer';

class MockAnnotationLayerBuilder {
    constructor(options) {
        this.options = options;
        this.div = document.createElement('div');
        this.div.className = 'annotationLayer';
        this.cancel = vi.fn();
        this.render = vi.fn(async () => {
            if (mocks.renderError) throw mocks.renderError;
            options.onAppend(this.div);
        });
        mocks.instances.push(this);
    }
}

const viewport = {
    width: 640.8,
    height: 800.2,
    scale: 1.25,
    clone: vi.fn(() => viewport),
};

beforeEach(() => {
    mocks.instances.length = 0;
    mocks.renderError = null;
    mocks.loadPdfAnnotationLayerBuilder.mockReset().mockResolvedValue(MockAnnotationLayerBuilder);
});

afterEach(() => {
    cleanup();
});

describe('PDF.js 原生链接层', () => {
    it('使用禁用表单和脚本的 AnnotationLayerBuilder，并同步页面尺寸', async () => {
        const pdfPage = { getAnnotations: vi.fn() };
        const linkService = { goToDestination: vi.fn() };
        const annotationStorage = {};
        const optionalContentConfigPromise = Promise.resolve(null);
        const onReady = vi.fn();
        const { container } = render(
            <PdfNativeLinkLayer
                pdfPage={pdfPage}
                viewport={viewport}
                linkService={linkService}
                annotationStorage={annotationStorage}
                optionalContentConfigPromise={optionalContentConfigPromise}
                onReady={onReady}
            />
        );

        await waitFor(() => expect(mocks.instances).toHaveLength(1));
        const builder = mocks.instances[0];
        expect(builder.options).toMatchObject({
            pdfPage,
            linkService,
            annotationStorage,
            renderForms: false,
            enableScripting: false,
        });
        expect(builder.render).toHaveBeenCalledWith({ viewport, optionalContentConfigPromise });

        const host = container.querySelector('[data-pdf-native-link-layer]');
        const layer = host.querySelector('.annotationLayer');
        expect(layer).toBe(builder.div);
        expect(host.style.getPropertyValue('--total-scale-factor')).toBe('1.25');
        expect(host.style.width).toBe('640px');
        expect(host.style.height).toBe('800px');
        expect(layer.style.width).toBe('640px');
        expect(layer.style.height).toBe('800px');
        expect(onReady).toHaveBeenCalledWith(layer);
    });

    it('切换页面和卸载时取消旧 builder 并移除旧链接命中区', async () => {
        const firstPage = { id: 'first' };
        const secondPage = { id: 'second' };
        const linkService = {};
        const { container, rerender, unmount } = render(
            <PdfNativeLinkLayer
                pdfPage={firstPage}
                viewport={viewport}
                linkService={linkService}
            />
        );
        await waitFor(() => expect(mocks.instances).toHaveLength(1));
        const firstBuilder = mocks.instances[0];

        rerender(
            <PdfNativeLinkLayer
                pdfPage={secondPage}
                viewport={viewport}
                linkService={linkService}
            />
        );
        await waitFor(() => expect(mocks.instances).toHaveLength(2));
        expect(firstBuilder.cancel).toHaveBeenCalledOnce();
        expect(container.querySelectorAll('.annotationLayer')).toHaveLength(1);

        const secondBuilder = mocks.instances[1];
        unmount();
        expect(secondBuilder.cancel).toHaveBeenCalledOnce();
        expect(container.querySelector('.annotationLayer')).toBeNull();
    });

    it('渲染失败时交给调用方处理，且不会留下半成品链接层', async () => {
        const onRenderError = vi.fn();
        mocks.renderError = new Error('broken annotations');
        const { container } = render(
            <PdfNativeLinkLayer
                pdfPage={{}}
                viewport={viewport}
                linkService={{}}
                onRenderError={onRenderError}
            />
        );

        await waitFor(() =>
            expect(onRenderError).toHaveBeenCalledWith(expect.objectContaining({ message: 'broken annotations' }))
        );
        expect(container.querySelector('.annotationLayer')).toBeNull();
    });
});
