//! 选线被动记账与自动切换熔断（一期，Muse 2026-11-18）。
//!
//! 账本：按线路 origin 分键，只记聚合数值——真实播放体验事件计数
//! （卡顿 stall / 恢复 recovery / 降级 fallback）与吞吐 EWMA。吞吐
//! 样本来自 auto_pick 的候选探测：line_rank 经生产媒体路拉真实首
//! 分片测得的 kbps，由 probe::auto_pick 回写本账本。不记 URL、路径
//! 或查询参数（仓规：日志不含秘密），账本本身也不落盘，进程期有效。
//!
//! 本期未挂分片主路径：media/segment 与 range_fetch 是起播必经路，
//! 在其完成点挂钩会触碰主路径顺序，留待下一批单独评估；stall 的
//! Rust 侧真实信号取 line_auto 的 urgent 入口（前端在播放卡顿/健康
//! 连挂时以 urgent 触发自愈选线），fallback/recovery 取自动切换
//! 真正落盘的那一刻。
//!
//! 熔断：只拦自动切换（line_auto 落盘前），手动命令完全不经此路。
//! 恢复全自动——窗口计数与单线退避都按时间惰性过期，下一次
//! auto_pick/line_auto 调用时自动重新允许尝试，不存在等用户手动
//! 切线或手动复位的恢复路径；进程期总上限随进程重启归零。被熔断
//! 拦下时调用方保持当前线路继续播放，不报错、不停播。

use once_cell::sync::Lazy;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 账本参与任何决胜/判断的最小吞吐样本数：不足时账本输入一律被
/// 忽略（自动回退到纯探测排序），不让一两次采样冒充线路画像。
pub const LEDGER_MIN_SAMPLES: u64 = 3;
/// 吞吐 EWMA 平滑系数：新样本权重 0.3，旧值保留 0.7。
const EWMA_ALPHA: f64 = 0.3;
/// 账本最多记这么多条线路，满了之后新 origin 不再入账（防无界增长）。
const MAX_LINES: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineEvent {
    Stall,
    Recovery,
    Fallback,
}

#[derive(Clone, Debug, Default)]
pub struct LineStats {
    pub stall: u64,
    pub recovery: u64,
    pub fallback: u64,
    pub throughput_samples: u64,
    pub ewma_bps: Option<f64>,
}

fn apply_throughput(stats: &mut LineStats, bps: u64) {
    if bps == 0 {
        return;
    }
    let value = bps as f64;
    if !value.is_finite() {
        return;
    }
    stats.throughput_samples = stats.throughput_samples.saturating_add(1);
    let next = match stats.ewma_bps {
        Some(old) if old.is_finite() => old + EWMA_ALPHA * (value - old),
        _ => value,
    };
    // 异常数值（溢出成 inf/NaN）直接丢弃整个 EWMA，回到无数据状态，
    // 后续查询按样本不足处理（自动回退），绝不让坏值参与排序。
    stats.ewma_bps = if next.is_finite() { Some(next) } else { None };
}

fn apply_event(stats: &mut LineStats, event: LineEvent) {
    let counter = match event {
        LineEvent::Stall => &mut stats.stall,
        LineEvent::Recovery => &mut stats.recovery,
        LineEvent::Fallback => &mut stats.fallback,
    };
    *counter = counter.saturating_add(1);
}

static LEDGER: Lazy<Mutex<HashMap<String, LineStats>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn with_entry<R>(origin: &str, f: impl FnOnce(&mut LineStats) -> R) -> Option<R> {
    let mut map = LEDGER.lock().ok()?;
    if !map.contains_key(origin) {
        if map.len() >= MAX_LINES {
            return None;
        }
        map.insert(origin.to_string(), LineStats::default());
    }
    map.get_mut(origin).map(f)
}

pub fn record_throughput(origin: &str, bps: u64) {
    let _ = with_entry(origin, |stats| apply_throughput(stats, bps));
}

pub fn record_event(origin: &str, event: LineEvent) {
    let _ = with_entry(origin, |stats| apply_event(stats, event));
}

#[allow(dead_code)]
pub fn snapshot(origin: &str) -> Option<LineStats> {
    LEDGER.lock().ok()?.get(origin).cloned()
}

/// 账本决胜查询（fix2 Batch D 已接入 line_rank 置信度排序）：仅当
/// 吞吐样本达到 LEDGER_MIN_SAMPLES 且 EWMA 为有限正数时返回 Some；
/// 样本不足或数值异常一律返回 None，调用方据此自动忽略账本、
/// 回纯探测排序。
pub fn tiebreak_bps(origin: &str) -> Option<f64> {
    let stats = snapshot(origin)?;
    if stats.throughput_samples < LEDGER_MIN_SAMPLES {
        return None;
    }
    stats.ewma_bps.filter(|v| v.is_finite() && *v > 0.0)
}

/* ── 自动切换熔断（保守阈值，Muse 2026-11-18）──────────────────
 * 进程期自动切换总上限 12 次：超过说明线路环境或探测判据在抖动，
 * 继续自动切只会反复打断播放；进程重启归零（新会话重新评估）。
 * 10 分钟窗口内最多 4 次：短时连切是抖动信号，窗口按时间滑动，
 * 到期自动恢复额度。单线退避 120 秒：刚被切走的线路短时内不许
 * 作为自动切换目标切回，防 A→B→A 乒乓；到期自动解除。 */
const AUTO_SWITCH_SESSION_MAX: u32 = 12;
const AUTO_SWITCH_WINDOW_MAX: usize = 4;
const AUTO_SWITCH_WINDOW: Duration = Duration::from_secs(600);
const LINE_BACKOFF: Duration = Duration::from_secs(120);

#[derive(Default)]
struct Breaker {
    total: u32,
    window: VecDeque<Instant>,
    backoff_until: HashMap<String, Instant>,
}

static BREAKER: Lazy<Mutex<Breaker>> = Lazy::new(|| Mutex::new(Breaker::default()));

fn breaker_allows(state: &mut Breaker, target: &str, now: Instant) -> bool {
    // 惰性过期 = 自动恢复：每次询问先清掉已过窗口的计数与已到期
    // 的退避，不需要任何外部复位动作。
    while matches!(state.window.front(), Some(at) if now.duration_since(*at) >= AUTO_SWITCH_WINDOW) {
        state.window.pop_front();
    }
    state.backoff_until.retain(|_, until| *until > now);
    if state.total >= AUTO_SWITCH_SESSION_MAX {
        return false;
    }
    if state.window.len() >= AUTO_SWITCH_WINDOW_MAX {
        return false;
    }
    !state.backoff_until.contains_key(target)
}

fn breaker_note(state: &mut Breaker, from: &str, now: Instant) {
    state.total = state.total.saturating_add(1);
    state.window.push_back(now);
    state
        .backoff_until
        .insert(from.to_string(), now + LINE_BACKOFF);
}

/// 自动切换落盘前询问熔断。锁失败按放行处理：熔断是保护不是门禁，
/// 绝不能因自身故障把自动路径锁死到无路可走。
pub fn auto_switch_allowed(target: &str) -> bool {
    match BREAKER.lock() {
        Ok(mut state) => breaker_allows(&mut state, target, Instant::now()),
        Err(_) => true,
    }
}

/// 一次自动切换真正落盘后记账：计数 + 给被切走的线路上退避。
pub fn note_auto_switch(from: &str, _to: &str) {
    if let Ok(mut state) = BREAKER.lock() {
        breaker_note(&mut state, from, Instant::now());
    }
}

/// 单线退避查询（fix2 Batch D 硬排除用）：该线路是否正处于「刚被
/// 自动切走」的退避期内。只看退避表、不看窗口/总量（那是切换许可
/// 的事，不是候选资格的事）。惰性过期同 breaker_allows；锁失败按
/// 不退避处理（排除是优化不是门禁，不许因账本故障把候选全清）。
pub fn in_backoff(origin: &str) -> bool {
    match BREAKER.lock() {
        Ok(mut state) => {
            let now = Instant::now();
            state.backoff_until.retain(|_, until| *until > now);
            state.backoff_until.contains_key(origin)
        }
        Err(_) => false,
    }
}

/* ── 账本完整性验证（Muse 2026-11-19 fix2 B2）──────────────────
 * Batch D 接排序的前置门：账本数值必须可信。本组测试钉住四件事：
 * EWMA 数学与最小样本门、异常值（0/溢出）不污染、事件计数有界
 * 累加、熔断的窗口/总量/退避语义。全局账本用唯一 origin 隔离。 */
#[cfg(test)]
mod tests {
    use super::*;

    fn uniq(tag: &str) -> String {
        format!("https://ledger-test-{tag}.example")
    }

    #[test]
    fn throughput_gate_requires_min_samples() {
        let origin = uniq("gate");
        assert_eq!(tiebreak_bps(&origin), None, "无样本必须无决胜值");
        record_throughput(&origin, 8_000_000);
        record_throughput(&origin, 8_000_000);
        assert_eq!(tiebreak_bps(&origin), None, "样本 < 3 不许参与决胜");
        record_throughput(&origin, 8_000_000);
        let v = tiebreak_bps(&origin).expect("3 样本后应有决胜值");
        assert!((v - 8_000_000.0).abs() < 1.0, "恒定样本 EWMA 应等于样本值, got {v}");
    }

    #[test]
    fn ewma_weights_new_sample_at_alpha() {
        let origin = uniq("ewma");
        record_throughput(&origin, 10_000_000);
        record_throughput(&origin, 20_000_000);
        record_throughput(&origin, 20_000_000);
        // 10M → 10+0.3*10=13M → 13+0.3*7=15.1M
        let v = tiebreak_bps(&origin).expect("应有决胜值");
        assert!((v - 15_100_000.0).abs() < 1.0, "EWMA 应按 alpha=0.3 演进, got {v}");
    }

    #[test]
    fn zero_and_outlier_samples_do_not_poison() {
        let origin = uniq("outlier");
        record_throughput(&origin, 0);
        let stats = snapshot(&origin).expect("条目应存在");
        assert_eq!(stats.throughput_samples, 0, "bps=0 不计样本");
        assert_eq!(stats.ewma_bps, None);
        record_throughput(&origin, 5_000_000);
        record_throughput(&origin, 5_000_000);
        record_throughput(&origin, 5_000_000);
        let before = tiebreak_bps(&origin).expect("应有决胜值");
        // u64 极值样本：EWMA 演进后仍须有限正数，不许把账本毒成 inf/NaN
        record_throughput(&origin, u64::MAX);
        let stats = snapshot(&origin).expect("条目应存在");
        if let Some(v) = stats.ewma_bps {
            assert!(v.is_finite() && v > 0.0, "EWMA 必须保持有限正数, got {v}");
        }
        let _ = before;
    }

    #[test]
    fn event_counters_accumulate() {
        let origin = uniq("events");
        record_event(&origin, LineEvent::Stall);
        record_event(&origin, LineEvent::Stall);
        record_event(&origin, LineEvent::Recovery);
        record_event(&origin, LineEvent::Fallback);
        let stats = snapshot(&origin).expect("条目应存在");
        assert_eq!(stats.stall, 2);
        assert_eq!(stats.recovery, 1);
        assert_eq!(stats.fallback, 1);
        assert_eq!(stats.throughput_samples, 0);
    }

    #[test]
    fn breaker_window_total_and_backoff() {
        let mut state = Breaker::default();
        let now = Instant::now();
        assert!(breaker_allows(&mut state, "https://a.example", now));
        breaker_note(&mut state, "https://a.example", now);
        // 被切走的线路 120s 内不许切回
        assert!(!breaker_allows(&mut state, "https://a.example", now));
        assert!(breaker_allows(&mut state, "https://b.example", now));
        // 窗口上限：10 分钟内记满 4 次后第 5 次不许
        for i in 0..3 {
            breaker_note(&mut state, &format!("https://w{i}.example"), now);
        }
        assert!(!breaker_allows(&mut state, "https://c.example", now), "窗口满应拦");
        // 窗口过期后自动恢复（退避也一并到期）
        let later = now + AUTO_SWITCH_WINDOW + Duration::from_secs(121);
        assert!(breaker_allows(&mut state, "https://a.example", later), "过期应自动恢复");
        // 进程期总量上限独立于窗口
        let mut s2 = Breaker::default();
        for i in 0..AUTO_SWITCH_SESSION_MAX {
            breaker_note(&mut s2, &format!("https://t{i}.example"), now + AUTO_SWITCH_WINDOW * (i + 1));
        }
        assert!(!breaker_allows(&mut s2, "https://z.example", now + AUTO_SWITCH_WINDOW * 99), "总量满应拦");
    }
}
