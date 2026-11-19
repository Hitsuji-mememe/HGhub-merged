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
    // 空目录判不健康（audit6 §二条 6 / §五 P0-B.5）：items 为空数组时
    // 下方 iter().all() 恒真、total 只验存在不验 >0，空壳镜像能混进
    // 候选池。硬要求：至少一条内容且 total ≥ 1。
    if items.is_empty() || integer("total").is_none_or(|n| n == 0) {
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

/// 两轮确认的代次校验结果（最终版 C 线 P1-05，②实锤）：Pass＝可直接
/// 生效；Hold＝已记待确认、调用方改写为 confirm-pending；Stale＝任务
/// 开始时捕获的代次与当前代次不符（期间发生手动切线/改代理等使
/// invalidate_pending_confirm 递增代次的操作），旧结果作废——不确认、
/// 不写待确认、不动现有待确认槽，调用方改写为 stale-generation。
#[derive(Debug, PartialEq, Eq)]
enum ConfirmOutcome {
    Pass,
    Hold,
    Stale,
}

/// confirm_gate 的捕获代次版（P1-05）：auto_pick 在任务开始捕获
/// CONFIRM_GEN（captured_gen，口径同 record_throughput_with_mode 在
/// 测量开始捕获 proxyMode），收尾时连同当前代次（current_gen）一并
/// 传入。两者不符说明本轮结果是在旧环境下测得的：旧实现收尾才
/// CONFIRM_GEN.load() 读末代次，等于给旧 winner 盖新代次的章写回
/// 待确认槽，下一轮同 winner 会被误判「连续两轮」直接切换；且若
/// 合法新轮已先写入待确认，旧任务还能冒充其第二轮。本函数在代次
/// 不符时不碰 pending、直接判 Stale，从根上堵这两条。
fn confirm_gate_captured(
    pending: &mut Option<(String, Instant, u64)>,
    winner: &str,
    current: &str,
    urgent: bool,
    now: Instant,
    captured_gen: u64,
    current_gen: u64,
) -> ConfirmOutcome {
    if captured_gen != current_gen {
        return ConfirmOutcome::Stale;
    }
    if confirm_gate(pending, winner, current, urgent, now, current_gen) {
        ConfirmOutcome::Pass
    } else {
        ConfirmOutcome::Hold
    }
}

/// 自动选线（2026-11-18 收官批 D 重做）：延迟探测主站 + 可信发布
/// 镜像候选（auto_candidates 上限 10 条），可达者进吞吐探测池
/// （池规则见 crate::line_rank：可达 ≤6 全测／>6 池内轮换）逐个拉
/// 真实分片测吞吐，按「吞吐为主、延迟为辅」综合
/// 排名（crate::line_rank）。旧规则（主站活着直接用主站、只按延迟选、
/// pick_from_hits）作废——延迟低不等于拉流快。全部不可达 → all-down，
/// 调用方保持当前线路。发布页错误不丢弃已探到的候选，只记 mirror_error。
/// 结果附 published/probed/okCount 三个覆盖计数（整改 2）：诊断报告
/// 直接复用本轮探测结果，不再为生成报告重测一遍。
pub async fn auto_pick(urgent: bool) -> Value {
    /* 代理模式在测量开始时捕获（整改 A5，Hark G2 P2-1）：整轮探测
     * 可达 20+ 秒，期间用户切代理时，测得的吞吐必须记回测量开始时
     * 环境的账本键——记账点（probe_and_rank 的 record 循环）现读
     * 当前模式会把旧环境样本污染进新环境画像。 */
    let mode_at_start = crate::proxy::mode();
    /* 确认代次在任务开始时捕获（最终版 C 线 P1-05，口径同上方
     * mode_at_start）：整轮探测含多次网络 await，期间手动切线/改
     * 代理会递增 CONFIRM_GEN 并清待确认——收尾校验捕获值，代次已
     * 变则本轮结果判 stale，不许用末代次给旧 winner 盖章写回槽位。 */
    let confirm_gen_at_start = CONFIRM_GEN.load(Ordering::SeqCst);
    auto_pick_with_probe(urgent, confirm_gen_at_start, probe_and_rank(mode_at_start)).await
}

/// 选线内层（P1-05 验收加强）：探测相以 Future 注入、门相走生产
/// apply_confirm_gate。auto_pick 本身即经此路径；测试可用 Tokio
/// Barrier 把注入的探测 Future 真卡在 await 中途做代次介入，验的
/// 仍是生产门相而非另写一份模拟。
async fn auto_pick_with_probe(
    urgent: bool,
    captured_gen: u64,
    probe: impl std::future::Future<Output = Value>,
) -> Value {
    let result = probe.await;
    apply_confirm_gate(result, captured_gen, urgent)
}

/// 探测相：延迟探测 + 排名 + 被动记账，产出尚未过两轮确认门的结果。
async fn probe_and_rank(mode_at_start: crate::proxy::Mode) -> Value {
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
    /* 被动记账（U2 一期）：pick_ranked 的 candidates 带每条候选经真实
     * 首分片测得的 kbps（未测到的为 null），回写账本 EWMA。只记
     * origin 与聚合吞吐，不记分片 URL；all-down 结果的 candidates
     * 是 hits 形状、无 kbps 字段，自然跳过。 */
    if let Some(candidates) = result.get("candidates").and_then(Value::as_array) {
        for candidate in candidates {
            if let (Some(url), Some(kbps)) = (
                candidate.get("url").and_then(Value::as_str),
                candidate.get("kbps").and_then(Value::as_u64),
            ) {
                if kbps > 0 {
                    super::ledger::record_throughput_with_mode(
                        url,
                        kbps.saturating_mul(1000),
                        mode_at_start,
                    );
                }
            }
        }
    }
    result
}

/// 门相：两轮确认（整改 5）——决策在 confirm_gate（纯函数，契约见
/// 其 tests），经 confirm_gate_captured 做捕获代次校验（P1-05）；
/// 锁失败按放行处理（不拦截、不改结果，与原内联实现一致）。拦截
/// 时把 base 改回当前线并标 reason=confirm-pending，调用方据此约
/// 下一轮确认探测；次轮同胜者才真切。代次已变时标
/// reason=stale-generation、同样保持当前线，但不记待确认。
fn apply_confirm_gate(mut result: Value, confirm_gen_at_start: u64, urgent: bool) -> Value {
    let current = crate::net::base();
    let winner = result.get("base").and_then(Value::as_str).unwrap_or_default().to_string();
    let outcome = match PENDING_WINNER.lock() {
        Ok(mut pending) => confirm_gate_captured(
            &mut pending,
            &winner,
            &current,
            urgent,
            Instant::now(),
            confirm_gen_at_start,
            CONFIRM_GEN.load(Ordering::SeqCst),
        ),
        Err(_) => ConfirmOutcome::Pass,
    };
    match outcome {
        ConfirmOutcome::Pass => {}
        ConfirmOutcome::Hold => {
            result["pendingWinner"] = json!(winner);
            result["base"] = json!(current);
            result["reason"] = json!("confirm-pending");
        }
        ConfirmOutcome::Stale => {
            /* 代次已变（手动切线/改代理介入）：本轮旧结果作废、保持
             * 当前线路，不写 pendingWinner（槽位未被本轮触碰）。 */
            result["base"] = json!(current);
            result["reason"] = json!("stale-generation");
        }
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

    /* 根治包回归（audit6 §二条 6 / §五 P0-B.5）：空目录判不健康。
     * 旧实现 items 空数组 iter().all() 恒真、total 只验存在不验 >0，
     * 空壳镜像能过健康检查进候选——本用例在旧代码上先红，修复后转绿。 */
    #[test]
    fn healthy_rejects_empty_directory() {
        let empty = json!({"items": [], "pagination": {"page": 1, "pages": 0, "size": 1, "total": 0}});
        assert!(!healthy_video_data(&empty), "空目录必须判不健康");
        let zero_total = json!({"items": [{"id": 1, "title": "x"}], "pagination": {"page": 1, "pages": 1, "size": 1, "total": 0}});
        assert!(!healthy_video_data(&zero_total), "total=0 必须判不健康");
    }

    /* ── 最终版 C 线 P1-05（②实锤，GPT 复审独检）：auto_pick 必须在
     * 任务开始捕获 CONFIRM_GEN，写 PENDING_WINNER 前校验捕获值仍为
     * 当前值。旧实现全部 await 后才 CONFIRM_GEN.load() 读末代次给旧
     * 结果盖章：手动切线/改代理已递增代次并清槽，旧任务仍能把旧
     * winner 以新代次写回。下面用例钉住 captured 口径。 ── */
    #[test]
    fn stale_capture_does_not_write_pending() {
        let now = Instant::now();
        let mut pending = None;
        // 任务开始捕获 GEN；中途手动操作递增到 GEN+1 并清槽；旧任务收尾
        let outcome = confirm_gate_captured(&mut pending, WINNER, CURRENT, false, now, GEN, GEN + 1);
        assert_eq!(outcome, ConfirmOutcome::Stale, "代次已变的旧任务必须判 stale");
        assert_eq!(pending, None, "stale 旧任务不许把旧 winner 写回待确认槽");
    }

    #[test]
    fn stale_capture_does_not_confirm_or_clear_legit_pending() {
        let now = Instant::now();
        // invalidate 后合法新轮已写入 OTHER 的待确认；旧任务同名胜者
        // 也不许冒充第二轮确认，更不许清掉合法待确认
        let recorded = now - Duration::from_secs(10);
        let mut pending = Some((WINNER.to_string(), recorded, GEN + 1));
        let outcome = confirm_gate_captured(&mut pending, WINNER, CURRENT, false, now, GEN, GEN + 1);
        assert_eq!(outcome, ConfirmOutcome::Stale);
        assert_eq!(pending, Some((WINNER.to_string(), recorded, GEN + 1)), "stale 任务不许动合法待确认槽");
    }

    /* ── P1-05 真并发卡点（验收加强，GPT 复审裁定第 6 项）：不用调用
     * 顺序模拟——把经生产路径 auto_pick_with_probe 的任务用 Tokio
     * Barrier 真卡在探测 await 中途，主任务在此期间执行手动切线/
     * 改代理的代次动作（invalidate_pending_confirm：CONFIRM_GEN+1
     * ＋清槽，line_set/proxy_set/line_cancel 共同动作），再释放旧
     * 任务，断言其旧 winner 未污染 PENDING_WINNER、结果判 stale。
     * 对照段：无介入的同形态任务正常记待确认（Hold 语义不变）。
     * 两段串行于同一测试内：全局代次/槽位只许本测试触碰，避免与其
     * 他用例并行互扰（其余 confirm 用例都用本地 pending）。 */
    #[tokio::test]
    async fn auto_pick_stalled_task_cannot_pollute_pending() {
        use std::sync::Arc;
        use tokio::sync::Barrier;
        invalidate_pending_confirm();
        // ── 段 1：中途被手动操作介入的旧任务 ──
        let captured = CONFIRM_GEN.load(Ordering::SeqCst);
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let (e2, r2) = (entered.clone(), release.clone());
        let probe = async move {
            e2.wait().await; // 已进入探测 await（网络等待的卡点）
            r2.wait().await; // 真卡住，直到主任务放行
            json!({ "base": WINNER, "tier": "mirror", "ms": 1, "reason": "mirror-ok", "candidates": [] })
        };
        let task = tokio::spawn(auto_pick_with_probe(false, captured, probe));
        entered.wait().await; // 任务确已到达探测 await
        invalidate_pending_confirm(); // 手动切线/改代理：代次+1 并清槽
        assert_eq!(CONFIRM_GEN.load(Ordering::SeqCst), captured + 1);
        release.wait().await; // 放行旧任务收尾
        let result = task.await.expect("旧任务应正常收尾");
        assert_eq!(result["reason"], json!("stale-generation"), "代次已变的旧任务结果必须判 stale");
        {
            let pending = PENDING_WINNER.lock().expect("待确认锁");
            assert!(pending.is_none(), "旧 winner 不许污染待确认槽，实际 {:?}", *pending);
        }
        // ── 段 2：无介入对照——同形态任务正常记待确认 ──
        let captured2 = CONFIRM_GEN.load(Ordering::SeqCst);
        let entered2 = Arc::new(Barrier::new(2));
        let release2 = Arc::new(Barrier::new(2));
        let (e3, r3) = (entered2.clone(), release2.clone());
        let probe2 = async move {
            e3.wait().await;
            r3.wait().await;
            json!({ "base": WINNER, "tier": "mirror", "ms": 1, "reason": "mirror-ok", "candidates": [] })
        };
        let task2 = tokio::spawn(auto_pick_with_probe(false, captured2, probe2));
        entered2.wait().await;
        release2.wait().await; // 不做任何代次动作，直接放行
        let result2 = task2.await.expect("对照任务应正常收尾");
        assert_eq!(result2["reason"], json!("confirm-pending"), "无介入时首胜应记待确认并拦截");
        {
            let pending = PENDING_WINNER.lock().expect("待确认锁");
            let recorded = pending.as_ref().expect("对照任务应已写入待确认");
            assert_eq!(recorded.0, WINNER);
            assert_eq!(recorded.2, captured2, "待确认须带任务捕获的代次");
        }
        invalidate_pending_confirm(); // 清理全局状态，不给其他用例留尾
    }

    #[test]
    fn same_generation_capture_keeps_two_round_semantics() {
        let now = Instant::now();
        let mut pending = None;
        assert_eq!(confirm_gate_captured(&mut pending, WINNER, CURRENT, false, now, GEN, GEN), ConfirmOutcome::Hold);
        assert_eq!(pending, Some((WINNER.to_string(), now, GEN)));
        assert_eq!(confirm_gate_captured(&mut pending, WINNER, CURRENT, false, now, GEN, GEN), ConfirmOutcome::Pass);
        assert_eq!(pending, None);
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
