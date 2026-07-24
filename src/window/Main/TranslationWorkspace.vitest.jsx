import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import TranslationWorkspace from './TranslationWorkspace';

const settings = {
    sourceLanguage: 'auto',
    targetLanguage: 'zh_cn',
    ollama: {
        enabled: true,
        translation: { model: 'gemma4:e4b-it-qat' },
    },
};

const coldStatus = {
    modelInstalled: true,
    modelRunning: false,
};

const readyStatus = {
    ...coldStatus,
    modelRunning: true,
};

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('学术翻译工作区 Ollama 恢复', () => {
    it('后端未就绪时低频重检，模型启动后自动恢复翻译按钮', async () => {
        let statusCalls = 0;
        const invokeCommand = vi.fn(async (command) => {
            if (command === 'get_settings_v2') return settings;
            if (command === 'ollama_get_setup_status') {
                statusCalls += 1;
                return statusCalls === 1 ? coldStatus : readyStatus;
            }
            throw new Error(`unexpected ${command}`);
        });

        render(
            <TranslationWorkspace
                desktop
                invokeCommand={invokeCommand}
                statusPollMs={50}
            />
        );

        expect(await screen.findByRole('button', { name: '完成本地 AI 设置' })).toBeTruthy();
        const translateButton = screen.getByRole('button', { name: '开始翻译' });
        expect(translateButton.disabled).toBe(true);

        await waitFor(() => expect(screen.getByText('Gemma 4 E4B 就绪')).toBeTruthy());
        expect(translateButton.disabled).toBe(false);
        expect(statusCalls).toBeGreaterThanOrEqual(2);
    });
});
