//! 快捷翻译仍需要的少量本机命令。

use crate::config::StoreWrapper;
use crate::StringWrapper;
use base64::{engine::general_purpose, Engine as _};
use image::GenericImageView;
use std::io::Read;

fn screenshot_path(app: &tauri::AppHandle, cropped: bool) -> Result<std::path::PathBuf, String> {
    let mut path = dirs::cache_dir().ok_or_else(|| "无法确定缓存目录".to_string())?;
    path.push(app.config().identifier.clone());
    std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    path.push(if cropped {
        "pot_screenshot_cut.png"
    } else {
        "pot_screenshot.png"
    });
    Ok(path)
}

#[tauri::command]
pub fn get_text(state: tauri::State<StringWrapper>) -> String {
    state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

#[tauri::command]
pub fn reload_store(state: tauri::State<StoreWrapper>) -> Result<(), String> {
    state.0.reload().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn cut_image(
    left: u32,
    top: u32,
    width: u32,
    height: u32,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("截图区域不能为空".to_string());
    }
    let source = screenshot_path(&app_handle, false)?;
    let destination = screenshot_path(&app_handle, true)?;
    let image = image::open(&source).map_err(|error| format!("读取截图失败：{error}"))?;
    let (image_width, image_height) = image.dimensions();
    if left >= image_width
        || top >= image_height
        || left.saturating_add(width) > image_width
        || top.saturating_add(height) > image_height
    {
        return Err("截图区域超出屏幕范围".to_string());
    }
    image
        .crop_imm(left, top, width, height)
        .save(destination)
        .map_err(|error| format!("保存截图失败：{error}"))
}

#[tauri::command]
pub fn get_base64(app_handle: tauri::AppHandle) -> Result<String, String> {
    let path = screenshot_path(&app_handle, true)?;
    let mut file = std::fs::File::open(path).map_err(|error| format!("截图尚未生成：{error}"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("读取截图失败：{error}"))?;
    Ok(general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub fn copy_img(app_handle: tauri::AppHandle) -> Result<(), String> {
    use arboard::{Clipboard, ImageData};
    use std::borrow::Cow;

    let image = image::open(screenshot_path(&app_handle, true)?)
        .map_err(|error| format!("读取截图失败：{error}"))?
        .to_rgba8();
    let (width, height) = image.dimensions();
    Clipboard::new()
        .and_then(|mut clipboard| {
            clipboard.set_image(ImageData {
                width: width as usize,
                height: height as usize,
                bytes: Cow::Owned(image.into_raw()),
            })
        })
        .map_err(|error| format!("复制截图失败：{error}"))
}
