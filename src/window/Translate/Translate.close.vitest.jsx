import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const listeners = new Map();
    const closeOrder = [];
    const translationSignals = [];
    const appWindow = {
        label: 'translate',
        hide: vi.fn(async () => {
            closeOrder.push('hide');
        }),
        onFocusChanged: vi.fn(async () => () => {}),
        setAlwaysOnTop: vi.fn(async () => {}),
        startDragging: vi.fn(async () => {}),
    };
    const dismissRequest = vi.fn(async ({ requestId }) => {
        closeOrder.push(`dismiss:${requestId}`);
        await appWindow.hide();
        return true;
    });
    return {
        appWindow,
        closeOrder,
        dismissRequest,
        listeners,
        translationSignals,
        invoke: vi.fn(async (command, args) => {
            if (command === 'get_settings_v2') {
                return {
                    ollama: { enabled: true },
                    sourceLanguage: 'auto',
                    targetLanguage: 'zh_cn',
                    window: { hideOnBlur: false },
                };
            }
            if (command === 'translate_window_ready') return null;
            if (command === 'dismiss_translate_window') return dismissRequest(args);
            return null;
        }),
        listen: vi.fn(async (event, callback) => {
            listeners.set(event, callback);
            return () => listeners.delete(event);
        }),
        translateAcademic: vi.fn(({ signal }) => {
            translationSignals.push(signal);
            return new Promise(() => {});
        }),
    };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
    getCurrentWebviewWindow: () => mocks.appWindow,
}));
vi.mock('../../domains/vision', () => ({
    extractText: vi.fn(async () => ''),
    loadOllamaVisionConfig: vi.fn(async () => ({})),
}));
vi.mock('../../domains/translation', () => ({
    getLanguageLabel: (language) => language,
    LANGUAGE_OPTIONS: [],
    loadOllamaTranslationConfig: vi.fn(async () => ({})),
    resolveAcademicTargetLanguage: (_text, language) => language,
    synthesizeSpeech: vi.fn(async () => new Uint8Array()),
    translateAcademic: mocks.translateAcademic,
}));
vi.mock('../../hooks/useVoice', () => ({ useVoice: () => vi.fn(async () => {}) }));
vi.mock('../../utils/clipboard', () => ({ writeClipboardText: vi.fn(async () => {}) }));
vi.mock('./components/FormattedTranslation', () => ({ default: () => null }));

import Translate from './index';

describe('快捷翻译自定义关闭按钮', () => {
    beforeEach(() => {
        mocks.closeOrder.length = 0;
        mocks.translationSignals.length = 0;
        mocks.listeners.clear();
        mocks.appWindow.hide.mockClear();
        mocks.appWindow.startDragging.mockClear();
        mocks.dismissRequest.mockReset();
        mocks.dismissRequest.mockImplementation(async ({ requestId }) => {
            mocks.closeOrder.push(`dismiss:${requestId}`);
            await mocks.appWindow.hide();
            return true;
        });
        mocks.invoke.mockClear();
        mocks.listen.mockClear();
        mocks.translateAcademic.mockClear();
    });

    afterEach(() => cleanup());

    it('完整 click 后原子关闭当前请求，pointerdown 不会提前隐藏窗口', async () => {
        render(<Translate />);
        await waitFor(() => {
            expect(mocks.listeners.has('new_text')).toBe(true);
            expect(mocks.listeners.has('selection_capture_state')).toBe(true);
        });

        act(() => {
            mocks.listeners.get('selection_capture_state')({
                payload: { requestId: 41, state: 'capturing', message: null },
            });
            mocks.listeners.get('new_text')({
                payload: { requestId: 41, text: 'first selection' },
            });
        });
        await waitFor(() => expect(mocks.translationSignals).toHaveLength(1));

        const closeButton = screen.getByRole('button', { name: '关闭翻译窗口' });
        fireEvent.pointerDown(closeButton, { button: 0 });
        expect(mocks.appWindow.startDragging).not.toHaveBeenCalled();
        expect(mocks.dismissRequest).not.toHaveBeenCalled();
        expect(mocks.appWindow.hide).not.toHaveBeenCalled();
        fireEvent.click(closeButton, { detail: 1 });

        expect(mocks.translationSignals[0].aborted).toBe(true);
        await waitFor(() => {
            expect(mocks.dismissRequest).toHaveBeenCalledTimes(1);
            expect(mocks.dismissRequest).toHaveBeenCalledWith({ requestId: 41 });
            // Rust mock 隐藏一次，IPC 返回后前端再确认一次可见性。
            expect(mocks.appWindow.hide).toHaveBeenCalledTimes(2);
        });

        act(() => {
            mocks.listeners.get('selection_capture_state')({
                payload: { requestId: 42, state: 'capturing', message: null },
            });
            mocks.listeners.get('new_text')({
                payload: { requestId: 42, text: 'second selection' },
            });
        });
        await waitFor(() => expect(mocks.translationSignals).toHaveLength(2));
        expect(mocks.translationSignals[1].aborted).toBe(false);
    });

    it('原生展示 ID 已清空但窗口仍可见时，叉号本地隐藏且不切换固定状态', async () => {
        mocks.dismissRequest.mockResolvedValue(false);
        render(<Translate />);
        await waitFor(() => expect(mocks.listeners.has('new_text')).toBe(true));

        act(() => {
            mocks.listeners.get('selection_capture_state')({
                payload: { requestId: 51, state: 'capturing', message: null },
            });
            mocks.listeners.get('new_text')({
                payload: { requestId: 51, text: 'scalability' },
            });
        });
        await waitFor(() => expect(mocks.translationSignals).toHaveLength(1));
        mocks.appWindow.hide.mockClear();
        mocks.appWindow.setAlwaysOnTop.mockClear();

        fireEvent.click(screen.getByRole('button', { name: '关闭翻译窗口' }), { detail: 1 });

        expect(mocks.translationSignals[0].aborted).toBe(true);
        await waitFor(() => {
            expect(mocks.dismissRequest).toHaveBeenCalledWith({ requestId: 51 });
            expect(mocks.appWindow.hide).toHaveBeenCalledTimes(1);
        });
        expect(mocks.appWindow.setAlwaysOnTop).not.toHaveBeenCalled();
    });

    it('延迟到达的旧关闭回执不会隐藏或取消下一次 Ctrl+D', async () => {
        let resolveOldDismiss;
        mocks.dismissRequest.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveOldDismiss = resolve;
                })
        );
        render(<Translate />);
        await waitFor(() => expect(mocks.listeners.has('new_text')).toBe(true));

        act(() => {
            mocks.listeners.get('selection_capture_state')({
                payload: { requestId: 71, state: 'capturing', message: null },
            });
            mocks.listeners.get('new_text')({
                payload: { requestId: 71, text: 'old selection' },
            });
        });
        await waitFor(() => expect(mocks.translationSignals).toHaveLength(1));
        fireEvent.click(screen.getByRole('button', { name: '关闭翻译窗口' }));

        act(() => {
            mocks.listeners.get('selection_capture_state')({
                payload: { requestId: 72, state: 'capturing', message: null },
            });
            mocks.listeners.get('new_text')({
                payload: { requestId: 72, text: 'new selection' },
            });
        });
        await waitFor(() => expect(mocks.translationSignals).toHaveLength(2));
        await act(async () => resolveOldDismiss(false));

        expect(mocks.dismissRequest).toHaveBeenCalledWith({ requestId: 71 });
        expect(mocks.appWindow.hide).not.toHaveBeenCalled();
        expect(mocks.translationSignals[1].aborted).toBe(false);
    });

    it('旧请求的文本和错误状态不能覆盖较新的请求', async () => {
        render(<Translate />);
        await waitFor(() => expect(mocks.listeners.has('new_text')).toBe(true));

        act(() => {
            mocks.listeners.get('selection_capture_state')({
                payload: { requestId: 91, state: 'capturing', message: null },
            });
            mocks.listeners.get('selection_capture_state')({
                payload: { requestId: 92, state: 'capturing', message: null },
            });
            mocks.listeners.get('new_text')({
                payload: { requestId: 91, text: 'stale selection' },
            });
            mocks.listeners.get('selection_capture_state')({
                payload: { requestId: 91, state: 'error', message: 'stale error' },
            });
            mocks.listeners.get('new_text')({
                payload: { requestId: 92, text: 'latest selection' },
            });
        });

        await waitFor(() => expect(mocks.translateAcademic).toHaveBeenCalledTimes(1));
        expect(mocks.translateAcademic.mock.calls[0][0].text).toBe('latest selection');
        expect(screen.queryByText('stale error')).toBeNull();
    });
});
