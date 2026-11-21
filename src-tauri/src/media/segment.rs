//! Segment/key cache, single-flight download and cache epochs.

use super::ByteLru;
use crate::net::fetch_bytes;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::future::Future;
use std::sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex, Weak};

/// AES Key / 分片：拖进度条时同一 key、同一片会被反复拉，缓存住省一次往返。
/// 淘汰与预算（P2-13）：真 LRU（访问序）＋总字节预算——KEY 120 条/8MB，
/// SEG 36 条/64MB（旧制只有条数上限：SEG 名义最坏 36×4MB≈144MB，
/// 且淘汰是 HashMap 任意序、误称 oldest）。
static KEY_CACHE: Lazy<Mutex<ByteLru<(String, Arc<Vec<u8>>)>>> =
    Lazy::new(|| Mutex::new(ByteLru::new(KEY_CACHE_MAX, KEY_CACHE_BUDGET_BYTES)));
static SEG_CACHE: Lazy<Mutex<ByteLru<(String, Arc<Vec<u8>>)>>> =
    Lazy::new(|| Mutex::new(ByteLru::new(SEG_CACHE_MAX, SEG_CACHE_BUDGET_BYTES)));
static SEG_CACHE_GENERATION: AtomicU64 = AtomicU64::new(0);
type SegmentResult = Result<(Option<String>, Arc<Vec<u8>>), String>;
type SegmentLoad = tokio::sync::OnceCell<SegmentResult>;
// hls.js can issue the same segment concurrently (ABR probes, seek re-entry).
// Share the in-progress download, but never across a proxy/security generation.
static SEG_LOADING: Lazy<Mutex<HashMap<String, Weak<SegmentLoad>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const KEY_CACHE_MAX: usize = 120;
const KEY_CACHE_BUDGET_BYTES: usize = 8 * 1024 * 1024;
const SEG_CACHE_MAX: usize = 36;
const SEG_CACHE_BUDGET_BYTES: usize = 64 * 1024 * 1024;
const SEG_CACHE_MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SegmentScope {
    request: crate::net::RequestScope,
    cache_generation: u64,
}

fn segment_scope() -> SegmentScope {
    SegmentScope {
        request: crate::net::request_scope(),
        cache_generation: SEG_CACHE_GENERATION.load(Ordering::Acquire),
    }
}

fn segment_cache_key(scope: SegmentScope, url: &str) -> String {
    format!(
        "{}:{}:{}:{url}",
        u8::from(scope.request.strict),
        scope.request.generation,
        scope.cache_generation
    )
}

fn cached_segment(scope: SegmentScope, url: &str) -> Option<(String, Arc<Vec<u8>>)> {
    let key = segment_cache_key(scope, url);
    if let Some(hit) = KEY_CACHE.lock().unwrap().get(&key) {
        return Some(hit);
    }
    SEG_CACHE.lock().unwrap().get(&key)
}

/// Discard a response that belongs to a superseded transport or cache epoch.
/// The epoch prevents an old in-flight request from repopulating a cache that
/// the user just cleared.
fn store_segment_for_scope(
    scope: SegmentScope,
    current: SegmentScope,
    url: &str,
    mime: String,
    bytes: Arc<Vec<u8>>,
    len: usize,
) -> bool {
    store_segment_for_scope_with(scope, current, url, mime, bytes, len, segment_scope)
}

fn store_segment_for_scope_with<F>(
    scope: SegmentScope,
    current: SegmentScope,
    url: &str,
    mime: String,
    bytes: Arc<Vec<u8>>,
    len: usize,
    current_scope: F,
) -> bool
where
    F: FnOnce() -> SegmentScope,
{
    if scope != current {
        return false;
    }
    if len > SEG_CACHE_MAX_BYTES {
        return true;
    }
    let key = segment_cache_key(scope, url);
    let cache = if len <= 65536 { &KEY_CACHE } else { &SEG_CACHE };
    let mut cache = cache.lock().unwrap();
    // clear_caches advances the epoch before clearing maps. Recheck while
    // holding the map lock so a late writer can never insert after that clear.
    if current_scope() != scope {
        return false;
    }
    // 淘汰在 ByteLru 内：访问序 LRU＋总字节预算（P2-13）。
    cache.insert(key, (mime, bytes), len);
    true
}

/// Run one in-progress request per key. Every waiter clones the same result,
/// including an error. Failed cells are removed immediately so a later request
/// can retry instead of inheriting a short-lived failed flight.
/// pub(super)（fix338 签名③）：清单腿（media::hls）共用同一合并
/// 实现，不另写第二份 single-flight。
pub(super) async fn coalesce<T, F, Fut>(
    registry: &Mutex<HashMap<String, Weak<tokio::sync::OnceCell<Result<T, String>>>>>,
    key: String,
    fetch: F,
) -> Result<T, String>
where
    T: Clone,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    let load = {
        let mut requests = registry.lock().unwrap();
        requests.retain(|_, request| request.strong_count() > 0);
        if let Some(load) = requests.get(&key).and_then(Weak::upgrade) {
            load
        } else {
            let load = Arc::new(tokio::sync::OnceCell::new());
            requests.insert(key.clone(), Arc::downgrade(&load));
            load
        }
    };
    let result = load.get_or_init(fetch).await.clone();
    if result.is_err() {
        if let Ok(mut requests) = registry.lock() {
            if requests
                .get(&key)
                .and_then(Weak::upgrade)
                .is_some_and(|request| Arc::ptr_eq(&request, &load))
            {
                requests.remove(&key);
            }
        }
    }
    result
}

/// 分片 / AES Key 带内存缓存：拖动进度条时避免重复拉取同一片造成卡顿。
pub async fn load_segment(url: &str) -> SegmentResult {
    let scope = segment_scope();
    if let Some((ctype, hit)) = cached_segment(scope, url) {
        return Ok((Some(ctype), hit));
    }
    let key = segment_cache_key(scope, url);
    coalesce(&SEG_LOADING, key, || download_segment(url, scope)).await
}

async fn download_segment(url: &str, scope: SegmentScope) -> SegmentResult {
    // Another request may have populated the completed cache while this one
    // was waiting for the single-flight lock.
    if let Some((ctype, hit)) = cached_segment(scope, url) {
        return Ok((Some(ctype), hit));
    }
    let (ctype, bytes) = crate::range_fetch::fetch_segment_bytes(url).await?;
    let mime = ctype.clone().unwrap_or_else(|| {
        let p = url.split('?').next().unwrap_or(url).to_ascii_lowercase();
        if p.ends_with(".ts") {
            "video/mp2t".to_string()
        } else if p.ends_with(".m4s") || p.ends_with(".mp4") {
            "video/mp4".to_string()
        } else {
            "application/octet-stream".to_string()
        }
    });
    let len = bytes.len();
    let arc = Arc::new(bytes);
    store_segment_for_scope(
        scope,
        segment_scope(),
        url,
        mime.clone(),
        arc.clone(),
        len,
    );
    Ok((Some(mime), arc))
}

pub(super) fn clear_cache() {
    SEG_CACHE_GENERATION.fetch_add(1, Ordering::AcqRel);
    if let Ok(mut g) = KEY_CACHE.lock() {
        g.clear();
    }
    if let Ok(mut g) = SEG_CACHE.lock() {
        g.clear();
    }
    if let Ok(mut g) = SEG_LOADING.lock() {
        g.clear();
    }
}

/* ── file 流 ranged 直通（Muse 2026-11-21 fix3310/file-playback-leg）──
 * 背景：/seg 旧形态只有整段下载一条路（load_segment→fetch_segment_
 * bytes 并行拼片成整对象 Vec、整形后本地切片）——拼片单响应上限
 * 16MB（range_fetch::RANGE_BODY_MAX_BYTES）与全量上限同值，大文
 * 件（数百 MB 级 MP4）每片必超限、回退全量同超限，恒 502；
 * 中等文件则每请求整文件入内存重下。kind:"file" 的 MP4 直链走
 * 本形态：把播放器/探针的单段 Range 映射为对上游的同区间单次
 * Range 取数（fetch_range_direct，20s 截止、206 偏移校验现成），
 * 窗口字节原样 206 返回——内存与流量都只随窗口走。
 * 适用面由 handle 限定：带 Range 头 ∧ 目标路径为媒体文件扩展名；
 * 其余 /seg 请求（HLS 分片/key/无 Range）逐字走旧形态。
 * 失败分流：可由旧形态接管的（解析不出的 Range、上游 200 全量
 * 超限、无总长、切片实为清单）回 Fallback；旧形态同样无结论或
 * 语义已定的（超时——旧形态共用同一 20s 取数链、只会再挂一遍；
 * 上游 416；切片为 HTML 文档——与 segment_response 同罪 502）
 * 直接 Fatal 定案，不双倍等待。 */

/// 开放区间（bytes=a-）单次服务的窗口上限：小于 fetch_range_
/// direct 的 16MB 单响应上限，留校验余量；播放器要更多字节会
/// 续发下一段 Range（原生媒体栈的常规形态）。
pub(super) const RANGED_WINDOW_MAX_BYTES: u64 = 15 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum SingleRange {
    FromTo(u64, u64),
    From(u64),
    Suffix(u64),
}

/// 解析单段 Range 头（bytes=a-b / a- / -n）；多段、双空、逆序、
/// 后缀 0 一律 None（调用方回退旧形态，由 apply_byte_range 按其
/// 既有语义处理）。
pub(super) fn parse_single_range(value: &str) -> Option<SingleRange> {
    let spec = value.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (first, last) = spec.split_once('-')?;
    let (first, last) = (first.trim(), last.trim());
    match (first.is_empty(), last.is_empty()) {
        (true, true) => None,
        (true, false) => last
            .parse::<u64>()
            .ok()
            .filter(|n| *n > 0)
            .map(SingleRange::Suffix),
        (false, true) => first.parse::<u64>().ok().map(SingleRange::From),
        (false, false) => {
            let start = first.parse::<u64>().ok()?;
            let end = last.parse::<u64>().ok()?;
            if end < start {
                None
            } else {
                Some(SingleRange::FromTo(start, end))
            }
        }
    }
}

/// 目标路径是否为媒体文件（扩展名判别，忽略查询串/片段与大小
/// 写；与 response::target_claims_playlist 同为路径后缀判别）。
/// 只认播放器会以文件形态消费的容器扩展名。
pub(super) fn is_media_file_target(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let lower = path.to_ascii_lowercase();
    [".mp4", ".m4v", ".mov", ".webm", ".mkv"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// ranged 直通的失败分流（见本节头注）。
#[derive(Debug)]
pub(super) enum RangedError {
    /// 回退旧整段形态（load_segment＋apply_byte_range）。
    Fallback,
    /// 直接定案（状态码＋错误原文，handle 以 text/plain 返回）。
    Fatal(u16, String),
}

fn ranged_fetch_error(error: String) -> RangedError {
    if error == "HTTP 416" {
        return RangedError::Fatal(416, error);
    }
    /* 超时定案：取数链自身 20s 截止给出的结论（get_with_dns_h 的
     * 「请求超时」与 reqwest 的 timed out 同源）——旧形态共用同一
     * 条链，回退只会再挂满一轮且结论不变（fix338 截止纪律：慢/
     * 挂形态必须有截止有结论，不双倍等待）。 */
    let lower = error.to_ascii_lowercase();
    if error.contains("超时") || lower.contains("timed out") || lower.contains("timeout") {
        return RangedError::Fatal(502, error);
    }
    RangedError::Fallback
}

/// 切片内容守卫（与 segment_response 同口径）：HTML 文档恒不是
/// 媒体字节 → Fatal 502；声称为媒体文件却取回清单字节（start=0
/// 且魔数命中）→ 回退旧形态走清单改写。
fn ranged_slice_guard(bytes: &[u8], start: u64) -> Result<(), RangedError> {
    if crate::net::is_html_document(bytes) {
        return Err(RangedError::Fatal(
            502,
            "响应为 HTML 文档而非媒体字节".to_string(),
        ));
    }
    if start == 0 && super::hls::is_playlist_bytes(bytes) {
        return Err(RangedError::Fallback);
    }
    Ok(())
}

/// 显式区间 [start, end] 的 ranged 取数与整形。
async fn load_ranged_explicit(
    url: &str,
    start: u64,
    end: u64,
) -> Result<tauri::http::Response<Vec<u8>>, RangedError> {
    let fetched = crate::range_fetch::fetch_range_direct(url, start, end)
        .await
        .map_err(ranged_fetch_error)?;
    if fetched.status == 200 {
        /* 上游忽略 Range：响应即全量实体（≤16MB 由 fetch_range_
         * direct 流式上限保证，超限在那里已报错回 Fallback）。
         * 总长即体长，本地切片成 206——与 apply_byte_range 对旧
         * 形态 200 的切片语义一致，只是免了整段拼片。 */
        let total = fetched.bytes.len() as u64;
        if start >= total {
            return Err(RangedError::Fatal(416, "请求区间越界".to_string()));
        }
        ranged_slice_guard(&fetched.bytes, start)?;
        let slice_end = end.min(total - 1);
        let slice = fetched.bytes[start as usize..=slice_end as usize].to_vec();
        return Ok(super::response::range_window_response(
            fetched.ctype.as_deref(),
            slice,
            start,
            total,
        ));
    }
    /* 206：fetch_range_direct 已校验 Content-Range 起点/终点/长
     * 度与请求区间一致；总长缺失（*）时无法给出 Content-Range
     * 总长，回退旧形态。 */
    let total = fetched.total.ok_or(RangedError::Fallback)?;
    if fetched.bytes.is_empty() {
        return Err(RangedError::Fallback);
    }
    ranged_slice_guard(&fetched.bytes, start)?;
    Ok(super::response::range_window_response(
        fetched.ctype.as_deref(),
        fetched.bytes,
        start,
        total,
    ))
}

/// /seg ranged 直通入口（handle 在「带 Range ∧ 媒体文件目标」时
/// 调用）：单段 Range → 同区间单次上游取数 → 206 窗口响应。
pub(super) async fn load_segment_ranged(
    url: &str,
    range: &str,
) -> Result<tauri::http::Response<Vec<u8>>, RangedError> {
    match parse_single_range(range).ok_or(RangedError::Fallback)? {
        SingleRange::FromTo(start, end) => load_ranged_explicit(url, start, end).await,
        SingleRange::From(start) => {
            let end = start.saturating_add(RANGED_WINDOW_MAX_BYTES - 1);
            load_ranged_explicit(url, start, end).await
        }
        SingleRange::Suffix(len) => {
            /* 后缀区间须先知总长：1 字节探针取 Content-Range 总
             * 长（206），上游忽略 Range 回 200 时探针体即全量、
             * 直接尾切。 */
            let probe = crate::range_fetch::fetch_range_direct(url, 0, 0)
                .await
                .map_err(ranged_fetch_error)?;
            if probe.status == 200 {
                let total = probe.bytes.len() as u64;
                if total == 0 {
                    return Err(RangedError::Fallback);
                }
                ranged_slice_guard(&probe.bytes, 0)?;
                let take = len.min(total);
                let start = total - take;
                let slice = probe.bytes[start as usize..].to_vec();
                return Ok(super::response::range_window_response(
                    probe.ctype.as_deref(),
                    slice,
                    start,
                    total,
                ));
            }
            let total = probe.total.ok_or(RangedError::Fallback)?;
            if total == 0 {
                return Err(RangedError::Fallback);
            }
            let take = len.min(total);
            load_ranged_explicit(url, total - take, total - 1).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[tokio::test]
    async fn concurrent_segment_flights_share_one_download() {
        let registry: Mutex<HashMap<String, Weak<tokio::sync::OnceCell<Result<u64, String>>>>> =
            Mutex::new(HashMap::new());
        let calls = AtomicUsize::new(0);
        let (first, second) = tokio::join!(
            coalesce(&registry, "same-segment".into(), || async {
                calls.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                Ok(42)
            }),
            coalesce(&registry, "same-segment".into(), || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(99)
            })
        );
        assert_eq!(first, Ok(42));
        assert_eq!(second, Ok(42));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn segment_flight_failure_reaches_every_waiter_and_allows_retry() {
        let registry: Mutex<HashMap<String, Weak<tokio::sync::OnceCell<Result<u64, String>>>>> =
            Mutex::new(HashMap::new());
        let (first, second) = tokio::join!(
            coalesce(&registry, "failed-segment".into(), || async {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                Err("upstream failed".to_string())
            }),
            coalesce(&registry, "failed-segment".into(), || async {
                Ok(1)
            })
        );
        assert_eq!(first, Err("upstream failed".to_string()));
        assert_eq!(second, Err("upstream failed".to_string()));

        let retry = coalesce(&registry, "failed-segment".into(), || async { Ok(7) }).await;
        assert_eq!(retry, Ok(7));
    }

    #[test]
    fn segment_keys_do_not_cross_security_proxy_or_cache_generations() {
        let base = SegmentScope {
            request: crate::net::RequestScope {
                strict: true,
                generation: 11,
            },
            cache_generation: 3,
        };
        let key = segment_cache_key(base, "https://cdn.example/seg.ts");
        assert_eq!(key, segment_cache_key(base, "https://cdn.example/seg.ts"));
        assert_ne!(
            key,
            segment_cache_key(
                SegmentScope {
                    request: crate::net::RequestScope {
                        strict: false,
                        ..base.request
                    },
                    ..base
                },
                "https://cdn.example/seg.ts"
            )
        );
        assert_ne!(
            key,
            segment_cache_key(
                SegmentScope {
                    request: crate::net::RequestScope {
                        generation: 12,
                        ..base.request
                    },
                    ..base
                },
                "https://cdn.example/seg.ts"
            )
        );
        assert_ne!(
            key,
            segment_cache_key(
                SegmentScope {
                    cache_generation: 4,
                    ..base
                },
                "https://cdn.example/seg.ts"
            )
        );
        assert_ne!(
            key,
            segment_cache_key(base, "https://cdn.example/other.ts")
        );
    }

    #[test]
    fn late_old_scope_segment_is_discarded_instead_of_polluting_new_cache() {
        let url = "https://cdn.example/late-scope-test.ts";
        let old = SegmentScope {
            request: crate::net::RequestScope {
                strict: true,
                generation: 20,
            },
            cache_generation: 8,
        };
        let new = SegmentScope {
            request: crate::net::RequestScope {
                strict: true,
                generation: 21,
            },
            cache_generation: 9,
        };
        let bytes = Arc::new(vec![0x5a; 70_000]);

        assert!(!store_segment_for_scope(
            old,
            new,
            url,
            "video/mp2t".into(),
            bytes.clone(),
            bytes.len(),
        ));
        assert!(cached_segment(new, url).is_none());
        assert!(cached_segment(old, url).is_none());

        assert!(store_segment_for_scope_with(
            old,
            old,
            url,
            "video/mp2t".into(),
            bytes.clone(),
            bytes.len(),
            || old,
        ));
        assert!(cached_segment(old, url).is_some());
        assert!(cached_segment(new, url).is_none());

        SEG_CACHE
            .lock()
            .unwrap()
            .remove(&segment_cache_key(old, url));

        // clear_caches can advance the epoch after the first scope check but
        // before the map lock is acquired. The second check must still reject.
        assert!(!store_segment_for_scope_with(
            old,
            old,
            url,
            "video/mp2t".into(),
            bytes.clone(),
            bytes.len(),
            || new,
        ));
        assert!(cached_segment(old, url).is_none());
        assert!(cached_segment(new, url).is_none());
    }

    /* fix3310/file-playback-leg：ranged 直通的纯判别面——单段
     * Range 解析与媒体文件目标判别。行为面（206 守恒/截止）在
     * media::tests 的设备链用例 device_chain_seg_file_range。 */
    #[test]
    fn parse_single_range_accepts_three_forms() {
        assert_eq!(parse_single_range("bytes=0-2047"), Some(SingleRange::FromTo(0, 2047)));
        assert_eq!(parse_single_range("bytes=1024-"), Some(SingleRange::From(1024)));
        assert_eq!(parse_single_range("bytes=-500"), Some(SingleRange::Suffix(500)));
        assert_eq!(parse_single_range("bytes=0-0"), Some(SingleRange::FromTo(0, 0)));
    }

    #[test]
    fn parse_single_range_rejects_non_single_or_invalid() {
        assert_eq!(parse_single_range("bytes=0-1,4-5"), None, "多段不走直通");
        assert_eq!(parse_single_range("bytes=-"), None);
        assert_eq!(parse_single_range("bytes=-0"), None, "后缀 0 无意义");
        assert_eq!(parse_single_range("bytes=9-4"), None, "逆序");
        assert_eq!(parse_single_range("items=0-1"), None, "单位不是 bytes");
        assert_eq!(parse_single_range("bytes=a-b"), None);
        assert_eq!(parse_single_range(""), None);
    }

    #[test]
    fn media_file_target_matches_container_extensions_only() {
        assert!(is_media_file_target("https://cdn.example/v/clip.mp4"));
        assert!(is_media_file_target("https://cdn.example/v/clip.MP4?token=1"));
        assert!(is_media_file_target("https://cdn.example/v/clip.webm#t=3"));
        assert!(is_media_file_target("https://cdn.example/v/clip.m4v"));
        assert!(!is_media_file_target("https://cdn.example/v/playlist.m3u8"));
        assert!(!is_media_file_target("https://cdn.example/v/seg-0001.ts"));
        assert!(!is_media_file_target("https://cdn.example/v/key.bin"));
        assert!(!is_media_file_target("https://cdn.example/mp4/playlist"));
    }
}

