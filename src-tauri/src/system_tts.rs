use serde::Serialize;

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
use once_cell::sync::Lazy;

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
use tokio::sync::{Mutex as AsyncMutex, MutexGuard as AsyncMutexGuard};

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
static SYSTEM_TTS_SLOT: Lazy<AsyncMutex<()>> = Lazy::new(|| AsyncMutex::new(()));

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
static SYSTEM_TTS_GENERATION: AtomicU64 = AtomicU64::new(0);

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
const SYSTEM_TTS_REQUEST_UPDATED: &str = "朗读请求已更新/取消";

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn next_system_tts_generation(latest: &AtomicU64) -> u64 {
    latest.fetch_add(1, Ordering::AcqRel).wrapping_add(1)
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn is_latest_system_tts_generation(latest: &AtomicU64, request_generation: u64) -> bool {
    latest.load(Ordering::Acquire) == request_generation
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
async fn acquire_latest_system_tts_slot<'a>(
    slot: &'a AsyncMutex<()>,
    latest: &AtomicU64,
    request_generation: u64,
) -> Result<AsyncMutexGuard<'a, ()>, &'static str> {
    let guard = slot.lock().await;
    if !is_latest_system_tts_generation(latest, request_generation) {
        return Err(SYSTEM_TTS_REQUEST_UPDATED);
    }
    Ok(guard)
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
    quality: String,
}

fn system_voice_quality(id: &str, name: &str) -> &'static str {
    let searchable = format!("{id} {name}").to_ascii_lowercase();
    if ["natural", "neural", "premium", "enhanced"]
        .iter()
        .any(|marker| searchable.contains(marker))
    {
        "natural"
    } else {
        "standard"
    }
}

fn sort_system_voices(voices: &mut [SystemVoice]) {
    let quality_rank = |quality: &str| u8::from(quality == "natural");
    voices.sort_by(|left, right| {
        left.language
            .cmp(&right.language)
            // 同一语言默认把自然/神经/增强音色放在标准音色之前。
            .then_with(|| quality_rank(&right.quality).cmp(&quality_rank(&left.quality)))
            .then_with(|| left.name.cmp(&right.name))
    });
}

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
                quality: system_voice_quality(&name, &name).to_string(),
                name,
                language: normalize_voice_locale(columns[locale_index]),
            })
        })
        .collect::<Vec<_>>();
    sort_system_voices(&mut voices);
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
            let id = columns[3].to_string();
            let name = columns[3].replace('_', " ");
            Some(SystemVoice {
                quality: system_voice_quality(&id, &name).to_string(),
                id,
                name,
                language: normalize_voice_locale(columns[1]),
            })
        })
        .collect::<Vec<_>>();
    sort_system_voices(&mut voices);
    voices
}

#[cfg(windows)]
fn synthesize_windows_media_audio(
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
    let synthesizer = SpeechSynthesizer::new()?;
    let voices = SpeechSynthesizer::AllVoices()?;
    let mut descriptors = Vec::with_capacity(voices.Size()? as usize);
    for index in 0..voices.Size()? {
        let voice = voices.GetAt(index)?;
        let id = voice.Id()?.to_string();
        let name = voice.DisplayName()?.to_string();
        descriptors.push(SystemVoice {
            quality: system_voice_quality(&id, &name).to_string(),
            id,
            name,
            language: voice.Language()?.to_string(),
        });
    }
    sort_system_voices(&mut descriptors);
    let selected = voice_for_locale(&descriptors, Some(&locale), requested_voice)
        .ok_or_else(|| {
            if requested_voice.is_some() {
                Error::new(ErrorKind::NotFound, "指定的系统声音不可用")
            } else {
                Error::new(ErrorKind::NotFound, "系统未安装对应语言的声音")
            }
        })?
        .id
        .clone();
    let mut selected_voice = None;
    for index in 0..voices.Size()? {
        let voice = voices.GetAt(index)?;
        if voice.Id()?.to_string().eq_ignore_ascii_case(&selected) {
            selected_voice = Some(voice);
            break;
        }
    }
    let voice =
        selected_voice.ok_or_else(|| Error::new(ErrorKind::NotFound, "所选系统声音已不可用"))?;
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

#[cfg(windows)]
fn sapi_language_attribute(lang: &str) -> Option<&'static str> {
    let locale = preferred_voice_locale(lang)?;
    match locale.to_ascii_lowercase().as_str() {
        "en-us" | "en" => Some("Language=409"),
        "zh-cn" | "zh" => Some("Language=804"),
        "zh-tw" => Some("Language=404"),
        _ => None,
    }
}

#[cfg(windows)]
struct WindowsSpeechFile(std::path::PathBuf);

#[cfg(windows)]
impl WindowsSpeechFile {
    fn wav() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};

        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        Self(std::env::temp_dir().join(format!(
            "xiaoyun-sapi-{}-{}-{}.wav",
            std::process::id(),
            timestamp,
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        )))
    }
}

#[cfg(windows)]
impl Drop for WindowsSpeechFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(windows)]
fn synthesize_sapi_audio(
    text: &str,
    lang: &str,
    rate: f64,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    use std::io::{Error, ErrorKind};
    use windows::core::{GUID, HSTRING, PCWSTR};
    use windows::Win32::Media::Audio::{WAVEFORMATEX, WAVE_FORMAT_PCM};
    use windows::Win32::Media::Speech::{
        ISpObjectTokenCategory, ISpStream, ISpVoice, SpFileStream, SpObjectTokenCategory, SpVoice,
        SPCAT_VOICES, SPFM_CREATE_ALWAYS, SPF_DEFAULT,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    };

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
    } else {
        initialize_result.ok()?;
        unreachable!()
    };

    let language_attribute = sapi_language_attribute(lang)
        .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "经典 Windows 语音不支持该语言"))?;
    let category: ISpObjectTokenCategory =
        unsafe { CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_INPROC_SERVER)? };
    unsafe { category.SetId(SPCAT_VOICES, false)? };
    let attribute = HSTRING::from(language_attribute);
    let tokens = unsafe { category.EnumTokens(&attribute, PCWSTR::null())? };
    let mut count = 0;
    unsafe { tokens.GetCount(&mut count)? };
    if count == 0 {
        return Err(Error::new(ErrorKind::NotFound, "系统未安装经典 Windows 英文声音").into());
    }

    let voice: ISpVoice = unsafe { CoCreateInstance(&SpVoice, None, CLSCTX_INPROC_SERVER)? };
    let token = unsafe { tokens.Item(0)? };
    unsafe {
        voice.SetVoice(&token)?;
        voice.SetRate(((rate - 1.0) * 5.0).round().clamp(-10.0, 10.0) as i32)?;
    }

    let output_file = WindowsSpeechFile::wav();
    let output_path = HSTRING::from(output_file.0.to_string_lossy().as_ref());
    let stream: ISpStream = unsafe { CoCreateInstance(&SpFileStream, None, CLSCTX_INPROC_SERVER)? };
    let format_id = GUID::from_u128(0xc31adbae_527f_4ff5_a230_f62bb61ff70c);
    let wave_format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: 1,
        nSamplesPerSec: 22_050,
        nAvgBytesPerSec: 44_100,
        nBlockAlign: 2,
        wBitsPerSample: 16,
        cbSize: 0,
    };
    unsafe {
        stream.BindToFile(
            &output_path,
            SPFM_CREATE_ALWAYS,
            Some(&format_id),
            Some(&wave_format),
            0,
        )?;
        voice.SetOutput(&stream, false)?;
        voice.Speak(&HSTRING::from(text), SPF_DEFAULT.0 as u32, None)?;
        stream.Close()?;
    }

    let audio = std::fs::read(&output_file.0)?;
    if audio.len() < 44 || !audio.starts_with(b"RIFF") {
        return Err(Error::new(ErrorKind::InvalidData, "经典 Windows 语音返回了无效音频").into());
    }
    Ok(audio)
}

#[cfg(windows)]
fn synthesize_system_audio(
    text: &str,
    lang: &str,
    requested_voice: Option<&str>,
    rate: f64,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    match synthesize_windows_media_audio(text, lang, requested_voice, rate) {
        Ok(audio) => Ok(audio),
        Err(primary_error) if sapi_language_attribute(lang).is_some() => {
            log::debug!(
                "WinRT speech unavailable, falling back to classic Windows voice: {primary_error}"
            );
            synthesize_sapi_audio(text, lang, rate)
        }
        Err(error) => Err(error),
    }
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
        let request_generation = next_system_tts_generation(&SYSTEM_TTS_GENERATION);
        let _slot = acquire_latest_system_tts_slot(
            &SYSTEM_TTS_SLOT,
            &SYSTEM_TTS_GENERATION,
            request_generation,
        )
        .await
        .map_err(str::to_string)?;
        let result = tauri::async_runtime::spawn_blocking(move || {
            synthesize_system_audio(&text, &lang, voice.as_deref(), normalize_rate(rate))
        })
        .await;
        if !is_latest_system_tts_generation(&SYSTEM_TTS_GENERATION, request_generation) {
            return Err(SYSTEM_TTS_REQUEST_UPDATED.to_string());
        }
        let result = result.map_err(|_| "本机朗读暂不可用".to_string())?;
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
            quality: system_voice_quality(
                &voice.Id()?.to_string(),
                &voice.DisplayName()?.to_string(),
            )
            .to_string(),
        });
    }
    sort_system_voices(&mut result);
    Ok(result)
}

#[tauri::command(async)]
pub async fn list_system_voices() -> Result<Vec<SystemVoice>, String> {
    #[cfg(windows)]
    let result = tauri::async_runtime::spawn_blocking(installed_system_voices)
        .await
        .map_err(|_| "无法读取 Windows 声音列表".to_string())?
        .map_err(|error| {
            log::warn!("Unable to enumerate system voices: {error}");
            "无法读取 Windows 声音列表".to_string()
        });

    #[cfg(target_os = "macos")]
    let result = tauri::async_runtime::spawn_blocking(installed_macos_voices)
        .await
        .map_err(|_| "无法读取 macOS 声音列表".to_string())?;

    #[cfg(target_os = "linux")]
    let result = tauri::async_runtime::spawn_blocking(installed_linux_voices)
        .await
        .map_err(|_| "无法读取 Linux 声音列表".to_string())?;

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    let result = Ok(Vec::new());

    result
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

    #[cfg(windows)]
    #[test]
    fn maps_english_to_classic_windows_voice_attribute() {
        assert_eq!(sapi_language_attribute("en"), Some("Language=409"));
        assert_eq!(sapi_language_attribute("en-US"), Some("Language=409"));
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
            quality: "standard".to_string(),
        }];
        assert!(voice_for_locale(&voices, None, Some("VOICE-ID")).is_some());
        assert!(voice_for_locale(&voices, None, Some("readable voice")).is_some());
        assert!(voice_for_locale(&voices, None, Some("missing")).is_none());
    }

    #[test]
    fn marks_and_prefers_natural_voices_for_the_same_locale() {
        let mut voices = vec![
            SystemVoice {
                id: "standard-id".to_string(),
                name: "Microsoft Standard".to_string(),
                language: "en-US".to_string(),
                quality: system_voice_quality("standard-id", "Microsoft Standard").to_string(),
            },
            SystemVoice {
                id: "natural-id".to_string(),
                name: "Microsoft Ava Natural".to_string(),
                language: "en-US".to_string(),
                quality: system_voice_quality("natural-id", "Microsoft Ava Natural").to_string(),
            },
        ];
        sort_system_voices(&mut voices);

        assert_eq!(voices[0].quality, "natural");
        assert_eq!(
            voice_for_locale(&voices, Some("en-US"), None).map(|voice| voice.id.as_str()),
            Some("natural-id")
        );
    }

    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn latest_speech_request_replaces_the_waiting_request() {
        use std::sync::Arc;

        let slot = Arc::new(AsyncMutex::new(()));
        let latest = Arc::new(AtomicU64::new(0));
        let occupied = slot.lock().await;
        let first_generation = next_system_tts_generation(&latest);
        let waiting_slot = Arc::clone(&slot);
        let waiting_latest = Arc::clone(&latest);
        let first = tokio::spawn(async move {
            acquire_latest_system_tts_slot(&waiting_slot, &waiting_latest, first_generation)
                .await
                .map(|_guard| ())
        });
        tokio::task::yield_now().await;

        let latest_generation = next_system_tts_generation(&latest);
        drop(occupied);

        assert_eq!(
            first.await.expect("等待任务不应崩溃"),
            Err(SYSTEM_TTS_REQUEST_UPDATED)
        );
        assert!(
            acquire_latest_system_tts_slot(&slot, &latest, latest_generation)
                .await
                .is_ok()
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "需要 Windows 本机英语语音包"]
    fn windows_synthesizes_english_with_installed_voice() {
        let audio = synthesize_system_audio("Michaelis–Menten", "en", None, 1.0).unwrap();
        assert!(audio.len() > 44);
        assert_eq!(&audio[..4], b"RIFF");
    }
}
