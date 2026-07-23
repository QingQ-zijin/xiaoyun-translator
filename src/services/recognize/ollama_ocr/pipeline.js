import { cleanOcrOutput, findOcrOutputLoop } from './output.js';

export class SupersededOcrError extends Error {
    constructor() {
        super('OCR 请求已被更新的截图取代');
        this.name = 'SupersededOcrError';
    }
}

class InvalidOcrOutputError extends Error {
    constructor(message, fallbackReason = 'invalid_output') {
        super(message);
        this.name = 'InvalidOcrOutputError';
        this.fallbackReason = fallbackReason;
    }
}

function validateOutput(text, source) {
    if (typeof text !== 'string' || text.trim() === '') {
        throw new InvalidOcrOutputError(`${source} 返回了空结果`);
    }
    const trimmed = text.trim();
    const meaningfulLines = trimmed.split(/\r\n|\n|\r/u).filter((line) => line.trim() !== '');
    if (meaningfulLines.every((line) => /^\s*```(?:[\w-]+)?\s*$/u.test(line))) {
        throw new InvalidOcrOutputError(`${source} 只返回了 Markdown 围栏`);
    }
    return trimmed;
}

function completeOutput(text, source, onResultMetadata, metadata = {}) {
    const validated = validateOutput(text, source === 'model' ? 'Ollama OCR' : '系统 OCR');
    try {
        onResultMetadata?.({ source, structured: source === 'model', ...metadata });
    } catch {
        // 元数据只服务于展示格式，不得反向破坏已经完成的 OCR 结果。
    }
    return validated;
}

function describeFallback(modelError) {
    return {
        fallbackReason: modelError?.fallbackReason ?? 'model_request_failed',
        fallbackDetail: String(modelError?.message ?? modelError),
    };
}

/**
 * 创建可取消的 OCR 管线。依赖均可注入，便于独立验证模型流、回退与竞态处理。
 */
export function createOllamaOcrPipeline({ generate, systemRecognize, abortPrevious = () => {} }) {
    let activeRequest = null;

    function cancelActive() {
        if (activeRequest !== null) {
            activeRequest.superseded = true;
            try {
                activeRequest.stream?.abort?.();
                abortPrevious();
            } catch {
                // 取消只是释放旧任务的尽力操作，新截图仍应立即继续。
            }
        }
    }

    async function recognize({ request, image, language, host, fallbackToSystem = true, onResultMetadata }) {
        cancelActive();

        const state = {
            stream: null,
            superseded: false,
        };
        activeRequest = state;

        try {
            try {
                const stream = await generate(request, { host });
                state.stream = stream;
                if (state.superseded) {
                    stream?.abort?.();
                    throw new SupersededOcrError();
                }

                let buffer = '';
                let doneReason;

                for await (const part of stream) {
                    if (state.superseded) {
                        stream?.abort?.();
                        throw new SupersededOcrError();
                    }

                    buffer += part?.response ?? '';
                    doneReason = part?.done_reason ?? doneReason;

                    const loop = findOcrOutputLoop(buffer);
                    if (loop) {
                        stream?.abort?.();
                        return completeOutput(buffer.slice(0, loop.cutIndex), 'model', onResultMetadata);
                    }
                }

                if (state.superseded) throw new SupersededOcrError();

                const cleaned = cleanOcrOutput(buffer, { doneReason });
                if (doneReason === 'length' && cleaned.repetition === null) {
                    throw new InvalidOcrOutputError('Ollama OCR 达到输出上限且未可靠收敛', 'length_limit');
                }
                return completeOutput(cleaned.text, 'model', onResultMetadata);
            } catch (modelError) {
                if (state.superseded || modelError instanceof SupersededOcrError) {
                    throw new SupersededOcrError();
                }
                if (!fallbackToSystem) throw modelError;

                try {
                    const fallback = await systemRecognize({ image, language });
                    if (state.superseded) throw new SupersededOcrError();
                    return completeOutput(fallback, 'system', onResultMetadata, describeFallback(modelError));
                } catch (systemError) {
                    if (state.superseded || systemError instanceof SupersededOcrError) {
                        throw new SupersededOcrError();
                    }
                    throw new AggregateError([modelError, systemError], 'Ollama OCR 与系统 OCR 均识别失败');
                }
            }
        } finally {
            if (activeRequest === state) activeRequest = null;
        }
    }

    return { cancelActive, recognize };
}
