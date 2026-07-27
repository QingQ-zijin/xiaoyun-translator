import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: mocks.invoke,
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
});
