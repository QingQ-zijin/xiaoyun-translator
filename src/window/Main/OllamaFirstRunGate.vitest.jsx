import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import OllamaFirstRunGate from './OllamaFirstRunGate';

const settings = {
    ollama: {
        enabled: true,
    },
};

const missingOllama = {
    installed: false,
    running: false,
    modelInstalled: false,
    modelRunning: false,
    manageable: true,
    model: 'gemma4:e4b-it-qat',
    message: '尚未检测到 Ollama',
};

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('首次启动 Ollama 接入层', () => {
    it('本地 AI 未就绪时自动展示，不要求用户先找到设置页', async () => {
        const invokeCommand = vi.fn(async (command) => {
            if (command === 'get_settings_v2') return settings;
            if (command === 'ollama_get_setup_status') return missingOllama;
            throw new Error(`unexpected ${command}`);
        });

        render(
            <OllamaFirstRunGate
                desktop
                invokeCommand={invokeCommand}
                sessionStorage={null}
            />
        );

        expect(await screen.findByRole('dialog', { name: '先接入本地 Ollama' })).toBeTruthy();
        expect(screen.getByText(/无需账号或 API Key/u)).toBeTruthy();
        expect(await screen.findByRole('button', { name: /打开 Ollama/u })).toBeTruthy();
    });

    it('模型已安装但尚在后台恢复时不重复显示首次使用模态', async () => {
        const invokeCommand = vi.fn(async (command) => {
            if (command === 'get_settings_v2') return settings;
            if (command === 'ollama_get_setup_status') {
                return {
                    ...missingOllama,
                    installed: true,
                    running: true,
                    modelInstalled: true,
                    modelRunning: false,
                    message: 'Gemma 4 E4B 已安装，正在后台恢复',
                };
            }
            throw new Error(`unexpected ${command}`);
        });

        render(
            <OllamaFirstRunGate
                desktop
                invokeCommand={invokeCommand}
                sessionStorage={null}
            />
        );

        await waitFor(() => expect(invokeCommand).toHaveBeenCalledTimes(2));
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('状态检测失败且 Ollama 未关闭时仍展示向导与重试入口', async () => {
        const invokeCommand = vi.fn(async (command) => {
            if (command === 'get_settings_v2') return settings;
            if (command === 'ollama_get_setup_status') throw new Error('状态检测失败');
            throw new Error(`unexpected ${command}`);
        });

        render(
            <OllamaFirstRunGate
                desktop
                invokeCommand={invokeCommand}
                sessionStorage={null}
            />
        );

        expect(await screen.findByRole('dialog', { name: '先接入本地 Ollama' })).toBeTruthy();
        expect(await screen.findByRole('button', { name: '重新检测' })).toBeTruthy();
    });
    it('本次会话可暂时跳过，论文浏览不会被锁死', async () => {
        const storage = {
            getItem: vi.fn(() => null),
            setItem: vi.fn(),
        };
        const invokeCommand = vi.fn(async (command) => {
            if (command === 'get_settings_v2') return settings;
            if (command === 'ollama_get_setup_status') return missingOllama;
            throw new Error(`unexpected ${command}`);
        });

        render(
            <OllamaFirstRunGate
                desktop
                invokeCommand={invokeCommand}
                sessionStorage={storage}
            />
        );

        fireEvent.click(await screen.findByRole('button', { name: '暂时跳过，仅浏览文献' }));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(storage.setItem).toHaveBeenCalledWith('xiaoyun.ollama.onboarding.skipped:v1', 'true');
    });

    it('模型真正加载后才显示成功，并通知其他页面刷新就绪状态', async () => {
        let statusCalls = 0;
        const invokeCommand = vi.fn(async (command) => {
            if (command === 'get_settings_v2') return settings;
            if (command === 'ollama_get_setup_status') {
                statusCalls += 1;
                return statusCalls === 1
                    ? missingOllama
                    : {
                          ...missingOllama,
                          installed: true,
                          running: true,
                          modelInstalled: true,
                          modelRunning: true,
                          message: 'Gemma 4 E4B 已加载并可立即使用',
                      };
            }
            throw new Error(`unexpected ${command}`);
        });
        const readyListener = vi.fn();
        globalThis.addEventListener('xiaoyun:ollama-ready', readyListener);

        render(
            <OllamaFirstRunGate
                desktop
                invokeCommand={invokeCommand}
                sessionStorage={null}
            />
        );

        expect(await screen.findByRole('heading', { name: '本地 AI 已准备好' })).toBeTruthy();
        await waitFor(() => expect(readyListener).toHaveBeenCalledOnce());
        globalThis.removeEventListener('xiaoyun:ollama-ready', readyListener);
    });

    it('用户已关闭本地 AI 时不打扰', async () => {
        const invokeCommand = vi.fn(async (command) => {
            if (command === 'get_settings_v2') return { ollama: { enabled: false } };
            if (command === 'ollama_get_setup_status') return missingOllama;
            throw new Error(`unexpected ${command}`);
        });

        render(
            <OllamaFirstRunGate
                desktop
                invokeCommand={invokeCommand}
                sessionStorage={null}
            />
        );

        await waitFor(() => expect(invokeCommand).toHaveBeenCalledTimes(2));
        expect(screen.queryByRole('dialog')).toBeNull();
    });
});
