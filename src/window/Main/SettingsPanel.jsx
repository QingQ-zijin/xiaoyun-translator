import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
    PiBrain,
    PiCheckCircle,
    PiCpu,
    PiFloppyDisk,
    PiFolder,
    PiKeyboard,
    PiMonitor,
    PiMoon,
    PiSpeakerHigh,
    PiSpinnerGap,
    PiTranslate,
    PiWarningCircle,
} from 'react-icons/pi';

import {
    DEFAULT_SETTINGS_V2,
    hotkeyFromKeyboardEvent,
    mergeSettingsV2,
    normalizeHotkey,
    prepareSettingsForSave,
} from './settings';
import OllamaOnboardingCard from './OllamaOnboardingCard';
import OllamaModelSelect from './OllamaModelSelect';
import { UNIFIED_OLLAMA_MODEL } from '../../domains/ollama/runtime';

const LANGUAGE_OPTIONS = [
    ['auto', '自动检测'],
    ['zh_cn', '简体中文'],
    ['zh_tw', '繁体中文'],
    ['en', '英语'],
    ['ja', '日语'],
    ['ko', '韩语'],
    ['de', '德语'],
    ['fr', '法语'],
    ['es', '西班牙语'],
    ['ru', '俄语'],
];

const SETTINGS_NAV = [
    ['ollama', 'Ollama', PiCpu],
    ['language', '语言', PiTranslate],
    ['hotkey', '快捷键', PiKeyboard],
    ['speech', '朗读', PiSpeakerHigh],
    ['window', '窗口', PiMonitor],
    ['library', '文献存储', PiFolder],
];

function initialSettingsSection() {
    const requested = String(globalThis.location?.hash ?? '').replace(/^#settings-/u, '');
    return SETTINGS_NAV.some(([id]) => id === requested) ? requested : 'ollama';
}

const isTauriRuntime = () =>
    Boolean(
        globalThis.window?.__TAURI__ || globalThis.window?.__TAURI_METADATA__ || globalThis.window?.__TAURI_INTERNALS__
    );

function SettingSection({ id, Icon, title, description, active, children }) {
    return (
        <section
            className='settings-section'
            id={`settings-${id}`}
            hidden={!active}
            aria-labelledby={`settings-nav-${id}`}
        >
            <div className='settings-section__intro'>
                <span className='settings-section__icon'>
                    <Icon aria-hidden='true' />
                </span>
                <div>
                    <h2>{title}</h2>
                    <p>{description}</p>
                </div>
            </div>
            <div className='settings-section__fields'>{children}</div>
        </section>
    );
}

function SettingRow({ label, hint, children, align = 'center' }) {
    return (
        <div className={`setting-row setting-row--${align}`}>
            <div>
                <strong>{label}</strong>
                {hint ? <span>{hint}</span> : null}
            </div>
            <div className='setting-row__control'>{children}</div>
        </div>
    );
}

function Toggle({ checked, onChange, label }) {
    return (
        <label className='settings-toggle'>
            <input
                type='checkbox'
                checked={checked}
                onChange={(event) => onChange(event.target.checked)}
            />
            <span aria-hidden='true'>
                <i />
            </span>
            <em>{label}</em>
        </label>
    );
}

function HotkeyInput({ value, onChange, ariaLabel }) {
    return (
        <input
            className='settings-hotkey-input'
            aria-label={ariaLabel}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onBlur={(event) => {
                const normalized = normalizeHotkey(event.target.value);
                if (normalized) onChange(normalized);
            }}
            onKeyDown={(event) => {
                if (event.key === 'Tab') return;
                event.preventDefault();
                if (event.key === 'Backspace' || event.key === 'Delete') {
                    onChange('');
                    return;
                }
                const next = hotkeyFromKeyboardEvent(event);
                if (next) onChange(next);
            }}
            spellCheck='false'
        />
    );
}

export default function SettingsPanel() {
    const [settings, setSettings] = useState(() => mergeSettingsV2(DEFAULT_SETTINGS_V2));
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [notice, setNotice] = useState({ type: '', text: '' });
    const [systemVoices, setSystemVoices] = useState([]);
    const [installedModels, setInstalledModels] = useState([]);
    const [modelListError, setModelListError] = useState('');
    const [activeSection, setActiveSection] = useState(initialSettingsSection);
    const originalSettingsRef = useRef(mergeSettingsV2(DEFAULT_SETTINGS_V2));

    useLayoutEffect(() => {
        if (!String(globalThis.location?.hash ?? '').startsWith('#settings-')) return;
        const cleanUrl = `${globalThis.location.pathname}${globalThis.location.search}`;
        globalThis.history?.replaceState?.(globalThis.history.state, '', cleanUrl);
    }, []);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const [value, voices, models] = await Promise.all([
                    isTauriRuntime() ? invoke('get_settings_v2') : Promise.resolve(DEFAULT_SETTINGS_V2),
                    isTauriRuntime() ? invoke('list_system_voices').catch(() => []) : Promise.resolve([]),
                    isTauriRuntime()
                        ? invoke('research_list_ollama_models')
                              .then((items) => ({ items, error: '' }))
                              .catch((reason) => ({ items: [], error: String(reason) }))
                        : Promise.resolve({ items: [], error: '' }),
                ]);
                if (cancelled) return;
                const normalized = mergeSettingsV2(value);
                setSettings(normalized);
                originalSettingsRef.current = normalized;
                setSystemVoices(Array.isArray(voices) ? voices : []);
                setInstalledModels(Array.isArray(models.items) ? models.items : []);
                setModelListError(models.error);
            } catch (reason) {
                if (!cancelled) setNotice({ type: 'error', text: `读取设置失败：${String(reason)}` });
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        void load();
        return () => {
            cancelled = true;
        };
    }, []);

    const setOllamaEndpoint = useCallback((endpoint, key, value) => {
        setSettings((current) => ({
            ...current,
            ollama: {
                ...current.ollama,
                [endpoint]: { ...current.ollama[endpoint], [key]: value },
            },
        }));
    }, []);

    const setHotkey = useCallback((key, value) => {
        setSettings((current) => ({ ...current, hotkeys: { ...current.hotkeys, [key]: value } }));
    }, []);

    const setSpeech = useCallback((key, value) => {
        setSettings((current) => ({ ...current, speech: { ...current.speech, [key]: value } }));
    }, []);

    const setWindowSetting = useCallback((key, value) => {
        setSettings((current) => ({ ...current, window: { ...current.window, [key]: value } }));
    }, []);

    const setDocumentSetting = useCallback((key, value) => {
        setSettings((current) => ({ ...current, documents: { ...current.documents, [key]: value } }));
    }, []);

    const handleOllamaSetupStatus = useCallback((status) => {
        if (status?.running) setModelListError('');
        if (!status?.modelInstalled || !status?.model) return;
        setInstalledModels((current) => {
            const exists = current.some(
                (item) =>
                    String(item?.name ?? item?.model)
                        .trim()
                        .toLocaleLowerCase() === status.model.trim().toLocaleLowerCase()
            );
            return exists ? current : [...current, { name: status.model, size: 0 }];
        });
    }, []);

    const saveSettings = async () => {
        const next = prepareSettingsForSave(settings);
        if (!next.ollama.translation.model) {
            setNotice({ type: 'error', text: '统一 Ollama 模型名称不能为空。' });
            return;
        }
        if (!next.hotkeys.selectionTranslate || !next.hotkeys.screenshotTranslate) {
            setNotice({ type: 'error', text: 'Ctrl+D 与 Ctrl+E 都必须是包含修饰键的有效组合。' });
            return;
        }

        setSaving(true);
        setNotice({ type: '', text: '' });
        const previous = originalSettingsRef.current;
        const changedHotkeys = [
            ['hotkey_selection_translate', 'selectionTranslate'],
            ['hotkey_ocr_translate', 'screenshotTranslate'],
        ].filter(([, key]) => previous.hotkeys[key] !== next.hotkeys[key]);
        const ollamaRuntimeChanged =
            previous.ollama.enabled !== next.ollama.enabled ||
            previous.ollama.translation.model !== next.ollama.translation.model ||
            previous.ollama.translation.requestPath !== next.ollama.translation.requestPath;
        const registered = [];
        let settingsSaved = false;

        try {
            if (isTauriRuntime()) {
                for (const [name, key] of changedHotkeys) {
                    await invoke('register_shortcut_by_frontend', { name, shortcut: next.hotkeys[key] });
                    registered.push([name, key]);
                }
                await invoke('update_settings_v2', { settings: next });
                settingsSaved = true;
                if (ollamaRuntimeChanged) {
                    await invoke('apply_ollama_runtime_state', { enabled: next.ollama.enabled });
                }
            }
            setSettings(next);
            originalSettingsRef.current = next;
            setNotice({ type: 'success', text: isTauriRuntime() ? '设置已保存并生效。' : '预览模式：设置校验通过。' });
        } catch (reason) {
            if (isTauriRuntime()) {
                if (settingsSaved) {
                    try {
                        await invoke('update_settings_v2', { settings: previous });
                        await invoke('apply_ollama_runtime_state', { enabled: previous.ollama.enabled });
                    } catch {
                        // 保留原错误；后端日志会记录运行态回滚失败。
                    }
                }
                for (const [name, key] of registered.reverse()) {
                    try {
                        await invoke('register_shortcut_by_frontend', { name, shortcut: previous.hotkeys[key] });
                    } catch {
                        // 后端日志会记录回滚失败；界面保留错误提示，避免误报成功。
                    }
                }
            }
            setNotice({ type: 'error', text: `保存失败，已回滚可恢复的快捷键：${String(reason)}` });
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <section className='main-page main-page--settings settings-loading'>
                <PiSpinnerGap
                    className='is-spinning'
                    aria-hidden='true'
                />
                <span>正在读取设置…</span>
            </section>
        );
    }

    const ollamaHost = settings.ollama.translation.requestPath;
    return (
        <section className='main-page main-page--settings'>
            <header className='main-page__header main-page__header--settings'>
                <div>
                    <h1>设置</h1>
                    <p>只保留学术翻译、论文阅读与本地 AI 所需的选项。</p>
                </div>
                <button
                    className='main-primary-button'
                    type='button'
                    onClick={saveSettings}
                    disabled={saving}
                >
                    {saving ? (
                        <PiSpinnerGap
                            className='is-spinning'
                            aria-hidden='true'
                        />
                    ) : (
                        <PiFloppyDisk aria-hidden='true' />
                    )}
                    {saving ? '保存中' : '保存设置'}
                </button>
            </header>

            <div className='settings-layout'>
                <aside
                    className='settings-subnav'
                    aria-label='设置分类'
                >
                    {SETTINGS_NAV.map(([id, label, Icon]) => (
                        <button
                            id={`settings-nav-${id}`}
                            className={activeSection === id ? 'is-active' : ''}
                            type='button'
                            key={id}
                            aria-pressed={activeSection === id}
                            onClick={() => setActiveSection(id)}
                        >
                            <Icon aria-hidden='true' />
                            <span>{label}</span>
                        </button>
                    ))}
                    <div className='settings-subnav__privacy'>
                        <PiCheckCircle aria-hidden='true' />
                        <span>翻译、OCR、朗读与论文数据均留在本机</span>
                    </div>
                </aside>

                <div className='settings-content'>
                    {notice.text ? (
                        <div
                            className={`settings-notice is-${notice.type}`}
                            role='status'
                        >
                            {notice.type === 'success' ? (
                                <PiCheckCircle aria-hidden='true' />
                            ) : (
                                <PiWarningCircle aria-hidden='true' />
                            )}
                            <span>{notice.text}</span>
                        </div>
                    ) : null}

                    <SettingSection
                        id='ollama'
                        Icon={PiCpu}
                        title='Ollama 与模型'
                        description='开启后立即预热翻译模型；关闭会取消生成并释放本地模型占用。'
                        active={activeSection === 'ollama'}
                    >
                        <OllamaOnboardingCard onStatusChange={handleOllamaSetupStatus} />
                        <SettingRow
                            label='启用本地 Ollama'
                            hint='Ctrl+D、论文翻译、OCR 与 AI 共用此开关'
                        >
                            <Toggle
                                checked={settings.ollama.enabled}
                                onChange={(enabled) =>
                                    setSettings((current) => ({
                                        ...current,
                                        ollama: { ...current.ollama, enabled },
                                    }))
                                }
                                label={settings.ollama.enabled ? '已开启' : '已关闭'}
                            />
                        </SettingRow>
                        <SettingRow
                            label='Ollama 地址'
                            hint='通常无需修改'
                        >
                            <input
                                value={ollamaHost}
                                onChange={(event) =>
                                    setOllamaEndpoint('translation', 'requestPath', event.target.value)
                                }
                                placeholder='http://127.0.0.1:11434'
                            />
                        </SettingRow>
                        <SettingRow
                            label='统一多模态模型'
                            hint='翻译、OCR、论文概要、词典和问答共用一个 runner'
                        >
                            <OllamaModelSelect
                                modelRole='vision'
                                ariaLabel='当前统一多模态模型'
                                value={settings.ollama.translation.model}
                                installedModels={installedModels.filter(
                                    (model) => String(model.name ?? model.model).trim() === UNIFIED_OLLAMA_MODEL
                                )}
                                disabled
                            />
                        </SettingRow>
                        <SettingRow
                            label='论文检索'
                            hint='Gemma 4 不支持 embeddings，当前使用本地 SQLite FTS5 关键词检索'
                        >
                            <span className='settings-embedding-confirmed'>不会加载第二个模型</span>
                        </SettingRow>
                        {modelListError ? (
                            <p className='settings-model-list-error'>无法读取已安装模型：{modelListError}</p>
                        ) : null}
                    </SettingSection>

                    <SettingSection
                        id='language'
                        Icon={PiTranslate}
                        title='默认语言'
                        description='快速翻译与论文划词翻译会沿用这里的目标语言。'
                        active={activeSection === 'language'}
                    >
                        <SettingRow label='原文语言'>
                            <select
                                value={settings.sourceLanguage}
                                onChange={(event) =>
                                    setSettings((current) => ({ ...current, sourceLanguage: event.target.value }))
                                }
                            >
                                {LANGUAGE_OPTIONS.map(([value, label]) => (
                                    <option
                                        key={value}
                                        value={value}
                                    >
                                        {label}
                                    </option>
                                ))}
                            </select>
                        </SettingRow>
                        <SettingRow label='译文语言'>
                            <select
                                value={settings.targetLanguage}
                                onChange={(event) =>
                                    setSettings((current) => ({ ...current, targetLanguage: event.target.value }))
                                }
                            >
                                {LANGUAGE_OPTIONS.filter(([value]) => value !== 'auto').map(([value, label]) => (
                                    <option
                                        key={value}
                                        value={value}
                                    >
                                        {label}
                                    </option>
                                ))}
                            </select>
                        </SettingRow>
                    </SettingSection>

                    <SettingSection
                        id='hotkey'
                        Icon={PiKeyboard}
                        title='全局快捷键'
                        description='点击输入框后直接按下新组合；保存失败会恢复原组合。'
                        active={activeSection === 'hotkey'}
                    >
                        <SettingRow
                            label='划词翻译'
                            hint='默认 Ctrl+D'
                        >
                            <HotkeyInput
                                ariaLabel='划词翻译快捷键'
                                value={settings.hotkeys.selectionTranslate}
                                onChange={(value) => setHotkey('selectionTranslate', value)}
                            />
                        </SettingRow>
                        <SettingRow
                            label='截图翻译'
                            hint='默认 Ctrl+E'
                        >
                            <HotkeyInput
                                ariaLabel='截图翻译快捷键'
                                value={settings.hotkeys.screenshotTranslate}
                                onChange={(value) => setHotkey('screenshotTranslate', value)}
                            />
                        </SettingRow>
                    </SettingSection>

                    <SettingSection
                        id='speech'
                        Icon={PiSpeakerHigh}
                        title='Windows 本地朗读'
                        description='使用系统 SpeechSynthesizer，不再连接 Lingva 或其他网络语音。'
                        active={activeSection === 'speech'}
                    >
                        <SettingRow
                            label='声音'
                            hint='留空时按语言自动匹配系统声音'
                        >
                            {systemVoices.length > 0 ? (
                                <select
                                    value={settings.speech.voice}
                                    onChange={(event) => setSpeech('voice', event.target.value)}
                                >
                                    <option value=''>按语言自动选择</option>
                                    {settings.speech.voice &&
                                    !systemVoices.some((voice) => voice.id === settings.speech.voice) ? (
                                        <option value={settings.speech.voice}>当前声音（暂不可用）</option>
                                    ) : null}
                                    {systemVoices.map((voice) => (
                                        <option
                                            key={voice.id}
                                            value={voice.id}
                                        >
                                            {voice.name} · {voice.language}
                                        </option>
                                    ))}
                                </select>
                            ) : (
                                <input
                                    value={settings.speech.voice}
                                    onChange={(event) => setSpeech('voice', event.target.value)}
                                    placeholder='自动选择 Windows 声音'
                                />
                            )}
                        </SettingRow>
                        <SettingRow
                            label='语速'
                            hint={`${Number(settings.speech.rate).toFixed(1)}×`}
                        >
                            <input
                                className='settings-range'
                                type='range'
                                min='0.5'
                                max='2'
                                step='0.1'
                                value={settings.speech.rate}
                                onChange={(event) => setSpeech('rate', Number(event.target.value))}
                            />
                        </SettingRow>
                    </SettingSection>

                    <SettingSection
                        id='window'
                        Icon={PiMonitor}
                        title='快速翻译窗口'
                        description='控制 Ctrl+D 弹窗的位置、失焦隐藏与默认置顶状态。'
                        active={activeSection === 'window'}
                    >
                        <SettingRow label='弹出位置'>
                            <select
                                value={settings.window.translatePosition}
                                onChange={(event) => setWindowSetting('translatePosition', event.target.value)}
                            >
                                <option value='mouse'>跟随鼠标</option>
                                <option value='center'>屏幕中央</option>
                                <option value='top-right'>右上角</option>
                            </select>
                        </SettingRow>
                        <SettingRow
                            label='失焦隐藏'
                            hint='抓取与翻译期间不会隐藏'
                        >
                            <Toggle
                                checked={settings.window.hideOnBlur}
                                onChange={(value) => setWindowSetting('hideOnBlur', value)}
                                label={settings.window.hideOnBlur ? '已开启' : '已关闭'}
                            />
                        </SettingRow>
                        <SettingRow
                            label='展示保护期'
                            hint='弹出后这段时间内忽略失焦'
                        >
                            <div className='settings-suffix-input'>
                                <input
                                    type='number'
                                    min='0'
                                    max='2000'
                                    step='50'
                                    value={settings.window.blurGuardMs}
                                    onChange={(event) => setWindowSetting('blurGuardMs', Number(event.target.value))}
                                />
                                <span>ms</span>
                            </div>
                        </SettingRow>
                        <SettingRow label='默认置顶'>
                            <Toggle
                                checked={settings.window.pinByDefault}
                                onChange={(value) => setWindowSetting('pinByDefault', value)}
                                label={settings.window.pinByDefault ? '已开启' : '已关闭'}
                            />
                        </SettingRow>
                        <SettingRow label='主题'>
                            <div className='settings-model-input'>
                                <PiMoon aria-hidden='true' />
                                <select
                                    value={settings.theme}
                                    onChange={(event) =>
                                        setSettings((current) => ({ ...current, theme: event.target.value }))
                                    }
                                >
                                    <option value='light'>浅色</option>
                                    <option value='dark'>深色</option>
                                    <option value='system'>跟随系统</option>
                                </select>
                            </div>
                        </SettingRow>
                    </SettingSection>

                    <SettingSection
                        id='library'
                        Icon={PiFolder}
                        title='文献存储'
                        description='导入的文献、索引、标签和笔记均保存在你选择的本地目录。'
                        active={activeSection === 'library'}
                    >
                        <SettingRow
                            label='文献库路径'
                            hint='修改后仅影响后续导入'
                            align='start'
                        >
                            <textarea
                                rows='2'
                                value={settings.libraryPath ?? ''}
                                onChange={(event) =>
                                    setSettings((current) => ({ ...current, libraryPath: event.target.value }))
                                }
                                placeholder={'例如 D:\\Papers\\小允文献库'}
                                spellCheck='false'
                            />
                        </SettingRow>
                        <SettingRow
                            label='TeX 编译器'
                            hint='导入 .tex 时使用；自动模式优先选择本机已安装且可用的编译器'
                        >
                            <select
                                aria-label='TeX 编译器'
                                value={settings.documents.texCompiler}
                                onChange={(event) => setDocumentSetting('texCompiler', event.target.value)}
                            >
                                <option value='auto'>自动选择（推荐）</option>
                                <option value='latexmk'>latexmk</option>
                                <option value='xelatex'>XeLaTeX</option>
                                <option value='pdflatex'>pdfLaTeX</option>
                                <option value='tectonic'>Tectonic</option>
                            </select>
                        </SettingRow>
                        <div className='settings-library-note'>
                            <PiBrain aria-hidden='true' />
                            <p>
                                <strong>本地优先</strong>
                                <span>
                                    不会自动同步云端，也不会修改原始文件。PDF、Markdown、DOCX 与 TeX
                                    的标注、笔记和索引单独保存在 research.db。
                                </span>
                            </p>
                        </div>
                    </SettingSection>
                </div>
            </div>
        </section>
    );
}
