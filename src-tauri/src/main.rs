// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
#![deny(clippy::large_stack_arrays)]

mod cmd;
mod config;
mod external_url;
mod hotkey;
mod ollama_onboarding;
mod research;
mod research_insights;
mod research_lexicon;
mod research_runtime;
mod screenshot;
mod selected_text;
mod system_ocr;
mod system_tts;
mod tray;
mod vision_runtime;
mod window;

use cmd::*;
use config::*;
use external_url::research_open_external_url;
use hotkey::*;
use log::{info, warn};
use ollama_onboarding::*;
use once_cell::sync::OnceCell;
use research::*;
use research_insights::*;
use research_lexicon::*;
use research_runtime::*;
use screenshot::screenshot;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use system_ocr::{system_ocr, system_ocr_base64};
use system_tts::{list_system_voices, system_tts};
use tauri::Manager;
use tray::*;
use vision_runtime::{cancel_ollama_vision_request, ollama_vision_generate};
use window::{
    dismiss_translate_window, main_window, open_main_window, prewarm_translate_window,
    translate_window_ready,
};

/// 全局 AppHandle。所有读取都必须处理尚未初始化的情况，禁止致命 unwrap。
pub static APP: OnceCell<tauri::AppHandle> = OnceCell::new();

/// 快捷窗口与旧命令共用的最后一次源文缓存。
pub struct StringWrapper(pub Mutex<String>);

/// 防止主窗口关闭与托盘退出同时触发两轮清理。
static APP_SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

fn should_exit_for_window(label: &str) -> bool {
    label == "main"
}

fn begin_app_shutdown(app: &tauri::AppHandle) {
    if APP_SHUTTING_DOWN.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Err(error) = unregister_all_shortcuts(app) {
        warn!("退出前注销快捷键失败：{error}");
    }
    selected_text::shutdown_selection_helper();
    info!("============== 退出小允翻译 ==============");
}

pub(crate) fn request_app_exit(app: &tauri::AppHandle) {
    begin_app_shutdown(app);
    let app = app.clone();
    // 退出请求离开窗口事件回调后再投递给 Tauri 事件循环，避免在
    // CloseRequested 回调内部同步退出造成重入。
    std::thread::spawn(move || app.exit(0));
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let _ = main_window(None);
            info!(
                "检测到第二个实例，已打开现有论文库窗口：{}",
                app.config().identifier
            );
        }))
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if should_exit_for_window(window.label()) {
                    api.prevent_close();
                    // 先隐藏主窗口，让用户点击 × 后立即得到视觉反馈；统一退出函数
                    // 会负责清理快捷键和 helper，再终止所有隐藏窗口与进程。
                    let _ = window.hide();
                    request_app_exit(window.app_handle());
                }
            }
        })
        .setup(|app| {
            info!("============== 启动小允翻译 4.x ==============");
            let _ = APP.set(app.handle().clone());
            init_config(app).map_err(std::io::Error::other)?;
            app.manage(StringWrapper(Mutex::new(String::new())));
            match research_library_root() {
                Ok(path) => {
                    if let Err(error) = app.asset_protocol_scope().allow_directory(path, true) {
                        warn!("允许 PDF 资源目录失败：{error}");
                    }
                }
                Err(error) => warn!("初始化论文库目录失败：{error}"),
            }

            prewarm_translate_window();
            schedule_translation_prewarm();
            if let Err(error) = install_tray(app.handle()) {
                warn!("初始化系统托盘失败：{error}");
            }
            if let Err(error) = register_shortcut("all") {
                warn!("注册全局快捷键失败：{error}");
            }
            start_shortcut_watchdog(app.handle().clone());
            if let Err(error) = main_window(None) {
                warn!("打开论文库失败：{error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            reload_store,
            get_text,
            cut_image,
            get_base64,
            copy_img,
            system_tts,
            list_system_voices,
            system_ocr,
            system_ocr_base64,
            dismiss_translate_window,
            translate_window_ready,
            open_main_window,
            register_shortcut_by_frontend,
            get_settings_v2,
            update_settings_v2,
            ollama_get_setup_status,
            ollama_open_official_download,
            ollama_start_local_service,
            ollama_pull_unified_model,
            ollama_activate_unified_model,
            ollama_cancel_model_pull,
            ollama_vision_generate,
            cancel_ollama_vision_request,
            screenshot,
            research_list_papers,
            research_import_papers,
            research_move_to_trash,
            research_restore_paper,
            research_archive_papers,
            research_unarchive_papers,
            research_move_papers_to_trash,
            research_restore_papers,
            research_delete_paper_permanently,
            research_list_tags,
            research_create_tag,
            research_set_paper_tags,
            research_list_projects,
            research_create_project,
            research_update_project,
            research_delete_project,
            research_set_paper_projects,
            research_get_document,
            research_open_external_url,
            research_replace_document_outline,
            research_rebuild_document_outline,
            research_save_progress,
            research_update_page_count,
            research_mark_text_index_complete,
            research_list_annotations,
            research_save_annotation,
            research_delete_annotation,
            research_list_glossary,
            research_save_glossary_entry,
            research_delete_glossary_entry,
            research_index_page,
            research_index_pages,
            research_get_document_pages,
            research_list_document_translation_pages,
            research_save_document_translation_page,
            research_clear_document_translation,
            research_search,
            research_sync_paper_references,
            research_list_paper_relations,
            research_get_translation_status,
            research_is_translation_active,
            research_list_ollama_models,
            research_translate_selection,
            research_cancel_translation,
            prepare_translation_runtime,
            apply_ollama_runtime_state,
            research_get_semantic_status,
            research_start_embedding_index,
            research_hybrid_search,
            research_ai_query,
            research_analyze_figure,
            research_start_ocr_job,
            research_enqueue_ocr_page,
            research_pause_job,
            research_cancel_job,
            research_get_paper_insights,
            research_list_pending_paper_insights,
            research_generate_paper_insights,
            research_cancel_paper_insights,
            research_list_chapter_insights,
            research_get_chapter_insights,
            research_generate_chapter_insights,
            research_define_term,
            research_cancel_define_term
        ])
        .build(tauri::generate_context!())
        .expect("无法构建小允翻译")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                begin_app_shutdown(app_handle);
            }
        });
}

#[cfg(test)]
mod lifecycle_tests {
    use super::should_exit_for_window;

    #[test]
    fn main_window_close_exits_the_application() {
        assert!(should_exit_for_window("main"));
    }

    #[test]
    fn auxiliary_window_close_does_not_exit_the_application() {
        for label in ["translate", "screenshot", "daemon"] {
            assert!(!should_exit_for_window(label));
        }
    }
}

#[cfg(test)]
mod platform_config_tests {
    use serde_json::Value;

    fn platform_config(source: &str) -> Value {
        let config: Value = serde_json::from_str(source).expect("平台配置必须是有效 JSON");
        assert!(
            config.get("tauri").is_none(),
            "Tauri 2 平台配置不得保留 v1 的 tauri 包装层"
        );
        config
    }

    #[test]
    fn macos_config_overrides_windows_bundle_target_and_identifier() {
        let config = platform_config(include_str!("../tauri.macos.conf.json"));
        assert_eq!(config["identifier"], "io.github.xiaoyun0922.translator");
        assert_eq!(
            config["bundle"]["targets"],
            serde_json::json!(["app", "dmg"])
        );
        assert!(config["bundle"]["resources"]
            .as_array()
            .is_some_and(|resources| !resources.is_empty()));
    }

    #[test]
    fn linux_config_overrides_windows_bundle_target_and_identifier() {
        let config = platform_config(include_str!("../tauri.linux.conf.json"));
        assert_eq!(config["identifier"], "io.github.xiaoyun0922.translator");
        assert_eq!(
            config["bundle"]["targets"],
            serde_json::json!(["deb", "appimage"])
        );
    }
}
