import { invoke } from '@tauri-apps/api/core';

import { cancelOllamaOcrRecognition, recognize as recognizeWithOllama } from '../../services/recognize/ollama_ocr';
import { UNIFIED_OLLAMA_MODEL } from '../ollama/runtime';

const DEFAULT_CONFIG = Object.freeze({
    requestPath: 'http://127.0.0.1:11434',
    model: UNIFIED_OLLAMA_MODEL,
    fallbackToSystem: false,
    mode: 'auto',
});

export async function loadOllamaVisionConfig() {
    const settingsV2 = await invoke('get_settings_v2').catch(() => ({}));
    return {
        ...DEFAULT_CONFIG,
        ...(settingsV2?.ollama?.vision ?? {}),
        // 截图识别与翻译共用同一个 Gemma 4 runner，不再静默切换到其他模型。
        model: UNIFIED_OLLAMA_MODEL,
        fallbackToSystem: false,
    };
}

export async function extractText({ image, language = 'auto', mode = 'auto', signal, onMetadata }) {
    if (!image) throw new Error('没有可识别的图像');
    const config = await loadOllamaVisionConfig();
    if (signal?.aborted) throw new DOMException('识别已取消', 'AbortError');
    const cancel = () => cancelOllamaOcrRecognition();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
        const result = await recognizeWithOllama(image, language, {
            config: { ...config, mode },
            onResultMetadata: onMetadata,
        });
        if (signal?.aborted) throw new DOMException('识别已取消', 'AbortError');
        return result;
    } finally {
        signal?.removeEventListener('abort', cancel);
    }
}
