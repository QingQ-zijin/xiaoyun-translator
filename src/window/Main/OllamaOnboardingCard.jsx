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
        <li
            className={[complete ? 'is-complete' : '', active ? 'is-active' : ''].filter(Boolean).join(' ')}
            aria-current={active ? 'step' : undefined}
        >
            <span aria-hidden='true'>{complete ? <PiCheckCircle /> : null}</span>
            <div>
                <strong>{title}</strong>
                <small>{detail}</small>
                <span className='visually-hidden'>{complete ? '已完成' : active ? '当前步骤' : '未开始'}</span>
            </div>
        </li>
    );
}

function humanizeSetupError(reason, action = '操作') {
    const raw = String(reason ?? '').trim();
    const normalized = raw.toLocaleLowerCase();
    if (/no space|disk full|磁盘空间|空间不足/u.test(normalized)) {
        return '磁盘空间不足。请至少释放 12 GB 空间后重试，已下载的模型分层不会丢失。';
    }
    if (/permission|access denied|拒绝访问|权限/u.test(normalized)) {
        return `${action}被系统权限阻止。请退出 Ollama 和小允翻译后重新打开，再重试。`;
    }
    if (/timeout|timed out|超时/u.test(normalized)) {
        return `${action}等待超时。请先重启 Ollama，再点击“重新检测”。`;
    }
    if (/connect|connection|无法连接|failed to fetch|network|网络/u.test(normalized)) {
        return `${action}无法连接 Ollama。请确认网络可用且 Ollama 正在运行，然后重试。`;
    }
    return raw || `${action}失败，请重试。`;
}

export default function OllamaOnboardingCard({
    desktop = isTauriRuntime(),
    invokeCommand = invoke,
    createChannel = () => new Channel(),
    onStatusChange,
    platform = desktopPlatform,
    autoMonitor = false,
    autoStartService = false,
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
    const autoStartAttemptRef = useRef('');

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
            if (!quiet) {
                setChecking(true);
                setError('');
            }
            try {
                const next = await invokeCommand('ollama_get_setup_status');
                publishStatus(next);
                if (next?.modelRunning) setError('');
                return next;
            } catch (reason) {
                if (!quiet) setError(humanizeSetupError(reason, '检测'));
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
            setActionMessage('已打开官方下载页。完成官方安装后回到这里，软件会自动检测并继续。');
        } catch (reason) {
            setError(humanizeSetupError(reason, '打开官方下载页'));
        } finally {
            setBusy('');
        }
    };

    const startService = useCallback(
        async ({ automatic = false } = {}) => {
            setBusy('start');
            setError('');
            setActionMessage(automatic ? '已检测到 Ollama，正在自动启动后台服务…' : '');
            try {
                const next = await invokeCommand('ollama_start_local_service');
                publishStatus(next);
                setActionMessage(
                    next?.modelRunning
                        ? 'Ollama 服务与 Gemma 4 E4B 已就绪。'
                        : next?.modelInstalled
                          ? 'Ollama 服务已启动。Gemma 4 E4B 已保存，下一步加载模型。'
                          : 'Ollama 服务已启动。下一步只需确认下载模型。'
                );
            } catch (reason) {
                setError(humanizeSetupError(reason, '启动 Ollama'));
            } finally {
                setBusy('');
            }
        },
        [invokeCommand, publishStatus]
    );

    const activateModel = useCallback(async () => {
        setBusy('activate');
        setError('');
        setActionMessage('正在加载 Gemma 4 E4B，第一次可能需要几十秒…');
        try {
            const next = await invokeCommand('ollama_activate_unified_model');
            publishStatus(next);
            setActionMessage('Gemma 4 E4B 已加载并可立即使用。');
        } catch (reason) {
            setError(humanizeSetupError(reason, '加载模型'));
        } finally {
            setBusy('');
        }
    }, [invokeCommand, publishStatus]);

    useEffect(() => {
        if (!autoMonitor || !desktop || checking || busy || setup?.modelRunning) return undefined;
        const timer = globalThis.setTimeout(() => void refresh({ quiet: true }), 2500);
        return () => globalThis.clearTimeout(timer);
    }, [autoMonitor, busy, checking, desktop, refresh, setup?.installed, setup?.modelInstalled, setup?.modelRunning]);

    useEffect(() => {
        if (
            !autoStartService ||
            !desktop ||
            checking ||
            busy ||
            !setup?.manageable ||
            !setup?.installed ||
            setup?.running ||
            !platformPresentation.canStartOllamaService
        ) {
            return;
        }
        const signature = `${setup.executablePath || setup.clientVersion || 'ollama'}:stopped`;
        if (autoStartAttemptRef.current === signature) return;
        autoStartAttemptRef.current = signature;
        void startService({ automatic: true });
    }, [autoStartService, busy, checking, desktop, platformPresentation.canStartOllamaService, setup, startService]);

    useEffect(
        () => () => {
            const activeRequestId = pullRequestRef.current;
            if (activeRequestId) {
                void invokeCommand('ollama_cancel_model_pull', { requestId: activeRequestId }).catch(() => undefined);
            }
        },
        [invokeCommand]
    );

    const pullModel = async () => {
        if (pullRequestRef.current) return;
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
                setError(humanizeSetupError(message, '下载模型'));
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
            setError(humanizeSetupError(reason, '取消下载'));
        }
    };

    const installComplete = Boolean(setup?.installed || (!setup?.manageable && setup?.running));
    const serviceComplete = Boolean(setup?.running);
    const modelInstalled = Boolean(setup?.modelInstalled);
    const modelComplete = Boolean(modelInstalled && setup?.modelRunning);
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
                    disabled={checking || Boolean(busy) || confirmingDownload}
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
                    title={modelInstalled && !modelComplete ? '加载模型' : '下载模型'}
                    detail={modelInstalled ? 'Gemma 4 E4B 已保存，加载后即可使用' : `Gemma 4 E4B · ${modelSize}`}
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
                ) : busy === 'pull' ? (
                    '模型下载中；完成后会自动加载。'
                ) : modelComplete ? (
                    <>
                        <PiCheckCircle aria-hidden='true' />
                        {setup?.message || '本地 AI 已准备好'}
                    </>
                ) : (
                    actionMessage || setup?.message || '按照上面的步骤完成本地 AI 配置。'
                )}
            </div>

            {busy === 'pull' ? (
                <div
                    className='ollama-onboarding__progress'
                    role='status'
                    aria-live='polite'
                >
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
                    role='group'
                    aria-label='确认模型下载'
                >
                    <div>
                        <strong>确认下载{modelSize} 模型？</strong>
                        <span>
                            这是唯一的大文件下载。至少需要 12 GB 可用空间，建议预留 15
                            GB；中断后可以续传，模型只保存在本机。
                        </span>
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
                        autoFocus
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
                    ) : !modelInstalled ? (
                        <button
                            type='button'
                            className='is-primary'
                            onClick={() => setConfirmingDownload(true)}
                        >
                            <PiDownloadSimple aria-hidden='true' />
                            下载 Gemma 4 E4B（{modelSize}）
                        </button>
                    ) : !modelComplete ? (
                        <button
                            type='button'
                            className='is-primary'
                            onClick={() => void activateModel()}
                            disabled={Boolean(busy)}
                        >
                            {busy === 'activate' ? (
                                <PiSpinnerGap
                                    className='is-spinning'
                                    aria-hidden='true'
                                />
                            ) : (
                                <PiPlay aria-hidden='true' />
                            )}
                            {busy === 'activate' ? '正在加载…' : '加载 Gemma 4 E4B'}
                        </button>
                    ) : null}
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
