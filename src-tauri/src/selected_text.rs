//! 跨应用划词捕获。
//!
//! Windows 剪贴板和 UI Automation 都必须在稳定的 COM apartment 中使用。
//! 主程序只通过带请求 ID 的 JSON Lines 管道访问独立 helper；helper 内部由唯一
//! 的常驻 STA worker 执行取词。新请求会替换尚未开始的旧请求，并让执行中的旧
//! 请求尽快停止。helper 崩溃或管道断开时，主程序会在当前请求预算内自动重启。

use std::fmt;

#[cfg(target_os = "windows")]
use enigo::{
    Direction::{Click, Press, Release},
    Enigo, Key, Keyboard, Settings,
};
#[cfg(target_os = "windows")]
use log::{info, warn};
#[cfg(target_os = "windows")]
use serde::{Deserialize, Serialize};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use std::{
    collections::HashMap,
    ffi::c_void,
    fs,
    io::{BufRead, BufReader, BufWriter, Write},
    panic::{catch_unwind, AssertUnwindSafe},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    ptr,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, RecvTimeoutError, Sender, SyncSender},
        Arc, Condvar, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{GetLastError, SetLastError, HANDLE, HGLOBAL, HWND, WIN32_ERROR};
#[cfg(target_os = "windows")]
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
#[cfg(target_os = "windows")]
use windows::Win32::System::DataExchange::{
    CloseClipboard, CountClipboardFormats, EmptyClipboard, GetClipboardData,
    GetClipboardSequenceNumber, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::Ole::{OleInitialize, OleUninitialize};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationTextPattern, UIA_TextPatternId,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, HWND_MESSAGE, WINDOW_EX_STYLE, WINDOW_STYLE,
};

#[cfg(target_os = "windows")]
const SELECTION_TIMEOUT: Duration = Duration::from_millis(800);
#[cfg(target_os = "windows")]
const RESULT_POLL_INTERVAL: Duration = Duration::from_millis(10);
#[cfg(target_os = "windows")]
const CLIPBOARD_FAST_TIMEOUT: Duration = Duration::from_millis(420);
#[cfg(target_os = "windows")]
const HELPER_RESPONSE_MARGIN: Duration = Duration::from_millis(40);
#[cfg(target_os = "windows")]
const CLIPBOARD_SNAPSHOT_TIMEOUT: Duration = Duration::from_millis(120);
#[cfg(target_os = "windows")]
const CLIPBOARD_RESTORE_TIMEOUT: Duration = Duration::from_millis(150);
#[cfg(target_os = "windows")]
const CLIPBOARD_POLL_INTERVAL: Duration = Duration::from_millis(10);
#[cfg(target_os = "windows")]
const CLIPBOARD_POLL_LIMIT: usize = 80;
#[cfg(target_os = "windows")]
const COPY_RETRY_POLL: usize = 5;
#[cfg(target_os = "windows")]
const OPEN_CLIPBOARD_RETRY_DELAYS: [Duration; 6] = [
    Duration::from_millis(2),
    Duration::from_millis(4),
    Duration::from_millis(8),
    Duration::from_millis(16),
    Duration::from_millis(24),
    Duration::from_millis(32),
];
#[cfg(target_os = "windows")]
const CF_UNICODETEXT: u32 = 13;
#[cfg(target_os = "windows")]
const CF_DIB: u32 = 8;
#[cfg(target_os = "windows")]
const CF_HDROP: u32 = 15;
#[cfg(target_os = "windows")]
const CF_DIBV5: u32 = 17;
#[cfg(target_os = "windows")]
const GMEM_MOVEABLE: u32 = 0x0002;
#[cfg(target_os = "windows")]
const MAX_STANDARD_FORMAT_BYTES: usize = 128 * 1024 * 1024;
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const HELPER_BUILD_NAME: &str = "selection-helper-x86_64-pc-windows-msvc";
#[cfg(all(target_os = "windows", target_arch = "x86"))]
const HELPER_BUILD_NAME: &str = "selection-helper-i686-pc-windows-msvc";
#[cfg(all(target_os = "windows", target_arch = "aarch64"))]
const HELPER_BUILD_NAME: &str = "selection-helper-aarch64-pc-windows-msvc";
#[cfg(target_os = "windows")]
const HELPER_BUNDLE_NAME: &str = "selection-helper";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 取词失败时向窗口层暴露稳定、可展示的错误，而不是 panic 或静默返回旧文本。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectionError {
    Cancelled,
    #[cfg(target_os = "windows")]
    TimedOut,
    NoSelection,
    WorkerUnavailable(String),
    #[cfg(target_os = "windows")]
    Automation(String),
    #[cfg(target_os = "windows")]
    Clipboard(String),
    #[cfg(target_os = "windows")]
    Input(String),
}

impl fmt::Display for SelectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled => formatter.write_str("取词请求已取消"),
            #[cfg(target_os = "windows")]
            Self::TimedOut => formatter.write_str("取词超时，请重新选择文字"),
            Self::NoSelection => formatter.write_str("未读取到选中的文字"),
            Self::WorkerUnavailable(message) => write!(formatter, "取词服务不可用：{message}"),
            #[cfg(target_os = "windows")]
            Self::Automation(message) => write!(formatter, "UI Automation 取词失败：{message}"),
            #[cfg(target_os = "windows")]
            Self::Clipboard(message) => write!(formatter, "剪贴板取词失败：{message}"),
            #[cfg(target_os = "windows")]
            Self::Input(message) => write!(formatter, "模拟复制失败：{message}"),
        }
    }
}

impl std::error::Error for SelectionError {}

/// Result 形式的取词接口，供新的窗口状态机直接展示失败原因。
pub fn capture_selected_text<Cancelled>(is_cancelled: Cancelled) -> Result<String, SelectionError>
where
    Cancelled: Fn() -> bool,
{
    #[cfg(target_os = "windows")]
    {
        selection_sidecar().capture(is_cancelled)
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        if is_cancelled() {
            return Err(SelectionError::Cancelled);
        }
        let text = std::panic::catch_unwind(selection::get_text).map_err(|_| {
            SelectionError::WorkerUnavailable("系统选区接口发生异常，请检查辅助功能权限".into())
        })?;
        finish_platform_capture(text, is_cancelled())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = is_cancelled;
        Err(SelectionError::WorkerUnavailable(
            "当前平台尚未提供划词接口".to_string(),
        ))
    }
}

#[cfg(any(test, target_os = "macos", target_os = "linux"))]
fn finish_platform_capture(
    text: String,
    cancelled_after_capture: bool,
) -> Result<String, SelectionError> {
    if cancelled_after_capture {
        return Err(SelectionError::Cancelled);
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        Err(SelectionError::NoSelection)
    } else {
        Ok(text)
    }
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod cross_platform_tests {
    use super::{finish_platform_capture, SelectionError};

    #[test]
    fn platform_selection_is_trimmed_and_empty_text_is_rejected() {
        assert_eq!(
            finish_platform_capture("  Michaelis–Menten  ".to_string(), false),
            Ok("Michaelis–Menten".to_string())
        );
        assert_eq!(
            finish_platform_capture(" \n\t".to_string(), false),
            Err(SelectionError::NoSelection)
        );
    }

    #[test]
    fn cancellation_after_platform_capture_discards_stale_text() {
        assert_eq!(
            finish_platform_capture("stale selection".to_string(), true),
            Err(SelectionError::Cancelled)
        );
    }
}

/// 提前启动常驻 helper，避免第一次 Ctrl+D 把进程冷启动计入 800 ms 取词预算。
pub fn prewarm_selection_helper() {
    #[cfg(target_os = "windows")]
    match selection_sidecar().prewarm() {
        Ok(()) => info!("selection-helper 已预热"),
        Err(error) => warn!("selection-helper 预热失败，将在首次取词时重试：{error}"),
    }
}

/// 主动关闭快捷翻译窗口时中断仍在执行的 UIA/剪贴板调用。
///
/// Windows UI Automation 的第三方 COM provider 不保证可协作取消；终止独立 helper
/// 可以保证下一次 Ctrl+D 不会排在旧调用之后，主程序本身不受影响。
pub fn interrupt_selection_capture() {
    #[cfg(target_os = "windows")]
    if let Some(sidecar) = SELECTION_SIDECAR.get() {
        sidecar.stop_process();
        info!("selection-helper 已中断当前取词");
    }
}

/// 主程序退出时主动终止常驻取词辅助进程。
///
/// 依赖父进程句柄自然回收会让辅助进程短暂残留，也会使下一次启动误判为已有
/// 取词服务。该操作是幂等的；未启动或已经停止时不会报错。
pub fn shutdown_selection_helper() {
    #[cfg(target_os = "windows")]
    if let Some(sidecar) = SELECTION_SIDECAR.get() {
        sidecar.stop_process();
        info!("selection-helper 已随主程序退出");
    }
}

#[cfg(target_os = "windows")]
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HelperRequest {
    request_id: u64,
    action: HelperAction,
    timeout_ms: u64,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum HelperAction {
    Capture,
    Cancel,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HelperResponse {
    request_id: u64,
    ok: bool,
    text: Option<String>,
    error_kind: Option<String>,
    message: Option<String>,
}

#[cfg(target_os = "windows")]
impl HelperResponse {
    fn from_result(request_id: u64, result: Result<String, SelectionError>) -> Self {
        match result {
            Ok(text) => Self {
                request_id,
                ok: true,
                text: Some(text),
                error_kind: None,
                message: None,
            },
            Err(error) => Self {
                request_id,
                ok: false,
                text: None,
                error_kind: Some(error.kind().to_string()),
                message: Some(error.detail()),
            },
        }
    }

    fn into_result(self) -> Result<String, SelectionError> {
        if self.ok {
            return self
                .text
                .filter(|text| !text.trim().is_empty())
                .ok_or(SelectionError::NoSelection);
        }
        Err(SelectionError::from_kind_and_message(
            self.error_kind.as_deref().unwrap_or("workerUnavailable"),
            self.message
                .unwrap_or_else(|| "helper 未返回错误详情".to_string()),
        ))
    }
}

impl SelectionError {
    #[cfg(target_os = "windows")]
    fn kind(&self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::TimedOut => "timedOut",
            Self::NoSelection => "noSelection",
            Self::WorkerUnavailable(_) => "workerUnavailable",
            Self::Automation(_) => "automation",
            Self::Clipboard(_) => "clipboard",
            Self::Input(_) => "input",
        }
    }

    #[cfg(target_os = "windows")]
    fn detail(&self) -> String {
        match self {
            Self::Cancelled => "取词请求已取消".to_string(),
            Self::TimedOut => "取词超时，请重新选择文字".to_string(),
            Self::NoSelection => "未读取到选中的文字".to_string(),
            Self::WorkerUnavailable(message)
            | Self::Automation(message)
            | Self::Clipboard(message)
            | Self::Input(message) => message.clone(),
        }
    }

    #[cfg(target_os = "windows")]
    fn from_kind_and_message(kind: &str, message: String) -> Self {
        match kind {
            "cancelled" => Self::Cancelled,
            "timedOut" => Self::TimedOut,
            "noSelection" => Self::NoSelection,
            "automation" => Self::Automation(message),
            "clipboard" => Self::Clipboard(message),
            "input" => Self::Input(message),
            _ => Self::WorkerUnavailable(message),
        }
    }
}

#[cfg(target_os = "windows")]
struct SidecarShared {
    alive: AtomicBool,
    pending: Mutex<HashMap<u64, SyncSender<HelperResponse>>>,
}

#[cfg(target_os = "windows")]
struct SidecarProcess {
    child: Child,
    stdin: ChildStdin,
    shared: Arc<SidecarShared>,
}

#[cfg(target_os = "windows")]
struct SelectionSidecar {
    process: Mutex<Option<SidecarProcess>>,
    next_request: AtomicU64,
}

#[cfg(target_os = "windows")]
static SELECTION_SIDECAR: OnceLock<SelectionSidecar> = OnceLock::new();

#[cfg(target_os = "windows")]
fn selection_sidecar() -> &'static SelectionSidecar {
    SELECTION_SIDECAR.get_or_init(|| SelectionSidecar {
        process: Mutex::new(None),
        next_request: AtomicU64::new(0),
    })
}

#[cfg(target_os = "windows")]
impl SelectionSidecar {
    fn prewarm(&self) -> Result<(), SelectionError> {
        let mut process_guard = self
            .process
            .lock()
            .map_err(|_| SelectionError::WorkerUnavailable("helper 进程锁已损坏".to_string()))?;
        ensure_sidecar_running(&mut process_guard)
    }

    fn capture<Cancelled>(&self, is_cancelled: Cancelled) -> Result<String, SelectionError>
    where
        Cancelled: Fn() -> bool,
    {
        if is_cancelled() {
            return Err(SelectionError::Cancelled);
        }
        let request_id = self.next_request.fetch_add(1, Ordering::SeqCst) + 1;
        let deadline = Instant::now() + SELECTION_TIMEOUT;
        let mut restart_attempted = false;

        loop {
            if is_cancelled() {
                return Err(SelectionError::Cancelled);
            }
            let response = match self.send_capture(request_id, deadline) {
                Ok(receiver) => {
                    self.wait_for_response(request_id, deadline, receiver, &is_cancelled)
                }
                Err(error) => Err(error),
            };

            match response {
                Err(SelectionError::WorkerUnavailable(message))
                    if !restart_attempted && Instant::now() < deadline =>
                {
                    if is_cancelled() {
                        return Err(SelectionError::Cancelled);
                    }
                    restart_attempted = true;
                    warn!("selection-helper 中断，正在自动重启：{message}");
                    self.stop_process();
                }
                result => return result,
            }
        }
    }

    fn send_capture(
        &self,
        request_id: u64,
        deadline: Instant,
    ) -> Result<mpsc::Receiver<HelperResponse>, SelectionError> {
        let mut process_guard = self
            .process
            .lock()
            .map_err(|_| SelectionError::WorkerUnavailable("helper 进程锁已损坏".to_string()))?;
        ensure_sidecar_running(&mut process_guard)?;
        let process = process_guard
            .as_mut()
            .ok_or_else(|| SelectionError::WorkerUnavailable("helper 进程未启动".to_string()))?;
        let (sender, receiver) = mpsc::sync_channel(1);
        process
            .shared
            .pending
            .lock()
            .map_err(|_| SelectionError::WorkerUnavailable("helper 请求表已损坏".to_string()))?
            .insert(request_id, sender);
        let timeout_ms = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(SELECTION_TIMEOUT.as_millis()) as u64;
        let request = HelperRequest {
            request_id,
            action: HelperAction::Capture,
            timeout_ms,
        };
        if let Err(error) = write_helper_request(&mut process.stdin, &request) {
            process.shared.alive.store(false, Ordering::Release);
            if let Ok(mut pending) = process.shared.pending.lock() {
                pending.remove(&request_id);
            }
            return Err(SelectionError::WorkerUnavailable(error));
        }
        Ok(receiver)
    }

    fn wait_for_response<Cancelled>(
        &self,
        request_id: u64,
        deadline: Instant,
        receiver: mpsc::Receiver<HelperResponse>,
        is_cancelled: &Cancelled,
    ) -> Result<String, SelectionError>
    where
        Cancelled: Fn() -> bool,
    {
        loop {
            if is_cancelled() {
                self.cancel_request(request_id);
                return Err(SelectionError::Cancelled);
            }
            let now = Instant::now();
            if now >= deadline {
                self.cancel_request(request_id);
                // helper 可能正卡在不可取消的第三方 UIA 调用；超时后终止进程，
                // 避免下一次 Ctrl+D 继续排在失去响应的 STA 后面。
                self.stop_process();
                return Err(SelectionError::TimedOut);
            }
            let wait = RESULT_POLL_INTERVAL.min(deadline.saturating_duration_since(now));
            match receiver.recv_timeout(wait) {
                Ok(response) => return response.into_result(),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(SelectionError::WorkerUnavailable(
                        "selection-helper 响应通道已断开".to_string(),
                    ));
                }
            }
        }
    }

    fn cancel_request(&self, request_id: u64) {
        let Ok(mut process_guard) = self.process.lock() else {
            return;
        };
        let Some(process) = process_guard.as_mut() else {
            return;
        };
        if let Ok(mut pending) = process.shared.pending.lock() {
            pending.remove(&request_id);
        }
        let request = HelperRequest {
            request_id,
            action: HelperAction::Cancel,
            timeout_ms: 0,
        };
        let _ = write_helper_request(&mut process.stdin, &request);
    }

    fn stop_process(&self) {
        let Ok(mut process_guard) = self.process.lock() else {
            return;
        };
        if let Some(mut process) = process_guard.take() {
            process.shared.alive.store(false, Ordering::Release);
            let _ = process.child.kill();
            let _ = process.child.wait();
        }
    }
}

#[cfg(target_os = "windows")]
fn ensure_sidecar_running(slot: &mut Option<SidecarProcess>) -> Result<(), SelectionError> {
    let should_restart = match slot.as_mut() {
        Some(process) if process.shared.alive.load(Ordering::Acquire) => process
            .child
            .try_wait()
            .map_err(|error| {
                SelectionError::WorkerUnavailable(format!("检查 helper 状态失败：{error}"))
            })?
            .is_some(),
        Some(_) => true,
        None => false,
    };
    if should_restart {
        if let Some(mut stale) = slot.take() {
            stale.shared.alive.store(false, Ordering::Release);
            let _ = stale.child.kill();
            let _ = stale.child.wait();
        }
    }
    if slot.is_some() {
        return Ok(());
    }

    let executable = resolve_helper_executable()?;
    let mut command = Command::new(&executable);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    let mut child = command.spawn().map_err(|error| {
        SelectionError::WorkerUnavailable(format!(
            "启动 selection-helper 失败（{}）：{error}",
            executable.display()
        ))
    })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| SelectionError::WorkerUnavailable("无法连接 helper 输入管道".to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| SelectionError::WorkerUnavailable("无法连接 helper 输出管道".to_string()))?;
    let shared = Arc::new(SidecarShared {
        alive: AtomicBool::new(true),
        pending: Mutex::new(HashMap::new()),
    });
    let reader_shared = Arc::clone(&shared);
    thread::Builder::new()
        .name("selection-helper-reader".to_string())
        .spawn(move || read_helper_responses(stdout, reader_shared))
        .map_err(|error| {
            SelectionError::WorkerUnavailable(format!("启动 helper 响应线程失败：{error}"))
        })?;
    info!("selection-helper 已启动：{}", executable.display());
    *slot = Some(SidecarProcess {
        child,
        stdin,
        shared,
    });
    Ok(())
}

#[cfg(target_os = "windows")]
fn write_helper_request(stdin: &mut ChildStdin, request: &HelperRequest) -> Result<(), String> {
    serde_json::to_writer(&mut *stdin, request)
        .map_err(|error| format!("序列化 helper 请求失败：{error}"))?;
    stdin
        .write_all(b"\n")
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("写入 helper 请求失败：{error}"))
}

#[cfg(target_os = "windows")]
fn read_helper_responses(stdout: impl std::io::Read, shared: Arc<SidecarShared>) {
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let response = match line {
            Ok(line) => match serde_json::from_str::<HelperResponse>(&line) {
                Ok(response) => response,
                Err(error) => {
                    warn!("selection-helper 返回无效响应：{error}");
                    break;
                }
            },
            Err(error) => {
                warn!("读取 selection-helper 响应失败：{error}");
                break;
            }
        };
        let sender = shared
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&response.request_id));
        if let Some(sender) = sender {
            let _ = sender.send(response);
        }
    }
    shared.alive.store(false, Ordering::Release);
    fail_pending_requests(&shared, "selection-helper 已退出");
}

#[cfg(target_os = "windows")]
fn fail_pending_requests(shared: &SidecarShared, message: &str) {
    let Ok(mut pending) = shared.pending.lock() else {
        return;
    };
    for (request_id, sender) in pending.drain() {
        let _ = sender.send(HelperResponse::from_result(
            request_id,
            Err(SelectionError::WorkerUnavailable(message.to_string())),
        ));
    }
}

#[cfg(target_os = "windows")]
fn resolve_helper_executable() -> Result<PathBuf, SelectionError> {
    if let Some(path) = std::env::var_os("POT_SELECTION_HELPER_PATH") {
        let path = PathBuf::from(path);
        if is_executable_file(&path) {
            return Ok(path);
        }
    }
    let executable_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));
    let mut candidates = Vec::new();
    if let Some(directory) = executable_dir {
        candidates.push(directory.join(format!("{HELPER_BUNDLE_NAME}.exe")));
        candidates.push(directory.join(format!("{HELPER_BUILD_NAME}.exe")));
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(
        manifest_dir
            .join("target")
            .join("debug")
            .join(format!("{HELPER_BUILD_NAME}.exe")),
    );
    candidates.push(
        manifest_dir
            .join("target")
            .join("release")
            .join(format!("{HELPER_BUILD_NAME}.exe")),
    );
    candidates
        .into_iter()
        .find(|path| is_executable_file(path))
        .ok_or_else(|| {
            SelectionError::WorkerUnavailable(
                "未找到 selection-helper.exe，请重新安装或执行 sidecar 构建".to_string(),
            )
        })
}

#[cfg(target_os = "windows")]
fn is_executable_file(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
struct CaptureRequest {
    id: u64,
    deadline: Instant,
    result_sender: Sender<HelperResponse>,
}

#[cfg(target_os = "windows")]
#[derive(Default)]
struct WorkerInbox {
    pending: Option<CaptureRequest>,
}

#[cfg(target_os = "windows")]
struct WorkerShared {
    inbox: Mutex<WorkerInbox>,
    wake_worker: Condvar,
    latest_request: AtomicU64,
    cancelled_through: AtomicU64,
}

#[cfg(target_os = "windows")]
/// selection-helper 的进程入口。标准输出只承载 JSON Lines 响应，禁止写入日志或选中文本。
#[allow(dead_code)]
pub fn run_selection_helper() -> Result<(), String> {
    let shared = Arc::new(WorkerShared {
        inbox: Mutex::new(WorkerInbox::default()),
        wake_worker: Condvar::new(),
        latest_request: AtomicU64::new(0),
        cancelled_through: AtomicU64::new(0),
    });
    let (response_sender, response_receiver) = mpsc::channel::<HelperResponse>();
    let worker_shared = Arc::clone(&shared);
    thread::Builder::new()
        .name("selection-helper-sta".to_string())
        .spawn(move || run_windows_worker(worker_shared))
        .map_err(|error| format!("无法启动 helper STA worker：{error}"))?;
    thread::Builder::new()
        .name("selection-helper-writer".to_string())
        .spawn(move || write_helper_responses(response_receiver))
        .map_err(|error| format!("无法启动 helper 响应线程：{error}"))?;

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| format!("读取 helper 请求失败：{error}"))?;
        let request: HelperRequest = serde_json::from_str(&line)
            .map_err(|error| format!("解析 helper 请求失败：{error}"))?;
        match request.action {
            HelperAction::Capture => {
                if !accept_worker_capture(&shared, request.request_id) {
                    let _ = response_sender.send(HelperResponse::from_result(
                        request.request_id,
                        Err(SelectionError::Cancelled),
                    ));
                    continue;
                }
                let timeout = Duration::from_millis(
                    request
                        .timeout_ms
                        .clamp(1, SELECTION_TIMEOUT.as_millis() as u64),
                );
                let capture = CaptureRequest {
                    id: request.request_id,
                    deadline: Instant::now() + timeout,
                    result_sender: response_sender.clone(),
                };
                let mut inbox = shared
                    .inbox
                    .lock()
                    .map_err(|_| "helper 请求队列已损坏".to_string())?;
                if let Some(replaced) = inbox.pending.replace(capture) {
                    let _ = replaced.result_sender.send(HelperResponse::from_result(
                        replaced.id,
                        Err(SelectionError::Cancelled),
                    ));
                }
                drop(inbox);
                shared.wake_worker.notify_one();
            }
            HelperAction::Cancel => {
                cancel_worker_capture(&shared, request.request_id);
                let mut inbox = shared
                    .inbox
                    .lock()
                    .map_err(|_| "helper 请求队列已损坏".to_string())?;
                if inbox
                    .pending
                    .as_ref()
                    .is_some_and(|pending| pending.id <= request.request_id)
                {
                    if let Some(cancelled) = inbox.pending.take() {
                        let _ = cancelled.result_sender.send(HelperResponse::from_result(
                            cancelled.id,
                            Err(SelectionError::Cancelled),
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn write_helper_responses(receiver: mpsc::Receiver<HelperResponse>) {
    let stdout = std::io::stdout();
    let mut writer = BufWriter::new(stdout.lock());
    for response in receiver {
        if serde_json::to_writer(&mut writer, &response).is_err()
            || writer.write_all(b"\n").is_err()
            || writer.flush().is_err()
        {
            break;
        }
    }
}

#[cfg(target_os = "windows")]
fn run_windows_worker(shared: Arc<WorkerShared>) {
    // 即使极少数系统无法初始化 OLE，raw Win32 剪贴板回退仍保持可用。
    let _apartment = OleApartment::initialize()
        .map_err(|error| warn!("{error}；本次会话仅使用剪贴板取词"))
        .ok();
    let mut runtime = WindowsCaptureRuntime::default();

    loop {
        let request = {
            let mut inbox = match shared.inbox.lock() {
                Ok(inbox) => inbox,
                Err(poisoned) => poisoned.into_inner(),
            };
            while inbox.pending.is_none() {
                inbox = match shared.wake_worker.wait(inbox) {
                    Ok(inbox) => inbox,
                    Err(poisoned) => poisoned.into_inner(),
                };
            }
            inbox.pending.take()
        };
        let Some(request) = request else {
            continue;
        };

        if !is_request_current(&shared, request.id) {
            let _ = request.result_sender.send(HelperResponse::from_result(
                request.id,
                Err(SelectionError::Cancelled),
            ));
            continue;
        }

        // 单次请求 panic 不得杀死常驻 worker；下一次请求会重新创建 UIA 对象。
        let result = catch_unwind(AssertUnwindSafe(|| {
            runtime.capture(&shared, request.id, request.deadline)
        }))
        .unwrap_or_else(|_| {
            runtime.reset_automation();
            Err(SelectionError::WorkerUnavailable(
                "取词任务发生内部异常，worker 已恢复".to_string(),
            ))
        });
        let _ = request
            .result_sender
            .send(HelperResponse::from_result(request.id, result));
    }
}

#[cfg(target_os = "windows")]
fn is_request_current(shared: &WorkerShared, request_id: u64) -> bool {
    shared.latest_request.load(Ordering::SeqCst) == request_id
        && shared.cancelled_through.load(Ordering::SeqCst) < request_id
}

#[cfg(target_os = "windows")]
fn accept_worker_capture(shared: &WorkerShared, request_id: u64) -> bool {
    let previous = shared
        .latest_request
        .fetch_max(request_id, Ordering::SeqCst);
    request_id > previous && request_id > shared.cancelled_through.load(Ordering::SeqCst)
}

#[cfg(target_os = "windows")]
fn cancel_worker_capture(shared: &WorkerShared, request_id: u64) {
    shared
        .cancelled_through
        .fetch_max(request_id, Ordering::SeqCst);
}

#[cfg(target_os = "windows")]
struct OleApartment;

#[cfg(target_os = "windows")]
impl OleApartment {
    fn initialize() -> Result<Self, String> {
        unsafe { OleInitialize(None) }
            .map(|_| Self)
            .map_err(|error| format!("无法初始化 STA/OLE apartment：{error}"))
    }
}

#[cfg(target_os = "windows")]
impl Drop for OleApartment {
    fn drop(&mut self) {
        unsafe { OleUninitialize() };
    }
}

#[cfg(target_os = "windows")]
#[derive(Default)]
struct WindowsCaptureRuntime {
    automation: Option<IUIAutomation>,
    clipboard_window: Option<ClipboardOwnerWindow>,
}

#[cfg(target_os = "windows")]
impl WindowsCaptureRuntime {
    fn capture(
        &mut self,
        shared: &WorkerShared,
        request_id: u64,
        deadline: Instant,
    ) -> Result<String, SelectionError> {
        if !is_request_current(shared, request_id) {
            return Err(SelectionError::Cancelled);
        }

        // 模拟复制在浏览器、PDF.js、Office 与编辑器里更稳定，而且不会被不可取消的
        // UIA COM 调用先占满总预算。只给它一段较短预算，失败后仍为 UIA 兜底留时间。
        let capture_deadline = deadline
            .checked_sub(HELPER_RESPONSE_MARGIN)
            .unwrap_or(deadline);
        let clipboard_deadline = capture_deadline.min(Instant::now() + CLIPBOARD_FAST_TIMEOUT);
        match self.capture_by_clipboard(shared, request_id, clipboard_deadline) {
            Ok(text) if !text.is_empty() && is_request_current(shared, request_id) => {
                return Ok(text)
            }
            Ok(text) if !text.is_empty() => return Err(SelectionError::Cancelled),
            Ok(_) => info!("模拟复制未返回选中文本，回退到 Windows UI Automation"),
            Err(SelectionError::Cancelled) => return Err(SelectionError::Cancelled),
            Err(error) => {
                info!("{error}，回退到 Windows UI Automation");
            }
        }

        if Instant::now() >= capture_deadline {
            return Err(SelectionError::TimedOut);
        }

        let automation_error = match self.capture_by_automation() {
            Ok(text) if !text.is_empty() && is_request_current(shared, request_id) => {
                return Ok(text)
            }
            Ok(text) if !text.is_empty() => return Err(SelectionError::Cancelled),
            Ok(_) => SelectionError::NoSelection,
            Err(error) => {
                self.reset_automation();
                error
            }
        };

        if !is_request_current(shared, request_id) {
            return Err(SelectionError::Cancelled);
        }
        if Instant::now() >= capture_deadline {
            return Err(SelectionError::TimedOut);
        }

        // UIA provider 可能合法返回 S_OK + NULL，也可能不支持 TextPattern。此时再次
        // 模拟复制通常仍能从浏览器、PDF.js 和 Office 取到文本，且不会把 0x0 伪错误
        // 暴露给用户。
        match self.capture_by_clipboard(shared, request_id, capture_deadline) {
            Ok(text) if !text.is_empty() && is_request_current(shared, request_id) => Ok(text),
            Ok(text) if !text.is_empty() => Err(SelectionError::Cancelled),
            Err(SelectionError::Cancelled) => Err(SelectionError::Cancelled),
            Err(SelectionError::TimedOut) => Err(SelectionError::TimedOut),
            Ok(_) | Err(_) => {
                info!("UI Automation 未取得选区，最终剪贴板回退也未返回文本：{automation_error}");
                Err(SelectionError::NoSelection)
            }
        }
    }

    fn capture_by_automation(&mut self) -> Result<String, SelectionError> {
        if self.automation.is_none() {
            self.automation = Some(
                unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL) }
                    .map_err(|error| map_automation_error("初始化 UIA", error))?,
            );
        }
        let automation = self
            .automation
            .as_ref()
            .ok_or_else(|| SelectionError::Automation("UIA 对象未初始化".to_string()))?;
        let element = unsafe { automation.GetFocusedElement() }
            .map_err(|error| map_automation_error("读取焦点元素", error))?;
        let pattern: IUIAutomationTextPattern =
            unsafe { element.GetCurrentPatternAs(UIA_TextPatternId) }
                .map_err(|error| map_automation_error("读取 TextPattern", error))?;
        let ranges = unsafe { pattern.GetSelection() }
            .map_err(|error| map_automation_error("读取选区", error))?;
        let length = unsafe { ranges.Length() }
            .map_err(|error| map_automation_error("读取选区数量", error))?;
        let mut selected_text = String::new();
        for index in 0..length {
            let range = unsafe { ranges.GetElement(index) }
                .map_err(|error| map_automation_error("读取选区范围", error))?;
            let text = unsafe { range.GetText(-1) }
                .map_err(|error| map_automation_error("读取选区文本", error))?;
            selected_text.push_str(&text.to_string());
        }
        Ok(selected_text.trim().to_string())
    }

    fn reset_automation(&mut self) {
        self.automation = None;
    }

    fn capture_by_clipboard(
        &mut self,
        shared: &WorkerShared,
        request_id: u64,
        deadline: Instant,
    ) -> Result<String, SelectionError> {
        let clipboard_owner = self.clipboard_owner()?;
        // 保存旧剪贴板只能占用很短的固定预算。大型 DIB、短暂占用或只有私有格式时，
        // 仍继续模拟复制，避免“保护剪贴板”反过来让外部划词完全失效。
        let snapshot_deadline = deadline.min(Instant::now() + CLIPBOARD_SNAPSHOT_TIMEOUT);
        let snapshot = match ClipboardSnapshot::capture(snapshot_deadline, clipboard_owner) {
            Ok(snapshot) => Some(snapshot),
            Err(error) => {
                info!("暂存原标准格式剪贴板失败，本次将优先完成取词且不恢复：{error}");
                None
            }
        };
        let initial_sequence = unsafe { GetClipboardSequenceNumber() };
        send_copy_shortcut()?;

        let text = wait_for_clipboard_text(
            initial_sequence,
            || unsafe { GetClipboardSequenceNumber() },
            || match read_unicode_text(deadline, clipboard_owner) {
                Ok(text) => text,
                Err(error) => {
                    info!("等待复制结果时暂时无法读取剪贴板：{error}");
                    None
                }
            },
            || {
                if let Err(error) = send_copy_shortcut() {
                    warn!("重试发送 Ctrl+C 失败：{error}");
                }
            },
            || !is_request_current(shared, request_id) || Instant::now() >= deadline,
            thread::sleep,
        );

        if let Some(snapshot) = snapshot {
            // 所有格式都已复制进本进程 Vec；恢复阶段不会引用来源应用对象。
            let restore_deadline = Instant::now() + CLIPBOARD_RESTORE_TIMEOUT;
            if let Err(error) = snapshot.restore(restore_deadline, clipboard_owner) {
                warn!("恢复原标准格式剪贴板失败：{error}");
            }
        }

        match text {
            Some(_) if !is_request_current(shared, request_id) => Err(SelectionError::Cancelled),
            Some(text) => Ok(text),
            None if !is_request_current(shared, request_id) => Err(SelectionError::Cancelled),
            None if Instant::now() >= deadline => Err(SelectionError::TimedOut),
            None => Err(SelectionError::NoSelection),
        }
    }

    fn clipboard_owner(&mut self) -> Result<HWND, SelectionError> {
        if self.clipboard_window.is_none() {
            self.clipboard_window = Some(ClipboardOwnerWindow::create()?);
        }
        self.clipboard_window
            .as_ref()
            .map(|window| window.0)
            .ok_or_else(|| SelectionError::Clipboard("helper 剪贴板窗口未创建".to_string()))
    }
}

#[cfg(target_os = "windows")]
fn map_automation_error(stage: &str, error: windows::core::Error) -> SelectionError {
    // windows-rs 将 COM 的 S_OK + NULL 接口包装为 Error::empty()。这代表当前元素
    // 没有可用 TextPattern/选区，不是真正的系统错误，更不能展示成“操作成功完成”。
    if error.code().0 == 0 {
        SelectionError::NoSelection
    } else {
        SelectionError::Automation(format!("{stage}：{error}"))
    }
}

#[cfg(target_os = "windows")]
struct ClipboardOwnerWindow(HWND);

#[cfg(target_os = "windows")]
impl ClipboardOwnerWindow {
    fn create() -> Result<Self, SelectionError> {
        let window = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                windows::core::w!("STATIC"),
                windows::core::w!("PotSelectionHelperClipboard"),
                WINDOW_STYLE::default(),
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                None,
                None,
                None,
            )
        }
        .map_err(|error| {
            SelectionError::Clipboard(format!("创建 helper 剪贴板宿主窗口失败：{error}"))
        })?;
        Ok(Self(window))
    }
}

#[cfg(target_os = "windows")]
impl Drop for ClipboardOwnerWindow {
    fn drop(&mut self) {
        if let Err(error) = unsafe { DestroyWindow(self.0) } {
            warn!("销毁 helper 剪贴板窗口失败：{error}");
        }
    }
}

#[cfg(target_os = "windows")]
#[derive(Debug)]
struct ClipboardFormatSnapshot {
    format: u32,
    name: &'static str,
    bytes: Vec<u8>,
}

#[cfg(target_os = "windows")]
#[derive(Debug)]
struct ClipboardSnapshot {
    formats: Vec<ClipboardFormatSnapshot>,
    was_empty: bool,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ClipboardFormatSpec {
    format: u32,
    name: &'static str,
}

#[cfg(target_os = "windows")]
fn standard_clipboard_formats() -> Result<Vec<ClipboardFormatSpec>, SelectionError> {
    let html = unsafe { RegisterClipboardFormatW(windows::core::w!("HTML Format")) };
    let rtf = unsafe { RegisterClipboardFormatW(windows::core::w!("Rich Text Format")) };
    if html == 0 || rtf == 0 {
        return Err(SelectionError::Clipboard(
            "注册 HTML/RTF 剪贴板格式失败".to_string(),
        ));
    }
    Ok(vec![
        ClipboardFormatSpec {
            format: CF_UNICODETEXT,
            name: "CF_UNICODETEXT",
        },
        ClipboardFormatSpec {
            format: html,
            name: "HTML Format",
        },
        ClipboardFormatSpec {
            format: rtf,
            name: "Rich Text Format",
        },
        ClipboardFormatSpec {
            format: CF_DIB,
            name: "CF_DIB",
        },
        ClipboardFormatSpec {
            format: CF_DIBV5,
            name: "CF_DIBV5",
        },
        ClipboardFormatSpec {
            format: CF_HDROP,
            name: "CF_HDROP",
        },
    ])
}

#[cfg(target_os = "windows")]
impl ClipboardSnapshot {
    fn capture(deadline: Instant, owner: HWND) -> Result<Self, SelectionError> {
        let specs = standard_clipboard_formats()?;
        let _clipboard = ClipboardOpenGuard::open(deadline, owner)?;
        unsafe { SetLastError(WIN32_ERROR(0)) };
        let format_count = unsafe { CountClipboardFormats() };
        if format_count == 0 && unsafe { GetLastError() } != WIN32_ERROR(0) {
            return Err(SelectionError::Clipboard(
                "读取剪贴板格式数量失败".to_string(),
            ));
        }
        let mut formats = Vec::with_capacity(specs.len());
        let mut total_bytes = 0usize;
        for spec in specs {
            if Instant::now() >= deadline {
                return Err(SelectionError::TimedOut);
            }
            if unsafe { IsClipboardFormatAvailable(spec.format) }.is_err() {
                continue;
            }
            let bytes = copy_open_clipboard_format(spec)?;
            total_bytes = total_bytes
                .checked_add(bytes.len())
                .ok_or_else(|| SelectionError::Clipboard("剪贴板格式大小溢出".to_string()))?;
            if total_bytes > MAX_STANDARD_FORMAT_BYTES {
                return Err(SelectionError::Clipboard(format!(
                    "标准剪贴板数据超过 {} MiB 安全上限",
                    MAX_STANDARD_FORMAT_BYTES / 1024 / 1024
                )));
            }
            formats.push(ClipboardFormatSnapshot {
                format: spec.format,
                name: spec.name,
                bytes,
            });
        }
        Ok(Self {
            formats,
            was_empty: format_count == 0,
        })
    }

    fn restore(&self, deadline: Instant, owner: HWND) -> Result<(), SelectionError> {
        if !self.should_restore() {
            // 原剪贴板只有未列入白名单的私有格式，禁止伪造或持有第三方句柄。
            return Ok(());
        }
        let mut allocations = Vec::with_capacity(self.formats.len());
        for format in &self.formats {
            allocations.push((
                format.format,
                format.name,
                OwnedGlobalMemory::from_bytes(&format.bytes, format.name)?,
            ));
        }

        let _clipboard = ClipboardOpenGuard::open(deadline, owner)?;
        unsafe { EmptyClipboard() }
            .map_err(|error| SelectionError::Clipboard(error.to_string()))?;
        for (format, name, mut memory) in allocations {
            unsafe { SetClipboardData(format, HANDLE(memory.handle().0)) }
                .map_err(|error| SelectionError::Clipboard(format!("恢复 {name} 失败：{error}")))?;
            memory.transfer_to_system();
        }
        Ok(())
    }

    fn should_restore(&self) -> bool {
        self.was_empty || !self.formats.is_empty()
    }
}

#[cfg(target_os = "windows")]
fn copy_open_clipboard_format(spec: ClipboardFormatSpec) -> Result<Vec<u8>, SelectionError> {
    let handle = unsafe { GetClipboardData(spec.format) }.map_err(|error| {
        SelectionError::Clipboard(format!("读取 {} 句柄失败：{error}", spec.name))
    })?;
    let global = HGLOBAL(handle.0);
    let size = unsafe { GlobalSize(global) };
    if size == 0 {
        return Err(SelectionError::Clipboard(format!(
            "读取 {} 大小失败",
            spec.name
        )));
    }
    if size > MAX_STANDARD_FORMAT_BYTES {
        return Err(SelectionError::Clipboard(format!(
            "{} 超过安全大小上限",
            spec.name
        )));
    }
    let pointer = unsafe { GlobalLock(global) } as *const u8;
    if pointer.is_null() {
        return Err(SelectionError::Clipboard(format!(
            "GlobalLock({}) 失败",
            spec.name
        )));
    }
    let bytes = unsafe { std::slice::from_raw_parts(pointer, size) }.to_vec();
    let _ = unsafe { GlobalUnlock(global) };
    Ok(bytes)
}

#[cfg(target_os = "windows")]
struct OwnedGlobalMemory(Option<HGLOBAL>);

#[cfg(target_os = "windows")]
impl OwnedGlobalMemory {
    fn from_bytes(bytes: &[u8], name: &str) -> Result<Self, SelectionError> {
        if bytes.is_empty() {
            return Err(SelectionError::Clipboard(format!(
                "{name} 不允许恢复为空内存块"
            )));
        }
        let global = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) };
        if global.0.is_null() {
            return Err(SelectionError::Clipboard(format!(
                "GlobalAlloc({name}) 失败"
            )));
        }
        let pointer = unsafe { GlobalLock(global) } as *mut u8;
        if pointer.is_null() {
            let _ = unsafe { GlobalFree(global) };
            return Err(SelectionError::Clipboard(format!(
                "GlobalLock({name}) 失败"
            )));
        }
        unsafe { ptr::copy_nonoverlapping(bytes.as_ptr(), pointer, bytes.len()) };
        let _ = unsafe { GlobalUnlock(global) };
        Ok(Self(Some(global)))
    }

    fn handle(&self) -> HGLOBAL {
        self.0.unwrap_or_default()
    }

    fn transfer_to_system(&mut self) {
        self.0 = None;
    }
}

#[cfg(target_os = "windows")]
impl Drop for OwnedGlobalMemory {
    fn drop(&mut self) {
        if let Some(global) = self.0.take() {
            let _ = unsafe { GlobalFree(global) };
        }
    }
}

#[cfg(target_os = "windows")]
struct ClipboardOpenGuard;

#[cfg(target_os = "windows")]
impl ClipboardOpenGuard {
    fn open(deadline: Instant, owner: HWND) -> Result<Self, SelectionError> {
        let mut last_error = None;
        for delay in OPEN_CLIPBOARD_RETRY_DELAYS {
            match unsafe { OpenClipboard(owner) } {
                Ok(()) => return Ok(Self),
                Err(error) => last_error = Some(error),
            }
            if Instant::now() >= deadline {
                break;
            }
            thread::sleep(delay.min(deadline.saturating_duration_since(Instant::now())));
        }
        Err(SelectionError::Clipboard(format!(
            "OpenClipboard 有界重试后仍失败：{}",
            last_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "未知错误".to_string())
        )))
    }
}

#[cfg(target_os = "windows")]
impl Drop for ClipboardOpenGuard {
    fn drop(&mut self) {
        if let Err(error) = unsafe { CloseClipboard() } {
            warn!("关闭剪贴板失败：{error}");
        }
    }
}

#[cfg(target_os = "windows")]
fn read_unicode_text(deadline: Instant, owner: HWND) -> Result<Option<String>, SelectionError> {
    let _clipboard = ClipboardOpenGuard::open(deadline, owner)?;
    if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT) }.is_err() {
        return Ok(None);
    }
    let bytes = copy_open_clipboard_format(ClipboardFormatSpec {
        format: CF_UNICODETEXT,
        name: "CF_UNICODETEXT",
    })?;
    let utf16: Vec<u16> = bytes
        .chunks_exact(std::mem::size_of::<u16>())
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    let length = utf16
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(utf16.len());
    let text = String::from_utf16_lossy(&utf16[..length]);
    Ok(Some(text))
}

#[cfg(target_os = "windows")]
fn send_copy_shortcut() -> Result<(), SelectionError> {
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|error| SelectionError::Input(error.to_string()))?;
    // 释放可能仍处于按下状态的热键，避免 Ctrl+D 与 Ctrl+C 粘连。
    for key in [
        Key::Control,
        Key::Alt,
        Key::Shift,
        Key::Space,
        Key::Meta,
        Key::Tab,
        Key::Escape,
        Key::CapsLock,
        Key::C,
        Key::D,
    ] {
        enigo
            .key(key, Release)
            .map_err(|error| SelectionError::Input(error.to_string()))?;
    }
    enigo
        .key(Key::Control, Press)
        .map_err(|error| SelectionError::Input(error.to_string()))?;
    enigo
        .key(Key::C, Click)
        .map_err(|error| SelectionError::Input(error.to_string()))?;
    enigo
        .key(Key::Control, Release)
        .map_err(|error| SelectionError::Input(error.to_string()))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn wait_for_clipboard_text<Sequence, ReadText, RetryCopy, Cancelled, Sleep>(
    initial_sequence: u32,
    mut sequence: Sequence,
    mut read_text: ReadText,
    mut retry_copy: RetryCopy,
    is_cancelled: Cancelled,
    mut sleep: Sleep,
) -> Option<String>
where
    Sequence: FnMut() -> u32,
    ReadText: FnMut() -> Option<String>,
    RetryCopy: FnMut(),
    Cancelled: Fn() -> bool,
    Sleep: FnMut(Duration),
{
    let mut retried = false;
    for poll in 0..CLIPBOARD_POLL_LIMIT {
        if is_cancelled() {
            return None;
        }
        if sequence() != initial_sequence {
            if let Some(text) = read_text() {
                let text = text.trim();
                if !text.is_empty() {
                    return Some(text.to_string());
                }
            }
        }
        if poll == COPY_RETRY_POLL && !retried {
            retry_copy();
            retried = true;
        }
        if poll + 1 < CLIPBOARD_POLL_LIMIT {
            sleep(CLIPBOARD_POLL_INTERVAL);
        }
    }
    None
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
extern "system" {
    fn GlobalAlloc(flags: u32, bytes: usize) -> HGLOBAL;
    fn GlobalFree(memory: HGLOBAL) -> HGLOBAL;
    fn GlobalLock(memory: HGLOBAL) -> *mut c_void;
    fn GlobalUnlock(memory: HGLOBAL) -> i32;
    fn GlobalSize(memory: HGLOBAL) -> usize;
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::{
        accept_worker_capture, cancel_worker_capture, ensure_sidecar_running,
        fail_pending_requests, is_request_current, map_automation_error,
        standard_clipboard_formats, wait_for_clipboard_text, CaptureRequest,
        ClipboardFormatSnapshot, HelperAction, HelperRequest, HelperResponse, OwnedGlobalMemory,
        SelectionError, SidecarShared, WorkerInbox, WorkerShared, CF_DIB, CF_DIBV5, CF_HDROP,
        CF_UNICODETEXT, CLIPBOARD_POLL_INTERVAL, CLIPBOARD_POLL_LIMIT,
    };
    use std::{
        cell::Cell,
        collections::HashMap,
        sync::{
            atomic::{AtomicBool, AtomicU64},
            mpsc, Condvar, Mutex,
        },
        time::{Duration, Instant},
    };

    fn worker_shared() -> WorkerShared {
        WorkerShared {
            inbox: Mutex::new(WorkerInbox::default()),
            wake_worker: Condvar::new(),
            latest_request: AtomicU64::new(0),
            cancelled_through: AtomicU64::new(0),
        }
    }

    #[test]
    fn stale_capture_or_cancel_cannot_replace_the_latest_request() {
        let shared = worker_shared();
        assert!(accept_worker_capture(&shared, 2));
        assert!(!accept_worker_capture(&shared, 1));
        cancel_worker_capture(&shared, 1);
        assert!(is_request_current(&shared, 2));
        cancel_worker_capture(&shared, 2);
        assert!(!is_request_current(&shared, 2));
        assert!(accept_worker_capture(&shared, 3));
        assert!(is_request_current(&shared, 3));
    }

    #[test]
    fn successful_null_uia_interface_is_treated_as_no_selection() {
        let error = windows::core::Error::empty();
        assert_eq!(
            map_automation_error("读取选区", error),
            SelectionError::NoSelection
        );
    }

    #[test]
    fn ipc_protocol_preserves_request_id_and_unicode() {
        let request = HelperRequest {
            request_id: 73,
            action: HelperAction::Capture,
            timeout_ms: 800,
        };
        let request_json = serde_json::to_string(&request).unwrap();
        assert!(request_json.contains("\"requestId\":73"));
        assert!(request_json.contains("\"action\":\"capture\""));

        let response = HelperResponse::from_result(
            request.request_id,
            Ok("Michaelis–Menten 与 β-氧化".to_string()),
        );
        let response_json = serde_json::to_string(&response).unwrap();
        let decoded: HelperResponse = serde_json::from_str(&response_json).unwrap();
        assert_eq!(decoded.request_id, 73);
        assert_eq!(decoded.into_result().unwrap(), "Michaelis–Menten 与 β-氧化");
    }

    #[test]
    fn helper_disconnect_releases_every_waiting_request() {
        let shared = SidecarShared {
            alive: AtomicBool::new(true),
            pending: Mutex::new(HashMap::new()),
        };
        let (sender, receiver) = mpsc::sync_channel(1);
        shared.pending.lock().unwrap().insert(91, sender);
        fail_pending_requests(&shared, "helper 测试退出");
        assert_eq!(
            receiver.recv().unwrap().into_result(),
            Err(SelectionError::WorkerUnavailable(
                "helper 测试退出".to_string()
            ))
        );
        assert!(shared.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn stopped_helper_is_restarted_without_affecting_main_process() {
        // 独立 helper crate 会复用本模块测试；只有主包 build script 保证打包路径已生成。
        if env!("CARGO_PKG_NAME") != "pot" {
            return;
        }
        let mut slot = None;
        ensure_sidecar_running(&mut slot).unwrap();
        let first_pid = slot.as_ref().unwrap().child.id();
        {
            let process = slot.as_mut().unwrap();
            process.child.kill().unwrap();
            process.child.wait().unwrap();
        }
        ensure_sidecar_running(&mut slot).unwrap();
        let second_pid = slot.as_ref().unwrap().child.id();
        assert_ne!(first_pid, second_pid);
        if let Some(mut process) = slot {
            let _ = process.child.kill();
            let _ = process.child.wait();
        }
    }

    #[test]
    fn delayed_clipboard_preserves_unicode_text() {
        let poll_count = Cell::new(0);
        let text = wait_for_clipboard_text(
            7,
            || {
                let current = poll_count.get();
                poll_count.set(current + 1);
                if current >= 3 {
                    8
                } else {
                    7
                }
            },
            || Some("Michaelis–Menten".to_string()),
            || {},
            || false,
            |_| {},
        );
        assert_eq!(text.as_deref(), Some("Michaelis–Menten"));
    }

    #[test]
    fn retries_copy_once_after_unchanged_clipboard() {
        let retry_count = Cell::new(0);
        let text = wait_for_clipboard_text(
            11,
            || if retry_count.get() == 0 { 11 } else { 12 },
            || Some("Michaelis–Menten".to_string()),
            || retry_count.set(retry_count.get() + 1),
            || false,
            |_| {},
        );
        assert_eq!(text.as_deref(), Some("Michaelis–Menten"));
        assert_eq!(retry_count.get(), 1);
    }

    #[test]
    fn retries_when_clipboard_changed_without_unicode_text() {
        let retry_count = Cell::new(0);
        let text = wait_for_clipboard_text(
            21,
            || 22,
            || (retry_count.get() > 0).then(|| "Michaelis–Menten".to_string()),
            || retry_count.set(retry_count.get() + 1),
            || false,
            |_| {},
        );
        assert_eq!(text.as_deref(), Some("Michaelis–Menten"));
        assert_eq!(retry_count.get(), 1);
    }

    #[test]
    fn capture_budget_is_about_eight_hundred_milliseconds() {
        let elapsed = Cell::new(Duration::ZERO);
        let text = wait_for_clipboard_text(
            31,
            || 31,
            || panic!("序列号未改变时不得读取旧剪贴板文本"),
            || {},
            || false,
            |duration| elapsed.set(elapsed.get() + duration),
        );
        assert_eq!(text, None);
        assert_eq!(
            elapsed.get(),
            CLIPBOARD_POLL_INTERVAL * (CLIPBOARD_POLL_LIMIT - 1) as u32
        );
    }

    #[test]
    fn cancellation_stops_without_retry_or_sleep() {
        let retry_count = Cell::new(0);
        let sleep_count = Cell::new(0);
        let text = wait_for_clipboard_text(
            41,
            || 41,
            || panic!("取消后不得读取剪贴板"),
            || retry_count.set(retry_count.get() + 1),
            || true,
            |_| sleep_count.set(sleep_count.get() + 1),
        );
        assert_eq!(text, None);
        assert_eq!(retry_count.get(), 0);
        assert_eq!(sleep_count.get(), 0);
    }

    #[test]
    fn latest_pending_request_cancels_the_replaced_one() {
        let (old_sender, old_receiver) = mpsc::channel();
        let (new_sender, _new_receiver) = mpsc::channel();
        let mut inbox = WorkerInbox {
            pending: Some(CaptureRequest {
                id: 1,
                deadline: Instant::now(),
                result_sender: old_sender,
            }),
        };
        if let Some(replaced) = inbox.pending.replace(CaptureRequest {
            id: 2,
            deadline: Instant::now(),
            result_sender: new_sender,
        }) {
            let _ = replaced.result_sender.send(HelperResponse::from_result(
                replaced.id,
                Err(SelectionError::Cancelled),
            ));
        }
        assert_eq!(
            old_receiver.recv().unwrap().into_result(),
            Err(SelectionError::Cancelled)
        );
        assert_eq!(inbox.pending.as_ref().map(|request| request.id), Some(2));
    }

    #[test]
    fn standard_snapshot_whitelist_contains_text_rich_content_images_and_files() {
        let formats = standard_clipboard_formats().unwrap();
        let ids: Vec<u32> = formats.iter().map(|format| format.format).collect();
        let names: Vec<&str> = formats.iter().map(|format| format.name).collect();
        assert!(ids.contains(&CF_UNICODETEXT));
        assert!(ids.contains(&CF_DIB));
        assert!(ids.contains(&CF_DIBV5));
        assert!(ids.contains(&CF_HDROP));
        assert!(names.contains(&"HTML Format"));
        assert!(names.contains(&"Rich Text Format"));
        assert!(ids.iter().all(|format| *format != 0));
    }

    #[test]
    fn clipboard_format_snapshot_owns_its_bytes() {
        let mut source = vec![1, 2, 3, 4];
        let snapshot = ClipboardFormatSnapshot {
            format: CF_DIB,
            name: "CF_DIB",
            bytes: source.clone(),
        };
        source.fill(9);
        assert_eq!(snapshot.bytes, vec![1, 2, 3, 4]);
    }

    #[test]
    fn private_only_clipboard_does_not_block_capture_or_fake_a_restore() {
        let snapshot = super::ClipboardSnapshot {
            formats: Vec::new(),
            was_empty: false,
        };
        assert!(!snapshot.should_restore());

        let empty_clipboard = super::ClipboardSnapshot {
            formats: Vec::new(),
            was_empty: true,
        };
        assert!(empty_clipboard.should_restore());
    }

    #[test]
    fn global_memory_copy_is_independent_from_source_buffer() {
        let mut source = vec![10, 20, 30, 40];
        let memory = OwnedGlobalMemory::from_bytes(&source, "test").unwrap();
        source.fill(0);
        let pointer = unsafe { super::GlobalLock(memory.handle()) } as *const u8;
        assert!(!pointer.is_null());
        let restored = unsafe { std::slice::from_raw_parts(pointer, 4) }.to_vec();
        let _ = unsafe { super::GlobalUnlock(memory.handle()) };
        assert_eq!(restored, vec![10, 20, 30, 40]);
    }
}
