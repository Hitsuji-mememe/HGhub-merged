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

    /* 页面 Referer（Muse 2026-11-20 fix338/realphoto-add）：/img 的
     * p= 参数＝承载该图的详情页地址，仅进图片抓取的 Referer 候选链
     * （页面级防盗链校准，见 net/edge.rs media_referer_candidates）；
     * 不作抓取目标、不落日志。其余路由不消费本参数。 */
    let page = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("p="))
        .map(dec)
        .filter(|s| !s.is_empty());

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
        "/img" => match load_image(&target, page.as_deref()).await {
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

    /// 设备链模拟（Muse 2026-11-20 fix331/gallery-device，用户 01:06
    /// 验收门槛：修复证据必须走完整设备链，不许只在组件级/直连快网
    /// 下自称已修）：起生产同款本地媒体服务（linux_http，与桌面端
    /// 17650 端口同一实现、同一 media::handle 入口），经真实 HTTP
    /// 请求 /img 抓 source-006 图集——该图床防盗链对外站 Referer 回
    /// 403（jpg 受保护、webp 豁免），旧抓取栈无条件发线路 base
    /// Referer 时 jpg 必 502（红），Referer 候选链修复后必 200。
    /// 图集地址不硬编码：DEVICE_CHAIN_URLS_FILE 给定时读编排脚本实
    /// 时抓取的地址表（原点为回放实测防盗链策略的上游替身，沙箱
    /// TLS 中间人环境专用，见 scripts/device-chain/upstream_double.py
    /// 头注）；否则经生产取页栈从 wp-json 实时取一帖 ≥20 张 jpg。
    /// 上游条件经 HGHUBX_PROXY 指向 throttle_proxy.py 注入（延迟/
    /// 限速/并发上限），由 run-device-chain.sh 编排。
    /// DEVICE_CHAIN_SERVE=1 时断言后保持服务存活供浏览器腿用。
    /// 运行：cargo test --lib device_chain_img_route -- --ignored --nocapture
    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "设备链模拟：需要真实网络与本地 17650 端口，手动经 run-device-chain.sh 运行"]
    async fn device_chain_img_route() {
        crate::linux_http::start();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        // 图集地址来源二选一：①DEVICE_CHAIN_URLS_FILE——编排脚本实时
        // 从 wp-json 抓取并把原点换成上游替身（沙箱出口对 TLS 中间人
        // 重签、webpki-roots 必然拒签时用，见 upstream_double.py 头注）；
        // ②缺省经生产取页栈实时取帖（普通网络环境）。
        let mut jpgs: Vec<String> = Vec::new();
        let mut webp: Option<String> = None;
        if let Ok(path) = std::env::var("DEVICE_CHAIN_URLS_FILE") {
            let raw = std::fs::read_to_string(&path).expect("DEVICE_CHAIN_URLS_FILE 可读");
            let urls: Vec<String> = serde_json::from_str(&raw).expect("urls 文件解析");
            for u in urls {
                if u.ends_with(".webp") && webp.is_none() {
                    webp = Some(u.clone());
                }
                if u.ends_with(".jpg") {
                    jpgs.push(u);
                }
            }
        } else {
            // 与适配器同一取页栈：source_fetch 命令底层
            // fetch_page_text_with_headers（绝对外站 URL 形态）。
            let raw = crate::net::fetch_page_text_with_headers(
                "https://xiuren.biz/wp-json/wp/v2/posts?page=1&per_page=5&_fields=content",
                &[],
            )
            .await
            .expect("wp-json 取帖（生产取页栈）");
            let posts: serde_json::Value = serde_json::from_str(&raw).expect("wp-json 解析");
            for post in posts.as_array().expect("posts 数组") {
                let html = post["content"]["rendered"].as_str().unwrap_or("");
                let mut found: Vec<String> = Vec::new();
                let mut rest = html;
                while let Some(i) = rest.find("src=\"") {
                    let tail = &rest[i + 5..];
                    match tail.find('"') {
                        Some(j) => {
                            found.push(tail[..j].replace("\\/", "/"));
                            rest = &tail[j..];
                        }
                        None => break,
                    }
                }
                let post_jpgs: Vec<String> = found.iter().filter(|u| u.ends_with(".jpg")).cloned().collect();
                if webp.is_none() {
                    webp = found.iter().find(|u| u.ends_with(".webp")).cloned();
                }
                if post_jpgs.len() >= 20 {
                    jpgs = post_jpgs;
                    break;
                }
            }
        }
        assert!(jpgs.len() >= 20, "需要一帖 ≥20 张 jpg 的真实图集，实得 {}", jpgs.len());
        println!("[device-chain] 图集 jpg {} 张，webp 首图候选 {}", jpgs.len(), webp.is_some());

        let client = reqwest::Client::builder().no_proxy().build().expect("驱动客户端");
        let get = |client: reqwest::Client, url: String| async move {
            let q = format!("u={}", enc(&url));
            let started = std::time::Instant::now();
            let resp = client
                .get(format!("http://127.0.0.1:17650/img?{q}"))
                .send()
                .await;
            match resp {
                Ok(r) => {
                    let status = r.status().as_u16();
                    let bytes = r.bytes().await.map(|b| b.len()).unwrap_or(0);
                    (status, bytes, started.elapsed().as_millis() as u64, String::new())
                }
                Err(e) => (0, 0, started.elapsed().as_millis() as u64, e.to_string()),
            }
        };

        // DEVICE_CHAIN_SKIP_ASSERTS=1：只起服务不做断言（红跑时让
        // 浏览器腿也能对着旧抓取栈的服务跑完，失败由浏览器断言呈现）。
        let skip_asserts = std::env::var("DEVICE_CHAIN_SKIP_ASSERTS").as_deref() == Ok("1");
        // 单张 jpg：旧码 502（上游 403）、新码 200。
        let (status, bytes, ms, err) = get(client.clone(), jpgs[1].clone()).await;
        println!("[device-chain] 单张 jpg → status={status} bytes={bytes} ms={ms} err={err}");
        if !skip_asserts {
            assert_eq!(status, 200, "单张 jpg 经真实 /img 路由必须 200（旧码为 502）");
            assert!(bytes > 10_000, "jpg 字节数应为整图量级，实得 {bytes}");
        }

        // 17 并发（设备诊断在途峰值量级）：同批不同 jpg，全量断言。
        let mut handles = Vec::new();
        for url in jpgs.iter().skip(2).take(17).cloned() {
            let c = client.clone();
            handles.push(tokio::spawn(get(c, url)));
        }
        let mut ok = 0usize;
        let mut max_ms = 0u64;
        let mut failures: Vec<String> = Vec::new();
        for h in handles {
            let (status, _b, ms, err) = h.await.expect("并发任务");
            max_ms = max_ms.max(ms);
            if status == 200 {
                ok += 1;
            } else {
                failures.push(format!("status={status} err={err}"));
            }
        }
        println!("[device-chain] 17 并发 jpg → 成功 {ok}/17，max_ms={max_ms}，失败 {failures:?}");
        if !skip_asserts {
            assert_eq!(ok, 17, "17 并发经真实 /img 路由必须全通，失败：{failures:?}");
        }

        if std::env::var("DEVICE_CHAIN_SERVE").as_deref() == Ok("1") {
            println!("[device-chain] SERVE 模式：保持 17650 服务存活供浏览器腿（由编排脚本终止）");
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
            }
        }
    }

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
