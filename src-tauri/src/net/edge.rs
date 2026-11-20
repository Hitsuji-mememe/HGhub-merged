use super::client::{client_for, get_with_dns, get_with_headers, post_with_headers};
use super::line::{base, normalize_base, trusted_auth_origin};
use super::redact::{err_text, heal_client};
use super::{MEDIA_DNS_ROUTES, NEXT_EDGE, NEXT_REQUEST};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use crate::network_policy;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub(super) fn retryable_error(error: &str) -> bool {
    if error == "401" {
        return false;
    }
    if let Some(status) = error
        .strip_prefix("HTTP ")
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse::<u16>().ok())
    {
        return matches!(status, 408 | 425 | 429 | 500..=599);
    }
    !matches!(
        crate::playback_log::error_kind(error),
        "https_downgrade_denied"
            | "private_address_denied"
            | "target_policy_denied"
            | "redirect_error"
    )
}

/// 只重试可能恢复的错误；404/权限错误/安全拒绝直接结束，避免无效等待。
/// 站点偶发 TLS 抖动；碰上代理隧道错误就先重建客户端再试
/// （代理软件开关后旧客户端会一直卡在 tunnel error 上）。
pub(super) async fn with_retry<F, Fut, T>(retry: bool, mut f: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let mut last = String::from("network error");
    let attempts = if retry { 3 } else { 1 };
    for attempt in 0..attempts {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last = e;
                if !retryable_error(&last) {
                    return Err(last);
                }
                heal_client(&last);
                if attempt + 1 < attempts {
                    tokio::time::sleep(Duration::from_millis(350 * (attempt as u64 + 1))).await;
                }
            }
        }
    }
    Err(last)
}

// 只记录固定的操作类型，不写搜索词、账号、内容 ID 或查询参数。
pub(super) fn edge_operation(path: &str) -> &'static str {
    let path = path.split('?').next().unwrap_or("");
    if path.starts_with("/api/videos/category/") {
        "category"
    } else if path.starts_with("/api/videos/") && path.ends_with("/play") {
        "play"
    } else if path == "/api/videos" {
        "feed"
    } else if path.starts_with("/api/videos/") {
        "video"
    } else if path == "/api/posts" {
        "posts"
    } else if path.starts_with("/api/posts/") {
        "post"
    } else if path.starts_with("/api/ranks/") {
        "rank"
    } else if path == "/api/search" {
        "search"
    } else if path.starts_with("/api/account/") {
        "account"
    } else {
        "other"
    }
}

/// 仅无请求体、无凭据的逻辑 GET 可以迁移网关；信封本身仍使用 POST。
pub(crate) fn edge_redirect_target(
    current: &url::Url,
    status: u16,
    location: &str,
    guest_get: bool,
) -> Result<url::Url, String> {
    if !guest_get || !matches!(status, 301 | 302 | 303) {
        return Err("业务接口重定向已拒绝".into());
    }
    network_policy::redirect_target(current, location)
}

/// 业务请求：走边缘信封。
pub async fn edge(
    origin: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> Result<Value, String> {
    let cur = normalize_base(origin).ok_or("业务请求必须使用安全 HTTPS 线路")?;
    if network_policy::strict_security()
        && (token.is_some()
            || matches!(
                path,
                "/api/account/loginByPassword" | "/api/account/registerByPassword"
            ))
        && !trusted_auth_origin(&cur)
    {
        if cur != base() || crate::lines::verify_published_origin(&cur).await.is_err() {
            return Err("镜像线路仅供游客浏览；登录/注册请切换到固定线路或重新加载发布页验证镜像".into());
        }
    }
    let (encoded, ctype) = match &body {
        Some(v) => (
            B64.encode(serde_json::to_vec(v).map_err(|e| e.to_string())?),
            "application/json",
        ),
        None => (String::new(), ""),
    };
    let envelope = json!({
        "method": method,
        "path": path,
        "body": encoded,
        "content_type": ctype,
    });

    let url = format!("{cur}/api/edge/request");
    let referer = format!("{cur}/");
    let token = token.map(|s| s.to_string());

    let request = NEXT_EDGE.fetch_add(1, Ordering::Relaxed);
    let line_host = url::Url::parse(&cur)
        .unwrap()
        .host_str()
        .unwrap()
        .to_string();
    let operation = edge_operation(path);
    let mut attempt = 0;
    let guest_get = method.eq_ignore_ascii_case("GET") && body.is_none() && token.is_none();
    let can_retry = method.eq_ignore_ascii_case("GET") && body.is_none();
    let value = with_retry(can_retry, || {
        attempt += 1;
        let attempt = attempt;
        let envelope = envelope.clone();
        let token = token.clone();
        let url = url.clone();
        let referer = referer.clone();
        let line_host = line_host.clone();
        async move {
            let started = Instant::now();
            crate::playback_log::record("api.begin", json!({"request": request, "attempt": attempt, "operation": operation, "method": method, "line_host": line_host}));
            let mut status_code = None;
            let mut headers_ms = None;
            let mut target_host = line_host.clone();
            let mut response_kind = "unknown";
            let mut gateway = "other";
            let result = async {
                let mut next = network_policy::parse_target(&url)?;
                for hop in 0..=5 {
                    let (target, client) = client_for(next.as_str()).await?;
                    target_host = target.host_str().unwrap_or("").to_string();
                    let mut req = client
                        .post(target.clone())
                        .header("Accept", "application/json")
                        .header("Referer", &referer)
                        .json(&envelope);
                    if let Some(t) = token.as_deref() {
                        if !t.is_empty() {
                            req = req.header("Authorization", format!("Bearer {t}"));
                        }
                    }
                    let resp = req.send().await.map_err(|e| err_text(&e))?;
                    let status = resp.status();
                    status_code = Some(status.as_u16());
                    headers_ms = Some(started.elapsed().as_millis() as u64);
                    let ctype = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
                    response_kind = if ctype.contains("json") { "json" } else if ctype.contains("html") { "html" } else { "other" };
                    gateway = if resp.headers().contains_key("x-amz-cf-id") { "cloudfront" } else if resp.headers().contains_key("cf-ray") { "cloudflare" } else { "other" };
                    // 逐跳重建并检查客户端；不自动把信封 POST 改成无信封 GET。
                    if status.is_redirection() {
                        if hop == 5 {
                            return Err("重定向次数超过限制".into());
                        }
                        let location = resp
                            .headers()
                            .get(reqwest::header::LOCATION)
                            .and_then(|h| h.to_str().ok())
                            .ok_or("重定向缺少有效 Location")?;
                        next = edge_redirect_target(&target, status.as_u16(), location, guest_get)?;
                        continue;
                    }
                    let text = resp.text().await.map_err(|e| err_text(&e))?;
                    if status.as_u16() == 401 || status.as_u16() == 403 {
                        return Err("401".to_string());
                    }
                    if !status.is_success() {
                        return Err(format!(
                            "HTTP {status}: {}",
                            text.chars().take(160).collect::<String>()
                        ));
                    }
                    if text.trim().is_empty() {
                        return Ok(Value::Null);
                    }
                    return serde_json::from_str::<Value>(&text)
                        .map_err(|e| format!("{e}: {}", text.chars().take(160).collect::<String>()));
                }
                Err("重定向次数超过限制".into())
            }.await;
            crate::playback_log::record("api.end", json!({
                "request": request, "attempt": attempt, "operation": operation, "method": method,
                "line_host": line_host, "target_host": target_host, "status": status_code,
                "headers_ms": headers_ms, "elapsed_ms": started.elapsed().as_millis() as u64,
                "response_kind": response_kind, "gateway": gateway,
                "business_status": result.as_ref().ok().and_then(|v: &Value| v.get("status")).and_then(Value::as_i64),
                "error_kind": result.as_ref().err().map(|e: &String| crate::playback_log::error_kind(e)),
                "retryable": can_retry && result.as_ref().err().is_some_and(|e| retryable_error(e)),
            }));
            result
        }
    })
    .await?;

    if value.is_null() {
        return Ok(Value::Null);
    }

    if value.get("status").and_then(|v| v.as_i64()) == Some(1) {
        Ok(value.get("data").cloned().unwrap_or(Value::Null))
    } else {
        Err(value
            .get("msg")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("接口返回失败")
            .to_string())
    }
}

/// 多源适配器取页的响应体上限：与清单/API 同档（4MB，audit6 P2-13 口径）。
pub const PAGE_TEXT_MAX_BYTES: usize = 4 * 1024 * 1024;

/// 取页上限的定向例外（Muse 2026-11-19 fix330-hanime-api）：Hanime
/// guest 目录端点 /api/v11/search_hvs 是全量目录单发（无服务端分页，
/// 参数被忽略——2026-11-19 本机实测恒回全量），实测体量 4.5MB 已超
/// 全局 4MB；其官方客户端自带 12MB 守卫。仅当 (origin, path) 恰为该
/// 端点时上限取 12MB，其余一切取页仍 4MB——不是全局放宽。
pub const HANIME_CATALOG_ORIGIN: &str = "https://guest.freeanimehentai.net";
pub const HANIME_CATALOG_PATH: &str = "/api/v11/search_hvs";
pub const HANIME_CATALOG_MAX_BYTES: usize = 12 * 1024 * 1024;

pub fn page_text_cap(url: &str) -> usize {
    if let Ok(parsed) = url::Url::parse(url) {
        if parsed.origin().ascii_serialization() == HANIME_CATALOG_ORIGIN
            && parsed.path() == HANIME_CATALOG_PATH
        {
            return HANIME_CATALOG_MAX_BYTES;
        }
    }
    PAGE_TEXT_MAX_BYTES
}

/// 流式累计器：逐块追加，累计超过上限立即报错中断，不整段读入内存。
pub(crate) struct CappedBody {
    buf: Vec<u8>,
    cap: usize,
}

impl CappedBody {
    pub(crate) fn new(cap: usize) -> Self {
        Self { buf: Vec::new(), cap }
    }

    pub(crate) fn push(&mut self, chunk: &[u8]) -> Result<(), String> {
        if self.buf.len() + chunk.len() > self.cap {
            return Err(format!("响应体超过 {} 字节上限", self.cap));
        }
        self.buf.extend_from_slice(chunk);
        Ok(())
    }

    pub(crate) fn into_bytes(self) -> Vec<u8> {
        self.buf
    }
}

/// 多源适配器取页（audit6 模块化与源注册表节）：只走生产网络栈——
/// get_with_dns 内含 parse_target_with_mode 目标校验（禁内网/回环/内部
/// 主机名）、DNS 固定与逐跳重定向复检，本函数不另开任何旁路客户端；
/// 响应体流式累计、上限 4MB 超限报错；正文按 UTF-8 lossy 返回。
pub async fn fetch_page_text(url: &str) -> Result<String, String> {
    fetch_page_text_with_headers(url, &[]).await
}

/// 同 fetch_page_text，另带适配器请求头（如 Referer/User-Agent）。
/// 头在此处先校验：名称/值必须能解析为合法 HTTP 头（禁控制字符与
/// CRLF 注入）；Host 与 Content-Length 不许覆盖——前者由目标 URL 与
/// DNS 固定决定、后者由实际请求体决定，覆盖都会破坏生产栈契约。
pub async fn fetch_page_text_with_headers(
    url: &str,
    headers: &[(String, String)],
) -> Result<String, String> {
    let mut validated: Vec<(String, String)> = Vec::with_capacity(headers.len());
    for (name, value) in headers {
        let parsed_name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("请求头名称无效：{name}"))?;
        if parsed_name == reqwest::header::HOST || parsed_name == reqwest::header::CONTENT_LENGTH {
            return Err(format!("请求头不许覆盖：{name}"));
        }
        reqwest::header::HeaderValue::from_str(value)
            .map_err(|_| format!("请求头值无效：{name}"))?;
        validated.push((name.clone(), value.clone()));
    }
    let cap = page_text_cap(url);
    let mut resp = get_with_headers(url, Duration::from_secs(20), &validated).await?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    if resp.content_length().is_some_and(|n| n > cap as u64) {
        return Err(format!("响应体超过 {} 字节上限", cap));
    }
    let mut body = CappedBody::new(cap);
    while let Some(chunk) = resp.chunk().await.map_err(|e| err_text(&e))? {
        body.push(&chunk)?;
    }
    Ok(String::from_utf8_lossy(&body.into_bytes()).into_owned())
}

/// 定向 POST 取页（Muse 2026-11-19 fix330-hanime-api）：只供
/// api::source::source_post 调用，origin/头名单已在命令层按
/// HANIME_AUTH_ORIGIN 定向校验完毕。返回 (HTTP 状态, x-token 响应头,
/// 正文)——状态不折叠成错误：握手端点的失败形态（CSRF 失效需重取
/// 后重试一次）要由适配器读正文 error_id 判读；x-token 是全仓唯一
/// 被回传的响应头，且只在该定向通道出现。响应体仍走 4MB 流式上限，
/// 不跟重定向。正文/令牌一律不入日志（不变量 10）。
pub async fn fetch_page_post(
    url: &str,
    request_body: &str,
    headers: &[(String, String)],
) -> Result<(u16, Option<String>, String), String> {
    let mut validated: Vec<(String, String)> = Vec::with_capacity(headers.len());
    for (name, value) in headers {
        let parsed_name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("请求头名称无效：{name}"))?;
        if parsed_name == reqwest::header::HOST || parsed_name == reqwest::header::CONTENT_LENGTH {
            return Err(format!("请求头不许覆盖：{name}"));
        }
        reqwest::header::HeaderValue::from_str(value)
            .map_err(|_| format!("请求头值无效：{name}"))?;
        validated.push((name.clone(), value.clone()));
    }
    let mut resp = post_with_headers(url, request_body, Duration::from_secs(20), &validated).await?;
    let status = resp.status().as_u16();
    let x_token = resp
        .headers()
        .get("x-token")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    if resp.content_length().is_some_and(|n| n > PAGE_TEXT_MAX_BYTES as u64) {
        return Err(format!("响应体超过 {} 字节上限", PAGE_TEXT_MAX_BYTES));
    }
    let mut body = CappedBody::new(PAGE_TEXT_MAX_BYTES);
    while let Some(chunk) = resp.chunk().await.map_err(|e| err_text(&e))? {
        body.push(&chunk)?;
    }
    Ok((status, x_token, String::from_utf8_lossy(&body.into_bytes()).into_owned()))
}

/// fetch_bytes 的默认流式上限（分片档，P2-13 资源类分档：分片
/// 16MB/图片 8MB/清单与 API 4MB）：旧实现 resp.bytes() 整段读入、
/// 无 Content-Length 预检也无分块上限，服务器回全量体时内存峰值
/// 不受控。现统一流式累计、超限中断报错。
pub const FETCH_BYTES_MAX: usize = 16 * 1024 * 1024;

/// 拉原始字节（图片 / m3u8 / 分片），保留重定向后的最终 URL。
pub async fn fetch_bytes(url: &str) -> Result<(Option<String>, Vec<u8>), String> {
    fetch_bytes_with_url(url).await.map(|(_, ctype, bytes)| (ctype, bytes))
}

/// 同 fetch_bytes，按调用方资源类指定流式上限（如图片 8MB）。
pub async fn fetch_bytes_capped(url: &str, max_bytes: usize) -> Result<(Option<String>, Vec<u8>), String> {
    fetch_bytes_with_url_cap(url, max_bytes).await.map(|(_, ctype, bytes)| (ctype, bytes))
}

pub async fn fetch_bytes_with_url(url: &str) -> Result<(String, Option<String>, Vec<u8>), String> {
    fetch_bytes_with_url_cap(url, FETCH_BYTES_MAX).await
}

/// 媒体字节抓取的 Referer 候选链（Muse 2026-11-20 fix331/gallery-device，
/// 3.3.1 真机图集全灭定性）：旧实现对一切目标无条件发当前线路 base 的
/// Referer——这是为原生源 CDN 的防盗链设的（它只认本站 Referer）。但
/// 外部源图床的防盗链口径相反：空 Referer 与本站 Referer 放行、**外站
/// Referer 一律 403**（source-006 图床实测：jpg 受保护、webp 豁免，
/// 故真机形态为「首图恰为 webp 独活、其余 jpg 全 403」；403 不可重试，
/// /img 回 502，Img 三次 attempt 每次重进抓取栈每次 403、终局 HG）。
/// 故候选链：①线路 base（与旧行为逐字一致，原生源路径零变化）；
/// ②目标自身 origin（模拟本站页面嵌图，满足「只认本站」型防盗链）；
/// ③不带 Referer（满足「空放行」型）。仅 HTTP 403 触发换候选——403
/// 正是防盗链的拒绝形态；其余错误维持既有重试语义、不换候选。
/// 防盗链还有第二种拒绝形态（fix336/014-image，source-014 实证）：
/// 外站 Referer 触发 307 跳到帖子 HTML 页，跟随重定向后是 200＋
/// HTML 文档、不是错误状态——只认 403 会把整页 HTML 当媒体字节
/// 收下（详情图查看器空白、字节数却像成功）。故响应体为 HTML
/// 文档时与 403 同等对待：换下一候选；末候选仍是 HTML 则如实
/// 报错，不把文档冒充媒体字节交给调用方。
pub(super) fn media_referer_candidates(raw: &str) -> Vec<Option<String>> {
    let base_ref = format!("{}/", base());
    let mut out: Vec<Option<String>> = vec![Some(base_ref.clone())];
    if let Ok(parsed) = url::Url::parse(raw) {
        let own = format!("{}/", parsed.origin().ascii_serialization());
        if own != base_ref {
            out.push(Some(own));
        }
    }
    out.push(None);
    out
}

/// 响应体是否为 HTML 文档：跳过 BOM 与前导空白后以 `<!doctype`
/// 或 `<html` 开头（不分大小写）。媒体字节（图片魔数、#EXTM3U
/// 清单、TS 分片 0x47）恒不命中；空体不命中（维持既有语义）。
/// pub(crate)（fix337/video-resolve 起）：media 层 /seg 整形与
/// range 直拉路径共用同一判别，不另写第二份。
pub(crate) fn is_html_document(bytes: &[u8]) -> bool {
    let mut s = bytes;
    if s.starts_with(&[0xEF, 0xBB, 0xBF]) {
        s = &s[3..];
    }
    while let Some((&b, rest)) = s.split_first() {
        if matches!(b, b' ' | b'\t' | b'\r' | b'\n') {
            s = rest;
        } else {
            break;
        }
    }
    let head: Vec<u8> = s.iter().take(9).map(|b| b.to_ascii_lowercase()).collect();
    head.starts_with(b"<!doctype") || head.starts_with(b"<html")
}

fn is_http_403(error: &str) -> bool {
    error
        .strip_prefix("HTTP ")
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse::<u16>().ok())
        == Some(403)
}

async fn fetch_bytes_with_url_cap(url: &str, max_bytes: usize) -> Result<(String, Option<String>, Vec<u8>), String> {
    let candidates = media_referer_candidates(url);
    let last_index = candidates.len() - 1;
    for (i, referer) in candidates.iter().enumerate() {
        match fetch_bytes_with_referer(url, max_bytes, referer.as_deref()).await {
            Ok(v) => {
                /* 防盗链第二形态（fix336/014-image）：200＋HTML 文档
                 * 不是媒体字节——与 403 同等换候选，末候选如实报错。 */
                if is_html_document(&v.2) {
                    if i == last_index {
                        return Err("响应为 HTML 文档而非媒体字节（疑似防盗链跳转）".to_string());
                    }
                    crate::playback_log::record(
                        "network.referer_fallback",
                        json!({"resource": crate::playback_log::resource_id(url), "candidate": i + 1}),
                    );
                    continue;
                }
                return Ok(v);
            }
            Err(e) => {
                if i == last_index || !is_http_403(&e) {
                    return Err(e);
                }
                crate::playback_log::record(
                    "network.referer_fallback",
                    json!({"resource": crate::playback_log::resource_id(url), "candidate": i + 1}),
                );
            }
        }
    }
    unreachable!("候选链至少含一项且末项必返回")
}

async fn fetch_bytes_with_referer(url: &str, max_bytes: usize, referer: Option<&str>) -> Result<(String, Option<String>, Vec<u8>), String> {
    let request = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed);
    let resource = crate::playback_log::resource_id(url);
    let mut attempt = 0;
    let url = url.to_string();
    let target = url::Url::parse(&url).ok();
    let host = target.as_ref().and_then(|target| target.host_str()).unwrap_or("").to_string();
    let public_dns = AtomicBool::new(MEDIA_DNS_ROUTES.lock().ok()
        .is_some_and(|routes| routes.prefers_public(&host, Instant::now())));
    let referer = referer.map(str::to_string);
    with_retry(true, || {
        attempt += 1;
        let attempt = attempt;
        let resource = resource.clone();
        let url = url.clone();
        let referer = referer.clone();
        let host = &host;
        let target = &target;
        let public_dns = &public_dns;
        async move {
            let using_public_dns = public_dns.load(Ordering::Relaxed);
            let started = Instant::now();
            crate::playback_log::record("network.begin", json!({"request": request, "resource": resource, "attempt": attempt}));
            let mut status = None;
            let mut headers_ms = None;
            let result = async {
                let mut resp = get_with_dns(&url, Duration::from_secs(20), None, referer.as_deref(), using_public_dns).await?;
                status = Some(resp.status().as_u16());
                headers_ms = Some(started.elapsed().as_millis() as u64);
                if !resp.status().is_success() {
                    return Err(format!("HTTP {}", resp.status()));
                }
                let final_url = resp.url().to_string();
                let ctype = resp
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());
                if resp.content_length().is_some_and(|n| n > max_bytes as u64) {
                    return Err(format!("响应体超过 {} 字节上限", max_bytes));
                }
                let mut body = CappedBody::new(max_bytes);
                while let Some(chunk) = resp.chunk().await.map_err(|e| err_text(&e))? {
                    body.push(&chunk)?;
                }
                Ok((final_url, ctype, body.into_bytes()))
            }.await;
            if using_public_dns {
                if let Ok(mut routes) = MEDIA_DNS_ROUTES.lock() {
                    if result.is_ok() {
                        routes.remember(host, Instant::now());
                    } else {
                        routes.forget(host);
                    }
                }
            }
            if let Err(error) = &result {
                if target.as_ref().is_some_and(|target| !super::client::proxy_active(target) && crate::media_dns::eligible(target, error)) {
                    public_dns.store(!using_public_dns, Ordering::Relaxed);
                    crate::playback_log::record("network.dns_fallback", json!({"resource": resource, "attempt": attempt, "public_dns": !using_public_dns, "error_kind": crate::playback_log::error_kind(error)}));
                }
            }
            crate::playback_log::record("network.end", json!({"request": request, "resource": resource, "attempt": attempt, "public_dns": using_public_dns, "status": status, "headers_ms": headers_ms, "elapsed_ms": started.elapsed().as_millis() as u64, "bytes": result.as_ref().ok().map(|(_, _, bytes)| bytes.len()), "error_kind": result.as_ref().err().map(|e: &String| crate::playback_log::error_kind(e))}));
            result
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /* 多源取页的目标校验走生产栈 parse_target_with_mode：内网/回环/
     * 本机主机名在发出任何请求前就被拒（字面 IP 与 localhost 都不
     * 需要真实网络即可判定）。 */
    #[tokio::test]
    async fn page_text_rejects_private_and_loopback_targets() {
        for raw in [
            "http://127.0.0.1/admin",
            "https://192.168.1.1/page",
            "https://10.0.0.5/page",
            "https://[::1]/page",
            "https://localhost/page",
            "https://nas.local/page",
        ] {
            assert!(fetch_page_text(raw).await.is_err(), "{raw} 必须被目标校验拒绝");
        }
    }

    /* fix330-hanime-api：取页上限定向例外只认 (guest origin,
     * /api/v11/search_hvs) 精确一对——同 origin 其他路径、带查询的
     * 同路径（查询不改 path、仍属该端点）、仿冒子域一律回 4MB。 */
    #[test]
    fn page_text_cap_scoped_to_hanime_catalog_endpoint() {
        assert_eq!(page_text_cap("https://guest.freeanimehentai.net/api/v11/search_hvs"), HANIME_CATALOG_MAX_BYTES);
        assert_eq!(page_text_cap("https://guest.freeanimehentai.net/api/v11/videos/1/comments"), PAGE_TEXT_MAX_BYTES);
        assert_eq!(page_text_cap("https://guest.freeanimehentai.net.evil.example/api/v11/search_hvs"), PAGE_TEXT_MAX_BYTES);
        assert_eq!(page_text_cap("https://hanime.tv/api/v11/search_hvs"), PAGE_TEXT_MAX_BYTES);
        assert_eq!(page_text_cap("not a url"), PAGE_TEXT_MAX_BYTES);
    }

    /* fix331/gallery-device：媒体 Referer 候选链——外站目标必须含
     * 「目标自身 origin」与「不带 Referer」两个后备（防盗链 403 的唯
     * 二解法形态），且首候选恒为线路 base（旧行为零变化）；与 base
     * 同源的目标不重复加候选。旧实现只有单一 base Referer，此断言
     * 在旧码上无对应函数即红。 */
    #[test]
    fn media_referer_candidates_cover_anti_hotlink_shapes() {
        let base_ref = format!("{}/", base());
        let foreign = media_referer_candidates("https://images.example.net/a/b.jpg");
        assert_eq!(
            foreign,
            vec![Some(base_ref.clone()), Some("https://images.example.net/".to_string()), None],
            "外站目标：base → 自身 origin → 空，三候选齐备且顺序固定"
        );
        let own = media_referer_candidates(&format!("{base_ref}cover/x.jpg"));
        assert_eq!(own.first(), Some(&Some(base_ref)), "同源目标首候选仍是 base");
        assert_eq!(own.iter().filter(|c| c.is_some()).count(), 1, "同源不重复加自身 origin 候选");
        assert_eq!(own.last(), Some(&None), "末候选恒为不带 Referer");
        let invalid = media_referer_candidates("not a url");
        assert_eq!(invalid, vec![Some(format!("{}/", base())), None], "不可解析目标只留 base＋空");
        assert!(is_http_403("HTTP 403"));
        assert!(!is_http_403("HTTP 404"));
        assert!(!is_http_403("HTTP 503"));
        assert!(!is_http_403("请求超时"));
    }

    /* fix336/014-image：HTML 文档判别真值——防盗链 307 跳回的帖子页
     * （200＋HTML）必须命中并触发候选链换候选；图片魔数、清单、
     * TS 分片、空体不命中（媒体字节零误伤）。旧码无此判别、HTML
     * 被当图片字节收下（source-014 详情图空白），此断言在旧码上
     * 无对应函数即红。 */
    #[test]
    fn html_document_detection_matches_media_shapes() {
        assert!(is_html_document(b"<!DOCTYPE html>\n<html lang=\"en\">"));
        assert!(is_html_document(b"<!doctype html>"));
        assert!(is_html_document(b"  \r\n\t<html>"));
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice(b"<!DOCTYPE html>");
        assert!(is_html_document(&bom));
        assert!(!is_html_document(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]));
        assert!(!is_html_document(b"\x89PNG\r\n\x1a\n"));
        assert!(!is_html_document(b"#EXTM3U\n#EXT-X-VERSION:3"));
        assert!(!is_html_document(&[0x47, 0x40, 0x11, 0x10]));
        assert!(!is_html_document(b""));
        assert!(!is_html_document(b"<htm"));
    }

    /* 流式上限：恰好 4MB 可过，累计越线立即报错（分块到达也一样）。 */
    #[test]
    fn capped_body_enforces_streaming_limit() {
        let mut body = CappedBody::new(PAGE_TEXT_MAX_BYTES);
        body.push(&vec![0u8; PAGE_TEXT_MAX_BYTES - 1]).unwrap();
        body.push(&[1]).unwrap();
        assert_eq!(body.buf.len(), PAGE_TEXT_MAX_BYTES);
        assert!(body.push(&[1]).is_err(), "越线一块必须报错");
        let mut small = CappedBody::new(8);
        assert!(small.push(&[0u8; 9]).is_err(), "单块越线必须报错");
        small.push(&[0u8; 8]).unwrap();
        assert_eq!(small.into_bytes().len(), 8);
    }
}
