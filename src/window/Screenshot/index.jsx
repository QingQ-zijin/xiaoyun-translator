import React, { useEffect, useState, useRef } from 'react';
import { appCacheDir, join } from '@tauri-apps/api/path';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { currentMonitor } from '@tauri-apps/api/window';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emit } from '@tauri-apps/api/event';
import { formatShortcutForPlatform } from '../../utils/platform';

const appWindow = getCurrentWebviewWindow();
const SCREENSHOT_TRANSLATE_SHORTCUT = formatShortcutForPlatform('CommandOrControl+E');

export default function Screenshot() {
    const [imgurl, setImgurl] = useState('');
    const [error, setError] = useState('');
    const [isMoved, setIsMoved] = useState(false);
    const [isDown, setIsDown] = useState(false);
    const [mouseDownX, setMouseDownX] = useState(0);
    const [mouseDownY, setMouseDownY] = useState(0);
    const [mouseMoveX, setMouseMoveX] = useState(0);
    const [mouseMoveY, setMouseMoveY] = useState(0);

    const imgRef = useRef();

    useEffect(() => {
        let disposed = false;
        const loadScreenshot = async () => {
            try {
                const monitor = await currentMonitor();
                const position = monitor?.position ?? { x: 0, y: 0 };
                await invoke('screenshot', { x: position.x, y: position.y });
                const appCacheDirPath = await appCacheDir();
                const filePath = await join(appCacheDirPath, 'pot_screenshot.png');
                if (!disposed) setImgurl(convertFileSrc(filePath));
            } catch (cause) {
                if (disposed) return;
                setError(`截图失败：${String(cause)}`);
                await appWindow.show().catch(() => undefined);
                await appWindow.setFocus().catch(() => undefined);
            }
        };
        void loadScreenshot();
        return () => {
            disposed = true;
        };
    }, []);

    return (
        <>
            <img
                ref={imgRef}
                className='fixed top-0 left-0 w-full select-none'
                src={imgurl}
                draggable={false}
                onLoad={() => {
                    if (imgurl !== '' && imgRef.current.complete) {
                        void appWindow.show();
                        void appWindow.setFocus();
                        void appWindow.setResizable(false);
                    }
                }}
            />
            <div
                className={`fixed bg-[#2080f020] border border-solid border-sky-500 ${!isMoved && 'hidden'}`}
                style={{
                    top: Math.min(mouseDownY, mouseMoveY),
                    left: Math.min(mouseDownX, mouseMoveX),
                    bottom: screen.height - Math.max(mouseDownY, mouseMoveY),
                    right: screen.width - Math.max(mouseDownX, mouseMoveX),
                }}
            />
            <div
                className='fixed top-0 left-0 bottom-0 right-0 z-10 cursor-crosshair select-none'
                onMouseDown={(e) => {
                    if (e.buttons === 1) {
                        setIsDown(true);
                        setMouseDownX(e.clientX);
                        setMouseDownY(e.clientY);
                    } else {
                        void appWindow.close();
                    }
                }}
                onMouseMove={(e) => {
                    if (isDown) {
                        setIsMoved(true);
                        setMouseMoveX(e.clientX);
                        setMouseMoveY(e.clientY);
                    }
                }}
                onMouseUp={async (e) => {
                    await appWindow.hide();
                    setIsDown(false);
                    setIsMoved(false);
                    const imgWidth = imgRef.current?.naturalWidth ?? 0;
                    if (imgWidth <= 0) {
                        setError(`截图尚未准备完成，请重新按 ${SCREENSHOT_TRANSLATE_SHORTCUT}。`);
                        await appWindow.show().catch(() => undefined);
                        return;
                    }
                    const dpi = imgWidth / screen.width;
                    const left = Math.floor(Math.min(mouseDownX, e.clientX) * dpi);
                    const top = Math.floor(Math.min(mouseDownY, e.clientY) * dpi);
                    const right = Math.floor(Math.max(mouseDownX, e.clientX) * dpi);
                    const bottom = Math.floor(Math.max(mouseDownY, e.clientY) * dpi);
                    const width = right - left;
                    const height = bottom - top;
                    if (width <= 0 || height <= 0) {
                        console.warn('截图区域过小，已取消本次识别');
                        await appWindow.close();
                    } else {
                        try {
                            await invoke('cut_image', { left, top, width, height });
                            await emit('success');
                            await appWindow.close();
                        } catch (cause) {
                            setError(`提交截图失败：${String(cause)}`);
                            await appWindow.show().catch(() => undefined);
                            await appWindow.setFocus().catch(() => undefined);
                        }
                    }
                }}
            />
            {error ? (
                <div className='fixed inset-0 z-20 flex items-center justify-center bg-slate-950/55 p-8'>
                    <div className='max-w-lg rounded-2xl bg-white p-6 text-slate-900 shadow-2xl'>
                        <strong className='block text-lg'>无法开始截图翻译</strong>
                        <p className='mt-3 break-words text-sm leading-6 text-slate-600'>{error}</p>
                        <button
                            type='button'
                            className='mt-5 rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white'
                            onClick={() => appWindow.close()}
                        >
                            关闭
                        </button>
                    </div>
                </div>
            ) : null}
        </>
    );
}
