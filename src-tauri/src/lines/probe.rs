//! Candidate probing and automatic line selection.

use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
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

/* 两轮确认的待确认胜者（2026-11-18 晚整改 5）：普通（非故障）切换
 * 离开一条可达的当前线路时，同一个胜者要连续两轮胜出才真切——单轮
 * 采样噪声下名次翻转是真机实锤过的病（粘性挡得住「够用不换」，挡不住
 * 「当前线明显更差但胜者是谁每轮都变」）。故障路径（urgent：当前线
 * 健康检查连挂/播放卡顿自愈）绕过确认立即切。待确认 10 分钟过期。 */
static PENDING_WINNER: std::sync::Mutex<Option<(String, Instant, u64)>> =
    std::sync::Mutex::new(None);
static CONFIRM_GEN: AtomicU64 = AtomicU64::new(0);
const PENDING_TTL: Duration = Duration::from_secs(600);

/// 手动选线/代理变更时使待确认失效（Muse 2026-11-18）：代次 +1 并
/// 清掉现有待确认。只递增 LINE_SELECTION 不够——那只作废在途探测，
/// 管不到本模块的待确认状态；手动操作后旧胜者再胜一轮会被误判为
/// 「连续两轮」而直接切换。代次同时记进 pending 本身，双保险：即便
/// 清除与记录并发交错，代次不符的旧记录也不会被当作确认（见
/// confirm_gate）。line_auto 不经此函数，否则自动确认轮会自断。
pub fn invalidate_pending_confirm() {
    CONFIRM_GEN.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut pending) = PENDING_WINNER.lock() {
        *pending = None;
    }
}

/// 两轮确认的决策（纯函数，2026-11-18 晚故障注入批自 auto_pick 内联
/// 逻辑等价提取，契约由文件末尾 tests 钉住）：返回 true = 本轮胜者可
/// 直接生效；false = 已记待确认，调用方须把结果改写为 confirm-pending。
/// 语义逐条：空胜者不涉及切换 → 放行且不碰待确认；胜者即当前线或
/// 故障路径（urgent）→ 清待确认放行；普通路径同胜者在 TTL 内二度
/// 胜出 → 清待确认放行，否则（首胜/已过期/异胜者）记或替换待确认
/// 并拦截。待确认带代次（current_gen）：记录时的代次与当前代次不符
/// 视为无待确认，按首胜重新记，不确认——手动操作经
/// invalidate_pending_confirm 递增代次后，旧胜者不能冒充第二轮。
fn confirm_gate(
    pending: &mut Option<(String, Instant, u64)>,
    winner: &str,
    current: &str,
    urgent: bool,
    now: Instant,
    current_gen: u64,
) -> bool {
    if winner.is_empty() {
        return true;
    }
    if winner == current || urgent {
        *pending = None;
        return true;
    }
    let confirmed = matches!(&*pending, Some((w, at, gen)) if w == winner && *gen == current_gen && now.duration_since(*at) < PENDING_TTL);
    if confirmed {
        *pending = None;
        true
    } else {
        *pending = Some((winner.to_string(), now, current_gen));
        false
    }
}

/// 自动选线（2026-11-18 收官批 D 重做）：延迟探测主站 + 全部可信发布
/// 镜像，对可达者逐个拉真实分片测吞吐，按「吞吐为主、延迟为辅」综合
/// 排名（crate::line_rank）。旧规则（主站活着直接用主站、只按延迟选、
/// pick_from_hits）作废——延迟低不等于拉流快。全部不可达 → all-down，
/// 调用方保持当前线路。发布页错误不丢弃已探到的候选，只记 mirror_error。
/// 结果附 published/probed/okCount 三个覆盖计数（整改 2）：诊断报告
/// 直接复用本轮探测结果，不再为生成报告重测一遍。
pub async fn auto_pick(urgent: bool) -> Value {
    let mut hits = vec![probe_hit("main", FIXED[0].1).await];
    let listing = mirrors().await;
    let mut published = 0usize;
    if let Ok(listing) = &listing {
        let items = listing
            .get("items")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        published = items.len();
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
    let probed = hits.len();
    let ok_count = ok.len();
    let mut result = if ok.is_empty() {
        json!({ "base": "", "tier": "none", "ms": 0, "reason": "all-down",
            "candidates": hits.iter().map(Hit::json).collect::<Vec<_>>() })
    } else {
        crate::line_rank::pick_ranked(ok, Some(&crate::net::base())).await
    };
    if let Err(error) = listing {
        result["mirror_error"] = json!(error);
    }
    result["published"] = json!(published);
    result["probed"] = json!(probed);
    result["okCount"] = json!(ok_count);
    /* 两轮确认（整改 5）：决策在 confirm_gate（纯函数，契约见其
     * tests）；锁失败按放行处理（不拦截、不改结果，与原内联实现
     * 一致）。拦截时把 base 改回当前线并标 reason=confirm-pending，
     * 调用方据此约下一轮确认探测；次轮同胜者才真切。 */
    let current = crate::net::base();
    let winner = result.get("base").and_then(Value::as_str).unwrap_or_default().to_string();
    let pass = match PENDING_WINNER.lock() {
        Ok(mut pending) => confirm_gate(
            &mut pending,
            &winner,
            &current,
            urgent,
            Instant::now(),
            CONFIRM_GEN.load(Ordering::SeqCst),
        ),
        Err(_) => true,
    };
    if !pass {
        result["pendingWinner"] = json!(winner);
        result["base"] = json!(current);
        result["reason"] = json!("confirm-pending");
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

#[cfg(test)]
mod tests {
    use super::*;

    const WINNER: &str = "https://mirror-a.example";
    const OTHER: &str = "https://mirror-b.example";
    const CURRENT: &str = "https://huangguoai.com";
    const GEN: u64 = 3;

    /* 故障注入（2026-11-18 晚）：两轮确认已落地但从未被真实故障
     * 检验，以下用例把 confirm_gate 的决策契约逐条钉死。 */

    #[test]
    fn first_win_holds_and_records_pending() {
        let now = Instant::now();
        let mut pending = None;
        assert!(!confirm_gate(&mut pending, WINNER, CURRENT, false, now, GEN));
        assert_eq!(pending, Some((WINNER.to_string(), now, GEN)));
    }

    #[test]
    fn second_win_within_ttl_passes_and_clears() {
        let now = Instant::now();
        let mut pending = Some((WINNER.to_string(), now - Duration::from_secs(60), GEN));
        assert!(confirm_gate(&mut pending, WINNER, CURRENT, false, now, GEN));
        assert_eq!(pending, None);
    }

    #[test]
    fn expired_pending_rerecords_and_holds() {
        let now = Instant::now();
        let mut pending = Some((WINNER.to_string(), now - PENDING_TTL - Duration::from_secs(1), GEN));
        assert!(!confirm_gate(&mut pending, WINNER, CURRENT, false, now, GEN));
        assert_eq!(pending, Some((WINNER.to_string(), now, GEN)));
    }

    #[test]
    fn different_winner_replaces_pending_and_holds() {
        let now = Instant::now();
        let mut pending = Some((OTHER.to_string(), now, GEN));
        assert!(!confirm_gate(&mut pending, WINNER, CURRENT, false, now, GEN));
        assert_eq!(pending, Some((WINNER.to_string(), now, GEN)));
    }

    #[test]
    fn urgent_passes_and_clears_pending() {
        let now = Instant::now();
        let mut pending = Some((OTHER.to_string(), now, GEN));
        assert!(confirm_gate(&mut pending, WINNER, CURRENT, true, now, GEN));
        assert_eq!(pending, None);
    }

    #[test]
    fn winner_is_current_clears_and_passes() {
        let now = Instant::now();
        let mut pending = Some((OTHER.to_string(), now, GEN));
        assert!(confirm_gate(&mut pending, CURRENT, CURRENT, false, now, GEN));
        assert_eq!(pending, None);
    }

    #[test]
    fn empty_winner_leaves_pending_and_passes() {
        let now = Instant::now();
        let recorded = now - Duration::from_secs(30);
        let mut pending = Some((OTHER.to_string(), recorded, GEN));
        assert!(confirm_gate(&mut pending, "", CURRENT, false, now, GEN));
        assert_eq!(pending, Some((OTHER.to_string(), recorded, GEN)));
    }

    #[test]
    fn stale_generation_second_win_holds_and_rerecords() {
        // 记下胜者 -> 代次失效（手动操作调 invalidate_pending_confirm
        // 递增代次）-> 同胜者再来：代次不符视为无待确认，按首胜处理，
        // 不确认，并以新代次重新记下。
        let now = Instant::now();
        let mut pending = None;
        assert!(!confirm_gate(&mut pending, WINNER, CURRENT, false, now, GEN));
        assert_eq!(pending, Some((WINNER.to_string(), now, GEN)));
        assert!(!confirm_gate(&mut pending, WINNER, CURRENT, false, now, GEN + 1));
        assert_eq!(pending, Some((WINNER.to_string(), now, GEN + 1)));
    }
}
