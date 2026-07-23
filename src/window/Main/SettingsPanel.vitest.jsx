import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import SettingsPanel from './SettingsPanel';

afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
});

describe('统一设置页导航', () => {
    it('使用页内选项卡切换，不写入锚点也不滚动整个页面', async () => {
        window.history.replaceState({}, '', '/?route=settings');
        render(<SettingsPanel />);

        await waitFor(() => expect(screen.getByRole('heading', { name: 'Ollama 与模型' })).toBeTruthy());
        expect(screen.queryByRole('heading', { name: '文献存储' })).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: '文献存储' }));

        expect(screen.getByRole('heading', { name: '文献存储' })).toBeTruthy();
        expect(screen.queryByRole('heading', { name: 'Ollama 与模型' })).toBeNull();
        expect(window.location.hash).toBe('');
        expect(screen.getByRole('button', { name: '文献存储' }).getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByRole('combobox', { name: 'TeX 编译器' }).value).toBe('auto');
    });

    it('兼容旧锚点并立即清除，避免重新进入设置时把应用滚走', async () => {
        window.history.replaceState({}, '', '/?route=settings#settings-library');
        render(<SettingsPanel />);

        await waitFor(() => expect(screen.getByRole('heading', { name: '文献存储' })).toBeTruthy());
        expect(window.location.hash).toBe('');
        expect(screen.getByRole('button', { name: '文献存储' }).getAttribute('aria-pressed')).toBe('true');
    });

    it('macOS 使用原生快捷键与系统朗读文案', async () => {
        render(<SettingsPanel platform='macos' />);

        await waitFor(() => expect(screen.getByRole('heading', { name: 'Ollama 与模型' })).toBeTruthy());
        fireEvent.click(screen.getByRole('button', { name: '快捷键' }));

        expect(screen.getByText('默认 ⌘+D')).toBeTruthy();
        expect(screen.getByText('默认 ⌘+E')).toBeTruthy();
        const selectionHotkey = screen.getByRole('textbox', { name: '划词翻译快捷键' });
        expect(selectionHotkey.value).toBe('⌘+D');
        fireEvent.change(selectionHotkey, { target: { value: '⌘+Q' } });
        fireEvent.blur(selectionHotkey);
        expect(selectionHotkey.value).toBe('⌘+Q');

        fireEvent.click(screen.getByRole('button', { name: '朗读' }));
        expect(screen.getByRole('heading', { name: 'macOS 本地朗读' })).toBeTruthy();
        expect(screen.getByText(/macOS 系统 say 语音/u)).toBeTruthy();
        expect(screen.getByPlaceholderText('自动选择 macOS 声音')).toBeTruthy();
    });

    it('Windows 保留现有 Ctrl 与 SpeechSynthesizer 体验', async () => {
        render(<SettingsPanel platform='windows' />);

        await waitFor(() => expect(screen.getByRole('heading', { name: 'Ollama 与模型' })).toBeTruthy());
        fireEvent.click(screen.getByRole('button', { name: '快捷键' }));
        expect(screen.getByText('默认 Ctrl+D')).toBeTruthy();
        expect(screen.getByRole('textbox', { name: '划词翻译快捷键' }).value).toBe('Ctrl+D');

        fireEvent.click(screen.getByRole('button', { name: '朗读' }));
        expect(screen.getByRole('heading', { name: 'Windows 本地朗读' })).toBeTruthy();
        expect(screen.getByText(/系统 SpeechSynthesizer/u)).toBeTruthy();
        expect(screen.getByPlaceholderText('自动选择 Windows 声音')).toBeTruthy();
    });
});
