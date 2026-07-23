use base64::{engine::general_purpose, Engine as _};
use dirs::cache_dir;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TEMP_IMAGE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn app_cache_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut path = cache_dir().ok_or_else(|| "Get Cache Dir Failed".to_string())?;
    path.push(&app_handle.config().tauri.bundle.identifier);
    Ok(path)
}

fn shared_screenshot_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut path = app_cache_dir(app_handle)?;
    path.push("pot_screenshot_cut.png");
    Ok(path)
}

struct TemporaryOcrImage {
    path: PathBuf,
}

impl TemporaryOcrImage {
    fn create_in(directory: &Path, image: &str) -> Result<Self, String> {
        let encoded = match image.split_once(',') {
            Some((metadata, payload))
                if metadata.starts_with("data:image/") && metadata.ends_with(";base64") =>
            {
                payload
            }
            _ => image,
        };
        let bytes = general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|error| format!("Invalid OCR image base64: {error}"))?;
        if bytes.is_empty() {
            return Err("OCR image is empty".to_string());
        }

        fs::create_dir_all(directory)
            .map_err(|error| format!("Create OCR cache directory failed: {error}"))?;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();

        // create_new 保证并发请求不会复用或覆盖同一个截图文件。
        for _ in 0..16 {
            let sequence = TEMP_IMAGE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = directory.join(format!(
                "pot_system_ocr_{}_{}_{}.png",
                std::process::id(),
                timestamp,
                sequence
            ));
            let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("Create temporary OCR image failed: {error}")),
            };

            if let Err(error) = file.write_all(&bytes) {
                drop(file);
                let _ = fs::remove_file(&path);
                return Err(format!("Write temporary OCR image failed: {error}"));
            }
            return Ok(Self { path });
        }

        Err("Create unique temporary OCR image failed".to_string())
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TemporaryOcrImage {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[tauri::command(async)]
pub fn system_ocr(app_handle: tauri::AppHandle, lang: &str) -> Result<String, String> {
    let image_path = shared_screenshot_path(&app_handle)?;
    recognize_image(&app_handle, &image_path, lang)
}

#[tauri::command(async)]
pub fn system_ocr_base64(
    app_handle: tauri::AppHandle,
    image: &str,
    lang: &str,
) -> Result<String, String> {
    let temporary_image = TemporaryOcrImage::create_in(&app_cache_dir(&app_handle)?, image)?;
    recognize_image(&app_handle, temporary_image.path(), lang)
}

#[cfg(target_os = "windows")]
fn recognize_image(
    _app_handle: &tauri::AppHandle,
    image_path: &Path,
    lang: &str,
) -> Result<String, String> {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::{FileAccessMode, StorageFile};

    let path = image_path.to_string_lossy().replace("\\\\?\\", "");
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))
        .map_err(|error| error.to_string())?
        .get()
        .map_err(|error| error.to_string())?;
    let stream = file
        .OpenAsync(FileAccessMode::Read)
        .map_err(|error| error.to_string())?
        .get()
        .map_err(|error| error.to_string())?;
    let decoder_id = BitmapDecoder::PngDecoderId().map_err(|error| error.to_string())?;
    let bitmap = BitmapDecoder::CreateWithIdAsync(decoder_id, &stream)
        .map_err(|error| error.to_string())?
        .get()
        .map_err(|error| error.to_string())?
        .GetSoftwareBitmapAsync()
        .map_err(|error| error.to_string())?
        .get()
        .map_err(|error| error.to_string())?;

    let engine = match lang {
        "auto" => OcrEngine::TryCreateFromUserProfileLanguages(),
        _ => {
            let language = Language::CreateLanguage(&HSTRING::from(lang))
                .map_err(|_| "Language Error".to_string())?;
            OcrEngine::TryCreateFromLanguage(&language)
        }
    };
    let engine = engine.map_err(|error| {
        if error.to_string().contains("0x00000000") {
            "Language package not installed!\n\nSee: https://learn.microsoft.com/zh-cn/windows/powertoys/text-extractor#supported-languages".to_string()
        } else {
            error.to_string()
        }
    })?;

    engine
        .RecognizeAsync(&bitmap)
        .map_err(|error| error.to_string())?
        .get()
        .map_err(|error| error.to_string())?
        .Text()
        .map_err(|error| error.to_string())
        .map(|text| text.to_string_lossy())
}

#[cfg(target_os = "macos")]
fn recognize_image(
    app_handle: &tauri::AppHandle,
    image_path: &Path,
    lang: &str,
) -> Result<String, String> {
    let arch = std::env::consts::ARCH;
    let bin_path = app_handle
        .path_resolver()
        .resolve_resource(format!("resources/ocr-{arch}-apple-darwin"))
        .ok_or_else(|| "Failed to resolve ocr binary".to_string())?;

    std::process::Command::new("chmod")
        .arg("+x")
        .arg(&bin_path)
        .output()
        .map_err(|error| error.to_string())?;

    let output = std::process::Command::new(bin_path)
        .arg(image_path)
        .arg(lang)
        .output()
        .map_err(|error| error.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8(output.stdout).unwrap_or_default())
    } else {
        Err(String::from_utf8(output.stderr).unwrap_or_default())
    }
}

#[cfg(target_os = "linux")]
fn recognize_image(
    _app_handle: &tauri::AppHandle,
    image_path: &Path,
    lang: &str,
) -> Result<String, String> {
    let mut command = std::process::Command::new("tesseract");
    command.arg(image_path).arg("stdout");
    if lang != "auto" {
        command.arg("-l").arg(lang);
    }

    let output = match command.output() {
        Ok(output) => output,
        Err(error) => {
            if error.to_string().contains("os error 2") {
                return Err("Tesseract not installed!".to_string());
            }
            return Err(error.to_string());
        }
    };
    if output.status.success() {
        Ok(String::from_utf8(output.stdout).unwrap_or_default())
    } else {
        let content = String::from_utf8(output.stderr).unwrap_or_default();
        if content.contains("data") {
            if lang == "auto" {
                return Err(
                    "Language data not installed!\nPlease try install tesseract-ocr-eng"
                        .to_string(),
                );
            }
            return Err(format!(
                "Language data not installed!\nPlease try install tesseract-ocr-{lang}"
            ));
        }
        Err(content)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temporary_images_are_unique_and_removed_on_drop() -> Result<(), Box<dyn std::error::Error>> {
        let directory = std::env::temp_dir().join(format!(
            "pot-system-ocr-test-{}-{}",
            std::process::id(),
            TEMP_IMAGE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let first_path;
        let second_path;
        {
            let first_image = TemporaryOcrImage::create_in(&directory, "iVBORw0KGgo=")?;
            let second_image = TemporaryOcrImage::create_in(&directory, "iVBORw0KGgo=")?;
            first_path = first_image.path().to_path_buf();
            second_path = second_image.path().to_path_buf();
            assert_ne!(first_path, second_path);
            assert_eq!(fs::read(&first_path)?, b"\x89PNG\r\n\x1a\n");
            assert_eq!(fs::read(&second_path)?, b"\x89PNG\r\n\x1a\n");
        }
        assert!(!first_path.exists());
        assert!(!second_path.exists());
        fs::remove_dir(directory)?;
        Ok(())
    }
}
