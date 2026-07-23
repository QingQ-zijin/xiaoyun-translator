//! 小允翻译的 Tauri 2 托盘入口。
//!
//! 托盘只保留论文库、快速翻译、截图翻译、设置和退出，避免重新引入已经删除的旧服务入口。

use crate::request_app_exit;
use crate::window::{config_window, input_translate, main_window, ocr_translate};
use log::warn;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

const PAPER_LIBRARY: &str = "paper_library";
const QUICK_TRANSLATE: &str = "input_translate";
const SCREENSHOT_TRANSLATE: &str = "screenshot_translate";
const SETTINGS: &str = "settings";
const QUIT: &str = "quit";

/// 创建并注册唯一的系统托盘图标。
pub fn install_tray(app: &AppHandle) -> Result<(), String> {
    let paper_library = MenuItem::with_id(app, PAPER_LIBRARY, "论文库", true, None::<&str>)
        .map_err(|error| format!("创建论文库托盘项失败：{error}"))?;
    let quick_translate = MenuItem::with_id(app, QUICK_TRANSLATE, "快速翻译", true, None::<&str>)
        .map_err(|error| format!("创建快速翻译托盘项失败：{error}"))?;
    let screenshot_translate =
        MenuItem::with_id(app, SCREENSHOT_TRANSLATE, "截图翻译", true, None::<&str>)
            .map_err(|error| format!("创建截图翻译托盘项失败：{error}"))?;
    let first_separator = PredefinedMenuItem::separator(app)
        .map_err(|error| format!("创建托盘分隔线失败：{error}"))?;
    let settings = MenuItem::with_id(app, SETTINGS, "设置", true, None::<&str>)
        .map_err(|error| format!("创建设置托盘项失败：{error}"))?;
    let second_separator = PredefinedMenuItem::separator(app)
        .map_err(|error| format!("创建托盘分隔线失败：{error}"))?;
    let quit = MenuItem::with_id(app, QUIT, "退出", true, None::<&str>)
        .map_err(|error| format!("创建退出托盘项失败：{error}"))?;

    let menu = Menu::with_items(
        app,
        &[
            &paper_library,
            &quick_translate,
            &screenshot_translate,
            &first_separator,
            &settings,
            &second_separator,
            &quit,
        ],
    )
    .map_err(|error| format!("创建托盘菜单失败：{error}"))?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip(format!("小允翻译 {}", app.package_info().version))
        .show_menu_on_left_click(false)
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(|_tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Err(error) = main_window(None) {
                    warn!("从托盘打开论文库失败：{error}");
                }
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder
        .build(app)
        .map(|_| ())
        .map_err(|error| format!("创建系统托盘失败：{error}"))
}

fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        PAPER_LIBRARY => {
            if let Err(error) = main_window(None) {
                warn!("从托盘打开论文库失败：{error}");
            }
        }
        QUICK_TRANSLATE => input_translate(),
        SCREENSHOT_TRANSLATE => ocr_translate(),
        SETTINGS => config_window(),
        QUIT => request_app_exit(app),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::{PAPER_LIBRARY, QUICK_TRANSLATE, QUIT, SCREENSHOT_TRANSLATE, SETTINGS};

    #[test]
    fn tray_contains_only_product_core_entries() {
        assert_eq!(
            [
                PAPER_LIBRARY,
                QUICK_TRANSLATE,
                SCREENSHOT_TRANSLATE,
                SETTINGS,
                QUIT,
            ],
            [
                "paper_library",
                "input_translate",
                "screenshot_translate",
                "settings",
                "quit",
            ]
        );
    }
}
