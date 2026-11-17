//! Range 直拉与大分片并行下载（Muse 2026-11-18 自 net/client 与 media/segment 拆出，
//! 移植自 2.0.x 的 438d9cf/2de34b3）：自检三路测速与分片并行共用同一底座。
//! 拆分原因：check-size-budgets 的 net/media 目录预算——关注点独立成顶层模块。

use crate::net::base;
use crate::net::{client_for_dns, err_text};
use crate::network_policy;
use serde_json::json;
use std::time::Instant;
use std::time::Duration;

pub async fn get_with_dns_h(
    raw: &str,
    timeout: Duration,
    accept: Option<&str>,
    referer: Option<&str>,
    public_dns: bool,
    extra_headers: &[(&str, &str)],
) -> Result<reqwest::Response, String> {
    tokio::time::timeout(timeout, async {
        let policy_error = |phase: &str, error: String| {
            crate::playback_log::record("network.target_failed", json!({"resource": crate::playback_log::resource_id(raw), "phase": phase, "error_kind": crate::playback_log::error_kind(&error)}));
            error
        };
        let mut next = network_policy::parse_target(raw).map_err(|e| policy_error("parse", e))?;
        for hop in 0..=5 {
            let resolving = Instant::now();
            let (target, http) = client_for_dns(next.as_str(), public_dns).await.map_err(|e| policy_error("dns_or_client", e))?;
            crate::playback_log::record("network.target_ready", json!({"resource": crate::playback_log::resource_id(raw), "target_resource": crate::playback_log::resource_id(target.as_str()), "dns_or_client_ms": resolving.elapsed().as_millis() as u64, "hop": hop}));
            let mut request = http.get(target.clone()).timeout(timeout);
            if let Some(value) = accept {
                request = request.header("Accept", value);
            }
            if let Some(value) = referer {
                request = request.header("Referer", value);
            }
            for (name, value) in extra_headers {
                request = request.header(*name, *value);
            }
            let response = request.send().await.map_err(|e| err_text(&e))?;
            if !matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
                return Ok(response);
            }
            if hop == 5 {
                return Err("重定向次数超过限制".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or("重定向缺少有效 Location")?;
            next = network_policy::redirect_target(&target, location).map_err(|e| policy_error("redirect", e))?;
            crate::playback_log::record("network.redirect", json!({"resource": crate::playback_log::resource_id(raw), "from": crate::playback_log::resource_id(target.as_str()), "to": crate::playback_log::resource_id(next.as_str()), "status": response.status().as_u16(), "hop": hop + 1}));
        }
        Err("重定向次数超过限制".into())
    })
    .await
    .map_err(|_| "请求超时".to_string())?
}

/// 一次 Range 抓取的结果（状态码 / 总长 / 类型 / 字节）。
pub struct RangeFetch {
    pub status: u16,
    /// Content-Range 里的总长；服务器没给或给 `*` 时为 None。
    pub total: Option<u64>,
    pub ctype: Option<String>,
    pub bytes: Vec<u8>,
}

/// 解析 `Content-Range: bytes 0-65535/1234567` 为 (首字节, 末字节, 总长)。
/// 总长为 `*` 时为 None；单位不是 bytes 或任一数字无效时整头视为无效。
fn parse_content_range(value: &str) -> Option<(u64, u64, Option<u64>)> {
    let (unit, rest) = value.trim().split_once(' ')?;
    if !unit.eq_ignore_ascii_case("bytes") {
        return None;
    }
    let (range, total) = rest.trim().rsplit_once('/')?;
    let (start, end) = range.trim().split_once('-')?;
    let start = start.trim().parse::<u64>().ok()?;
    let end = end.trim().parse::<u64>().ok()?;
    if end < start {
        return None;
    }
    let total = total.trim();
    let total = if total == "*" {
        None
    } else {
        Some(total.parse::<u64>().ok().filter(|n| *n > 0)?)
    };
    Some((start, end, total))
}

/// 解析 `Content-Range: bytes 0-65535/1234567` 的总长部分。
fn parse_content_range_total(value: &str) -> Option<u64> {
    parse_content_range(value).and_then(|(_, _, total)| total)
}

/// 带 Range 头拉一段字节，走系统 DNS 路径（与 fetch_bytes_direct 同路，不翻公共 DNS）。
/// 客户端构造、UA、Referer 都与 fetch_bytes 一致，只是多个 Range 头和状态码语义：
/// 206＝分段命中（看 total 规划后续）；200＝服务器忽略 Range、响应即全量；非 2xx 直接报错。
pub async fn fetch_range_direct(
    url: &str,
    start: u64,
    end: u64,
) -> Result<RangeFetch, String> {
    let referer = format!("{}/", base());
    let range = format!("bytes={start}-{end}");
    // Accept-Encoding 写死 identity（Muse 2026-11-18）：客户端默认开 gzip/brotli
    // 自动解压，若边缘对 Range 响应做了内容编码，解压后字节与 Range 偏移不是
    // 同一套坐标系，拼片会静默错位。Range 语义只对 identity 实体成立，写死。
    let resp = get_with_dns_h(
        url,
        Duration::from_secs(20),
        None,
        Some(&referer),
        false,
        &[("Range", &range), ("Accept-Encoding", "identity")],
    )
    .await?;
    let status = resp.status().as_u16();
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let content_range = resp
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let total = content_range
        .as_deref()
        .and_then(parse_content_range_total);
    let ctype = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let bytes = resp.bytes().await.map_err(|e| err_text(&e))?.to_vec();
    // fix(rust-audit): 206 此前只验状态+长度、从不核对 Content-Range 偏移。
    // 服务器（或重定向落点）若回了另一段同长度字节，拼片总长照样对得上，
    // 损坏分片会被当好片缓存/播出。这里要求 206 必带合法 Content-Range，
    // 且起点与请求一致、终点不越请求区间、区间长度与实体长度一致；
    // 任一不符整段判失败，由调用方回退单连接全量抓取（不拼片）。
    // 终点小于请求终点是合法的 EOF 截断（探针请求越过文件尾），后续
    // 规划/拼片的长度校验会处理；200 不走此校验（响应即全量）。
    if status == 206 {
        let (range_start, range_end, _) = content_range
            .as_deref()
            .and_then(parse_content_range)
            .ok_or("HTTP 206 缺少有效 Content-Range")?;
        if range_start != start
            || range_end > end
            || range_end - range_start + 1 != bytes.len() as u64
        {
            return Err("HTTP 206 Content-Range 与请求区间不一致".into());
        }
    }
    Ok(RangeFetch { status, total, ctype, bytes })
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

pub(crate) async fn fetch_segment_bytes(url: &str) -> Result<(Option<String>, Vec<u8>), String> {
    let started = std::time::Instant::now();
    let log = |v: serde_json::Value| crate::playback_log::record("media.range_fetch", v);
    match fetch_range_direct(url, 0, RANGE_PROBE_BYTES - 1).await {
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
                        match fetch_range_direct(url, have, total - 1).await {
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
                                crate::net::fetch_bytes(url).await
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
                            crate::net::fetch_bytes(url).await
                        }
                    }
                }
                _ => {
                    // Content-Range 缺失/自相矛盾：不猜，整段单连接重拉。
                    log(serde_json::json!({"resource": crate::playback_log::resource_id(url), "fallback": "chunk_fail", "total_bytes": 0}));
                    crate::net::fetch_bytes(url).await
                }
            }
        }
        _ => {
            // 探针本身失败（传输错误等）：回退单连接全量，再失败由它报错。
            log(serde_json::json!({"resource": crate::playback_log::resource_id(url), "fallback": "chunk_fail", "total_bytes": 0}));
            crate::net::fetch_bytes(url).await
        }
    }
}

/// 并行取回探针之后的剩余字节：剩余区间均分 RANGE_PARTS 段并发 Range GET，
/// 逐段校验状态与长度，按序拼在探针字节之后；任一段不对整段判失败（外层回退）。
async fn fetch_segment_parallel(
    url: &str,
    first: RangeFetch,
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
        set.spawn(async move { (idx, fetch_range_direct(&u, s, e - 1).await) });
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
