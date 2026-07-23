import { SETTINGS_VERSION, UNIFIED_OLLAMA_MODEL, unifyOllamaEndpoints } from '../../domains/ollama/runtime';

/**
 * 主窗口使用的 SettingsV2 默认值与归一化工具。
 *
 * 这里刻意只描述 4.x 仍在使用的 Ollama、本地语音、快捷键、窗口与论文库设置，
 * 避免旧版任意服务列表重新渗入新界面。
 */
export const DEFAULT_SETTINGS_V2 = Object.freeze({
    version: SETTINGS_VERSION,
    ollama: {
        enabled: true,
        translation: {
            requestPath: 'http://127.0.0.1:11434',
            model: UNIFIED_OLLAMA_MODEL,
            stream: true,
        },
        research: {
            requestPath: 'http://127.0.0.1:11434',
            model: UNIFIED_OLLAMA_MODEL,
            stream: false,
        },
        vision: {
            requestPath: 'http://127.0.0.1:11434',
            model: UNIFIED_OLLAMA_MODEL,
            stream: false,
        },
        embedding: {
            requestPath: 'http://127.0.0.1:11434',
            model: UNIFIED_OLLAMA_MODEL,
            stream: false,
        },
        embeddingInstallConfirmed: false,
        semanticEmbeddingsEnabled: false,
    },
    sourceLanguage: 'auto',
    targetLanguage: 'zh_cn',
    hotkeys: {
        selectionTranslate: 'CommandOrControl+D',
        screenshotTranslate: 'CommandOrControl+E',
        inputTranslate: 'CommandOrControl+G',
    },
    speech: {
        voice: '',
        rate: 1,
    },
    window: {
        translatePosition: 'mouse',
        hideOnBlur: true,
        blurGuardMs: 500,
        pinByDefault: false,
    },
    documents: {
        texCompiler: 'auto',
    },
    theme: 'light',
    libraryPath: null,
});

const clone = (value) => JSON.parse(JSON.stringify(value));

export function mergeSettingsV2(value = {}) {
    const defaults = clone(DEFAULT_SETTINGS_V2);
    const merged = {
        ...defaults,
        ...value,
        version: SETTINGS_VERSION,
        ollama: {
            ...defaults.ollama,
            ...(value.ollama ?? {}),
            translation: {
                ...defaults.ollama.translation,
                ...(value.ollama?.translation ?? {}),
            },
            research: {
                ...defaults.ollama.research,
                ...(value.ollama?.research ?? {}),
            },
            vision: {
                ...defaults.ollama.vision,
                ...(value.ollama?.vision ?? {}),
            },
            embedding: {
                ...defaults.ollama.embedding,
                ...(value.ollama?.embedding ?? {}),
            },
        },
        hotkeys: { ...defaults.hotkeys, ...(value.hotkeys ?? {}) },
        speech: { ...defaults.speech, ...(value.speech ?? {}) },
        window: { ...defaults.window, ...(value.window ?? {}) },
        documents: { ...defaults.documents, ...(value.documents ?? {}) },
    };
    merged.ollama = unifyOllamaEndpoints(merged.ollama);
    return merged;
}

const HOTKEY_MODIFIER_ORDER = ['CommandOrControl', 'Alt', 'Shift'];

export function normalizeHotkey(value) {
    const rawParts = String(value ?? '')
        .split('+')
        .map((part) => part.trim())
        .filter(Boolean);
    const parts = new Set();
    let key = '';

    rawParts.forEach((part) => {
        const lower = part.toLowerCase();
        if (['ctrl', 'control', 'cmd', 'command', 'meta', 'commandorcontrol', '⌘'].includes(lower)) {
            parts.add('CommandOrControl');
        } else if (lower === 'alt' || lower === 'option') {
            parts.add('Alt');
        } else if (lower === 'shift') {
            parts.add('Shift');
        } else if (!key) {
            key = part.length === 1 ? part.toLocaleUpperCase() : part;
        }
    });

    if (!key || parts.size === 0) return '';
    return [...HOTKEY_MODIFIER_ORDER.filter((part) => parts.has(part)), key].join('+');
}

export function hotkeyFromKeyboardEvent(event) {
    const modifiers = [];
    if (event.ctrlKey || event.metaKey) modifiers.push('CommandOrControl');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('Shift');

    const modifierKeys = new Set(['Control', 'Meta', 'Alt', 'Shift']);
    if (modifierKeys.has(event.key) || modifiers.length === 0) return '';

    let key = event.key;
    if (key.length === 1) key = key.toLocaleUpperCase();
    if (key === ' ') key = 'Space';
    return normalizeHotkey([...modifiers, key].join('+'));
}

export function normalizeOllamaRequestPath(value) {
    const fallback = DEFAULT_SETTINGS_V2.ollama.translation.requestPath;
    const raw = String(value ?? '')
        .trim()
        .replace(/\/+$/u, '');
    if (!raw) return fallback;
    const candidate = /^[a-z][a-z\d+.-]*:\/\//iu.test(raw) ? raw : `http://${raw}`;
    const url = new URL(candidate);
    const hostname = url.hostname.toLocaleLowerCase();
    const isLocal = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
    const port = url.port || (url.protocol === 'http:' ? '80' : '443');
    if (isLocal && ['11434', '11435'].includes(port)) return fallback;
    return candidate.replace(/\/+$/u, '');
}

export function prepareSettingsForSave(value) {
    const settings = mergeSettingsV2(value);
    const requestPath = normalizeOllamaRequestPath(settings.ollama.translation.requestPath);
    const rate = Math.min(2, Math.max(0.5, Number(settings.speech.rate) || 1));
    const blurGuardMs = Math.min(2000, Math.max(0, Math.round(Number(settings.window.blurGuardMs) || 0)));
    const supportedTexCompilers = new Set(['auto', 'latexmk', 'xelatex', 'pdflatex', 'tectonic']);
    const requestedTexCompiler = String(settings.documents.texCompiler ?? '')
        .trim()
        .toLocaleLowerCase();
    const texCompiler = supportedTexCompilers.has(requestedTexCompiler) ? requestedTexCompiler : 'auto';

    const ollama = unifyOllamaEndpoints({
        ...settings.ollama,
        translation: {
            ...settings.ollama.translation,
            requestPath,
            model: String(settings.ollama.translation.model).trim(),
        },
    });

    return {
        ...settings,
        version: SETTINGS_VERSION,
        ollama,
        hotkeys: {
            ...settings.hotkeys,
            selectionTranslate: normalizeHotkey(settings.hotkeys.selectionTranslate),
            screenshotTranslate: normalizeHotkey(settings.hotkeys.screenshotTranslate),
        },
        speech: { ...settings.speech, rate },
        window: { ...settings.window, blurGuardMs },
        documents: { ...settings.documents, texCompiler },
        libraryPath: String(settings.libraryPath ?? '').trim() || null,
    };
}
