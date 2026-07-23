import { Ollama } from 'ollama/browser';

import { UNIFIED_OLLAMA_CONTEXT_TOKENS, UNIFIED_OLLAMA_MODEL } from '../../../domains/ollama/runtime.js';

const warmupRequests = new Map();

function normalizeOllamaHost(requestPath) {
    let host = String(requestPath || 'http://127.0.0.1:11434').trim();
    if (!/^https?:\/\//i.test(host)) {
        host = `https://${host}`;
    }
    return host.replace(/\/$/, '');
}

// WebView 启动后立即把当前翻译模型装入显存，并无限期保留到显存压力要求换出。
export function prewarmOllamaTranslation(config, { createClient = (host) => new Ollama({ host }) } = {}) {
    // 预热入口不接受任意模型名，避免旧配置把 TranslateGemma/Qwen/EmbeddingGemma 拉回显存。
    const model = UNIFIED_OLLAMA_MODEL;

    const host = normalizeOllamaHost(config?.requestPath);
    const key = `${host}\n${model}`;
    if (warmupRequests.has(key)) {
        return warmupRequests.get(key);
    }

    const client = createClient(host);
    const request = client.chat({
        model,
        messages: [{ role: 'user', content: '.' }],
        stream: false,
        think: false,
        keep_alive: -1,
        options: { num_ctx: UNIFIED_OLLAMA_CONTEXT_TOKENS, num_predict: 1, temperature: 0 },
    });

    const pending = Promise.resolve(request).then(
        () => true,
        (error) => {
            warmupRequests.delete(key);
            throw error;
        }
    );
    warmupRequests.set(key, pending);
    return pending;
}
