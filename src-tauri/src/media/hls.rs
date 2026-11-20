//! HLS playlist fetch and rewrite.

use crate::net::fetch_bytes_with_url;
use once_cell::sync::Lazy;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use std::collections::HashMap;
use std::sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex, Weak};
use std::time::Duration;

static PL_CACHE: Lazy<Mutex<HashMap<String, Arc<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static PL_CACHE_GENERATION: AtomicU64 = AtomicU64::new(0);
const PL_CACHE_MAX: usize = 60;

/* 清单在途合并（fix338 签名③）：与分片 SEG coalesce 同实现
 * （media::segment::coalesce），同 URL 同时只飞一条取数链——
 * hls.js 的清单重试与播放器恢复重入此前各开一条 3×20s 链
 * 叠加等待。失败 cell 立即摘除，后来者可重试（coalesce 语义）。 */
static PL_LOADING: Lazy<
    Mutex<HashMap<String, Weak<tokio::sync::OnceCell<Result<Arc<String>, String>>>>>,
> = Lazy::new(|| Mutex::new(HashMap::new()));

/* 清单腿总截止（fix338 签名③）：15 秒，含全部候选与重试。
 * 此前取数链只有 attempt 级 20s 超时（with_retry 3 次叠加
 * ≈60s+）、load_playlist 无总预算，hls.js 侧 20s 超时又只中止
 * WebView 等待、Rust 链继续跑——上游慢/挂时全链无一处有义务
 * 在有界时间内给结论（3.3.7 真机 mount 后 24 秒无清单、无
 * 留痕）。15s 小于 hls.js 的 manifestLoadingTimeOut（20s），
 * 让失败由 Rust 层先于播放器超时以可分类的 502 给出。 */
const PLAYLIST_DEADLINE: Duration = Duration::from_secs(15);

/* ───────────────────────── HLS ───────────────────────── */

pub(super) fn enc(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

pub(super) fn dec(s: &str) -> String {
    percent_decode_str(s).decode_utf8_lossy().to_string()
}

fn absolutize(base: &str, target: &str) -> String {
    if target.starts_with("http://") || target.starts_with("https://") {
        return target.to_string();
    }
    if let Ok(b) = url::Url::parse(base) {
        if let Ok(j) = b.join(target) {
            return j.to_string();
        }
    }
    target.to_string()
}

/// 属性列表中的引号内可含逗号，不能直接 split(',')。
fn hls_attributes(line: &str) -> Option<(&str, Vec<&str>)> {
    let (tag, rest) = line.split_once(':')?;
    let mut attributes = Vec::new();
    let mut quoted = false;
    let mut start = 0;
    for (i, ch) in rest.char_indices() {
        if ch == '"' {
            quoted = !quoted;
        }
        if ch == ',' && !quoted {
            attributes.push(&rest[start..i]);
            start = i + 1;
        }
    }
    attributes.push(&rest[start..]);
    Some((tag, attributes))
}

fn map_uri_attributes(line: &str, mut rewrite: impl FnMut(&str) -> String) -> String {
    let Some((tag, attributes)) = hls_attributes(line) else { return line.to_string(); };
    let mapped: Vec<String> = attributes.into_iter().map(|attribute| {
        if let Some((key, value)) = attribute.split_once('=') {
            if key.trim().to_ascii_uppercase().ends_with("URI") {
                if let Some(uri) = value.trim().strip_prefix('"').and_then(|v| v.strip_suffix('"')) {
                    return format!("{}=\"{}\"", key.trim(), rewrite(uri));
                }
            }
        }
        attribute.to_string()
    }).collect();
    format!("{tag}:{}", mapped.join(","))
}

fn rewrite_uri_attr(line: &str, prefix: &str) -> String {
    map_uri_attributes(line, |uri| format!("{prefix}/seg?u={}", enc(uri)))
}

/// HLS 清单魔数判别（fix338 签名①）：字节以 #EXTM3U 开头（容忍
/// 一个 BOM 前缀），与 load_playlist 既有校验同一口径。
/// load_playlist 与 media::response::segment_response 共用这一份
/// 实现——变体清单腿此前只有 ctype 判读、从不复验魔数，非清单
/// 体被当清单 200 交给 hls.js（levelParsingError）。
pub(super) fn is_playlist_bytes(bytes: &[u8]) -> bool {
    let body = bytes
        .strip_prefix(&[0xEF, 0xBB, 0xBF])
        .unwrap_or(bytes);
    body.starts_with(b"#EXTM3U")
}

/// 清单腿失败留痕（fix338 签名③）：与适配器 source.resolve_fail
/// 同构（source/segment/code/status/attempt），进诊断导出「取流
/// 失败留痕」同一节。此前该节只消费适配器 resolve() 段事件，
/// 清单腿失败/挂起不发事件、media::handle 的 proxy.end 又以
/// handle 返回为前提——挂起即整场无痕。source 用目标的稳定
/// 资源编号（清单腿在 Rust 媒体层、无适配器编号上下文，与
/// network.target_failed 的 resource 口径一致），segment 恒
/// manifest，code 取 playback_log::error_kind 的固定分类，
/// HTTP 状态从「HTTP nnn」形态错误文本提取（与适配器侧
/// resolveTrace.httpStatusOf 同口径）。纯旁路，不影响错误本身。
fn record_manifest_failure(url: &str, error: &str) {
    crate::playback_log::record("source.resolve_fail", manifest_failure_event(url, error));
}

/// 事件数据组装（纯函数，形状与适配器 resolveFailureEventData
/// 同键集合：source/segment/code[/status]/attempt）。
fn manifest_failure_event(url: &str, error: &str) -> serde_json::Value {
    let status = error
        .strip_prefix("HTTP ")
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse::<u16>().ok());
    serde_json::json!({
        "source": crate::playback_log::resource_id(url),
        "segment": "manifest",
        "code": crate::playback_log::error_kind(error),
        "status": status,
        "attempt": 0,
    })
}

/// 取 m3u8 并把 key / 分片地址改写到本地协议。
pub async fn load_playlist(url: &str, prefix: &str) -> Result<Arc<String>, String> {
    // 缓存 key 要带请求作用域与 prefix：同一份 m3u8 在不同 scheme 或配置代次下不混用
    let req_scope = crate::net::request_scope();
    let generation = PL_CACHE_GENERATION.load(Ordering::Acquire);
    let cache_key = format!("{}:{}:{generation}:{prefix}|{url}", u8::from(req_scope.strict), req_scope.generation);
    if let Some(hit) = PL_CACHE.lock().unwrap().get(&cache_key).cloned() { return Ok(hit); }
    super::segment::coalesce(&PL_LOADING, cache_key.clone(), || {
        fetch_playlist(url, prefix, cache_key, req_scope, generation)
    })
    .await
}

/// 清单实际取数（single-flight 的飞行体）：总截止包裹整个候选
/// 链取数；解析/魔数失败与取数失败同落 manifest 段留痕。
async fn fetch_playlist(
    url: &str,
    prefix: &str,
    cache_key: String,
    req_scope: crate::net::RequestScope,
    generation: u64,
) -> Result<Arc<String>, String> {
    // 等待 single-flight 期间另一条飞行可能刚写完缓存。
    if let Some(hit) = PL_CACHE.lock().unwrap().get(&cache_key).cloned() {
        return Ok(hit);
    }
    let (final_url, _, bytes) = match tokio::time::timeout(PLAYLIST_DEADLINE, fetch_bytes_with_url(url)).await {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            record_manifest_failure(url, &e);
            return Err(e);
        }
        Err(_) => {
            let e = format!("播放列表加载超时（{} 秒总时限）", PLAYLIST_DEADLINE.as_secs());
            record_manifest_failure(url, &e);
            return Err(e);
        }
    };
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text,
        Err(_) => {
            let e = "播放列表不是 UTF-8 文本".to_string();
            record_manifest_failure(url, &e);
            return Err(e);
        }
    };
    if !is_playlist_bytes(&bytes) {
        let e = "响应不是 HLS 播放列表".to_string();
        record_manifest_failure(url, &e);
        return Err(e);
    }
    let arc = Arc::new(rewrite_playlist(&final_url, text, prefix));
    let mut cache = PL_CACHE.lock().unwrap();
    // clear_caches advances the epoch first; never let an older in-flight
    // playlist repopulate the cache after that clear.
    if PL_CACHE_GENERATION.load(Ordering::Acquire) == generation && crate::net::request_scope() == req_scope {
        if cache.len() >= PL_CACHE_MAX {
            if let Some(key) = cache.keys().next().cloned() { cache.remove(&key); }
        }
        cache.insert(cache_key, arc.clone());
    }
    Ok(arc)
}

pub(super) fn rewrite_playlist(url: &str, text: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(text.len() + 512);
    for raw in text.trim_start_matches('\u{feff}').lines() {
        let line = raw.trim_end();
        if line.is_empty() {
            out.push('\n');
            continue;
        }
        if line.starts_with('#') {
            // 禁用可派生 URL 的内容引导；DATERANGE 保留时间线/SCTE-35 元数据。
            if line.starts_with("#EXT-X-CONTENT-STEERING:") {
                continue;
            }
            if line.starts_with("#EXT-X-DATERANGE:") {
                if let Some((tag, attributes)) = hls_attributes(line) {
                    let safe: Vec<&str> = attributes
                        .into_iter()
                        .filter(|attribute| {
                            let key = attribute
                                .split('=')
                                .next()
                                .unwrap_or("")
                                .trim()
                                .to_ascii_uppercase();
                            !key.contains("URI") && key != "X-ASSET-LIST"
                        })
                        .collect();
                    out.push_str(&format!("{tag}:{}\n", safe.join(",")));
                }
                continue;
            }
            if line.to_ascii_uppercase().contains("URI") && line.contains('"') {
                // KEY/MAP/MEDIA/SESSION-KEY/PART/PRELOAD-HINT 等 URI 都必须经过目标检查。
                let absolute = absolutize_uri_in_attr(url, line);
                out.push_str(&rewrite_uri_attr(&absolute, prefix));
            } else {
                out.push_str(line);
            }
        } else {
            let absolute = absolutize(url, line);
            out.push_str(&format!("{prefix}/seg?u={}", enc(&absolute)));
        }
        out.push('\n');
    }

    out
}

fn absolutize_uri_in_attr(base: &str, line: &str) -> String {
    map_uri_attributes(line, |uri| absolutize(base, uri))
}

pub(super) fn clear_cache() {
    PL_CACHE_GENERATION.fetch_add(1, Ordering::AcqRel);
    if let Ok(mut g) = PL_CACHE.lock() {
        g.clear();
    }
    if let Ok(mut g) = PL_LOADING.lock() {
        g.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::LOCAL_ORIGIN;
    use std::sync::atomic::AtomicUsize;

    /* fix338 签名③：清单腿失败留痕的事件形状——与适配器
     * source.resolve_fail 同键集合（source/segment/code/status/
     * attempt），segment 恒 manifest、source 为目标资源编号、
     * code 为固定错误分类、HTTP 状态只从「HTTP nnn」形态提取。
     * 旧码清单腿不发任何 resolve_fail 事件（留痕节恒无行）。 */
    #[test]
    fn manifest_failure_event_matches_resolve_fail_shape() {
        let timeout = manifest_failure_event(
            "https://cdn.example/list.m3u8",
            "播放列表加载超时（15 秒总时限）",
        );
        assert_eq!(timeout["segment"], "manifest");
        assert_eq!(timeout["code"], "timeout");
        assert_eq!(
            timeout["source"],
            crate::playback_log::resource_id("https://cdn.example/list.m3u8")
        );
        assert_eq!(timeout["attempt"], 0);
        assert!(timeout["status"].is_null());
        let http = manifest_failure_event("https://cdn.example/list.m3u8", "HTTP 503");
        assert_eq!(http["code"], "http_error");
        assert_eq!(http["status"], 503);
    }

    /* fix338 签名③：清单 single-flight——同 key 并发只飞一条
     * 取数（与分片 coalesce 同实现，此处钉清单的 Arc<String>
     * 实例化与失败共享/可重试语义）。旧码 load_playlist 无在途
     * 合并，hls.js 重试与恢复重入各开一条链。 */
    #[tokio::test]
    async fn playlist_flights_share_one_load() {
        let registry: Mutex<
            HashMap<String, Weak<tokio::sync::OnceCell<Result<Arc<String>, String>>>>,
        > = Mutex::new(HashMap::new());
        let calls = AtomicUsize::new(0);
        let (first, second) = tokio::join!(
            super::super::segment::coalesce(&registry, "same-playlist".into(), || async {
                calls.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(20)).await;
                Ok(Arc::new("#EXTM3U".to_string()))
            }),
            super::super::segment::coalesce(&registry, "same-playlist".into(), || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(Arc::new("other".to_string()))
            })
        );
        assert_eq!(first.as_ref().map(|a| a.as_str()), Ok("#EXTM3U"));
        assert_eq!(second.as_ref().map(|a| a.as_str()), Ok("#EXTM3U"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn dateranges_keep_timing_and_scte_metadata_but_drop_external_resources() {
        let line = "#EXTM3U\n#EXT-X-DATERANGE:ID=\"event\",START-DATE=\"2026-11-07T00:00:00Z\",DURATION=4,SCTE35-OUT=0xFC,X-TEXT=\"a,b\",X-ASSET-URI=\"https://evil.example/ad\",X-ASSET-LIST=\"https://evil.example/list.json\"\n";
        let out = rewrite_playlist("https://cdn.example/master.m3u8", line, LOCAL_ORIGIN);
        assert!(out.contains("DURATION=4,SCTE35-OUT=0xFC,X-TEXT=\"a,b\""));
        assert!(out.contains("START-DATE="));
        assert!(!out.contains("evil.example") && !out.contains("X-ASSET"));
    }

    #[test]
    fn every_uri_attribute_is_rewritten_without_splitting_quoted_commas() {
        let line = "#EXT-X-MEDIA:NAME=\"audio,main\",URI=\"first.m3u8\",URI=\"second.m3u8\"";
        let absolute = absolutize_uri_in_attr("https://cdn.example/master.m3u8", line);
        let rewritten = rewrite_uri_attr(&absolute, LOCAL_ORIGIN);
        assert_eq!(
            rewritten.matches(&format!("{LOCAL_ORIGIN}/seg?u=")).count(),
            2
        );
        assert!(rewritten.contains("NAME=\"audio,main\""));
        assert!(!rewritten.contains("URI=\"https://"));
    }

    /// 离线回归：不再依赖带 auth_key 时效的真实上游地址（旧地址已过期，会 403）。
    /// 与真实播放列表同构：带签名的分片地址 + 加密 KEY + 相对路径分片。
    #[test]
    fn playlist_rewrite_works() {
        let base = "https://cdn.example/videos5/abc/abc.m3u8?auth_key=9999999999-0-0-deadbeef&v=3&via=hgdj";
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin?auth_key=9999999999-0-0-deadbeef\"\n#EXTINF:4,\nseg-1.ts?auth_key=9999999999-0-0-deadbeef\n";
        let body = rewrite_playlist(base, text, LOCAL_ORIGIN);

        assert!(body.contains("#EXTM3U"), "not a playlist: {body}");
        assert!(
            body.contains(&format!("{LOCAL_ORIGIN}/seg?u=")),
            "segments not rewritten: {body}"
        );
        // 分片必须绝对化到源站，并保留签名查询串。
        assert!(
            body.contains("https%3A%2F%2Fcdn%2Eexample%2Fvideos5%2Fabc%2Fseg%2D1%2Ets%3Fauth%5Fkey%3D"),
            "segment not absolutized with query: {body}"
        );
        // 加密 KEY 也要走本地代理，否则 hls.js 会直接打源站被 CORS 拦住。
        assert!(
            body.contains("URI=\"") && body.contains("%2Fkey%2Ebin%3Fauth%5Fkey%3D"),
            "key uri not rewritten: {body}"
        );
        assert!(!body.contains("URI=\"key.bin"), "key uri left relative");
    }
}
