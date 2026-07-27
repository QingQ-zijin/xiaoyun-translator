import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
    PiArrowsLeftRight,
    PiCheckCircle,
    PiCopy,
    PiPaperPlaneRight,
    PiSpeakerHigh,
    PiSpinnerGap,
    PiTrash,
    PiWarningCircle,
} from 'react-icons/pi';

import { resolveAcademicTargetLanguage, synthesizeSpeech, translateAcademic } from '../../domains/translation';
import { UNIFIED_OLLAMA_MODEL } from '../../domains/ollama/runtime';
import { useVoice } from '../../hooks/useVoice';
import { writeClipboardText } from '../../utils/clipboard';
import { formatShortcutForPlatform } from '../../utils/platform';
import FormattedTranslation from '../Translate/components/FormattedTranslation';

const INPUT_TRANSLATE_SHORTCUT = formatShortcutForPlatform('CommandOrControl+Enter');

const LANGUAGE_OPTIONS = [
    { value: 'auto', label: '自动检测' },
    { value: 'zh_cn', label: '简体中文' },
    { value: 'zh_tw', label: '繁体中文' },
    { value: 'en', label: '英语' },
    { value: 'ja', label: '日语' },
    { value: 'ko', label: '韩语' },
    { value: 'de', label: '德语' },
    { value: 'fr', label: '法语' },
    { value: 'es', label: '西班牙语' },
    { value: 'ru', label: '俄语' },
];

const isTauriRuntime = () =>
    Boolean(
        globalThis.window?.__TAURI__ || globalThis.window?.__TAURI_METADATA__ || globalThis.window?.__TAURI_INTERNALS__
    );

function WorkspaceStatus({ state, error, runtimeStatus, backendReady, backendChecking, onOpenSettings }) {
    if (state === 'translating') {
        return (
            <span className='translate-workspace__status is-busy'>
                <PiSpinnerGap aria-hidden='true' />
                {runtimeStatus || '翻译中'}
            </span>
        );
    }
    if (state === 'ready') {
        return (
            <span className='translate-workspace__status is-ready'>
                <PiCheckCircle aria-hidden='true' />
                已完成
            </span>
        );
    }
    if (state === 'error') {
        return (
            <span
                className='translate-workspace__status is-error'
                title={error}
            >
                <PiWarningCircle aria-hidden='true' />
                翻译失败
            </span>
        );
    }
    if (backendChecking) {
        return (
            <span className='translate-workspace__status is-busy'>
                <PiSpinnerGap aria-hidden='true' />
                正在检测本地 AI
            </span>
        );
    }
    if (!backendReady) {
        return (
            <button
                type='button'
                className='translate-workspace__status is-error'
                onClick={onOpenSettings}
            >
                <PiWarningCircle aria-hidden='true' />
                完成本地 AI 设置
            </button>
        );
    }
    return (
        <span className='translate-workspace__status'>
            <i />
            Gemma 4 E4B 就绪
        </span>
    );
}

function isBackendUnavailableError(error) {
    return /无法连接本地翻译服务|Ollama.+(?:已退出|自动恢复失败|已关闭)|统一模型.+尚未安装|本地 AI.+未准备/iu.test(
        String(error ?? '')
    );
}

export default function TranslationWorkspace({
    onNavigate,
    desktop = isTauriRuntime(),
    invokeCommand = invoke,
    statusPollMs = 2500,
}) {
    const [sourceText, setSourceText] = useState('');
    const [result, setResult] = useState('');
    const [sourceLanguage, setSourceLanguage] = useState('auto');
    const [targetLanguage, setTargetLanguage] = useState('zh_cn');
    const [paperTitle, setPaperTitle] = useState('');
    const [contextBefore, setContextBefore] = useState('');
    const [contextAfter, setContextAfter] = useState('');
    const [state, setState] = useState('idle');
    const [error, setError] = useState('');
    const [runtimeStatus, setRuntimeStatus] = useState('');
    const [copyState, setCopyState] = useState('复制');
    const [modelName, setModelName] = useState(UNIFIED_OLLAMA_MODEL);
    const [backendReady, setBackendReady] = useState(!desktop);
    const [backendChecking, setBackendChecking] = useState(desktop);
    const requestRef = useRef(null);
    const playVoice = useVoice();

    useEffect(() => {
        const handleOllamaReady = () => {
            setBackendReady(true);
            setBackendChecking(false);
        };
        globalThis.addEventListener?.('xiaoyun:ollama-ready', handleOllamaReady);
        if (desktop) {
            void Promise.all([invokeCommand('get_settings_v2'), invokeCommand('ollama_get_setup_status')])
                .then(([settings, status]) => {
                    setSourceLanguage(settings?.sourceLanguage ?? 'auto');
                    setTargetLanguage(settings?.targetLanguage ?? 'zh_cn');
                    setModelName(settings?.ollama?.translation?.model ?? UNIFIED_OLLAMA_MODEL);
                    setBackendReady(settings?.ollama?.enabled !== false && Boolean(status?.modelRunning));
                })
                .catch(() => setBackendReady(false))
                .finally(() => setBackendChecking(false));
        }
        return () => {
            requestRef.current?.abort();
            globalThis.removeEventListener?.('xiaoyun:ollama-ready', handleOllamaReady);
        };
    }, [desktop, invokeCommand]);

    useEffect(() => {
        if (!desktop || backendChecking || backendReady) return undefined;
        let cancelled = false;
        let timer;
        const poll = async () => {
            try {
                const [settings, status] = await Promise.all([
                    invokeCommand('get_settings_v2'),
                    invokeCommand('ollama_get_setup_status'),
                ]);
                if (cancelled) return;
                const readyNow = settings?.ollama?.enabled !== false && Boolean(status?.modelRunning);
                setBackendReady(readyNow);
                if (readyNow) return;
            } catch {
                if (cancelled) return;
            }
            timer = globalThis.setTimeout(() => void poll(), statusPollMs);
        };
        timer = globalThis.setTimeout(() => void poll(), statusPollMs);
        return () => {
            cancelled = true;
            globalThis.clearTimeout(timer);
        };
    }, [backendChecking, backendReady, desktop, invokeCommand, statusPollMs]);

    const runTranslation = useCallback(async () => {
        const text = sourceText.trim();
        if (!text) {
            setError('请先输入需要翻译的内容。');
            setState('error');
            return;
        }

        requestRef.current?.abort();
        const controller = new AbortController();
        requestRef.current = controller;
        setResult('');
        setError('');
        setRuntimeStatus('');
        setState('translating');
        const effectiveTargetLanguage = resolveAcademicTargetLanguage(text, targetLanguage);
        if (effectiveTargetLanguage !== targetLanguage) setTargetLanguage(effectiveTargetLanguage);
        try {
            const translated = await translateAcademic({
                text,
                sourceLanguage,
                targetLanguage: effectiveTargetLanguage,
                paperTitle,
                contextBefore,
                contextAfter,
                signal: controller.signal,
                onDelta: (nextText) => {
                    if (!controller.signal.aborted) setResult(nextText);
                },
                onStatus: (message) => {
                    if (!controller.signal.aborted) setRuntimeStatus(message);
                },
            });
            if (!controller.signal.aborted) {
                setResult(translated);
                setRuntimeStatus('');
                setBackendReady(true);
                setBackendChecking(false);
                setState('ready');
            }
        } catch (reason) {
            if (controller.signal.aborted || reason?.name === 'AbortError') return;
            const message = String(reason?.message ?? reason);
            setRuntimeStatus('');
            if (isBackendUnavailableError(message)) setBackendReady(false);
            setBackendChecking(false);
            setError(message);
            setState('error');
        }
    }, [contextAfter, contextBefore, paperTitle, sourceLanguage, sourceText, targetLanguage]);

    const swapLanguages = () => {
        if (sourceLanguage === 'auto') {
            setTargetLanguage((current) => (current === 'zh_cn' ? 'en' : 'zh_cn'));
            return;
        }
        setSourceLanguage(targetLanguage);
        setTargetLanguage(sourceLanguage);
        setSourceText(result || sourceText);
        setResult(sourceText);
    };

    const copyResult = async () => {
        if (!result) return;
        await writeClipboardText(result);
        setCopyState('已复制');
        setTimeout(() => setCopyState('复制'), 1300);
    };

    const speakResult = async () => {
        if (!result) return;
        try {
            const bytes = await synthesizeSpeech({ text: result, language: targetLanguage });
            await playVoice(bytes);
        } catch (reason) {
            setError(`本地朗读失败：${String(reason?.message ?? reason)}`);
            setState('error');
        }
    };

    const clearAll = () => {
        requestRef.current?.abort();
        setSourceText('');
        setResult('');
        setError('');
        setRuntimeStatus('');
        setState('idle');
    };

    return (
        <section className='main-page main-page--translate'>
            <header className='main-page__header'>
                <div>
                    <h1>学术翻译</h1>
                    <p>保留论文术语、Markdown 与 LaTeX，只输出译文。</p>
                </div>
                <WorkspaceStatus
                    state={state}
                    error={error}
                    runtimeStatus={runtimeStatus}
                    backendReady={backendReady}
                    backendChecking={backendChecking}
                    onOpenSettings={() => onNavigate?.('settings')}
                />
            </header>

            <div className='translate-workspace'>
                <div className='translate-workspace__toolbar'>
                    <label>
                        <span className='visually-hidden'>原文语言</span>
                        <select
                            value={sourceLanguage}
                            onChange={(event) => setSourceLanguage(event.target.value)}
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
                        className='translate-workspace__swap'
                        type='button'
                        onClick={swapLanguages}
                        aria-label='交换翻译语言'
                    >
                        <PiArrowsLeftRight aria-hidden='true' />
                    </button>
                    <label>
                        <span className='visually-hidden'>译文语言</span>
                        <select
                            value={targetLanguage}
                            onChange={(event) => setTargetLanguage(event.target.value)}
                        >
                            {LANGUAGE_OPTIONS.filter((language) => language.value !== 'auto').map((language) => (
                                <option
                                    key={language.value}
                                    value={language.value}
                                >
                                    {language.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <span className='translate-workspace__model'>{modelName} · 本地 Ollama</span>
                </div>

                <div className='translate-workspace__columns'>
                    <article className='translate-panel translate-panel--source'>
                        <div className='translate-panel__heading'>
                            <strong>原文</strong>
                            <button
                                type='button'
                                onClick={clearAll}
                                disabled={!sourceText && !result}
                            >
                                <PiTrash aria-hidden='true' />
                                清空
                            </button>
                        </div>
                        <textarea
                            autoFocus
                            value={sourceText}
                            onChange={(event) => setSourceText(event.target.value)}
                            onKeyDown={(event) => {
                                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                                    event.preventDefault();
                                    void runTranslation();
                                }
                            }}
                            placeholder={`粘贴论文段落，按 ${INPUT_TRANSLATE_SHORTCUT} 开始翻译…`}
                            spellCheck='false'
                        />
                        <span className='translate-panel__count'>{sourceText.length.toLocaleString()} 字符</span>
                    </article>

                    <article
                        className='translate-panel translate-panel--result'
                        aria-live='polite'
                    >
                        <div className='translate-panel__heading'>
                            <strong>译文</strong>
                            <div>
                                <button
                                    type='button'
                                    onClick={speakResult}
                                    disabled={!result}
                                >
                                    <PiSpeakerHigh aria-hidden='true' />
                                    朗读
                                </button>
                                <button
                                    type='button'
                                    onClick={copyResult}
                                    disabled={!result}
                                >
                                    <PiCopy aria-hidden='true' />
                                    {copyState}
                                </button>
                            </div>
                        </div>
                        <div className={`translate-panel__output ${!result ? 'is-empty' : ''}`}>
                            {result ? (
                                <FormattedTranslation
                                    value={result}
                                    fontSize={17}
                                />
                            ) : (
                                <div className='translate-panel__placeholder'>
                                    <PiTranslatePlaceholder />
                                    <p>译文会在模型生成时实时出现</p>
                                    <span>变量、公式、引文与数字将按原格式保留</span>
                                </div>
                            )}
                        </div>
                        {error ? <p className='translate-panel__error'>{error}</p> : null}
                    </article>
                </div>

                <div className='translate-workspace__footer'>
                    <details>
                        <summary>添加论文上下文以改善术语消歧</summary>
                        <div className='translate-context'>
                            <label>
                                <span>论文标题</span>
                                <input
                                    value={paperTitle}
                                    onChange={(event) => setPaperTitle(event.target.value)}
                                    placeholder='选填，只用于消歧'
                                />
                            </label>
                            <label>
                                <span>选区前文</span>
                                <input
                                    value={contextBefore}
                                    onChange={(event) => setContextBefore(event.target.value)}
                                    placeholder='不会被翻译'
                                />
                            </label>
                            <label>
                                <span>选区后文</span>
                                <input
                                    value={contextAfter}
                                    onChange={(event) => setContextAfter(event.target.value)}
                                    placeholder='不会被翻译'
                                />
                            </label>
                        </div>
                    </details>
                    <button
                        className='main-primary-button'
                        type='button'
                        onClick={runTranslation}
                        disabled={state === 'translating' || !sourceText.trim()}
                    >
                        {state === 'translating' ? (
                            <PiSpinnerGap
                                className='is-spinning'
                                aria-hidden='true'
                            />
                        ) : (
                            <PiPaperPlaneRight aria-hidden='true' />
                        )}
                        {state === 'translating' ? '正在翻译' : backendReady ? '开始翻译' : '启动并翻译'}
                    </button>
                </div>
            </div>
        </section>
    );
}

function PiTranslatePlaceholder() {
    return <PiArrowsLeftRight aria-hidden='true' />;
}
