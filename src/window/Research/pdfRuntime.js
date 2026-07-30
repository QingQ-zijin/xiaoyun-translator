let runtimePromise;
let textLayerBuilderPromise;
let annotationLayerBuilderPromise;

export const PDFJS_WASM_URL = '/pdfjs-wasm/';
export const PDFJS_CANVAS_MAX_AREA_IN_BYTES = 16_000_000 * 4;

/**
 * 所有 PDF.js 文档入口共用同一组运行参数，确保数字 PDF 与扫描 PDF 的解码能力一致。
 */
export function createPdfDocumentOptions(source) {
    return {
        url: source,
        enableXfa: true,
        wasmUrl: PDFJS_WASM_URL,
        canvasMaxAreaInBytes: PDFJS_CANVAS_MAX_AREA_IN_BYTES,
    };
}

export function loadPdfRuntime() {
    if (!runtimePromise) {
        runtimePromise = Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(
            ([pdfjs, workerModule]) => {
                pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;
                return pdfjs;
            }
        );
    }
    return runtimePromise;
}

export function loadPdfTextLayerBuilder() {
    if (!textLayerBuilderPromise) {
        textLayerBuilderPromise = import('pdfjs-dist/web/pdf_viewer.mjs').then(
            ({ TextLayerBuilder }) => TextLayerBuilder
        );
    }
    return textLayerBuilderPromise;
}

export function loadPdfAnnotationLayerBuilder() {
    if (!annotationLayerBuilderPromise) {
        annotationLayerBuilderPromise = import('pdfjs-dist/web/pdf_viewer.mjs').then(
            ({ AnnotationLayerBuilder }) => AnnotationLayerBuilder
        );
    }
    return annotationLayerBuilderPromise;
}
