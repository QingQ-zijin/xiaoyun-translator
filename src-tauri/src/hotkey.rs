//! 全局快捷键注册。
//!
//! 快捷键只在按下事件触发。更新时先注册新组合，再注销旧组合并保存配置；
//! 任一步失败都会撤销已完成的步骤，避免一次设置失败同时破坏仍可用的旧快捷键。

use crate::config::{get_settings_v2, update_settings_v2};
use crate::window::{input_translate, ocr_translate, selection_translate};
use crate::APP;
use log::{info, warn};
use once_cell::sync::Lazy;
use std::{
    collections::HashMap,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::Mutex,
    time::Duration,
};
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

type ShortcutHandler = fn();

const SHORTCUT_NAMES: [&str; 3] = [
    "hotkey_selection_translate",
    "hotkey_ocr_translate",
    "hotkey_input_translate",
];

/// 记录后端实际成功注册的组合，不依赖前端正在编辑的配置值。
static REGISTERED_SHORTCUTS: Lazy<Mutex<HashMap<&'static str, String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static SHORTCUT_TRANSACTION: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

fn shortcut_handler(name: &str) -> Option<(&'static str, ShortcutHandler)> {
    match name {
        "hotkey_selection_translate" => Some((
            "hotkey_selection_translate",
            selection_translate as ShortcutHandler,
        )),
        "hotkey_input_translate" => {
            Some(("hotkey_input_translate", input_translate as ShortcutHandler))
        }
        "hotkey_ocr_translate" => Some(("hotkey_ocr_translate", ocr_translate as ShortcutHandler)),
        _ => None,
    }
}

fn configured_shortcut(name: &str) -> Result<String, String> {
    let settings = get_settings_v2()?;
    let shortcut = match name {
        "hotkey_selection_translate" => settings.hotkeys.selection_translate,
        "hotkey_input_translate" => settings.hotkeys.input_translate,
        "hotkey_ocr_translate" => settings.hotkeys.screenshot_translate,
        _ => return Err(format!("不支持的快捷键配置项：{name}")),
    };
    Ok(shortcut.trim().to_string())
}

fn registered_shortcut(name: &'static str) -> Option<String> {
    let registry = REGISTERED_SHORTCUTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    registry.get(name).cloned()
}

fn remember_shortcut(name: &'static str, shortcut: Option<&str>) {
    let mut registry = REGISTERED_SHORTCUTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match shortcut.filter(|value| !value.is_empty()) {
        Some(shortcut) => {
            registry.insert(name, shortcut.to_string());
        }
        None => {
            registry.remove(name);
        }
    }
}

fn register_with_handler(
    app_handle: &AppHandle,
    name: &'static str,
    shortcut: &str,
    handler: ShortcutHandler,
) -> Result<(), String> {
    app_handle
        .global_shortcut()
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                info!("全局快捷键已触发：{name}");
                if catch_unwind(AssertUnwindSafe(handler)).is_err() {
                    warn!("全局快捷键处理器发生异常并已隔离：{name}");
                }
            }
        })
        .map_err(|error| error.to_string())
}

fn register_configured(app_handle: &AppHandle, name: &str) -> Result<(), String> {
    let (canonical_name, handler) =
        shortcut_handler(name).ok_or_else(|| format!("不支持的快捷键配置项：{name}"))?;
    let shortcut = configured_shortcut(canonical_name)?;
    let previous_shortcut = registered_shortcut(canonical_name);
    if shortcut.is_empty() {
        if let Some(previous) = previous_shortcut.as_deref() {
            if app_handle.global_shortcut().is_registered(previous) {
                app_handle
                    .global_shortcut()
                    .unregister(previous)
                    .map_err(|error| format!("注销已停用快捷键失败：{error}"))?;
            }
        }
        remember_shortcut(canonical_name, None);
        return Ok(());
    }
    if previous_shortcut.as_deref() == Some(shortcut.as_str())
        && app_handle
            .global_shortcut()
            .is_registered(shortcut.as_str())
    {
        return Ok(());
    }
    register_with_handler(app_handle, canonical_name, &shortcut, handler).map_err(|error| {
        warn!("注册全局快捷键失败：{shortcut} ({canonical_name})，{error}");
        error
    })?;

    // 配置可能由升级迁移或外部写入改变。自检注册新键后必须清理本进程仍持有的旧键；
    // 清理失败则撤销新键，避免一个动作被两个组合键同时触发。
    if let Some(previous) = previous_shortcut
        .as_deref()
        .filter(|value| *value != shortcut)
    {
        if app_handle.global_shortcut().is_registered(previous) {
            if let Err(error) = app_handle.global_shortcut().unregister(previous) {
                let _ = app_handle.global_shortcut().unregister(shortcut.as_str());
                return Err(format!("切换快捷键时注销旧组合失败，已回滚：{error}"));
            }
        }
    }
    remember_shortcut(canonical_name, Some(&shortcut));
    info!("已注册全局快捷键：{shortcut} ({canonical_name})");
    Ok(())
}

/// 定期自检全局快捷键。Windows 启动阶段或其他软件短暂占用组合键时，首次注册可能失败；
/// 后台重试能在占用解除后恢复功能，无需用户重启应用。
pub fn start_shortcut_watchdog(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // 启动阶段若组合键被其他程序短暂占用，尽快进行第一次恢复；稳定后降低频率。
        tokio::time::sleep(Duration::from_secs(2)).await;
        loop {
            for name in SHORTCUT_NAMES {
                if let Err(error) = register_configured(&app_handle, name) {
                    warn!("全局快捷键自检未能恢复 {name}：{error}");
                }
            }
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });
}

/// 启动时注册单项或全部快捷键。
pub fn register_shortcut(shortcut: &str) -> Result<(), String> {
    let app_handle = APP
        .get()
        .ok_or_else(|| "应用尚未初始化，无法注册快捷键".to_string())?;
    if shortcut == "all" {
        let mut errors = Vec::new();
        for name in SHORTCUT_NAMES {
            if let Err(error) = register_configured(app_handle, name) {
                errors.push(format!("{name}: {error}"));
            }
        }
        if !errors.is_empty() {
            return Err(errors.join("；"));
        }
        return Ok(());
    }
    if shortcut_handler(shortcut).is_some() {
        register_configured(app_handle, shortcut)
    } else {
        Err(format!("不支持的快捷键配置项：{shortcut}"))
    }
}

/// 注销本应用注册的全部全局快捷键。
pub fn unregister_all_shortcuts(app_handle: &AppHandle) -> Result<(), String> {
    app_handle
        .global_shortcut()
        .unregister_all()
        .map_err(|error| error.to_string())?;
    REGISTERED_SHORTCUTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
    Ok(())
}

/// 原子替换快捷键：新键不可用时旧键保持有效；注销或保存失败时自动回滚。
pub fn replace_shortcut_atomically(
    app_handle: &AppHandle,
    name: &str,
    new_shortcut: &str,
) -> Result<(), String> {
    let _transaction = SHORTCUT_TRANSACTION
        .lock()
        .map_err(|_| "快捷键事务锁已损坏".to_string())?;
    let (canonical_name, handler) =
        shortcut_handler(name).ok_or_else(|| format!("不支持的快捷键配置项：{name}"))?;
    let new_shortcut = new_shortcut.trim().to_string();
    let old_shortcut = match registered_shortcut(canonical_name) {
        Some(shortcut) => shortcut,
        None => configured_shortcut(canonical_name)?,
    };

    let old_is_registered = !old_shortcut.is_empty()
        && app_handle
            .global_shortcut()
            .is_registered(old_shortcut.as_str());

    if new_shortcut == old_shortcut {
        let registered_now = !new_shortcut.is_empty() && !old_is_registered;
        if registered_now {
            register_with_handler(app_handle, canonical_name, &new_shortcut, handler)
                .map_err(|error| format!("重新注册快捷键失败：{error}"))?;
        }
        if let Err(error) = persist_shortcut(canonical_name, &new_shortcut) {
            if registered_now {
                let _ = app_handle
                    .global_shortcut()
                    .unregister(new_shortcut.as_str());
            }
            return Err(error);
        }
        remember_shortcut(canonical_name, Some(&new_shortcut));
        return Ok(());
    }

    // 新组合先注册；冲突或格式错误不会影响仍在工作的旧组合。
    if !new_shortcut.is_empty() {
        register_with_handler(app_handle, canonical_name, &new_shortcut, handler)
            .map_err(|error| format!("新快捷键不可用，旧快捷键未改变：{error}"))?;
    }

    if old_is_registered {
        if let Err(error) = app_handle
            .global_shortcut()
            .unregister(old_shortcut.as_str())
        {
            if !new_shortcut.is_empty() {
                let _ = app_handle
                    .global_shortcut()
                    .unregister(new_shortcut.as_str());
            }
            return Err(format!("注销旧快捷键失败，已回滚新快捷键：{error}"));
        }
    }

    if let Err(error) = persist_shortcut(canonical_name, &new_shortcut) {
        if !new_shortcut.is_empty() {
            let _ = app_handle
                .global_shortcut()
                .unregister(new_shortcut.as_str());
        }
        if old_is_registered && !old_shortcut.is_empty() {
            if let Err(rollback_error) =
                register_with_handler(app_handle, canonical_name, &old_shortcut, handler)
            {
                warn!("快捷键配置保存失败，且恢复旧快捷键失败：{rollback_error}");
            }
        }
        remember_shortcut(canonical_name, Some(&old_shortcut));
        return Err(format!("保存快捷键失败，已回滚：{error}"));
    }

    remember_shortcut(canonical_name, Some(&new_shortcut));
    info!("快捷键已原子更新：{canonical_name}: {old_shortcut} -> {new_shortcut}");
    Ok(())
}

fn persist_shortcut(name: &str, shortcut: &str) -> Result<(), String> {
    let mut settings = get_settings_v2()?;
    match name {
        "hotkey_selection_translate" => {
            settings.hotkeys.selection_translate = shortcut.to_string();
        }
        "hotkey_input_translate" => {
            settings.hotkeys.input_translate = shortcut.to_string();
        }
        "hotkey_ocr_translate" => {
            settings.hotkeys.screenshot_translate = shortcut.to_string();
        }
        _ => return Err(format!("不支持的快捷键配置项：{name}")),
    }
    update_settings_v2(settings).map(|_| ())
}

#[tauri::command]
pub fn register_shortcut_by_frontend(name: &str, shortcut: &str) -> Result<(), String> {
    let app_handle = APP
        .get()
        .ok_or_else(|| "应用尚未初始化，无法更新快捷键".to_string())?;
    replace_shortcut_atomically(app_handle, name, shortcut)
}

#[cfg(test)]
mod tests {
    use super::{shortcut_handler, SHORTCUT_NAMES};

    #[test]
    fn only_known_shortcut_names_have_handlers() {
        for name in SHORTCUT_NAMES {
            assert!(shortcut_handler(name).is_some(), "缺少处理器：{name}");
        }
        assert!(shortcut_handler("hotkey_unknown").is_none());
        assert!(shortcut_handler("hotkey_ocr_recognize").is_none());
    }
}
