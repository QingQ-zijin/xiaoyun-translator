import { Channel } from '@tauri-apps/api/core';

import { createThrottledStreamWriter } from '../../services/translate/ollama/stream';

const UNKNOWN_COMMAND_PATTERN = /unknown command|command .* not found|not in the allowlist|missing required key/iu;
const NETWORK_ERROR_PATTERN =
    /failed to fetch|networkerror|network error|load failed|connection refused|actively refused|无法连接/iu;
const RECOVERY_ERROR_PATTERN = /自动恢复失败|自动启动.+失败/iu;

export function isTauriRuntime() {
    if (typeof window === 'undefined') return false;
    return Boolean(window.__TAURI__ || window.__TAURI_METADATA__ || window.__TAURI_INTERNALS__);
}

function createAbortError() {
    if (typeof DOMException !== 'undefined') {
        return new DOMException('Translation cancelled', 'AbortError');
    }
    const error = new Error('Translation cancelled');
    error.name = 'AbortError';
    return error;
}

function errorMessage(error) {
    return String(typeof error === 'string' ? error : error?.message || error || '')
        .replace(/^(?:Error|TypeError):\s*/iu, '')
        .trim();
}

export function normalizeDesktopTranslationError(error, label = '翻译') {
    const message = errorMessage(error);
    if (UNKNOWN_COMMAND_PATTERN.test(message)) {
        return `当前程序后端不支持${label}，请安装最新版本后重试。`;
    }
    if (RECOVERY_ERROR_PATTERN.test(message)) {
        const detail = message.replace(/^论文划词翻译失败[：:]?\s*/u, '').trim();
        return detail.startsWith(`${label}失败`) ? detail : `${label}失败：${detail}`;
    }
    if (NETWORK_ERROR_PATTERN.test(message)) {
        return `${label}失败：无法连接本地翻译服务，请确认 Ollama 正在运行。`;
    }

    const detail = message.replace(/^论文划词翻译失败[：:]?\s*/u, '').trim();
    if (!detail) return `${label}失败：本地翻译服务没有返回错误详情。`;
    if (detail.startsWith(`${label}失败`)) return detail;
    return `${label}失败：${detail}`;
}

function translationRequestId() {
    return `translation-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

export async function translateWithDesktopBackend({
    invokeCommand,
    payload,
    onDelta,
    onStatus,
    signal,
    label = '翻译',
    createChannel = () => new Channel(),
}) {
    if (signal?.aborted) throw createAbortError();

    const requestId = translationRequestId();
    const channel = createChannel();
    let streamedText = '';
    // 首块同步显示，后续 token 以一帧左右合并，避免整棵阅读器与 Markdown/KaTeX 逐 token 重排。
    const streamWriter = createThrottledStreamWriter(onDelta, {
        intervalMs: 24,
        decorateIntermediate: false,
    });
    channel.onmessage = (message) => {
        if (signal?.aborted || message?.requestId !== requestId) return;
        if (message.event === 'delta') {
            streamedText = String(message.text ?? `${streamedText}${message.delta ?? ''}`);
            streamWriter.push(streamedText);
        } else if (message.event === 'status') {
            onStatus?.(String(message.message ?? message.text ?? '').trim());
        }
    };
    const cancel = () => {
        void invokeCommand('research_cancel_translation', { requestId }).catch(() => undefined);
    };
    signal?.addEventListener('abort', cancel, { once: true });

    try {
        const result = await invokeCommand('research_translate_selection', {
            ...payload,
            requestId,
            onEvent: channel,
        });
        if (signal?.aborted) throw createAbortError();

        const text = typeof result === 'string' ? result : result?.text ?? '';
        if (!String(text).trim()) throw new Error('Gemma 4 E4B 返回了空译文');
        streamWriter.finish(text);
        return text;
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        throw new Error(normalizeDesktopTranslationError(error, label));
    } finally {
        streamWriter.cancel();
        signal?.removeEventListener('abort', cancel);
        channel.onmessage = () => {};
    }
}
