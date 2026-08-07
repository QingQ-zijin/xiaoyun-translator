import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import UpdateNotice from './UpdateNotice';
import useAppUpdater, { APP_UPDATE_PHASE, isTauriRuntime } from './useAppUpdater';

const defaultTauriMocks = vi.hoisted(() => ({
    check: vi.fn(),
    relaunch: vi.fn(),
    getVersion: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-updater', () => ({
    check: defaultTauriMocks.check,
}));

vi.mock('@tauri-apps/plugin-process', () => ({
    relaunch: defaultTauriMocks.relaunch,
}));

vi.mock('@tauri-apps/api/app', () => ({
    getVersion: defaultTauriMocks.getVersion,
}));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function updaterOptions({ check, relaunch = vi.fn().mockResolvedValue(undefined), startupDelayMs = 0 }) {
    return {
        runtime: true,
        platform: 'windows',
        startupDelayMs,
        updaterLoader: vi.fn().mockResolvedValue({ check }),
        processLoader: vi.fn().mockResolvedValue({ relaunch }),
        appApiLoader: vi.fn().mockResolvedValue({ getVersion: vi.fn().mockResolvedValue('4.5.2') }),
    };
}

function UpdaterHarness({ options }) {
    const updater = useAppUpdater(options);
    return (
        <div>
            <span aria-label='更新阶段'>{updater.phase}</span>
            <span aria-label='更新错误'>{updater.error}</span>
            <span aria-label='更新进度'>{updater.progressPercent ?? 'unknown'}</span>
            <button
                type='button'
                onClick={() => {
                    void updater.checkForUpdates({ silent: false });
                    void updater.checkForUpdates({ silent: false });
                }}
            >
                重复检查
            </button>
            <button
                type='button'
                onClick={() => {
                    void updater.installUpdate();
                    void updater.installUpdate();
                }}
            >
                重复安装
            </button>
            <button
                type='button'
                onClick={updater.showBanner}
            >
                显示更新通知
            </button>
            <UpdateNotice updater={updater} />
        </div>
    );
}

afterEach(() => {
    cleanup();
    defaultTauriMocks.check.mockReset();
    defaultTauriMocks.relaunch.mockReset();
    defaultTauriMocks.getVersion.mockReset();
    delete globalThis.window?.__TAURI__;
    delete globalThis.window?.__TAURI_METADATA__;
    delete globalThis.window?.__TAURI_INTERNALS__;
    vi.restoreAllMocks();
});

describe('useAppUpdater', () => {
    it('浏览器环境安全 no-op，不加载 updater 插件', async () => {
        const check = vi.fn();
        const options = {
            ...updaterOptions({ check }),
            runtime: false,
        };

        render(<UpdaterHarness options={options} />);
        fireEvent.click(screen.getByRole('button', { name: '重复检查' }));

        await Promise.resolve();
        expect(check).not.toHaveBeenCalled();
        expect(screen.getByLabelText('更新阶段').textContent).toBe(APP_UPDATE_PHASE.IDLE);
        expect(screen.queryByRole('status', { name: '软件更新通知' })).toBeNull();
    });

    it('macOS 桌面端连接包含对应平台资产的正式更新源', async () => {
        const check = vi.fn();
        const options = {
            ...updaterOptions({ check }),
            platform: 'macos',
        };

        render(<UpdaterHarness options={options} />);
        fireEvent.click(screen.getByRole('button', { name: '重复检查' }));
        await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
        expect(screen.getByLabelText('更新阶段').textContent).toBe(APP_UPDATE_PHASE.UP_TO_DATE);
        expect(screen.queryByRole('status', { name: '软件更新通知' })).toBeNull();
    });

    it('去重并发检查，null 表示当前已是最新版且不显示横幅', async () => {
        const result = deferred();
        const check = vi.fn().mockReturnValue(result.promise);
        const options = updaterOptions({ check });

        render(<UpdaterHarness options={options} />);
        await waitFor(() => expect(check).toHaveBeenCalledTimes(1));

        fireEvent.click(screen.getByRole('button', { name: '重复检查' }));
        expect(check).toHaveBeenCalledTimes(1);

        await act(async () => {
            result.resolve(null);
            await result.promise;
        });

        await waitFor(() => expect(screen.getByLabelText('更新阶段').textContent).toBe(APP_UPDATE_PHASE.UP_TO_DATE));
        expect(screen.queryByRole('status', { name: '软件更新通知' })).toBeNull();
    });

    it('发现新版本后显示通知，并可在本会话选择稍后', async () => {
        const update = {
            currentVersion: '4.5.2',
            version: '4.5.3',
            body: '修复翻译窗口并提升稳定性',
            downloadAndInstall: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        const options = updaterOptions({ check: vi.fn().mockResolvedValue(update) });
        const view = render(<UpdaterHarness options={options} />);

        expect(await screen.findByText('发现新版本 4.5.3')).toBeTruthy();
        expect(screen.getByText('修复翻译窗口并提升稳定性')).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: '本会话稍后更新' }));
        expect(screen.queryByRole('status', { name: '软件更新通知' })).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: '显示更新通知' }));
        expect(screen.getByRole('status', { name: '软件更新通知' })).toBeTruthy();

        view.unmount();
        await waitFor(() => expect(update.close).toHaveBeenCalledTimes(1));
    });

    it('流式更新下载进度，且并发安装只执行一次并在完成后重启', async () => {
        const download = deferred();
        const relaunch = vi.fn().mockResolvedValue(undefined);
        const update = {
            currentVersion: '4.5.2',
            version: '4.5.3',
            body: '',
            close: vi.fn().mockResolvedValue(undefined),
            downloadAndInstall: vi.fn(async (onEvent) => {
                onEvent({ event: 'Started', data: { contentLength: 100 } });
                onEvent({ event: 'Progress', data: { chunkLength: 25 } });
                await download.promise;
                onEvent({ event: 'Progress', data: { chunkLength: 75 } });
                onEvent({ event: 'Finished' });
            }),
        };
        const options = updaterOptions({
            check: vi.fn().mockResolvedValue(update),
            relaunch,
        });

        render(<UpdaterHarness options={options} />);
        await screen.findByText('发现新版本 4.5.3');

        fireEvent.click(screen.getByRole('button', { name: '重复安装' }));
        await waitFor(() => expect(update.downloadAndInstall).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.getByLabelText('更新进度').textContent).toBe('25'));

        fireEvent.click(screen.getByRole('button', { name: '重复安装' }));
        expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);

        await act(async () => {
            download.resolve();
            await download.promise;
        });

        await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
        expect(update.close).toHaveBeenCalledTimes(1);
        expect(screen.getByLabelText('更新进度').textContent).toBe('100');
    });

    it('启动检查失败不显示横幅，手动重试后可发现更新', async () => {
        const update = {
            currentVersion: '4.5.2',
            version: '4.5.3',
            body: '',
            downloadAndInstall: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        const check = vi.fn().mockRejectedValueOnce(new Error('网络不可用')).mockResolvedValueOnce(update);
        const options = updaterOptions({ check });

        render(<UpdaterHarness options={options} />);

        await waitFor(() => expect(screen.getByLabelText('更新错误').textContent).toContain('网络不可用'));
        expect(screen.queryByRole('status', { name: '软件更新通知' })).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: '重复检查' }));

        expect(await screen.findByText('发现新版本 4.5.3')).toBeTruthy();
        expect(check).toHaveBeenCalledTimes(2);
    });

    it('安装失败后允许重试，仍保持防重复保护', async () => {
        const relaunch = vi.fn().mockResolvedValue(undefined);
        const update = {
            currentVersion: '4.5.2',
            version: '4.5.3',
            body: '',
            close: vi.fn().mockResolvedValue(undefined),
            downloadAndInstall: vi
                .fn()
                .mockRejectedValueOnce(new Error('签名验证失败'))
                .mockImplementationOnce(async (onEvent) => {
                    onEvent({ event: 'Started', data: { contentLength: 10 } });
                    onEvent({ event: 'Progress', data: { chunkLength: 10 } });
                    onEvent({ event: 'Finished' });
                }),
        };
        const options = updaterOptions({
            check: vi.fn().mockResolvedValue(update),
            relaunch,
        });

        render(<UpdaterHarness options={options} />);
        await screen.findByText('发现新版本 4.5.3');

        fireEvent.click(screen.getByRole('button', { name: '立即更新' }));
        await waitFor(() => expect(screen.getByLabelText('更新错误').textContent).toContain('签名验证失败'));
        expect(relaunch).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: '重试更新' }));
        await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
        expect(update.downloadAndInstall).toHaveBeenCalledTimes(2);
        expect(update.close).toHaveBeenCalledTimes(1);
    });

    it('使用默认 Tauri 插件加载器，并向检查与下载传入超时保护', async () => {
        expect(isTauriRuntime()).toBe(false);
        globalThis.window.__TAURI_INTERNALS__ = {};
        expect(isTauriRuntime()).toBe(true);
        delete globalThis.window.__TAURI_INTERNALS__;
        globalThis.window.__TAURI_METADATA__ = {};
        expect(isTauriRuntime()).toBe(true);
        delete globalThis.window.__TAURI_METADATA__;
        globalThis.window.__TAURI__ = {};
        expect(isTauriRuntime()).toBe(true);

        const update = {
            currentVersion: '4.5.2',
            version: '4.5.3',
            body: '',
            close: vi.fn().mockResolvedValue(undefined),
            downloadAndInstall: vi.fn(async (onEvent) => {
                onEvent({ event: 'Started', data: { contentLength: 20 } });
                onEvent({ event: 'Progress', data: { chunkLength: 20 } });
                onEvent({ event: 'Finished' });
            }),
        };
        defaultTauriMocks.check.mockResolvedValue(update);
        defaultTauriMocks.relaunch.mockResolvedValue(undefined);
        defaultTauriMocks.getVersion.mockResolvedValue('4.5.2');

        render(
            <UpdaterHarness
                options={{
                    runtime: true,
                    platform: 'windows',
                    startupDelayMs: 0,
                }}
            />
        );

        expect(await screen.findByText('发现新版本 4.5.3')).toBeTruthy();
        expect(defaultTauriMocks.check).toHaveBeenCalledWith({ timeout: 15_000 });
        expect(defaultTauriMocks.getVersion).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole('button', { name: '立即更新' }));

        await waitFor(() => expect(defaultTauriMocks.relaunch).toHaveBeenCalledTimes(1));
        expect(update.downloadAndInstall).toHaveBeenCalledWith(expect.any(Function), {
            timeout: 30 * 60_000,
        });
        expect(update.close).toHaveBeenCalledTimes(1);
    });

    it('未知下载总量保持不确定进度，重启失败后只重试重启而不重复安装', async () => {
        const relaunch = vi.fn().mockRejectedValueOnce(new Error('系统拒绝重启')).mockResolvedValueOnce(undefined);
        const update = {
            currentVersion: '4.5.2',
            version: '4.5.3',
            body: '',
            close: vi.fn().mockRejectedValue(new Error('资源已经关闭')),
            downloadAndInstall: vi.fn(async (onEvent) => {
                onEvent(null);
                onEvent({ event: 'Started', data: {} });
                onEvent({ event: 'Progress', data: { chunkLength: 0 } });
                onEvent({ event: 'Finished' });
            }),
        };
        const options = updaterOptions({
            check: vi.fn().mockResolvedValue(update),
            relaunch,
        });

        render(<UpdaterHarness options={options} />);
        await screen.findByText('发现新版本 4.5.3');

        fireEvent.click(screen.getByRole('button', { name: '立即更新' }));

        await waitFor(() =>
            expect(screen.getByLabelText('更新错误').textContent).toContain('自动重启失败：系统拒绝重启')
        );
        expect(screen.getByLabelText('更新阶段').textContent).toBe(APP_UPDATE_PHASE.READY_TO_RELAUNCH);
        expect(screen.getByLabelText('更新进度').textContent).toBe('unknown');
        expect(update.downloadAndInstall).toHaveBeenCalledWith(expect.any(Function), {
            timeout: 30 * 60_000,
        });

        fireEvent.click(screen.getByRole('button', { name: '重新启动' }));

        await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(2));
        expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
        expect(update.close).toHaveBeenCalledTimes(1);
    });

    it('未发现更新前拒绝安装并给出明确错误', async () => {
        const check = vi.fn();
        const options = updaterOptions({
            check,
            startupDelayMs: 60_000,
        });

        render(<UpdaterHarness options={options} />);
        fireEvent.click(screen.getByRole('button', { name: '重复安装' }));

        await waitFor(() => expect(screen.getByLabelText('更新错误').textContent).toContain('请先检查并选择可用更新'));
        expect(check).not.toHaveBeenCalled();
        expect(screen.getByLabelText('更新阶段').textContent).toBe(APP_UPDATE_PHASE.IDLE);
    });

    it('更新插件缺少 check API 时转为可重试检查错误', async () => {
        const options = {
            ...updaterOptions({ check: vi.fn() }),
            updaterLoader: vi.fn().mockResolvedValue({}),
        };

        render(<UpdaterHarness options={options} />);

        await waitFor(() => expect(screen.getByLabelText('更新错误').textContent).toContain('更新插件未正确加载'));
        expect(screen.getByLabelText('更新阶段').textContent).toBe(APP_UPDATE_PHASE.IDLE);
        expect(screen.queryByRole('status', { name: '软件更新通知' })).toBeNull();
    });

    it('拒绝缺少版本号的更新元数据并释放临时资源', async () => {
        const malformedUpdate = {
            currentVersion: '4.5.2',
            version: '  ',
            close: vi.fn().mockRejectedValue(new Error('资源关闭失败')),
        };
        const options = updaterOptions({
            check: vi.fn().mockResolvedValue(malformedUpdate),
        });

        render(<UpdaterHarness options={options} />);

        await waitFor(() => expect(screen.getByLabelText('更新错误').textContent).toContain('更新信息缺少版本号'));
        expect(malformedUpdate.close).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('status', { name: '软件更新通知' })).toBeNull();
    });

    it('组件在检查完成前卸载时关闭返回资源且不再更新界面', async () => {
        const result = deferred();
        const versionResult = deferred();
        const update = {
            currentVersion: '4.5.2',
            version: '4.5.3',
            close: vi.fn().mockResolvedValue(undefined),
        };
        const options = {
            ...updaterOptions({ check: vi.fn().mockReturnValue(result.promise) }),
            appApiLoader: vi.fn().mockResolvedValue({
                getVersion: vi.fn().mockReturnValue(versionResult.promise),
            }),
        };
        const view = render(<UpdaterHarness options={options} />);
        await waitFor(() => expect(options.updaterLoader).toHaveBeenCalledTimes(1));

        view.unmount();
        await act(async () => {
            result.resolve(update);
            versionResult.resolve('4.5.2');
            await Promise.all([result.promise, versionResult.promise]);
        });

        await waitFor(() => expect(update.close).toHaveBeenCalledTimes(1));
    });

    it('非 Error 的空检查失败原因回退为未知错误', async () => {
        const options = updaterOptions({
            check: vi.fn().mockRejectedValue(null),
        });

        render(<UpdaterHarness options={options} />);

        await waitFor(() => expect(screen.getByLabelText('更新错误').textContent).toContain('未知错误'));
        expect(screen.queryByRole('status', { name: '软件更新通知' })).toBeNull();
    });
});
