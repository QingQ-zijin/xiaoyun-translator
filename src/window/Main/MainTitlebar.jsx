import { useEffect, useMemo, useState } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { PiFileArrowUp, PiGear, PiReadCvLogo, PiTranslate } from 'react-icons/pi';
import { VscChromeClose, VscChromeMaximize, VscChromeMinimize, VscChromeRestore } from 'react-icons/vsc';

import packageMetadata from '../../../package.json';

const isTauriRuntime = () =>
    Boolean(
        globalThis.window?.__TAURI__ || globalThis.window?.__TAURI_METADATA__ || globalThis.window?.__TAURI_INTERNALS__
    );

export default function MainTitlebar({ active, onNavigate }) {
    const [maximized, setMaximized] = useState(false);
    const appWindow = useMemo(() => (isTauriRuntime() ? getCurrentWebviewWindow() : null), []);

    useEffect(() => {
        if (!appWindow) return undefined;
        let dispose = () => {};
        void appWindow
            .isMaximized()
            .then(setMaximized)
            .catch(() => undefined);
        void appWindow
            .onResized(async () => setMaximized(await appWindow.isMaximized()))
            .then((unlisten) => {
                dispose = unlisten;
            });
        return () => dispose();
    }, [appWindow]);

    const openDocumentTranslation = () => {
        onNavigate?.('translate');
        globalThis.setTimeout(
            () => globalThis.dispatchEvent?.(new CustomEvent('xiaoyun:open-document-translator')),
            30
        );
    };

    const toggleMaximize = async () => {
        if (!appWindow) return;
        if (await appWindow.isMaximized()) await appWindow.unmaximize();
        else await appWindow.maximize();
    };

    return (
        <header
            className='main-titlebar'
            data-tauri-drag-region='true'
            onDoubleClick={(event) => {
                if (!event.target.closest?.('button')) void toggleMaximize();
            }}
        >
            <div
                className='main-titlebar__brand'
                data-tauri-drag-region='true'
            >
                <img
                    src='/icon.png'
                    alt=''
                />
                <strong>小允翻译</strong>
                <span>v{packageMetadata.version}</span>
            </div>
            <nav
                className='main-titlebar__menu'
                aria-label='窗口快捷菜单'
            >
                <button
                    type='button'
                    className={active === 'translate' ? 'is-active' : ''}
                    onClick={() => onNavigate?.('translate')}
                >
                    <PiTranslate aria-hidden='true' />
                    翻译
                </button>
                <button
                    type='button'
                    onClick={openDocumentTranslation}
                >
                    <PiFileArrowUp aria-hidden='true' />
                    文件翻译
                </button>
                <button
                    type='button'
                    className={active === 'research' ? 'is-active' : ''}
                    onClick={() => onNavigate?.('research')}
                >
                    <PiReadCvLogo aria-hidden='true' />
                    阅读
                </button>
                <button
                    type='button'
                    className={active === 'settings' ? 'is-active' : ''}
                    onClick={() => onNavigate?.('settings')}
                >
                    <PiGear aria-hidden='true' />
                    设置
                </button>
            </nav>
            <div
                className='main-titlebar__route'
                data-tauri-drag-region='true'
            >
                {active === 'translate'
                    ? 'Academic Translation'
                    : active === 'research'
                      ? 'Research Library'
                      : 'Preferences'}
            </div>
            <div className='main-titlebar__controls'>
                <button
                    type='button'
                    aria-label='最小化窗口'
                    onClick={() => appWindow?.minimize()}
                >
                    <VscChromeMinimize />
                </button>
                <button
                    type='button'
                    aria-label={maximized ? '还原窗口' : '最大化窗口'}
                    onClick={toggleMaximize}
                >
                    {maximized ? <VscChromeRestore /> : <VscChromeMaximize />}
                </button>
                <button
                    className='is-close'
                    type='button'
                    aria-label='关闭窗口'
                    onClick={() => appWindow?.close()}
                >
                    <VscChromeClose />
                </button>
            </div>
        </header>
    );
}
