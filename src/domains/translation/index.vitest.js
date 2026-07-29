import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
    translateWithOllama: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: mocks.invoke,
    Channel: class TestChannel {
        onmessage = null;
    },
}));
vi.mock('../../services/translate/ollama', () => ({ translate: mocks.translateWithOllama }));

import { loadOllamaTranslationConfig, resolveSpeechVoice, synthesizeSpeech, translateAcademic } from './index';

const TAURI_MARKERS = ['__TAURI__', '__TAURI_METADATA__', '__TAURI_INTERNALS__'];

function clearTauriMarkers() {
    for (const marker of TAURI_MARKERS) delete window[marker];
}

beforeEach(() => {
    clearTauriMarkers();
    mocks.invoke.mockReset();
    mocks.translateWithOllama.mockReset();
});

afterEach(() => {
    clearTauriMarkers();
    vi.unstubAllGlobals();
});

describe('学术翻译桌面路由', () => {
    it('读取旧配置时仍强制使用统一 Gemma 4', async () => {
        mocks.invoke.mockResolvedValue({
            ollama: {
                translation: {
                    requestPath: 'http://127.0.0.1:11434',
                    model: 'translategemma:4b',
                },
            },
        });

        await expect(loadOllamaTranslationConfig()).resolves.toMatchObject({
            requestPath: 'http://127.0.0.1:11434',
            model: 'gemma4:e4b-it-qat',
            stream: true,
        });
    });

    it('Tauri 2 环境只走 Rust 后端，不调用浏览器 Ollama 或 fetch', async () => {
        window.__TAURI_INTERNALS__ = {};
        mocks.invoke.mockResolvedValue({ text: '但其临床转化进展缓慢。' });
        const onDelta = vi.fn();
        const browserFetch = vi.fn(() => {
            throw new Error('桌面翻译不应调用浏览器 fetch');
        });
        vi.stubGlobal('fetch', browserFetch);

        await expect(
            translateAcademic({
                text: '  but its translation into the clinic has been slow.  ',
                sourceLanguage: 'auto',
                targetLanguage: 'zh_cn',
                contextBefore: 'previous sentence',
                contextAfter: 'next sentence',
                paperTitle: 'Clinical Delivery',
                onDelta,
            })
        ).resolves.toBe('但其临床转化进展缓慢。');

        expect(mocks.invoke).toHaveBeenCalledOnce();
        expect(mocks.invoke).toHaveBeenCalledWith(
            'research_translate_selection',
            expect.objectContaining({
                text: 'but its translation into the clinic has been slow.',
                pageNumber: 1,
                paperTitle: 'Clinical Delivery',
                contextBefore: 'previous sentence',
                contextAfter: 'next sentence',
                sourceLanguage: 'auto',
                targetLanguage: 'zh_cn',
                requestId: expect.any(String),
                onEvent: expect.any(Object),
            })
        );
        expect(onDelta).toHaveBeenCalledWith('但其临床转化进展缓慢。');
        expect(mocks.translateWithOllama).not.toHaveBeenCalled();
        expect(browserFetch).not.toHaveBeenCalled();
    });

    it('桌面后端网络失败时返回中文提示，不泄漏 Failed to fetch', async () => {
        window.__TAURI_INTERNALS__ = {};
        mocks.invoke.mockRejectedValue(new TypeError('Failed to fetch'));

        await expect(translateAcademic({ text: 'Michaelis–Menten', targetLanguage: 'zh_cn' })).rejects.toThrow(
            '学术翻译失败：无法连接本地翻译服务，请确认 Ollama 正在运行。'
        );
        expect(mocks.translateWithOllama).not.toHaveBeenCalled();
    });

    it('空白文本不调用任何翻译后端', async () => {
        window.__TAURI_INTERNALS__ = {};
        await expect(translateAcademic({ text: '   ' })).resolves.toBe('');
        expect(mocks.invoke).not.toHaveBeenCalled();
        expect(mocks.translateWithOllama).not.toHaveBeenCalled();
    });

    it('中文 Ctrl+D 在默认中文目标下自动改为英文翻译', async () => {
        window.__TAURI_INTERNALS__ = {};
        mocks.invoke.mockResolvedValue({ text: 'Graduate admissions administration regulations.' });

        await translateAcademic({
            text: '研究生招生工作管理规定',
            sourceLanguage: 'auto',
            targetLanguage: 'zh_cn',
        });

        expect(mocks.invoke).toHaveBeenCalledWith(
            'research_translate_selection',
            expect.objectContaining({
                text: '研究生招生工作管理规定',
                sourceLanguage: 'auto',
                targetLanguage: 'en',
            })
        );
    });
});

describe('本地朗读按语言选择音色', () => {
    it('中英文使用独立音色，旧 voice 只为其他语言回退', () => {
        const speech = {
            voice: 'legacy-other',
            chineseVoice: 'zh-natural',
            englishVoice: 'en-natural',
        };

        expect(resolveSpeechVoice(speech, 'zh_cn')).toBe('zh-natural');
        expect(resolveSpeechVoice(speech, 'zh-TW')).toBe('zh-natural');
        expect(resolveSpeechVoice(speech, 'en-US')).toBe('en-natural');
        expect(resolveSpeechVoice(speech, 'ja')).toBe('legacy-other');
        expect(resolveSpeechVoice(speech, 'zh')).toBe('zh-natural');
        expect(resolveSpeechVoice(speech, 'en')).toBe('en-natural');
    });

    it('调用系统朗读时使用设置中的语言音色', async () => {
        mocks.invoke
            .mockResolvedValueOnce({
                speech: {
                    voice: 'legacy-other',
                    chineseVoice: 'zh-natural',
                    englishVoice: 'en-natural',
                    rate: 1.3,
                },
            })
            .mockResolvedValueOnce([82, 73, 70, 70]);

        await synthesizeSpeech({ text: 'flux', language: 'en' });

        expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'get_settings_v2');
        expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'system_tts', {
            text: 'flux',
            lang: 'en',
            voice: 'en-natural',
            rate: 1.3,
        });
    });

    it('显式试听音色优先于已保存设置', async () => {
        mocks.invoke.mockResolvedValueOnce({ speech: { englishVoice: 'saved-voice', rate: 1 } });
        mocks.invoke.mockResolvedValueOnce([82, 73, 70, 70]);

        await synthesizeSpeech({ text: 'preview', language: 'en', voice: 'preview-voice', rate: 0.9 });

        expect(mocks.invoke).toHaveBeenLastCalledWith('system_tts', {
            text: 'preview',
            lang: 'en',
            voice: 'preview-voice',
            rate: 0.9,
        });
    });
});
