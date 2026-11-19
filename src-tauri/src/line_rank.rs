//! 自动选线的吞吐探测与综合排名（2026-11-18 收官批 D 项）。
//!
//! 旧规则只按接口延迟（probe_hit 的 ms）选线——延迟低不等于拉流快。
//! 新规则：对每个可达候选拉一段真实分片（经该候选线路取播放地址与清单、
//! 再走生产媒体路 fetch_bytes 拉首分片）测实际吞吐，排名以吞吐为主、
//! 延迟为辅。探测串行（并行会互相污染带宽，与 speed_probe 同理），
//! 单候选整体超时 6 秒、整轮预算 20 秒；测不到吞吐的候选退回延迟比较。
//!
//! 本模块独立于 lines/ 尺寸预算目录：lines::probe 只负责延迟探测与
//! 候选清单，排名与吞吐在此处。

use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// 一条候选的综合度量：延迟来自 lines::probe_hit，吞吐来自真实分片，
/// hist_bps 是账本里的历史吞吐 EWMA（真实播放样本 ≥3 才有值，
/// fix2 Batch D 置信度排序输入）。
#[derive(Clone, Debug)]
pub struct LineMeasure {
    pub url: String,
    pub tier: String,
    pub ms: u64,
    pub bps: Option<u64>,
    pub hist_bps: Option<f64>,
}

impl LineMeasure {
    fn json(&self) -> Value {
        json!({ "url": self.url, "tier": self.tier, "ms": self.ms,
            "kbps": self.bps.map(|b| b / 1000),
            "hist_kbps": self.hist_bps.map(|b| (b / 1000.0) as u64) })
    }

    /// 参与分带的生效吞吐：本轮实测优先（实时证据压过历史），
    /// 实测缺失时用历史 EWMA 估算（账本已用最小样本数把过关）。
    fn effective_bps(&self) -> Option<f64> {
        self.bps.map(|b| b as f64).or(self.hist_bps)
    }
}

/// 「同吞吐」带宽：最高吞吐的 20% 以内视为同档（主站/镜像的日常波动
/// 远大于此，带外差异才是真的快慢）。带内按延迟定胜负。
const SAME_BAND_PERCENT: u64 = 80;

/// 综合排名（纯函数，可注入假度量验证）。fix2 Batch D 两阶段中的
/// 第二阶段「置信度排序」（第一阶段硬排除在 pick_ranked 侧）：
/// - 无候选 → None（调用方保持当前线路，即「全挂保留当前线」）；
/// - 生效吞吐（实测优先、历史 EWMA 兜底）取带（≥最高值 ×80%），
///   带外淘汰——吞吐落后 20% 以上者无论延迟多低都不胜；
/// - 带内按置信度定胜负：历史 EWMA 高者优先（持续真实播放吞吐
///   比单次探测延迟更可信）；只有一方有历史时有者胜；都没有
///   历史时回到延迟最低者胜；延迟相同取先出现者（主站优先）。
/// - 无任何生效吞吐：有历史者按历史降序、无历史者按延迟，
///   统一走同一比较器（历史缺失视为置信度最低）。
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
                .filter(|m| m.effective_bps().is_some_and(|b| b >= floor))
                .collect();
            if band.is_empty() { measures.iter().collect() } else { band }
        }
        None => measures.iter().collect(),
    };
    pool.into_iter().min_by(|a, b| {
        /* 置信度比较：hist 高者胜（用 partial_cmp，账本已保证有限
         * 正数；万一混入非有限值按「无历史」处理，不许毒化排序）。 */
        let ha = a.hist_bps.filter(|v| v.is_finite());
        let hb = b.hist_bps.filter(|v| v.is_finite());
        match (ha, hb) {
            (Some(x), Some(y)) => y.partial_cmp(&x).unwrap_or(std::cmp::Ordering::Equal),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        }
        .then_with(|| a.ms.cmp(&b.ms))
    })
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

/// 经候选线路拉首分片测吞吐（bps）。任何一步失败/超时返回 None，
/// 不影响该候选以延迟参与排名。走生产媒体路（net::edge + fetch_bytes），
/// 测的是用户真实播放路径，不是裸连。
/// 单条超时 6 秒（2026-11-18 晚整改 3）：原 15 秒是整轮探测的预算黑洞
/// ——4 条串行最坏 60 秒；6 秒内拉不完一个首分片的线路当下就不适合
/// 优先播放，没必要让它占满探测窗口。
pub async fn probe_throughput(origin: &str) -> Option<u64> {
    tokio::time::timeout(Duration::from_secs(6), throughput_inner(origin))
        .await
        .ok()?
}

async fn throughput_inner(origin: &str) -> Option<u64> {
    let list = crate::net::edge(origin, "GET", "/api/videos?page=1&size=1", None, None)
        .await
        .ok()?;
    let id = list
        .get("items")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(|v| v.get("id"))
        .and_then(Value::as_i64)?;
    let info = crate::net::edge(
        origin,
        "POST",
        &format!("/api/videos/{id}/episodes/1/playback"),
        Some(json!({})),
        None,
    )
    .await
    .ok()?;
    let playlist_url = info
        .get("streams")
        .and_then(|s| s.get("main"))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .or_else(|| info.get("video_url").and_then(Value::as_str).filter(|s| !s.trim().is_empty()))?
        .to_string();
    let seg_url = crate::speed_probe::resolve_first_segment(&playlist_url).await.ok()?;
    let started = Instant::now();
    let (_, bytes) = crate::net::fetch_bytes(&seg_url).await.ok()?;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    if bytes.is_empty() || elapsed_ms == 0 {
        return None;
    }
    Some(bytes.len() as u64 * 8 * 1000 / elapsed_ms)
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
    let (mut pool, rotated) =
        select_pool(&ordered, current, ROTATE.load(std::sync::atomic::Ordering::SeqCst));
    if rotated {
        ROTATE.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    pool.sort_by_key(|(tier, _, ms)| (tier != "main", *ms));
    let mut measures: Vec<LineMeasure> = Vec::new();
    for (tier, url, ms) in pool {
        let bps = if round_started.elapsed() > ROUND_BUDGET {
            None
        } else {
            probe_throughput(&url).await
        };
        let hist_bps = crate::lines::ledger::tiebreak_bps(&url);
        measures.push(LineMeasure { url, tier, ms, bps, hist_bps });
    }
    let candidates: Vec<Value> = measures.iter().map(LineMeasure::json).collect();
    match rank_lines(&measures) {
        Some(winner) => {
            /* 粘性（Muse 2026-11-18 真机反馈「线路一直变」）：度量是单次
             * 采样、噪声大，路况整体波动时名次每轮翻转、播放被反复打断。
             * 当前线路只要还够用就留任：吞吐不低于胜者 60%（即胜者快
             * 不到 1.7 倍）不换；缺吞吐数据时延迟不超胜者 2 倍不换。
             * 当前线路不可达（不在 measures 里）或明显更差才真切换。 */
            let winner = match current {
                Some(cur) if winner.url != cur => match measures.iter().find(|m| m.url == cur) {
                    Some(cur_m) => {
                        let keep = match (cur_m.bps, winner.bps) {
                            (Some(cb), Some(wb)) => cb * 100 >= wb * 60,
                            _ => cur_m.ms <= winner.ms.saturating_mul(2),
                        };
                        if keep { cur_m } else { winner }
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
        LineMeasure { url: url.into(), tier: "mirror".into(), ms, bps, hist_bps: None }
    }

    fn mh(url: &str, ms: u64, bps: Option<u64>, hist: f64) -> LineMeasure {
        LineMeasure { url: url.into(), tier: "mirror".into(), ms, bps, hist_bps: Some(hist) }
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
                    hist_bps: hist[i],
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
