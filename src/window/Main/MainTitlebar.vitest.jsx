import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import MainTitlebar from './MainTitlebar';

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('主窗口标题栏', () => {
    it('显示产品版本并提供文件翻译、阅读和设置快捷入口', () => {
        vi.useFakeTimers();
        const onNavigate = vi.fn();
        const dispatch = vi.spyOn(globalThis, 'dispatchEvent');
        render(
            <MainTitlebar
                active='translate'
                onNavigate={onNavigate}
            />
        );

        expect(screen.getByText('v4.5.9')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: '文件翻译' }));
        expect(onNavigate).toHaveBeenCalledWith('translate');
        vi.advanceTimersByTime(31);
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'xiaoyun:open-document-translator' }));

        fireEvent.click(screen.getByRole('button', { name: '阅读' }));
        fireEvent.click(screen.getByRole('button', { name: '设置' }));
        expect(onNavigate).toHaveBeenCalledWith('research');
        expect(onNavigate).toHaveBeenCalledWith('settings');
    });
});
