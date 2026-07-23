import { writeText } from '@tauri-apps/plugin-clipboard-manager';

const isTauriRuntime = () => Boolean(
    globalThis.window?.__TAURI__
    || globalThis.window?.__TAURI_METADATA__
    || globalThis.window?.__TAURI_INTERNALS__
);

/**
 * 统一写入系统剪贴板：桌面端优先使用 Tauri 2 官方插件，浏览器预览回退到 Web Clipboard API。
 */
export async function writeClipboardText(value) {
    const text = String(value ?? '');
    if (!text) return;

    if (isTauriRuntime()) {
        try {
            await writeText(text);
            return;
        } catch {
            // 插件权限或初始化异常时继续尝试 WebView 剪贴板，避免复制按钮静默失效。
        }
    }

    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard?.writeText) throw new Error('当前环境不支持写入剪贴板');
    await clipboard.writeText(text);
}
