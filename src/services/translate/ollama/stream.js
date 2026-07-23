const DEFAULT_STREAM_RENDER_INTERVAL_MS = 32;

// 首块立即渲染，后续块按一帧左右合并，避免每个 token 都重跑 Markdown 与 KaTeX。
export function createThrottledStreamWriter(
    setResult,
    {
        intervalMs = DEFAULT_STREAM_RENDER_INTERVAL_MS,
        setTimer = setTimeout,
        clearTimer = clearTimeout,
        now = Date.now,
        decorateIntermediate = true,
    } = {}
) {
    let latestValue = '';
    let timer = null;
    let hasPublished = false;
    let lastPublishedAt = 0;
    let lastPublishedValue = '';

    const publishIntermediate = () => {
        timer = null;
        if (!setResult) return;
        setResult(decorateIntermediate ? `${latestValue}_` : latestValue);
        hasPublished = true;
        lastPublishedAt = now();
        lastPublishedValue = latestValue;
    };

    const clearPendingTimer = () => {
        if (timer !== null) {
            clearTimer(timer);
            timer = null;
        }
    };

    return {
        push(value) {
            latestValue = value;
            if (!setResult) return;
            if (!hasPublished) {
                publishIntermediate();
                return;
            }
            if (timer === null) {
                const delay = Math.max(0, intervalMs - (now() - lastPublishedAt));
                timer = setTimer(publishIntermediate, delay);
            }
        },
        finish(value) {
            latestValue = value;
            clearPendingTimer();
            // 无光标的桌面流若最终值已显示则不重复触发整棵 React 树；带光标模式仍需提交一次以移除光标。
            if (decorateIntermediate || latestValue !== lastPublishedValue) {
                setResult?.(latestValue);
            }
        },
        cancel() {
            clearPendingTimer();
        },
    };
}
