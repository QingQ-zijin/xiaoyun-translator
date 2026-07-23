import { describe, expect, it } from 'vitest';

import { createPdfDocumentOptions, PDFJS_CANVAS_MAX_AREA_IN_BYTES, PDFJS_WASM_URL } from './pdfRuntime';

describe('PDF.js 运行配置', () => {
    it('为所有文档入口启用固定 WASM 路径并保留画布预算', () => {
        const options = createPdfDocumentOptions('asset://scanned-book.pdf');

        expect(options).toEqual({
            url: 'asset://scanned-book.pdf',
            enableXfa: true,
            wasmUrl: PDFJS_WASM_URL,
            canvasMaxAreaInBytes: PDFJS_CANVAS_MAX_AREA_IN_BYTES,
        });
        expect(PDFJS_WASM_URL).toBe('/pdfjs-wasm/');
        expect(options).not.toHaveProperty('maxImageSize');
    });
});
