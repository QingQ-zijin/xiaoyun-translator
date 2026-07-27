//! 快捷截图 OCR 的 Ollama 后端传输层。
//!
//! Windows 生产版 WebView 的来源为 `http(s)://tauri.localhost`，Ollama 默认不会
//! 接受该跨域来源。视觉请求因此必须由 Rust 发出，前端只通过 Tauri IPC 传递当前
//! 截图请求；取消时直接丢弃正在等待的 HTTP future，避免旧截图继续占用显存。

use crate::config::{get_settings_v2, UNIFIED_OLLAMA_CONTEXT_TOKENS, UNIFIED_OLLAMA_MODEL};
use crate::ollama_onboarding::is_local_ollama_endpoint;
use crate::research_runtime::ensure_unified_ollama_runtime;
use log::{info, warn};
use once_cell::sync::Lazy;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::oneshot;

const MAX_IMAGE_BASE64_CHARS: usize = 64 * 1024 * 1024;
const MAX_REQUEST_ID_CHARS: usize = 160;

struct ActiveVisionRequest {
    generation: u64,
    cancel: oneshot::Sender<()>,
}

static VISION_REQUEST_GENERATION: AtomicU64 = AtomicU64::new(0);
static ACTIVE_VISION_REQUESTS: Lazy<Mutex<HashMap<String, ActiveVisionRequest>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn validate_request_id(request_id: &str) -> Result<&str, String> {
    let request_id = request_id.trim();
    if request_id.is_empty()
        || request_id.chars().count() > MAX_REQUEST_ID_CHARS
        || !request_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("截图 OCR 请求 ID 无效".to_string());
    }
    Ok(request_id)
}

fn prepare_generate_request(mut request: Value) -> Result<Value, String> {
    let object = request
        .as_object_mut()
        .ok_or_else(|| "截图 OCR 请求格式无效".to_string())?;
    let images = object
        .get("images")
        .and_then(Value::as_array)
        .ok_or_else(|| "截图 OCR 请求缺少当前图片".to_string())?;
    if images.len() != 1 {
        return Err("截图 OCR 每次只能提交一张当前图片".to_string());
    }
    let image = images[0]
        .as_str()
        .ok_or_else(|| "截图 OCR 图片格式无效".to_string())?;
    if image.trim().is_empty() || image.len() > MAX_IMAGE_BASE64_CHARS {
        return Err("截图 OCR 图片为空或超过 64 MB 限制".to_string());
    }

    // IPC 负载可能来自尚未刷新的旧 WebView；网络边界再次锁死唯一模型和 runner 规格。
    object.insert(
        "model".to_string(),
        Value::String(UNIFIED_OLLAMA_MODEL.to_string()),
    );
    object.insert("stream".to_string(), Value::Bool(false));
    object.insert("think".to_string(), Value::Bool(false));
    object.insert("keep_alive".to_string(), Value::from(-1));
    let options = object
        .entry("options".to_string())
        .or_insert_with(|| Value::Object(Default::default()))
        .as_object_mut()
        .ok_or_else(|| "截图 OCR 生成参数格式无效".to_string())?;
    options.insert(
        "num_ctx".to_string(),
        Value::from(UNIFIED_OLLAMA_CONTEXT_TOKENS),
    );
    Ok(request)
}

fn install_cancellation(request_id: &str) -> (u64, oneshot::Receiver<()>) {
    let generation = VISION_REQUEST_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let (sender, receiver) = oneshot::channel();
    let previous = ACTIVE_VISION_REQUESTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(
            request_id.to_string(),
            ActiveVisionRequest {
                generation,
                cancel: sender,
            },
        );
    if let Some(previous) = previous {
        let _ = previous.cancel.send(());
    }
    (generation, receiver)
}

fn finish_request(request_id: &str, generation: u64) {
    let mut requests = ACTIVE_VISION_REQUESTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if requests
        .get(request_id)
        .is_some_and(|request| request.generation == generation)
    {
        requests.remove(request_id);
    }
}

async fn response_error(response: reqwest::Response) -> String {
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
        .unwrap_or_else(|| "本地视觉服务没有返回错误详情".to_string());
    format!("截图 OCR 请求失败（HTTP {status}）：{detail}")
}

fn request_error(error: reqwest::Error) -> String {
    if error.is_connect() {
        return "截图 OCR 失败：无法连接本地 Ollama，请确认它正在运行".to_string();
    }
    if error.is_timeout() {
        return "截图 OCR 失败：本地视觉模型响应超时".to_string();
    }
    format!("截图 OCR 请求失败：{error}")
}

fn should_recover_local_vision_connection(
    endpoint: &crate::config::OllamaEndpointSettings,
    error: &reqwest::Error,
) -> bool {
    is_local_ollama_endpoint(endpoint) && error.is_connect()
}

#[tauri::command]
pub async fn ollama_vision_generate(request_id: String, request: Value) -> Result<Value, String> {
    let request_id = validate_request_id(&request_id)?.to_string();
    // 必须先注册取消槽，再读取开关。这样设置页关闭时 cancel-all 不会漏过
    // “已经读到 enabled=true、但尚未发送 HTTP”的截图请求。
    let (generation, mut cancellation) = install_cancellation(&request_id);
    let settings = match get_settings_v2() {
        Ok(settings) => settings,
        Err(error) => {
            finish_request(&request_id, generation);
            return Err(error);
        }
    };
    if !settings.ollama.enabled {
        finish_request(&request_id, generation);
        return Err("Ollama 后端已关闭，请在设置中开启后重试".to_string());
    }
    let endpoint = settings.ollama.vision;
    let request = match prepare_generate_request(request) {
        Ok(request) => request,
        Err(error) => {
            finish_request(&request_id, generation);
            return Err(error);
        }
    };
    let url = format!(
        "{}/api/generate",
        endpoint.request_path.trim_end_matches('/')
    );
    info!(
        "截图 OCR 后端请求开始 request_id={request_id} model={}",
        UNIFIED_OLLAMA_MODEL
    );

    let http_request = async {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|error| format!("初始化截图 OCR 网络客户端失败：{error}"))?;
        let first_response = client.post(url).json(&request).send().await;
        let response = match first_response {
            Ok(response) => response,
            Err(error) if should_recover_local_vision_connection(&endpoint, &error) => {
                ensure_unified_ollama_runtime(&endpoint)
                    .await
                    .map_err(|recovery_error| {
                        format!("截图 OCR 检测到 Ollama 已退出，自动恢复失败：{recovery_error}")
                    })?;
                client
                    .post(format!(
                        "{}/api/generate",
                        endpoint.request_path.trim_end_matches('/')
                    ))
                    .json(&request)
                    .send()
                    .await
                    .map_err(request_error)?
            }
            Err(error) => return Err(request_error(error)),
        };
        if !response.status().is_success() {
            return Err(response_error(response).await);
        }
        response
            .json::<Value>()
            .await
            .map_err(|error| format!("解析截图 OCR 结果失败：{error}"))
    };

    let result = tokio::select! {
        biased;
        _ = &mut cancellation => Err("截图 OCR 已取消".to_string()),
        result = http_request => result,
    };
    finish_request(&request_id, generation);
    match &result {
        Ok(_) => info!("截图 OCR 后端请求完成 request_id={request_id}"),
        Err(error) if error == "截图 OCR 已取消" => {
            info!("截图 OCR 后端请求已取消 request_id={request_id}")
        }
        Err(error) => warn!("截图 OCR 后端请求失败 request_id={request_id} error={error}"),
    }
    result
}

#[tauri::command]
pub fn cancel_ollama_vision_request(request_id: String) -> Result<bool, String> {
    let request_id = validate_request_id(&request_id)?;
    let request = ACTIVE_VISION_REQUESTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(request_id);
    if let Some(request) = request {
        let _ = request.cancel.send(());
        return Ok(true);
    }
    Ok(false)
}

/// 设置页关闭本地 AI 时取消全部截图/OCR 请求，避免恢复完成后继续重试视觉生成。
pub(crate) fn cancel_all_ollama_vision_requests() {
    let requests = {
        let mut active = ACTIVE_VISION_REQUESTS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        active
            .drain()
            .map(|(_, request)| request)
            .collect::<Vec<_>>()
    };
    for request in requests {
        let _ = request.cancel.send(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::OllamaEndpointSettings;
    use serde_json::json;
    use std::net::TcpListener;

    #[test]
    fn backend_forces_current_vision_model_and_non_stream_response() {
        let request = prepare_generate_request(json!({
            "model": "qwen3-vl:4b-instruct-q4_K_M",
            "prompt": "OCR:",
            "images": ["CURRENT_IMAGE"],
            "stream": true,
            "think": true,
            "keep_alive": "5m",
            "options": {"num_ctx": 4096, "num_predict": 2048}
        }))
        .unwrap();

        assert_eq!(request["model"], UNIFIED_OLLAMA_MODEL);
        assert_eq!(request["images"], json!(["CURRENT_IMAGE"]));
        assert_eq!(request["stream"], false);
        assert_eq!(request["think"], false);
        assert_eq!(request["keep_alive"], -1);
        assert_eq!(request["options"]["num_ctx"], UNIFIED_OLLAMA_CONTEXT_TOKENS);
        assert_eq!(request["options"]["num_predict"], 2048);
    }

    #[test]
    fn backend_rejects_missing_multiple_or_oversized_images() {
        assert!(prepare_generate_request(json!({})).is_err());
        assert!(prepare_generate_request(json!({"images": ["FIRST", "SECOND"]})).is_err());
        assert!(prepare_generate_request(json!({"images": [" "]})).is_err());
        assert!(
            prepare_generate_request(json!({"images": ["IMAGE"], "options": "stale"})).is_err()
        );
    }

    #[test]
    fn cancellation_only_removes_the_matching_active_request() {
        let request_id = "vision-test-cancel";
        let (_generation, receiver) = install_cancellation(request_id);
        assert!(cancel_ollama_vision_request(request_id.to_string()).unwrap());
        assert!(receiver.blocking_recv().is_ok());
        assert!(!cancel_ollama_vision_request(request_id.to_string()).unwrap());
    }

    #[test]
    fn request_id_rejects_spaces_and_unbounded_input() {
        assert!(validate_request_id("vision-123_ok").is_ok());
        assert!(validate_request_id("vision request").is_err());
        assert!(validate_request_id(&"x".repeat(MAX_REQUEST_ID_CHARS + 1)).is_err());
    }

    #[tokio::test]
    async fn only_local_connection_refusal_triggers_vision_recovery() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let error = reqwest::Client::new()
            .get(format!("http://{address}/api/generate"))
            .send()
            .await
            .unwrap_err();

        let local = OllamaEndpointSettings {
            request_path: format!("http://{address}"),
            ..OllamaEndpointSettings::default()
        };
        let remote = OllamaEndpointSettings {
            request_path: "https://ollama.example.test".to_string(),
            ..OllamaEndpointSettings::default()
        };
        assert!(should_recover_local_vision_connection(&local, &error));
        assert!(!should_recover_local_vision_connection(&remote, &error));
    }
}
