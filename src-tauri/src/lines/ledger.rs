//! 选线被动记账与自动切换熔断（一期，Muse 2026-11-18；根治包
//! P0-B 改版，Muse 2026-11-19，audit6 §五 P0-B.2/条 7）。
//!
//! 账本：按线路 origin × 代理模式（proxyMode）分键——代理开关是
//! 本机最大的网络环境变量，家里 WiFi 与出门代理的吞吐画像不许混账
//! （WiFi/蜂窝无可靠探测手段，明示不纳入）。只记聚合数值：真实播放
//! 体验事件计数（卡顿 stall / 恢复 recovery / 降级 fallback）与两套
//! 吞吐 EWMA——play（真实播放，VideoSurface 分片统计经
//! line_record_playback 命令回写）与 probe（主动探测，auto_pick 候选
//! 探测回写）。不记 URL、路径或查询参数（仓规：日志不含秘密），
//! 账本本身也不落盘，进程期有效。
//!
//! 排名消费口径（tiebreak）：play EWMA 有 ≥3 个真实样本且 30 分钟内
//! 更新过 → 最高置信；过期的 play 降级为 probe 等级参与；probe EWMA
//! ≥3 样本为次级。近 30 分钟 stall ≥3 的线路，账本生效吞吐打 8 折
//! （只惩罚不奖励，防计数博弈）。stall 的 Rust 侧真实信号取
//! line_auto 的 urgent 入口（前端在播放卡顿/健康连挂时以 urgent
//! 触发自愈选线），fallback/recovery 取自动切换真正落盘的那一刻。
//!
//! 熔断：只拦自动切换（line_auto 落盘前），手动命令完全不经此路。
//! 恢复全自动——窗口计数、总上限与单线退避都按时间惰性过期，下一次
//! auto_pick/line_auto 调用时自动重新允许尝试，不存在等用户手动
//! 切线或手动复位的恢复路径。总上限改为时间衰减（24 小时内最多
//! 12 次，超窗记录过期即恢复额度；旧制进程期只增不减，长驻进程
//! 达上限后永不恢复，Hark G2 P1-1）。urgent 路径（当前线已确认
//! 故障）豁免窗口计数与总上限、只保留单线退避——当前线已挂时还拦
//! 故障切换等于守着死线。被熔断拦下时调用方保持当前线路继续
//! 播放，不报错、不停播。

use once_cell::sync::Lazy;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 账本参与任何决胜/判断的最小吞吐样本数：不足时账本输入一律被
/// 忽略（自动回退到纯探测排序），不让一两次采样冒充线路画像。
pub const LEDGER_MIN_SAMPLES: u64 = 3;
/// 吞吐 EWMA 平滑系数：新样本权重 0.3，旧值保留 0.7。
const EWMA_ALPHA: f64 = 0.3;
/// 账本最多记这么多条线路（键含环境维），满了之后新键不再入账
/// （防无界增长）。
const MAX_LINES: usize = 64;
/// play EWMA 的新鲜期：超过 30 分钟未更新，降级为 probe 等级参与
/// （防旧环境画像长期主导排名，audit6 P0-B.2）。
const PLAY_FRESH: Duration = Duration::from_secs(30 * 60);
/// stall 否决窗口与门槛：近 30 分钟 stall ≥3 次，账本生效吞吐打
/// 8 折（audit6 P0-B.2）。
const STALL_WINDOW: Duration = Duration::from_secs(30 * 60);
const STALL_PENALTY_MIN: usize = 3;
const STALL_PENALTY_FACTOR: f64 = 0.8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineEvent {
    Stall,
    Recovery,
    Fallback,
}

/// 一套吞吐 EWMA（样本数＋当前值＋最近更新时刻）。
#[derive(Clone, Debug, Default)]
pub struct Ewma {
    pub samples: u64,
    pub bps: Option<f64>,
    pub updated: Option<Instant>,
}

impl Ewma {
    fn apply(&mut self, value: f64, now: Instant) {
        if !(value.is_finite() && value > 0.0) {
            return;
        }
        self.samples = self.samples.saturating_add(1);
        let next = match self.bps {
            Some(old) if old.is_finite() => old + EWMA_ALPHA * (value - old),
            _ => value,
        };
        // 异常数值（溢出成 inf/NaN）直接丢弃整个 EWMA，回到无数据状态，
        // 后续查询按样本不足处理（自动回退），绝不让坏值参与排序。
        self.bps = if next.is_finite() { Some(next) } else { None };
        self.updated = Some(now);
    }

    /// 达到最小样本数且为有限正数才算有效画像。
    fn valid(&self) -> Option<f64> {
        if self.samples < LEDGER_MIN_SAMPLES {
            return None;
        }
        self.bps.filter(|v| v.is_finite() && *v > 0.0)
    }
}

#[derive(Clone, Debug, Default)]
pub struct LineStats {
    pub stall: u64,
    pub recovery: u64,
    pub fallback: u64,
    /// 主动探测吞吐（auto_pick 回写）。
    pub probe: Ewma,
    /// 真实播放吞吐（line_record_playback 回写）。
    pub play: Ewma,
    /// stall 事件时刻（否决窗口用）：只保留窗口内的，惰性清理。
    stall_times: VecDeque<Instant>,
}

impl LineStats {
    fn recent_stalls(&mut self, now: Instant) -> usize {
        while matches!(self.stall_times.front(), Some(at) if now.duration_since(*at) >= STALL_WINDOW) {
            self.stall_times.pop_front();
        }
        self.stall_times.len()
    }
}

fn apply_event(stats: &mut LineStats, event: LineEvent, now: Instant) {
    match event {
        LineEvent::Stall => {
            stats.stall = stats.stall.saturating_add(1);
            stats.recent_stalls(now);
            stats.stall_times.push_back(now);
        }
        LineEvent::Recovery => stats.recovery = stats.recovery.saturating_add(1),
        LineEvent::Fallback => stats.fallback = stats.fallback.saturating_add(1),
    }
}

static LEDGER: Lazy<Mutex<HashMap<String, LineStats>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// 账本键：origin × 代理模式。代理模式取当前应用代理设置
/// （system/custom/off）——环境切换后新样本自动落到新键，旧键画像
/// 不再被查到（查询同样按当前模式组键）。
fn ledger_key(origin: &str) -> String {
    format!("{origin}\u{1f}{}", crate::proxy::mode().as_str())
}

fn with_entry<R>(origin: &str, f: impl FnOnce(&mut LineStats) -> R) -> Option<R> {
    let key = ledger_key(origin);
    let mut map = LEDGER.lock().ok()?;
    if !map.contains_key(&key) {
        if map.len() >= MAX_LINES {
            return None;
        }
        map.insert(key.clone(), LineStats::default());
    }
    map.get_mut(&key).map(f)
}

/// 主动探测吞吐回写（auto_pick 的候选探测结果，probe EWMA）。
/// bps=0 由 Ewma::apply 拒绝（不计样本），条目本身照常建立——与
/// 旧实现的可观察行为一致（snapshot 能看到条目、样本数为 0）。
pub fn record_throughput(origin: &str, bps: u64) {
    let now = Instant::now();
    let _ = with_entry(origin, |stats| stats.probe.apply(bps as f64, now));
}

/// 真实播放吞吐回写（line_record_playback 命令，play EWMA）：
/// 前端聚合的分片实测 bps（f64），非有限/非正一律丢弃。
pub fn record_playback(origin: &str, bps: f64) {
    let now = Instant::now();
    let _ = with_entry(origin, |stats| stats.play.apply(bps, now));
}

pub fn record_event(origin: &str, event: LineEvent) {
    let now = Instant::now();
    let _ = with_entry(origin, |stats| apply_event(stats, event, now));
}

#[allow(dead_code)]
pub fn snapshot(origin: &str) -> Option<LineStats> {
    LEDGER.lock().ok()?.get(&ledger_key(origin)).cloned()
}

/// 账本条目汇总（诊断导出用，Muse 2026-11-19 根治包·飞行记录仪
/// 收口）：键拆回 origin × mode 两维，双 EWMA 原值与样本数、事件
/// 计数全量给出——报告侧据此判读每条线路的真实播放画像与探测
/// 画像，不经排名口径加工（未知问题回溯口径：给原值不给结论）。
#[derive(Clone, Debug, PartialEq)]
pub struct LedgerEntry {
    pub origin: String,
    pub mode: String,
    pub stall: u64,
    pub recovery: u64,
    pub fallback: u64,
    pub probe_samples: u64,
    pub probe_bps: Option<f64>,
    pub play_samples: u64,
    pub play_bps: Option<f64>,
}

/// 全账本只读汇总（按 origin/mode 排序，输出稳定）。锁失败返回
/// 空表——诊断旁路不许因账本锁故障报错，报告侧以空表呈现。
pub fn summary() -> Vec<LedgerEntry> {
    let Ok(map) = LEDGER.lock() else { return Vec::new() };
    let mut out: Vec<LedgerEntry> = map
        .iter()
        .map(|(key, s)| {
            let (origin, mode) = key.split_once('\u{1f}').unwrap_or((key.as_str(), ""));
            LedgerEntry {
                origin: origin.to_string(),
                mode: mode.to_string(),
                stall: s.stall,
                recovery: s.recovery,
                fallback: s.fallback,
                probe_samples: s.probe.samples,
                probe_bps: s.probe.bps,
                play_samples: s.play.samples,
                play_bps: s.play.bps,
            }
        })
        .collect();
    out.sort_by(|a, b| a.origin.cmp(&b.origin).then_with(|| a.mode.cmp(&b.mode)));
    out
}

/// 熔断状态只读汇总（诊断导出用）：进程期总量/上限、窗口内计数/
/// 上限、当前退避中的线路数。惰性过期与 breaker_allows 同口径
/// （先清过期再计数），报告读到的就是下一次自动切换面对的状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BreakerStatus {
    pub total: u32,
    pub session_max: u32,
    pub window_count: usize,
    pub window_max: usize,
    pub backoff_lines: usize,
}

pub fn breaker_status() -> Option<BreakerStatus> {
    let mut state = BREAKER.lock().ok()?;
    let now = Instant::now();
    prune_breaker(&mut state, now);
    Some(BreakerStatus {
        total: state.switch_times.len() as u32,
        session_max: AUTO_SWITCH_SESSION_MAX,
        window_count: state.window.len(),
        window_max: AUTO_SWITCH_WINDOW_MAX,
        backoff_lines: state.backoff_until.len(),
    })
}

/// 账本决胜查询（双 EWMA 版，line_rank 消费）：play 与 probe 两级
/// 置信度分开返回，排名按 play ＞ 本轮实测 ＞ probe 的顺序决胜。
/// - play：play EWMA 有效且 30 分钟内更新过；
/// - probe：probe EWMA 有效，或过期的 play EWMA 降级至此级
///   （两者都有时取大者——同为该级证据，取更能代表线路上限的）；
/// - stall 否决：近 30 分钟 stall ≥3，两级一并打 8 折。
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Tiebreak {
    pub play: Option<f64>,
    pub probe: Option<f64>,
}

pub fn tiebreak(origin: &str) -> Tiebreak {
    tiebreak_at(origin, Instant::now())
}

fn tiebreak_at(origin: &str, now: Instant) -> Tiebreak {
    // 只读查询：不经 with_entry 建条目——查询本身不许消耗账本容量，
    // 否则批量探测未入账线路会把空条目塞满 MAX_LINES。
    let Some(mut stats) = snapshot(origin) else {
        return Tiebreak::default();
    };
    let play_valid = stats.play.valid();
    let fresh = stats
        .play
        .updated
        .is_some_and(|at| now.duration_since(at) < PLAY_FRESH);
    let (play, demoted) = match (play_valid, fresh) {
        (Some(v), true) => (Some(v), None),
        (Some(v), false) => (None, Some(v)),
        _ => (None, None),
    };
    let probe = match (stats.probe.valid(), demoted) {
        (Some(p), Some(d)) => Some(p.max(d)),
        (Some(p), None) => Some(p),
        (None, d) => d,
    };
    let mut out = Tiebreak { play, probe };
    if stats.recent_stalls(now) >= STALL_PENALTY_MIN {
        out.play = out.play.map(|v| v * STALL_PENALTY_FACTOR);
        out.probe = out.probe.map(|v| v * STALL_PENALTY_FACTOR);
    }
    out
}

/// 单值口径（旧调用方/测试用）：play 优先、probe 兜底的生效吞吐。
pub fn tiebreak_bps(origin: &str) -> Option<f64> {
    let tb = tiebreak(origin);
    tb.play.or(tb.probe)
}

/* ── 自动切换熔断（保守阈值，Muse 2026-11-18；整改 A2 修订，
 * Muse 2026-11-19，Hark G2 P1-1）────────────────────────────
 * 自动切换总上限 12 次、改为 24 小时时间衰减：24 小时内累计切满
 * 12 次说明线路环境或探测判据在抖动，继续自动切只会反复打断
 * 播放；但记录超 24 小时即过期、额度自动恢复（旧制只增不减，
 * iOS 长驻进程达上限后只能重启 App 才恢复）。10 分钟窗口内最多
 * 4 次：短时连切是抖动信号，窗口按时间滑动，到期自动恢复额度。
 * 单线退避 120 秒：刚被切走的线路短时内不许作为自动切换目标切
 * 回，防 A→B→A 乒乓；到期自动解除。
 * urgent 豁免（当前线已确认故障的自愈路径）：跳过窗口计数与总
 * 上限两道，只保留单线退避——死线面前「防抖动」让位于「先活过来」，
 * 退避仍拦是防刚切走的线立刻被切回造成乒乓。 */
const AUTO_SWITCH_SESSION_MAX: u32 = 12;
const AUTO_SWITCH_TOTAL_WINDOW: Duration = Duration::from_secs(24 * 3600);
const AUTO_SWITCH_WINDOW_MAX: usize = 4;
const AUTO_SWITCH_WINDOW: Duration = Duration::from_secs(600);
const LINE_BACKOFF: Duration = Duration::from_secs(120);

#[derive(Default)]
struct Breaker {
    /// 每次自动切换的时刻（总上限衰减窗内计数，惰性过期）。
    switch_times: VecDeque<Instant>,
    window: VecDeque<Instant>,
    backoff_until: HashMap<String, Instant>,
}

static BREAKER: Lazy<Mutex<Breaker>> = Lazy::new(|| Mutex::new(Breaker::default()));

/// 惰性过期 = 自动恢复：每次询问/记账前先清掉已过各自时间窗的
/// 记录与已到期的退避，不需要任何外部复位动作。
fn prune_breaker(state: &mut Breaker, now: Instant) {
    while matches!(state.window.front(), Some(at) if now.duration_since(*at) >= AUTO_SWITCH_WINDOW) {
        state.window.pop_front();
    }
    while matches!(state.switch_times.front(), Some(at) if now.duration_since(*at) >= AUTO_SWITCH_TOTAL_WINDOW) {
        state.switch_times.pop_front();
    }
    state.backoff_until.retain(|_, until| *until > now);
}

fn breaker_allows(state: &mut Breaker, target: &str, now: Instant, urgent: bool) -> bool {
    prune_breaker(state, now);
    if !urgent {
        if state.switch_times.len() >= AUTO_SWITCH_SESSION_MAX as usize {
            return false;
        }
        if state.window.len() >= AUTO_SWITCH_WINDOW_MAX {
            return false;
        }
    }
    !state.backoff_until.contains_key(target)
}

fn breaker_note(state: &mut Breaker, from: &str, now: Instant) {
    state.switch_times.push_back(now);
    state.window.push_back(now);
    state
        .backoff_until
        .insert(from.to_string(), now + LINE_BACKOFF);
}

/// 自动切换落盘前询问熔断。urgent=true 为当前线确认故障的自愈
/// 路径，豁免窗口与总上限（见上方常量注释）。锁失败按放行处理：
/// 熔断是保护不是门禁，绝不能因自身故障把自动路径锁死到无路可走。
pub fn auto_switch_allowed(target: &str, urgent: bool) -> bool {
    match BREAKER.lock() {
        Ok(mut state) => breaker_allows(&mut state, target, Instant::now(), urgent),
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
        assert_eq!(stats.probe.samples, 0, "bps=0 不计样本");
        assert_eq!(stats.probe.bps, None);
        record_throughput(&origin, 5_000_000);
        record_throughput(&origin, 5_000_000);
        record_throughput(&origin, 5_000_000);
        let before = tiebreak_bps(&origin).expect("应有决胜值");
        // u64 极值样本：EWMA 演进后仍须有限正数，不许把账本毒成 inf/NaN
        record_throughput(&origin, u64::MAX);
        let stats = snapshot(&origin).expect("条目应存在");
        if let Some(v) = stats.probe.bps {
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
        assert_eq!(stats.probe.samples, 0);
        assert_eq!(stats.play.samples, 0);
    }

    /* ── 根治包 P0-B 双 EWMA（audit6 §五 P0-B.2）：play/probe 分账、
     * play 过期降级、stall 窗口否决。tiebreak_at 注入时刻验证。 ── */
    #[test]
    fn play_and_probe_ledgers_are_separate() {
        let origin = uniq("dual");
        for _ in 0..3 {
            record_playback(&origin, 9_000_000.0);
            record_throughput(&origin, 4_000_000);
        }
        let tb = tiebreak(&origin);
        assert_eq!(tb.play, Some(9_000_000.0), "play EWMA 独立成账");
        assert_eq!(tb.probe, Some(4_000_000.0), "probe EWMA 独立成账");
        // play 样本不足时不进 play 级（probe 侧同理）
        let thin = uniq("dual-thin");
        record_playback(&thin, 9_000_000.0);
        record_playback(&thin, 9_000_000.0);
        assert_eq!(tiebreak(&thin).play, None, "play <3 样本不许冒充画像");
    }

    #[test]
    fn stale_play_demotes_to_probe_tier() {
        let origin = uniq("demote");
        for _ in 0..3 {
            record_playback(&origin, 9_000_000.0);
        }
        let now = Instant::now();
        let fresh = tiebreak_at(&origin, now);
        assert_eq!(fresh.play, Some(9_000_000.0));
        assert_eq!(fresh.probe, None);
        let later = tiebreak_at(&origin, now + PLAY_FRESH + Duration::from_secs(1));
        assert_eq!(later.play, None, "过期 play 不许继续占最高置信级");
        assert_eq!(later.probe, Some(9_000_000.0), "过期 play 降级为 probe 级参与");
    }

    #[test]
    fn recent_stalls_discount_tiebreak_by_twenty_percent() {
        let origin = uniq("stall-penalty");
        for _ in 0..3 {
            record_playback(&origin, 10_000_000.0);
        }
        record_event(&origin, LineEvent::Stall);
        record_event(&origin, LineEvent::Stall);
        assert_eq!(tiebreak(&origin).play, Some(10_000_000.0), "stall <3 不罚");
        record_event(&origin, LineEvent::Stall);
        let tb = tiebreak(&origin);
        assert_eq!(tb.play, Some(8_000_000.0), "近 30 分钟 stall ≥3 打 8 折");
        // 窗口外的旧 stall 不计：以 31 分钟后查询，play 同时过期降级，
        // 降级值不再被打折。
        let later = tiebreak_at(&origin, Instant::now() + STALL_WINDOW + Duration::from_secs(60));
        assert_eq!(later.probe, Some(10_000_000.0), "窗口外 stall 不再否决");
    }

    /* ── 飞行记录仪收口（Muse 2026-11-19 根治包，用户点名：诊断
     * 导出须含双账本摘要与熔断状态）：summary 拆键给原值、
     * breaker_status 与切换许可同口径惰性过期。 ── */
    #[test]
    fn summary_splits_key_and_reports_both_ewmas() {
        let origin = uniq("summary");
        record_event(&origin, LineEvent::Stall);
        for _ in 0..3 {
            record_playback(&origin, 6_000_000.0);
            record_throughput(&origin, 3_000_000);
        }
        let entries = summary();
        let e = entries.iter().find(|e| e.origin == origin).expect("汇总应含本条目");
        assert_eq!(e.stall, 1);
        assert_eq!(e.play_samples, 3);
        assert_eq!(e.play_bps, Some(6_000_000.0));
        assert_eq!(e.probe_samples, 3);
        assert_eq!(e.probe_bps, Some(3_000_000.0));
        assert!(!e.mode.is_empty(), "键应拆出代理模式维");
    }

    #[test]
    fn breaker_status_reflects_notes() {
        let before = breaker_status().expect("熔断状态可读");
        note_auto_switch("https://brk-from.example", "https://brk-to.example");
        let after = breaker_status().expect("熔断状态可读");
        assert_eq!(after.total, before.total + 1);
        assert!(after.backoff_lines >= 1, "刚被切走的线路应处于退避中");
        assert_eq!(after.session_max, AUTO_SWITCH_SESSION_MAX);
        assert_eq!(after.window_max, AUTO_SWITCH_WINDOW_MAX);
    }

    /* ── 整改 A2（Hark G2 P1-1）：urgent 豁免窗口/总上限（只保留单线
     * 退避）＋总上限 24h 时间衰减。旧签名/旧语义下本组用例先红。 ── */
    #[test]
    fn breaker_urgent_bypasses_window_and_total_but_not_backoff() {
        let now = Instant::now();
        // 窗口记满（10 分钟内 4 次）：非 urgent 拦、urgent 放行
        let mut s = Breaker::default();
        for i in 0..AUTO_SWITCH_WINDOW_MAX {
            breaker_note(&mut s, &format!("https://uw{i}.example"), now);
        }
        assert!(!breaker_allows(&mut s, "https://next.example", now, false), "窗口满非 urgent 应拦");
        assert!(breaker_allows(&mut s, "https://next.example", now, true), "窗口满 urgent（当前线已挂）必须放行");
        // 总上限记满（12 次）：非 urgent 拦、urgent 放行
        let mut s2 = Breaker::default();
        for i in 0..AUTO_SWITCH_SESSION_MAX {
            breaker_note(&mut s2, &format!("https://ut{i}.example"), now);
        }
        assert!(!breaker_allows(&mut s2, "https://next2.example", now, false), "总上限满非 urgent 应拦");
        assert!(breaker_allows(&mut s2, "https://next2.example", now, true), "总上限满 urgent 必须放行");
        // urgent 不豁免单线退避：刚被切走的线路 120s 内不许切回
        assert!(!breaker_allows(&mut s2, "https://ut0.example", now, true), "urgent 仍受单线退避约束");
    }

    #[test]
    fn breaker_total_decays_with_time() {
        let now = Instant::now();
        let mut s = Breaker::default();
        for i in 0..AUTO_SWITCH_SESSION_MAX {
            breaker_note(&mut s, &format!("https://d{i}.example"), now);
        }
        assert!(!breaker_allows(&mut s, "https://z.example", now, false), "总上限满应拦");
        let later = now + AUTO_SWITCH_TOTAL_WINDOW + Duration::from_secs(1);
        assert!(breaker_allows(&mut s, "https://z.example", later, false), "总上限记录超衰减窗过期后非 urgent 应恢复");
    }

    #[test]
    fn breaker_window_total_and_backoff() {
        let mut state = Breaker::default();
        let now = Instant::now();
        assert!(breaker_allows(&mut state, "https://a.example", now, false));
        breaker_note(&mut state, "https://a.example", now);
        // 被切走的线路 120s 内不许切回
        assert!(!breaker_allows(&mut state, "https://a.example", now, false));
        assert!(breaker_allows(&mut state, "https://b.example", now, false));
        // 窗口上限：10 分钟内记满 4 次后第 5 次不许
        for i in 0..3 {
            breaker_note(&mut state, &format!("https://w{i}.example"), now);
        }
        assert!(!breaker_allows(&mut state, "https://c.example", now, false), "窗口满应拦");
        // 窗口过期后自动恢复（退避也一并到期）
        let later = now + AUTO_SWITCH_WINDOW + Duration::from_secs(121);
        assert!(breaker_allows(&mut state, "https://a.example", later, false), "过期应自动恢复");
        // 总量上限独立于窗口（12 笔记录间隔 10 分钟记账、均在 24h
        // 衰减窗内，查询时刻亦在窗内 → 总量满应拦）
        let mut s2 = Breaker::default();
        for i in 0..AUTO_SWITCH_SESSION_MAX {
            breaker_note(&mut s2, &format!("https://t{i}.example"), now + AUTO_SWITCH_WINDOW * (i + 1));
        }
        assert!(!breaker_allows(&mut s2, "https://z.example", now + AUTO_SWITCH_WINDOW * 99, false), "总量满应拦");
    }
}
