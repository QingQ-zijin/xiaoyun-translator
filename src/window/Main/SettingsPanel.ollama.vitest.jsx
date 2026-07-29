import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
    playSpeechRequest: vi.fn(async (loadAudio) => loadAudio()),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: mocks.invoke,
}));

vi.mock('../../hooks/useVoice', () => ({
    useSpeechRequest: () => mocks.playSpeechRequest,
}));

vi.mock('./OllamaOnboardingCard', () => ({
    default: ({ autoStartService }) => (
        <output
            data-testid='ollama-onboarding-props'
            data-auto-start={String(Boolean(autoStartService))}
        />
    ),
}));

import SettingsPanel from './SettingsPanel';
import { DEFAULT_SETTINGS_V2 } from './settings';

beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.playSpeechRequest.mockClear();
    delete window.__TAURI_INTERNALS__;
});
afterEach(() => {
    cleanup();
    delete window.__TAURI_INTERNALS__;
});

describe('设置页 Ollama 生命周期', () => {
    it('用户关闭本地 AI 后设置页不会重新自动拉起 Ollama', async () => {
        render(<SettingsPanel />);

        await waitFor(() => expect(screen.getByRole('heading', { name: 'Ollama 与模型' })).toBeTruthy());
        const onboarding = screen.getByTestId('ollama-onboarding-props');
        expect(onboarding.dataset.autoStart).toBe('true');

        fireEvent.click(screen.getByRole('checkbox'));
        expect(onboarding.dataset.autoStart).toBe('false');
    });

    it('已保存为关闭时首次挂载就保持关闭，不会短暂自动启动服务', async () => {
        window.__TAURI_INTERNALS__ = {};
        mocks.invoke.mockImplementation(async (command) => {
            if (command === 'get_settings_v2') {
                return {
                    ...DEFAULT_SETTINGS_V2,
                    ollama: { ...DEFAULT_SETTINGS_V2.ollama, enabled: false },
                };
            }
            if (command === 'list_system_voices' || command === 'research_list_ollama_models') return [];
            throw new Error(`unexpected ${command}`);
        });

        render(<SettingsPanel />);

        expect(screen.queryByTestId('ollama-onboarding-props')).toBeNull();
        const onboarding = await screen.findByTestId('ollama-onboarding-props');
        expect(onboarding.dataset.autoStart).toBe('false');
    });

    it('中英文音色独立选择、标记自然语音并支持试听', async () => {
        window.__TAURI_INTERNALS__ = {};
        mocks.invoke.mockImplementation(async (command, payload) => {
            if (command === 'get_settings_v2') {
                return {
                    ...DEFAULT_SETTINGS_V2,
                    speech: {
                        ...DEFAULT_SETTINGS_V2.speech,
                        chineseVoice: 'zh-natural',
                        englishVoice: 'en-standard',
                    },
                };
            }
            if (command === 'list_system_voices') {
                return [
                    {
                        id: 'zh-natural',
                        name: 'Microsoft Xiaoxiao Natural',
                        language: 'zh-CN',
                        quality: 'natural',
                    },
                    {
                        id: 'en-standard',
                        name: 'Microsoft David',
                        language: 'en-US',
                        quality: 'standard',
                    },
                ];
            }
            if (command === 'research_list_ollama_models') return [];
            if (command === 'system_tts') {
                expect(payload).toMatchObject({
                    text: '小允翻译，让论文阅读更自然。',
                    lang: 'zh',
                    voice: 'zh-natural',
                    rate: 1,
                });
                return [82, 73, 70, 70];
            }
            throw new Error(`unexpected ${command}`);
        });

        render(<SettingsPanel platform='windows' />);
        await waitFor(() => expect(screen.getByRole('heading', { name: 'Ollama 与模型' })).toBeTruthy());
        fireEvent.click(screen.getByRole('button', { name: '朗读' }));

        const chineseVoice = screen.getByRole('combobox', { name: '中文朗读音色' });
        const englishVoice = screen.getByRole('combobox', { name: '英文朗读音色' });
        expect(chineseVoice.value).toBe('zh-natural');
        expect(englishVoice.value).toBe('en-standard');
        expect(screen.getByRole('option', { name: /Xiaoxiao Natural.*自然语音/u })).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: '试听中文音色' }));
        await waitFor(() => expect(mocks.playSpeechRequest).toHaveBeenCalledTimes(1));
        await waitFor(() =>
            expect(mocks.invoke).toHaveBeenCalledWith(
                'system_tts',
                expect.objectContaining({ voice: 'zh-natural', lang: 'zh' })
            )
        );
    });
});
