#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

#[cfg(windows)]
static SYSTEM_TTS_BUSY: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
struct SystemTtsBusyGuard;

#[cfg(windows)]
impl Drop for SystemTtsBusyGuard {
    fn drop(&mut self) {
        SYSTEM_TTS_BUSY.store(false, Ordering::Release);
    }
}

#[cfg(windows)]
fn try_acquire_system_tts() -> Option<SystemTtsBusyGuard> {
    SYSTEM_TTS_BUSY
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .ok()
        .map(|_| SystemTtsBusyGuard)
}

fn preferred_voice_locale(lang: &str) -> Option<String> {
    let normalized = lang.trim().replace('_', "-").to_ascii_lowercase();
    match normalized.as_str() {
        "" | "auto" => None,
        "en" | "en-us" => Some("en-US".to_string()),
        "zh" | "zh-cn" | "zh-hans" | "zh-sg" => Some("zh-CN".to_string()),
        "zh-hant" | "zh-tw" | "zh-hk" | "zh-mo" => Some("zh-TW".to_string()),
        _ => {
            let mut parts = normalized.split('-');
            let language = parts.next()?;
            let region = parts.next();
            Some(match region {
                Some(region) => format!("{}-{}", language, region.to_ascii_uppercase()),
                None => language.to_string(),
            })
        }
    }
}

fn normalize_rate(rate: Option<f64>) -> f64 {
    rate.unwrap_or(1.0).clamp(0.5, 2.0)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemVoice {
    id: String,
    name: String,
    language: String,
}

#[cfg(windows)]
fn synthesize_system_audio(
    text: &str,
    lang: &str,
    requested_voice: Option<&str>,
    rate: f64,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    use std::io::{Error, ErrorKind};
    use windows::core::HSTRING;
    use windows::Media::SpeechSynthesis::SpeechSynthesizer;
    use windows::Storage::Streams::DataReader;
    use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

    struct ComApartment(bool);
    impl Drop for ComApartment {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    let initialize_result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let _apartment = if initialize_result.is_ok() {
        ComApartment(true)
    } else if initialize_result == RPC_E_CHANGED_MODE {
        // 当前线程已使用另一种 COM apartment，仍可继续调用 WinRT。
        ComApartment(false)
    } else {
        initialize_result.ok()?;
        unreachable!()
    };

    let locale = preferred_voice_locale(lang)
        .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "无法确定朗读语言"))?;
    let locale_lower = locale.to_ascii_lowercase();
    let language_prefix = locale_lower.split('-').next().unwrap_or_default();

    let synthesizer = SpeechSynthesizer::new()?;
    let voices = SpeechSynthesizer::AllVoices()?;
    let requested_voice = requested_voice
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let requested_voice_lower = requested_voice.map(str::to_ascii_lowercase);
    let mut prefix_match = None;
    let mut exact_match = None;
    let mut requested_match = None;
    for index in 0..voices.Size()? {
        let voice = voices.GetAt(index)?;
        if let Some(requested) = requested_voice_lower.as_deref() {
            let voice_id = voice.Id()?.to_string().to_ascii_lowercase();
            let voice_name = voice.DisplayName()?.to_string().to_ascii_lowercase();
            if voice_id == requested || voice_name == requested {
                requested_match = Some(voice);
                break;
            }
        }
        let voice_language = voice.Language()?.to_string().to_ascii_lowercase();
        if voice_language == locale_lower {
            exact_match = Some(voice);
            break;
        }
        if prefix_match.is_none()
            && (voice_language == language_prefix
                || voice_language.starts_with(&format!("{}-", language_prefix)))
        {
            prefix_match = Some(voice);
        }
    }

    let voice = if requested_voice.is_some() {
        requested_match.ok_or_else(|| Error::new(ErrorKind::NotFound, "指定的系统声音不可用"))?
    } else {
        exact_match
            .or(prefix_match)
            .ok_or_else(|| Error::new(ErrorKind::NotFound, "系统未安装对应语言的声音"))?
    };
    synthesizer.SetVoice(&voice)?;
    synthesizer.Options()?.SetSpeakingRate(rate)?;

    let stream = synthesizer
        .SynthesizeTextToStreamAsync(&HSTRING::from(text))?
        .get()?;
    let size = stream.Size()?;
    if size == 0 || size > u32::MAX as u64 {
        return Err(Error::new(ErrorKind::InvalidData, "系统语音返回了无效音频").into());
    }

    let input = stream.GetInputStreamAt(0)?;
    let reader = DataReader::CreateDataReader(&input)?;
    let loaded = reader.LoadAsync(size as u32)?.get()?;
    if loaded != size as u32 {
        return Err(Error::new(ErrorKind::UnexpectedEof, "系统语音音频读取不完整").into());
    }

    let mut audio = vec![0; loaded as usize];
    reader.ReadBytes(&mut audio)?;
    reader.Close()?;
    stream.Close()?;
    synthesizer.Close()?;
    Ok(audio)
}

#[tauri::command(async)]
pub async fn system_tts(
    text: String,
    lang: String,
    voice: Option<String>,
    rate: Option<f64>,
) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        let busy_guard = try_acquire_system_tts().ok_or_else(|| "本机朗读正忙".to_string())?;
        let result = tauri::async_runtime::spawn_blocking(move || {
            let _busy_guard = busy_guard;
            synthesize_system_audio(&text, &lang, voice.as_deref(), normalize_rate(rate))
        })
        .await
        .map_err(|_| "本机朗读暂不可用".to_string())?;
        result.map_err(|error| {
            log::warn!("System TTS unavailable: {}", error);
            "本机朗读暂不可用".to_string()
        })
    }

    #[cfg(not(windows))]
    {
        let _ = (text, lang, voice, rate);
        Err("本机朗读暂不可用".to_string())
    }
}

#[cfg(windows)]
fn installed_system_voices() -> Result<Vec<SystemVoice>, Box<dyn std::error::Error + Send + Sync>> {
    use windows::Media::SpeechSynthesis::SpeechSynthesizer;

    let voices = SpeechSynthesizer::AllVoices()?;
    let mut result = Vec::with_capacity(voices.Size()? as usize);
    for index in 0..voices.Size()? {
        let voice = voices.GetAt(index)?;
        result.push(SystemVoice {
            id: voice.Id()?.to_string(),
            name: voice.DisplayName()?.to_string(),
            language: voice.Language()?.to_string(),
        });
    }
    result.sort_by(|left, right| {
        left.language
            .cmp(&right.language)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(result)
}

#[tauri::command(async)]
pub async fn list_system_voices() -> Result<Vec<SystemVoice>, String> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(installed_system_voices)
            .await
            .map_err(|_| "无法读取 Windows 声音列表".to_string())?
            .map_err(|error| {
                log::warn!("Unable to enumerate system voices: {error}");
                "无法读取 Windows 声音列表".to_string()
            });
    }

    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_supported_language_codes_to_windows_locales() {
        assert_eq!(preferred_voice_locale("en"), Some("en-US".to_string()));
        assert_eq!(preferred_voice_locale("zh"), Some("zh-CN".to_string()));
        assert_eq!(preferred_voice_locale("zh_HANT"), Some("zh-TW".to_string()));
        assert_eq!(preferred_voice_locale("zh-TW"), Some("zh-TW".to_string()));
    }

    #[test]
    fn clamps_speech_rate_to_windows_supported_range() {
        assert_eq!(normalize_rate(None), 1.0);
        assert_eq!(normalize_rate(Some(0.1)), 0.5);
        assert_eq!(normalize_rate(Some(2.8)), 2.0);
    }

    #[cfg(windows)]
    #[test]
    fn limits_system_tts_to_one_blocking_job() {
        let first = try_acquire_system_tts().expect("第一次应获得本机语音槽位");
        assert!(try_acquire_system_tts().is_none());
        drop(first);
        assert!(try_acquire_system_tts().is_some());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "需要 Windows 本机中文语音包"]
    fn windows_synthesizes_unicode_term() {
        let audio = synthesize_system_audio("Michaelis–Menten", "zh", None, 1.0).unwrap();
        assert!(audio.len() > 44);
        assert_eq!(&audio[..4], b"RIFF");
    }
}
