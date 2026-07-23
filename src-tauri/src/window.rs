//! 窗口与快捷翻译状态机。
//!
//! Ctrl+D 会先显示已经预热的窗口，再异步取词。窗口尚未完成 React 挂载时，
//! 这里只缓存最后一次事件，`translate_window_ready` 握手后再派发。

use crate::config::get;
use crate::selected_text::{
    capture_selected_text, interrupt_selection_capture, prewarm_selection_helper,
};
use crate::{StringWrapper, APP};
use log::{info, warn};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::webview::PageLoadEvent;
use tauri::{Emitter, Listener, Manager, Monitor, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

static SELECTION_REQUEST_GENERATION: AtomicU64 = AtomicU64::new(0);
static SELECTION_CAPTURE_ACTIVE: AtomicU64 = AtomicU64::new(0);
static SCREENSHOT_REQUEST_GENERATION: AtomicU64 = AtomicU64::new(0);
static TRANSLATE_WINDOW_READY: AtomicBool = AtomicBool::new(false);
static SCREENSHOT_WINDOW_TRANSACTION: Lazy<tokio::sync::Mutex<()>> =
    Lazy::new(|| tokio::sync::Mutex::new(()));
static TRANSLATE_WINDOW_LOADING_SINCE: Lazy<Mutex<Option<Instant>>> =
    Lazy::new(|| Mutex::new(None));
static TRANSLATE_WINDOW_TRANSACTION: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static TRANSLATE_PRESENTATION_TRANSACTION: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
// 与取词代次分离：该 ID 只描述当前真正提交到浮窗的展示会话。
// 新一轮 Ctrl+D 可以先开始取词，但在它完成 dispatch + show 前，眼前的旧会话仍必须可关闭。
static TRANSLATE_PRESENTED_REQUEST_ID: AtomicU64 = AtomicU64::new(0);
static PENDING_TRANSLATE_EVENT: Lazy<Mutex<Option<PendingTranslateEvent>>> =
    Lazy::new(|| Mutex::new(None));

const TRANSLATE_WINDOW_READY_TIMEOUT: Duration = Duration::from_millis(1_000);
const TRANSLATE_WINDOW_RECOVERY_DELAY: Duration = Duration::from_millis(1_100);
const TRANSLATE_WINDOW_WIDTH: f64 = 420.0;
const TRANSLATE_WINDOW_HEIGHT: f64 = 360.0;
const TRANSLATE_WINDOW_MIN_WIDTH: f64 = 360.0;
const TRANSLATE_WINDOW_MIN_HEIGHT: f64 = 300.0;
const TRANSLATE_WINDOW_CURSOR_GAP: i32 = 14;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TranslateWorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingTranslateEvent {
    request_id: u64,
    text: Option<String>,
    state: String,
    message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectionStatePayload {
    request_id: u64,
    state: String,
    message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectionTextPayload {
    request_id: u64,
    text: String,
}

fn app_handle() -> Option<tauri::AppHandle> {
    APP.get().cloned()
}

fn get_daemon_window() -> Option<WebviewWindow> {
    let app = app_handle()?;
    if let Some(window) = app.get_webview_window("daemon") {
        return Some(window);
    }
    WebviewWindowBuilder::new(&app, "daemon", WebviewUrl::App("daemon.html".into()))
        .title("小允翻译")
        .visible(false)
        .build()
        .map_err(|error| warn!("创建 daemon 窗口失败：{error}"))
        .ok()
}

fn current_monitor(x: i32, y: i32) -> Option<Monitor> {
    let daemon = get_daemon_window()?;
    if let Ok(monitors) = daemon.available_monitors() {
        for monitor in monitors {
            let position = monitor.position();
            let size = monitor.size();
            if x >= position.x
                && x < position.x + size.width as i32
                && y >= position.y
                && y < position.y + size.height as i32
            {
                return Some(monitor);
            }
        }
    }
    daemon.primary_monitor().ok().flatten()
}

fn mouse_position() -> (i32, i32) {
    use mouse_position::mouse_position::{Mouse, Position};
    match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => (x, y),
        Mouse::Error => {
            warn!("无法读取鼠标位置，使用主显示器原点");
            let Position { x, y } = Position { x: 0, y: 0 };
            (x, y)
        }
    }
}

fn mark_translate_window_loading() {
    TRANSLATE_WINDOW_READY.store(false, Ordering::Release);
    let mut loading_since = TRANSLATE_WINDOW_LOADING_SINCE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *loading_since = Some(Instant::now());
}

fn translate_window_should_rebuild(ready: bool, loading_elapsed: Option<Duration>) -> bool {
    !ready
        && loading_elapsed
            .map(|elapsed| elapsed >= TRANSLATE_WINDOW_READY_TIMEOUT)
            .unwrap_or(true)
}

fn stalled_translate_window() -> bool {
    let ready = TRANSLATE_WINDOW_READY.load(Ordering::Acquire);
    let loading_elapsed = TRANSLATE_WINDOW_LOADING_SINCE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .map(Instant::elapsed);
    translate_window_should_rebuild(ready, loading_elapsed)
}

fn schedule_translate_window_recovery(generation: u64) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(TRANSLATE_WINDOW_RECOVERY_DELAY).await;
        if SELECTION_REQUEST_GENERATION.load(Ordering::SeqCst) != generation
            || !translate_request_is_presented(generation)
            || TRANSLATE_WINDOW_READY.load(Ordering::Acquire)
            || !stalled_translate_window()
        {
            return;
        }

        // 最终校验与 show 必须和主动关闭串行，否则恢复线程可能在 X 已经隐藏窗口后
        // 又把同一轮旧会话重新显示出来。
        let _presentation = TRANSLATE_PRESENTATION_TRANSACTION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !selection_request_is_current(generation)
            || !translate_request_is_presented(generation)
            || TRANSLATE_WINDOW_READY.load(Ordering::Acquire)
            || !stalled_translate_window()
        {
            return;
        }

        warn!("快捷翻译 WebView 超过 1 秒未 ready，正在重建并重放最新请求");
        match translate_window() {
            Ok(window)
                if selection_request_is_current(generation)
                    && translate_request_is_presented(generation) =>
            {
                show_without_activating(&window);
            }
            Ok(_) => {}
            Err(error) => warn!("恢复快捷翻译 WebView 失败：{error}"),
        }
    });
}

fn translate_window() -> Result<WebviewWindow, String> {
    // 快速连按可能让两个全局快捷键回调同时进入窗口创建路径。串行化 label 的销毁、
    // 创建和几何恢复，避免第二次触发撞上半销毁的 WebView 而静默丢失。
    let _transaction = TRANSLATE_WINDOW_TRANSACTION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let app = app_handle().ok_or_else(|| "应用尚未初始化".to_string())?;
    if let Some(window) = app.get_webview_window("translate") {
        if stalled_translate_window() {
            warn!("快捷翻译 WebView 在 1 秒内未完成 ready 握手，正在重建");
            window
                .destroy()
                .map_err(|error| format!("重建快捷翻译窗口失败：{error}"))?;
        } else {
            let (mouse_x, mouse_y) = mouse_position();
            normalize_translate_window(&window);
            position_translate_window(&window, mouse_x, mouse_y);
            return Ok(window);
        }
    }

    mark_translate_window_loading();
    let (mouse_x, mouse_y) = mouse_position();
    let monitor = current_monitor(mouse_x, mouse_y);
    let monitor_position = monitor.as_ref().map(Monitor::position);
    let mut builder =
        WebviewWindowBuilder::new(&app, "translate", WebviewUrl::App("index.html".into()))
            .title("小允翻译")
            .visible(false)
            .focused(false)
            .inner_size(TRANSLATE_WINDOW_WIDTH, TRANSLATE_WINDOW_HEIGHT)
            .min_inner_size(TRANSLATE_WINDOW_MIN_WIDTH, TRANSLATE_WINDOW_MIN_HEIGHT)
            .maximizable(false)
            .decorations(false)
            .transparent(true)
            .skip_taskbar(true)
            .on_page_load(|_window, payload| {
                if matches!(payload.event(), PageLoadEvent::Started) {
                    // WebView 刷新或 renderer 恢复后，旧监听器已经失效；必须重新握手。
                    mark_translate_window_loading();
                    info!("快捷翻译 WebView 开始加载，等待 ready 握手");
                }
            });
    if let Some(position) = monitor_position {
        builder = builder.position(position.x as f64, position.y as f64);
    }
    let window = builder.build().map_err(|error| error.to_string())?;
    normalize_translate_window(&window);
    position_translate_window(&window, mouse_x, mouse_y);
    Ok(window)
}

fn normalize_translate_window(window: &WebviewWindow) {
    // 这里只调整几何尺寸，不执行可能隐式 ShowWindow 的恢复操作。最大化/最小化恢复
    // 统一放在持有展示事务锁的 show/activate helper 中，避免关闭后被准备阶段重新显示。
    let _ = window.set_size(tauri::LogicalSize::new(
        TRANSLATE_WINDOW_WIDTH,
        TRANSLATE_WINDOW_HEIGHT,
    ));
}

fn calculate_translate_window_position(
    position_mode: &str,
    mouse_x: i32,
    mouse_y: i32,
    window_width: u32,
    window_height: u32,
    work_area: TranslateWorkArea,
) -> (i32, i32) {
    let available_width = work_area.width as i32 - window_width as i32;
    let available_height = work_area.height as i32 - window_height as i32;
    let max_x = work_area.x + available_width.max(0);
    let max_y = work_area.y + available_height.max(0);
    match position_mode {
        "center" => (
            work_area.x + available_width.max(0) / 2,
            work_area.y + available_height.max(0) / 2,
        ),
        "top-right" => (
            (max_x - 24).max(work_area.x),
            (work_area.y + 24).clamp(work_area.y, max_y),
        ),
        _ => {
            // 优先放在指针右下方；空间不足时翻到左侧或上方，并始终限制在工作区内。
            // 留出间距可避免窗口正好压在用户刚刚划选的文字和鼠标上。
            let right = mouse_x.saturating_add(TRANSLATE_WINDOW_CURSOR_GAP);
            let below = mouse_y.saturating_add(TRANSLATE_WINDOW_CURSOR_GAP);
            let left = mouse_x
                .saturating_sub(window_width as i32)
                .saturating_sub(TRANSLATE_WINDOW_CURSOR_GAP);
            let above = mouse_y
                .saturating_sub(window_height as i32)
                .saturating_sub(TRANSLATE_WINDOW_CURSOR_GAP);
            let x = if right <= max_x { right } else { left };
            let y = if below <= max_y { below } else { above };
            (x.clamp(work_area.x, max_x), y.clamp(work_area.y, max_y))
        }
    }
}

fn position_translate_window(window: &WebviewWindow, mouse_x: i32, mouse_y: i32) {
    let position_mode = get("settings_v2")
        .and_then(|value| {
            value
                .get("window")
                .and_then(|window| window.get("translatePosition"))
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "mouse".to_string());
    if position_mode == "pre_state" {
        return;
    }
    let Ok(size) = window.outer_size() else {
        return;
    };
    let Some(monitor) = current_monitor(mouse_x, mouse_y) else {
        return;
    };
    let native_work_area = monitor.work_area();
    let work_area = TranslateWorkArea {
        x: native_work_area.position.x,
        y: native_work_area.position.y,
        width: native_work_area.size.width,
        height: native_work_area.size.height,
    };
    let (x, y) = calculate_translate_window_position(
        &position_mode,
        mouse_x,
        mouse_y,
        size.width,
        size.height,
        work_area,
    );
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

#[cfg(target_os = "windows")]
fn show_without_activating(window: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
    let _ = window.unmaximize();
    let _ = window.unminimize();
    normalize_translate_window(window);
    match window.hwnd() {
        Ok(hwnd) => {
            let _ = unsafe { ShowWindow(HWND(hwnd.0 as _), SW_SHOWNOACTIVATE) };
        }
        Err(error) => {
            warn!("无激活显示失败，回退到普通显示：{error}");
            let _ = window.show();
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn show_without_activating(window: &WebviewWindow) {
    if let Err(error) = window.unmaximize() {
        warn!("恢复快捷翻译窗口最大化状态失败：{error}");
    }
    if let Err(error) = window.unminimize() {
        warn!("恢复快捷翻译窗口最小化状态失败：{error}");
    }
    normalize_translate_window(window);
    if let Err(error) = window.show() {
        warn!("显示快捷翻译窗口失败：{error}");
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TranslateForegroundPlan {
    promote_to_topmost: bool,
    restore_topmost_after_activation: bool,
}

fn translate_foreground_plan(was_topmost: bool) -> TranslateForegroundPlan {
    TranslateForegroundPlan {
        promote_to_topmost: !was_topmost,
        restore_topmost_after_activation: !was_topmost,
    }
}

#[cfg(target_os = "windows")]
fn activate_translate_window(window: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetWindowLongPtrW, SetForegroundWindow, SetWindowPos, ShowWindow,
        GWL_EXSTYLE, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_SHOWWINDOW, SW_RESTORE, WS_EX_TOPMOST,
    };

    let _ = window.unmaximize();
    let _ = window.unminimize();
    normalize_translate_window(window);
    let Ok(native) = window.hwnd() else {
        warn!("无法取得快捷翻译窗口句柄，回退到 Tauri 聚焦");
        let _ = window.show();
        let _ = window.set_focus();
        return;
    };
    let hwnd = HWND(native.0 as _);
    let was_topmost = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32 & WS_EX_TOPMOST.0 != 0;
    let plan = translate_foreground_plan(was_topmost);
    let show_flags = SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW;

    // 取词完成前只进行无激活显示，避免 Ctrl+C 回退链路丢失外部选区。此处取词已经
    // 结束，可以用一次短暂的 TOPMOST 脉冲突破后台窗口的 Z 序限制；随后立即恢复为
    // 普通窗口。若用户已手动固定窗口，则保留原有 TOPMOST 状态。
    let _ = unsafe { ShowWindow(hwnd, SW_RESTORE) };
    if plan.promote_to_topmost {
        if let Err(error) = unsafe { SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, show_flags) } {
            warn!("快捷翻译窗口临时置顶失败：{error}");
        }
    }
    if let Err(error) = unsafe { BringWindowToTop(hwnd) } {
        warn!("快捷翻译窗口提升到前台失败：{error}");
    }
    let first_foreground_attempt = unsafe { SetForegroundWindow(hwnd) }.as_bool();

    if plan.restore_topmost_after_activation {
        if let Err(error) = unsafe {
            SetWindowPos(
                hwnd,
                HWND_NOTOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | SWP_NOACTIVATE,
            )
        } {
            warn!("快捷翻译窗口恢复普通层级失败：{error}");
        }
    }

    // 降回普通层级后再请求一次前台，确保窗口位于非置顶窗口栈最上方。即使 Windows
    // 拒绝焦点切换，前面的 TOPMOST 脉冲也已保证窗口不会继续藏在其他普通窗口后面。
    let second_foreground_attempt = unsafe { SetForegroundWindow(hwnd) }.as_bool();
    if !first_foreground_attempt && !second_foreground_attempt {
        warn!("Windows 拒绝快捷翻译窗口获得前台焦点，窗口已提升到当前普通窗口栈顶部");
    }
}

#[cfg(not(target_os = "windows"))]
fn activate_translate_window(window: &WebviewWindow) {
    if let Err(error) = window.unmaximize() {
        warn!("恢复快捷翻译窗口最大化状态失败：{error}");
    }
    if let Err(error) = window.unminimize() {
        warn!("恢复快捷翻译窗口最小化状态失败：{error}");
    }
    normalize_translate_window(window);
    if let Err(error) = window.show().and_then(|_| window.set_focus()) {
        warn!("快捷翻译窗口聚焦失败：{error}");
    }
}

fn update_text_state(app: &tauri::AppHandle, text: &str) {
    let state = app.state::<StringWrapper>();
    let mut value = state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    value.clear();
    value.push_str(text);
}

fn cache_translate_event(event: PendingTranslateEvent) {
    let mut pending = PENDING_TRANSLATE_EVENT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *pending = Some(event);
}

fn dispatch_translate_event(window: &WebviewWindow, event: PendingTranslateEvent) {
    if TRANSLATE_WINDOW_READY.load(Ordering::Acquire) {
        let state_result = window.emit(
            "selection_capture_state",
            SelectionStatePayload {
                request_id: event.request_id,
                state: event.state.clone(),
                message: event.message.clone(),
            },
        );
        let text_result = event.text.as_ref().map(|text| {
            window.emit(
                "new_text",
                SelectionTextPayload {
                    request_id: event.request_id,
                    text: text.clone(),
                },
            )
        });
        if state_result.is_ok() && text_result.as_ref().is_none_or(Result::is_ok) {
            return;
        }

        // renderer 重启与窗口销毁存在极短竞态。事件发送失败时重新进入未就绪状态，
        // 保留最新请求，等待新 WebView 的 ready 握手，而不是静默丢失快捷键。
        TRANSLATE_WINDOW_READY.store(false, Ordering::Release);
        warn!(
            "快捷翻译事件发送失败，已缓存等待 WebView 恢复：state={:?}, text={:?}",
            state_result.err(),
            text_result.and_then(Result::err)
        );
    }
    cache_translate_event(event);
}

#[tauri::command]
pub fn translate_window_ready(
    window: WebviewWindow,
) -> Result<Option<PendingTranslateEvent>, String> {
    if window.label() != "translate" {
        return Err(format!("ready 握手来自错误窗口：{}", window.label()));
    }
    let _presentation = TRANSLATE_PRESENTATION_TRANSACTION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    TRANSLATE_WINDOW_READY.store(true, Ordering::Release);
    *TRANSLATE_WINDOW_LOADING_SINCE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    info!("快捷翻译 WebView ready 握手完成");
    // 通过当前 invoke 的返回值交付启动期间缓存的最后一条事件。相比 ready 后立刻
    // 再 emit，它不存在“监听器刚建立但消息循环尚未接管”的首帧竞态。
    let pending = PENDING_TRANSLATE_EVENT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    Ok(pending.filter(|event| translate_request_is_presented(event.request_id)))
}

pub fn prewarm_translate_window() {
    prewarm_selection_helper();
    match translate_window() {
        Ok(window) => {
            let _ = window.hide();
            info!("快捷翻译窗口已预热");
        }
        Err(error) => warn!("预热快捷翻译窗口失败：{error}"),
    }
}

fn cancel_selection_generation(generation: &AtomicU64, request_id: u64) -> bool {
    generation
        .compare_exchange(
            request_id,
            request_id.saturating_add(1),
            Ordering::SeqCst,
            Ordering::SeqCst,
        )
        .is_ok()
}

fn selection_request_is_current(request_id: u64) -> bool {
    SELECTION_REQUEST_GENERATION.load(Ordering::SeqCst) == request_id
}

fn translate_request_is_presented(request_id: u64) -> bool {
    TRANSLATE_PRESENTED_REQUEST_ID.load(Ordering::SeqCst) == request_id
}

fn present_translate_request(request_id: u64) {
    TRANSLATE_PRESENTED_REQUEST_ID.store(request_id, Ordering::SeqCst);
}

#[cfg(target_os = "windows")]
fn hide_translate_window_verified(window: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{IsWindowVisible, ShowWindow, SW_HIDE};

    // 先走 Tauri API 同步其窗口状态，再用 HWND 强制结束当前 Windows 指针激活序列。
    // WebView2 可能在 pointerdown 尚未结束时让 hide() 返回成功但继续显示，因此必须
    // 以 IsWindowVisible 的真实结果作为成功标准。
    let _ = window.hide();
    let native = window
        .hwnd()
        .map_err(|error| format!("取得快捷翻译窗口句柄失败：{error}"))?;
    let hwnd = HWND(native.0 as _);
    let _ = unsafe { ShowWindow(hwnd, SW_HIDE) };
    if unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return Err("Windows 仍报告快捷翻译窗口可见".to_string());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn hide_translate_window_verified(window: &WebviewWindow) -> Result<(), String> {
    window
        .hide()
        .map_err(|error| format!("隐藏快捷翻译窗口失败：{error}"))?;
    // Cocoa/GTK/Wayland 后端可能在下一轮原生事件循环才更新可见性。短暂重试可避免
    // 把已经成功排队的 hide 误报为失败，同时仍保留“确认隐藏后再清会话 ID”的约束。
    for attempt in 0..3 {
        if !window
            .is_visible()
            .map_err(|error| format!("读取快捷翻译窗口可见性失败：{error}"))?
        {
            return Ok(());
        }
        if attempt < 2 {
            std::thread::sleep(Duration::from_millis(15));
        }
    }
    Err("快捷翻译窗口仍然可见".to_string())
}

/// 隐藏当前展示会话或收回展示 ID 已丢失的孤儿窗口。
/// 调用方必须持有 `TRANSLATE_PRESENTATION_TRANSACTION`。
///
/// 隐藏成功并确认不可见后才清空展示 ID，因此系统 API 瞬时失败时，同一个关闭按钮
/// 仍可重试。展示 ID 为 0 时允许再次隐藏，以修复原生 API 曾返回成功但窗口仍可见的状态。
fn dismiss_presented_request<E>(
    presented_request: &AtomicU64,
    request_id: u64,
    hide: impl FnOnce() -> Result<(), E>,
) -> Result<bool, E> {
    let presented_request_id = presented_request.load(Ordering::SeqCst);
    if presented_request_id != 0 && presented_request_id != request_id {
        return Ok(false);
    }
    hide()?;
    if presented_request_id == request_id {
        presented_request.store(0, Ordering::SeqCst);
    }
    Ok(true)
}

/// 收起已经失去取词资格的旧展示。调用方必须持有展示事务锁；隐藏失败时保留会话 ID，
/// 这样用户仍能通过关闭按钮重试，而不会留下“可见但无法归属”的孤儿窗口。
fn retire_stale_translate_presentation(window: &WebviewWindow, request_id: u64) {
    if let Err(error) =
        dismiss_presented_request(&TRANSLATE_PRESENTED_REQUEST_ID, request_id, || {
            hide_translate_window_verified(window)
        })
    {
        warn!("隐藏已过期的快捷翻译展示失败 request_id={request_id}: {error}");
    }
}

/// 原子地隐藏指定展示会话，并尽力取消仍属于该会话的取词请求。
///
/// 关闭请求携带前端最后接收的 request_id。后台取词代次即使已经前移，只要下一轮
/// 尚未真正展示，眼前的会话仍可关闭；若新会话已经展示，旧关闭请求则不得误关它。
#[tauri::command]
pub fn dismiss_translate_window(window: WebviewWindow, request_id: u64) -> Result<bool, String> {
    if window.label() != "translate" {
        return Err(format!("关闭请求来自错误窗口：{}", window.label()));
    }
    let _presentation = TRANSLATE_PRESENTATION_TRANSACTION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let presented_request_id = TRANSLATE_PRESENTED_REQUEST_ID.load(Ordering::SeqCst);
    if !dismiss_presented_request(&TRANSLATE_PRESENTED_REQUEST_ID, request_id, || {
        hide_translate_window_verified(&window)
    })? {
        info!(
            "忽略不属于当前展示会话的快捷翻译关闭请求 request_id={request_id}, presented_request_id={presented_request_id}"
        );
        return Ok(false);
    }

    {
        let mut pending = PENDING_TRANSLATE_EVENT
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if pending
            .as_ref()
            .is_some_and(|event| event.request_id == request_id)
        {
            *pending = None;
        }
    }
    let selection_cancelled =
        cancel_selection_generation(&SELECTION_REQUEST_GENERATION, request_id);
    if selection_cancelled
        && SELECTION_CAPTURE_ACTIVE
            .compare_exchange(request_id, 0, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    {
        // UIA COM 调用不可协作取消。只在取词仍执行时终止 helper，避免下一次 Ctrl+D
        // 排在旧 STA 调用之后；随后后台重新预热，不把冷启动留给用户。
        interrupt_selection_capture();
        std::thread::spawn(prewarm_selection_helper);
    }
    info!("快捷翻译窗口已关闭 request_id={request_id}, selection_cancelled={selection_cancelled}");
    Ok(true)
}

pub fn selection_translate() {
    let started = Instant::now();
    let generation = SELECTION_REQUEST_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let Some(app) = app_handle() else {
        warn!("Ctrl+D 触发时应用尚未初始化");
        return;
    };
    SELECTION_CAPTURE_ACTIVE.store(generation, Ordering::SeqCst);
    update_text_state(&app, "");

    // 取词与 WebView 准备并行，但每次快捷键只创建一个等待线程。窗口在无激活展示后
    // 通过单容量通道交给该线程，避免旧实现“取词线程 + recv 线程”在连按时累积句柄。
    let (window_sender, window_receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let result = capture_selected_text(|| {
            SELECTION_REQUEST_GENERATION.load(Ordering::SeqCst) != generation
        });
        let _ = SELECTION_CAPTURE_ACTIVE.compare_exchange(
            generation,
            0,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
        let Ok(window) = window_receiver.recv() else {
            return;
        };
        handle_selection_capture_result(result, app, window, generation, started);
    });

    let window = match translate_window() {
        Ok(window) => window,
        Err(error) => {
            warn!("Ctrl+D 无法创建翻译窗口：{error}");
            return;
        }
    };
    {
        let _presentation = TRANSLATE_PRESENTATION_TRANSACTION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !selection_request_is_current(generation) {
            return;
        }
        present_translate_request(generation);
        dispatch_translate_event(
            &window,
            PendingTranslateEvent {
                request_id: generation,
                text: None,
                state: "capturing".to_string(),
                message: None,
            },
        );
        show_without_activating(&window);
    }
    schedule_translate_window_recovery(generation);
    info!("Ctrl+D 窗口展示耗时={}ms", started.elapsed().as_millis());
    let _ = window_sender.send(window);
}

fn dispatch_capture_error(
    window: &WebviewWindow,
    generation: u64,
    message: String,
    started: Instant,
) {
    if !selection_request_is_current(generation) || !translate_request_is_presented(generation) {
        return;
    }
    warn!(
        "Ctrl+D 取词失败，阶段=capture，耗时={}ms，错误={message}",
        started.elapsed().as_millis()
    );
    dispatch_translate_event(
        window,
        PendingTranslateEvent {
            request_id: generation,
            text: None,
            state: "error".to_string(),
            message: Some(message),
        },
    );
    // 失败提示保持可见但不抢焦点。若这里聚焦浮窗，下一次 Ctrl+D 的 Ctrl+C/UIA
    // 会错误读取浮窗自身，形成连续失败反馈环。
    if !selection_request_is_current(generation) || !translate_request_is_presented(generation) {
        return;
    }
    show_without_activating(window);
    if !selection_request_is_current(generation) || !translate_request_is_presented(generation) {
        retire_stale_translate_presentation(window, generation);
    }
}

fn handle_selection_capture_result(
    result: Result<String, crate::selected_text::SelectionError>,
    app: tauri::AppHandle,
    window: WebviewWindow,
    generation: u64,
    started: Instant,
) {
    let _presentation = TRANSLATE_PRESENTATION_TRANSACTION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !selection_request_is_current(generation) || !translate_request_is_presented(generation) {
        return;
    }
    match result {
        Ok(text) if !text.trim().is_empty() => {
            update_text_state(&app, &text);
            // 取词期间可能恰好撞上上一轮失焦隐藏；成功后再次确保窗口可见，
            // 再聚焦并提交最新文本，连续触发不会留下“后台已翻译、前台没弹出”的状态。
            if !selection_request_is_current(generation)
                || !translate_request_is_presented(generation)
            {
                return;
            }
            activate_translate_window(&window);
            if !selection_request_is_current(generation)
                || !translate_request_is_presented(generation)
            {
                retire_stale_translate_presentation(&window, generation);
                return;
            }
            dispatch_translate_event(
                &window,
                PendingTranslateEvent {
                    request_id: generation,
                    text: Some(text),
                    state: "capturing".to_string(),
                    message: None,
                },
            );
            info!("Ctrl+D 取词完成耗时={}ms", started.elapsed().as_millis());
        }
        Ok(_) => {
            dispatch_capture_error(
                &window,
                generation,
                "未读取到选中的文字".to_string(),
                started,
            );
        }
        Err(error) => {
            dispatch_capture_error(&window, generation, error.to_string(), started);
        }
    }
}

fn show_marker(marker: &str, focus: bool) {
    let generation = SELECTION_REQUEST_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let Some(app) = app_handle() else {
        return;
    };
    update_text_state(&app, marker);
    match translate_window() {
        Ok(window) => {
            let _presentation = TRANSLATE_PRESENTATION_TRANSACTION
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !selection_request_is_current(generation) {
                return;
            }
            present_translate_request(generation);
            dispatch_translate_event(
                &window,
                PendingTranslateEvent {
                    request_id: generation,
                    text: Some(marker.to_string()),
                    state: "idle".to_string(),
                    message: None,
                },
            );
            if focus {
                activate_translate_window(&window);
            } else {
                show_without_activating(&window);
            }
        }
        Err(error) => warn!("打开快捷翻译窗口失败：{error}"),
    }
}

pub fn input_translate() {
    show_marker("[INPUT_TRANSLATE]", true);
}

pub fn image_translate() {
    show_marker("[IMAGE_TRANSLATE]", true);
}

pub fn main_window(route: Option<&str>) -> Result<WebviewWindow, String> {
    let app = app_handle().ok_or_else(|| "应用尚未初始化".to_string())?;
    let window = if let Some(window) = app.get_webview_window("main") {
        window
    } else {
        WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
            .title("小允翻译")
            .inner_size(1440.0, 920.0)
            .min_inner_size(1040.0, 680.0)
            .decorations(true)
            .visible(false)
            .build()
            .map_err(|error| error.to_string())?
    };
    show_main_window(&window)?;
    if let Some(route) = route {
        let _ = window.emit("main_navigate", route);
    }
    Ok(window)
}

#[cfg(target_os = "windows")]
fn show_main_window(window: &WebviewWindow) -> Result<(), String> {
    // 保留 Windows 已验证的调用顺序；WebView2 在隐藏窗口上先 show 再恢复最小化更稳定。
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn show_main_window(window: &WebviewWindow) -> Result<(), String> {
    // Cocoa/GTK 应先恢复最小化，再显示并请求焦点；错误向上传递给托盘/单实例入口记录。
    window
        .unminimize()
        .map_err(|error| format!("恢复论文库窗口失败：{error}"))?;
    window
        .show()
        .map_err(|error| format!("显示论文库窗口失败：{error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("聚焦论文库窗口失败：{error}"))
}

#[tauri::command]
pub fn open_main_window(route: Option<String>) -> Result<(), String> {
    main_window(route.as_deref()).map(|_| ())
}

pub fn config_window() {
    if let Err(error) = main_window(Some("settings")) {
        warn!("打开设置失败：{error}");
    }
}

fn screenshot_request_is_current(generation: u64) -> bool {
    SCREENSHOT_REQUEST_GENERATION.load(Ordering::SeqCst) == generation
}

async fn wait_for_screenshot_window_release(app: &tauri::AppHandle) -> Result<(), String> {
    let started = Instant::now();
    let timeout = Duration::from_millis(800);
    while app.get_webview_window("screenshot").is_some() {
        if started.elapsed() >= timeout {
            return Err("旧截图窗口在 800 ms 内未释放".to_string());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    Ok(())
}

async fn screenshot_window(generation: u64) -> Result<Option<WebviewWindow>, String> {
    let app = app_handle().ok_or_else(|| "应用尚未初始化".to_string())?;
    if let Some(window) = app.get_webview_window("screenshot") {
        // Esc 只会隐藏覆盖层。复用隐藏 WebView 会保留旧截图、鼠标状态和 success 监听器，
        // 导致第二次 Ctrl+E 看似无响应或一次选择触发多次翻译；每次都从干净窗口开始。
        window
            .destroy()
            .map_err(|error| format!("重置截图窗口失败：{error}"))?;
        // WebView 的销毁和 label 从 Tauri 窗口表移除不是同一个时刻。
        // 等待 label 真正释放，避免第二次 Ctrl+E 立即重建时冲突。
        wait_for_screenshot_window_release(&app).await?;
    }
    if !screenshot_request_is_current(generation) {
        return Ok(None);
    }
    let (mouse_x, mouse_y) = mouse_position();
    let monitor_position = current_monitor(mouse_x, mouse_y).map(|monitor| *monitor.position());
    let mut builder =
        WebviewWindowBuilder::new(&app, "screenshot", WebviewUrl::App("index.html".into()))
            .title("小允翻译 - 截图")
            .decorations(false)
            .transparent(true)
            .skip_taskbar(true)
            .visible(false);
    if let Some(position) = monitor_position {
        builder = builder.position(position.x as f64, position.y as f64);
    }
    let window = builder.build().map_err(|error| error.to_string())?;
    if !screenshot_request_is_current(generation) {
        let _ = window.destroy();
        return Ok(None);
    }
    window
        .set_fullscreen(true)
        .map_err(|error| error.to_string())?;
    window
        .set_always_on_top(true)
        .map_err(|error| error.to_string())?;
    // 保持隐藏，直到前端拿到完整截图并完成图片解码；这能消除透明空白闪屏。
    // Ctrl+E 的 success 监听器会在用户能够框选之前安装完成。
    Ok(Some(window))
}

pub fn ocr_translate() {
    let generation = SCREENSHOT_REQUEST_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    info!("Ctrl+E 已触发，正在创建截图覆盖层");
    tauri::async_runtime::spawn(async move {
        // 销毁与重建必须串行；快速连按时只保留最新一次请求。
        let _transaction = SCREENSHOT_WINDOW_TRANSACTION.lock().await;
        if !screenshot_request_is_current(generation) {
            return;
        }
        match screenshot_window(generation).await {
            Ok(Some(window)) => {
                window.once("success", move |_event| {
                    if !screenshot_request_is_current(generation) {
                        return;
                    }
                    info!("Ctrl+E 截图区域已提交，正在打开 OCR 翻译");
                    image_translate();
                });
            }
            Ok(None) => {}
            Err(error) => warn!("打开截图翻译失败：{error}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        calculate_translate_window_position, cancel_selection_generation,
        dismiss_presented_request, screenshot_request_is_current, translate_foreground_plan,
        translate_window_should_rebuild, TranslateForegroundPlan, TranslateWorkArea,
        SCREENSHOT_REQUEST_GENERATION, TRANSLATE_WINDOW_CURSOR_GAP, TRANSLATE_WINDOW_HEIGHT,
        TRANSLATE_WINDOW_READY_TIMEOUT, TRANSLATE_WINDOW_WIDTH,
    };
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    #[test]
    fn stale_close_never_cancels_a_newer_selection_request() {
        for current in 2..10_002 {
            let generation = AtomicU64::new(current);
            assert!(!cancel_selection_generation(&generation, current - 1));
            assert_eq!(generation.load(Ordering::SeqCst), current);
        }
    }

    #[test]
    fn current_close_is_atomic_and_the_next_request_remains_valid() {
        let generation = AtomicU64::new(41);
        assert!(cancel_selection_generation(&generation, 41));
        assert_eq!(generation.load(Ordering::SeqCst), 42);
        let next = generation.fetch_add(1, Ordering::SeqCst) + 1;
        assert_eq!(next, 43);
        assert!(!cancel_selection_generation(&generation, 41));
        assert_eq!(generation.load(Ordering::SeqCst), next);
    }

    #[test]
    fn visible_session_closes_even_after_a_new_selection_generation_started() {
        let presented_request = AtomicU64::new(41);
        let selection_generation = AtomicU64::new(42);
        let hide_calls = AtomicU64::new(0);

        let dismissed = dismiss_presented_request(&presented_request, 41, || {
            hide_calls.fetch_add(1, Ordering::SeqCst);
            Ok::<(), ()>(())
        })
        .expect("隐藏当前展示会话不应失败");

        assert!(dismissed);
        assert_eq!(hide_calls.load(Ordering::SeqCst), 1);
        assert_eq!(presented_request.load(Ordering::SeqCst), 0);
        assert!(!cancel_selection_generation(&selection_generation, 41));
        assert_eq!(selection_generation.load(Ordering::SeqCst), 42);
    }

    #[test]
    fn stale_close_never_hides_a_newer_presented_session() {
        let presented_request = AtomicU64::new(42);
        let hide_calls = AtomicU64::new(0);

        let dismissed = dismiss_presented_request(&presented_request, 41, || {
            hide_calls.fetch_add(1, Ordering::SeqCst);
            Ok::<(), ()>(())
        })
        .expect("过期关闭只应被忽略");

        assert!(!dismissed);
        assert_eq!(hide_calls.load(Ordering::SeqCst), 0);
        assert_eq!(presented_request.load(Ordering::SeqCst), 42);
    }

    #[test]
    fn failed_native_hide_preserves_the_session_for_a_retry() {
        let presented_request = AtomicU64::new(73);

        let failed = dismiss_presented_request(&presented_request, 73, || Err("hide failed"));
        assert_eq!(failed, Err("hide failed"));
        assert_eq!(presented_request.load(Ordering::SeqCst), 73);

        let retried = dismiss_presented_request(&presented_request, 73, || Ok::<(), &str>(()))
            .expect("第二次隐藏应可重试");
        assert!(retried);
        assert_eq!(presented_request.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn orphan_visible_window_can_be_hidden_again() {
        let presented_request = AtomicU64::new(0);
        let hide_calls = AtomicU64::new(0);

        let dismissed = dismiss_presented_request(&presented_request, 73, || {
            hide_calls.fetch_add(1, Ordering::SeqCst);
            Ok::<(), ()>(())
        })
        .expect("展示 ID 已清空的孤儿窗口仍应允许隐藏");

        assert!(dismissed);
        assert_eq!(hide_calls.load(Ordering::SeqCst), 1);
        assert_eq!(presented_request.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn ready_translate_window_is_never_rebuilt() {
        assert!(!translate_window_should_rebuild(
            true,
            Some(TRANSLATE_WINDOW_READY_TIMEOUT * 2)
        ));
    }

    #[test]
    fn loading_translate_window_gets_a_one_second_grace_period() {
        assert!(!translate_window_should_rebuild(
            false,
            Some(TRANSLATE_WINDOW_READY_TIMEOUT - Duration::from_millis(1))
        ));
        assert!(translate_window_should_rebuild(
            false,
            Some(TRANSLATE_WINDOW_READY_TIMEOUT)
        ));
    }

    #[test]
    fn untracked_unready_translate_window_is_treated_as_stalled() {
        assert!(translate_window_should_rebuild(false, None));
    }

    #[test]
    fn normal_translate_window_uses_a_temporary_topmost_pulse() {
        assert_eq!(
            translate_foreground_plan(false),
            TranslateForegroundPlan {
                promote_to_topmost: true,
                restore_topmost_after_activation: true,
            }
        );
    }

    #[test]
    fn pinned_translate_window_keeps_its_existing_topmost_state() {
        assert_eq!(
            translate_foreground_plan(true),
            TranslateForegroundPlan {
                promote_to_topmost: false,
                restore_topmost_after_activation: false,
            }
        );
    }

    #[test]
    fn mouse_window_prefers_cursor_offset_and_uses_work_area() {
        let work_area = TranslateWorkArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        };
        assert_eq!(
            calculate_translate_window_position("mouse", 100, 80, 420, 360, work_area),
            (
                100 + TRANSLATE_WINDOW_CURSOR_GAP,
                80 + TRANSLATE_WINDOW_CURSOR_GAP
            )
        );
    }

    #[test]
    fn mouse_window_flips_before_crossing_work_area_edges() {
        let work_area = TranslateWorkArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        };
        assert_eq!(
            calculate_translate_window_position("mouse", 1900, 1020, 420, 360, work_area),
            (
                1900 - 420 - TRANSLATE_WINDOW_CURSOR_GAP,
                1020 - 360 - TRANSLATE_WINDOW_CURSOR_GAP
            )
        );
    }

    #[test]
    fn compact_logical_size_stays_bounded_on_two_hundred_percent_dpi() {
        assert_eq!(
            (TRANSLATE_WINDOW_WIDTH, TRANSLATE_WINDOW_HEIGHT),
            (420.0, 360.0)
        );
        let work_area = TranslateWorkArea {
            x: 0,
            y: 0,
            width: 2560,
            height: 1520,
        };
        let (x, y) = calculate_translate_window_position(
            "mouse",
            1800,
            900,
            (TRANSLATE_WINDOW_WIDTH * 2.0) as u32,
            (TRANSLATE_WINDOW_HEIGHT * 2.0) as u32,
            work_area,
        );
        assert!(x >= work_area.x && x + 840 <= work_area.x + work_area.width as i32);
        assert!(y >= work_area.y && y + 720 <= work_area.y + work_area.height as i32);
    }

    #[test]
    fn oversized_window_is_clamped_to_work_area_origin() {
        let work_area = TranslateWorkArea {
            x: -1280,
            y: 20,
            width: 800,
            height: 600,
        };
        assert_eq!(
            calculate_translate_window_position("mouse", -900, 300, 1200, 900, work_area),
            (-1280, 20)
        );
    }

    #[test]
    fn only_latest_screenshot_request_can_create_or_submit_a_window() {
        SCREENSHOT_REQUEST_GENERATION.store(41, Ordering::SeqCst);
        assert!(!screenshot_request_is_current(40));
        assert!(screenshot_request_is_current(41));
    }
}
