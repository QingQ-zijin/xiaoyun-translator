import { invoke } from '@tauri-apps/api/core';

import { translate as translateWithOllama } from '../../services/translate/ollama';
import { Language } from '../../services/translate/ollama/info';
import { detectByScript, detectFast } from '../../utils/lang_detect';
import { isTauriRuntime, translateWithDesktopBackend } from './desktopTransport';
import { resolveAcademicTargetLanguage } from './language';
import { SETTINGS_VERSION, UNIFIED_OLLAMA_MODEL } from '../ollama/runtime';
export { getLanguageLabel, LANGUAGE_OPTIONS, resolveAcademicTargetLanguage } from './language';

const DEFAULT_CONFIG = Object.freeze({
    requestPath: 'http://127.0.0.1:11434',
    model: UNIFIED_OLLAMA_MODEL,
    stream: true,
});

function normalizeHost(requestPath) {
    const value = String(requestPath || DEFAULT_CONFIG.requestPath).trim();
    if (/^https?:\/\//iu.test(value)) return value.replace(/\/$/u, '');
    return `http://${value}`.replace(/\/$/u, '');
}

export async function loadOllamaTranslationConfig() {
    const settingsV2 = await invoke('get_settings_v2').catch(() => ({}));
    const translation = settingsV2?.ollama?.translation ?? {};

    return {
        ...DEFAULT_CONFIG,
        ...translation,
        requestPath: normalizeHost(translation.requestPath),
        // 运行期固定唯一模型；即使旧配置事件晚到，也不能重新加载历史翻译模型。
        model: UNIFIED_OLLAMA_MODEL,
        stream: true,
    };
}

export async function saveOllamaTranslationConfig(nextConfig) {
    const current = await invoke('get_settings_v2');
    const value = {
        ...current,
        version: SETTINGS_VERSION,
        ollama: {
            ...(current.ollama ?? {}),
            translation: {
                ...DEFAULT_CONFIG,
                ...(current.ollama?.translation ?? {}),
                ...nextConfig,
                requestPath: normalizeHost(nextConfig.requestPath),
            },
        },
    };
    const saved = await invoke('update_settings_v2', { settings: value });
    return saved.ollama.translation;
}

function resolveDetectedLanguage(text, sourceLanguage) {
    if (sourceLanguage !== 'auto') return sourceLanguage;
    return detectFast(text) || detectByScript(text) || 'en';
}

export async function translateAcademic({
    text,
    sourceLanguage = 'auto',
    targetLanguage = 'zh_cn',
    contextBefore = '',
    contextAfter = '',
    paperTitle = '',
    onDelta,
    onStatus,
    signal,
}) {
    const sourceText = String(text ?? '').trim();
    if (!sourceText) return '';

    const detectedLanguage = resolveDetectedLanguage(sourceText, sourceLanguage);
    const effectiveTargetLanguage = resolveAcademicTargetLanguage(sourceText, targetLanguage);
    if (isTauriRuntime()) {
        return translateWithDesktopBackend({
            invokeCommand: invoke,
            payload: {
                text: sourceText,
                pageNumber: 1,
                paperTitle,
                contextBefore,
                contextAfter,
                sourceLanguage,
                targetLanguage: effectiveTargetLanguage,
            },
            onDelta,
            onStatus,
            signal,
            label: '学术翻译',
        });
    }

    const config = await loadOllamaTranslationConfig();
    let cancelRequest = null;
    const abort = () => cancelRequest?.();
    signal?.addEventListener('abort', abort, { once: true });

    try {
        return await translateWithOllama(
            sourceText,
            Language[sourceLanguage] ?? Language.auto,
            Language[effectiveTargetLanguage] ?? Language.zh_cn,
            {
                config,
                detect: detectedLanguage,
                context: { before: contextBefore, after: contextAfter, paperTitle },
                setResult: onDelta,
                registerCancel: (cancel) => {
                    cancelRequest = cancel;
                    if (signal?.aborted) cancelRequest?.();
                },
            }
        );
    } finally {
        signal?.removeEventListener('abort', abort);
    }
}

export async function synthesizeSpeech({ text, language = 'zh_cn', voice, rate } = {}) {
    const normalizedLanguage = language === 'zh_cn' ? 'zh' : language === 'zh_tw' ? 'zh-TW' : language;
    const settingsV2 = await invoke('get_settings_v2').catch(() => ({}));
    const speech = settingsV2?.speech ?? {};
    return invoke('system_tts', {
        text: String(text ?? ''),
        lang: normalizedLanguage,
        voice: voice ?? speech.voice ?? null,
        rate: rate ?? speech.rate ?? 1,
    });
}
