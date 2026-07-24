use serde::Serialize;

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
static SYSTEM_TTS_BUSY: AtomicBool = AtomicBool::new(false);

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
struct SystemTtsBusyGuard;

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
impl Drop for SystemTtsBusyGuard {
    fn drop(&mut self) {
        SYSTEM_TTS_BUSY.store(false, Ordering::Release);
    }
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
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

#[cfg(any(test, target_os = "linux"))]
fn preferred_espeak_locale(lang: &str) -> Option<String> {
    preferred_voice_locale(lang).map(|locale| {
        if locale.to_ascii_lowercase().starts_with("zh") {
            "cmn".to_string()
        } else {
            locale
        }
    })
}

fn normalize_rate(rate: Option<f64>) -> f64 {
    rate.unwrap_or(1.0).clamp(0.5, 2.0)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemVoice {
    id: String,
    name: String,
    language: String,
}

#[cfg(any(test, target_os = "macos", target_os = "linux"))]
fn normalize_voice_locale(locale: &str) -> String {
    let normalized = locale.trim().replace('_', "-");
    let mut parts = normalized.split('-').map(str::to_string);
    let Some(language) = parts.next() else {
        return String::new();
    };
    match parts.next() {
        Some(region) if region.len() == 2 => {
            format!(
                "{}-{}",
                language.to_ascii_lowercase(),
                region.to_ascii_uppercase()
            )
        }
        Some(suffix) => format!("{}-{}", language.to_ascii_lowercase(), suffix),
        None => language.to_ascii_lowercase(),
    }
}

#[cfg(any(test, target_os = "macos", target_os = "linux"))]
fn voice_for_locale<'a>(
    voices: &'a [SystemVoice],
    locale: Option<&str>,
    requested_voice: Option<&str>,
) -> Option<&'a SystemVoice> {
    if let Some(requested) = requested_voice
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return voices.iter().find(|voice| {
            voice.id.eq_ignore_ascii_case(requested) || voice.name.eq_ignore_ascii_case(requested)
        });
    }
    let locale = normalize_voice_locale(locale?);
    let language = locale.split('-').next().unwrap_or_default();
    voices
        .iter()
        .find(|voice| normalize_voice_locale(&voice.language).eq_ignore_ascii_case(&locale))
        .or_else(|| {
            voices.iter().find(|voice| {
                let voice_locale = normalize_voice_locale(&voice.language);
                voice_locale.eq_ignore_ascii_case(language)
                    || voice_locale
                        .to_ascii_lowercase()
                        .starts_with(&format!("{}-", language.to_ascii_lowercase()))
            })
        })
}

#[cfg(any(test, target_os = "macos"))]
fn looks_like_macos_locale(value: &str) -> bool {
    let value = value.trim_matches(|character: char| character == ',' || character == ';');
    let mut parts = value.split(['_', '-']);
    let Some(language) = parts.next() else {
        return false;
    };
    let Some(region) = parts.next() else {
        return false;
    };
    (language.len() == 2 || language.len() == 3)
        && language
            .chars()
            .all(|character| character.is_ascii_alphabetic())
        && (region.len() == 2 || region.len() == 4)
        && region
            .chars()
            .all(|character| character.is_ascii_alphabetic())
}

#[cfg(any(test, target_os = "macos"))]
fn parse_macos_voices(output: &str) -> Vec<SystemVoice> {
    let mut voices = output
        .lines()
        .filter_map(|line| {
            let columns = line.split_whitespace().collect::<Vec<_>>();
            let locale_index = columns
                .iter()
                .position(|column| looks_like_macos_locale(column))?;
            if locale_index == 0 {
                return None;
            }
            let name = columns[..locale_index].join(" ");
            Some(SystemVoice {
                id: name.clone(),
                name,
                language: normalize_voice_locale(columns[locale_index]),
            })
        })
        .collect::<Vec<_>>();
    voices.sort_by(|left, right| {
        left.language
            .cmp(&right.language)
            .then_with(|| left.name.cmp(&right.name))
    });
    voices
}

#[cfg(any(test, target_os = "linux"))]
fn parse_espeak_voices(output: &str) -> Vec<SystemVoice> {
    let mut voices = output
        .lines()
        .filter_map(|line| {
            let columns = line.split_whitespace().collect::<Vec<_>>();
            if columns.len() < 5
                || columns[0].eq_ignore_ascii_case("pty")
                || !columns[0]
                    .chars()
                    .all(|character| character.is_ascii_digit())
            {
                return None;
            }
            Some(SystemVoice {
                id: columns[3].to_string(),
                name: columns[3].replace('_', " "),
                language: normalize_voice_locale(columns[1]),
            })
        })
        .collect::<Vec<_>>();
    voices.sort_by(|left, right| {
        left.language
            .cmp(&right.language)
            .then_with(|| left.name.cmp(&right.name))
    });
    voices
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

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn command_output_with_input(
    command: &mut std::process::Command,
    text: &str,
) -> Result<std::process::Output, String> {
    use std::io::Write;
    use std::process::Stdio;

    let program = command.get_program().to_string_lossy().into_owned();
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 {program}：{error}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| format!("无法写入 {program}"))?
        .write_all(text.as_bytes())
        .map_err(|error| format!("写入 {program} 失败：{error}"))?;
    child
        .wait_with_output()
        .map_err(|error| format!("等待 {program} 失败：{error}"))
}

#[cfg(target_os = "macos")]
fn installed_macos_voices() -> Result<Vec<SystemVoice>, String> {
    let output = std::process::Command::new("say")
        .args(["-v", "?"])
        .output()
        .map_err(|error| format!("无法读取 macOS 声音列表：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "无法读取 macOS 声音列表：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let voices = parse_macos_voices(&String::from_utf8_lossy(&output.stdout));
    if voices.is_empty() {
        Err("macOS 未返回可用的系统声音".to_string())
    } else {
        Ok(voices)
    }
}

#[cfg(target_os = "macos")]
struct TemporarySpeechFile(std::path::PathBuf);

#[cfg(target_os = "macos")]
impl TemporarySpeechFile {
    fn wav() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};

        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        Self(std::env::temp_dir().join(format!(
            "xiaoyun-system-tts-{}-{}-{}.wav",
            std::process::id(),
            timestamp,
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        )))
    }
}

#[cfg(target_os = "macos")]
impl Drop for TemporarySpeechFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(target_os = "macos")]
fn synthesize_system_audio(
    text: &str,
    lang: &str,
    requested_voice: Option<&str>,
    rate: f64,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    use std::io::{Error, ErrorKind};

    let locale = preferred_voice_locale(lang);
    let voices = installed_macos_voices().map_err(Error::other)?;
    let voice = voice_for_locale(&voices, locale.as_deref(), requested_voice);
    if requested_voice.is_some() && voice.is_none() {
        return Err(Error::new(ErrorKind::NotFound, "指定的 macOS 声音不可用").into());
    }
    if locale.is_some() && voice.is_none() {
        return Err(Error::new(ErrorKind::NotFound, "macOS 未安装对应语言的声音").into());
    }

    let output_file = TemporarySpeechFile::wav();
    let mut command = std::process::Command::new("say");
    command
        .arg("-o")
        .arg(&output_file.0)
        .args(["--file-format=WAVE", "--data-format=LEI16@22050", "-r"])
        .arg(format!("{:.0}", 175.0 * rate));
    if let Some(voice) = voice {
        command.arg("-v").arg(&voice.id);
    }
    command.args(["-f", "-"]);
    let output = command_output_with_input(&mut command, text).map_err(Error::other)?;
    if !output.status.success() {
        return Err(Error::other(format!(
            "macOS say 合成失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
        .into());
    }
    let audio = std::fs::read(&output_file.0)
        .map_err(|error| Error::other(format!("读取 macOS 语音音频失败：{error}")))?;
    if audio.len() < 44 || !audio.starts_with(b"RIFF") {
        return Err(Error::new(ErrorKind::InvalidData, "macOS say 返回了无效的 WAVE 音频").into());
    }
    Ok(audio)
}

#[cfg(target_os = "linux")]
fn linux_speech_program() -> Result<&'static str, String> {
    ["espeak-ng", "espeak"]
        .into_iter()
        .find(|program| {
            std::process::Command::new(program)
                .arg("--version")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok()
        })
        .ok_or_else(|| "未找到 espeak-ng 或 espeak，请先安装 espeak-ng".to_string())
}

#[cfg(target_os = "linux")]
fn installed_linux_voices() -> Result<Vec<SystemVoice>, String> {
    let program = linux_speech_program()?;
    let output = std::process::Command::new(program)
        .arg("--voices")
        .output()
        .map_err(|error| format!("无法读取 Linux 声音列表：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "无法读取 Linux 声音列表：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let voices = parse_espeak_voices(&String::from_utf8_lossy(&output.stdout));
    if voices.is_empty() {
        Err(format!("{program} 未返回可用声音"))
    } else {
        Ok(voices)
    }
}

#[cfg(target_os = "linux")]
fn synthesize_system_audio(
    text: &str,
    lang: &str,
    requested_voice: Option<&str>,
    rate: f64,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    use std::io::{Error, ErrorKind};

    let program = linux_speech_program().map_err(Error::other)?;
    let locale = preferred_espeak_locale(lang);
    let voices = installed_linux_voices().map_err(Error::other)?;
    let voice = voice_for_locale(&voices, locale.as_deref(), requested_voice);
    if requested_voice.is_some() && voice.is_none() {
        return Err(Error::new(ErrorKind::NotFound, "指定的 Linux 声音不可用").into());
    }
    if locale.is_some() && voice.is_none() {
        return Err(Error::new(ErrorKind::NotFound, "espeak-ng 未安装对应语言的声音数据").into());
    }

    let mut command = std::process::Command::new(program);
    command
        .args(["--stdout", "--stdin", "-s"])
        .arg(format!("{:.0}", 175.0 * rate));
    if let Some(voice) = voice {
        command.arg("-v").arg(&voice.id);
    }
    let output = command_output_with_input(&mut command, text).map_err(Error::other)?;
    if !output.status.success() {
        return Err(Error::other(format!(
            "{program} 合成失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
        .into());
    }
    if output.stdout.len() < 44 || !output.stdout.starts_with(b"RIFF") {
        return Err(Error::new(ErrorKind::InvalidData, "espeak-ng 返回了无效的 WAVE 音频").into());
    }
    Ok(output.stdout)
}

#[tauri::command(async)]
pub async fn system_tts(
    text: String,
    lang: String,
    voice: Option<String>,
    rate: Option<f64>,
) -> Result<Vec<u8>, String> {
    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
    {
        let busy_guard = try_acquire_system_tts().ok_or_else(|| "本机朗读正忙".to_string())?;
        let result = tauri::async_runtime::spawn_blocking(move || {
            let _busy_guard = busy_guard;
            synthesize_system_audio(&text, &lang, voice.as_deref(), normalize_rate(rate))
        })
        .await
        .map_err(|_| "本机朗读暂不可用".to_string())?;
        result.map_err(|error| {
            log::warn!("System TTS unavailable: {error}");
            #[cfg(windows)]
            {
                "本机朗读暂不可用".to_string()
            }
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            {
                format!("本机朗读暂不可用：{error}")
            }
        })
    }

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = (text, lang, voice, rate);
        Err("当前平台暂不支持本机朗读".to_string())
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

    #[cfg(target_os = "macos")]
    {
        return tauri::async_runtime::spawn_blocking(installed_macos_voices)
            .await
            .map_err(|_| "无法读取 macOS 声音列表".to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        return tauri::async_runtime::spawn_blocking(installed_linux_voices)
            .await
            .map_err(|_| "无法读取 Linux 声音列表".to_string())?;
    }

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_supported_language_codes_to_system_locales() {
        assert_eq!(preferred_voice_locale("en"), Some("en-US".to_string()));
        assert_eq!(preferred_voice_locale("zh"), Some("zh-CN".to_string()));
        assert_eq!(preferred_voice_locale("zh_HANT"), Some("zh-TW".to_string()));
        assert_eq!(preferred_voice_locale("zh-TW"), Some("zh-TW".to_string()));
        assert_eq!(preferred_espeak_locale("zh"), Some("cmn".to_string()));
    }

    #[test]
    fn clamps_speech_rate_to_supported_range() {
        assert_eq!(normalize_rate(None), 1.0);
        assert_eq!(normalize_rate(Some(0.1)), 0.5);
        assert_eq!(normalize_rate(Some(2.8)), 2.0);
    }

    #[test]
    fn parses_macos_voice_names_and_locales() {
        let voices = parse_macos_voices(
            "Samantha                en_US    # Hello!\n\
             Eddy (English (US))     en_US    # Hello!\n\
             Tingting                zh_CN    # 你好！",
        );
        assert_eq!(voices.len(), 3);
        assert!(voices
            .iter()
            .any(|voice| { voice.name == "Eddy (English (US))" && voice.language == "en-US" }));
        assert_eq!(
            voice_for_locale(&voices, Some("zh-CN"), None).map(|voice| voice.id.as_str()),
            Some("Tingting")
        );
    }

    #[test]
    fn parses_espeak_voice_table_and_selects_language_prefix() {
        let voices = parse_espeak_voices(
            "Pty Language Age/Gender VoiceName File Other Languages\n\
             5  en-us  M  English_(America)  gmw/en-US\n\
             5  cmn    M  Chinese_(Mandarin) asia/cmn",
        );
        assert_eq!(voices.len(), 2);
        assert_eq!(
            voice_for_locale(&voices, Some("en-US"), None).map(|voice| voice.id.as_str()),
            Some("English_(America)")
        );
        assert_eq!(
            voice_for_locale(&voices, Some("cmn"), None).map(|voice| voice.id.as_str()),
            Some("Chinese_(Mandarin)")
        );
    }

    #[test]
    fn requested_voice_must_match_id_or_name() {
        let voices = vec![SystemVoice {
            id: "voice-id".to_string(),
            name: "Readable Voice".to_string(),
            language: "en-US".to_string(),
        }];
        assert!(voice_for_locale(&voices, None, Some("VOICE-ID")).is_some());
        assert!(voice_for_locale(&voices, None, Some("readable voice")).is_some());
        assert!(voice_for_locale(&voices, None, Some("missing")).is_none());
    }

    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
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
