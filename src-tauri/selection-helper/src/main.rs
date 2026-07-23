//! Windows 划词辅助进程。
//!
//! 此进程只通过标准输入/输出交换 JSON Lines，不创建 Tauri 窗口，也不记录选中文本。

#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

#[allow(dead_code)]
#[path = "../../src/selected_text.rs"]
mod selected_text;

#[cfg(target_os = "windows")]
fn main() {
    if let Err(error) = selected_text::run_selection_helper() {
        eprintln!("selection-helper 异常退出：{error}");
        std::process::exit(1);
    }
}

#[cfg(not(target_os = "windows"))]
fn main() {}
