//! 媒体层：封面解密 + HLS 代理。
//!
//! 站点封面是 AES-128-CBC 密文，m3u8 内部分片/key 又可能被 WebView 的 CORS 拦住，
//! 所以图片与视频统一走本地自定义协议（Windows/Android 为 `http://hg.localhost`，
//! macOS 为 `hg://localhost`，见 [`LOCAL_ORIGIN`]）。

mod hls;
mod image;
mod response;
mod segment;

use std::collections::{HashMap, VecDeque};
use tauri::http::Response;

/// 带总字节预算的真 LRU（根治包 P2-13，Muse 2026-11-19）：旧实现
/// 用 HashMap.keys().next() 删任意一条（迭代序与插入/访问无关，
/// segment.rs 还误称其为 oldest）——热数据可被随机淘汰、冷数据可
/// 长驻，且只有条数上限、没有总字节上限。本结构按访问序维护队列：
/// get 命中即移到队尾，insert 后从队头（最久未访问）淘汰，直到
/// 条数与总字节都回到预算内；单条大于总字节预算的不入缓存。
pub(super) struct ByteLru<V> {
    map: HashMap<String, (V, usize)>,
    order: VecDeque<String>,
    bytes: usize,
    max_entries: usize,
    max_bytes: usize,
}

impl<V: Clone> ByteLru<V> {
    pub(super) fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            max_entries,
            max_bytes,
        }
    }

    pub(super) fn get(&mut self, key: &str) -> Option<V> {
        let (value, _) = self.map.get(key)?.clone();
        self.touch(key);
        Some(value)
    }

    pub(super) fn insert(&mut self, key: String, value: V, size: usize) {
        if size > self.max_bytes {
            return;
        }
        if let Some((_, old_size)) = self.map.remove(&key) {
            self.bytes -= old_size;
            self.order.retain(|k| k != &key);
        }
        self.map.insert(key.clone(), (value, size));
        self.bytes += size;
        self.order.push_back(key);
        while self.map.len() > self.max_entries || self.bytes > self.max_bytes {
            let Some(victim) = self.order.pop_front() else { break };
            if let Some((_, victim_size)) = self.map.remove(&victim) {
                self.bytes -= victim_size;
            }
        }
    }

    pub(super) fn remove(&mut self, key: &str) -> Option<V> {
        let (value, size) = self.map.remove(key)?;
        self.bytes -= size;
        self.order.retain(|k| k != key);
        Some(value)
    }

    pub(super) fn clear(&mut self) {
        self.map.clear();
        self.order.clear();
        self.bytes = 0;
    }

    fn touch(&mut self, key: &str) {
        self.order.retain(|k| k != key);
        self.order.push_back(key.to_string());
    }
}

#[cfg(test)]
mod byte_lru_tests {
    use super::*;

    #[test]
    fn evicts_least_recently_used_by_access_order_and_byte_budget() {
        let mut lru = ByteLru::new(10, 100);
        lru.insert("a".into(), 1, 40);
        lru.insert("b".into(), 2, 40);
        // 访问 a 后 b 成最久未用：再塞 40 字节应淘汰 b 而非 a
        assert_eq!(lru.get("a"), Some(1));
        lru.insert("c".into(), 3, 40);
        assert_eq!(lru.get("a"), Some(1), "刚访问的 a 不许被淘汰");
        assert_eq!(lru.get("b"), None, "最久未访问的 b 应被淘汰");
        assert_eq!(lru.get("c"), Some(3));
        // 条数预算同样按访问序淘汰
        let mut by_count = ByteLru::new(2, usize::MAX);
        by_count.insert("x".into(), 1, 1);
        by_count.insert("y".into(), 2, 1);
        by_count.insert("z".into(), 3, 1);
        assert_eq!(by_count.get("x"), None);
        // 单条大于总预算不入缓存
        let mut tiny = ByteLru::new(10, 10);
        tiny.insert("big".into(), 9, 11);
        assert_eq!(tiny.get("big"), None);
    }
}

#[cfg(test)]
pub(crate) use response::fixture_response;
use hls::{dec, load_playlist};
use image::load_image;
use segment::load_segment;
use response::{apply_byte_range, respond, segment_response, PROXIED_IMAGE_CACHE_CONTROL};

/// 本平台自定义协议的完整基址。
///
/// Tauri 的自定义协议地址随平台不同：Windows / Android 是 `http://<scheme>.localhost`，
/// macOS / iOS / Linux 是 `<scheme>://localhost`。m3u8 里的分片与 key 地址按它改写。
/// 前端 `src/shared/api/api.ts` 的 `LOCAL` 必须与此一致，否则封面与视频全部加载失败。
#[cfg(any(target_os = "windows", target_os = "android"))]
pub const LOCAL_ORIGIN: &str = "http://hg.localhost";
/// Linux 走 loopback HTTP：WebKitGTK 的播放器是 GStreamer，它拿不到自定义 scheme。
#[cfg(target_os = "linux")]
pub const LOCAL_ORIGIN: &str = crate::linux_http::ORIGIN;
#[cfg(not(any(target_os = "windows", target_os = "android", target_os = "linux")))]
pub const LOCAL_ORIGIN: &str = "hg://localhost";

/// 清空封面 / 播放列表 / Key / 分片内存缓存
pub fn clear_caches() {
    image::clear_cache();
    hls::clear_cache();
    segment::clear_cache();
}

/// 统一入口：`<LOCAL_ORIGIN>/img?u=` / `hls?u=` / `seg?u=`
///
/// `origin` 是本平台自定义协议的完整基址，见 [`LOCAL_ORIGIN`]；用于改写 m3u8 里的
/// 分片与 key 地址。正常情况下调用方直接传 [`LOCAL_ORIGIN`]。
pub async fn handle(path: &str, query: &str, origin: &str, range: Option<&str>) -> Response<Vec<u8>> {
    let target = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("u="))
        .map(dec)
        .unwrap_or_default();

    if target.is_empty() {
        return respond(400, "text/plain", b"missing u".to_vec(), "no-store");
    }

    let started = std::time::Instant::now();
    let route = match path {
        "/img" => "image",
        "/hls" => "playlist",
        "/seg" => "segment_or_key",
        _ => "unknown",
    };
    crate::playback_log::record(
        "proxy.begin",
        serde_json::json!({"route": route, "resource": crate::playback_log::resource_id(&target)}),
    );
    let response = match path {
        "/img" => match load_image(&target).await {
            Ok((kind, bytes)) => respond(
                200,
                &kind,
                bytes.as_ref().clone(),
                PROXIED_IMAGE_CACHE_CONTROL,
            ),
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        "/hls" => match load_playlist(&target, origin).await {
            Ok(text) => respond(
                200,
                "application/vnd.apple.mpegurl",
                text.as_bytes().to_vec(),
                "no-store",
            ),
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        "/seg" => match load_segment(&target).await {
            Ok((ctype, bytes)) => segment_response(&target, ctype.as_deref(), bytes.as_ref().clone(), origin),
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        _ => respond(404, "text/plain", b"not found".to_vec(), "no-store"),
    };
    let response = apply_byte_range(response, range);
    crate::playback_log::record(
        "proxy.end",
        serde_json::json!({"route": route, "resource": crate::playback_log::resource_id(&target), "status": response.status().as_u16(), "bytes": response.body().len(), "content_type": response.headers().get("Content-Type").and_then(|v| v.to_str().ok()), "content_range": response.headers().get("Content-Range").and_then(|v| v.to_str().ok()), "elapsed_ms": started.elapsed().as_millis() as u64}),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::hls::enc;
    use super::*;
    use crate::net::fetch_bytes;

    /// 联网测试：默认跳过，手动跑 `cargo test --lib -- --ignored`。
    /// 依赖上游 `/api/videos/117/play` 返回的实时播放地址。
    #[tokio::test]
    #[ignore = "联网测试：依赖上游实时播放地址，手动用 --ignored 运行"]
    async fn live_play_chain() {
        let play = crate::net::edge(
            &crate::net::base(),
            "GET",
            "/api/videos/117/play?ep=3&page_texts=0",
            None,
            None,
        )
        .await
        .expect("play api");
        let url = play["video_url"].as_str().expect("video_url").to_string();
        println!("play url: {}", &url[..url.len().min(90)]);
        let (_, bytes) = fetch_bytes(&url).await.expect("fetch playlist");
        let text = String::from_utf8_lossy(&bytes);
        println!(
            "raw playlist len={} head={}",
            text.len(),
            &text[..text.len().min(160)]
        );
        let q = format!("u={}", enc(&url));
        let resp = handle("/hls", &q, LOCAL_ORIGIN, None).await;
        let body = String::from_utf8_lossy(resp.body()).to_string();
        println!("proxied status={} len={}", resp.status(), body.len());
        assert!(body.contains("#EXTM3U"));
        // 取一个分片验证
        let seg_line = body
            .lines()
            .find(|l| !l.starts_with('#') && l.contains("/seg?u="))
            .expect("seg line")
            .to_string();
        println!("seg line: {}", &seg_line[..seg_line.len().min(120)]);
        let seg_q = seg_line.split("?u=").nth(1).unwrap();
        let seg = handle("/seg", &format!("u={seg_q}"), LOCAL_ORIGIN, None).await;
        println!("segment status={} len={}", seg.status(), seg.body().len());
        assert_eq!(seg.status(), 200);
        assert!(seg.body().len() > 1000);
    }
}
