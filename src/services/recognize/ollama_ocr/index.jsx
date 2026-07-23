import {
    buildOllamaOcrRequest,
    DEFAULT_OLLAMA_OCR_HOST,
    DEFAULT_OLLAMA_OCR_MODE,
    DEFAULT_OLLAMA_OCR_MODEL,
    normalizeOllamaHost,
} from './core';
import { createOllamaOcrPipeline } from './pipeline';
import { SupersededOcrError } from './pipeline';
import { preprocessOcrImage } from './image';
import { chooseBestFormulaOcrOutput, shouldRetryFormulaRecognition } from './formula';
import { createOllamaGenerateTransport } from './transport';

let preprocessingGeneration = 0;
const transport = createOllamaGenerateTransport();

const pipeline = createOllamaOcrPipeline({
    generate: transport.generate,
    abortPrevious: transport.abort,
});

/** 取消图片预处理、等待后端响应或读取结果中的当前 OCR 请求。 */
export function cancelOllamaOcrRecognition() {
    preprocessingGeneration += 1;
    pipeline.cancelActive();
}

export async function recognize(base64, language, options = {}) {
    const generation = ++preprocessingGeneration;
    pipeline.cancelActive();
    const config = options.config ?? {};
    const host = normalizeOllamaHost(config.requestPath ?? DEFAULT_OLLAMA_OCR_HOST);
    const model = config.model ?? DEFAULT_OLLAMA_OCR_MODEL;
    const mode = config.mode ?? DEFAULT_OLLAMA_OCR_MODE;
    let processedImagePromise;
    let resultMetadata = null;
    const onResultMetadata = (metadata) => {
        resultMetadata = metadata;
        try {
            options.onResultMetadata?.(metadata);
        } catch {
            // 展示元数据不能反向破坏已经完成的 OCR 结果。
        }
    };
    const ensureCurrent = () => {
        if (generation !== preprocessingGeneration) throw new SupersededOcrError();
    };
    const getProcessedImage = async () => {
        processedImagePromise ??= preprocessOcrImage(base64);
        const image = await processedImagePromise;
        ensureCurrent();
        return image;
    };
    const runRecognition = async (requestMode, fallbackToSystem, imageVariant = 'processed', keepAlive = -1) => {
        const image = imageVariant === 'raw' ? base64 : await getProcessedImage();
        ensureCurrent();
        return pipeline.recognize({
            request: buildOllamaOcrRequest({ model, mode: requestMode, image, keepAlive }),
            image: base64,
            language,
            host,
            fallbackToSystem,
            onResultMetadata,
        });
    };
    const runFormulaRecognition = async () => {
        const candidates = [];
        const errors = [];
        const imageVariants = ['processed', 'raw'];
        for (const imageVariant of imageVariants) {
            // 两个候选复用同一个 Gemma 4 runner，结束后仍由翻译直接复用，不再发生换模。
            const keepAlive = -1;
            try {
                candidates.push({
                    variant: imageVariant,
                    text: await runRecognition('formula', false, imageVariant, keepAlive),
                });
            } catch (error) {
                if (error instanceof SupersededOcrError) throw error;
                errors.push(error);
            }
        }

        const best = chooseBestFormulaOcrOutput(candidates);
        if (best === null) {
            throw new AggregateError(errors, '公式模型未返回可渲染的 LaTeX');
        }
        onResultMetadata({
            source: 'model',
            structured: true,
            route: 'formula_dual_scale',
            formulaVariant: best.variant,
        });
        return best.text;
    };

    if (mode === DEFAULT_OLLAMA_OCR_MODE) {
        const documentResult = await runRecognition(DEFAULT_OLLAMA_OCR_MODE, false, 'processed');
        onResultMetadata({
            ...(resultMetadata ?? {}),
            route: resultMetadata?.source === 'model' ? 'document_multimodal' : 'document_system_fallback',
            imageVariant: 'processed',
        });
        return documentResult;
    }

    if (mode === 'formula') {
        return runFormulaRecognition();
    }

    const initialResult = await runRecognition(mode, false);
    if (resultMetadata?.source !== 'model') return initialResult;

    return initialResult;
}

export { checkOllamaOcrModel } from './client';
export * from './info';
