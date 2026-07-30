use crate::ollama_onboarding::open_url_with_system;
use reqwest::Url;

const ALLOWED_EXTERNAL_SCHEMES: [&str; 3] = ["http", "https", "mailto"];

fn normalize_external_url(value: &str) -> Result<String, String> {
    let candidate = value.trim();
    if candidate.is_empty() || candidate.chars().any(char::is_control) {
        return Err("外部链接为空或包含控制字符".to_string());
    }
    let parsed = Url::parse(candidate).map_err(|_| "外部链接格式无效".to_string())?;
    if !ALLOWED_EXTERNAL_SCHEMES.contains(&parsed.scheme()) {
        return Err("外部链接只允许使用 http、https 或 mailto".to_string());
    }
    match parsed.scheme() {
        "http" | "https" => {
            if parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                return Err("HTTP 外部链接缺少主机或包含身份信息".to_string());
            }
        }
        "mailto" if parsed.path().is_empty() => {
            return Err("mailto 外部链接缺少收件地址".to_string());
        }
        _ => {}
    }
    Ok(parsed.to_string())
}

#[tauri::command]
pub fn research_open_external_url(url: String) -> Result<(), String> {
    let safe_url = normalize_external_url(&url)?;
    open_url_with_system(&safe_url)
}

#[cfg(test)]
mod tests {
    use super::{normalize_external_url, research_open_external_url};

    #[test]
    fn accepts_and_normalizes_allowed_external_urls() {
        assert_eq!(
            normalize_external_url(" https://example.com/paper?q=1 ").unwrap(),
            "https://example.com/paper?q=1"
        );
        assert_eq!(
            normalize_external_url("http://example.com").unwrap(),
            "http://example.com/"
        );
        assert_eq!(
            normalize_external_url("mailto:author@example.com").unwrap(),
            "mailto:author@example.com"
        );
    }

    #[test]
    fn rejects_unsafe_or_ambiguous_external_urls() {
        for value in [
            "javascript:alert(1)",
            "file:///C:/secret.txt",
            "data:text/html,test",
            "/relative/path",
            "https://user:password@example.com",
            "https://",
            "mailto:",
            "https://example.com/\nnext",
        ] {
            assert!(normalize_external_url(value).is_err(), "{value}");
        }
    }

    #[test]
    fn command_rejects_unsafe_url_before_opening_system_browser() {
        let error = research_open_external_url("javascript:alert(1)".to_string()).unwrap_err();
        assert!(error.contains("http、https 或 mailto"));
    }
}
