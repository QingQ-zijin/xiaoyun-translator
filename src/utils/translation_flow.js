import { invoke } from '@tauri-apps/api/core';

// 仅允许当前请求提交结果，避免较慢的旧请求覆盖较新的内容。
export function commitIfCurrentRequest({ requestId, currentRequestId, commit }) {
    if (requestId !== currentRequestId) {
        return false;
    }
    commit();
    return true;
}

export const TRANSLATION_WINDOW_HIDE_EVENT = 'translation-window-hide';
export const TRANSLATION_WINDOW_HIDE_TIMEOUT_MS = 120;

let activeSelectionRequestId = 0;

export function acceptSelectionRequestId(value) {
    const requestId = Number(value);
    if (!Number.isSafeInteger(requestId) || requestId <= 0 || requestId < activeSelectionRequestId) {
        return false;
    }
    activeSelectionRequestId = requestId;
    return true;
}

export function getActiveSelectionRequestId() {
    return activeSelectionRequestId;
}

// 隐藏模式只抑制前台展示，翻译 WebView 仍可在后台处理新文本。
export function shouldPresentTranslationWindow(hideWindow) {
    return hideWindow !== true;
}

export async function hideTranslationWindow(
    appWindow,
    target = window,
    dismissRequest = (requestId) => invoke('dismiss_translate_window', { requestId }),
    timeoutMs = TRANSLATION_WINDOW_HIDE_TIMEOUT_MS
) {
    const requestId = getActiveSelectionRequestId();
    target.dispatchEvent(new CustomEvent(TRANSLATION_WINDOW_HIDE_EVENT, { detail: { requestId } }));
    if (!requestId) {
        await appWindow.hide();
        return true;
    }

    const hideIfStillCurrent = async () => {
        if (getActiveSelectionRequestId() !== requestId) return false;
        await appWindow.hide();
        return true;
    };
    let fallbackTimer = null;
    try {
        const nativeDismiss = Promise.resolve()
            .then(() => dismissRequest(requestId))
            .then(
                (dismissed) => ({ dismissed }),
                (error) => ({ error })
            );
        const timeout = new Promise((resolve) => {
            fallbackTimer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
        });
        const outcome = await Promise.race([nativeDismiss, timeout]);
        if (outcome.timedOut) {
            const hidden = await hideIfStillCurrent();
            if (hidden) {
                console.warn('原子关闭快捷翻译窗口超时，已按当前请求执行本地隐藏兜底');
            }
            return hidden;
        }
        if (outcome.error) throw outcome.error;
        // Rust 会先按展示会话 ID 原子隐藏；这里在 IPC 返回后再确认一次 WebView 可见性。
        // 该确认发生在完整 click 之后，可规避 Windows 仍持有 pointerdown 激活导致的延迟隐藏。
        // 若期间已经到达下一次 Ctrl+D，requestId 检查会保护新窗口不被旧回执误关。
        const locallyHidden = await hideIfStillCurrent();
        return Boolean(outcome.dismissed || locallyHidden);
    } catch (error) {
        console.warn('原子关闭快捷翻译窗口失败，使用本地隐藏兜底：', error);
        return hideIfStillCurrent();
    } finally {
        clearTimeout(fallbackTimer);
    }
}

// 失焦自动隐藏只改变可见性，不取消正在进行的原生取词或模型请求。
// 这样上一轮遗留的失焦计时器即使恰好触发，也不会废弃刚开始的下一次 Ctrl+D。
export async function hideTranslationWindowOnBlur(appWindow) {
    await appWindow.hide();
}

// 统一划词翻译的同步与语言检测时序：可靠的本地结果立即启动，模糊文本只等待一次精确检测。
export async function syncAndDetect({
    text,
    sync,
    detect,
    setDetected,
    detectFast,
    detectFallback,
    isCurrent = () => true,
}) {
    const fastLanguage = detectFast?.(text) ?? '';
    if (!isCurrent()) {
        return;
    }
    if (fastLanguage) {
        setDetected(fastLanguage);
        sync();
    }

    try {
        const detectedLanguage = await detect(text);
        if (!isCurrent()) return;
        const resolvedLanguage = detectedLanguage || detectFallback?.(text) || '';
        if (resolvedLanguage && resolvedLanguage !== fastLanguage) {
            setDetected(resolvedLanguage);
        }
        if (!fastLanguage && resolvedLanguage) sync();
    } catch (error) {
        console.warn('语言检测失败，继续使用即时语言结果：', error);
        if (!isCurrent() || fastLanguage) return;
        const fallbackLanguage = detectFallback?.(text) || '';
        if (fallbackLanguage) {
            setDetected(fallbackLanguage);
            sync();
        }
    }
}
