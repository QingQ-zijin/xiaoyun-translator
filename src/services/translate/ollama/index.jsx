import { Language } from './info';
import { Ollama } from 'ollama/browser';
import { UNIFIED_OLLAMA_CONTEXT_TOKENS, UNIFIED_OLLAMA_MODEL } from '../../../domains/ollama/runtime';
import { interpolateOllamaTranslationPrompt, upgradeOllamaTranslationPrompt } from './prompt';
import {
    analyzeTranslateGemmaIntegrity,
    createTranslateGemmaChatRequest,
    enforceTranslateGemmaTerminology,
    isTranslateGemmaModel,
} from './translategemma';
import { createThrottledStreamWriter } from './stream';
import { createAbortableFetch } from './abort';

export async function translate(text, from, to, options = {}) {
    const { config, setResult, detect, registerCancel, context } = options;

    let { stream, promptList, requestPath } = config;
    // 浏览器预览与异常降级路径也必须遵守单模型约束，不能信任旧服务配置里的 model。
    const model = UNIFIED_OLLAMA_MODEL;

    if (!/https?:\/\/.+/.test(requestPath)) {
        requestPath = `https://${requestPath}`;
    }
    if (requestPath.endsWith('/')) {
        requestPath = requestPath.slice(0, -1);
    }
    const requestController = new AbortController();
    const ollama = new Ollama({
        host: requestPath,
        fetch: createAbortableFetch(requestController),
    });
    registerCancel?.(() => {
        requestController.abort();
        ollama.abort();
    });

    const usesTranslateGemma = isTranslateGemmaModel(model);
    const createRequest = (safeRetry = false) =>
        usesTranslateGemma
            ? createTranslateGemmaChatRequest({
                  model,
                  text,
                  from,
                  to,
                  detectedKey: detect,
                  stream,
                  safeRetry,
                  context,
              })
            : {
                  model,
                  messages: interpolateOllamaTranslationPrompt(upgradeOllamaTranslationPrompt(promptList), {
                      text,
                      from,
                      to,
                      detect: Language[detect],
                  }),
                  stream,
                  think: false,
                  keep_alive: -1,
                  options: { num_ctx: UNIFIED_OLLAMA_CONTEXT_TOKENS },
              };

    const runAttempt = async (safeRetry) => {
        const response = await ollama.chat(createRequest(safeRetry));
        if (!stream) {
            const rawTarget = response.message.content.trim();
            const target = usesTranslateGemma
                ? enforceTranslateGemmaTerminology({
                      sourceText: text,
                      resultText: rawTarget,
                      targetLanguage: to,
                  })
                : rawTarget;
            return {
                target,
                suspicious:
                    usesTranslateGemma &&
                    analyzeTranslateGemmaIntegrity({ sourceText: text, resultText: target }).suspicious,
            };
        }

        let target = '';
        let nextIntegrityCheckAt = 16;
        const writer = createThrottledStreamWriter(setResult);
        try {
            for await (const part of response) {
                target += part.message.content;
                const shouldCheckIntegrity = usesTranslateGemma && target.length >= nextIntegrityCheckAt;
                const integrity = shouldCheckIntegrity
                    ? analyzeTranslateGemmaIntegrity({ sourceText: text, resultText: target })
                    : { suspicious: false };
                if (shouldCheckIntegrity) {
                    nextIntegrityCheckAt = target.length + 16;
                }
                if (integrity.suspicious) {
                    writer.cancel();
                    response.abort?.();
                    return { target: target.trim(), suspicious: true };
                }
                if (setResult) {
                    writer.push(target);
                } else {
                    response.abort?.();
                    return { target: '[STREAM]', suspicious: false };
                }
            }
            target = target.trim();
            if (usesTranslateGemma) {
                target = enforceTranslateGemmaTerminology({
                    sourceText: text,
                    resultText: target,
                    targetLanguage: to,
                });
            }
            const suspicious =
                usesTranslateGemma &&
                analyzeTranslateGemmaIntegrity({ sourceText: text, resultText: target }).suspicious;
            if (!suspicious) {
                writer.finish(target);
            }
            return { target, suspicious };
        } finally {
            writer.cancel();
        }
    };

    try {
        const firstAttempt = await runAttempt(false);
        if (!firstAttempt.suspicious) {
            return firstAttempt.target;
        }

        if (requestController.signal.aborted) {
            throw new DOMException('Translation cancelled', 'AbortError');
        }

        // 清除首轮异常流式内容，再在同一取消生命周期内安全重试一次。
        setResult?.('');
        const retryAttempt = await runAttempt(true);
        if (retryAttempt.suspicious) {
            setResult?.('');
            throw new Error('TranslateGemma 未能返回可信译文，请重试。');
        }
        return retryAttempt.target;
    } finally {
        registerCancel?.(null);
    }
}

export * from './info';
