/** 当前桌面版的单一多模态模型策略。 */
export const UNIFIED_OLLAMA_MODEL = 'gemma4:e4b-it-qat';
export const UNIFIED_OLLAMA_CONTEXT_TOKENS = 8192;
export const SETTINGS_VERSION = 6;

/**
 * 把旧的四模型配置收敛为一个端点。Gemma 4 不支持 embeddings，embedding 字段只为
 * 保持持久配置结构完整，运行时不会调用它的 `/api/embed`。
 */
export function unifyOllamaEndpoints(ollama = {}) {
    const translation = ollama.translation ?? {};
    const model = UNIFIED_OLLAMA_MODEL;
    const requestPath = String(translation.requestPath || 'http://127.0.0.1:11434').trim();
    const endpoint = { requestPath, model };

    return {
        ...ollama,
        translation: { ...ollama.translation, ...endpoint, stream: true },
        research: { ...ollama.research, ...endpoint, stream: false },
        vision: { ...ollama.vision, ...endpoint, stream: false },
        embedding: { ...ollama.embedding, ...endpoint, stream: false },
        embeddingInstallConfirmed: false,
        semanticEmbeddingsEnabled: false,
    };
}
