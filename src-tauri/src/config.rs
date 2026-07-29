//! 小允翻译的版本化配置。
//!
//! 4.x 只保留 Ollama、本机朗读、快捷键、窗口和论文库设置。旧的动态服务列表
//! 仍留在一次性备份文件中，但运行时不再加载它们。

use crate::APP;
use dirs::config_dir;
use log::{info, warn};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager, Wry};
use tauri_plugin_store::{Store, StoreBuilder};

pub struct StoreWrapper(pub Arc<Store<Wry>>);

pub const SETTINGS_VERSION: u8 = 6;

/// 4.3 起所有生成任务共用一个本地多模态模型，避免 8GB 显存中同时驻留多个 runner。
pub const UNIFIED_OLLAMA_MODEL: &str = "gemma4:e4b-it-qat";
pub const UNIFIED_OLLAMA_CONTEXT_TOKENS: usize = 8_192;

pub const TEX_COMPILERS: [&str; 5] = ["auto", "tectonic", "xelatex", "pdflatex", "latexmk"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct OllamaEndpointSettings {
    pub request_path: String,
    pub model: String,
    pub stream: bool,
}

impl Default for OllamaEndpointSettings {
    fn default() -> Self {
        Self {
            request_path: "http://127.0.0.1:11434".to_string(),
            model: UNIFIED_OLLAMA_MODEL.to_string(),
            stream: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct OllamaSettings {
    /// 是否启用本地 Ollama 后端。关闭时不预热，并主动卸载当前模型。
    pub enabled: bool,
    pub translation: OllamaEndpointSettings,
    /// 论文概要、术语注释与上下文词典复用同一个常驻多模态模型。
    pub research: OllamaEndpointSettings,
    pub vision: OllamaEndpointSettings,
    pub embedding: OllamaEndpointSettings,
    pub embedding_install_confirmed: bool,
    /// Gemma 4 没有 embeddings 能力；关闭时论文检索只使用本地 SQLite FTS5。
    pub semantic_embeddings_enabled: bool,
}

impl Default for OllamaSettings {
    fn default() -> Self {
        let translation = OllamaEndpointSettings::default();
        Self {
            enabled: true,
            research: OllamaEndpointSettings {
                stream: false,
                ..translation.clone()
            },
            vision: OllamaEndpointSettings {
                stream: false,
                ..translation.clone()
            },
            embedding: OllamaEndpointSettings {
                stream: false,
                ..translation.clone()
            },
            translation,
            embedding_install_confirmed: false,
            semantic_embeddings_enabled: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct HotkeySettings {
    pub selection_translate: String,
    pub screenshot_translate: String,
    pub input_translate: String,
}

impl Default for HotkeySettings {
    fn default() -> Self {
        Self {
            selection_translate: "CommandOrControl+D".to_string(),
            screenshot_translate: "CommandOrControl+E".to_string(),
            input_translate: "CommandOrControl+G".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SpeechSettings {
    /// 当前仅使用操作系统本地语音；该引擎零下载、零显存占用。
    pub engine: String,
    /// 旧版单一音色保留为其他语言的兼容回退，不静默猜测它属于中文还是英文。
    pub voice: String,
    pub chinese_voice: String,
    pub english_voice: String,
    pub rate: f32,
}

impl Default for SpeechSettings {
    fn default() -> Self {
        Self {
            engine: "system".to_string(),
            voice: String::new(),
            chinese_voice: String::new(),
            english_voice: String::new(),
            rate: 1.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowSettings {
    pub translate_position: String,
    pub hide_on_blur: bool,
    pub blur_guard_ms: u16,
    pub pin_by_default: bool,
}

impl Default for WindowSettings {
    fn default() -> Self {
        Self {
            translate_position: "mouse".to_string(),
            hide_on_blur: true,
            blur_guard_ms: 500,
            pin_by_default: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DocumentSettings {
    /// TeX 导入时使用的编译器。`auto` 会按可用性选择本机编译器。
    pub tex_compiler: String,
}

impl Default for DocumentSettings {
    fn default() -> Self {
        Self {
            tex_compiler: "auto".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsV2 {
    pub version: u8,
    pub ollama: OllamaSettings,
    pub source_language: String,
    pub target_language: String,
    pub hotkeys: HotkeySettings,
    pub speech: SpeechSettings,
    pub window: WindowSettings,
    pub documents: DocumentSettings,
    pub theme: String,
    pub library_path: Option<String>,
}

impl Default for SettingsV2 {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            ollama: OllamaSettings::default(),
            source_language: "auto".to_string(),
            target_language: "zh_cn".to_string(),
            hotkeys: HotkeySettings::default(),
            speech: SpeechSettings::default(),
            window: WindowSettings::default(),
            documents: DocumentSettings::default(),
            theme: "light".to_string(),
            library_path: None,
        }
    }
}

fn legacy_string(store: &Store<Wry>, key: &str) -> Option<String> {
    store
        .get(key)
        .and_then(|value| value.as_str().map(str::trim).map(str::to_string))
        .filter(|value| !value.is_empty())
}

fn legacy_ollama_config(store: &Store<Wry>, prefix: &str) -> Option<Value> {
    store
        .entries()
        .into_iter()
        .find_map(|(key, value)| (key.split('@').next() == Some(prefix)).then(|| value.clone()))
}

fn migrate_settings(store: &Store<Wry>) -> SettingsV2 {
    let mut settings = SettingsV2::default();
    settings.source_language = legacy_string(store, "translate_source_language")
        .unwrap_or_else(|| settings.source_language.clone());
    settings.target_language = legacy_string(store, "translate_target_language")
        .unwrap_or_else(|| settings.target_language.clone());
    settings.theme = legacy_string(store, "app_theme").unwrap_or(settings.theme);
    settings.library_path = legacy_string(store, "research_library_path");

    settings.hotkeys.selection_translate = legacy_string(store, "hotkey_selection_translate")
        .unwrap_or(settings.hotkeys.selection_translate);
    settings.hotkeys.screenshot_translate = legacy_string(store, "hotkey_ocr_translate")
        .unwrap_or(settings.hotkeys.screenshot_translate);
    settings.hotkeys.input_translate =
        legacy_string(store, "hotkey_input_translate").unwrap_or(settings.hotkeys.input_translate);
    settings.window.translate_position = legacy_string(store, "translate_window_position")
        .unwrap_or(settings.window.translate_position);

    if let Some(config) = legacy_ollama_config(store, "ollama") {
        if let Some(path) = config.get("requestPath").and_then(Value::as_str) {
            settings.ollama.translation.request_path = path.trim_end_matches('/').to_string();
        }
        if let Some(model) = config.get("model").and_then(Value::as_str) {
            settings.ollama.translation.model = model.to_string();
        }
    }
    if let Some(config) = legacy_ollama_config(store, "ollama_ocr") {
        if let Some(path) = config.get("requestPath").and_then(Value::as_str) {
            settings.ollama.vision.request_path = path.trim_end_matches('/').to_string();
        }
        if let Some(model) = config.get("model").and_then(Value::as_str) {
            settings.ollama.vision.model = model.to_string();
        }
    }
    settings
}

pub(crate) fn normalize_ollama_request_path(path: &str) -> String {
    const LOCAL_OLLAMA: &str = "http://127.0.0.1:11434";

    let trimmed = path.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return LOCAL_OLLAMA.to_string();
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    if let Ok(url) = reqwest::Url::parse(&candidate) {
        let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
        let port = url.port_or_known_default();
        let is_local = matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1" | "[::1]");
        if is_local && matches!(port, Some(11434) | Some(11435)) {
            return LOCAL_OLLAMA.to_string();
        }
    }
    candidate.trim_end_matches('/').to_string()
}

/// 4.1 起 Ollama 已原生支持关闭思考模式，不再需要 11435 本地代理。
/// 每次启动都把本机 localhost、回环地址和旧 11435 代理统一到原生端口；
/// 远程自定义地址保持不变。
fn normalize_settings(mut settings: SettingsV2) -> SettingsV2 {
    let request_path = normalize_ollama_request_path(&settings.ollama.translation.request_path);
    // 当前版本固定复用同一个已安装的 Gemma 4 runner。即使磁盘中残留新版四模型
    // 配置，也会在启动和保存时被收敛，避免多个模型同时驻留显存。
    let unified_model = UNIFIED_OLLAMA_MODEL.to_string();
    settings.version = SETTINGS_VERSION;
    for endpoint in [
        &mut settings.ollama.translation,
        &mut settings.ollama.research,
        &mut settings.ollama.vision,
        &mut settings.ollama.embedding,
    ] {
        endpoint.request_path = request_path.clone();
        endpoint.model = unified_model.clone();
    }
    settings.ollama.translation.stream = true;
    settings.ollama.research.stream = false;
    settings.ollama.vision.stream = false;
    settings.ollama.embedding.stream = false;
    settings.ollama.embedding_install_confirmed = false;
    settings.ollama.semantic_embeddings_enabled = false;
    // 暂不暴露尚未完整集成的神经 TTS；旧配置中的未知引擎安全迁回系统语音。
    settings.speech.engine = "system".to_string();
    settings.speech.voice = settings.speech.voice.trim().to_string();
    settings.speech.chinese_voice = settings.speech.chinese_voice.trim().to_string();
    settings.speech.english_voice = settings.speech.english_voice.trim().to_string();
    settings.speech.rate = settings.speech.rate.clamp(0.5, 2.0);
    settings.documents.tex_compiler = settings.documents.tex_compiler.trim().to_ascii_lowercase();
    if !TEX_COMPILERS.contains(&settings.documents.tex_compiler.as_str()) {
        settings.documents.tex_compiler = DocumentSettings::default().tex_compiler;
    }
    settings
}

fn backup_legacy_config(config_path: &Path) {
    if !config_path.exists() {
        return;
    }
    let backup_path = config_path.with_file_name("config.v1.backup.json");
    if backup_path.exists() {
        return;
    }
    match std::fs::copy(config_path, &backup_path) {
        Ok(_) => info!("旧配置已归档到：{:?}", backup_path),
        Err(error) => warn!("旧配置归档失败，不阻止启动：{error}"),
    }
}

fn config_path(app: &tauri::App) -> PathBuf {
    let root = config_dir().unwrap_or_else(std::env::temp_dir);
    root.join(app.config().identifier.clone())
        .join("config.json")
}

pub fn init_config(app: &mut tauri::App) -> Result<(), String> {
    let config_path = config_path(app);
    info!("加载配置：{:?}", config_path);
    let store = match StoreBuilder::new(app.handle(), config_path.clone()).build() {
        Ok(store) => store,
        Err(error) => {
            warn!("配置存储初始化失败，将使用临时配置：{error:?}");
            StoreBuilder::new(
                app.handle(),
                std::env::temp_dir().join("xiaoyun-config.json"),
            )
            .build()
            .map_err(|fallback_error| {
                format!("配置存储与临时配置均初始化失败：{error:?}；{fallback_error:?}")
            })?
        }
    };
    if let Err(error) = store.reload() {
        warn!("配置读取失败，将使用安全默认值：{error:?}");
    }

    let settings = store
        .get("settings_v2")
        .and_then(|value| serde_json::from_value::<SettingsV2>(value).ok())
        .unwrap_or_else(|| {
            backup_legacy_config(&config_path);
            migrate_settings(&store)
        });
    let settings = normalize_settings(settings);
    store.set("settings_v2".to_string(), json!(settings));
    if let Err(error) = store.save() {
        warn!("保存 SettingsV2 失败：{error}");
    }
    app.manage(StoreWrapper(store));
    Ok(())
}

pub fn get(key: &str) -> Option<Value> {
    let app = APP.get()?;
    let state = app.state::<StoreWrapper>();
    state.0.get(key)
}

#[tauri::command]
pub fn get_settings_v2() -> Result<SettingsV2, String> {
    get("settings_v2")
        .ok_or_else(|| "SettingsV2 尚未初始化".to_string())
        .and_then(|value| serde_json::from_value(value).map_err(|error| error.to_string()))
}

#[tauri::command]
pub fn update_settings_v2(mut settings: SettingsV2) -> Result<SettingsV2, String> {
    settings = normalize_settings(settings);
    if settings.ollama.translation.model.trim().is_empty() {
        return Err("统一 Ollama 模型不能为空".to_string());
    }
    let app = APP.get().ok_or_else(|| "应用尚未初始化".to_string())?;
    if let Some(path) = settings
        .library_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        let path = std::path::PathBuf::from(path);
        std::fs::create_dir_all(path.join("papers"))
            .map_err(|error| format!("无法创建文献库目录：{error}"))?;
        app.asset_protocol_scope()
            .allow_directory(&path, true)
            .map_err(|error| format!("无法授权 PDF 资源目录：{error}"))?;
    }
    let state = app.state::<StoreWrapper>();
    state.0.set("settings_v2", json!(settings.clone()));
    state.0.save().map_err(|error| error.to_string())?;
    if let Err(error) = app.emit("settings_v2_changed", settings.clone()) {
        warn!("广播 SettingsV2 变更失败：{error}");
    }
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_ollama_only() {
        let settings = SettingsV2::default();
        assert_eq!(settings.version, 6);
        for endpoint in [
            &settings.ollama.translation,
            &settings.ollama.research,
            &settings.ollama.vision,
            &settings.ollama.embedding,
        ] {
            assert_eq!(endpoint.model, UNIFIED_OLLAMA_MODEL);
        }
        assert!(settings.ollama.enabled);
        assert!(!settings.ollama.embedding_install_confirmed);
        assert!(!settings.ollama.semantic_embeddings_enabled);
        assert_eq!(settings.documents.tex_compiler, "auto");
        assert_eq!(settings.speech.engine, "system");
        assert!(settings.speech.chinese_voice.is_empty());
        assert!(settings.speech.english_voice.is_empty());
    }

    #[test]
    fn partial_json_is_filled_by_defaults() {
        let settings: SettingsV2 = serde_json::from_value(json!({
            "version": 2,
            "theme": "dark",
            "ollama": {
                "translation": {"model": "translategemma:4b"}
            }
        }))
        .unwrap();
        let settings = normalize_settings(settings);
        assert_eq!(settings.theme, "dark");
        assert_eq!(
            settings.ollama.translation.request_path,
            "http://127.0.0.1:11434"
        );
        assert_eq!(settings.ollama.translation.model, UNIFIED_OLLAMA_MODEL);
        assert_eq!(settings.ollama.vision.model, UNIFIED_OLLAMA_MODEL);
        assert_eq!(settings.ollama.research.model, UNIFIED_OLLAMA_MODEL);
        assert_eq!(settings.ollama.embedding.model, UNIFIED_OLLAMA_MODEL);
    }

    #[test]
    fn current_settings_are_forced_back_to_the_single_gemma4_runner() {
        let mut settings = SettingsV2::default();
        settings.ollama.translation.model = "one-multimodal-model:latest".to_string();
        settings.ollama.research.model = "stale-research".to_string();
        settings.ollama.vision.model = "stale-vision".to_string();
        settings.ollama.embedding.model = "stale-embedding".to_string();
        settings.ollama.embedding_install_confirmed = true;
        settings.ollama.semantic_embeddings_enabled = true;

        let normalized = normalize_settings(settings);
        for endpoint in [
            &normalized.ollama.translation,
            &normalized.ollama.research,
            &normalized.ollama.vision,
            &normalized.ollama.embedding,
        ] {
            assert_eq!(endpoint.model, UNIFIED_OLLAMA_MODEL);
            assert_eq!(endpoint.request_path, "http://127.0.0.1:11434");
        }
        assert!(!normalized.ollama.embedding_install_confirmed);
        assert!(!normalized.ollama.semantic_embeddings_enabled);
    }

    #[test]
    fn all_local_ollama_endpoints_are_normalized_without_touching_custom_hosts() {
        let mut legacy = SettingsV2 {
            version: 2,
            ..SettingsV2::default()
        };
        legacy.ollama.translation.request_path = "http://127.0.0.1:11435/".to_string();
        legacy.ollama.research.request_path = "localhost:11434".to_string();
        legacy.ollama.vision.request_path = "https://localhost:11435/".to_string();
        legacy.ollama.embedding.request_path = "http://[::1]:11434/".to_string();
        let migrated = normalize_settings(legacy);
        assert_eq!(migrated.version, SETTINGS_VERSION);
        for endpoint in [
            migrated.ollama.translation,
            migrated.ollama.research,
            migrated.ollama.vision,
            migrated.ollama.embedding,
        ] {
            assert_eq!(endpoint.request_path, "http://127.0.0.1:11434");
        }

        let mut custom = SettingsV2::default();
        custom.ollama.translation.request_path = "http://192.168.1.9:11435/".to_string();
        assert_eq!(
            normalize_settings(custom).ollama.translation.request_path,
            "http://192.168.1.9:11435"
        );
    }

    #[test]
    fn tex_compiler_is_persisted_and_invalid_values_fall_back_safely() {
        let mut settings = SettingsV2::default();
        settings.documents.tex_compiler = "  XeLaTeX  ".to_string();
        assert_eq!(
            normalize_settings(settings).documents.tex_compiler,
            "xelatex"
        );

        let mut invalid = SettingsV2::default();
        invalid.documents.tex_compiler = "shell-script".to_string();
        assert_eq!(normalize_settings(invalid).documents.tex_compiler, "auto");
    }

    #[test]
    fn legacy_single_voice_is_kept_as_other_language_fallback() {
        let settings: SettingsV2 = serde_json::from_value(json!({
            "version": 5,
            "speech": {
                "voice": "Legacy Voice",
                "rate": 1.25
            }
        }))
        .unwrap();
        let normalized = normalize_settings(settings);

        assert_eq!(normalized.version, SETTINGS_VERSION);
        assert_eq!(normalized.speech.engine, "system");
        assert_eq!(normalized.speech.voice, "Legacy Voice");
        assert!(normalized.speech.chinese_voice.is_empty());
        assert!(normalized.speech.english_voice.is_empty());
        assert_eq!(normalized.speech.rate, 1.25);
    }

    #[test]
    fn speech_settings_reject_unknown_engines_and_normalize_values() {
        let mut settings = SettingsV2::default();
        settings.speech.engine = "unfinished-neural-engine".to_string();
        settings.speech.voice = "  fallback  ".to_string();
        settings.speech.chinese_voice = "  zh-natural  ".to_string();
        settings.speech.english_voice = "  en-natural  ".to_string();
        settings.speech.rate = 9.0;

        let normalized = normalize_settings(settings);
        assert_eq!(normalized.speech.engine, "system");
        assert_eq!(normalized.speech.voice, "fallback");
        assert_eq!(normalized.speech.chinese_voice, "zh-natural");
        assert_eq!(normalized.speech.english_voice, "en-natural");
        assert_eq!(normalized.speech.rate, 2.0);
    }
}
