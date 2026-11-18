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

/// 账本决胜查询（供下一批接入 pick_ranked 同分决胜）：仅当吞吐样本
/// 达到 LEDGER_MIN_SAMPLES 且 EWMA 为有限正数时返回 Some；样本不足
/// 或数值异常一律返回 None，调用方据此自动忽略账本、回纯探测排序。
#[allow(dead_code)]
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
