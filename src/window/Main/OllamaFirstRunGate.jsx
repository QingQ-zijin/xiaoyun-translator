import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { PiArrowRight, PiBrain, PiCheckCircle, PiShieldCheck } from 'react-icons/pi';

import OllamaOnboardingCard from './OllamaOnboardingCard';

const SESSION_SKIP_KEY = 'xiaoyun.ollama.onboarding.skipped:v1';

const isTauriRuntime = () =>
    Boolean(
        globalThis.window?.__TAURI__ || globalThis.window?.__TAURI_METADATA__ || globalThis.window?.__TAURI_INTERNALS__
    );

function wasSkipped(storage) {
    try {
        return storage?.getItem(SESSION_SKIP_KEY) === 'true';
    } catch {
        return false;
    }
}

function rememberSkip(storage) {
    try {
        storage?.setItem(SESSION_SKIP_KEY, 'true');
    } catch {
        // 会话存储不可用时只隐藏本次组件；下次启动仍会再次检查。
    }
}

export default function OllamaFirstRunGate({
    desktop = isTauriRuntime(),
    invokeCommand = invoke,
    sessionStorage = globalThis.sessionStorage,
}) {
    const [visible, setVisible] = useState(false);
    const [ready, setReady] = useState(false);
    const panelRef = useRef(null);

    useEffect(() => {
        if (!desktop || wasSkipped(sessionStorage)) return undefined;
        let cancelled = false;
        void Promise.allSettled([invokeCommand('get_settings_v2'), invokeCommand('ollama_get_setup_status')]).then(
            ([settingsResult, statusResult]) => {
                if (cancelled) return;
                const settings = settingsResult.status === 'fulfilled' ? settingsResult.value : null;
                const status = statusResult.status === 'fulfilled' ? statusResult.value : null;
                if (settings?.ollama?.enabled === false || status?.modelInstalled) return;
                setVisible(true);
            }
        );
        return () => {
            cancelled = true;
        };
    }, [desktop, invokeCommand, sessionStorage]);

    useEffect(() => {
        if (!visible) return;
        globalThis.requestAnimationFrame?.(() => panelRef.current?.focus());
    }, [visible]);

    const handleStatusChange = useCallback((status) => {
        if (!status?.modelRunning) return;
        setReady(true);
        if (typeof globalThis.Event === 'function') {
            globalThis.dispatchEvent?.(new globalThis.Event('xiaoyun:ollama-ready'));
        }
    }, []);

    const dismiss = useCallback(() => {
        rememberSkip(sessionStorage);
        setVisible(false);
    }, [sessionStorage]);

    if (!visible) return null;

    return (
        <div
            className='ollama-first-run'
            role='dialog'
            aria-modal='true'
            aria-labelledby='ollama-first-run-title'
        >
            <div
                className='ollama-first-run__backdrop'
                aria-hidden='true'
            />
            <section
                ref={panelRef}
                className='ollama-first-run__panel'
                tabIndex='-1'
            >
                <header>
                    <span className='ollama-first-run__icon'>
                        {ready ? <PiCheckCircle aria-hidden='true' /> : <PiBrain aria-hidden='true' />}
                    </span>
                    <div>
                        <span className='ollama-first-run__eyebrow'>第一次使用</span>
                        <h1 id='ollama-first-run-title'>{ready ? '本地 AI 已准备好' : '先接入本地 Ollama'}</h1>
                        <p>
                            {ready
                                ? 'Gemma 4 E4B 已安装。接下来可以使用划词翻译、截图识别和论文阅读。'
                                : 'Ollama 是在你的电脑上运行 AI 的后台程序。无需账号或 API Key，按下面唯一的主按钮操作即可。'}
                        </p>
                    </div>
                </header>

                {ready ? (
                    <div className='ollama-first-run__ready'>
                        <PiShieldCheck aria-hidden='true' />
                        <div>
                            <strong>内容默认留在本机</strong>
                            <span>普通用户无需修改地址、端口或模型名称。</span>
                        </div>
                    </div>
                ) : (
                    <OllamaOnboardingCard
                        desktop={desktop}
                        invokeCommand={invokeCommand}
                        onStatusChange={handleStatusChange}
                        autoMonitor
                        autoStartService
                    />
                )}

                <footer>
                    {ready ? (
                        <button
                            type='button'
                            className='main-primary-button'
                            onClick={dismiss}
                        >
                            开始使用
                            <PiArrowRight aria-hidden='true' />
                        </button>
                    ) : (
                        <button
                            type='button'
                            className='ollama-first-run__skip'
                            onClick={dismiss}
                        >
                            暂时跳过，仅浏览文献
                        </button>
                    )}
                </footer>
            </section>
        </div>
    );
}
