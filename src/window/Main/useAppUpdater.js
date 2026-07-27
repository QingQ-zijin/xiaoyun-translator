import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DESKTOP_PLATFORM, desktopPlatform } from '../../utils/platform';

const DEFAULT_STARTUP_DELAY_MS = 1_500;
const UPDATE_CHECK_TIMEOUT_MS = 15_000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

const loadUpdaterPlugin = () => import('@tauri-apps/plugin-updater');
const loadProcessPlugin = () => import('@tauri-apps/plugin-process');
const loadAppApi = () => import('@tauri-apps/api/app');

export const APP_UPDATE_PHASE = Object.freeze({
    IDLE: 'idle',
    CHECKING: 'checking',
    UP_TO_DATE: 'upToDate',
    AVAILABLE: 'available',
    DOWNLOADING: 'downloading',
    INSTALLING: 'installing',
    READY_TO_RELAUNCH: 'readyToRelaunch',
    RELAUNCHING: 'relaunching',
});

export function isTauriRuntime() {
    return Boolean(
        globalThis.window?.__TAURI__ || globalThis.window?.__TAURI_METADATA__ || globalThis.window?.__TAURI_INTERNALS__
    );
}

function initialState(runtime) {
    return {
        phase: APP_UPDATE_PHASE.IDLE,
        currentVersion: runtime ? '' : '浏览器预览',
        updateVersion: '',
        notes: '',
        releaseDate: '',
        downloadedBytes: 0,
        totalBytes: null,
        error: '',
        errorKind: '',
        hasChecked: false,
        lastCheckedAt: null,
        lastCheckWasSilent: false,
        bannerDismissed: false,
    };
}

function errorMessage(reason) {
    if (reason instanceof Error && reason.message) return reason.message;
    const message = String(reason ?? '').trim();
    return message || '未知错误';
}

function positiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

async function closeUpdateResource(update) {
    if (!update || typeof update.close !== 'function') return;
    try {
        await update.close();
    } catch {
        // Resource cleanup is best-effort; the original update result remains more useful.
    }
}

/**
 * Owns the updater resource for the lifetime of Main.
 *
 * Main must call this hook once and pass the returned object to both UpdateNotice
 * and SettingsPanel. Test-only dependency injection keeps browser/Vitest runs free
 * from Tauri IPC while production still loads the official plugins on demand.
 */
export default function useAppUpdater({
    runtime = isTauriRuntime(),
    platform = desktopPlatform,
    startupDelayMs = DEFAULT_STARTUP_DELAY_MS,
    updaterLoader = loadUpdaterPlugin,
    processLoader = loadProcessPlugin,
    appApiLoader = loadAppApi,
} = {}) {
    const supported = runtime && platform === DESKTOP_PLATFORM.WINDOWS;
    const [state, setState] = useState(() => initialState(runtime));
    const mountedRef = useRef(true);
    const updateRef = useRef(null);
    const checkPromiseRef = useRef(null);
    const checkSilentRef = useRef(false);
    const installPromiseRef = useRef(null);
    const hasCheckedRef = useRef(false);
    const installedRef = useRef(false);
    const dismissedVersionRef = useRef('');

    const updateState = useCallback((next) => {
        if (mountedRef.current) setState(next);
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            const update = updateRef.current;
            updateRef.current = null;
            void closeUpdateResource(update);
        };
    }, []);

    useEffect(() => {
        if (!runtime) return undefined;
        let cancelled = false;
        void appApiLoader()
            .then((api) => {
                if (typeof api?.getVersion !== 'function') return '';
                return api.getVersion();
            })
            .then((version) => {
                if (cancelled || !version) return;
                updateState((current) => ({ ...current, currentVersion: String(version) }));
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [appApiLoader, runtime, updateState]);

    const checkForUpdates = useCallback(
        ({ silent = false } = {}) => {
            if (!supported || installedRef.current) return Promise.resolve(null);
            if (installPromiseRef.current) return Promise.resolve(updateRef.current);
            if (checkPromiseRef.current) {
                if (!silent) {
                    checkSilentRef.current = false;
                    updateState((current) => ({ ...current, lastCheckWasSilent: false }));
                }
                return checkPromiseRef.current;
            }
            checkSilentRef.current = silent;

            let checkTask;
            checkTask = (async () => {
                let checkedUpdate = null;
                updateState((current) => ({
                    ...current,
                    phase: APP_UPDATE_PHASE.CHECKING,
                    error: '',
                    errorKind: '',
                    lastCheckWasSilent: silent,
                }));

                try {
                    const updaterApi = await updaterLoader();
                    if (typeof updaterApi?.check !== 'function') {
                        throw new Error('更新插件未正确加载');
                    }

                    const update = await updaterApi.check({ timeout: UPDATE_CHECK_TIMEOUT_MS });
                    checkedUpdate = update;
                    hasCheckedRef.current = true;

                    if (!mountedRef.current) {
                        await closeUpdateResource(update);
                        return update ?? null;
                    }

                    if (!update) {
                        const previous = updateRef.current;
                        updateRef.current = null;
                        installedRef.current = false;
                        await closeUpdateResource(previous);
                        updateState((current) => ({
                            ...current,
                            phase: APP_UPDATE_PHASE.UP_TO_DATE,
                            updateVersion: '',
                            notes: '',
                            releaseDate: '',
                            downloadedBytes: 0,
                            totalBytes: null,
                            error: '',
                            errorKind: '',
                            hasChecked: true,
                            lastCheckedAt: Date.now(),
                            bannerDismissed: false,
                        }));
                        return null;
                    }

                    const version = String(update.version ?? '').trim();
                    if (!version) throw new Error('更新信息缺少版本号');

                    const previous = updateRef.current;
                    updateRef.current = update;
                    checkedUpdate = null;
                    installedRef.current = false;
                    if (previous && previous !== update) await closeUpdateResource(previous);

                    updateState((current) => ({
                        ...current,
                        phase: APP_UPDATE_PHASE.AVAILABLE,
                        currentVersion: String(update.currentVersion ?? current.currentVersion ?? ''),
                        updateVersion: version,
                        notes: String(update.body ?? '').trim(),
                        releaseDate: String(update.date ?? '').trim(),
                        downloadedBytes: 0,
                        totalBytes: null,
                        error: '',
                        errorKind: '',
                        hasChecked: true,
                        lastCheckedAt: Date.now(),
                        bannerDismissed: dismissedVersionRef.current === version,
                    }));
                    return update;
                } catch (reason) {
                    hasCheckedRef.current = true;
                    if (checkedUpdate && checkedUpdate !== updateRef.current) {
                        await closeUpdateResource(checkedUpdate);
                    }
                    if (mountedRef.current) {
                        updateState((current) => ({
                            ...current,
                            phase: updateRef.current ? APP_UPDATE_PHASE.AVAILABLE : APP_UPDATE_PHASE.IDLE,
                            error: `检查更新失败：${errorMessage(reason)}`,
                            errorKind: 'check',
                            hasChecked: true,
                            lastCheckedAt: Date.now(),
                            lastCheckWasSilent: checkSilentRef.current,
                        }));
                    }
                    return null;
                } finally {
                    if (checkPromiseRef.current === checkTask) checkPromiseRef.current = null;
                }
            })();

            checkPromiseRef.current = checkTask;
            return checkTask;
        },
        [supported, updaterLoader, updateState]
    );

    useEffect(() => {
        if (!supported) return undefined;
        const delay = Math.max(0, Number(startupDelayMs) || 0);
        const timer = globalThis.setTimeout(() => {
            if (!hasCheckedRef.current && !checkPromiseRef.current) {
                void checkForUpdates({ silent: true });
            }
        }, delay);
        return () => globalThis.clearTimeout(timer);
    }, [checkForUpdates, startupDelayMs, supported]);

    const installUpdate = useCallback(() => {
        if (!supported) return Promise.resolve(false);
        if (installPromiseRef.current) return installPromiseRef.current;

        const update = updateRef.current;
        if (!update && !installedRef.current) {
            updateState((current) => ({
                ...current,
                error: '请先检查并选择可用更新。',
                errorKind: 'install',
            }));
            return Promise.resolve(false);
        }

        let installTask;
        installTask = (async () => {
            try {
                if (!installedRef.current) {
                    let downloadedBytes = 0;
                    let totalBytes = null;
                    updateState((current) => ({
                        ...current,
                        phase: APP_UPDATE_PHASE.DOWNLOADING,
                        downloadedBytes: 0,
                        totalBytes: null,
                        error: '',
                        errorKind: '',
                        bannerDismissed: false,
                    }));

                    await update.downloadAndInstall(
                        (event) => {
                            if (!mountedRef.current || !event) return;
                            if (event.event === 'Started') {
                                downloadedBytes = 0;
                                totalBytes = positiveNumber(event.data?.contentLength);
                                updateState((current) => ({
                                    ...current,
                                    phase: APP_UPDATE_PHASE.DOWNLOADING,
                                    downloadedBytes,
                                    totalBytes,
                                }));
                            } else if (event.event === 'Progress') {
                                downloadedBytes += positiveNumber(event.data?.chunkLength) ?? 0;
                                updateState((current) => ({
                                    ...current,
                                    phase: APP_UPDATE_PHASE.DOWNLOADING,
                                    downloadedBytes,
                                    totalBytes: totalBytes ?? current.totalBytes,
                                }));
                            } else if (event.event === 'Finished') {
                                if (totalBytes) downloadedBytes = Math.max(downloadedBytes, totalBytes);
                                updateState((current) => ({
                                    ...current,
                                    phase: APP_UPDATE_PHASE.INSTALLING,
                                    downloadedBytes,
                                    totalBytes: totalBytes ?? current.totalBytes,
                                }));
                            }
                        },
                        { timeout: UPDATE_DOWNLOAD_TIMEOUT_MS }
                    );

                    installedRef.current = true;
                    if (updateRef.current === update) updateRef.current = null;
                    updateState((current) => ({
                        ...current,
                        phase: APP_UPDATE_PHASE.INSTALLING,
                        downloadedBytes: current.totalBytes ?? current.downloadedBytes,
                    }));
                    await closeUpdateResource(update);
                }

                updateState((current) => ({
                    ...current,
                    phase: APP_UPDATE_PHASE.RELAUNCHING,
                    error: '',
                    errorKind: '',
                    bannerDismissed: false,
                }));
                const processApi = await processLoader();
                if (typeof processApi?.relaunch !== 'function') {
                    throw new Error('重启插件未正确加载');
                }
                await processApi.relaunch();
                return true;
            } catch (reason) {
                const installed = installedRef.current;
                updateState((current) => ({
                    ...current,
                    phase: installed ? APP_UPDATE_PHASE.READY_TO_RELAUNCH : APP_UPDATE_PHASE.AVAILABLE,
                    error: installed
                        ? `更新已安装，但自动重启失败：${errorMessage(reason)}`
                        : `更新失败：${errorMessage(reason)}`,
                    errorKind: installed ? 'relaunch' : 'install',
                    bannerDismissed: false,
                }));
                return false;
            } finally {
                if (installPromiseRef.current === installTask) installPromiseRef.current = null;
            }
        })();

        installPromiseRef.current = installTask;
        return installTask;
    }, [processLoader, supported, updateState]);

    const dismissBanner = useCallback(() => {
        const version = updateRef.current?.version;
        dismissedVersionRef.current = version ? String(version) : '';
        updateState((current) => ({ ...current, bannerDismissed: true }));
    }, [updateState]);

    const showBanner = useCallback(() => {
        dismissedVersionRef.current = '';
        updateState((current) => ({ ...current, bannerDismissed: false }));
    }, [updateState]);

    const progressPercent = useMemo(() => {
        if (!state.totalBytes || state.totalBytes <= 0) return null;
        return Math.min(100, Math.max(0, Math.round((state.downloadedBytes / state.totalBytes) * 100)));
    }, [state.downloadedBytes, state.totalBytes]);

    const isChecking = state.phase === APP_UPDATE_PHASE.CHECKING;
    const isInstalling = [
        APP_UPDATE_PHASE.DOWNLOADING,
        APP_UPDATE_PHASE.INSTALLING,
        APP_UPDATE_PHASE.RELAUNCHING,
    ].includes(state.phase);

    return {
        ...state,
        runtime,
        platform,
        supported,
        progressPercent,
        isChecking,
        isInstalling,
        checkForUpdates,
        installUpdate,
        dismissBanner,
        showBanner,
    };
}
