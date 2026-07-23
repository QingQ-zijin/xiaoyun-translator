use log::info;

#[tauri::command]
pub fn screenshot(x: i32, y: i32) -> Result<(), String> {
    use crate::APP;
    use dirs::cache_dir;
    use screenshots::{Compression, Screen};
    use std::fs;
    info!("Screenshot screen with position: x={}, y={}", x, y);
    let screens = Screen::all().map_err(|error| format!("读取显示器失败：{error}"))?;
    let mut captured = false;
    for screen in screens {
        let info = screen.display_info;
        info!("Screen: {:?}", info);
        if info.x == x && info.y == y {
            let handle = APP.get().ok_or_else(|| "应用尚未初始化".to_string())?;
            let mut app_cache_dir_path =
                cache_dir().ok_or_else(|| "无法定位缓存目录".to_string())?;
            app_cache_dir_path.push(&handle.config().identifier);
            if !app_cache_dir_path.exists() {
                // 创建目录
                fs::create_dir_all(&app_cache_dir_path)
                    .map_err(|error| format!("创建截图缓存目录失败：{error}"))?;
            }
            app_cache_dir_path.push("pot_screenshot.png");

            let image = screen
                .capture()
                .map_err(|error| format!("截图失败：{error}"))?;
            let buffer = image
                .to_png(Compression::Fast)
                .map_err(|error| format!("编码截图失败：{error}"))?;
            fs::write(app_cache_dir_path, buffer)
                .map_err(|error| format!("保存截图失败：{error}"))?;
            captured = true;
            break;
        }
    }
    if captured {
        Ok(())
    } else {
        Err("未找到截图目标显示器".to_string())
    }
}
