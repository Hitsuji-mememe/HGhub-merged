//! 多源适配器取页命令（audit6 模块化与源注册表节）。
//!
//! 外部站点的页面只能经此命令取：底层走生产网络栈
//! （net::fetch_page_text_with_headers —— 目标校验/DNS 固定/逐跳
//! 重定向复检/4MB 流式上限），适配器不得另开任何直连旁路。
//!
//! 前端契约（features/sources/adapters/fetchPage.ts 的 FetchPage）：
//! 启动处以 invoke("source_fetch", { url }) 注入；headers 可选，
//! 适配器需要 Referer/User-Agent 等头时以键值对象传入，缺省即无头。

use std::collections::{HashMap, HashSet};
use std::sync::RwLock;

/// 请求头白名单（Muse 2026-11-19 整改 D6.1，G5 P1-3）：适配器取页
/// 只需要这四类头；Cookie/Authorization/Origin 等其余头一律丢弃，
/// 不让 WebView 侧脚本把 source_fetch 用成任意头取页口。Host 与
/// Content-Length 沿用原有禁令（报错，不静默放行也不静默丢弃——
/// 与 net::edge 的既有契约一致）。
pub const ALLOWED_SOURCE_HEADERS: [&str; 4] =
    ["referer", "user-agent", "accept", "accept-language"];

pub fn filter_source_headers(
    headers: Vec<(String, String)>,
) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if lower == "host" || lower == "content-length" {
            return Err(format!("请求头不许覆盖：{name}"));
        }
        if ALLOWED_SOURCE_HEADERS.contains(&lower.as_str()) {
            out.push((name, value));
        }
    }
    Ok(out)
}

/// origin 规范化：scheme://host:port（默认端口省略），与前端
/// URL.origin 口径一致；非 http/https 或不可解析 → None。
pub fn normalize_origin(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

/// 生效注册表 origin 白名单（整改 D6.2）：前端在注册表落定后经
/// source_allowlist_set 推送；None＝尚未设置。
static SOURCE_ALLOWLIST: RwLock<Option<HashSet<String>>> = RwLock::new(None);

/// 名单校验：未设置（启动竞态）→ 拒绝并明确报错（最小风险语义，
/// 不静默放行）；已设置 → 目标 origin 必须在名单内。
pub fn check_origin_allowed(allowlist: Option<&HashSet<String>>, url: &str) -> Result<(), String> {
    let Some(set) = allowlist else {
        return Err("源白名单未初始化：注册表尚未落定，拒绝取页".to_string());
    };
    let origin = normalize_origin(url).ok_or_else(|| format!("目标 URL 无效：{url}"))?;
    if set.contains(&origin) {
        Ok(())
    } else {
        Err(format!("目标 origin 不在源白名单内：{origin}"))
    }
}

/// 前端推送生效注册表的 origins（规范化后存入 Rust 侧状态）。
#[tauri::command]
pub fn source_allowlist_set(origins: Vec<String>) {
    let set: HashSet<String> = origins.iter().filter_map(|o| normalize_origin(o)).collect();
    if let Ok(mut guard) = SOURCE_ALLOWLIST.write() {
        *guard = Some(set);
    }
}

/// 取一个外部站点页面并以文本返回（UTF-8 lossy）。
/// 签名：source_fetch(url: string, headers?: Record<string, string>)
///   -> Promise<string>；失败 reject 为错误字符串（HTTP 状态/策略拒绝/
///   超限/头无效/白名单拒绝）。只许 http/https（由生产栈 parse_target
///   校验）；目标 origin 必须在生效注册表白名单内、请求头只放行白名单。
#[tauri::command]
pub async fn source_fetch(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<String, String> {
    {
        let guard = SOURCE_ALLOWLIST
            .read()
            .map_err(|_| "源白名单状态异常".to_string())?;
        check_origin_allowed(guard.as_ref(), &url)?;
    }
    let headers: Vec<(String, String)> = headers
        .unwrap_or_default()
        .into_iter()
        .collect();
    let headers = filter_source_headers(headers)?;
    crate::net::fetch_page_text_with_headers(&url, &headers).await
}

#[cfg(test)]
mod tests {
    use super::{check_origin_allowed, filter_source_headers, normalize_origin};
    use std::collections::HashSet;

    fn pairs(v: &[(&str, &str)]) -> Vec<(String, String)> {
        v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    /* D6.1 头白名单：Cookie/Authorization 等敏感头一律丢弃，
     * Referer/User-Agent/Accept/Accept-Language 保留（大小写不敏感）；
     * Host/Content-Length 沿用原有禁令（报错，不静默放行）。 */
    #[test]
    fn header_allowlist_drops_sensitive_keeps_referer() {
        let out = filter_source_headers(pairs(&[
            ("Cookie", "sid=secret"),
            ("Authorization", "Bearer x"),
            ("Origin", "https://evil.example"),
            ("Referer", "https://swag.live/"),
            ("user-agent", "HGhubX/test"),
            ("ACCEPT", "text/html"),
            ("Accept-Language", "zh-CN"),
            ("X-Custom", "1"),
        ]))
        .expect("白名单内头应通过");
        let names: Vec<&str> = out.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["Referer", "user-agent", "ACCEPT", "Accept-Language"]);
        assert!(out.iter().all(|(n, _)| n.to_lowercase() != "cookie" && n.to_lowercase() != "authorization"));
    }

    #[test]
    fn header_allowlist_keeps_host_content_length_ban() {
        assert!(filter_source_headers(pairs(&[("Host", "evil.example")])).is_err());
        assert!(filter_source_headers(pairs(&[("content-length", "5")])).is_err());
    }

    /* D6.2 origin 白名单：名单未设置 → 拒绝（启动竞态最小风险语义）；
     * 名单内放行、名单外拒绝；origin 规范化统一 scheme://host:port
     * （默认端口省略，与前端 URL.origin 口径一致）。 */
    #[test]
    fn origin_allowlist_unset_rejects_and_set_enforces() {
        assert!(check_origin_allowed(None, "https://swag.live/page").is_err(), "名单未设置必须拒绝");
        let set: HashSet<String> = ["https://swag.live".to_string()].into_iter().collect();
        assert!(check_origin_allowed(Some(&set), "https://swag.live/video/1").is_ok(), "名单内放行");
        assert!(check_origin_allowed(Some(&set), "https://evil.example/phish").is_err(), "名单外拒绝");
        assert!(check_origin_allowed(Some(&set), "http://swag.live/video/1").is_err(), "scheme 不同视为不同 origin");
    }

    #[test]
    fn origin_normalization_matches_url_origin() {
        assert_eq!(normalize_origin("https://swag.live").as_deref(), Some("https://swag.live"));
        assert_eq!(normalize_origin("https://swag.live:443/x").as_deref(), Some("https://swag.live"));
        assert_eq!(normalize_origin("http://127.0.0.1:8080/a").as_deref(), Some("http://127.0.0.1:8080"));
        assert_eq!(normalize_origin("not a url"), None);
    }
}
