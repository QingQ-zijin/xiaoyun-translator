import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
    HiOutlineBookOpen,
    HiOutlineChevronLeft,
    HiOutlineClipboardCopy,
    HiOutlineCog,
    HiOutlineChip,
    HiOutlineRefresh,
    HiOutlineSpeakerphone,
    HiOutlineSwitchHorizontal,
    HiOutlineTranslate,
    HiOutlineTrash,
    HiX,
} from 'react-icons/hi';
import { HiOutlineLanguage } from 'react-icons/hi2';
import { BsPinAngle, BsPinAngleFill } from 'react-icons/bs';

import { extractText, loadOllamaVisionConfig } from '../../domains/vision';
import {
    getLanguageLabel,
    LANGUAGE_OPTIONS,
    loadOllamaTranslationConfig,
    resolveAcademicTargetLanguage,
    synthesizeSpeech,
    translateAcademic,
} from '../../domains/translation';
import { useVoice } from '../../hooks/useVoice';
import { writeClipboardText } from '../../utils/clipboard';
import {
    acceptSelectionRequestId,
    hideTranslationWindow,
    hideTranslationWindowOnBlur,
    TRANSLATION_WINDOW_HIDE_EVENT,
} from '../../utils/translation_flow';
import './translate.css';
const appWindow = getCurrentWebviewWindow();

// 富文本与 KaTeX 只在首批译文到达后加载，取词窗口的 ready 握手无需等待大依赖。
const FormattedTranslation = lazy(() => import('./components/FormattedTranslation'));

function prefetchFormattedTranslation() {
    return import('./components/FormattedTranslation');
}

const WINDOW_STATES = Object.freeze({
    idle: '等待输入',
    capturing: '正在读取选区…',
    recognizing: '正在识别截图…',
    translating: '正在翻译…',
    ready: '翻译完成',
    error: '需要处理',
});

function IconButton({ label, active = false, className = '', children, ...props }) {
    return (
        <button
            type='button'
            title={label}
            aria-label={label}
            aria-pressed={active}
            className={`quick-icon-button ${active ? 'is-active' : ''} ${className}`}
            {...props}
        >
            {children}
        </button>
    );
}

async function copyText(value) {
    await writeClipboardText(value);
}

function startWindowDrag(event) {
    if (event.button !== 0 || event.target.closest('button, input, textarea, select, a')) return;
    appWindow.startDragging().catch((cause) => console.warn('移动快捷翻译窗口失败：', cause));
}

export default function Translate() {
    const [settingsV2, setSettingsV2] = useState(null);
    const [sourceLanguage, setSourceLanguage] = useState('auto');
    const [targetLanguage, setTargetLanguage] = useState('zh_cn');
    const [sourceText, setSourceText] = useState('');
    const [result, setResult] = useState('');
    const [error, setError] = useState('');
    const [windowState, setWindowState] = useState('idle');
    const [drawer, setDrawer] = useState(null);
    const [pinned, setPinned] = useState(false);
    const [translationConfig, setTranslationConfig] = useState(null);
    const [visionConfig, setVisionConfig] = useState(null);
    const translateAbortRef = useRef(null);
    const requestGenerationRef = useRef(0);
    const nativeSelectionRequestRef = useRef(0);
    const dismissedSelectionRequestRef = useRef(0);
    const dismissingRef = useRef(false);
    const busyRef = useRef(false);
    const shownAtRef = useRef(Date.now());
    const presentationGenerationRef = useRef(0);
    const sourceTextRef = useRef('');
    const ollamaEnabledRef = useRef(true);
    const playVoice = useVoice();
    const closeOnBlur = settingsV2?.window?.hideOnBlur ?? true;
    const blurGuardMs = settingsV2?.window?.blurGuardMs ?? 500;
    const fontSize = 16;

    const setState = useCallback((next) => {
        busyRef.current = ['capturing', 'recognizing', 'translating'].includes(next);
        setWindowState(next);
    }, []);

    const handleTranslationWindowHide = useCallback(
        (event) => {
            const requestId = Number(event?.detail?.requestId);
            if (Number.isSafeInteger(requestId) && requestId > 0) {
                dismissedSelectionRequestRef.current = Math.max(dismissedSelectionRequestRef.current, requestId);
            }
            presentationGenerationRef.current += 1;
            requestGenerationRef.current += 1;
            translateAbortRef.current?.abort();
            translateAbortRef.current = null;
            setState('idle');
        },
        [setState]
    );

    const acceptNativePayload = useCallback((payload) => {
        const requestId = Number(payload?.requestId);
        if (!Number.isSafeInteger(requestId) || requestId <= 0) return true;
        if (requestId < nativeSelectionRequestRef.current || requestId <= dismissedSelectionRequestRef.current) {
            return false;
        }
        nativeSelectionRequestRef.current = requestId;
        acceptSelectionRequestId(requestId);
        dismissingRef.current = false;
        return true;
    }, []);

    const runTranslation = useCallback(
        async (nextText = sourceTextRef.current) => {
            const text = String(nextText ?? '').trim();
            if (!text) return;
            if (!ollamaEnabledRef.current) {
                setResult('');
                setError('Ollama 后端已关闭。请在“设置 → Ollama”中开启后再翻译。');
                setState('error');
                return;
            }
            const generation = ++requestGenerationRef.current;
            translateAbortRef.current?.abort();
            const controller = new AbortController();
            translateAbortRef.current = controller;
            setError('');
            setResult('');
            setState('translating');
            const effectiveTargetLanguage = resolveAcademicTargetLanguage(text, targetLanguage || 'zh_cn');
            if (effectiveTargetLanguage !== targetLanguage) setTargetLanguage(effectiveTargetLanguage);
            try {
                const finalResult = await translateAcademic({
                    text,
                    sourceLanguage: sourceLanguage || 'auto',
                    targetLanguage: effectiveTargetLanguage,
                    signal: controller.signal,
                    onDelta: (value) => {
                        if (generation === requestGenerationRef.current) setResult(value);
                    },
                });
                if (generation !== requestGenerationRef.current) return;
                setResult(finalResult);
                setState('ready');
            } catch (cause) {
                if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
                setError(String(cause?.message ?? cause));
                setState('error');
            }
        },
        [sourceLanguage, targetLanguage, setState]
    );

    useEffect(() => {
        sourceTextRef.current = sourceText;
    }, [sourceText]);

    useEffect(() => {
        window.addEventListener(TRANSLATION_WINDOW_HIDE_EVENT, handleTranslationWindowHide);
        return () => {
            window.removeEventListener(TRANSLATION_WINDOW_HIDE_EVENT, handleTranslationWindowHide);
        };
    }, [handleTranslationWindowHide]);

    const handleScreenshot = useCallback(async () => {
        const generation = ++requestGenerationRef.current;
        translateAbortRef.current?.abort();
        const controller = new AbortController();
        translateAbortRef.current = controller;
        sourceTextRef.current = '';
        setSourceText('');
        setError('');
        setResult('');
        setState('recognizing');
        try {
            const image = await invoke('get_base64');
            const text = await extractText({ image, signal: controller.signal, language: 'auto' });
            if (generation !== requestGenerationRef.current) return;
            setSourceText(text);
            await runTranslation(text);
        } catch (cause) {
            if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
            sourceTextRef.current = '';
            setSourceText('');
            setResult('');
            setError(String(cause?.message ?? cause));
            setState('error');
        }
    }, [runTranslation, setState]);

    const handleIncomingText = useCallback(
        async (payload) => {
            if (!acceptNativePayload(payload)) return;
            const text = String(payload?.text ?? payload ?? '').trim();
            if (text === '[INPUT_TRANSLATE]') {
                requestGenerationRef.current += 1;
                translateAbortRef.current?.abort();
                setSourceText('');
                setResult('');
                setError('');
                setState('idle');
                return;
            }
            if (text === '[IMAGE_TRANSLATE]') {
                await handleScreenshot();
                return;
            }
            if (!text) {
                setState('capturing');
                return;
            }
            setSourceText(text);
            await runTranslation(text);
        },
        [acceptNativePayload, handleScreenshot, runTranslation, setState]
    );
    const handleIncomingTextRef = useRef(handleIncomingText);
    handleIncomingTextRef.current = handleIncomingText;

    const applyCaptureState = useCallback(
        (payload) => {
            if (!acceptNativePayload(payload)) return;
            const state = payload?.state ?? payload;
            if (state === 'capturing') {
                shownAtRef.current = Date.now();
                // 每次 Ctrl+D 都使上一轮失焦隐藏计时器失效，避免第二次刚弹出又被旧计时器关闭。
                presentationGenerationRef.current += 1;
                setError('');
            }
            if (WINDOW_STATES[state]) setState(state);
            if (payload?.message) setError(payload.message);
        },
        [acceptNativePayload, setState]
    );

    useEffect(() => {
        let disposed = false;
        const cleanups = [];
        void Promise.all([
            loadOllamaTranslationConfig(),
            loadOllamaVisionConfig(),
            invoke('get_settings_v2').catch(() => null),
        ]).then(([translation, vision, settings]) => {
            if (disposed) return;
            setTranslationConfig(translation);
            setVisionConfig(vision);
            if (settings) {
                ollamaEnabledRef.current = settings.ollama?.enabled !== false;
                setSettingsV2(settings);
                setSourceLanguage(settings.sourceLanguage || 'auto');
                setTargetLanguage(settings.targetLanguage || 'zh_cn');
                const shouldPin = Boolean(settings.window?.pinByDefault);
                setPinned(shouldPin);
                void appWindow.setAlwaysOnTop(shouldPin);
            }
        });

        const setupEventListeners = async () => {
            // 新文本与状态是快捷键链路的必要监听器；只有二者都建立后才完成 ready 握手。
            const requiredUnlisteners = await Promise.all([
                listen('new_text', (event) => {
                    void handleIncomingTextRef.current(event.payload);
                }),
                listen('selection_capture_state', (event) => {
                    applyCaptureState(event.payload);
                }),
            ]);
            const settingsUnlisten = await listen('settings_v2_changed', (event) => {
                const settings = event.payload;
                if (!settings) return;
                ollamaEnabledRef.current = settings.ollama?.enabled !== false;
                setSettingsV2(settings);
                setSourceLanguage(settings.sourceLanguage || 'auto');
                setTargetLanguage(settings.targetLanguage || 'zh_cn');
            }).catch((cause) => {
                console.warn('监听设置变更失败，不影响快捷翻译：', cause);
                return null;
            });
            const unlisteners = settingsUnlisten ? [...requiredUnlisteners, settingsUnlisten] : requiredUnlisteners;
            if (disposed) {
                unlisteners.forEach((unlisten) => unlisten());
                return;
            }
            cleanups.push(...unlisteners);

            // ready 返回启动阶段缓存的最后一条事件，避免监听器注册与首个 emit 之间的竞态。
            let bootstrap = null;
            let lastError = null;
            for (let attempt = 0; attempt < 3; attempt += 1) {
                try {
                    bootstrap = await invoke('translate_window_ready');
                    lastError = null;
                    break;
                } catch (cause) {
                    lastError = cause;
                    await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
                }
            }
            if (lastError) throw lastError;
            // ready 之后再空闲预取富文本排版模块，不延长窗口握手，也避免首 token 到达后才下载大块代码。
            const schedulePrefetch = globalThis.requestIdleCallback ?? ((callback) => setTimeout(callback, 0));
            schedulePrefetch(() => void prefetchFormattedTranslation());
            if (disposed || !bootstrap) return;
            applyCaptureState(bootstrap);
            if (bootstrap.text) await handleIncomingTextRef.current(bootstrap);
        };
        void setupEventListeners().catch((cause) => {
            if (disposed) return;
            setError(`初始化快捷翻译事件失败：${String(cause)}`);
            setState('error');
        });
        return () => {
            disposed = true;
            translateAbortRef.current?.abort();
            cleanups.forEach((cleanup) => cleanup());
        };
    }, [applyCaptureState, setState]);

    useEffect(() => {
        if (!closeOnBlur || pinned) return undefined;
        let timeout = null;
        const cleanups = [];
        appWindow
            .onFocusChanged(({ payload: focused }) => {
                if (focused) {
                    clearTimeout(timeout);
                    return;
                }
                if (busyRef.current) return;
                clearTimeout(timeout);
                const presentationGeneration = presentationGenerationRef.current;
                const elapsed = Date.now() - shownAtRef.current;
                const remainingGuard = Math.max(0, blurGuardMs - elapsed);
                timeout = setTimeout(() => {
                    if (presentationGeneration === presentationGenerationRef.current && !busyRef.current) {
                        void hideTranslationWindowOnBlur(appWindow);
                    }
                }, remainingGuard);
            })
            .then((unlisten) => cleanups.push(unlisten));
        return () => {
            clearTimeout(timeout);
            cleanups.forEach((cleanup) => cleanup());
        };
    }, [blurGuardMs, closeOnBlur, pinned]);

    const persistLanguages = (nextSource, nextTarget) => {
        if (!settingsV2) return;
        const nextSettings = {
            ...settingsV2,
            sourceLanguage: nextSource,
            targetLanguage: nextTarget,
        };
        setSettingsV2(nextSettings);
        void invoke('update_settings_v2', { settings: nextSettings }).catch((reason) => {
            setError(`保存语言设置失败：${String(reason)}`);
            setState('error');
        });
    };

    const swapLanguages = () => {
        if (sourceLanguage === 'auto') {
            const nextTarget = targetLanguage === 'zh_cn' ? 'en' : 'zh_cn';
            setTargetLanguage(nextTarget);
            persistLanguages(sourceLanguage, nextTarget);
            return;
        }
        const previousSource = sourceLanguage;
        setSourceLanguage(targetLanguage);
        setTargetLanguage(previousSource);
        persistLanguages(targetLanguage, previousSource);
    };

    const speak = async (text, language) => {
        try {
            const bytes = await synthesizeSpeech({ text, language });
            await playVoice(bytes);
        } catch (cause) {
            setError(String(cause?.message ?? cause));
            setState('error');
        }
    };

    const requestWindowDismiss = () => {
        if (dismissingRef.current) return;
        dismissingRef.current = true;
        void hideTranslationWindow(appWindow).finally(() => {
            dismissingRef.current = false;
        });
    };

    return (
        <div className='quick-translate-shell'>
            <aside
                className='quick-rail'
                data-tauri-drag-region='true'
                onPointerDown={startWindowDrag}
            >
                <img
                    className='quick-rail__logo'
                    src='/icon.png'
                    alt='小允翻译'
                />
                <div className='quick-rail__tools'>
                    <IconButton
                        label='语言'
                        active={drawer === 'language'}
                        onClick={() => setDrawer(drawer === 'language' ? null : 'language')}
                    >
                        <HiOutlineLanguage />
                    </IconButton>
                    <IconButton
                        label='模型'
                        active={drawer === 'model'}
                        onClick={() => setDrawer(drawer === 'model' ? null : 'model')}
                    >
                        <HiOutlineChip />
                    </IconButton>
                    <IconButton
                        label='论文库'
                        onClick={() => invoke('open_main_window').catch(() => undefined)}
                    >
                        <HiOutlineBookOpen />
                    </IconButton>
                    <IconButton
                        label='设置'
                        onClick={() => invoke('open_main_window', { route: 'settings' }).catch(() => undefined)}
                    >
                        <HiOutlineCog />
                    </IconButton>
                </div>
                <div className='quick-rail__bottom'>
                    <IconButton
                        label={pinned ? '取消置顶' : '置顶'}
                        active={pinned}
                        onClick={async () => {
                            const next = !pinned;
                            await appWindow.setAlwaysOnTop(next);
                            setPinned(next);
                        }}
                    >
                        {pinned ? <BsPinAngleFill /> : <BsPinAngle />}
                    </IconButton>
                </div>
            </aside>

            <main className='quick-main'>
                <header
                    className='quick-titlebar'
                    onPointerDown={startWindowDrag}
                >
                    <div className='quick-titlebar__identity'>
                        <strong>小允翻译</strong>
                        <span className={`quick-status quick-status--${windowState}`}>
                            <i /> {WINDOW_STATES[windowState]}
                        </span>
                    </div>
                    <button
                        type='button'
                        className='quick-window-close'
                        aria-label='关闭翻译窗口'
                        onClick={(event) => {
                            event.stopPropagation();
                            // 必须等完整点击结束后再调用原生隐藏。若在 pointerdown 捕获阶段隐藏，
                            // Windows/WebView 仍持有本轮指针激活，窗口会停留到下一次失焦才消失。
                            requestWindowDismiss();
                        }}
                    >
                        <HiX />
                    </button>
                </header>

                <section
                    className='quick-source'
                    aria-label='原文'
                >
                    <div className='quick-section-heading'>
                        <span>原文</span>
                        <div>
                            <IconButton
                                label='朗读原文'
                                onClick={() => speak(sourceText, sourceLanguage)}
                            >
                                <HiOutlineSpeakerphone />
                            </IconButton>
                            <IconButton
                                label='复制原文'
                                onClick={() => copyText(sourceText)}
                            >
                                <HiOutlineClipboardCopy />
                            </IconButton>
                            <IconButton
                                label='清空'
                                onClick={() => {
                                    requestGenerationRef.current += 1;
                                    translateAbortRef.current?.abort();
                                    setSourceText('');
                                    setResult('');
                                    setError('');
                                    setState('idle');
                                }}
                            >
                                <HiOutlineTrash />
                            </IconButton>
                        </div>
                    </div>
                    <textarea
                        value={sourceText}
                        autoFocus={false}
                        spellCheck={false}
                        placeholder='选择文字后按 Ctrl+D，或在这里输入…'
                        onChange={(event) => setSourceText(event.target.value)}
                        onKeyDown={(event) => {
                            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') runTranslation();
                        }}
                    />
                    <button
                        type='button'
                        className='quick-translate-action'
                        onClick={() => runTranslation()}
                        disabled={!sourceText.trim()}
                    >
                        <HiOutlineTranslate />
                        翻译
                    </button>
                </section>

                <section
                    className='quick-result'
                    aria-label='译文'
                >
                    <div className='quick-section-heading'>
                        <span>译文</span>
                        <div>
                            <IconButton
                                label='重新翻译'
                                onClick={() => runTranslation()}
                            >
                                <HiOutlineRefresh />
                            </IconButton>
                            <IconButton
                                label='朗读译文'
                                onClick={() => speak(result, targetLanguage)}
                            >
                                <HiOutlineSpeakerphone />
                            </IconButton>
                            <IconButton
                                label='复制译文'
                                onClick={() => copyText(result)}
                            >
                                <HiOutlineClipboardCopy />
                            </IconButton>
                        </div>
                    </div>
                    <div className='quick-result__body'>
                        {error ? <div className='quick-error'>{error}</div> : null}
                        {!error && !result && windowState === 'translating' ? (
                            <div
                                className='quick-loading'
                                aria-label='正在翻译'
                            >
                                <span />
                                <span />
                                <span />
                            </div>
                        ) : null}
                        {!error && result ? (
                            <Suspense fallback={<p className='quick-empty'>正在排版译文…</p>}>
                                <FormattedTranslation
                                    value={result}
                                    fontSize={fontSize || 16}
                                />
                            </Suspense>
                        ) : null}
                        {!error && !result && !busyRef.current ? (
                            <p className='quick-empty'>译文会在这里流式显示。</p>
                        ) : null}
                    </div>
                </section>
            </main>

            {drawer ? (
                <div
                    className='quick-drawer'
                    role='dialog'
                    aria-label={drawer === 'language' ? '语言设置' : '模型状态'}
                >
                    <div className='quick-drawer__header'>
                        <button
                            type='button'
                            aria-label='收起侧栏'
                            onClick={() => setDrawer(null)}
                        >
                            <HiOutlineChevronLeft />
                        </button>
                        <strong>{drawer === 'language' ? '语言' : '本地模型'}</strong>
                    </div>
                    {drawer === 'language' ? (
                        <div className='quick-language-settings'>
                            <label>
                                <span>原文语言</span>
                                <select
                                    value={sourceLanguage || 'auto'}
                                    onChange={(event) => {
                                        const value = event.target.value;
                                        setSourceLanguage(value);
                                        persistLanguages(value, targetLanguage);
                                    }}
                                >
                                    {LANGUAGE_OPTIONS.map((language) => (
                                        <option
                                            key={language.value}
                                            value={language.value}
                                        >
                                            {language.label}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <button
                                type='button'
                                className='quick-swap'
                                onClick={swapLanguages}
                            >
                                <HiOutlineSwitchHorizontal />
                                交换语言
                            </button>
                            <label>
                                <span>译文语言</span>
                                <select
                                    value={targetLanguage || 'zh_cn'}
                                    onChange={(event) => {
                                        const value = event.target.value;
                                        setTargetLanguage(value);
                                        persistLanguages(sourceLanguage, value);
                                    }}
                                >
                                    {LANGUAGE_OPTIONS.filter((language) => language.value !== 'auto').map(
                                        (language) => (
                                            <option
                                                key={language.value}
                                                value={language.value}
                                            >
                                                {language.label}
                                            </option>
                                        )
                                    )}
                                </select>
                            </label>
                            <p>
                                {getLanguageLabel(sourceLanguage || 'auto')} →{' '}
                                {getLanguageLabel(targetLanguage || 'zh_cn')}
                            </p>
                        </div>
                    ) : (
                        <div className='quick-model-settings'>
                            <div>
                                <span className='model-dot is-ready' />
                                <p>
                                    <strong>Gemma 4 E4B</strong>
                                    <small>{translationConfig?.model ?? '加载中…'}</small>
                                </p>
                            </div>
                            <div>
                                <span className='model-dot is-ready' />
                                <p>
                                    <strong>Qwen3-VL</strong>
                                    <small>{visionConfig?.model ?? '加载中…'}</small>
                                </p>
                            </div>
                            <div>
                                <span className='model-dot is-local' />
                                <p>
                                    <strong>Windows 本地语音</strong>
                                    <small>离线朗读</small>
                                </p>
                            </div>
                        </div>
                    )}
                </div>
            ) : null}
        </div>
    );
}
