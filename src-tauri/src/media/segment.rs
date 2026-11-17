//! Segment/key cache, single-flight download and cache epochs.

use crate::net::fetch_bytes;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::future::Future;
use std::sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex, Weak};

/// AES Key / 分片：拖进度条时同一 key、同一片会被反复拉，缓存住省一次往返。
static KEY_CACHE: Lazy<Mutex<HashMap<String, (String, Arc<Vec<u8>>)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static SEG_CACHE: Lazy<Mutex<HashMap<String, (String, Arc<Vec<u8>>)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static SEG_CACHE_GENERATION: AtomicU64 = AtomicU64::new(0);
type SegmentResult = Result<(Option<String>, Arc<Vec<u8>>), String>;
type SegmentLoad = tokio::sync::OnceCell<SegmentResult>;
// hls.js can issue the same segment concurrently (ABR probes, seek re-entry).
// Share the in-progress download, but never across a proxy/security generation.
static SEG_LOADING: Lazy<Mutex<HashMap<String, Weak<SegmentLoad>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const KEY_CACHE_MAX: usize = 120;
const SEG_CACHE_MAX: usize = 36;
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
    if let Some(hit) = KEY_CACHE.lock().unwrap().get(&key).cloned() {
        return Some(hit);
    }
    SEG_CACHE.lock().unwrap().get(&key).cloned()
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
    let (cache, max) = if len <= 65536 {
        (&KEY_CACHE, KEY_CACHE_MAX)
    } else {
        (&SEG_CACHE, SEG_CACHE_MAX)
    };
    let mut cache = cache.lock().unwrap();
    // clear_caches advances the epoch before clearing maps. Recheck while
    // holding the map lock so a late writer can never insert after that clear.
    if current_scope() != scope {
        return false;
    }
    if cache.len() >= max {
        if let Some(oldest) = cache.keys().next().cloned() {
            cache.remove(&oldest);
        }
    }
    cache.insert(key, (mime, bytes));
    true
}

/// Run one in-progress request per key. Every waiter clones the same result,
/// including an error. Failed cells are removed immediately so a later request
/// can retry instead of inheriting a short-lived failed flight.
async fn coalesce<T, F, Fut>(
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
    let (ctype, bytes) = fetch_segment_bytes(url).await?;
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
}

/* ── 大分片并行 Range 下载（修复四，4 路） ────────────────────────
 * 家里实测瓶颈是视频服务器按连接限速（单连接 0.3–1MB/s）：总长 >512KB 的
 * 分片拆段并行拉，让每条连接各吃一份限速。探针（首 64KB）是第 1 条连接，
 * 拿到总长后剩余字节均分 4 段并发取回。用户在本 App 一直是游客模式、
 * 从未登录账号，不存在封号风险，故按原案直接上 4 路。服务器不支持
 * Range（回 200）、任一段失败或长度对不上，一律整段回退单连接全量
 * 抓取，不硬撑。 */
const RANGE_PROBE_BYTES: u64 = 65536;
const RANGE_SMALL_MAX: u64 = 512 * 1024;
const RANGE_PARTS: u64 = 4;

async fn fetch_segment_bytes(url: &str) -> Result<(Option<String>, Vec<u8>), String> {
    let started = std::time::Instant::now();
    let log = |v: serde_json::Value| crate::playback_log::record("media.range_fetch", v);
    match crate::net::fetch_range_direct(url, 0, RANGE_PROBE_BYTES - 1).await {
        Ok(first) if first.status == 200 => {
            // 服务器忽略 Range：探针响应就是全量，直接用。
            log(serde_json::json!({"resource": crate::playback_log::resource_id(url), "fallback": "no_range", "total_bytes": first.bytes.len()}));
            Ok((first.ctype, first.bytes))
        }
        Ok(first) if first.status == 206 => {
            let have = first.bytes.len() as u64;
            match first.total {
                Some(total) if have <= total && total <= RANGE_SMALL_MAX => {
                    if have == total {
                        log(serde_json::json!({"resource": crate::playback_log::resource_id(url), "fallback": "small", "total_bytes": total}));
                        Ok((first.ctype, first.bytes))
                    } else {
                        // 小分片不拆多路：一条 Range 把剩余取完。
                        match crate::net::fetch_range_direct(url, have, total - 1).await {
                            Ok(rest)
                                if rest.status == 206
                                    && have + rest.bytes.len() as u64 == total =>
                            {
                                let mut bytes = first.bytes;
                                bytes.extend_from_slice(&rest.bytes);
                                log(serde_json::json!({"resource": crate::playback_log::resource_id(url), "fallback": "small", "total_bytes": total}));
                                Ok((first.ctype, bytes))
                            }
                            _ => {
                                log(serde_json::json!({"resource": crate::playback_log::resource_id(url), "fallback": "chunk_fail", "total_bytes": total}));
                                fetch_bytes(url).await
                            }
                        }
                    }
                }
                Some(total) if have < total => {
                    match fetch_segment_parallel(url, first, total).await {
                        Ok((ctype, bytes)) => {
                            log(serde_json::json!({"resource": crate::playback_log::resource_id(url), "chunks": RANGE_PARTS, "total_bytes": total, "ms": started.elapsed().as_millis() as u64}));
                            Ok((ctype, bytes))
                        }
                        Err(_) => {
                            log(serde_json::json!({"resource": crate::playback_log::resource_id(url), "fallback": "chunk_fail", "total_bytes": total}));
                            fetch_bytes(url).await
                        }
                    }
                }
                _ => {
                    // Content-Range 缺失/自相矛盾：不猜，整段单连接重拉。
                    log(serde_json::json!({"resource": crate::playback_log::resource_id(url), "fallback": "chunk_fail", "total_bytes": 0}));
                    fetch_bytes(url).await
                }
            }
        }
        _ => {
            // 探针本身失败（传输错误等）：回退单连接全量，再失败由它报错。
            log(serde_json::json!({"resource": crate::playback_log::resource_id(url), "fallback": "chunk_fail", "total_bytes": 0}));
            fetch_bytes(url).await
        }
    }
}

/// 并行取回探针之后的剩余字节：剩余区间均分 RANGE_PARTS 段并发 Range GET，
/// 逐段校验状态与长度，按序拼在探针字节之后；任一段不对整段判失败（外层回退）。
async fn fetch_segment_parallel(
    url: &str,
    first: crate::net::RangeFetch,
    total: u64,
) -> Result<(Option<String>, Vec<u8>), String> {
    let ctype = first.ctype.clone();
    let have = first.bytes.len() as u64;
    let rest = total - have;
    let step = rest.div_ceil(RANGE_PARTS);
    let mut ranges: Vec<(u64, u64)> = Vec::new(); // [start, end) 区间
    let mut start = have;
    while start < total {
        let end = (start + step).min(total);
        ranges.push((start, end));
        start = end;
    }
    let expected: Vec<u64> = ranges.iter().map(|(s, e)| e - s).collect();
    let mut set = tokio::task::JoinSet::new();
    for (idx, (s, e)) in ranges.iter().enumerate() {
        let u = url.to_string();
        let (s, e) = (*s, *e);
        set.spawn(async move { (idx, crate::net::fetch_range_direct(&u, s, e - 1).await) });
    }
    let mut pieces: Vec<Option<Vec<u8>>> = (0..ranges.len()).map(|_| None).collect();
    while let Some(joined) = set.join_next().await {
        let (idx, piece) = joined.map_err(|e| format!("分片并行任务失败: {e}"))?;
        let piece = piece?;
        if piece.status != 206 || piece.bytes.len() as u64 != expected[idx] {
            return Err("并行分段长度或状态不对".into());
        }
        pieces[idx] = Some(piece.bytes);
    }
    let mut bytes = first.bytes;
    for piece in pieces {
        bytes.extend_from_slice(&piece.ok_or("并行分段缺失")?);
    }
    if bytes.len() as u64 != total {
        return Err("并行拼接总长不对".into());
    }
    Ok((ctype, bytes))
}
