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
});
