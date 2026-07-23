import { Ollama } from 'ollama/browser';

import { DEFAULT_OLLAMA_OCR_HOST, DEFAULT_OLLAMA_OCR_MODEL, normalizeOllamaHost } from './core.js';

/** 保存配置前只检查连接与模型，不在后台隐式下载大文件。 */
export async function checkOllamaOcrModel(config = {}) {
    const host = normalizeOllamaHost(config.requestPath ?? DEFAULT_OLLAMA_OCR_HOST);
    const model = String(config.model ?? '').trim() || DEFAULT_OLLAMA_OCR_MODEL;
    const client = new Ollama({ host });
    await client.show({ model });
    return true;
}
