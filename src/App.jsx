import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { lazy, Suspense, useEffect } from 'react';

import { hideTranslationWindow } from './utils/translation_flow';
import './style.css';

function isTauriEnvironment() {
    return Boolean(
        globalThis.window?.__TAURI__
        || globalThis.window?.__TAURI_METADATA__
        || globalThis.window?.__TAURI_INTERNALS__
    );
}

// 浏览器预览没有 Tauri metadata，不能在模块加载阶段直接创建窗口句柄。
const appWindow = isTauriEnvironment() ? getCurrentWebviewWindow() : null;

// 三类 WebView 按窗口标签只加载各自代码，避免快捷翻译解析整套 PDF 阅读器。
const Main = lazy(() => import('./window/Main'));
const Screenshot = lazy(() => import('./window/Screenshot'));
const Translate = lazy(() => import('./window/Translate'));

function currentWindowLabel() {
    return appWindow?.label ?? 'main';
}

export default function App() {
    const label = currentWindowLabel();

    useEffect(() => {
        document.documentElement.dataset.window = label;
        const handleKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            if (label === 'translate') {
                event.preventDefault();
                if (appWindow) void hideTranslationWindow(appWindow);
            } else if (label === 'screenshot') {
                event.preventDefault();
                if (appWindow) void appWindow.hide();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [label]);

    if (label === 'daemon') return null;
    const content = label === 'translate'
        ? <Translate />
        : label === 'screenshot'
            ? <Screenshot />
            : <Main />;
    return <Suspense fallback={<div className='app-loading' role='status' aria-label='正在加载小允翻译' />}>{content}</Suspense>;
}
