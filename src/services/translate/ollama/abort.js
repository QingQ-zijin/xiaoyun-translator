export function combineAbortSignals(...signals) {
    const activeSignals = signals.filter(Boolean);
    if (activeSignals.length === 0) return undefined;
    if (activeSignals.length === 1) return activeSignals[0];
    if (typeof AbortSignal.any === 'function') {
        return AbortSignal.any(activeSignals);
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    for (const signal of activeSignals) {
        if (signal.aborted) {
            abort();
            break;
        }
        signal.addEventListener('abort', abort, { once: true });
    }
    return controller.signal;
}

// 把组件级取消信号与 Ollama SDK 自己的流取消信号合并，首 token 到达前也能终止请求。
export function createAbortableFetch(requestController, baseFetch = globalThis.fetch) {
    return (input, init = {}) =>
        baseFetch(input, {
            ...init,
            signal: combineAbortSignals(init.signal, requestController.signal),
        });
}
