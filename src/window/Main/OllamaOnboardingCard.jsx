import { useCallback, useEffect, useRef, useState } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import { PiArrowClockwise, PiCheckCircle, PiDownloadSimple, PiGlobe, PiPlay, PiSpinnerGap, PiX } from 'react-icons/pi';

import { UNIFIED_OLLAMA_MODEL } from '../../domains/ollama/runtime';
import { desktopPlatform, getPlatformPresentation } from '../../utils/platform';
import { getRecommendedModelMetadata } from './ollamaModels';

const MODEL_METADATA = getRecommendedModelMetadata(UNIFIED_OLLAMA_MODEL);

const isTauriRuntime = () =>
    Boolean(
        globalThis.window?.__TAURI__ || globalThis.window?.__TAURI_METADATA__ || globalThis.window?.__TAURI_INTERNALS__
    );

function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes <= 0) return '';
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
}

function requestId() {
    return `ollama-pull-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

function SetupStep({ complete, active, title, detail }) {
    return (
        <li className={[complete ? 'is-complete' : '', active ? 'is-active' : ''].filter(Boolean).join(' ')}>
            <span aria-hidden='true'>{complete ? <PiCheckCircle /> : null}</span>
            <div>
                <strong>{title}</strong>
                <small>{detail}</small>
            </div>
        </li>
    );
}

export default function OllamaOnboardingCard({
    desktop = isTauriRuntime(),
    invokeCommand = invoke,
    createChannel = () => new Channel(),
    onStatusChange,
    platform = desktopPlatform,
}) {
    const platformPresentation = getPlatformPresentation(platform);
    const [setup, setSetup] = useState(null);
    const [checking, setChecking] = useState(desktop);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [actionMessage, setActionMessage] = useState('');
    const [confirmingDownload, setConfirmingDownload] = useState(false);
    const [pullProgress, setPullProgress] = useState(null);
    const pullRequestRef = useRef('');

    const publishStatus = useCallback(
        (next) => {
            setSetup(next);
            onStatusChange?.(next);
        },
        [onStatusChange]
    );

    const refresh = useCallback(
        async ({ quiet = false } = {}) => {
            if (!desktop) {
                setChecking(false);
                setActionMessage('桌面版会在这里检测 Ollama、服务与模型状态。');
                return null;
            }
            if (!quiet) setChecking(true);
            setError('');
            try {
                const next = await invokeCommand('ollama_get_setup_status');
                publishStatus(next);
                return next;
            } catch (reason) {
                setError(`检测失败：${String(reason)}`);
                return null;
            } finally {
                if (!quiet) setChecking(false);
            }
        },
        [desktop, invokeCommand, publishStatus]
    );

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const openOfficialDownload = async () => {
        setBusy('download-page');
        setError('');
        try {
            await invokeCommand('ollama_open_official_download');
            setActionMessage('已打开 Ollama 官方下载页。完成安装后请返回并重新检测。');
        } catch (reason) {
            setError(`无法打开官方下载页：${String(reason)}`);
        } finally {
            setBusy('');
        }
    };

    const startService = async () => {
        setBusy('start');
        setError('');
        setActionMessage('');
        try {
            const next = await invokeCommand('ollama_start_local_service');
            publishStatus(next);
            setActionMessage('Ollama 服务已启动。');
        } catch (reason) {
            setError(String(reason));
        } finally {
            setBusy('');
        }
    };

    const pullModel = async () => {
        const currentRequestId = requestId();
        const channel = createChannel();
        pullRequestRef.current = currentRequestId;
        channel.onmessage = (event) => {
            if (event?.requestId !== currentRequestId) return;
            setPullProgress(event);
            setActionMessage(event?.message || '正在下载模型…');
        };
        setConfirmingDownload(false);
        setBusy('pull');
        setError('');
        setActionMessage('正在连接 Ollama 模型仓库…');
        setPullProgress({ requestId: currentRequestId, state: 'running', progress: 0, total: 0, completed: 0 });
        try {
            const next = await invokeCommand('ollama_pull_unified_model', {
                requestId: currentRequestId,
                onEvent: channel,
            });
            publishStatus(next);
            setPullProgress((current) => ({ ...current, state: 'completed', progress: 1 }));
            setActionMessage(next?.modelRunning ? 'Gemma 4 E4B 已下载并预热完成。' : 'Gemma 4 E4B 已下载完成。');
        } catch (reason) {
            const message = String(reason);
            if (message.includes('已取消')) {
                setPullProgress((current) => ({ ...current, state: 'cancelled' }));
                setActionMessage('模型下载已取消，已经下载的可复用分层会由 Ollama 保留。');
            } else {
                setError(message);
            }
        } finally {
            channel.onmessage = () => {};
            if (pullRequestRef.current === currentRequestId) pullRequestRef.current = '';
            setBusy('');
            void refresh({ quiet: true });
        }
    };

    const cancelPull = async () => {
        const currentRequestId = pullRequestRef.current;
        if (!currentRequestId) return;
        setActionMessage('正在取消模型下载…');
        try {
            await invokeCommand('ollama_cancel_model_pull', { requestId: currentRequestId });
        } catch (reason) {
            setError(`取消失败：${String(reason)}`);
        }
    };

    const installComplete = Boolean(setup?.installed || (!setup?.manageable && setup?.running));
    const serviceComplete = Boolean(setup?.running);
    const modelComplete = Boolean(setup?.modelInstalled);
    const activeStep = !installComplete ? 'install' : !serviceComplete ? 'service' : !modelComplete ? 'model' : '';
    const progressPercent = Math.round(Math.min(1, Math.max(0, Number(pullProgress?.progress) || 0)) * 100);
    const transferred = formatBytes(pullProgress?.completed);
    const total = formatBytes(pullProgress?.total);
    const modelSize = MODEL_METADATA?.packageSize ?? '约 6.1 GB';

    return (
        <div className='ollama-onboarding'>
            <div className='ollama-onboarding__heading'>
                <div>
                    <strong>首次接入向导</strong>
                    <span>三步完成本地 AI 配置，不需要密钥</span>
                </div>
                <button
                    type='button'
                    className='ollama-onboarding__refresh'
                    onClick={() => void refresh()}
                    disabled={checking || busy === 'pull'}
                >
                    <PiArrowClockwise
                        className={checking ? 'is-spinning' : ''}
                        aria-hidden='true'
                    />
                    重新检测
                </button>
            </div>

            <ol className='ollama-onboarding__steps'>
                <SetupStep
                    complete={installComplete}
                    active={activeStep === 'install'}
                    title={setup?.manageable === false ? '连接 Ollama' : '安装 Ollama'}
                    detail={
                        setup?.clientVersion ||
                        (installComplete
                            ? '已检测到本机程序'
                            : setup?.manageable === false
                              ? '使用远程服务'
                              : platformPresentation.ollamaInstallDetail)
                    }
                />
                <SetupStep
                    complete={serviceComplete}
                    active={activeStep === 'service'}
                    title='启动服务'
                    detail={
                        setup?.serverVersion
                            ? `服务版本 ${setup.serverVersion}`
                            : platformPresentation.ollamaServiceDetail
                    }
                />
                <SetupStep
                    complete={modelComplete}
                    active={activeStep === 'model'}
                    title='下载模型'
                    detail={`Gemma 4 E4B · ${modelSize}`}
                />
            </ol>

            <div
                className='ollama-onboarding__status'
                aria-live='polite'
            >
                {checking ? (
                    <>
                        <PiSpinnerGap
                            className='is-spinning'
                            aria-hidden='true'
                        />
                        正在检测 Ollama…
                    </>
                ) : modelComplete ? (
                    <>
                        <PiCheckCircle aria-hidden='true' />
                        {setup?.message || '本地 AI 已准备好'}
                    </>
                ) : (
                    setup?.message || actionMessage || '按照上面的步骤完成本地 AI 配置。'
                )}
            </div>

            {busy === 'pull' ? (
                <div className='ollama-onboarding__progress'>
                    <div>
                        <span>{pullProgress?.message || actionMessage || '正在下载模型…'}</span>
                        <strong>{pullProgress?.total ? `${progressPercent}%` : '准备中'}</strong>
                    </div>
                    <progress
                        aria-label='Gemma 4 E4B 下载进度'
                        max='100'
                        value={pullProgress?.total ? progressPercent : undefined}
                    />
                    <div>
                        <small>{transferred && total ? `${transferred} / ${total}` : '下载中可以随时取消'}</small>
                        <button
                            type='button'
                            onClick={() => void cancelPull()}
                        >
                            <PiX aria-hidden='true' />
                            取消下载
                        </button>
                    </div>
                </div>
            ) : null}

            {confirmingDownload ? (
                <div
                    className='ollama-onboarding__confirmation'
                    role='alert'
                >
                    <div>
                        <strong>确认下载{modelSize} 模型？</strong>
                        <span>文件保存在 Ollama 的本地模型目录；取消后已完成的分层可供下次复用。</span>
                    </div>
                    <button
                        type='button'
                        onClick={() => setConfirmingDownload(false)}
                    >
                        暂不下载
                    </button>
                    <button
                        type='button'
                        className='is-primary'
                        onClick={() => void pullModel()}
                    >
                        确认下载
                    </button>
                </div>
            ) : null}

            {!checking && busy !== 'pull' && !confirmingDownload ? (
                <div className='ollama-onboarding__actions'>
                    {setup?.manageable === false ? (
                        <span>远程地址只能检测状态，请在远程设备上安装、启动和下载模型。</span>
                    ) : !installComplete ? (
                        <button
                            type='button'
                            className='is-primary'
                            onClick={() => void openOfficialDownload()}
                            disabled={Boolean(busy)}
                        >
                            {busy === 'download-page' ? (
                                <PiSpinnerGap
                                    className='is-spinning'
                                    aria-hidden='true'
                                />
                            ) : (
                                <PiGlobe aria-hidden='true' />
                            )}
                            {platformPresentation.ollamaDownloadAction}
                        </button>
                    ) : !serviceComplete ? (
                        platformPresentation.canStartOllamaService ? (
                            <button
                                type='button'
                                className='is-primary'
                                onClick={() => void startService()}
                                disabled={Boolean(busy)}
                            >
                                {busy === 'start' ? (
                                    <PiSpinnerGap
                                        className='is-spinning'
                                        aria-hidden='true'
                                    />
                                ) : (
                                    <PiPlay aria-hidden='true' />
                                )}
                                {busy === 'start' ? '启动中…' : '启动 Ollama 服务'}
                            </button>
                        ) : (
                            <span>{platformPresentation.ollamaServiceGuidance}</span>
                        )
                    ) : !modelComplete ? (
                        <button
                            type='button'
                            className='is-primary'
                            onClick={() => setConfirmingDownload(true)}
                        >
                            <PiDownloadSimple aria-hidden='true' />
                            下载 Gemma 4 E4B（{modelSize}）
                        </button>
                    ) : null}
                    {actionMessage && setup?.message ? <span>{actionMessage}</span> : null}
                </div>
            ) : null}

            {error ? (
                <p
                    className='ollama-onboarding__error'
                    role='alert'
                >
                    {error}
                </p>
            ) : null}
        </div>
    );
}
