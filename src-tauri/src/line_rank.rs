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

/// 一条候选的综合度量：延迟来自 lines::probe_hit，吞吐来自真实分片。
#[derive(Clone, Debug)]
pub struct LineMeasure {
    pub url: String,
    pub tier: String,
    pub ms: u64,
    pub bps: Option<u64>,
}

impl LineMeasure {
    fn json(&self) -> Value {
        json!({ "url": self.url, "tier": self.tier, "ms": self.ms,
            "kbps": self.bps.map(|b| b / 1000) })
    }
}

/// 「同吞吐」带宽：最高吞吐的 20% 以内视为同档（主站/镜像的日常波动
/// 远大于此，带外差异才是真的快慢）。带内按延迟定胜负。
const SAME_BAND_PERCENT: u64 = 80;

/// 综合排名（纯函数，可注入假度量验证）：
/// - 无候选 → None（调用方保持当前线路，即「全挂保留当前线」）；
/// - 有吞吐数据时：先取吞吐带（≥最高值 ×80%），带内延迟最低者胜；
///   延迟相同取先出现者（候选按主站优先构造）；
/// - 无任何吞吐数据：整体按延迟最低者胜（旧规则）。
/// 「吞吐高者胜」由带外淘汰实现：吞吐落后 20% 以上者无论延迟多低都不胜。
pub fn rank_lines(measures: &[LineMeasure]) -> Option<&LineMeasure> {
    if measures.is_empty() {
        return None;
    }
    let best_bps = measures.iter().filter_map(|m| m.bps).max();
    let pool: Vec<&LineMeasure> = match best_bps {
        Some(best) => {
            let floor = best.saturating_mul(SAME_BAND_PERCENT) / 100;
            let band: Vec<&LineMeasure> = measures
                .iter()
                .filter(|m| m.bps.is_some_and(|b| b >= floor))
                .collect();
            if band.is_empty() { measures.iter().collect() } else { band }
        }
        None => measures.iter().collect(),
    };
    pool.into_iter().min_by_key(|m| m.ms)
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

/// 给已延迟探测的候选补吞吐并排名，产出与旧 pick_from_hits 同形状的结果
/// （base/tier/ms/reason/candidates），candidates 附每条的 kbps。
/// 吞吐探测串行且最多测前 4 条可达候选（主站优先、其余按延迟升序）。
pub async fn pick_ranked(hits: Vec<(String, String, u64)>, current: Option<&str>) -> Value {
    let round_started = Instant::now();
    let mut ordered = hits;
    ordered.sort_by_key(|(tier, _, ms)| (tier != "main", *ms));
    let mut measures: Vec<LineMeasure> = Vec::new();
    for (tier, url, ms) in ordered.into_iter().take(4) {
        let bps = if round_started.elapsed() > ROUND_BUDGET {
            None
        } else {
            probe_throughput(&url).await
        };
        measures.push(LineMeasure { url, tier, ms, bps });
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
        LineMeasure { url: url.into(), tier: "mirror".into(), ms, bps }
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
}
