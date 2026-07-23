use log::info;

fn display_contains_point(
    display_x: i32,
    display_y: i32,
    display_width: u32,
    display_height: u32,
    point_x: i32,
    point_y: i32,
) -> bool {
    let left = i64::from(display_x);
    let top = i64::from(display_y);
    let right = left + i64::from(display_width);
    let bottom = top + i64::from(display_height);
    let point_x = i64::from(point_x);
    let point_y = i64::from(point_y);
    point_x >= left && point_x < right && point_y >= top && point_y < bottom
}

fn capture_error_message(platform: &str, detail: &str) -> String {
    match platform {
        "macos" => format!(
            "截图失败：{detail}。请在“系统设置 → 隐私与安全性 → 屏幕与系统音频录制”中授权小允翻译"
        ),
        "linux" => format!(
            "截图失败：{detail}。Wayland 会话需允许桌面截图门户，X11 会话需可访问当前 DISPLAY"
        ),
        _ => format!("截图失败：{detail}"),
    }
}

#[tauri::command]
pub fn screenshot(app_handle: tauri::AppHandle, x: i32, y: i32) -> Result<(), String> {
    use dirs::cache_dir;
    use screenshots::{Compression, Screen};
    use std::fs;

    info!("Screenshot screen with position: x={}, y={}", x, y);
    let screens = Screen::all().map_err(|error| format!("读取显示器失败：{error}"))?;
    for screen in &screens {
        let info = screen.display_info;
        info!("Screen: {:?}", info);
    }
    // 前端通常传显示器原点；若不同后端在缩放坐标上有细微差异，则回退到包含该点的
    // 显示器。精确原点始终优先，保持 Windows 既有多屏选择语义。
    let screen_index = screens
        .iter()
        .position(|screen| screen.display_info.x == x && screen.display_info.y == y)
        .or_else(|| {
            screens.iter().position(|screen| {
                let info = screen.display_info;
                display_contains_point(info.x, info.y, info.width, info.height, x, y)
            })
        })
        .ok_or_else(|| "未找到截图目标显示器".to_string())?;
    let screen = screens
        .into_iter()
        .nth(screen_index)
        .ok_or_else(|| "未找到截图目标显示器".to_string())?;

    let mut app_cache_dir_path = cache_dir().ok_or_else(|| "无法定位缓存目录".to_string())?;
    app_cache_dir_path.push(&app_handle.config().identifier);
    fs::create_dir_all(&app_cache_dir_path)
        .map_err(|error| format!("创建截图缓存目录失败：{error}"))?;
    app_cache_dir_path.push("pot_screenshot.png");

    let image = screen
        .capture()
        .map_err(|error| capture_error_message(std::env::consts::OS, &error.to_string()))?;
    let buffer = image
        .to_png(Compression::Fast)
        .map_err(|error| format!("编码截图失败：{error}"))?;
    fs::write(app_cache_dir_path, buffer).map_err(|error| format!("保存截图失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::{capture_error_message, display_contains_point};

    #[test]
    fn display_hit_testing_supports_negative_multi_monitor_coordinates() {
        assert!(display_contains_point(-1920, 0, 1920, 1080, -1920, 0));
        assert!(display_contains_point(-1920, 0, 1920, 1080, -1, 1079));
        assert!(!display_contains_point(-1920, 0, 1920, 1080, 0, 100));
        assert!(!display_contains_point(-1920, 0, 1920, 1080, -1, 1080));
    }

    #[test]
    fn platform_capture_errors_include_actionable_permission_guidance() {
        assert!(capture_error_message("macos", "denied").contains("隐私与安全性"));
        assert!(capture_error_message("linux", "denied").contains("Wayland"));
        assert_eq!(
            capture_error_message("windows", "denied"),
            "截图失败：denied"
        );
    }
}
