import { describe, expect, it } from 'vitest';

import {
    DEFAULT_SETTINGS_V2,
    hotkeyFromKeyboardEvent,
    mergeSettingsV2,
    normalizeHotkey,
    normalizeOllamaRequestPath,
    prepareSettingsForSave,
} from './settings';

describe('SettingsV2 主窗口适配', () => {
    it('补齐后端未返回的嵌套默认值并迁移为单一 Gemma 4', () => {
        const settings = mergeSettingsV2({ theme: 'dark', ollama: { translation: { model: 'custom' } } });
        expect(settings.theme).toBe('dark');
        expect(settings.ollama.translation.model).toBe('gemma4:e4b-it-qat');
        expect(settings.ollama.research.model).toBe('gemma4:e4b-it-qat');
        expect(settings.ollama.vision.model).toBe('gemma4:e4b-it-qat');
        expect(settings.ollama.embedding.model).toBe('gemma4:e4b-it-qat');
        expect(settings.ollama.enabled).toBe(true);
        expect(settings.hotkeys.selectionTranslate).toBe('CommandOrControl+D');
        expect(settings.version).toBe(6);
        expect(settings.documents.texCompiler).toBe('auto');
        expect(settings.speech).toMatchObject({
            engine: 'system',
            voice: '',
            chineseVoice: '',
            englishVoice: '',
        });
    });

    it('保留用户关闭 Ollama 的选择，保存时不被默认值覆盖', () => {
        const settings = prepareSettingsForSave({
            ...DEFAULT_SETTINGS_V2,
            ollama: { ...DEFAULT_SETTINGS_V2.ollama, enabled: false },
        });
        expect(settings.ollama.enabled).toBe(false);
    });

    it('把 Windows 常见快捷键写法归一化', () => {
        expect(normalizeHotkey('ctrl+d')).toBe('CommandOrControl+D');
        expect(normalizeHotkey('Shift + Alt + e')).toBe('Alt+Shift+E');
        expect(normalizeHotkey('D')).toBe('');
        expect(normalizeHotkey('cmd + option + shift + x + y')).toBe('CommandOrControl+Alt+Shift+X');
        for (const value of ['⌘+d', 'Command+d', 'Cmd+d', 'Meta+d']) {
            expect(normalizeHotkey(value)).toBe('CommandOrControl+D');
        }
        expect(normalizeHotkey('')).toBe('');
    });

    it('从键盘事件生成 Tauri 快捷键', () => {
        expect(
            hotkeyFromKeyboardEvent({ key: 'd', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })
        ).toBe('CommandOrControl+D');
        expect(hotkeyFromKeyboardEvent({ key: ' ', ctrlKey: false, metaKey: true, altKey: true, shiftKey: true })).toBe(
            'CommandOrControl+Alt+Shift+Space'
        );
        expect(
            hotkeyFromKeyboardEvent({ key: 'Shift', ctrlKey: false, metaKey: false, altKey: false, shiftKey: true })
        ).toBe('');
        expect(
            hotkeyFromKeyboardEvent({ key: 'x', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
        ).toBe('');
    });

    it('保存时统一 Ollama 地址并限制数值范围', () => {
        const settings = prepareSettingsForSave({
            ...DEFAULT_SETTINGS_V2,
            ollama: {
                ...DEFAULT_SETTINGS_V2.ollama,
                translation: {
                    ...DEFAULT_SETTINGS_V2.ollama.translation,
                    requestPath: 'http://localhost:11434/',
                },
            },
            speech: {
                engine: 'unfinished-neural-engine',
                voice: '  fallback  ',
                chineseVoice: '  zh-natural  ',
                englishVoice: '  en-natural  ',
                rate: 9,
            },
            window: { ...DEFAULT_SETTINGS_V2.window, blurGuardMs: 9999 },
        });
        expect(settings.ollama.translation.requestPath).toBe('http://127.0.0.1:11434');
        expect(settings.ollama.vision.requestPath).toBe('http://127.0.0.1:11434');
        expect(settings.speech.rate).toBe(2);
        expect(settings.speech).toMatchObject({
            engine: 'system',
            voice: 'fallback',
            chineseVoice: 'zh-natural',
            englishVoice: 'en-natural',
        });
        expect(settings.window.blurGuardMs).toBe(2000);
    });

    it('把旧的 11435 思考代理迁回 Ollama 原生端口', () => {
        const settings = prepareSettingsForSave({
            ...DEFAULT_SETTINGS_V2,
            version: 2,
            ollama: {
                ...DEFAULT_SETTINGS_V2.ollama,
                translation: {
                    ...DEFAULT_SETTINGS_V2.ollama.translation,
                    requestPath: 'http://127.0.0.1:11435/',
                },
            },
        });
        expect(settings.version).toBe(6);
        expect(settings.ollama.translation.requestPath).toBe('http://127.0.0.1:11434');
    });

    it('把所有本机 Ollama 写法统一成不会触发 WebView 跨域的回环地址', () => {
        for (const path of [
            'localhost:11434',
            'http://localhost:11435/',
            'https://127.0.0.1:11435',
            'http://[::1]:11434/',
        ]) {
            expect(normalizeOllamaRequestPath(path)).toBe('http://127.0.0.1:11434');
        }
        expect(normalizeOllamaRequestPath('http://192.168.1.9:11435/')).toBe('http://192.168.1.9:11435');
    });

    it('保存时补齐空地址、清理模型与路径并应用下限', () => {
        const settings = prepareSettingsForSave({
            ollama: {
                translation: { requestPath: '', model: '  translate  ' },
                research: { model: '  research  ' },
                vision: { model: '  vision  ' },
                embedding: { model: '  embed  ' },
            },
            hotkeys: { selectionTranslate: 'CTRL+q', screenshotTranslate: 'alt+w' },
            speech: { rate: 0 },
            window: { blurGuardMs: -5 },
            libraryPath: '   ',
        });
        expect(settings.ollama.translation.requestPath).toBe('http://127.0.0.1:11434');
        expect(settings.ollama.translation.model).toBe('gemma4:e4b-it-qat');
        expect(settings.ollama.research.model).toBe('gemma4:e4b-it-qat');
        expect(settings.ollama.vision.model).toBe('gemma4:e4b-it-qat');
        expect(settings.ollama.embedding.model).toBe('gemma4:e4b-it-qat');
        expect(settings.hotkeys).toMatchObject({
            selectionTranslate: 'CommandOrControl+Q',
            screenshotTranslate: 'Alt+W',
        });
        expect(settings.speech.rate).toBe(1);
        expect(settings.window.blurGuardMs).toBe(0);
        expect(settings.documents.texCompiler).toBe('auto');
        expect(settings.libraryPath).toBeNull();
    });

    it('规范化 TeX 编译器并拒绝任意命令', () => {
        expect(prepareSettingsForSave({ documents: { texCompiler: '  XeLaTeX ' } }).documents.texCompiler).toBe(
            'xelatex'
        );
        expect(prepareSettingsForSave({ documents: { texCompiler: 'powershell.exe' } }).documents.texCompiler).toBe(
            'auto'
        );
    });

    it('平滑保留旧版单一朗读音色为其他语言回退', () => {
        const settings = mergeSettingsV2({
            version: 5,
            speech: { voice: 'Legacy Voice', rate: 1.2 },
        });

        expect(settings.version).toBe(6);
        expect(settings.speech).toEqual({
            engine: 'system',
            voice: 'Legacy Voice',
            chineseVoice: '',
            englishVoice: '',
            rate: 1.2,
        });
    });
});
