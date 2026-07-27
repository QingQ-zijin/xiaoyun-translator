//! Ollama 首次接入与模型下载。
//!
//! 本模块只管理当前 SettingsV2 指向的统一 Gemma 4 模型。安装 Ollama 本体时仅打开
//! 官方下载页，由用户在浏览器中确认并运行安装程序；模型下载也必须由设置页明确触发。

use crate::config::{get_settings_v2, OllamaEndpointSettings, UNIFIED_OLLAMA_MODEL};
use once_cell::sync::Lazy;
use reqwest::{Client, Response, Url};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tokio::sync::{Mutex as AsyncMutex, Notify};
use tokio::time::sleep;

const OLLAMA_WINDOWS_DOWNLOAD_URL: &str = "https://ollama.com/download/windows";
const OLLAMA_MACOS_DOWNLOAD_URL: &str = "https://ollama.com/download/mac";
const OLLAMA_LINUX_DOWNLOAD_URL: &str = "https://ollama.com/download/linux";
const PULL_CANCEL_TOMBSTONE_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OllamaSetupStatus {
    pub installed: bool,
    pub executable_path: String,
    pub client_version: String,
    pub running: bool,
    pub server_version: String,
    pub model: String,
    pub model_installed: bool,
    pub model_running: bool,
    pub manageable: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OllamaPullProgress {
    pub request_id: String,
    pub state: String,
    pub status: String,
    pub message: String,
    pub digest: String,
    pub total: u64,
    pub completed: u64,
    pub progress: f64,
}

#[derive(Debug, Clone)]
struct OllamaExecutable {
    path: PathBuf,
    version: String,
}

#[derive(Debug, Default)]
struct PullCancellation {
    cancelled: AtomicBool,
    notify: Notify,
}

impl PullCancellation {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        // A pull has a single waiter at any given time. `notify_one` stores a
        // permit when cancellation arrives between two await points, whereas
        // `notify_waiters` would lose that notification.
        self.notify.notify_one();
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        self.notify.notified().await;
    }
}

enum PullCancellationSlot {
    Active(Arc<PullCancellation>),
    CancelledBeforeRegistration(Instant),
}

struct PullRegistration {
    request_id: String,
    cancellation: Arc<PullCancellation>,
}

impl Drop for PullRegistration {
    fn drop(&mut self) {
        let Ok(mut pulls) = OLLAMA_PULL_CANCELLATIONS.lock() else {
            return;
        };
        if matches!(
            pulls.get(&self.request_id),
            Some(PullCancellationSlot::Active(current))
                if Arc::ptr_eq(current, &self.cancellation)
        ) {
            pulls.remove(&self.request_id);
        }
    }
}

static OLLAMA_PULL_CANCELLATIONS: Lazy<Mutex<HashMap<String, PullCancellationSlot>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
/// 启动 Ollama 必须单飞：应用启动、设置页检测和翻译失败恢复可能同时到达，
/// 但任何时刻都只能创建一个本机服务进程。
static OLLAMA_START_LOCK: Lazy<AsyncMutex<()>> = Lazy::new(|| AsyncMutex::new(()));

fn onboarding_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .build()
        .map_err(|error| format!("无法创建 Ollama 接入客户端：{error}"))
}

fn normalized_host(endpoint: &OllamaEndpointSettings) -> String {
    endpoint
        .request_path
        .trim()
        .trim_end_matches('/')
        .to_string()
}

fn is_local_host(host: &str) -> bool {
    Url::parse(host)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|hostname| {
            matches!(
                hostname.as_str(),
                "localhost" | "127.0.0.1" | "::1" | "[::1]"
            )
        })
}

pub(crate) fn is_local_ollama_endpoint(endpoint: &OllamaEndpointSettings) -> bool {
    is_local_host(&normalized_host(endpoint))
}

fn output_text(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        stdout
    } else {
        String::from_utf8_lossy(&output.stderr).trim().to_string()
    }
}

fn executable_version(path: &Path) -> String {
    Command::new(path)
        .arg("--version")
        .output()
        .ok()
        .map(|output| output_text(&output))
        .unwrap_or_default()
}

fn platform_executable_candidates(
    platform: &str,
    local_app_data: Option<&Path>,
    home: Option<&Path>,
    path_directories: impl IntoIterator<Item = PathBuf>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if platform == "windows" {
        if let Some(local_app_data) = local_app_data {
            candidates.push(
                local_app_data
                    .join("Programs")
                    .join("Ollama")
                    .join("ollama.exe"),
            );
            candidates.push(local_app_data.join("Ollama").join("ollama.exe"));
        }
    } else if platform == "macos" {
        candidates.extend([
            PathBuf::from("/Applications/Ollama.app/Contents/Resources/ollama"),
            PathBuf::from("/usr/local/bin/ollama"),
            PathBuf::from("/opt/homebrew/bin/ollama"),
            PathBuf::from("/usr/bin/ollama"),
        ]);
        if let Some(home) = home {
            candidates.push(
                home.join("Applications")
                    .join("Ollama.app")
                    .join("Contents")
                    .join("Resources")
                    .join("ollama"),
            );
        }
    } else {
        candidates.extend([
            PathBuf::from("/usr/local/bin/ollama"),
            PathBuf::from("/usr/bin/ollama"),
            PathBuf::from("/bin/ollama"),
        ]);
        if let Some(home) = home {
            candidates.push(home.join(".local").join("bin").join("ollama"));
        }
    }

    let executable_name = if platform == "windows" {
        "ollama.exe"
    } else {
        "ollama"
    };
    candidates.extend(
        path_directories
            .into_iter()
            .map(|directory| directory.join(executable_name)),
    );
    let mut seen = HashSet::new();
    candidates.retain(|candidate| seen.insert(candidate.clone()));
    candidates
}

fn executable_candidates() -> Vec<PathBuf> {
    let local_app_data = env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(dirs::home_dir);
    let path_directories = env::var_os("PATH")
        .map(|path| env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    platform_executable_candidates(
        env::consts::OS,
        local_app_data.as_deref(),
        home.as_deref(),
        path_directories,
    )
}

fn discover_executable() -> Option<OllamaExecutable> {
    executable_candidates()
        .into_iter()
        .find(|candidate| candidate.is_file())
        .map(|path| OllamaExecutable {
            version: executable_version(&path),
            path,
        })
}

fn model_names(body: &Value) -> HashSet<String> {
    body.get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|model| [model.get("name"), model.get("model")])
        .flatten()
        .filter_map(Value::as_str)
        .flat_map(|name| {
            let normalized = name.trim().to_ascii_lowercase();
            let base = normalized
                .strip_suffix(":latest")
                .unwrap_or(&normalized)
                .to_string();
            [normalized, base]
        })
        .collect()
}

fn contains_model(body: &Value, model: &str) -> bool {
    let normalized = model.trim().to_ascii_lowercase();
    let base = normalized
        .strip_suffix(":latest")
        .unwrap_or(&normalized)
        .to_string();
    let names = model_names(body);
    names.contains(&normalized) || names.contains(&base)
}

async fn response_json(response: Response, action: &str) -> Result<Value, String> {
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("{action}响应读取失败：{error}"))?;
    if !status.is_success() {
        let detail = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|body| {
                body.get("error")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| String::from_utf8_lossy(&bytes).trim().to_string());
        let suffix = if detail.is_empty() {
            String::new()
        } else {
            format!("：{detail}")
        };
        return Err(format!("{action}失败（HTTP {status}）{suffix}"));
    }
    serde_json::from_slice(&bytes).map_err(|error| format!("{action}响应格式错误：{error}"))
}

async fn detect_setup_status(
    endpoint: &OllamaEndpointSettings,
) -> Result<OllamaSetupStatus, String> {
    let host = normalized_host(endpoint);
    let manageable = is_local_host(&host);
    let executable = if manageable {
        discover_executable()
    } else {
        None
    };
    let mut status = OllamaSetupStatus {
        installed: executable.is_some(),
        executable_path: executable
            .as_ref()
            .map(|value| value.path.to_string_lossy().into_owned())
            .unwrap_or_default(),
        client_version: executable
            .as_ref()
            .map(|value| value.version.clone())
            .unwrap_or_default(),
        running: false,
        server_version: String::new(),
        model: UNIFIED_OLLAMA_MODEL.to_string(),
        model_installed: false,
        model_running: false,
        manageable,
        message: String::new(),
    };

    let client = onboarding_client()?;
    let version_response = client
        .get(format!("{host}/api/version"))
        .timeout(Duration::from_secs(3))
        .send()
        .await;
    let Ok(version_response) = version_response else {
        status.message = if status.installed {
            "Ollama 已安装，后台服务尚未启动".to_string()
        } else if manageable {
            "尚未检测到 Ollama".to_string()
        } else {
            "无法连接远程 Ollama 地址".to_string()
        };
        return Ok(status);
    };
    let version = response_json(version_response, "读取 Ollama 版本").await?;
    status.running = true;
    status.server_version = version
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if manageable {
        // 服务可达但命令行不在 PATH 时仍视为已经安装，例如由 Windows 托盘程序启动。
        status.installed = true;
    }

    let tags = client
        .get(format!("{host}/api/tags"))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|error| format!("读取 Ollama 模型列表失败：{error}"))?;
    let tags = response_json(tags, "读取 Ollama 模型列表").await?;
    status.model_installed = contains_model(&tags, UNIFIED_OLLAMA_MODEL);

    let processes = client
        .get(format!("{host}/api/ps"))
        .timeout(Duration::from_secs(5))
        .send()
        .await;
    if let Ok(processes) = processes {
        if let Ok(processes) = response_json(processes, "读取 Ollama 运行模型").await {
            status.model_running = contains_model(&processes, UNIFIED_OLLAMA_MODEL);
        }
    }
    status.message = if !status.model_installed {
        "Ollama 已运行，Gemma 4 E4B 尚未下载".to_string()
    } else if status.model_running {
        "Gemma 4 E4B 已加载并可立即使用".to_string()
    } else {
        "Gemma 4 E4B 已安装，可在启用后自动预热".to_string()
    };
    Ok(status)
}

/// 检测本机 Ollama、后台服务、统一模型安装与加载状态。
#[tauri::command]
pub async fn ollama_get_setup_status() -> Result<OllamaSetupStatus, String> {
    let settings = get_settings_v2()?;
    detect_setup_status(&settings.ollama.translation).await
}

fn official_download_url() -> &'static str {
    if cfg!(target_os = "macos") {
        OLLAMA_MACOS_DOWNLOAD_URL
    } else if cfg!(target_os = "linux") {
        OLLAMA_LINUX_DOWNLOAD_URL
    } else {
        OLLAMA_WINDOWS_DOWNLOAD_URL
    }
}

fn open_url_with_system(url: &str) -> Result<(), String> {
    let result = if cfg!(windows) {
        Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn()
    } else if cfg!(target_os = "macos") {
        Command::new("open").arg(url).spawn()
    } else {
        Command::new("xdg-open").arg(url).spawn()
    };
    result
        .map(|_| ())
        .map_err(|error| format!("无法打开系统浏览器：{error}"))
}

/// 打开 Ollama 官方下载页，不下载、执行或静默安装任何程序。
#[tauri::command]
pub fn ollama_open_official_download() -> Result<(), String> {
    open_url_with_system(official_download_url())
}

fn spawn_ollama_server(executable: &Path) -> Result<std::process::Child, String> {
    let mut command = Command::new(executable);
    command
        .arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：Ollama 服务在后台运行，不额外弹出终端窗口。
        command.creation_flags(0x0800_0000);
    }
    command
        .spawn()
        .map_err(|error| format!("启动 Ollama 服务失败：{error}"))
}

fn can_spawn_local_ollama_service(platform: &str) -> bool {
    matches!(platform, "windows" | "macos")
}

fn local_service_start_guidance(platform: &str) -> String {
    if platform == "linux" {
        "Linux 上不会由应用隐式启动 Ollama；请运行 `sudo systemctl start ollama`，或在终端运行 `ollama serve` 后重试"
            .to_string()
    } else {
        "当前平台不会由应用隐式启动 Ollama，请按 Ollama 官方说明启动服务后重试".to_string()
    }
}

/// 确保本机 Ollama 服务已启动。供设置页和应用启动恢复流程共同使用。
pub(crate) async fn ensure_local_ollama_service(
    endpoint: &OllamaEndpointSettings,
) -> Result<OllamaSetupStatus, String> {
    if !is_local_ollama_endpoint(endpoint) {
        return Err("当前配置是远程 Ollama 地址，请在服务器上启动服务".to_string());
    }
    let current = detect_setup_status(endpoint).await?;
    if current.running {
        return Ok(current);
    }
    let _start_guard = OLLAMA_START_LOCK.lock().await;
    // 等锁期间其他请求可能已经完成启动；二次检测避免重复创建 `ollama serve`。
    let current = detect_setup_status(endpoint).await?;
    if current.running {
        return Ok(current);
    }
    if !can_spawn_local_ollama_service(env::consts::OS) {
        return Err(local_service_start_guidance(env::consts::OS));
    }
    let executable = discover_executable()
        .ok_or_else(|| "尚未安装 Ollama，请先打开官方下载页完成安装".to_string())?;
    let mut child = spawn_ollama_server(&executable.path)?;
    for _ in 0..40 {
        sleep(Duration::from_millis(250)).await;
        let child_exit = child
            .try_wait()
            .map_err(|error| format!("检查 Ollama 服务状态失败：{error}"))?;
        // 官方托盘程序可能恰好也在启动 Ollama。即使本应用拉起的第二个
        // `ollama serve` 因端口占用退出，也应先以 API 健康状态为准。
        match detect_setup_status(endpoint).await {
            Ok(status) if status.running => return Ok(status),
            Ok(_) | Err(_) if child_exit.is_none() => continue,
            Ok(_) | Err(_) => {}
        }
        if let Some(exit) = child_exit {
            return Err(format!("Ollama 服务未能启动（退出码 {exit}）"));
        }
    }
    Err("Ollama 启动超时，请检查防火墙或在终端运行 `ollama serve` 查看详情".to_string())
}

/// 启动本机 Ollama 服务。远程地址不会被本应用管理。
#[tauri::command]
pub async fn ollama_start_local_service() -> Result<OllamaSetupStatus, String> {
    let settings = get_settings_v2()?;
    ensure_local_ollama_service(&settings.ollama.translation).await
}

fn ensure_activation_enabled(enabled: bool) -> Result<(), String> {
    if enabled {
        Ok(())
    } else {
        Err("Ollama 后端已关闭，请先在设置中启用并保存后重试".to_string())
    }
}

fn ensure_model_installed_for_activation(status: &OllamaSetupStatus) -> Result<(), String> {
    if status.model_installed {
        Ok(())
    } else {
        Err(format!(
            "统一模型 {} 尚未安装，请先下载模型后重试",
            status.model
        ))
    }
}

/// 幂等地启动本机 Ollama 并将统一模型载入内存。
#[tauri::command]
pub async fn ollama_activate_unified_model() -> Result<OllamaSetupStatus, String> {
    let settings = get_settings_v2()?;
    ensure_activation_enabled(settings.ollama.enabled)?;
    let endpoint = settings.ollama.translation;
    crate::research_runtime::ensure_unified_ollama_runtime(&endpoint)
        .await
        .map_err(|error| format!("统一模型激活失败：{error}"))?;
    let status = detect_setup_status(&endpoint).await?;
    ensure_model_installed_for_activation(&status)?;
    Ok(status)
}

fn prune_pull_cancellations(pulls: &mut HashMap<String, PullCancellationSlot>) {
    let now = Instant::now();
    pulls.retain(|_, slot| match slot {
        PullCancellationSlot::Active(_) => true,
        PullCancellationSlot::CancelledBeforeRegistration(created_at) => {
            now.saturating_duration_since(*created_at) <= PULL_CANCEL_TOMBSTONE_TTL
        }
    });
}

fn register_pull(request_id: &str) -> Result<PullRegistration, String> {
    let cancellation = Arc::new(PullCancellation::default());
    let mut pulls = OLLAMA_PULL_CANCELLATIONS
        .lock()
        .map_err(|_| "Ollama 下载取消表已损坏".to_string())?;
    prune_pull_cancellations(&mut pulls);
    if let Some(active_request_id) = pulls.iter().find_map(|(active_request_id, slot)| {
        (active_request_id != request_id && matches!(slot, PullCancellationSlot::Active(_)))
            .then_some(active_request_id)
    }) {
        return Err(format!(
            "已有模型下载正在进行（请求 {active_request_id}），请等待完成或先取消"
        ));
    }
    match pulls.remove(request_id) {
        Some(PullCancellationSlot::Active(previous)) => previous.cancel(),
        Some(PullCancellationSlot::CancelledBeforeRegistration(_)) => cancellation.cancel(),
        None => {}
    }
    pulls.insert(
        request_id.to_string(),
        PullCancellationSlot::Active(cancellation.clone()),
    );
    Ok(PullRegistration {
        request_id: request_id.to_string(),
        cancellation,
    })
}

fn human_pull_status(status: &str, progress: f64) -> String {
    let lower = status.to_ascii_lowercase();
    if lower == "success" {
        "模型下载完成".to_string()
    } else if lower.contains("manifest") && lower.contains("pull") {
        "正在读取模型清单".to_string()
    } else if lower.starts_with("pulling ") {
        format!("正在下载模型文件 {:.0}%", progress * 100.0)
    } else if lower.contains("verifying") {
        "正在校验模型文件".to_string()
    } else if lower.contains("writing manifest") {
        "正在写入模型清单".to_string()
    } else if lower.contains("removing") {
        "正在整理模型文件".to_string()
    } else {
        status.to_string()
    }
}

fn parse_pull_progress(request_id: &str, line: &[u8]) -> Result<OllamaPullProgress, String> {
    let body: Value = serde_json::from_slice(line)
        .map_err(|error| format!("Ollama 下载进度格式错误：{error}"))?;
    if let Some(error) = body.get("error").and_then(Value::as_str) {
        return Err(format!("Ollama 模型下载失败：{error}"));
    }
    let status = body
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let total = body.get("total").and_then(Value::as_u64).unwrap_or(0);
    let completed = body.get("completed").and_then(Value::as_u64).unwrap_or(0);
    let progress = if total == 0 {
        0.0
    } else {
        (completed as f64 / total as f64).clamp(0.0, 1.0)
    };
    Ok(OllamaPullProgress {
        request_id: request_id.to_string(),
        state: if status == "success" {
            "completed".to_string()
        } else {
            "running".to_string()
        },
        message: human_pull_status(&status, progress),
        status,
        digest: body
            .get("digest")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        total,
        completed,
        progress,
    })
}

fn send_pull_event(
    channel: &Channel<OllamaPullProgress>,
    event: OllamaPullProgress,
) -> Result<(), String> {
    channel
        .send(event)
        .map_err(|error| format!("发送模型下载进度失败：{error}"))
}

fn send_pull_cancelled(
    channel: &Channel<OllamaPullProgress>,
    request_id: &str,
) -> Result<(), String> {
    send_pull_event(
        channel,
        OllamaPullProgress {
            request_id: request_id.to_string(),
            state: "cancelled".to_string(),
            status: "cancelled".to_string(),
            message: "模型下载已取消".to_string(),
            digest: String::new(),
            total: 0,
            completed: 0,
            progress: 0.0,
        },
    )
}

fn ensure_pull_not_cancelled(
    cancellation: &PullCancellation,
    channel: &Channel<OllamaPullProgress>,
    request_id: &str,
) -> Result<(), String> {
    if !cancellation.is_cancelled() {
        return Ok(());
    }
    send_pull_cancelled(channel, request_id)?;
    Err("模型下载已取消".to_string())
}

fn should_prewarm_after_pull(enabled: bool, status: &OllamaSetupStatus) -> bool {
    enabled && status.model_installed
}

async fn pull_response_error(response: Response) -> String {
    let status = response.status();
    let detail = response
        .text()
        .await
        .ok()
        .and_then(|body| {
            serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|value| {
                    value
                        .get("error")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .or_else(|| (!body.trim().is_empty()).then(|| body.trim().to_string()))
        })
        .unwrap_or_default();
    if detail.is_empty() {
        format!("Ollama 模型下载失败（HTTP {status}）")
    } else {
        format!("Ollama 模型下载失败（HTTP {status}）：{detail}")
    }
}

/// 下载统一 Gemma 4 模型并通过 Channel 上报官方 `/api/pull` 的逐层进度。
#[tauri::command]
pub async fn ollama_pull_unified_model(
    request_id: String,
    on_event: Channel<OllamaPullProgress>,
) -> Result<OllamaSetupStatus, String> {
    let request_id = request_id.trim().to_string();
    if request_id.is_empty() {
        return Err("模型下载请求 ID 不能为空".to_string());
    }
    let settings = get_settings_v2()?;
    let endpoint = settings.ollama.translation;
    let host = normalized_host(&endpoint);
    if !is_local_host(&host) {
        return Err("为避免意外占用远程磁盘，一键下载仅支持本机 Ollama".to_string());
    }
    let registration = register_pull(&request_id)?;
    ensure_pull_not_cancelled(&registration.cancellation, &on_event, &request_id)?;

    let send_request = onboarding_client()?
        .post(format!("{host}/api/pull"))
        .json(&json!({"model": UNIFIED_OLLAMA_MODEL, "stream": true}))
        .send();
    let response = tokio::select! {
        _ = registration.cancellation.cancelled() => {
            send_pull_cancelled(&on_event, &request_id)?;
            return Err("模型下载已取消".to_string());
        }
        response = send_request => {
            response.map_err(|error| format!("无法连接 Ollama 下载模型：{error}"))?
        }
    };
    ensure_pull_not_cancelled(&registration.cancellation, &on_event, &request_id)?;
    if !response.status().is_success() {
        return Err(pull_response_error(response).await);
    }

    let mut response = response;
    let mut pending = Vec::<u8>::new();
    loop {
        let cancellation = registration.cancellation.clone();
        ensure_pull_not_cancelled(&cancellation, &on_event, &request_id)?;
        let chunk = tokio::select! {
            _ = cancellation.cancelled() => {
                send_pull_cancelled(&on_event, &request_id)?;
                return Err("模型下载已取消".to_string());
            }
            chunk = response.chunk() => {
                chunk.map_err(|error| format!("读取 Ollama 下载进度失败：{error}"))?
            }
        };
        ensure_pull_not_cancelled(&cancellation, &on_event, &request_id)?;
        let Some(chunk) = chunk else {
            break;
        };
        pending.extend_from_slice(&chunk);
        while let Some(line_end) = pending.iter().position(|byte| *byte == b'\n') {
            let line = pending.drain(..=line_end).collect::<Vec<_>>();
            let line = line
                .strip_suffix(b"\n")
                .unwrap_or(&line)
                .strip_suffix(b"\r")
                .unwrap_or(line.strip_suffix(b"\n").unwrap_or(&line));
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            send_pull_event(&on_event, parse_pull_progress(&request_id, line)?)?;
        }
    }
    if !pending.iter().all(u8::is_ascii_whitespace) {
        send_pull_event(
            &on_event,
            parse_pull_progress(&request_id, pending.as_slice())?,
        )?;
    }
    ensure_pull_not_cancelled(&registration.cancellation, &on_event, &request_id)?;
    let detect_status = detect_setup_status(&endpoint);
    let mut status = tokio::select! {
        _ = registration.cancellation.cancelled() => {
            send_pull_cancelled(&on_event, &request_id)?;
            return Err("模型下载已取消".to_string());
        }
        status = detect_status => status?,
    };
    ensure_pull_not_cancelled(&registration.cancellation, &on_event, &request_id)?;
    if !status.model_installed {
        return Err("Ollama 下载流已结束，但没有检测到 Gemma 4 E4B 模型".to_string());
    }
    // 下载可能持续很久，结束时必须重读最新开关。用户期间关闭本地 AI 时，
    // 下载仍算成功，但不再把“跳过预热”误报成整次下载失败。
    let latest_settings = get_settings_v2()?;
    let endpoint_unchanged = latest_settings
        .ollama
        .translation
        .request_path
        .trim_end_matches('/')
        == endpoint.request_path.trim_end_matches('/');
    if endpoint_unchanged && should_prewarm_after_pull(latest_settings.ollama.enabled, &status) {
        ensure_pull_not_cancelled(&registration.cancellation, &on_event, &request_id)?;
        // 下载结束后也加入应用级单飞恢复；取消设置页等待不会销毁已启动的服务进程。
        let prewarm = crate::research_runtime::ensure_unified_ollama_runtime(&endpoint);
        tokio::select! {
            _ = registration.cancellation.cancelled() => {
                send_pull_cancelled(&on_event, &request_id)?;
                return Err("模型下载已取消".to_string());
            }
            result = prewarm => {
                result.map_err(|error| format!("模型已下载，但自动预热失败：{error}"))?;
            }
        }
        ensure_pull_not_cancelled(&registration.cancellation, &on_event, &request_id)?;
        let detect_status = detect_setup_status(&endpoint);
        status = tokio::select! {
            _ = registration.cancellation.cancelled() => {
                send_pull_cancelled(&on_event, &request_id)?;
                return Err("模型下载已取消".to_string());
            }
            status = detect_status => status?,
        };
    }
    ensure_pull_not_cancelled(&registration.cancellation, &on_event, &request_id)?;
    Ok(status)
}

/// 取消当前设置页发起的模型下载；即使取消请求先到，也不会随后误启动下载。
#[tauri::command]
pub fn ollama_cancel_model_pull(request_id: String) -> Result<bool, String> {
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Ok(false);
    }
    let mut pulls = OLLAMA_PULL_CANCELLATIONS
        .lock()
        .map_err(|_| "Ollama 下载取消表已损坏".to_string())?;
    prune_pull_cancellations(&mut pulls);
    if let Some(PullCancellationSlot::Active(cancellation)) = pulls.get(request_id) {
        cancellation.cancel();
        return Ok(true);
    }
    pulls.insert(
        request_id.to_string(),
        PullCancellationSlot::CancelledBeforeRegistration(Instant::now()),
    );
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    static PULL_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn local_host_detection_rejects_remote_management() {
        assert!(is_local_host("http://127.0.0.1:11434"));
        assert!(is_local_host("http://localhost:11434"));
        assert!(is_local_host("http://[::1]:11434"));
        assert!(!is_local_host("https://ollama.example.com"));
    }

    #[test]
    fn platform_candidates_cover_gui_installs_and_path_without_duplicates() {
        let home = Path::new("/Users/researcher");
        let macos = platform_executable_candidates(
            "macos",
            None,
            Some(home),
            [PathBuf::from("/usr/local/bin")],
        );
        assert!(macos.contains(&PathBuf::from(
            "/Applications/Ollama.app/Contents/Resources/ollama"
        )));
        assert!(macos.contains(&home.join("Applications/Ollama.app/Contents/Resources/ollama")));
        assert_eq!(
            macos
                .iter()
                .filter(|candidate| candidate.as_path() == Path::new("/usr/local/bin/ollama"))
                .count(),
            1
        );

        let linux = platform_executable_candidates(
            "linux",
            None,
            Some(Path::new("/home/researcher")),
            [PathBuf::from("/custom/bin")],
        );
        assert!(linux.contains(&PathBuf::from("/home/researcher/.local/bin/ollama")));
        assert!(linux.contains(&PathBuf::from("/custom/bin/ollama")));
    }

    #[test]
    fn model_matching_accepts_name_model_and_latest_alias() {
        let body = json!({
            "models": [
                {"name": "gemma4:e4b-it-qat"},
                {"model": "other:latest"}
            ]
        });
        assert!(contains_model(&body, "gemma4:e4b-it-qat"));
        assert!(contains_model(&body, "other"));
        assert!(!contains_model(&body, "missing:latest"));
    }

    #[test]
    fn streamed_pull_progress_is_understandable_and_bounded() {
        let event = parse_pull_progress(
            "pull-1",
            br#"{"status":"pulling abc","digest":"abc","total":100,"completed":42}"#,
        )
        .unwrap();
        assert_eq!(event.request_id, "pull-1");
        assert_eq!(event.state, "running");
        assert_eq!(event.progress, 0.42);
        assert_eq!(event.message, "正在下载模型文件 42%");

        let completed = parse_pull_progress("pull-1", br#"{"status":"success"}"#).unwrap();
        assert_eq!(completed.state, "completed");
        assert_eq!(completed.message, "模型下载完成");
    }

    #[test]
    fn pull_error_is_not_misreported_as_progress() {
        let error =
            parse_pull_progress("pull-2", br#"{"error":"model manifest not found"}"#).unwrap_err();
        assert!(error.contains("model manifest not found"));
    }

    #[test]
    fn downloaded_model_is_prewarmed_only_when_backend_is_enabled() {
        let mut status = OllamaSetupStatus {
            installed: true,
            executable_path: String::new(),
            client_version: String::new(),
            running: true,
            server_version: String::new(),
            model: UNIFIED_OLLAMA_MODEL.to_string(),
            model_installed: true,
            model_running: false,
            manageable: true,
            message: String::new(),
        };
        assert!(should_prewarm_after_pull(true, &status));
        assert!(!should_prewarm_after_pull(false, &status));
        status.model_installed = false;
        assert!(!should_prewarm_after_pull(true, &status));
    }

    #[test]
    fn cancellation_before_registration_is_consumed_once() {
        let _test_guard = PULL_TEST_LOCK.lock().unwrap();
        let request_id = format!("pull-before-register-{}", std::process::id());
        assert!(!ollama_cancel_model_pull(request_id.clone()).unwrap());
        let registration = register_pull(&request_id).unwrap();
        assert!(registration.cancellation.cancelled.load(Ordering::Acquire));
        drop(registration);
        assert!(!OLLAMA_PULL_CANCELLATIONS
            .lock()
            .unwrap()
            .contains_key(&request_id));
    }

    #[test]
    fn another_request_cannot_start_while_unified_model_pull_is_active() {
        let _test_guard = PULL_TEST_LOCK.lock().unwrap();
        let first_request_id = format!("pull-active-first-{}", std::process::id());
        let second_request_id = format!("pull-active-second-{}", std::process::id());
        let first_registration = register_pull(&first_request_id).unwrap();

        let error = register_pull(&second_request_id)
            .err()
            .expect("a second active unified-model pull must be rejected");
        assert!(error.contains("已有模型下载正在进行"));
        assert!(error.contains(&first_request_id));

        drop(first_registration);
        let second_registration = register_pull(&second_request_id).unwrap();
        drop(second_registration);
    }
    #[test]
    fn cancellation_notification_is_retained_before_waiter_registration() {
        let cancellation = PullCancellation::default();
        cancellation.cancel();

        tauri::async_runtime::block_on(async {
            tokio::time::timeout(Duration::from_secs(1), cancellation.notify.notified())
                .await
                .expect("notify_one should retain a cancellation permit");
            tokio::time::timeout(Duration::from_secs(1), cancellation.cancelled())
                .await
                .expect("the atomic cancellation state should remain observable");
        });
        assert!(cancellation.is_cancelled());
    }

    #[test]
    fn local_service_spawn_policy_is_explicit_per_platform() {
        assert!(can_spawn_local_ollama_service("windows"));
        assert!(can_spawn_local_ollama_service("macos"));
        assert!(!can_spawn_local_ollama_service("linux"));
        assert!(!can_spawn_local_ollama_service("unknown"));

        let guidance = local_service_start_guidance("linux");
        assert!(guidance.contains("systemctl start ollama"));
        assert!(guidance.contains("ollama serve"));
    }

    #[test]
    fn activation_respects_the_saved_backend_switch() {
        assert!(ensure_activation_enabled(true).is_ok());

        let error = ensure_activation_enabled(false).unwrap_err();
        assert!(error.contains("已关闭"));
        assert!(error.contains("启用并保存"));
    }

    #[test]
    fn activation_requires_the_unified_model_to_be_installed() {
        let mut status = OllamaSetupStatus {
            installed: true,
            executable_path: String::new(),
            client_version: String::new(),
            running: true,
            server_version: String::new(),
            model: UNIFIED_OLLAMA_MODEL.to_string(),
            model_installed: false,
            model_running: false,
            manageable: true,
            message: String::new(),
        };

        let error = ensure_model_installed_for_activation(&status).unwrap_err();
        assert!(error.contains(UNIFIED_OLLAMA_MODEL));
        assert!(error.contains("尚未安装"));

        status.model_installed = true;
        assert!(ensure_model_installed_for_activation(&status).is_ok());
    }
}
