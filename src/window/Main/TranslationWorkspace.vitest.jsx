import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const translationMocks = vi.hoisted(() => ({
    translateAcademic: vi.fn(),
}));

vi.mock('../../domains/translation', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        translateAcademic: translationMocks.translateAcademic,
    };
});

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
    translationMocks.translateAcademic.mockReset();
});

describe('学术翻译工作区 Ollama 恢复', () => {
    it('在翻译主页提供醒目的文档翻译入口', async () => {
        render(<TranslationWorkspace desktop={false} />);

        const documentMode = screen.getByRole('button', { name: /文档翻译/u });
        expect(documentMode.getAttribute('aria-pressed')).toBe('false');
        fireEvent.click(documentMode);

        expect(await screen.findByText('拖入整篇文件，得到完整译文 PDF')).toBeTruthy();
        expect(documentMode.getAttribute('aria-pressed')).toBe('true');
    });

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
        const translateButton = screen.getByRole('button', { name: '启动并翻译' });
        expect(translateButton.disabled).toBe(true);

        await waitFor(() => expect(screen.getByText('Gemma 4 E4B 就绪')).toBeTruthy());
        expect(screen.getByRole('button', { name: '开始翻译' }).disabled).toBe(true);
        expect(statusCalls).toBeGreaterThanOrEqual(2);
    });

    it('后端冷启动时允许一次点击自动恢复并完成翻译', async () => {
        translationMocks.translateAcademic.mockResolvedValue('恢复后译文');
        const invokeCommand = vi.fn(async (command) => {
            if (command === 'get_settings_v2') return settings;
            if (command === 'ollama_get_setup_status') return coldStatus;
            throw new Error(`unexpected ${command}`);
        });

        render(
            <TranslationWorkspace
                desktop
                invokeCommand={invokeCommand}
                statusPollMs={10_000}
            />
        );

        const source = await screen.findByPlaceholderText(/粘贴论文段落/u);
        fireEvent.change(source, { target: { value: 'Ollama can recover.' } });
        const start = screen.getByRole('button', { name: '启动并翻译' });
        expect(start.disabled).toBe(false);
        fireEvent.click(start);

        expect(await screen.findByText('恢复后译文')).toBeTruthy();
        expect(translationMocks.translateAcademic).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('button', { name: '开始翻译' })).toBeTruthy();
    });
});
