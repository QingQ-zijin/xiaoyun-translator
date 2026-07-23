import { invoke } from '@tauri-apps/api/core';

import { normalizeOllamaHost } from './core.js';

const CANCELLED_PATTERN = /已取消|cancelled|canceled|abort/iu;
const NETWORK_PATTERN = /failed to fetch|network|connection|connect|refused|无法连接/iu;

async function readHttpError(response) {
    let detail = '';
    try {
        const raw = await response.text();
        try {
            const payload = JSON.parse(raw);
            detail = payload?.error ?? raw;
        } catch {
            detail = raw;
        }
    } catch {
        detail = '';
    }

    const suffix = detail ? `：${detail}` : '';
    return new Error(`Ollama 请求失败（HTTP ${response.status}）${suffix}`);
}

function parseNdjsonLine(line) {
    const trimmed = line.trim();
    if (trimmed === '') return null;
    try {
        return JSON.parse(trimmed);
    } catch (error) {
        throw new Error('Ollama 返回了无效的 NDJSON 数据', { cause: error });
    }
}

function isTauriRuntime() {
    if (typeof window === 'undefined') return false;
    return Boolean(window.__TAURI__ || window.__TAURI_METADATA__ || window.__TAURI_INTERNALS__);
}

function createAbortError() {
    if (typeof DOMException !== 'undefined') return new DOMException('截图 OCR 已取消', 'AbortError');
    const error = new Error('截图 OCR 已取消');
    error.name = 'AbortError';
    return error;
}

function backendErrorMessage(error) {
    return String(typeof error === 'string' ? error : error?.message || error || '')
        .replace(/^(?:Error|TypeError):\s*/iu, '')
        .trim();
}

export function normalizeVisionBackendError(error) {
    const message = backendErrorMessage(error);
    if (CANCELLED_PATTERN.test(message)) return createAbortError();
    if (NETWORK_PATTERN.test(message)) {
        return new Error('截图 OCR 失败：无法连接本地 Ollama，请确认它正在运行。');
    }
    if (!message) return new Error('截图 OCR 失败：本地视觉服务没有返回错误详情。');
    if (/截图 OCR|Ollama 后端已关闭/u.test(message)) return new Error(message);
    return new Error(`截图 OCR 失败：${message}`);
}

function createVisionRequestId() {
    return `vision-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

/**
 * 创建由调用方直接持有 AbortController 的 generate 传输层。
 * 取消信号覆盖 HTTP 建连、等待首响应和流式读取三个阶段。
 */
export function createOllamaGenerateTransport({
    fetchImpl = globalThis.fetch,
    invokeImpl = invoke,
    desktopRuntime = isTauriRuntime(),
    requestIdFactory = createVisionRequestId,
} = {}) {
    if (!desktopRuntime && typeof fetchImpl !== 'function') throw new TypeError('当前环境不支持 fetch');

    let activeRequest = null;

    const abort = () => {
        const request = activeRequest;
        if (request === null) return;
        activeRequest = null;
        request.abort();
    };

    const generate = async (request, { host }) => {
        if (desktopRuntime) {
            const requestId = requestIdFactory();
            const state = {
                aborted: false,
                abort() {
                    if (state.aborted) return;
                    state.aborted = true;
                    void invokeImpl('cancel_ollama_vision_request', { requestId }).catch(() => undefined);
                },
            };
            activeRequest = state;
            let result;
            try {
                result = await invokeImpl('ollama_vision_generate', { requestId, request });
            } catch (error) {
                if (state.aborted) throw createAbortError();
                throw normalizeVisionBackendError(error);
            } finally {
                if (activeRequest === state) activeRequest = null;
            }
            if (state.aborted) throw createAbortError();

            return {
                abort: state.abort,
                async *[Symbol.asyncIterator]() {
                    if (state.aborted) throw createAbortError();
                    yield result;
                },
            };
        }

        const controller = new AbortController();
        const state = { abort: () => controller.abort() };
        activeRequest = state;
        let response;

        try {
            response = await fetchImpl(`${normalizeOllamaHost(host)}/api/generate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/x-ndjson',
                },
                body: JSON.stringify(request),
                signal: controller.signal,
            });
        } catch (error) {
            if (activeRequest === state) activeRequest = null;
            throw error;
        }

        if (!response.ok) {
            if (activeRequest === state) activeRequest = null;
            throw await readHttpError(response);
        }
        if (!response.body || typeof response.body.getReader !== 'function') {
            if (activeRequest === state) activeRequest = null;
            throw new Error('Ollama 响应不支持流式读取');
        }

        const abortRequest = () => {
            if (activeRequest === state) activeRequest = null;
            controller.abort();
        };

        return {
            abort: abortRequest,
            async *[Symbol.asyncIterator]() {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });

                        let newlineIndex = buffer.indexOf('\n');
                        while (newlineIndex >= 0) {
                            const parsed = parseNdjsonLine(buffer.slice(0, newlineIndex));
                            buffer = buffer.slice(newlineIndex + 1);
                            if (parsed !== null) yield parsed;
                            newlineIndex = buffer.indexOf('\n');
                        }
                    }

                    buffer += decoder.decode();
                    const trailing = parseNdjsonLine(buffer);
                    if (trailing !== null) yield trailing;
                } finally {
                    if (activeRequest === state) activeRequest = null;
                    reader.releaseLock();
                }
            },
        };
    };

    return { abort, generate };
}
