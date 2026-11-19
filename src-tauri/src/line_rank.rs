//! 自动选线的吞吐探测与综合排名（2026-11-18 收官批 D 项；根治包
//! P0-B 改版，Muse 2026-11-19，audit6 §五 P0-B.1/.4）。
//!
//! 旧规则只按接口延迟（probe_hit 的 ms）选线——延迟低不等于拉流快。
//! 探测口径（改版）：全候选测**同一内容**——以当前线目录首条视频为
//! 锚，各候选请求同一 id 的首分片、固定 512KB 字节预算、连测 2 次
//! 取低值（悲观样本压噪声）；某候选没有锚内容 → 标 incomparable、
//! 只记延迟不进吞吐排名。探测串行（并行会互相污染带宽），单候选
//! 整体超时 6 秒、整轮预算 20 秒。
//!
//! 排名目标函数（改版）：速度优先、防抖动为约束——分带收窄到 90%
//! （差 >10% 不配进带）、当前线粘性放宽到 80%（胜者快 ≥1.25× 必
//! 换，防抖动由两轮确认＋熔断＋退避承担）；带内决胜顺序＝真实播放
//! EWMA（账本 play）＞本轮实测＞探测 EWMA（账本 probe）＞延迟。
//!
//! 本模块独立于 lines/ 尺寸预算目录：lines::probe 只负责延迟探测与
//! 候选清单，排名与吞吐在此处。

use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// 一条候选的综合度量：延迟来自 lines::probe_hit；bps 是本轮同内容
/// 实测吞吐；play_bps / probe_hist_bps 是账本双 EWMA（play＝真实
/// 播放样本、probe＝主动探测样本，均 ≥3 样本才有值，见
/// lines::ledger::tiebreak）；incomparable＝该候选没有锚内容、本轮
/// 不可比（bps 必为 None）。
#[derive(Clone, Debug)]
pub struct LineMeasure {
    pub url: String,
    pub tier: String,
    pub ms: u64,
    pub bps: Option<u64>,
    pub play_bps: Option<f64>,
    pub probe_hist_bps: Option<f64>,
    pub incomparable: bool,
}

impl LineMeasure {
    fn json(&self) -> Value {
        json!({ "url": self.url, "tier": self.tier, "ms": self.ms,
            "kbps": self.bps.map(|b| b / 1000),
            "play_kbps": self.play_bps.map(|b| (b / 1000.0) as u64),
            "hist_kbps": self.probe_hist_bps.map(|b| (b / 1000.0) as u64),
            "incomparable": self.incomparable })
    }

    /// 参与分带的生效吞吐：本轮实测优先（实时证据压过历史——当前
    /// 已退化的线不能靠旧画像留在带内），实测缺失时依次用账本
    /// play EWMA、probe EWMA 估算（账本已用最小样本数把过关）。
    fn effective_bps(&self) -> Option<f64> {
        self.bps.map(|b| b as f64).or(self.play_bps).or(self.probe_hist_bps)
    }
}

/// 「同吞吐」带宽：最高吞吐的 10% 以内视为同档（根治包由 80 收窄
/// 到 90：差 20% 靠历史胜出是旧目标函数「够用不换」的残留，速度
/// 优先口径下带外差异就是真的快慢）。带内按置信度决胜（见
/// rank_lines）。
const SAME_BAND_PERCENT: u64 = 90;

/// 可选数值降序比较（Some 胜 None，两 Some 时大者胜）：非有限值
/// 按「无数据」处理，不许毒化排序（账本已保证有限正数，此为兜底）。
fn cmp_opt_desc(a: Option<f64>, b: Option<f64>) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let a = a.filter(|v| v.is_finite());
    let b = b.filter(|v| v.is_finite());
    match (a, b) {
        (Some(x), Some(y)) => y.partial_cmp(&x).unwrap_or(Ordering::Equal),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

/// 带内决胜比较（Less＝更优）：真实播放 EWMA ＞ 本轮实测 ＞ 探测
/// EWMA ＞ 主站优先 ＞ 延迟（根治包 P0-B.4）。全等返回 Equal，
/// 由 rank_lines 的顺序扫描保留先出现者。
fn cmp_in_band(a: &LineMeasure, b: &LineMeasure) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    cmp_opt_desc(a.play_bps, b.play_bps)
        .then_with(|| cmp_opt_desc(a.bps.map(|v| v as f64), b.bps.map(|v| v as f64)))
        .then_with(|| cmp_opt_desc(a.probe_hist_bps, b.probe_hist_bps))
        .then_with(|| (b.tier == "main").cmp(&(a.tier == "main")))
        .then_with(|| a.ms.cmp(&b.ms))
        .then(Ordering::Equal)
}

/// 综合排名（纯函数，可注入假度量验证）。fix2 Batch D 两阶段中的
/// 第二阶段「置信度排序」（第一阶段硬排除在 pick_ranked 侧）：
/// - 无候选 → None（调用方保持当前线路，即「全挂保留当前线」）；
/// - 生效吞吐（实测优先、账本 EWMA 兜底）取带（≥最高值 ×90%），
///   带外淘汰——吞吐落后 10% 以上者无论延迟多低都不胜；
/// - 无样本候选（实测与账本皆无）不硬排除（P2-04 根治，兑现模块头
///   「退回延迟比较」的承诺）：并入池内、以最低置信度参选——只要
///   有任一带内候选，它在 cmp_in_band 里必然垫底；全员无样本时
///   池＝全体，比较器自然回落到延迟决胜；
/// - 带内决胜顺序见 cmp_in_band；全等取先出现者（池已按主站优先
///   排序，主站同分先胜）。
pub fn rank_lines(measures: &[LineMeasure]) -> Option<&LineMeasure> {
    if measures.is_empty() {
        return None;
    }
    let best = measures.iter().filter_map(|m| m.effective_bps()).fold(None::<f64>, |acc, b| {
        Some(acc.map_or(b, |a: f64| a.max(b)))
    });
    let pool: Vec<&LineMeasure> = match best {
        Some(best) => {
            let floor = best * (SAME_BAND_PERCENT as f64) / 100.0;
            let band: Vec<&LineMeasure> = measures
                .iter()
                .filter(|m| match m.effective_bps() {
                    Some(b) => b >= floor,
                    None => true, // 无样本：并入池内垫底参选（P2-04）
                })
                .collect();
            if band.is_empty() { measures.iter().collect() } else { band }
        }
        None => measures.iter().collect(),
    };
    // 顺序扫描取严格最优：全等保留先出现者（min_by 在全等时返回
    // 末位元素，会破坏主站优先，故不用）。
    let mut winner: Option<&LineMeasure> = None;
    for candidate in pool {
        match winner {
            None => winner = Some(candidate),
            Some(current) => {
                if cmp_in_band(candidate, current) == std::cmp::Ordering::Less {
                    winner = Some(candidate);
                }
            }
        }
    }
    winner
}

/// 粘性决策（纯函数，pick_ranked 用）：当前线是否留任。根治包
/// P0-B.4——粘性 60%→80%：双方都有生效吞吐时，当前线须严格高于
/// 胜者 80% 才留任；恰好 80%（＝胜者快恰 1.25×）按裁定「胜者快
/// ≥1.25× 必换」处理、不留任。缺吞吐数据时回落延迟判据（当前线
/// 延迟 ≤胜者 2 倍留任，与旧制一致）。
fn stickiness_keeps(current: &LineMeasure, winner: &LineMeasure) -> bool {
    match (current.effective_bps(), winner.effective_bps()) {
        (Some(cb), Some(wb)) => cb * 100.0 > wb * 80.0,
        _ => current.ms <= winner.ms.saturating_mul(2),
    }
}

/// 第一阶段「硬排除」（fix2 Batch D，纯函数可测）：剔除正处于
/// 熔断退避期的候选（刚被自动切走，120s 内不许切回，防乒乓）。
/// 两条护栏：当前线路永不排除（连续性保护——正在用的线哪怕在
/// 退避表里也必须能参与排名留任）；排除后为空则整表回退未排除
/// 集合（退避是优化不是门禁，绝不许把可用候选清成 all-down）。
/// 不可达/连续失败已由 hits 输入契约与熔断窗口在上游处理；
/// 「地理不符」在本系统无数据源（线路均为同一服务镜像），不设。
pub fn apply_hard_exclusions(
    ordered: &[(String, String, u64)],
    current: Option<&str>,
    in_backoff: impl Fn(&str) -> bool,
) -> Vec<(String, String, u64)> {
    let kept: Vec<(String, String, u64)> = ordered
        .iter()
        .filter(|(_, url, _)| Some(url.as_str()) == current || !in_backoff(url))
        .cloned()
        .collect();
    if kept.is_empty() {
        ordered.to_vec()
    } else {
        kept
    }
}

/// 同内容探测的单次字节预算：每候选只取锚内容首分片的前 512KB，
/// 保证 bps 的分子口径一致（旧制整片下载，分片大小随 rendition 变，
/// bps 系统性不可比——audit6 §二条 6）。
const PROBE_BUDGET_BYTES: u64 = 512 * 1024;

/// 一次吞吐探测的结果：bps 为 None 时看 incomparable 区分原因——
/// true＝候选没有锚内容（本轮不可比，只记延迟）；false＝内容可比
/// 但没测出吞吐（超时/传输失败，以账本/延迟参与排名）。
pub struct ProbeOutcome {
    pub bps: Option<u64>,
    pub incomparable: bool,
}

/// 锚内容：当前线目录首条视频 id。全候选测同一 id，样本才可比；
/// 取不到锚（当前线目录异常）→ 本轮全体不可比、只按延迟/账本排。
async fn anchor_video_id() -> Option<i64> {
    let list = crate::net::edge(&crate::net::base(), "GET", "/api/videos?page=1&size=1", None, None)
        .await
        .ok()?;
    list.get("items")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(|v| v.get("id"))
        .and_then(Value::as_i64)
}

/// 经候选线路测锚内容首分片的吞吐（根治包 P0-B.1）：同一 id 的
/// playback → 首分片 → 固定预算流式取段，连测 2 次取低值（悲观
/// 样本压首连接/瞬时负载噪声）。候选拿不到锚内容的 playback
/// （目录 desync/无此片）→ incomparable。走生产网络栈，测的是
/// 用户真实播放路径，不是裸连。
/// 单候选整体超时 6 秒（2026-11-18 晚整改 3）：原 15 秒是整轮探测
/// 的预算黑洞；6 秒内拉不满 512KB×2 的线路当下就不适合优先播放。
pub async fn probe_throughput(origin: &str, anchor: Option<i64>) -> ProbeOutcome {
    let Some(anchor) = anchor else {
        return ProbeOutcome { bps: None, incomparable: true };
    };
    match tokio::time::timeout(Duration::from_secs(6), throughput_inner(origin, anchor)).await {
        Ok(outcome) => outcome,
        Err(_) => ProbeOutcome { bps: None, incomparable: false },
    }
}

async fn throughput_inner(origin: &str, anchor: i64) -> ProbeOutcome {
    let unmeasured = ProbeOutcome { bps: None, incomparable: false };
    let info = match crate::net::edge(
        origin,
        "POST",
        &format!("/api/videos/{anchor}/episodes/1/playback"),
        Some(json!({})),
        None,
    )
    .await
    {
        Ok(info) => info,
        // 锚内容在此候选上取不到 playback：判不可比（区别于测速失败）。
        Err(_) => return ProbeOutcome { bps: None, incomparable: true },
    };
    let playlist_url = info
        .get("streams")
        .and_then(|s| s.get("main"))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .or_else(|| info.get("video_url").and_then(Value::as_str).filter(|s| !s.trim().is_empty()))
        .map(str::to_string);
    let Some(playlist_url) = playlist_url else {
        return ProbeOutcome { bps: None, incomparable: true };
    };
    let seg_url = match crate::speed_probe::resolve_first_segment(&playlist_url).await {
        Ok(url) => url,
        Err(_) => return unmeasured,
    };
    // 连测 2 次取低值；只成一次时用该次（样本少但仍是同内容实测）。
    let first = fetch_budgeted_bps(&seg_url).await;
    let second = fetch_budgeted_bps(&seg_url).await;
    let bps = match (first, second) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) | (None, Some(a)) => Some(a),
        (None, None) => None,
    };
    ProbeOutcome { bps, incomparable: false }
}

/// 流式取首分片的前 PROBE_BUDGET_BYTES 字节并计 bps：Range 取段，
/// 服务器忽略 Range 回 200 时同样在预算处停读（分子口径一致）；
/// Accept-Encoding 写死 identity（Range 坐标系只对 identity 成立，
/// 与 range_fetch 同理）。计时从发请求到读满预算/读完分片。
async fn fetch_budgeted_bps(seg_url: &str) -> Option<u64> {
    let range = format!("bytes=0-{}", PROBE_BUDGET_BYTES - 1);
    let referer = format!("{}/", crate::net::base());
    let started = Instant::now();
    let mut resp = crate::range_fetch::get_with_dns_h(
        seg_url,
        Duration::from_secs(6),
        None,
        Some(&referer),
        false,
        &[("Range", &range), ("Accept-Encoding", "identity")],
    )
    .await
    .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let mut got: u64 = 0;
    while got < PROBE_BUDGET_BYTES {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                got = got.saturating_add(chunk.len() as u64).min(PROBE_BUDGET_BYTES);
            }
            Ok(None) => break,
            Err(_) => return None,
        }
    }
    let elapsed_ms = started.elapsed().as_millis() as u64;
    if got == 0 || elapsed_ms == 0 {
        return None;
    }
    Some(got * 8 * 1000 / elapsed_ms)
}

/// 整轮吞吐探测总预算（整改 3）：超过后剩余候选不再实测、以无吞吐
/// 数据参与排名——单条 6 秒超时之外再加一道整轮闸，防一轮选线拖到
/// 几十秒挤占播放带宽。
const ROUND_BUDGET: Duration = Duration::from_secs(20);

/// 吞吐池轮换游标（复审批 §3）：逐轮推进，保证池外候选长期轮得到
/// 被测机会，而不是永远排在固定前几名之后。
static ROTATE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// 给已延迟探测的候选补吞吐并排名，产出与旧 pick_from_hits 同形状的结果
/// （base/tier/ms/reason/candidates），candidates 附每条的 kbps。
/// 吞吐探测串行、池上限 4 条。池构成（2026-11-18 晚复审批，GPT 公平性
/// 质疑后改）：旧制只取延迟前 4——池外候选永远测不到吞吐、永远赢不了，
/// 当前线跌出前 4 还会被粘性当作不可达直接换掉。现池＝延迟前 2 +
/// 当前线保底（可达且未入池时）+ 其余候选轮换 1 条。
/// 吞吐探测池构成（纯函数，2026-11-18 晚故障注入批自 pick_ranked
/// 等价提取，契约由本文件 tests 钉住）：入参 ordered 已由调用方按
/// 延迟序（主站优先）排序。池＝前 2 + 当前线保底（在候选中且未入池
/// 时）+ 池外轮换 1 条（rotate 游标取模，池 <4 且有池外候选才取）。
/// 返回（池， 是否消耗了轮换位）；池保持未重排状态，主站优先重排
/// 留在调用方。
fn select_pool(
    ordered: &[(String, String, u64)],
    current: Option<&str>,
    rotate: usize,
) -> (Vec<(String, String, u64)>, bool) {
    let mut pool: Vec<(String, String, u64)> = ordered.iter().take(2).cloned().collect();
    if let Some(cur) = current {
        if let Some(hit) = ordered.iter().find(|(_, u, _)| u.as_str() == cur) {
            if !pool.contains(hit) {
                pool.push(hit.clone());
            }
        }
    }
    let mut rotated = false;
    if pool.len() < 4 {
        let rest: Vec<&(String, String, u64)> =
            ordered.iter().filter(|h| !pool.contains(h)).collect();
        if !rest.is_empty() {
            pool.push(rest[rotate % rest.len()].clone());
            rotated = true;
        }
    }
    (pool, rotated)
}

pub async fn pick_ranked(hits: Vec<(String, String, u64)>, current: Option<&str>) -> Value {
    let round_started = Instant::now();
    let mut ordered = hits;
    ordered.sort_by_key(|(tier, _, ms)| (tier != "main", *ms));
    /* 硬排除（fix2 Batch D 第一阶段）：退避期候选先出局再组池，
     * 省下探测预算给真候选；护栏见 apply_hard_exclusions。 */
    let ordered = apply_hard_exclusions(&ordered, current, crate::lines::ledger::in_backoff);
    /* 池构成（根治包 P0-B.1）：可达候选 ≤6 时全测（同内容探测后样本
     * 可比，池外轮换的探索补偿不再必要）；>6 时沿用旧制 select_pool
     * （前 2＋当前线保底＋轮换 1 条，契约由本文件 tests 钉住）。 */
    let mut pool = if ordered.len() <= 6 {
        ordered.clone()
    } else {
        let (pool, rotated) =
            select_pool(&ordered, current, ROTATE.load(std::sync::atomic::Ordering::SeqCst));
        if rotated {
            ROTATE.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        pool
    };
    pool.sort_by_key(|(tier, _, ms)| (tier != "main", *ms));
    // 锚内容只取一次：全候选测同一 id 的首分片（P0-B.1）。
    let anchor = anchor_video_id().await;
    let mut measures: Vec<LineMeasure> = Vec::new();
    for (tier, url, ms) in pool {
        let outcome = if round_started.elapsed() > ROUND_BUDGET {
            ProbeOutcome { bps: None, incomparable: false }
        } else {
            probe_throughput(&url, anchor).await
        };
        let tb = crate::lines::ledger::tiebreak(&url);
        measures.push(LineMeasure {
            url,
            tier,
            ms,
            bps: outcome.bps,
            play_bps: tb.play,
            probe_hist_bps: tb.probe,
            incomparable: outcome.incomparable,
        });
    }
    let candidates: Vec<Value> = measures.iter().map(LineMeasure::json).collect();
    match rank_lines(&measures) {
        Some(winner) => {
            /* 粘性（Muse 2026-11-18 真机反馈「线路一直变」；根治包
             * P0-B.4 参数改版）：判据在 stickiness_keeps——当前线生效
             * 吞吐 ≥胜者 80% 才留任，胜者快 ≥1.25× 必换（防抖动改由
             * 两轮确认＋熔断＋退避承担，不再靠粘性吞掉明显差距）。
             * 当前线路不可达（不在 measures 里）或明显更差才真切换。 */
            let winner = match current {
                Some(cur) if winner.url != cur => match measures.iter().find(|m| m.url == cur) {
                    Some(cur_m) => {
                        if stickiness_keeps(cur_m, winner) { cur_m } else { winner }
                    }
                    None => winner,
                },
                _ => winner,
            };
            json!({ "base": winner.url, "tier": winner.tier, "ms": winner.ms,
            "kbps": winner.bps.map(|b| b / 1000),
            "reason": if winner.tier == "main" { "main-ok" } else { "mirror-ok" },
            "candidates": candidates })
        }
        None => json!({ "base": "", "tier": "none", "ms": 0, "reason": "all-down", "candidates": candidates }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(url: &str, ms: u64, bps: Option<u64>) -> LineMeasure {
        LineMeasure { url: url.into(), tier: "mirror".into(), ms, bps, play_bps: None, probe_hist_bps: None, incomparable: false }
    }

    fn mh(url: &str, ms: u64, bps: Option<u64>, hist: f64) -> LineMeasure {
        LineMeasure { url: url.into(), tier: "mirror".into(), ms, bps, play_bps: None, probe_hist_bps: Some(hist), incomparable: false }
    }

    fn mp(url: &str, ms: u64, bps: Option<u64>, play: f64) -> LineMeasure {
        LineMeasure { url: url.into(), tier: "mirror".into(), ms, bps, play_bps: Some(play), probe_hist_bps: None, incomparable: false }
    }

    /* ── 根治包 P0-B：带内决胜顺序与粘性参数（audit6 §五 P0-B.4）── */
    #[test]
    fn play_ewma_beats_fresh_measurement_inside_band() {
        // 同带（生效吞吐差 ≤10%）：有真实播放画像者胜，哪怕其实测略低
        let measures = vec![
            m("fresh-only", 40, Some(4_000_000)),
            mp("played", 120, Some(3_700_000), 3_800_000.0),
        ];
        assert_eq!(rank_lines(&measures).map(|w| w.url.as_str()), Some("played"));
    }

    #[test]
    fn main_wins_full_tie_inside_band() {
        // 全部度量相同：主站优先（带内同分主站胜，P0-B.3 的带内优先）
        let mut main = m("main-line", 50, Some(4_000_000));
        main.tier = "main".into();
        let measures = vec![m("mirror-line", 50, Some(4_000_000)), main];
        assert_eq!(rank_lines(&measures).map(|w| w.url.as_str()), Some("main-line"));
    }

    #[test]
    fn stickiness_switches_when_winner_is_25_percent_faster() {
        let cur = m("cur", 50, Some(4_000_000));
        let winner = m("winner", 50, Some(5_000_000));
        assert!(!stickiness_keeps(&cur, &winner), "胜者快 1.25× 必须换");
        let close = m("winner", 50, Some(4_400_000));
        assert!(stickiness_keeps(&cur, &close), "胜者只快 1.1× 留任");
    }

    #[test]
    fn unmeasured_candidate_ranks_last_but_is_not_excluded() {
        // P2-04：无样本候选并入池内垫底——延迟再低也不越过有样本者；
        // 但它仍是合法候选（全员无样本时按延迟胜，见
        // no_throughput_falls_back_to_latency）。
        let measures = vec![
            m("unmeasured-fast", 5, None),
            m("measured-slow", 900, Some(1_000_000)),
        ];
        assert_eq!(rank_lines(&measures).map(|w| w.url.as_str()), Some("measured-slow"));
    }

    /* ── fix2 Batch D：置信度排序与硬排除 ─────────────────── */
    #[test]
    fn hist_breaks_same_band_by_confidence_not_latency() {
        // 同带（实测吞吐差 10%）：延迟低者历史差 → 历史高者胜
        let measures = vec![
            mh("low-latency", 40, Some(3_600_000), 2_000_000.0),
            mh("proven", 120, Some(4_000_000), 6_000_000.0),
        ];
        assert_eq!(rank_lines(&measures).map(|w| w.url.as_str()), Some("proven"));
    }

    #[test]
    fn hist_substitutes_missing_fresh_measurement() {
        // 一方本轮没测到吞吐但有历史画像：历史进带参与淘汰
        let measures = vec![
            m("fresh-slow", 30, Some(1_000_000)),
            mh("hist-fast", 200, None, 5_000_000.0),
        ];
        assert_eq!(rank_lines(&measures).map(|w| w.url.as_str()), Some("hist-fast"));
    }

    #[test]
    fn fresh_measurement_overrides_stale_history_for_banding() {
        // 本轮实测很差（实时证据优先）：历史再好也进不了带
        let measures = vec![
            mh("degraded-now", 30, Some(500_000), 9_000_000.0),
            m("steady", 90, Some(4_000_000)),
        ];
        assert_eq!(rank_lines(&measures).map(|w| w.url.as_str()), Some("steady"));
    }

    #[test]
    fn exclusion_drops_backoff_but_never_current() {
        let ordered = vec![h("a", 10), h("b", 20), h("c", 30)];
        let kept = apply_hard_exclusions(&ordered, Some("b"), |u| u == "a" || u == "b");
        assert_eq!(pool_urls(&kept), vec!["b", "c"]);
    }

    #[test]
    fn exclusion_empty_result_falls_back_to_full_set() {
        let ordered = vec![h("a", 10), h("b", 20)];
        let kept = apply_hard_exclusions(&ordered, None, |_| true);
        assert_eq!(kept.len(), 2, "全排除时必须回退未排除集合");
    }

    #[test]
    fn higher_throughput_wins_over_latency() {
        // 吞吐 2 倍于对手：即使延迟更高也胜（带外淘汰）
        let measures = vec![m("fast-latency", 30, Some(2_000_000)), m("fast-throughput", 200, Some(4_000_000))];
        assert_eq!(rank_lines(&measures).map(|w| w.url.as_str()), Some("fast-throughput"));
    }

    #[test]
    fn same_band_lower_latency_wins() {
        // 吞吐差 10%（同带）：延迟低者胜
        let measures = vec![m("a", 120, Some(3_600_000)), m("b", 40, Some(4_000_000))];
        assert_eq!(rank_lines(&measures).map(|w| w.url.as_str()), Some("b"));
    }

    #[test]
    fn no_throughput_falls_back_to_latency() {
        let measures = vec![m("a", 90, None), m("b", 25, None)];
        assert_eq!(rank_lines(&measures).map(|w| w.url.as_str()), Some("b"));
    }

    #[test]
    fn measured_beats_unmeasured_only_inside_band_logic() {
        // 有吞吐者进带；无吞吐者不进带（有数据时以数据为准）
        let measures = vec![m("unmeasured", 10, None), m("measured", 300, Some(1_000_000))];
        assert_eq!(rank_lines(&measures).map(|w| w.url.as_str()), Some("measured"));
    }

    #[test]
    fn empty_candidates_keep_current() {
        assert!(rank_lines(&[]).is_none());
    }

    /* ── 故障注入（2026-11-18 晚）：选线池构成契约。hits 元组为
     * (tier, url, ms)，ordered 由调用方按延迟序排好后传入。 ── */
    fn h(url: &str, ms: u64) -> (String, String, u64) {
        ("mirror".into(), url.into(), ms)
    }

    fn pool_urls(pool: &[(String, String, u64)]) -> Vec<&str> {
        pool.iter().map(|(_, u, _)| u.as_str()).collect()
    }

    #[test]
    fn pool_is_top2_plus_current_plus_one_rotation() {
        // 5 候选、当前线在前 2 之外：前 2 + 当前线保底 + 轮换 1 条
        let ordered = vec![h("a", 10), h("b", 20), h("c", 30), h("cur", 40), h("d", 50)];
        let (pool, rotated) = select_pool(&ordered, Some("cur"), 0);
        assert!(rotated);
        assert_eq!(pool_urls(&pool), vec!["a", "b", "cur", "c"]);
    }

    #[test]
    fn pool_rotation_picks_next_outsider() {
        let ordered = vec![h("a", 10), h("b", 20), h("c", 30), h("cur", 40), h("d", 50)];
        let (pool, rotated) = select_pool(&ordered, Some("cur"), 1);
        assert!(rotated);
        assert_eq!(pool_urls(&pool), vec!["a", "b", "cur", "d"]);
    }

    #[test]
    fn pool_current_in_top2_not_duplicated() {
        let ordered = vec![h("a", 10), h("b", 20), h("c", 30), h("d", 40), h("e", 50)];
        let (pool, rotated) = select_pool(&ordered, Some("a"), 0);
        assert!(rotated);
        assert_eq!(pool_urls(&pool), vec!["a", "b", "c"]);
        assert_eq!(pool.iter().filter(|(_, u, _)| u == "a").count(), 1);
    }

    #[test]
    fn pool_exhausted_candidates_no_rotation() {
        let ordered = vec![h("a", 10), h("b", 20)];
        let (pool, rotated) = select_pool(&ordered, Some("a"), 0);
        assert!(!rotated);
        assert_eq!(pool_urls(&pool), vec!["a", "b"]);
    }

    #[test]
    fn pool_current_absent_gets_no_reserved_slot() {
        let ordered = vec![h("a", 10), h("b", 20), h("c", 30), h("d", 40), h("e", 50)];
        let (pool, rotated) = select_pool(&ordered, Some("ghost"), 0);
        assert!(rotated);
        assert_eq!(pool_urls(&pool), vec!["a", "b", "c"]);
        assert!(!pool.iter().any(|(_, u, _)| u == "ghost"));
    }

    /* ── 防自我强化＋固定种子模拟（fix2.1 追加，GPT 四审裁定项）──
     * D 的反馈环风险：历史 EWMA 影响排名→胜者被选中→只有胜者拿到
     * 真实播放样本→EWMA 进一步强化→赢者通吃，哪怕别的线已经变快。
     * 两道防线在本组钉死：①分带用「生效吞吐」（本轮实测优先于历史），
     * 挑战者实测跃升后老胜者被带外淘汰，历史再厚也锁不死；
     * ②EWMA 只由胜者样本更新时自身有界（不发散），且 select_pool 的
     * 轮换位保证池外候选持续获得被探测机会（防饿死）。
     * 确定性：xorshift64* 固定种子，无系统随机/时间/网络输入。 */
    struct SimRng(u64);
    impl SimRng {
        fn next_u64(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545F4914F6CDD1D)
        }
        /* 0.92..1.08 的 ±8% 测量噪声（与真机探测日常波动同量级） */
        fn noise(&mut self) -> f64 {
            0.92 + 0.16 * ((self.next_u64() >> 11) as f64 / (1u64 << 53) as f64)
        }
    }

    #[test]
    fn sim_1000_rounds_no_lockin_after_conditions_change() {
        let mut rng = SimRng(0x9E37_79B9_7F4A_7C15);
        /* 真值（bps）：A 起始最快、B 次之、C 慢但延迟最低（延迟陷阱） */
        let mut true_bps = [10_000_000.0f64, 8_500_000.0, 5_000_000.0];
        let ms = [50u64, 60, 40];
        /* 历史只有 A 有（此前一直在用 A）——最容易锁死的初始条件 */
        let mut hist: [Option<f64>; 3] = [Some(9_800_000.0), None, None];
        let urls = ["a", "b", "c"];
        let mut first_b_win: Option<usize> = None;
        let mut late_b_wins = 0usize;
        for round in 0..1000usize {
            if round == 500 {
                true_bps[1] = 14_000_000.0; /* B 路况跃升为全场最快 */
            }
            let measured: Vec<u64> =
                true_bps.iter().map(|t| (t * rng.noise()) as u64).collect();
            let measures: Vec<LineMeasure> = (0..3)
                .map(|i| LineMeasure {
                    url: urls[i].into(),
                    tier: "mirror".into(),
                    ms: ms[i],
                    bps: Some(measured[i]),
                    play_bps: None,
                    probe_hist_bps: hist[i],
                    incomparable: false,
                })
                .collect();
            let winner = rank_lines(&measures).expect("候选非空必有胜者");
            let wi = urls.iter().position(|u| *u == winner.url).unwrap();
            if round < 500 {
                assert_eq!(winner.url, "a", "第 {round} 轮：路况未变时最快且有历史的 A 必须胜出");
            } else {
                if winner.url == "b" && first_b_win.is_none() {
                    first_b_win = Some(round);
                }
                if round >= 900 && winner.url == "b" {
                    late_b_wins += 1;
                }
            }
            /* 只有被选中（真实播放）的线拿到新样本更新 EWMA——反馈环
             * 的输入端。断言 EWMA 恒被样本包络界住、不发散。 */
            let sample = measured[wi] as f64;
            hist[wi] = Some(match hist[wi] {
                None => sample,
                Some(h) => h * 0.7 + sample * 0.3,
            });
            if let Some(h) = hist[wi] {
                assert!(h > 1_000_000.0 && h < 20_000_000.0, "第 {round} 轮 EWMA 发散: {h}");
            }
        }
        let fb = first_b_win.expect("B 跃升后 500 轮内必须至少胜出一次（历史不得锁死排名）");
        assert!(fb < 530, "B 跃升后应在 30 轮内被实测带门放行，实际第 {fb} 轮");
        assert!(late_b_wins >= 95, "末 100 轮 B 应近乎全胜，实际 {late_b_wins}");
    }

    #[test]
    fn sim_1000_rounds_pool_rotation_never_starves_outsiders() {
        let mut rng = SimRng(0xD1B5_4A32_D192_ED03);
        let ordered: Vec<(String, String, u64)> = (0..6)
            .map(|i| ("mirror".to_string(), format!("l{i}"), 10 + i as u64 * 10))
            .collect();
        let mut entries = [0usize; 6];
        let mut rotate = 0usize;
        for _ in 0..1000 {
            /* current 随机漂移，模拟用户当前线路在候选间变化 */
            let cur_idx = (rng.next_u64() % 6) as usize;
            let (pool, rotated) = select_pool(&ordered, Some(&ordered[cur_idx].1), rotate);
            if rotated {
                rotate += 1;
            }
            for (_, url, _) in &pool {
                entries[url[1..].parse::<usize>().unwrap()] += 1;
            }
        }
        for (i, n) in entries.iter().enumerate() {
            assert!(*n >= 100, "候选 l{i} 在 1000 轮里只进池 {n} 次（探索饿死）");
        }
    }
}
