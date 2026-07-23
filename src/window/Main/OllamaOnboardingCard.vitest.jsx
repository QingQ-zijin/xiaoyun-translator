import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import OllamaOnboardingCard from './OllamaOnboardingCard';

const missingOllama = {
    installed: false,
    executablePath: '',
    clientVersion: '',
    running: false,
    serverVersion: '',
    model: 'gemma4:e4b-it-qat',
    modelInstalled: false,
    modelRunning: false,
    manageable: true,
    message: '尚未检测到 Ollama',
};

const stoppedOllama = {
    ...missingOllama,
    installed: true,
    executablePath: 'C:\\Ollama\\ollama.exe',
    clientVersion: 'ollama version 0.12.0',
    message: 'Ollama 已安装，后台服务尚未启动',
};

const missingModel = {
    ...stoppedOllama,
    running: true,
    serverVersion: '0.12.0',
    message: 'Ollama 已运行，Gemma 4 E4B 尚未下载',
};

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
    });
    return { promise, resolve, reject };
}

function channelHarness() {
    const channel = { onmessage: undefined };
    return {
        channel,
        createChannel: vi.fn(() => channel),
        send(message) {
            channel.onmessage?.(message);
        },
    };
}

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('Ollama 首次接入向导', () => {
    it('未安装时只打开官方页面，不在后台静默安装', async () => {
        const invokeCommand = vi.fn(async (command) => {
            if (command === 'ollama_get_setup_status') return missingOllama;
            if (command === 'ollama_open_official_download') return undefined;
            throw new Error(`unexpected ${command}`);
        });
        render(
            <OllamaOnboardingCard
                desktop
                platform='windows'
                invokeCommand={invokeCommand}
            />
        );

        await screen.findByText('尚未检测到 Ollama');
        fireEvent.click(screen.getByRole('button', { name: '打开 Ollama 官方下载页' }));

        await waitFor(() => expect(invokeCommand).toHaveBeenCalledWith('ollama_open_official_download'));
        expect(screen.getByText(/已打开 Ollama 官方下载页/u)).toBeTruthy();
        expect(invokeCommand.mock.calls.map(([command]) => command)).not.toContain('ollama_pull_unified_model');
    });

    it('已安装但服务停止时提供明确的启动动作', async () => {
        const started = {
            ...missingModel,
            message: 'Ollama 已运行，Gemma 4 E4B 尚未下载',
        };
        const invokeCommand = vi.fn(async (command) => {
            if (command === 'ollama_get_setup_status') return stoppedOllama;
            if (command === 'ollama_start_local_service') return started;
            throw new Error(`unexpected ${command}`);
        });
        render(
            <OllamaOnboardingCard
                desktop
                platform='windows'
                invokeCommand={invokeCommand}
            />
        );

        await screen.findByText('Ollama 已安装，后台服务尚未启动');
        fireEvent.click(screen.getByRole('button', { name: '启动 Ollama 服务' }));

        await screen.findByText('Ollama 服务已启动。');
        expect(invokeCommand).toHaveBeenCalledWith('ollama_start_local_service');
        expect(screen.getByRole('button', { name: /下载 Gemma 4 E4B/u })).toBeTruthy();
    });

    it('下载前二次确认，显示官方流进度并可立即取消', async () => {
        const pendingPull = deferred();
        const stream = channelHarness();
        let statusCalls = 0;
        const invokeCommand = vi.fn((command) => {
            if (command === 'ollama_get_setup_status') {
                statusCalls += 1;
                return Promise.resolve(missingModel);
            }
            if (command === 'ollama_pull_unified_model') return pendingPull.promise;
            if (command === 'ollama_cancel_model_pull') return Promise.resolve(true);
            throw new Error(`unexpected ${command}`);
        });
        render(
            <OllamaOnboardingCard
                desktop
                platform='windows'
                invokeCommand={invokeCommand}
                createChannel={stream.createChannel}
            />
        );

        const download = await screen.findByRole('button', { name: /下载 Gemma 4 E4B/u });
        fireEvent.click(download);
        expect(screen.getByRole('alert').textContent).toContain('确认下载约 6.1 GB 模型');
        expect(invokeCommand.mock.calls.map(([command]) => command)).not.toContain('ollama_pull_unified_model');

        fireEvent.click(screen.getByRole('button', { name: '确认下载' }));
        await waitFor(() => expect(stream.createChannel).toHaveBeenCalledOnce());
        const [, pullRequest] = invokeCommand.mock.calls.find(([command]) => command === 'ollama_pull_unified_model');
        stream.send({
            requestId: pullRequest.requestId,
            state: 'running',
            status: 'pulling layer',
            message: '正在下载模型文件 42%',
            completed: 420,
            total: 1000,
            progress: 0.42,
        });

        expect(await screen.findByText('正在下载模型文件 42%')).toBeTruthy();
        expect(screen.getByText('42%')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: '取消下载' }));
        await waitFor(() =>
            expect(invokeCommand).toHaveBeenCalledWith('ollama_cancel_model_pull', {
                requestId: pullRequest.requestId,
            })
        );

        pendingPull.reject('模型下载已取消');
        await screen.findByText(/模型下载已取消/u);
        expect(statusCalls).toBeGreaterThanOrEqual(1);
    });

    it('Linux 服务停止时提示终端命令，不声称应用可直接启动', async () => {
        const invokeCommand = vi.fn(async (command) => {
            if (command === 'ollama_get_setup_status') {
                return {
                    ...stoppedOllama,
                    executablePath: '/usr/local/bin/ollama',
                };
            }
            throw new Error(`unexpected ${command}`);
        });
        render(
            <OllamaOnboardingCard
                desktop
                platform='linux'
                invokeCommand={invokeCommand}
            />
        );

        expect(await screen.findByText('请在终端运行 ollama serve，然后重新检测。')).toBeTruthy();
        expect(screen.queryByRole('button', { name: '启动 Ollama 服务' })).toBeNull();
        expect(invokeCommand.mock.calls.map(([command]) => command)).not.toContain('ollama_start_local_service');
    });

    it('macOS 安装步骤使用平台对应的官方应用文案', async () => {
        const invokeCommand = vi.fn(async (command) => {
            if (command === 'ollama_get_setup_status') return missingOllama;
            if (command === 'ollama_open_official_download') return undefined;
            throw new Error(`unexpected ${command}`);
        });
        render(
            <OllamaOnboardingCard
                desktop
                platform='macos'
                invokeCommand={invokeCommand}
            />
        );

        await screen.findByText('官方 macOS 应用');
        fireEvent.click(screen.getByRole('button', { name: '打开 Ollama macOS 下载页' }));
        await waitFor(() => expect(invokeCommand).toHaveBeenCalledWith('ollama_open_official_download'));
    });
});
