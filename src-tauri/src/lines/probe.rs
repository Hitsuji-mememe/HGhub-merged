//! Candidate probing and automatic line selection.

use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::{Duration, Instant};

use super::mirror::{is_fixed, is_trusted_mirror, mirrors, FIXED, MIRROR_MAX};

const AUTO_PROBE_PATH: &str = "/api/videos?page=1&size=1";
const AUTO_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const AUTO_MIRROR_MAX: usize = 10;

/// Validate the unwrapped /api/videos data, rather than HTML or status alone.
pub(crate) fn healthy_video_data(data: &Value) -> bool {
    let Some(items) = data.get("items").and_then(Value::as_array) else {
        return false;
    };
    let Some(pagination) = data.get("pagination").and_then(Value::as_object) else {
        return false;
    };
    let integer = |key: &str| pagination.get(key).and_then(Value::as_u64);
    if integer("page").is_none_or(|n| n == 0)
        || integer("size").is_none_or(|n| n == 0)
        || integer("pages").is_none()
        || integer("total").is_none()
    {
        return false;
    }
    // These two fields are stable feed identity, unlike optional cover/score.
    items.iter().all(|item| {
        item.get("id")
            .and_then(Value::as_u64)
            .is_some_and(|id| id > 0)
            && item
                .get("title")
                .and_then(Value::as_str)
                .is_some_and(|title| !title.trim().is_empty())
    })
}

#[derive(Clone)]
pub struct Hit {
    pub tier: &'static str,
    pub url: String,
    pub ok: bool,
    pub reachable: bool,
    pub ms: u64,
    pub status: Option<u16>,
    pub(crate) error: Option<String>,
}

impl Hit {
    fn json(&self) -> Value {
        let mut value = json!({ "tier": self.tier, "url": self.url, "ok": self.ok,
            "reachable": self.reachable, "ms": self.ms, "status": self.status });
        if let Some(error) = &self.error {
            value["error"] = json!(error);
        }
        value
    }
}

async fn probe_hit(tier: &'static str, raw: &str) -> Hit {
    let mut hit = Hit {
        tier,
        url: raw.to_owned(),
        ok: false,
        reachable: false,
        ms: 0,
        status: None,
        error: None,
    };
    let Some(origin) = crate::net::normalize_base(raw) else {
        hit.error = Some("线路必须是安全 HTTPS origin".into());
        return hit;
    };
    hit.url = origin.clone();
    let started = Instant::now();
    // edge sends the upstream's real envelope. None explicitly omits credentials.
    // This total deadline also covers edge retries and the response body.
    match tokio::time::timeout(
        AUTO_PROBE_TIMEOUT,
        crate::net::edge(&origin, "GET", AUTO_PROBE_PATH, None, None),
    )
    .await
    {
        Ok(Ok(data)) => {
            hit.reachable = true;
            hit.status = Some(200);
            hit.ok = healthy_video_data(&data);
            if !hit.ok {
                hit.error = Some("接口未返回有效视频列表数据".into());
            }
        }
        Ok(Err(error)) => {
            hit.error = Some(error);
        }
        Err(_) => {
            hit.error = Some("视频接口探测超时（5 秒）".into());
        }
    }
    hit.ms = started.elapsed().as_millis() as u64;
    hit
}

/// Manual checks retain their JSON API and never change trust or active line.
pub async fn probe(urls: Vec<String>) -> Value {
    let mut out = Vec::new();
    for chunk in urls[..urls.len().min(MIRROR_MAX)].chunks(6) {
        let mut handles = Vec::new();
        for origin in chunk {
            let origin = origin.clone();
            handles.push(tokio::spawn(
                async move { probe_hit("mirror", &origin).await },
            ));
        }
        for handle in handles {
            if let Ok(hit) = handle.await {
                out.push(hit.json());
            }
        }
    }
    json!(out)
}

/// A display recommendation is not proof of publication. Candidates are built
/// exclusively from the published items; the .ai landing page is never automatic.
pub(crate) fn auto_candidates(items: &[Value], current: &str, trusted: impl Fn(&str) -> bool) -> Vec<String> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    let current = crate::net::normalize_base(current);
    let published: Vec<_> = items
        .iter()
        .filter_map(|item| item.get("url").and_then(Value::as_str))
        .filter_map(crate::net::normalize_base)
        .filter(|origin| !is_fixed(origin) && trusted(origin))
        .collect();
    // Preserve an actually published current line as a candidate, even with a
    // large published list. A line restored only from disk never qualifies.
    if let Some(origin) = current.filter(|origin| published.contains(origin)) {
        seen.insert(origin.clone());
        candidates.push(origin);
    }
    for origin in published {
        if candidates.len() >= AUTO_MIRROR_MAX {
            break;
        }
        if seen.insert(origin.clone()) {
            candidates.push(origin);
        }
    }
    candidates
}

/// 自动选线（2026-11-18 收官批 D 重做）：延迟探测主站 + 全部可信发布
/// 镜像，对可达者逐个拉真实分片测吞吐，按「吞吐为主、延迟为辅」综合
/// 排名（crate::line_rank）。旧规则（主站活着直接用主站、只按延迟选、
/// pick_from_hits）作废——延迟低不等于拉流快。全部不可达 → all-down，
/// 调用方保持当前线路。发布页错误不丢弃已探到的候选，只记 mirror_error。
pub async fn auto_pick() -> Value {
    let mut hits = vec![probe_hit("main", FIXED[0].1).await];
    let listing = mirrors().await;
    if let Ok(listing) = &listing {
        let items = listing
            .get("items")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let mut handles = Vec::new();
        for origin in auto_candidates(items, &crate::net::base(), is_trusted_mirror) {
            handles.push(tokio::spawn(
                async move { probe_hit("mirror", &origin).await },
            ));
        }
        for handle in handles {
            if let Ok(hit) = handle.await {
                hits.push(hit);
            }
        }
    }
    let ok: Vec<(String, String, u64)> = hits
        .iter()
        .filter(|hit| hit.ok)
        .map(|hit| (hit.tier.to_string(), hit.url.clone(), hit.ms))
        .collect();
    let mut result = if ok.is_empty() {
        json!({ "base": "", "tier": "none", "ms": 0, "reason": "all-down",
            "candidates": hits.iter().map(Hit::json).collect::<Vec<_>>() })
    } else {
        crate::line_rank::pick_ranked(ok).await
    };
    if let Err(error) = listing {
        result["mirror_error"] = json!(error);
    }
    result
}

pub async fn try_main() -> Value {
    let hit = probe_hit("main", FIXED[0].1).await;
    let mut result = hit.json();
    result["base"] = json!(hit.url);
    result
}

pub async fn health() -> Value {
    let hit = probe_hit("current", &crate::net::base()).await;
    let mut result = hit.json();
    result["base"] = json!(hit.url);
    result
}
