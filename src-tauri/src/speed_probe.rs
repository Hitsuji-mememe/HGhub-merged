//! 分片测速对照探针（Muse 2026-11-18 自 net/diagnostics 拆出，移植自 2.0.11）：
//! 网络自检时现取一条新鲜分片，A=生产客户端、B=裸 reqwest 顺序测速；
//! C 路（WebView 直连）在 TS 侧跑。拆分原因：net 目录尺寸预算。

use crate::net::base;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// 分片测速对照（移植 2.0.11, Muse 2026-11-18）：现取一条新鲜分片，顺序测两条 Rust 路——
/// A = 生产媒体路 edge::fetch_bytes；B = 临时裸 reqwest（显式禁代理、系统默认解析）。
/// C 路（WebView 直连同一分片）在 TS 侧用返回的 seg_url 跑，三路同分片对照。
/// 两路严禁并行（会互相污染带宽）；任何一步失败只回 {error}，自检其余部分照常。
///
/// B 路安全收口（根治包 P1-1，Muse 2026-11-19，audit6 §一/§五）：
/// B 的「裸直连」是对照实验的本意（报告标注「直连」属实），但旧实现
/// 有三处硬伤——目标零校验（清单指向内网也照连）、重定向默认跟随
/// 不复检、响应体整段读入无上限。现：目标先过生产策略校验
/// （network_policy::parse_target：scheme/主机/IP），重定向禁自动
/// 跟随、逐跳 redirect_target 复检（≤5 跳），响应体流式累计
/// 64MB 截断并在结果里标 b_truncated。B 仍不走代理/DNS 固定——
/// 那是 A 路的被测属性，不是 B 的缺陷。
pub async fn speed_ab_probe() -> Value {
    match tokio::time::timeout(Duration::from_secs(150), speed_ab_inner()).await {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => json!({ "error": e }),
        Err(_) => json!({ "error": "测速整体超时" }),
    }
}

async fn speed_ab_inner() -> Result<Value, String> {
    let origin = base();
    let list = crate::net::edge(&origin, "GET", "/api/videos?page=1&size=1", None, None)
        .await
        .map_err(|e| format!("取视频列表失败：{e}"))?;
    let id = list
        .get("items")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.get("id"))
        .and_then(|v| v.as_i64())
        .ok_or("视频列表为空")?;
    let info = crate::net::edge(
        &origin,
        "POST",
        &format!("/api/videos/{id}/episodes/1/playback"),
        Some(json!({})),
        None,
    )
    .await
    .map_err(|e| format!("取播放地址失败：{e}"))?;
    let playlist_url = info
        .get("streams")
        .and_then(|s| s.get("main"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            info.get("video_url")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
        })
        .ok_or("播放信息缺少清单地址")?
        .to_string();
    let seg_url = resolve_first_segment(&playlist_url).await?;
    let host = url::Url::parse(&seg_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_default();

    let a_started = Instant::now();
    let (_, a_bytes) = crate::net::fetch_bytes(&seg_url)
        .await
        .map_err(|e| format!("A 路下载失败：{e}"))?;
    let a_ms = a_started.elapsed().as_millis() as u64;

    let b_started = Instant::now();
    let (b_bytes, b_truncated) = speed_b_direct(&seg_url).await?;
    let b_ms = b_started.elapsed().as_millis() as u64;

    Ok(json!({
        "host": host,
        "bytes": a_bytes.len(),
        "b_bytes": b_bytes,
        "b_truncated": b_truncated,
        "a_ms": a_ms,
        "b_ms": b_ms,
        "seg_url": seg_url,
    }))
}

/// B 路响应体流式上限：分片正常在 MB 级，64MB 足够宽；超限截断并
/// 标记（结果 b_truncated=true），不整段读入内存（audit6 §五）。
const B_BODY_MAX_BYTES: usize = 64 * 1024 * 1024;

/// B 路裸直连下载（P1-1 收口后）：目标先过生产策略校验；禁自动
/// 重定向，逐跳用 network_policy::redirect_target 复检（禁 HTTPS
/// 降级/内网目标，≤5 跳）；响应体流式累计、超 64MB 截断标记。
/// 返回（读到的字节数， 是否被截断）。
async fn speed_b_direct(seg_url: &str) -> Result<(usize, bool), String> {
    let mut next = crate::network_policy::parse_target(seg_url)
        .map_err(|e| format!("B 路目标未通过策略校验：{e}"))?;
    let bare = reqwest::Client::builder()
        .user_agent(crate::net::UA)
        .no_proxy()
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("B 路客户端构建失败：{e}"))?;
    for hop in 0..=5 {
        let mut resp = bare
            .get(next.clone())
            .send()
            .await
            .map_err(|e| format!("B 路下载失败：{}", crate::net::err_text(&e)))?;
        if resp.status().is_redirection() {
            if hop == 5 {
                return Err("B 路重定向次数超过限制".into());
            }
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or("B 路重定向缺少有效 Location")?;
            next = crate::network_policy::redirect_target(&next, location)
                .map_err(|e| format!("B 路重定向未通过策略校验：{e}"))?;
            continue;
        }
        if !resp.status().is_success() {
            return Err(format!("B 路下载失败：HTTP {}", resp.status()));
        }
        let mut got = 0usize;
        let mut truncated = false;
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("B 路读取失败：{}", crate::net::err_text(&e)))?
        {
            if got + chunk.len() > B_BODY_MAX_BYTES {
                truncated = true;
                break;
            }
            got += chunk.len();
        }
        return Ok((got, truncated));
    }
    Err("B 路重定向次数超过限制".into())
}

/// 拉播放清单并解析第一个媒体分片的绝对地址；主清单跟一层子清单。
/// line_rank 的吞吐探测共用同一解析（收官批 D）。
pub(crate) async fn resolve_first_segment(playlist_url: &str) -> Result<String, String> {
    let (_, bytes) = crate::net::fetch_bytes(playlist_url)
        .await
        .map_err(|e| format!("拉播放清单失败：{e}"))?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let first_uri = first_uri_line(&text).ok_or("播放清单没有可用条目")?;
    if text.contains("#EXT-X-STREAM-INF") {
        let sub_url = resolve_uri(&first_uri, playlist_url);
        let (_, sub_bytes) = crate::net::fetch_bytes(&sub_url)
            .await
            .map_err(|e| format!("拉子清单失败：{e}"))?;
        let sub_text = String::from_utf8_lossy(&sub_bytes).into_owned();
        let seg = first_uri_line(&sub_text).ok_or("子清单没有媒体分片")?;
        Ok(resolve_uri(&seg, &sub_url))
    } else {
        Ok(resolve_uri(&first_uri, playlist_url))
    }
}

fn first_uri_line(text: &str) -> Option<String> {
    text.lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| l.to_string())
}

fn resolve_uri(u: &str, base: &str) -> String {
    url::Url::parse(base)
        .and_then(|b| b.join(u))
        .map(|u| u.to_string())
        .unwrap_or_else(|_| u.to_string())
}
