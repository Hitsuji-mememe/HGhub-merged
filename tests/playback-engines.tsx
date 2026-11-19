/* 收官批 F/C 逻辑断言夹具（2026-11-18）：以假时钟/假事件序列验证
 * AppendStallWatchdog 三段逻辑（正常出画不触发 / 卡死触发 / 慢网不触发 /
 * 到点复查谓词救场），会话级原生降级对 playbackSource 的作用，以及
 * effectiveSrMode 在模拟源参数下的判档（高密度 1080p→off、低密度
 * 1080p→crisp、720p 低密度→natural 等，含真实采样锚点）。
 * 由 scripts/test-playback-engines.mjs 驱动，结果挂 window.__engines。 */
import { AppendStallWatchdog, type StallClock } from "../src/features/playback/appendStallWatchdog";
import { nativeFallbackState, noteNativeFallback, playbackSource, resetNativeFallbackForTests } from "../src/features/playback/mediaTransport";
import { createStallWatchdog } from "../src/features/playback/stallWatchdogWiring";
import { createSrPerfTracker, effectiveSrMode, presentationPipeline, srContentRect, srCostBudgetMs, srDemote, srHasConfirmedFrame, srPerfStep, srVideoFilterMode } from "../src/features/playback/SuperResCanvas";
import { createSrFpsEstimator } from "../src/features/playback/srFpsEstimate";
import { createSrDensitySampler, type SrFragSample, type SrLevelInfo } from "../src/features/playback/useSrDensity";
import { evaluateSrGatesV2, runSrProbe, srProbeCacheKey } from "../src/shared/diagnostics/gpuProbe";
import * as srDensityModule from "../src/features/playback/useSrDensity";
import * as gpuProbeModule from "../src/shared/diagnostics/gpuProbe";
import * as webgpuSrModule from "../src/features/playback/webgpuSr";
import * as srCanvasModule from "../src/features/playback/SrCanvas";
import SrCanvas from "../src/features/playback/SrCanvas";
import * as webgpuCanvasModule from "../src/features/playback/WebGpuSrCanvas";
import { registerSrProbeV2 } from "../src/features/playback/srProbe";
import { capRecordByFifo, scopedPlayKey, setCapped } from "../src/features/feed/cacheMap";
import { prewarmRetryDue } from "../src/features/feed/prewarm";
import { createFragThroughputReporter, originOf } from "../src/features/playback/playbackThroughput";
import * as throughputModule from "../src/features/playback/playbackThroughput";
import { createLedgerBinding, recordIfCurrent, registerPlayerInstance, snapshot as ledgerSnapshot, unregisterPlayerInstance, validateLedgerIntegrity } from "../src/shared/diagnostics/eventLedger";
import { ABR_DEFAULT_ESTIMATE_BPS, createHlsPlayerConfig, formatFirstRendition, lockHighestStartLevel, resolveAbrSeedBps } from "../src/features/playback/hlsConfig";
import { isPlaybackPlaying, notePlaybackPlaying } from "../src/shared/diagnostics/playbackFacts";
import Hls from "hls.js";
import { wireStallWatchdogSignals } from "../src/features/playback/stallWatchdogWiring";
import * as holdJankModule from "../src/features/feed/holdJank";
import { observeFirstRendition } from "../src/features/playback/hlsConfig";

class FakeClock implements StallClock {
  now = 0;
  private seq = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.push({ id, at: this.now + ms, fn });
    return id;
  };
  clearTimeout = (h: unknown) => {
    this.timers = this.timers.filter(t => t.id !== h);
  };
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const due = this.timers.filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.now = due.at;
      this.timers = this.timers.filter(t => t.id !== due.id);
      due.fn();
    }
    this.now = end;
  }
}

function run() {
  const results: Record<string, unknown> = {};

  /* ── F1 正常出画：FragLoaded 后 buffered 及时到达 → 永不触发 ── */
  {
    const clock = new FakeClock();
    let stalls = 0;
    const wd = new AppendStallWatchdog({ clock, hasBuffered: () => false, isPlaying: () => false, onStall: () => stalls++ });
    wd.fragLoaded();
    clock.advance(1500);
    wd.buffered();
    clock.advance(10000);
    results.f_normal_buffered = stalls;
    wd.dispose();
  }
  /* ── F2 卡死签名：FragLoaded 后 4s 无 buffered/playing → 恰触发一次 ── */
  {
    const clock = new FakeClock();
    let stalls = 0;
    const wd = new AppendStallWatchdog({ clock, hasBuffered: () => false, isPlaying: () => false, onStall: () => stalls++ });
    wd.fragLoaded();
    clock.advance(3999);
    results.f_before_deadline = stalls;
    clock.advance(1);
    results.f_at_deadline = stalls;
    clock.advance(10000);
    results.f_stays_once = stalls;
    wd.dispose();
  }
  /* ── F3 慢网：FragLoaded 都没来 → 永不触发、不误杀 ── */
  {
    const clock = new FakeClock();
    let stalls = 0;
    const wd = new AppendStallWatchdog({ clock, hasBuffered: () => false, isPlaying: () => false, onStall: () => stalls++ });
    clock.advance(60000);
    results.f_slow_network = stalls;
    wd.dispose();
  }
  /* ── F4 playing 到达即解除 ── */
  {
    const clock = new FakeClock();
    let stalls = 0;
    const wd = new AppendStallWatchdog({ clock, hasBuffered: () => false, isPlaying: () => false, onStall: () => stalls++ });
    wd.fragLoaded();
    clock.advance(2000);
    wd.playing();
    clock.advance(10000);
    results.f_playing_clears = stalls;
    wd.dispose();
  }
  /* ── F5 到点复查：事件漏报但实际已有缓冲 → 不误杀 ── */
  {
    const clock = new FakeClock();
    let stalls = 0;
    let bufferedNow = false;
    const wd = new AppendStallWatchdog({ clock, hasBuffered: () => bufferedNow, isPlaying: () => false, onStall: () => stalls++ });
    wd.fragLoaded();
    bufferedNow = true; // 缓冲已有，但 buffered 事件漏报
    clock.advance(4000);
    /* 口径随 audit5 条 1 转交语义更新（Muse 2026-11-19 根治包）：
     * append 窗到期不误判 append 卡死（原 F5 语义保留于此点）；但缓冲
     * 已有却永不出画是第二臂的 buffered-no-play 签名，转交后照常判死
     * （见 F13），旧「advance 10000 恒 0」与第二臂契约互斥、就此作废。 */
    results.f_predicate_rescue = stalls;
    clock.advance(4000);
    results.f_predicate_handoff_stall = stalls;
    wd.dispose();
  }
  /* ── F6 三段链：判死→重建→再判死→会话降级，后续视频直接 native ── */
  {
    const src = "https://cdn.example/movie.m3u8";
    results.f_engine_before = playbackSource(src, true).engine;
    let attempt = 0;
    let fellBack = false;
    const policy = () => {
      if (attempt < 1) { attempt += 1; return "retry"; }
      if (noteNativeFallback("append_stall")) fellBack = true;
      return "fallback";
    };
    const clock1 = new FakeClock();
    const wd1 = new AppendStallWatchdog({ clock: clock1, hasBuffered: () => false, isPlaying: () => false, onStall: policy });
    wd1.fragLoaded();
    clock1.advance(4000);
    results.f_first_stall_action = attempt === 1 && !fellBack ? "retry" : "wrong";
    const clock2 = new FakeClock();
    const wd2 = new AppendStallWatchdog({ clock: clock2, hasBuffered: () => false, isPlaying: () => false, onStall: policy });
    wd2.fragLoaded();
    clock2.advance(4000);
    results.f_second_stall_fell_back = fellBack;
    results.f_fallback_state = nativeFallbackState()?.reason ?? null;
    results.f_engine_after = playbackSource(src, true).engine;
    wd1.dispose();
    wd2.dispose();
  }

  /* ── F7 append-hung：append 已开始、首窗只宽限一次，次窗判死 ── */
  {
    const clock = new FakeClock();
    let stalls = 0;
    let state: string | null = null;
    const wd = new AppendStallWatchdog({ clock, hasBuffered: () => false, isPlaying: () => false, onStall: s => { stalls++; state = s; } });
    wd.fragLoaded();
    wd.appendStarted();
    clock.advance(4000);
    results.f_append_hung_grace = stalls;
    wd.appendStarted(); // 宽限期内再次 appendStarted 不重置宽限
    clock.advance(4000);
    results.f_append_hung_fires = stalls;
    results.f_append_hung_state = state;
    clock.advance(10000);
    results.f_append_hung_once = stalls;
    wd.dispose();
  }
  /* ── F8 appended-no-buffer：append 已结束但缓冲仍空 → 到点判死 ── */
  {
    const clock = new FakeClock();
    let stalls = 0;
    let state: string | null = null;
    const wd = new AppendStallWatchdog({ clock, hasBuffered: () => false, isPlaying: () => false, onStall: s => { stalls++; state = s; } });
    wd.fragLoaded();
    wd.appendStarted();
    wd.appendEnded();
    clock.advance(4000);
    results.f_appended_no_buffer_fires = stalls;
    results.f_appended_no_buffer_state = state;
    wd.dispose();
  }
  /* ── F9 buffered-no-play：缓冲已达但 playing 不来 → 第二臂判死 ── */
  {
    const clock = new FakeClock();
    let stalls = 0;
    let state: string | null = null;
    const wd = new AppendStallWatchdog({ clock, hasBuffered: () => true, isPlaying: () => false, onStall: s => { stalls++; state = s; } });
    wd.fragLoaded();
    wd.buffered();
    clock.advance(3999);
    results.f_buffered_no_play_before = stalls;
    clock.advance(1);
    results.f_buffered_no_play_fires = stalls;
    results.f_buffered_no_play_state = state;
    clock.advance(10000);
    results.f_buffered_no_play_once = stalls;
    wd.dispose();
  }
  /* ── F10 意愿门控：用户不想播（shouldEscalate=false）→ 第二臂永不判死 ── */
  {
    const clock = new FakeClock();
    let stalls = 0;
    const wd = new AppendStallWatchdog({ clock, hasBuffered: () => true, isPlaying: () => false, shouldEscalate: () => false, onStall: () => stalls++ });
    wd.fragLoaded();
    wd.buffered();
    clock.advance(20000);
    results.f_will_gate_blocks = stalls;
    wd.dispose();
  }
  /* ── F11 出画解除第二臂：buffered 后 playing 到达 → 永不判死 ── */
  {
    const clock = new FakeClock();
    let stalls = 0;
    const wd = new AppendStallWatchdog({ clock, hasBuffered: () => true, isPlaying: () => false, onStall: () => stalls++ });
    wd.fragLoaded();
    wd.buffered();
    clock.advance(2000);
    wd.playing();
    clock.advance(10000);
    results.f_playing_clears_second_arm = stalls;
    wd.dispose();
  }

  /* ── F12 F10 续集（audit5 条 1）：门控命中挂起 → 意愿返回 resume →
   * 再卡死必须判死。旧实现门控命中即 cleared 永久退役，本例必红。 ── */
  {
    const clock = new FakeClock();
    let stalls = 0;
    let wanted = false;
    const wd = new AppendStallWatchdog({ clock, hasBuffered: () => true, isPlaying: () => false, shouldEscalate: () => wanted, onStall: () => stalls++ });
    wd.fragLoaded();
    wd.buffered();
    clock.advance(4000); // 出画守候到期：意愿不在 → 挂起，不判死不退役
    results.f_gate_suspends_no_stall = stalls;
    results.f_gate_suspended = wd.isSuspended;
    wanted = true;
    wd.resume(); // 意愿恢复：重新起守候窗
    clock.advance(3999);
    results.f_resumed_before_deadline = stalls;
    clock.advance(1);
    results.f_resumed_stall_fires = stalls;
    wd.dispose();
  }
  /* ── F14 判死被意愿门挂起必须留痕（fix322/play）：两臂挂起时经
   * onGated 报出被吞的判定，判死行为与挂起/复活语义不变。背景：
   * 3.2.1 真机「用户可见卡死、诊断无 append_stall」——门后无痕即
   * 无从定性。旧码无 onGated 通道，gated 恒空、本组必红。 ── */
  {
    const clock = new FakeClock();
    let stalls = 0;
    let wanted = false;
    const gated: string[] = [];
    const wd = new AppendStallWatchdog({ clock, hasBuffered: () => false, isPlaying: () => false, shouldEscalate: () => wanted, onStall: () => stalls++, onGated: s => gated.push(s) });
    wd.fragLoaded();
    clock.advance(4000);
    results.f14_append_arm_gated = [...gated];
    results.f14_append_arm_no_stall = stalls;
    wanted = true;
    wd.resume();
    clock.advance(4000);
    results.f14_after_resume_stall = stalls;
    results.f14_after_resume_gated = [...gated];
    wd.dispose();
  }
  {
    const clock = new FakeClock();
    let stalls = 0;
    const gated: string[] = [];
    const wd = new AppendStallWatchdog({ clock, hasBuffered: () => true, isPlaying: () => false, shouldEscalate: () => false, onStall: () => stalls++, onGated: s => gated.push(s) });
    wd.fragLoaded();
    wd.buffered();
    clock.advance(20000);
    results.f14_play_arm_gated = [...gated];
    results.f14_play_arm_no_stall = stalls;
    wd.dispose();
  }
  /* ── F13 append 臂转交（audit5 条 1 旁路）：FRAG_BUFFERED 事件漏报、
   * append 到点复查 hasBuffered 命中 → 转交出画守候臂而非退役，
   * 出画窗内 playing 不来仍判死 buffered-no-play。旧实现必红。 ── */
  {
    const clock = new FakeClock();
    let stalls = 0;
    let state: string | null = null;
    let bufferedNow = false;
    const wd = new AppendStallWatchdog({ clock, hasBuffered: () => bufferedNow, isPlaying: () => false, onStall: s => { stalls++; state = s; } });
    wd.fragLoaded();
    bufferedNow = true; // 缓冲已有，但 buffered 事件漏报
    clock.advance(4000); // append 臂到期：转交第二臂，不判死不退役
    results.f_transfer_no_stall_yet = stalls;
    clock.advance(4000); // 第二臂到期：仍不出画 → 判死
    results.f_transfer_stall_fires = stalls;
    results.f_transfer_state = state;
    wd.dispose();
  }

  /* ── B10 append 臂意愿门（整改 B10，先核实后修）：append 窗内意愿
   * 不在（shouldEscalate=false）→ append 臂必须与出画臂同态挂起、
   * 不 retire；意愿恢复 resume() 后再卡死仍须判死。旧实现 append
   * 臂先 retire 再调 onStall（接线层吞掉即永久退役），本例必红。 ── */
  {
    const clock = new FakeClock();
    let stalls = 0;
    let wanted = false;
    const wd = new AppendStallWatchdog({ clock, hasBuffered: () => false, isPlaying: () => false, shouldEscalate: () => wanted, onStall: () => stalls++ });
    wd.fragLoaded();
    clock.advance(4000); // append 窗到期：意愿不在 → 挂起，不判死不退役
    results.b10_append_gate_no_stall = stalls;
    results.b10_append_gate_suspended = wd.isSuspended;
    wanted = true;
    wd.resume(); // 意愿恢复：append 臂重新起窗
    clock.advance(3999);
    results.b10_append_resumed_before_deadline = stalls;
    clock.advance(1);
    results.b10_append_resumed_stall_fires = stalls;
    wd.dispose();
  }

  /* ── B18 全局播放事实源契约（整改 B18）：notePlaybackPlaying 是
   * autoLine main-return 护栏的唯一事实源——置 true 后 isPlaybackPlaying
   * 必须为 true，置 false 后必须为 false（两播放面共用同一口径）。
   * Player 侧接线本身由文件末尾的模块级接线用例断言（__b18）。 ── */
  notePlaybackPlaying(true);
  results.b18_fact_playing_true = isPlaybackPlaying();
  notePlaybackPlaying(false);
  results.b18_fact_playing_false = isPlaybackPlaying();

  /* ── B13 FRAG_LOADED 按类型过滤（整改 B13，先核实）：独立音频轨的
   * 音频分片（frag.type="audio"）不得进看门狗记账/首档记录/密度入口；
   * 只过滤 part/sn 的旧实现会让音频 level 与视频 level 交替出现。 ── */
  {
    const handlers = new Map<string, (e: unknown, data: unknown) => void>();
    const fakeHls = { on: (ev: string, cb: (e: unknown, data: unknown) => void) => handlers.set(ev, cb) };
    const fakeVideo = { addEventListener: () => {}, removeEventListener: () => {} };
    let wdFragLoaded = 0;
    let cbFragLoaded = 0;
    const fakeWatchdog = { fragLoaded: () => { wdFragLoaded += 1; }, buffered: () => {}, playing: () => {}, appendStarted: () => {}, appendEnded: () => {}, resume: () => {} };
    wireStallWatchdogSignals({
      hls: fakeHls as unknown as Hls, video: fakeVideo as unknown as HTMLVideoElement,
      watchdog: fakeWatchdog as unknown as AppendStallWatchdog,
      onFragLoaded: () => { cbFragLoaded += 1; },
    });
    const onFrag = handlers.get(Hls.Events.FRAG_LOADED)!;
    onFrag(null, { part: undefined, frag: { sn: 3, type: "audio", level: 0 } });
    results.b13_watchdog_audio_frag_blocked = [wdFragLoaded, cbFragLoaded];
    onFrag(null, { part: undefined, frag: { sn: 4, type: "main", level: 0 } });
    results.b13_watchdog_main_frag_passes = [wdFragLoaded, cbFragLoaded];
  }
  {
    const handlers = new Map<string, (e: unknown, data: unknown) => void>();
    const fakeHls = {
      levels: [{ width: 640, height: 360, bitrate: 800_000 }, { width: 1920, height: 1080, bitrate: 8_000_000 }],
      on: (ev: string, cb: (e: unknown, data: unknown) => void) => handlers.set(ev, cb),
    };
    const seen: number[] = [];
    observeFirstRendition(fakeHls as unknown as Hls, Hls.Events, r => seen.push(r.index));
    const onFrag = handlers.get(Hls.Events.FRAG_LOADED)!;
    onFrag(null, { frag: { level: 0, type: "audio" } });
    results.b13_first_rendition_audio_blocked = [...seen];
    onFrag(null, { frag: { level: 1, type: "main" } });
    results.b13_first_rendition_main_recorded = [...seen];
  }

  /* ── B1 切线连续性·登记口径（整改 B1）：stallHeal 接回登记与作用域
   * 判定 helper——登记键为 epoch 无关的 id:ep，epoch 变前写入、变后
   * 按同键必须命中且只消费一次；作用域判定：同 id:ep 仅作用域变 →
   * scopeOnly。两 helper 均为本项新增导出，经命名空间读取，旧代码
   * 缺导出时结果为 "missing"（红）。 ── */
  {
    const sh = stallHealModule as unknown as {
      recordHealResume?: (m: Map<string, number>, id: number, ep: number, t: number) => void;
      consumeHealResume?: (m: Map<string, number>, id: number, ep: number) => number | null;
    };
    const reg = new Map<string, number>();
    sh.recordHealResume?.(reg, 42, 2, 42);
    results.b1_heal_resume_hits_after_epoch_change = sh.consumeHealResume ? sh.consumeHealResume(reg, 42, 2) : "missing";
    results.b1_heal_resume_consumed_once = sh.consumeHealResume ? sh.consumeHealResume(reg, 42, 2) : "missing";
    const pc = playUrlCacheModule as unknown as {
      isScopeOnlyChange?: (prevKey: string, nextKey: string, prevContent: string, nextContent: string) => boolean;
    };
    results.b1_scope_only_same_content = pc.isScopeOnlyChange ? pc.isScopeOnlyChange("a:7:42:2", "a:8:42:2", "42:2", "42:2") : "missing";
    results.b1_scope_only_diff_content = pc.isScopeOnlyChange ? pc.isScopeOnlyChange("a:7:42:2", "a:8:43:1", "42:2", "43:1") : "missing";
    results.b1_scope_only_first_key = pc.isScopeOnlyChange ? pc.isScopeOnlyChange("", "a:8:42:2", "42:2", "42:2") : "missing";
  }

  /* ── B17-4 webgpuSr 降级门排除快速域（整改 B17-4）：纯状态机
   * createSrDegradeGate——≥2x 域样本不入窗、退出清窗；正常域连续
   * 两轮 30 帧均值超预算才 step。旧引擎内联判定无此导出且不排除
   * 快速域，结果为 "missing"（红）。 ── */
  {
    const wg = webgpuSrModule as unknown as {
      createSrDegradeGate?: () => { sample: (costMs: number, frameIntervalMs: number, fastRate: boolean) => "none" | "step" };
    };
    if (!wg.createSrDegradeGate) {
      results.b17_gate_fast_domain_no_step = "missing";
      results.b17_gate_step_at_31 = "missing";
      results.b17_gate_window_restarts_after_fast = "missing";
    } else {
      const g1 = wg.createSrDegradeGate();
      let fastStep = "none";
      for (let i = 0; i < 100; i++) if (g1.sample(100, 33.3, true) === "step") fastStep = "step";
      results.b17_gate_fast_domain_no_step = fastStep;
      const g2 = wg.createSrDegradeGate();
      let at30 = "none"; let at31 = "none";
      for (let i = 1; i <= 31; i++) { const r = g2.sample(50, 33.3, false); if (i === 30) at30 = r; if (i === 31) at31 = r; }
      results.b17_gate_step_at_31 = at30 === "none" && at31 === "step" ? "step" : `${at30}/${at31}`;
      const g3 = wg.createSrDegradeGate();
      for (let i = 0; i < 29; i++) g3.sample(50, 33.3, false);
      g3.sample(100, 33.3, true);
      let afterFast = "none";
      for (let i = 0; i < 29; i++) if (g3.sample(50, 33.3, false) === "step") afterFast = "step";
      results.b17_gate_window_restarts_after_fast = afterFast;
    }
  }

  /* ── B17-2 WebGPU 档位回报口径（整改 B17-2）：呈现档 = srDemote
   * (mode, degrade)——degrade 0 原档、1 降一档。旧组件只在首帧报一
   * 次原 mode、无此导出，结果为 "missing"（红）。 ── */
  {
    const wc = webgpuCanvasModule as unknown as {
      webgpuReportedMode?: (mode: string, degrade: 0 | 1 | 2) => string;
    };
    results.b17_reported_mode_degrade0 = wc.webgpuReportedMode ? wc.webgpuReportedMode("natural", 0) : "missing";
    results.b17_reported_mode_degrade1 = wc.webgpuReportedMode ? wc.webgpuReportedMode("natural", 1) : "missing";
  }

  /* ── B17-3 死亡闩锁全局化（整改 B17-3）：note 后全部订阅者被通知
   * 且闩锁置位。旧实现只有触发实例自知、无订阅导出，结果为
   * "missing"（红）。测毕用测试复位口恢复闩锁，不污染后续探针。 ── */
  {
    const sc = srCanvasModule as unknown as {
      subscribeWebgpuSessionDeath?: (fn: () => void) => () => void;
      noteWebgpuSessionDeath?: () => void;
      resetWebgpuSessionDeathForTests?: () => void;
    };
    if (!sc.subscribeWebgpuSessionDeath || !sc.noteWebgpuSessionDeath) {
      results.b17_death_notifies_all = "missing";
    } else {
      let a = 0; let b = 0;
      const offA = sc.subscribeWebgpuSessionDeath(() => { a += 1; });
      sc.subscribeWebgpuSessionDeath(() => { b += 1; });
      sc.noteWebgpuSessionDeath();
      results.b17_death_notifies_all = a === 1 && b === 1 && srCanvasModule.isWebgpuSessionDead() ? "notified" : `a=${a},b=${b}`;
      offA();
      sc.resetWebgpuSessionDeathForTests?.();
    }
  }

  /* ── C 超分判档（模拟源参数 + 真实采样锚点） ── */
  results.c_1080p_high_density = effectiveSrMode("auto", 1920, 1080, { bitrateBps: 12_000_000, fps: 30 });
  results.c_1080p_low_density = effectiveSrMode("auto", 1920, 1080, { bitrateBps: 2_500_000, fps: 30 });
  results.c_720p_low_density = effectiveSrMode("auto", 1280, 720, { bitrateBps: 1_343_000, fps: 24 });
  results.c_sample_starved_720p = effectiveSrMode("auto", 720, 1280, { bitrateBps: 1_164_000, fps: 30 });
  results.c_sample_mid_1080p = effectiveSrMode("auto", 1080, 1920, { bitrateBps: 6_014_000, fps: 30 });
  results.c_sample_healthy_720p = effectiveSrMode("auto", 720, 1280, { bitrateBps: 3_530_000, fps: 30 });
  results.c_no_density_720 = effectiveSrMode("auto", 1280, 720);
  results.c_no_density_1080 = effectiveSrMode("auto", 1920, 1080);
  results.c_low_res = effectiveSrMode("auto", 640, 480, { bitrateBps: 3_000_000, fps: 30 });
  results.c_pref_off = effectiveSrMode("off", 720, 1280, { bitrateBps: 500_000, fps: 30 });
  results.c_unknown_size = effectiveSrMode("auto", 0, 0);
  results.c_demote = [srDemote("crisp", 1), srDemote("natural", 1), srDemote("off", 1), srDemote("crisp", 2)];

  /* ── C2 SR 帧率回填（2026-11-19 3.3.0批 SR 帧率回填线）：单档列表
   * 形态（声明 fps 恒缺失、低密度 bpp≈0.044）回填前恒 natural、实测
   * 定版后翻 crisp；回归两条——高密度源回填后不得新翻 off（关超分
   * 门只认声明 fps）、帧预算只认声明 fps（同 density 下预算不变）。 */
  results.c2_single_level_unknown_fps = effectiveSrMode("auto", 720, 1280, { bitrateBps: 1_219_000 });
  results.c2_single_level_measured_fps = effectiveSrMode("auto", 720, 1280, { bitrateBps: 1_219_000, measuredFps: 30 });
  results.c2_high_density_measured_not_off = effectiveSrMode("auto", 1080, 1920, { bitrateBps: 12_000_000, measuredFps: 30 });
  results.c2_high_density_declared_off = effectiveSrMode("auto", 1080, 1920, { bitrateBps: 12_000_000, fps: 30 });
  results.c2_budget_declared_only = [srCostBudgetMs(undefined), srCostBudgetMs(30), Math.round(srCostBudgetMs(60) * 1000) / 1000];
  {
    const est = createSrFpsEstimator();
    let settled: ReturnType<typeof est.current> = est.current();
    for (let k = 0; k <= 70; k++) settled = est.feed(k, k / 30);
    results.c2_estimator_30fps = [settled.settled, settled.fps ?? null];
  }

  /* ── D SR 黑场自检纯判据：内容矩形避黑边 + 有效帧门控 ── */
  // 竖屏源（720x1280）进横画布（1920x1080）：内容居中、左右各留 656.25 黑边
  results.d_rect_wide_canvas = srContentRect(1920, 1080, 720, 1280, "contain");
  // 横屏源（1920x1080）进竖画布（1080x1920）：内容居中、上下各留 656.25 黑边
  results.d_rect_tall_canvas = srContentRect(1080, 1920, 1920, 1080, "contain");
  // cover 无黑边：矩形即全画布
  results.d_rect_cover = srContentRect(1920, 1080, 720, 1280, "cover");
  // rVFC 可用：没回调过就是没确认（哪怕 readyState 已满）
  results.d_frame_rvfc_pending = srHasConfirmedFrame({ requestVideoFrameCallback: () => 0, readyState: 4, videoWidth: 720, videoHeight: 1280 }, false);
  results.d_frame_rvfc_seen = srHasConfirmedFrame({ requestVideoFrameCallback: () => 0, readyState: 4, videoWidth: 720, videoHeight: 1280 }, true);
  // rVFC 不可用：回落 readyState>=2 且尺寸已知
  results.d_frame_fallback_ready = srHasConfirmedFrame({ readyState: 2, videoWidth: 720, videoHeight: 1280 }, false);
  results.d_frame_fallback_notready = srHasConfirmedFrame({ readyState: 1, videoWidth: 720, videoHeight: 1280 }, false);

  /* ── U1 自动选档：帧成本双向调节（迟滞）+ 合成层保底判定 ── */
  {
    // 预算 16：坏窗（20）单窗即降；好窗（4<8）须连续 3 窗才升；中性带（12）清零计数
    let s = { demote: 0, goodStreak: 0 };
    const feed = (avg: number) => { const r = srPerfStep(avg, 16, s.demote, 2, s.goodStreak); s = { demote: r.demote, goodStreak: r.goodStreak }; return r.action; };
    results.u_demote_fast = feed(20);
    results.u_promote_first_good = feed(4);
    results.u_promote_neutral_resets = feed(12);
    results.u_promote_streak_restarts = feed(4);
    feed(4);
    results.u_promote_after_3_good = feed(4);
    results.u_demote_at_floor = (() => { let d = 2, g = 0; const r = srPerfStep(99, 16, d, 2, g); return [r.demote, r.action]; })();
  }
  /* ── U3 长按松手管线阶跃（根治包）：帧成本记账器的速率域口径 ──
   * 场景：1x 先攒 59 帧好样本 → 长按进 ≥2x 域（隔帧交替）→ 域内塞
   * 60 帧爆贵样本（旧实现会混窗降档、阶跃恰可落在松手帧）→ 松手
   * 退出（清窗）→ 59 帧仍未满窗 → 第 60 帧好窗不动档；对照组：
   * 正常域爆贵窗仍单窗即降（阶梯保护不被去抖削弱）。 */
  {
    const t = createSrPerfTracker();
    const base = { budgetMs: 16, demote: 0, maxDemote: 2 };
    let v: unknown = null;
    for (let i = 0; i < 59; i++) v = t.sample(4, { ...base, fastRate: false, probing: false });
    results.u3_window_not_full = v;
    results.u3_gate_fast_seq = [t.gate(true), t.gate(true), t.gate(true), t.gate(true)];
    let fastVerdict: unknown = null;
    for (let i = 0; i < 60; i++) { const r = t.sample(99, { ...base, fastRate: true, probing: false }); if (r) fastVerdict = r; }
    results.u3_fast_samples_dropped = fastVerdict;
    results.u3_gate_release = t.gate(false);
    v = null;
    for (let i = 0; i < 59; i++) v = t.sample(4, { ...base, fastRate: false, probing: false });
    results.u3_window_restarted = v;
    const good = t.sample(4, { ...base, fastRate: false, probing: false });
    results.u3_good_window = good && [good.action, good.demote];
    const t2 = createSrPerfTracker();
    let bad: ReturnType<typeof t2.sample> = null;
    for (let i = 0; i < 60; i++) bad = t2.sample(99, { ...base, fastRate: false, probing: false });
    results.u3_bad_window_demotes = bad && [bad.action, bad.demote];
  }
  // 合成层保底矩阵：[自动判档 off→natural 保底 / 显式关→无 / WebGL 呈现中→无（防双重）/
  // 性能降到 off→natural 保底 / svgFallback→本档位滤镜]
  results.u_filter_auto_off = srVideoFilterMode({ srPref: "auto", srMode: "off", canvasMode: "off", svgFallback: false }) ?? null;
  results.u_filter_pref_off = srVideoFilterMode({ srPref: "off", srMode: "off", canvasMode: "off", svgFallback: false }) ?? null;
  results.u_filter_webgl_presenting = srVideoFilterMode({ srPref: "auto", srMode: "crisp", canvasMode: "crisp", svgFallback: false }) ?? null;
  results.u_filter_demoted_off = srVideoFilterMode({ srPref: "auto", srMode: "crisp", canvasMode: "off", svgFallback: false }) ?? null;
  results.u_filter_svg_fallback = srVideoFilterMode({ srPref: "auto", srMode: "cinema", canvasMode: "cinema", svgFallback: true }) ?? null;
  /* ── U2 off 原因矩阵（audit6 P0-A 第 2 层）：judged 真 off、demoted/
   * unavailable SVG 保底；呈现管线枚举与判档分离 ── */
  results.u2_judged_true_off = srVideoFilterMode({ srPref: "auto", srMode: "off", canvasMode: "off", svgFallback: false, canvasOffReason: "judged" }) ?? null;
  results.u2_demoted_floor = srVideoFilterMode({ srPref: "auto", srMode: "crisp", canvasMode: "off", svgFallback: false, canvasOffReason: "demoted" }) ?? null;
  results.u2_unavailable_floor = srVideoFilterMode({ srPref: "auto", srMode: "natural", canvasMode: "off", svgFallback: false, canvasOffReason: "unavailable" }) ?? null;
  results.u2_pipeline_svg = presentationPipeline({ webgpuEngaged: false, canvasMode: "off", filterMode: "natural" });
  results.u2_pipeline_none = presentationPipeline({ webgpuEngaged: false, canvasMode: "off", filterMode: undefined });
  results.u2_pipeline_webgl = presentationPipeline({ webgpuEngaged: false, canvasMode: "crisp", filterMode: undefined });
  results.u2_pipeline_webgpu = presentationPipeline({ webgpuEngaged: true, canvasMode: "crisp", filterMode: undefined });

  /* ── S 共享密度采样器（audit6 P0-A 第 2 层）：中位数口径、换 level
   * 重采、显式重置（换源/换线共用同一 reset 面） ── */
  {
    const sampler = createSrDensitySampler();
    const lvl = { frameRate: 30, videoCodec: "avc1.640028" };
    sampler.ingest({ loaded: 100_000, duration: 2, level: 0 }, lvl); // 400kbps
    sampler.ingest({ loaded: 300_000, duration: 2, level: 0 }, lvl); // 1.2Mbps
    const third = sampler.ingest({ loaded: 200_000, duration: 2, level: 0 }, lvl); // 800kbps → 中位数 800k
    results.s_median = third?.bitrateBps ?? null;
    results.s_fps_codec = [third?.fps ?? null, third?.codec ?? null];
    const switched = sampler.ingest({ loaded: 500_000, duration: 2, level: 1 }, { frameRate: 60, videoCodec: "hvc1.1.6" });
    results.s_level_switch_resamples = switched?.bitrateBps ?? null; // 换 level 后单样本即新中位数 2Mbps
    sampler.reset();
    results.s_reset_clears = sampler.current();
  }

  /* ── B4 判档同 rendition（整改 B4）：下载分片属低档（frag 字节只够
   * 400kbps）但正在播放的 level 是 1080p 档时，判档入参必须全部取
   * playing level 同一 rendition：码率=该档标称码率、fps/codec/宽/高
   * 同档，不许拿下载档字节或显示帧尺寸拼 bpp。 ── */
  {
    const sampler = createSrDensitySampler();
    const playing = { frameRate: 30, videoCodec: "avc1.640028", width: 1920, height: 1080, bitrate: 8_000_000 };
    let d: ReturnType<typeof sampler.ingest> = null;
    for (let i = 0; i < 3; i++) d = sampler.ingest({ loaded: 100_000, duration: 2, level: 2 }, playing);
    results.b4_density_bitrate_from_playing_level = d?.bitrateBps ?? null;
    results.b4_density_size_from_playing_level = [d?.width ?? null, d?.height ?? null];
    results.b4_density_fps_codec_from_playing_level = [d?.fps ?? null, d?.codec ?? null];
  }

  /* ── E 最终版 E 线（Muse 2026-11-19 fin-e）：①SR 探针失败短 TTL
   * ②密度 provisional（GPT P2-04）。新导出经模块命名空间取用：基线
   * 无此导出/字段时结果记缺失或旧行为 → 本组在基线上红、修复后绿。
   * 判档判别例：1080p 低密度（1.2Mbps、bpp≈0.019）——final 时判
   * crisp；provisional 值若驱动判档也会判 crisp；受防护时密度视为
   * 未知、走纯分辨率回落判 off。故 1–2 片期望 off、3 片期望 crisp。 */
  {
    const forTiering = (srDensityModule as unknown as { srDensityForTiering?: (d: unknown) => { bitrateBps?: number } | undefined }).srDensityForTiering;
    const sampler = createSrDensitySampler();
    const lvl = { frameRate: 30, videoCodec: "avc1.640028", width: 1920, height: 1080, bitrate: 1_200_000 };
    const frag = { loaded: 100_000, duration: 2, level: 0 };
    type Prov = { provisional?: boolean; sampleCount?: number };
    const one = sampler.ingest(frag, lvl);
    results.e_prov_1_flag = (one as Prov | null)?.provisional ?? null;
    results.e_prov_1_count = (one as Prov | null)?.sampleCount ?? null;
    results.e_prov_1_tiering = forTiering ? (forTiering(one) ?? null) : "missing";
    results.e_prov_1_mode = effectiveSrMode("auto", 1920, 1080, one as unknown as Parameters<typeof effectiveSrMode>[3] ?? undefined);
    const two = sampler.ingest(frag, lvl);
    results.e_prov_2_flag = (two as Prov | null)?.provisional ?? null;
    results.e_prov_2_count = (two as Prov | null)?.sampleCount ?? null;
    results.e_prov_2_tiering = forTiering ? (forTiering(two) ?? null) : "missing";
    results.e_prov_2_mode = effectiveSrMode("auto", 1920, 1080, two as unknown as Parameters<typeof effectiveSrMode>[3] ?? undefined);
    const three = sampler.ingest(frag, lvl);
    results.e_prov_3_flag = (three as Prov | null)?.provisional ?? null;
    results.e_prov_3_count = (three as Prov | null)?.sampleCount ?? null;
    results.e_prov_3_tiering_bps = forTiering ? (forTiering(three)?.bitrateBps ?? null) : "missing";
    results.e_prov_3_mode = effectiveSrMode("auto", 1920, 1080, three as unknown as Parameters<typeof effectiveSrMode>[3] ?? undefined);
  }
  {
    const readPersisted = (gpuProbeModule as unknown as { readPersistedSrProbe?: () => { source?: string; gatesPass?: boolean } | null }).readPersistedSrProbe;
    const key = srProbeCacheKey();
    const day = 86400_000;
    const okChains = {
      presented720: 10, frames720Ok: true,
      external: { ok: true, msAvg: 5, msP90: 6, processed: 24, dropped: 0 },
      copy: { ok: true, msAvg: 5, msP90: 6, processed: 24, dropped: 0 },
      chain720: { ok: true, msAvg: 11, msP90: 15, withinBudget: true },
      chain1080: { ok: true, msAvg: 16, msP90: 20 },
      deviceLost: 0, droppedRate720: 0.01, tailRatio720: 1.05,
    };
    const success29 = { ...okChains, at: new Date(Date.now() - 29 * day).toISOString(), recommendedPath: "copy", gatesPass: true };
    const failure2d = { ...okChains, chain720: { ok: false, msAvg: null, msP90: null, withinBudget: false }, at: new Date(Date.now() - 2 * day).toISOString(), recommendedPath: null, gatesPass: false };
    const success31 = { ...success29, at: new Date(Date.now() - 31 * day).toISOString() };
    try {
      localStorage.setItem(key, JSON.stringify(failure2d));
      results.e_ttl_failure_2d = readPersisted ? (readPersisted() === null ? "ignored" : "used") : "missing";
      localStorage.setItem(key, JSON.stringify(success29));
      const hit = readPersisted ? readPersisted() : null;
      results.e_ttl_success_29d = hit ? (hit.source ?? "hit-no-source") : "missing";
      results.e_ttl_success_29d_gates = hit ? (hit.gatesPass ?? null) : null;
      localStorage.setItem(key, JSON.stringify(success31));
      results.e_ttl_success_31d = readPersisted ? (readPersisted() === null ? "ignored" : "used") : "missing";
    } catch {
      results.e_ttl_error = "threw";
    }
    try { localStorage.removeItem(key); } catch { /* 清理夹具写入 */ }
  }

  /* ── E2 最终版 E2 线（Muse 2026-11-19 fin-e2，来源②GPT 后续复审
   * 主代理亲核条目 1/2/3）：①SR 生产统计周期发布（与探针分开）
   * ②帧预算纳入倍速核销 ③natural/crisp WebGPU 路径真实差异。
   * 新导出经命名空间取用：基线无此导出时记 "missing" → 本组红。 */
  {
    const gp = gpuProbeModule as unknown as {
      createSrProductionPublisher?: (opts?: { intervalMs?: number }) => {
        consider: (input: { frames: number; droppedStale: number; costs: number[]; degrade: 0 | 1 | 2; path: string; mode: string }, nowMs: number) => { frames: number; droppedRate: number; costAvgMs: number; costP90Ms: number; phase: string; degradeTrail: number[] } | null;
      };
      getSrProductionStats?: () => { frames: number } | null;
      formatSrProductionLines?: (s: unknown) => string[];
      srDroppedRate?: (frames: number, dropped: number) => number;
      srCostP90?: (costs: number[]) => number;
    };
    const round4 = (v: number) => Math.round(v * 10000) / 10000;
    const costs = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100ms
    results.e2_dropped_rate_fn = gp.srDroppedRate ? round4(gp.srDroppedRate(100, 3)) : "missing";
    results.e2_p90_fn = gp.srCostP90 ? gp.srCostP90(costs) : "missing";
    const pub = gp.createSrProductionPublisher ? gp.createSrProductionPublisher({ intervalMs: 30_000 }) : null;
    const in1 = { frames: 100, droppedStale: 3, costs, degrade: 0 as const, path: "copy", mode: "natural" };
    const p1 = pub ? pub.consider(in1, 0) : "missing";
    results.e2_prod_first_publish = p1 === "missing" ? "missing" : p1 != null;
    results.e2_prod_first_phase = p1 === "missing" || p1 == null ? "missing" : p1.phase;
    results.e2_prod_first_frames = p1 === "missing" || p1 == null ? "missing" : p1.frames;
    results.e2_prod_first_dropped_rate = p1 === "missing" || p1 == null ? "missing" : round4(p1.droppedRate);
    results.e2_prod_first_avg = p1 === "missing" || p1 == null ? "missing" : p1.costAvgMs;
    results.e2_prod_first_p90 = p1 === "missing" || p1 == null ? "missing" : p1.costP90Ms;
    const p2 = pub ? pub.consider({ ...in1, frames: 150, droppedStale: 4 }, 10_000) : "missing";
    results.e2_prod_throttled = p2 === "missing" ? "missing" : p2 === null;
    const p3 = pub ? pub.consider({ ...in1, frames: 200, droppedStale: 5 }, 30_000) : "missing";
    results.e2_prod_interval_frames = p3 === "missing" || p3 == null ? "missing" : p3.frames;
    results.e2_prod_interval_dropped_rate = p3 === "missing" || p3 == null ? "missing" : round4(p3.droppedRate);
    const p4 = pub ? pub.consider({ ...in1, frames: 210, droppedStale: 5, degrade: 1 as const }, 31_000) : "missing";
    results.e2_prod_degrade_forced = p4 === "missing" ? "missing" : p4 != null;
    results.e2_prod_degrade_trail = p4 === "missing" || p4 == null ? "missing" : p4.degradeTrail;
    results.e2_prod_registry_frames = gp.getSrProductionStats ? (gp.getSrProductionStats()?.frames ?? null) : "missing";
    results.e2_prod_lines_label = gp.formatSrProductionLines && gp.getSrProductionStats
      ? gp.formatSrProductionLines(gp.getSrProductionStats()).join("\n").includes("生产期") : "missing";
  }
  {
    const budget = (webgpuSrModule as unknown as { srFrameBudgetMs?: (fps: number | undefined, playbackRate: number) => number }).srFrameBudgetMs;
    results.e2_budget_30fps_1x = budget ? budget(30, 1) : "missing";
    results.e2_budget_30fps_125x = budget ? budget(30, 1.25) : "missing";
    results.e2_budget_30fps_15x = budget ? budget(30, 1.5) : "missing";
    results.e2_budget_unknown_fps_1x = budget ? budget(undefined, 1) : "missing";
    results.e2_budget_unknown_fps_2x = budget ? budget(undefined, 2) : "missing";
    results.e2_budget_rate_zero = budget ? budget(30, 0) : "missing";
  }
  {
    const wg = webgpuSrModule as unknown as {
      SR_PRESENT_SHARPEN?: Record<string, { coeff: number; detail: number }>;
      srPresentSharpenPixel?: (c: number[], n: number[], s: number[], w: number[], e: number[], mode: "natural" | "crisp") => number[];
    };
    results.e2_sharp_coeff_natural = wg.SR_PRESENT_SHARPEN?.natural.coeff ?? "missing";
    results.e2_sharp_coeff_crisp = wg.SR_PRESENT_SHARPEN?.crisp.coeff ?? "missing";
    const px = wg.srPresentSharpenPixel;
    const gray = (v: number) => [v, v, v];
    const flat = px ? px(gray(0.5), gray(0.5), gray(0.5), gray(0.5), gray(0.5), "crisp") : null;
    results.e2_sharp_flat_unchanged = flat ? Math.abs(flat[0] - 0.5) : "missing";
    /* 边缘例：中心 0.6、四邻 0.9/0.9/0.9/0.5（crossAvg 0.8，中心被
     * 亮邻居包围）——锐化应把中心推离局部均值（向下），crisp 推得更远。 */
    const nat = px ? px(gray(0.6), gray(0.9), gray(0.9), gray(0.9), gray(0.5), "natural") : null;
    const cri = px ? px(gray(0.6), gray(0.9), gray(0.9), gray(0.9), gray(0.5), "crisp") : null;
    const round3 = (v: number) => Math.round(v * 1000) / 1000;
    results.e2_sharp_edge_natural = nat ? round3(nat[0]) : "missing";
    results.e2_sharp_edge_crisp = cri ? round3(cri[0]) : "missing";
    results.e2_sharp_edge_separation = nat && cri ? round3(Math.abs(nat[0] - cri[0])) : "missing";
    results.e2_sharp_direction = nat && cri ? (cri[0] < nat[0] && nat[0] < 0.6) : "missing";
    results.e2_sharp_shader_wired = webgpuSrModule.__test.PRESENT_SHADER.includes("rects[2]");
  }

  /* ── H HLS 工厂（audit6 P0-A 第 1 层）：播种值、回退默认、锁最高档、
   * 首分片档位格式 ── */
  results.h_seed_from_round = resolveAbrSeedBps({ measured: [{ kbps: 1200 }, { kbps: 4500 }, { kbps: null }] });
  results.h_seed_empty = resolveAbrSeedBps(null);
  results.h_config_seeded = createHlsPlayerConfig({ ios: true, startPosition: -1, seedBps: 4_500_000 }).abrEwmaDefaultEstimate;
  results.h_config_fallback = createHlsPlayerConfig({ ios: false, startPosition: -1, seedBps: null }).abrEwmaDefaultEstimate;
  results.h_default_estimate = ABR_DEFAULT_ESTIMATE_BPS;
  {
    const fake = { levels: [{}, {}, {}, {}], startLevel: -1 } as unknown as Parameters<typeof lockHighestStartLevel>[0] & { startLevel: number };
    const locked = lockHighestStartLevel(fake);
    results.h_lock_highest = [locked, (fake as { startLevel: number }).startLevel];
  }
  results.h_first_rendition = formatFirstRendition({ index: 4, total: 4, width: 1920, height: 1080, bitrate: 8_000_000 });
  /* ── B11 ABR 播种取当前线路（整改 B11）：最快候选不是当前线路时，
   * 播种值必须 = round.base 对应候选的 kbps，而非全候选 max。 ── */
  results.b11_seed_current_line = resolveAbrSeedBps({
    base: "https://line-b.example",
    measured: [
      { host: "line-a.example", kbps: 9000 },
      { host: "line-b.example", kbps: 1500 },
      { host: "line-c.example", kbps: null },
    ],
  });
  results.b11_seed_current_line_missing = resolveAbrSeedBps({
    base: "https://line-z.example",
    measured: [{ host: "line-a.example", kbps: 9000 }],
  });

  /* ── G 门禁 v2（audit6 P0-A 第 3 层）：逐项否决——任一门不过全不过 ── */
  {
    const base = {
      recommendedPath: "copy" as const,
      chain720: { ok: true, msAvg: 11.3, msP90: 15 },
      chain1080: { ok: true, msAvg: 16.1, msP90: 20 },
      deviceLost: 0, droppedRate720: 0.01, tailRatio720: 1.05,
    };
    results.g_all_pass = evaluateSrGatesV2(base);
    results.g_p90_720_blocks = evaluateSrGatesV2({ ...base, chain720: { ok: true, msAvg: 11, msP90: 40 } });
    results.g_1080_avg_blocks = evaluateSrGatesV2({ ...base, chain1080: { ok: true, msAvg: 26, msP90: 20 } });
    results.g_device_lost_blocks = evaluateSrGatesV2({ ...base, deviceLost: 1 });
    results.g_dropped_blocks = evaluateSrGatesV2({ ...base, droppedRate720: 0.06 });
    results.g_tail_blocks = evaluateSrGatesV2({ ...base, tailRatio720: 1.25 });
    results.g_no_path_blocks = evaluateSrGatesV2({ ...base, recommendedPath: null });
  }

  /* ── K 缓存作用域与容量（audit6 P1-3/P2-07/P2-08） ── */
  results.k_scoped_key = scopedPlayKey("acct:3", 7, 42, 2);
  results.k_scoped_key_changes_with_epoch = scopedPlayKey("acct:3", 8, 42, 2) !== scopedPlayKey("acct:3", 7, 42, 2);
  results.k_scoped_key_changes_with_account = scopedPlayKey("acct:4", 7, 42, 2) !== scopedPlayKey("acct:3", 7, 42, 2);
  {
    const m = new Map<string, number>();
    for (let i = 0; i < 5; i++) setCapped(m, `k${i}`, i, 3);
    results.k_fifo_evicts_oldest = [...m.keys()];
    setCapped(m, "k4", 44, 3); // 更新已有键不淘汰
    results.k_fifo_update_keeps = [...m.keys()];
  }
  {
    const rec: Record<number, string> = { 1: "a", 2: "b", 3: "c", 4: "d" };
    results.k_record_capped = Object.keys(capRecordByFifo(rec, 2)).length;
  }
  results.k_prewarm_first_attempt = prewarmRetryDue(undefined, 100_000);
  results.k_prewarm_ok_never = prewarmRetryDue({ at: 0, ok: true, retries: 0 }, 100_000);
  results.k_prewarm_too_soon = prewarmRetryDue({ at: 90_000, ok: false, retries: 0 }, 100_000);
  results.k_prewarm_retry_due = prewarmRetryDue({ at: 60_000, ok: false, retries: 0 }, 100_000);
  results.k_prewarm_retry_exhausted = prewarmRetryDue({ at: 0, ok: false, retries: 1 }, 100_000);

  /* ── T 真实播放吞吐回写（audit6 P0-B ⑤）：5 片节流、中位数、flush 兜底 ── */
  {
    const sent: [string, number][] = [];
    const rep = createFragThroughputReporter((o, b) => sent.push([o, b]));
    rep.setOrigin("https://line.example");
    for (let i = 0; i < 4; i++) rep.push(100_000, 100); // 8Mbps each
    results.t_quiet_before_5 = sent.length;
    rep.push(300_000, 100); // 24Mbps → 中位数仍 8Mbps
    results.t_flush_at_5 = [...sent];
    rep.push(100_000, 100);
    rep.flush(); // 暂停/结束兜底
    results.t_flush_remainder = sent.length;
    results.t_origin_parse = originOf("https://line.example/path/x.m3u8");
    results.t_origin_bad = originOf("not a url");
  }

  /* ── B3 吞吐回写按当前线路 base 记账（整改 B3）：账本键必须是线路
   * base 的 origin，不是媒体地址 origin（LOCAL 包装时媒体 origin 是
   * hg://localhost，必错）。lineOriginFor 为本项新增导出，经模块命名
   * 空间读取——旧代码无此导出时结果为 "missing"，即红。 ── */
  {
    const lineOriginFor = (throughputModule as unknown as {
      lineOriginFor?: (round: { base: string } | null, fallbackSrc?: string) => string;
    }).lineOriginFor;
    results.b3_line_origin_from_base = typeof lineOriginFor === "function"
      ? lineOriginFor({ base: "https://line-b.example" }, "hg://localhost/hls?u=zzz") : "missing";
    results.b3_line_origin_no_round = typeof lineOriginFor === "function" ? lineOriginFor(null) : "missing";
    const sent: [string, number][] = [];
    const rep = createFragThroughputReporter((o, b) => sent.push([o, b]));
    rep.setOrigin(typeof lineOriginFor === "function"
      ? lineOriginFor({ base: "https://line-b.example" }, "https://media.example/x.m3u8")
      : originOf("https://media.example/x.m3u8"));
    for (let i = 0; i < 5; i++) rep.push(100_000, 100);
    results.b3_reporter_keyed_by_line = [...sent];
  }

  /* ── L 事件账本接线（audit6 诊断一级模块）：注销后迟到丢弃且不入窗口、
   * 完整性校验纯函数（同快照同结论）、retired 改名口径 ── */
  {
    const id = registerPlayerInstance();
    const before = ledgerSnapshot();
    const okIn = recordIfCurrent(id, "source.load", { generation: 0 });
    unregisterPlayerInstance(id);
    const lateOk = recordIfCurrent(id, "media.first_frame", { generation: 0 });
    const after = ledgerSnapshot();
    results.l_record_while_active = okIn;
    results.l_late_rejected = lateOk;
    results.l_dropped_late_delta = after.droppedLate - before.droppedLate;
    results.l_window_has_load = after.events.some(e => e.name === "source.load" && e.instanceId === id);
    results.l_window_has_late = after.events.some(e => e.name === "media.first_frame" && e.instanceId === id);
    const i1 = validateLedgerIntegrity(after);
    const i2 = validateLedgerIntegrity(after);
    results.l_validate_pure = JSON.stringify(i1) === JSON.stringify(i2);
    results.l_retired_counted = i1.retiredInstanceEvents >= 1;
    results.l_no_orphan_field = !("orphanedInstance" in i1);
  }

  /* ── A 账本 (id,generation) 绑定证伪用例（最终版 A 线 P2-08，②实锤
   * 待证伪）：同一播放器实例换源（generation 0→1）后，旧 HLS 实例的
   * 迟到事件以其起源代次 0 到达——现绑定若把 generation 钉死在首记
   * 值，gen1 事件会被记成 gen0（a_bind_gen1_tagged=0）、迟到事件会
   * 被当正常事件入账（a_bind_late_rejected=true、droppedLate 不增）。
   * 期望：gen1 事件记 gen1；迟到 gen0 在代次已推进后被拒收＋计数；
   * 代次未推进时的同代迟到仍按起源代次入账（对照组）。 ── */
  {
    const before = ledgerSnapshot();
    const b = createLedgerBinding();
    results.a_bind_first_ok = b.record("fina.load", { tag: "gen0" }, 0);
    results.a_bind_advance_ok = b.record("fina.load", { tag: "gen1" }, 1);
    results.a_bind_late_rejected = b.record("fina.late_hls", { tag: "late-gen0" }, 0);
    const after = ledgerSnapshot();
    const evs = after.events.filter(e => e.name.startsWith("fina."));
    const gen1 = evs.find(e => e.name === "fina.load" && (e.data as { tag?: string } | undefined)?.tag === "gen1");
    results.a_bind_gen1_tagged = gen1 ? (gen1.data as { generation?: number }).generation ?? "missing" : "missing";
    results.a_bind_late_not_in_window = !evs.some(e => e.name === "fina.late_hls");
    results.a_bind_dropped_late_delta = after.droppedLate - before.droppedLate;
    b.dispose();
    const b2 = createLedgerBinding();
    b2.record("fina.early", { tag: "a" }, 0);
    results.a_bind_early_late_ok = b2.record("fina.early_late", { tag: "b" }, 0);
    const after2 = ledgerSnapshot();
    const earlyLate = after2.events.find(e => e.name === "fina.early_late");
    results.a_bind_early_late_gen = earlyLate ? (earlyLate.data as { generation?: number }).generation ?? "missing" : "missing";
    b2.dispose();
  }

  /* ── W 接线级矩阵（fix2 B1）：createStallWatchdog 的真实升级链——
   * 判死→重建→再判死→会话降级→名额用尽报错，及三道门控（旧实例 /
   * 无意愿 / paused_by_user）与谓词救场。F6 测的是看门狗类本身与
   * 模拟 policy；这里测的是两处播放入口共用的那份真实接线。 ── */
  {
    resetNativeFallbackForTests();
    const fakeVideo = (bufferedLen = 0) => ({
      buffered: { length: bufferedLen, end: () => 5 },
      paused: true, readyState: 0,
    }) as unknown as HTMLVideoElement;
    const harness = (over: { wanted?: boolean; current?: boolean; pause?: "playing" | "paused_by_user" | "paused_by_system"; bufferedLen?: number; attempt?: number } = {}) => {
      const clock = new FakeClock();
      const calls = { retry: [] as string[], exhausted: [] as string[], traced: [] as { state: string; attempt: number }[], gated: [] as { gate: string; state: string }[] };
      const attemptRef = { current: over.attempt ?? 0 };
      const wd = createStallWatchdog({
        video: fakeVideo(over.bufferedLen ?? 0),
        isCurrent: () => over.current !== false,
        isPlayWanted: () => over.wanted !== false,
        pauseState: () => over.pause ?? "playing",
        attemptRef,
        traceStall: (state, attempt) => calls.traced.push({ state, attempt }),
        traceGated: (info) => calls.gated.push(info),
        retry: (reason) => calls.retry.push(reason),
        onExhausted: (m) => calls.exhausted.push(m),
        clock, timeoutMs: 4000,
      });
      return { clock, calls, attemptRef, wd };
    };
    /* W1 首次判死 → 原地重建，attempt 递增、取证先行 */
    {
      const h = harness();
      h.wd.fragLoaded();
      h.clock.advance(4000);
      results.w1_first_stall_retry = h.calls.retry;
      results.w1_attempt_after = h.attemptRef.current;
      results.w1_traced = h.calls.traced;
      h.wd.dispose();
    }
    /* W2 二次判死（attempt=1）→ 会话降级并走 fallback 重建 */
    {
      resetNativeFallbackForTests();
      const h = harness({ attempt: 1 });
      h.wd.fragLoaded();
      h.clock.advance(4000);
      results.w2_second_stall_retry = h.calls.retry;
      results.w2_fallback_noted = nativeFallbackState() !== null;
      h.wd.dispose();
    }
    /* W3 降级名额已占用 → 不再静默，明确报错且不重建 */
    {
      const h = harness({ attempt: 1 });
      h.wd.fragLoaded();
      h.clock.advance(4000);
      results.w3_exhausted_message = h.calls.exhausted;
      results.w3_no_retry = h.calls.retry;
      h.wd.dispose();
    }
    /* W4 用户已暂停（无意愿）→ 判死不升级：不取证、不重建、不计数 */
    {
      const h = harness({ wanted: false });
      h.wd.fragLoaded();
      h.clock.advance(8000);
      results.w4_paused_no_retry = h.calls.retry;
      results.w4_paused_no_trace = h.calls.traced;
      results.w4_attempt_unchanged = h.attemptRef.current;
      h.wd.dispose();
    }
    /* W5 旧实例判死 → 丢弃（换源后旧 hls 的回调不许动新源）；
     * fix322/play 起丢弃必留痕（stale_instance） */
    {
      const h = harness({ current: false });
      h.wd.fragLoaded();
      h.clock.advance(4000);
      results.w5_stale_no_retry = h.calls.retry;
      results.w5_stale_no_exhausted = h.calls.exhausted;
      results.w5_stale_gated = h.calls.gated;
      h.wd.dispose();
    }
    /* W6 paused_by_user（即使 wanted 读数异常为真）→ 硬门控不升级。
     * 不变量：用户明确暂停后，任何自愈不得重建/自动播放。 */
    {
      const h = harness({ pause: "paused_by_user", wanted: true });
      h.wd.fragLoaded();
      h.clock.advance(8000);
      results.w6_user_pause_no_retry = h.calls.retry;
      results.w6_user_pause_attempt = h.attemptRef.current;
      h.wd.dispose();
    }
    /* W7 paused_by_system（系统挂起后恢复）→ 不挡升级，照常重建 */
    {
      const h = harness({ pause: "paused_by_system" });
      h.wd.fragLoaded();
      h.clock.advance(4000);
      results.w7_system_pause_retry = h.calls.retry;
      h.wd.dispose();
    }
    /* W8 buffered-no-play 第二臂 → 同链升级（buffered 已达但不出画） */
    {
      const h = harness({ bufferedLen: 1 });
      h.wd.fragLoaded();
      h.wd.buffered();
      h.clock.advance(4000);
      results.w8_buffered_no_play_retry = h.calls.retry;
      results.w8_buffered_no_play_state = h.calls.traced.map(t => t.state);
      h.wd.dispose();
    }
    /* W9 到点复查谓词救场：事件漏报但 video.buffered 已有 → 不判死 */
    {
      const h = harness({ bufferedLen: 1 });
      h.wd.fragLoaded();
      h.clock.advance(4000);
      /* 同 F5 口径更新：append 窗不升级（原 W9 语义保留于此点），
       * 转交第二臂后 buffered-no-play 照常升级（W8 同链）。 */
      results.w9_predicate_rescue = [...h.calls.retry];
      h.clock.advance(4000);
      results.w9_handoff_retry = [...h.calls.retry];
      h.wd.dispose();
    }
    /* W10 paused_by_user 门吞判死必留痕（fix322/play）：行为同 W6
     * （不升级、不计数），但账本必须看得见被吞的判定与门名——旧码
     * gated 恒空、本例必红 */
    {
      const h = harness({ pause: "paused_by_user", wanted: true });
      h.wd.fragLoaded();
      h.clock.advance(8000);
      results.w10_user_pause_gated = h.calls.gated;
      results.w10_user_pause_no_retry = h.calls.retry;
      results.w10_user_pause_attempt = h.attemptRef.current;
      h.wd.dispose();
    }
    /* W11 构造期意愿门挂起留痕（fix322/play）：wanted=false 时判死
     * 在看门狗内即被挂起（不到达 onStall 三道门），经
     * watchdog_intent 报出——W4 的无声挂起自此有账 */
    {
      const h = harness({ wanted: false });
      h.wd.fragLoaded();
      h.clock.advance(8000);
      results.w11_unwanted_gated = h.calls.gated;
      h.wd.dispose();
    }
    resetNativeFallbackForTests();
  }

  /* ── FB 两臂等价（最终版 B 线任务 2，先证伪）：append 臂与出画臂走
   * 同一脚本「意愿门拦下 → 挂起不退役 → 意愿恢复 resume → 再卡死判死」，
   * 结局元组（门内判死数／挂起态／恢复后判死数／总判死数）必须一致；
   * 任一臂分歧即由此钉住。整改 P1-9 已修 append 臂意愿门，本例为
   * 两臂同脚本对照（B10/F12 此前是各臂单独测，无同脚本等价断言）。 ── */
  {
    const drive = (arm: "append" | "play") => {
      const clock = new FakeClock();
      let stalls = 0;
      let wanted = false;
      const wd = new AppendStallWatchdog({
        clock, timeoutMs: 4000,
        hasBuffered: () => arm === "play",
        isPlaying: () => false,
        shouldEscalate: () => wanted,
        onStall: () => stalls++,
      });
      wd.fragLoaded();
      if (arm === "play") wd.buffered();
      clock.advance(4000); // 意愿门拦下
      const gatedStalls = stalls;
      const suspended = wd.isSuspended;
      wanted = true;
      wd.resume(); // 意愿恢复：重新布防
      clock.advance(3999);
      const beforeDeadline = stalls;
      clock.advance(1); // 再卡死 → 必须判死
      const out = { gatedStalls, suspended, beforeDeadline, afterResume: stalls };
      wd.dispose();
      return out;
    };
    results.fb_append_arm = drive("append");
    results.fb_play_arm = drive("play");
    results.fb_arms_equivalent = JSON.stringify(results.fb_append_arm) === JSON.stringify(results.fb_play_arm);
  }

  /* ── HP 松手剖面（最终版 B 线任务 3）：createHoldReleaseProfiler 以
   * 注入时刻模拟 SR 接管时序——release→srAttempt→firstFrame→srPresent
   * 四点齐后立即落一行 hold.release_profile，分段 ms 必须与注入差值
   * 一致；无 SR 场景尾窗 flush 后落行且 SR 段为 null；无任何帧标记的
   * release 不落行（不制造噪声）。旧 holdJank 无此导出 → missing 先红。 ── */
  {
    const mk = () => {
      const lines: { event: string; data?: Record<string, unknown> }[] = [];
      const timers: { fn: () => void }[] = [];
      const create = (holdJankModule as Record<string, unknown>).createHoldReleaseProfiler as
        | ((trace: (e: string, d?: Record<string, unknown>) => void, opts: { setTimeoutFn: (fn: () => void) => void }) => {
          release: (t: number) => void; srAttempt: (t: number) => void; srPresent: (t: number) => void; firstFrame: (t: number) => void;
        })
        | undefined;
      if (!create) return { lines, profiler: null, flushTimers: () => {} };
      const profiler = create((event, data) => lines.push({ event, data }), {
        setTimeoutFn: (fn) => { timers.push({ fn }); },
      });
      return { lines, profiler, flushTimers: () => { for (const t of timers.splice(0)) t.fn(); } };
    };
    const a = mk();
    results.hp_profiler_exists = !!a.profiler;
    if (a.profiler) {
      a.profiler.release(1000);
      a.profiler.srAttempt(1012);
      a.profiler.firstFrame(1033);
      results.hp_no_emit_before_sr_present = a.lines.length;
      a.profiler.srPresent(1040);
      results.hp_emit_count = a.lines.length;
      results.hp_event = a.lines[0]?.event ?? null;
      results.hp_segments = a.lines[0]?.data ?? null;
      const b = mk();
      b.profiler!.release(2000);
      b.profiler!.firstFrame(2016);
      results.hp_nosr_no_emit_before_tail = b.lines.length;
      b.flushTimers();
      results.hp_nosr_emit_count = b.lines.length;
      results.hp_nosr_segments = b.lines[0]?.data ?? null;
      const c = mk();
      c.profiler!.release(3000);
      c.flushTimers();
      results.hp_silent_release_dropped = c.lines.length;
    }
  }

  /* ── HP2 松手剖面补字段＋判别力（最终版 B3 线任务 2/3）：同一
   * hold.release_profile 事件必须自带——sr_engaged 显式布尔＋pipeline
   * 名（不许靠 SR 段 null 推断）、rVFC metadata（mediaTime/
   * presentedFrames/expectedDisplayTime）、主线程长任务聚合、Feed/SR
   * 组件生命周期年龄、HLS 实例 ID。全部经 opts 注入假源断言；旧
   * profiler 忽略新 opts、只落旧四段 → 本组必红。 ── */
  {
    type ProfilerV2 = {
      release: (t: number) => void; srAttempt: (t: number) => void; srPresent: (t: number) => void;
      firstFrame: (t: number, meta?: { mediaTime?: number; presentedFrames?: number; expectedDisplayTime?: number }) => void;
    };
    const create = (holdJankModule as Record<string, unknown>).createHoldReleaseProfiler as
      | ((trace: (e: string, d?: Record<string, unknown>) => void, opts: Record<string, unknown>) => ProfilerV2)
      | undefined;
    const mkV2 = (over: Record<string, unknown>) => {
      const lines: { event: string; data?: Record<string, unknown> }[] = [];
      const timers: { fn: () => void }[] = [];
      if (!create) return { lines, profiler: null as ProfilerV2 | null, flushTimers: () => {} };
      const profiler = create((event, data) => lines.push({ event, data }), {
        setTimeoutFn: (fn: () => void) => { timers.push({ fn }); },
        ...over,
      });
      return { lines, profiler, flushTimers: () => { for (const t of timers.splice(0)) t.fn(); } };
    };
    /* 接管场景：webgpu 接管、长任务两条、SR 画布窗口内重挂载、HLS 未重建 */
    let lc = { feedMountedAt: 400 as number | null, srMountedAt: 900 as number | null, srUnmountedAt: null as number | null };
    let hlsId: string | null = "hls-7";
    const a = mkV2({
      context: () => ({ srEngaged: true, pipeline: "webgpu" }),
      startLongtask: (note: (s: number, d: number) => void) => { note(1010, 80); note(1030, 120); return () => {}; },
      lifecycle: () => lc,
      hlsInstanceId: () => hlsId,
    });
    results.hp2_profiler_exists = !!a.profiler;
    if (a.profiler) {
      a.profiler.release(1000);
      lc = { feedMountedAt: 400, srMountedAt: 1050, srUnmountedAt: null }; // 窗口内 SR 重挂载
      a.profiler.srAttempt(1012);
      a.profiler.firstFrame(1033, { mediaTime: 12.5, presentedFrames: 42, expectedDisplayTime: 5000 });
      a.profiler.srPresent(1040);
      results.hp2_engaged_line = a.lines[0]?.data ?? null;
      /* 直通场景：无 SR 接管、无 rVFC metadata（rAF 回落）、长任务不可用 */
      const b = mkV2({
        context: () => ({ srEngaged: false, pipeline: "none" }),
        startLongtask: () => null,
        lifecycle: () => ({ feedMountedAt: 400, srMountedAt: null, srUnmountedAt: null }),
        hlsInstanceId: () => "hls-9",
      });
      b.profiler!.release(2000);
      b.profiler!.firstFrame(2016);
      b.flushTimers();
      results.hp2_bypass_line = b.lines[0]?.data ?? null;
      /* HLS 窗口内重建：release 时 hls-1、落行时 hls-2 → rebuilt=true */
      let hlsC: string | null = "hls-1";
      const c2 = mkV2({
        context: () => ({ srEngaged: true, pipeline: "webgpu" }),
        startLongtask: () => () => {},
        lifecycle: () => ({ feedMountedAt: 0, srMountedAt: 0, srUnmountedAt: null }),
        hlsInstanceId: () => hlsC,
      });
      c2.profiler!.release(3000);
      hlsC = "hls-2";
      c2.profiler!.firstFrame(3010);
      c2.profiler!.srAttempt(3011);
      c2.profiler!.srPresent(3012);
      results.hp2_hls_rebuilt = c2.lines[0]?.data?.hls_rebuilt_during_window ?? null;
      results.hp2_hls_id = c2.lines[0]?.data?.hls_instance_id ?? null;
    }
    /* AGG 判别力聚合器（任务 3）：事件序列 → engaged/bypass 两桶计数；
     * 无 sr_engaged 显式布尔的事件不入桶（不许推断），他类事件忽略。 */
    const agg = (holdJankModule as Record<string, unknown>).summarizeHoldEvents as
      | ((events: { name?: string; event?: string; data?: Record<string, unknown> }[]) => unknown)
      | undefined;
    results.hp2_agg_exists = typeof agg === "function";
    if (agg) {
      /* 断言适配（3.3.0 批诊断标尺线）：聚合改判读尾窗载荷，jank 行
       * 补采样器落行原样的真卡顿载荷，分桶计数口径不变。 */
      const jankPayload = { over33: 5, over50: 3, max_gap_ms: 140, post_over33: 3, post_over50: 2, post_max_gap_ms: 132 };
      results.hp2_agg_counts = agg([
        { name: "hold.release_profile", data: { sr_engaged: true } },
        { name: "hold.jank", data: { sr_engaged: true, ...jankPayload } },
        { name: "hold.jank", data: { sr_engaged: true, ...jankPayload } },
        { event: "hold.release_profile", data: { sr_engaged: false } },
        { name: "hold.jank", data: { sr_engaged: false, ...jankPayload } },
        { name: "hold.jank", data: {} },
        { name: "media.first_frame", data: { sr_engaged: true } },
      ]);
    }
  }

  return results;
}

Object.assign(window, { __engines: run() });

/* ── KA keepAlive 渲染探针（audit6 P1-4 → 整改 B2 三态改版）：真实
 * hook + 真实定时器 + 真实接线语义——Feed 层 paused=true 在两种情形
 * 下都成立，区别只在活动层三态：A：paused_by_user（用户显式暂停）
 * → 1.2s 窗内零 play（pausedPlays）；B：paused_by_system（全屏过渡
 * 的系统打断，正是 keepAlive 要处理的场景）→ 必须续播
 * （resumedPlays ≥3）。旧接线读 Feed.paused 粗信号，B 情形必被拦。 */
import React from "react";
import { createRoot } from "react-dom/client";
import { useFsKeepAlive } from "../src/features/feed/useFsKeepAlive";
{
  const state = { kind: "paused_by_system" as "playing" | "paused_by_user" | "paused_by_system", keyNow: "k1", plays: 0 };
  let trigger: (() => void) | null = null;
  function Probe() {
    const keepAlive = useFsKeepAlive({
      playKey: "k1",
      pauseState: () => state.kind,
      currentPlayKey: () => state.keyNow,
      isVideoPaused: () => true,
      play: () => { state.plays += 1; },
    });
    trigger = keepAlive;
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  void (async () => {
    root.render(<Probe />);
    await sleep(30);
    // A：用户显式暂停 → 六发必须全灭
    state.kind = "paused_by_user";
    (trigger as (() => void) | null)?.();
    await sleep(1400);
    const pausedPlays = state.plays;
    // B：系统打断（Feed.paused 同样为 true）→ 必须续播
    state.kind = "paused_by_system";
    state.plays = 0;
    (trigger as (() => void) | null)?.();
    await sleep(1400);
    Object.assign(window, { __keepAlive: { pausedPlays, resumedPlays: state.plays } });
    root.unmount();
  })();
}

/* ── B7 useProxyPlaybackRecovery retry() 推导探针（整改 B7）：真实
 * hook + 假 video/activity。判别用例：视频被系统暂停（paused=true、
 * readyState≥2）但活状态意愿为想播（isPlayWanted=true、
 * pauseState=paused_by_system）→ retry 快照 playing 必须是 true：
 * 系统暂停不得被推导成「不想播」。旧推导走 !video.paused → false。 ── */
import { useProxyPlaybackRecovery } from "../src/features/playback/useProxyPlaybackRecovery";
import * as playUrlCacheModule from "../src/features/feed/usePlayUrlCache";
import { usePlayUrlCache } from "../src/features/feed/usePlayUrlCache";
import * as stallHealModule from "../src/features/feed/stallHeal";
{
  const state = { want: true, kind: "paused_by_system" as "playing" | "paused_by_user" | "paused_by_system", wantSet: null as boolean | null };
  let retryFn: ((source?: string, playWanted?: boolean) => void) | null = null;
  let resumeFn: (() => { playing: boolean } | null) | null = null;
  const video = document.createElement("video");
  Object.defineProperty(video, "readyState", { value: 2 });
  const videoRef = { current: video as HTMLVideoElement | null };
  const activity = {
    isActive: () => true,
    isPlayWanted: () => state.want,
    play: () => {},
    pause: () => {},
    setPlayWanted: (on: boolean) => { state.wantSet = on; },
    pauseState: () => state.kind,
  };
  function Probe() {
    const rec = useProxyPlaybackRecovery(videoRef, "https://media.example/x.m3u8", activity, () => {});
    retryFn = rec.retry;
    resumeFn = rec.resume as () => { playing: boolean } | null;
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  void (async () => {
    /* 逐例重挂载：同一 hook 实例的 previous 快照优先于推导（契约本身），
     * 不重挂载会掩盖逐例推导结果。 */
    const run = async (n: number) => {
      root.render(<Probe key={n} />);
      await sleep(30);
      retryFn?.("probe");
      return resumeFn?.()?.playing ?? null;
    };
    state.kind = "paused_by_system"; state.want = true;
    const systemWanted = await run(1);
    state.kind = "paused_by_user"; state.want = false;
    const userPaused = await run(2);
    state.kind = "paused_by_system"; state.want = false;
    const systemUnwanted = await run(3);
    Object.assign(window, { __b7: { systemWanted, userPaused, systemUnwanted } });
    root.unmount();
  })();
}

/* ── FIN-B3 恢复期 seek 探针（最终版 B3 线任务 1，裁定条目 4）：
 * 真实 useProxyPlaybackRecovery hook + 假 video（currentTime 背存）。
 * 判别用例：retry 在 80s 落快照 → 恢复进行中用户暂停＋seek 到 130
 * （currentTime=130＋seeking 事件）→ loadedmetadata 触发 restore，
 * 落点必须是 130 不是快照旧值 80，且暂停意愿保持（pause 被调、
 * play 不被调）。对照：无用户 seek 时落点仍为快照 80；二次 seek
 * 以最后一次为准（200）。旧实现 restore 无条件写快照 time → 正向
 * 组必红（落点 80）。 ── */
{
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  void (async () => {
    const out: Record<string, unknown> = {};
    let backing = 0;
    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", {
      get: () => backing,
      set: (v: number) => { backing = v; },
      configurable: true,
    });
    Object.defineProperty(video, "readyState", { value: 4, configurable: true });
    Object.defineProperty(video, "duration", { value: 600, configurable: true });
    Object.defineProperty(video, "paused", { value: true, configurable: true });
    const videoRef = { current: video as HTMLVideoElement | null };
    const calls = { pause: [] as string[], play: 0 };
    const traces: { event: string; data?: Record<string, unknown> }[] = [];
    let want = false;
    const activity = {
      isActive: () => true,
      isPlayWanted: () => want,
      play: () => { calls.play += 1; },
      pause: (source?: string) => { calls.pause.push(source ?? ""); },
      setPlayWanted: (on: boolean) => { want = on; },
      pauseState: () => "paused_by_user" as const,
    };
    let retryFn: ((source?: string, playWanted?: boolean) => void) | null = null;
    let resumeFn: (() => { time: number } | null) | null = null;
    function Probe() {
      const rec = useProxyPlaybackRecovery(videoRef, "https://media.example/x.m3u8", activity, (e, d) => traces.push({ event: e, data: d }));
      retryFn = rec.retry;
      resumeFn = rec.resume as () => { time: number } | null;
      return null;
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    /* 句柄调用收进独立闭包：runCase 内重置=null 的控制流收窄会把
     * 后续 retryFn?.() 判成 never（TS2349），闭包按声明类型读。 */
    const callRetry = () => retryFn?.("probe");
    const callResume = () => resumeFn?.() ?? null;
    const runCase = async (key: number, seeks: number[]) => {
      calls.pause = []; calls.play = 0; traces.length = 0; want = false;
      retryFn = null; resumeFn = null;
      root.render(<Probe key={key} />);
      /* 首挂载含模块编译，固定 sleep 不够：等 hook 句柄就绪再动手 */
      for (let i = 0; i < 100 && !retryFn; i++) await sleep(50);
      await sleep(20);
      backing = 80;
      callRetry();
      for (const t of seeks) {
        backing = t;
        video.dispatchEvent(new Event("seeking"));
      }
      const snapshotTime = callResume()?.time ?? null;
      video.dispatchEvent(new Event("loadedmetadata"));
      await sleep(20);
      const restored = traces.filter(t => t.event === "proxy.restored").map(t => t.data?.time ?? null);
      return { snapshotTime, landed: backing, restored, pauses: [...calls.pause], plays: calls.play };
    };
    out.case_seek = await runCase(1, [130]);
    out.case_control = await runCase(2, []);
    out.case_reseek = await runCase(3, [130, 200]);
    Object.assign(window, { __finB3: out });
    root.unmount();
  })();
}

/* ── B1 播放 URL 缓存真实 hook 探针（整改 B1）：当前条目播放中 →
 * lineEpoch 自增 → 当前条目 URL 必须在新作用域键下仍可取（迁移、
 * 不卸载），其余条目照旧整表失效；自愈 skip 集内的条目不迁移
 * （强制重解析）；clearKey 必须两表都删（旧实现 main 删除成功
 * 短路、hevc 残留）。旧 hook 无迁移且 clearKey 短路，本探针必红。 ── */
{
  const entryRef = { current: { id: 42, ep: 2 } };
  const skipRef = { current: new Set<string>() };
  let api: ReturnType<typeof usePlayUrlCache> | null = null;
  function CacheProbe({ epoch }: { epoch: number }) {
    api = usePlayUrlCache("acct", epoch, entryRef, skipRef);
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  void (async () => {
    const waitApi = async () => { for (let i = 0; i < 60 && !api; i++) await sleep(50); return api!; };
    root.render(<CacheProbe epoch={7} />);
    const a = await waitApi();
    a.setUrls(a.keyFor(42, 2), "https://m/main.m3u8", "https://m/hevc.m3u8");
    a.setUrls(a.keyFor(9, 1), "https://m/other.m3u8");
    root.render(<CacheProbe epoch={8} />);
    await sleep(120);
    const migratedMain = api!.getMain(api!.keyFor(42, 2)) ?? null;
    const migratedHevc = api!.getHevc(api!.keyFor(42, 2)) ?? null;
    const otherGone = api!.getMain(api!.keyFor(9, 1)) === undefined;
    // 自愈失效集：当前条目在 skip 集内 → 不迁移、强制重解析
    api!.setUrls(api!.keyFor(42, 2), "https://m/main2.m3u8", "https://m/hevc2.m3u8");
    skipRef.current.add("42:2");
    root.render(<CacheProbe epoch={9} />);
    await sleep(120);
    const skipBlocksMigration = api!.getMain(api!.keyFor(42, 2)) === undefined;
    // clearKey 两表都删
    api!.setUrls(api!.keyFor(5, 1), "https://m/m5.m3u8", "https://m/h5.m3u8");
    api!.clearKey(api!.keyFor(5, 1));
    const clearRemovesBoth = api!.getMain(api!.keyFor(5, 1)) === undefined && api!.getHevc(api!.keyFor(5, 1)) === undefined;
    Object.assign(window, { __b1: { migratedMain, migratedHevc, otherGone, skipBlocksMigration, clearRemovesBoth } });
    root.unmount();
  })();
}

/* ── B17-1 探针等待对齐＋接管探针（整改 B17-1/B17-5）：探针未完成
 * 时挂载的 SrCanvas 处于等待态；随后注入 30 天内有效的持久化全过
 * 结果（gatesPass＋recommendedPath=copy，不重跑探针 runner）→ 该面
 * 必须经 onPipelineChange 报出 engaged=true（接管 WebGPU 路径）。
 * 开关未翻（SR_MODEL_DEFAULT_ENABLED=false）或等待上限只有 ~40s
 * 且无人替挂载面调 runSrProbe 时，engaged 永不为 true（红）。 ── */
{
  const seen: boolean[] = [];
  const video = document.createElement("video");
  const videoRef = { current: video as HTMLVideoElement | null };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  void (async () => {
    root.render(<SrCanvas videoRef={videoRef} mode="natural" onPipelineChange={(v) => { seen.push(v); }} />);
    await sleep(300);
    const waitingBeforeProbe = !seen.includes(true);
    try {
      registerSrProbeV2();
      localStorage.setItem(srProbeCacheKey(), JSON.stringify({ at: new Date().toISOString(), gatesPass: true, recommendedPath: "copy" }));
      await runSrProbe();
    } catch { /* 注册/持久化异常时接管自然失败，结果如实为 false */ }
    const t0 = Date.now();
    while (Date.now() - t0 < 6000 && !seen.includes(true)) await sleep(100);
    Object.assign(window, { __srTakeover: { waitingBeforeProbe, sawEngaged: seen.includes(true), seen: [...seen] } });
    root.unmount();
  })();
}

/* ── FIN-B1 原生暂停意愿写回（最终版 B 线任务 1，GPT P1-02）：真实
 * usePlaybackActivity hook + 真实 <video>（夹具 mp4）。正向：起播后
 * 绕过 activity 直接 video.pause()（模拟 PiP/系统控件原生暂停；能进
 * PiP 时在 PiP 内做）→ isPlayWanted 必须 false、pauseState 必须
 * paused_by_user、automatic play 必须被意愿门拦住不自动播。对照：
 * 页面挂起（active=false）语义不变（wanted 保留、paused_by_system、
 * 回页续播）；activity.pause("proxy_restore") 仍为 paused_by_system；
 * activity.pause("toggle") 仍为 paused_by_user。旧实现无原生 pause
 * 监听：原生暂停后 wanted 恒 true、pauseState 恒 paused_by_system，
 * 正向组必红。 ── */
import { usePlaybackActivity } from "../src/features/playback/usePlaybackActivity";
{
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn: () => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); }
    return fn();
  };
  void (async () => {
    const out: Record<string, unknown> = {};
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    /* 夹具 mp4 仅 1s：不 loop 会在用例中途 ended 抢发 pause 事件、
     * 污染原生暂停的判别时序（runner 环境实测）。 */
    video.loop = true;
    video.src = "/tests/fixtures-media/master320.mp4";
    document.body.appendChild(video);
    const videoRef = { current: video as HTMLVideoElement | null };
    const hlsRef = { current: null };
    let api: ReturnType<typeof usePlaybackActivity> | null = null;
    const traces: string[] = [];
    function Probe({ active, k }: { active: boolean; k: number }) {
      void k;
      api = usePlaybackActivity(videoRef, hlsRef, { active, autoPlay: false, src: "finb", trace: (e, d) => traces.push(d?.source ? `${e}:${String(d.source)}` : d && "ready_state" in d ? `${e}|src=${String(d.current_src)}|rs=${String(d.ready_state)}|w=${String(d.wanted)}` : e) });
      return null;
    }
    let root: ReturnType<typeof createRoot> | null = null;
    const mount = async (active: boolean, k: number) => {
      if (!root) {
        const host = document.createElement("div");
        document.body.appendChild(host);
        root = createRoot(host);
      }
      root.render(<Probe active={active} k={k} />);
      await waitFor(() => api !== null, 2000);
      await sleep(30);
    };
    const unmount = async () => {
      root?.unmount();
      root = null;
      api = null;
      await sleep(60);
    };
    try {
      /* 正向：原生暂停写回 */
      await mount(true, 1);
      api!.play("toggle");
      out.native_started = await waitFor(() => !video.paused && video.readyState >= 2);
      let pip = false;
      try {
        await (video as HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> }).requestPictureInPicture?.();
        pip = document.pictureInPictureElement === video;
      } catch { pip = false; }
      out.native_pip_entered = pip;
      video.pause(); // 原生控件暂停：不经 activity.pause
      /* pause 事件是排队任务，整页夹具主线程竞争下固定等待不可靠：
       * 等写回落定（上限 2s）再取三态快照。 */
      await waitFor(() => api!.isPlayWanted() === false, 2000);
      await sleep(100);
      out.native_wanted = api!.isPlayWanted();
      out.native_state = api!.pauseState();
      out.native_traces = [...traces];
      api!.play("retry_auto", true); // 自愈式 automatic play：必须被意愿门拦住
      await sleep(400);
      out.native_autoplay_blocked = video.paused;
      if (document.pictureInPictureElement) {
        try { await document.exitPictureInPicture(); } catch { /* 忽略 */ }
      }
      await unmount();

      /* 对照 S：页面挂起/回页 */
      await mount(true, 2);
      api!.play("toggle");
      out.suspend_started = await waitFor(() => !video.paused && video.readyState >= 2);
      await mount(false, 2);
      await waitFor(() => video.paused);
      await sleep(150);
      out.suspend_wanted = api!.isPlayWanted();
      out.suspend_state = api!.pauseState();
      await mount(true, 2);
      out.suspend_resumed = await waitFor(() => !video.paused);
      await unmount();

      /* 对照 P：proxy_restore 系统暂停 */
      await mount(true, 3);
      api!.play("toggle");
      await waitFor(() => !video.paused);
      api!.pause("proxy_restore");
      await sleep(150);
      out.proxy_wanted = api!.isPlayWanted();
      out.proxy_state = api!.pauseState();
      await unmount();

      /* 对照 U：我方 toggle 暂停 */
      await mount(true, 4);
      api!.play("toggle");
      await waitFor(() => !video.paused);
      api!.pause("toggle");
      await sleep(150);
      out.own_wanted = api!.isPlayWanted();
      out.own_state = api!.pauseState();
      await unmount();
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e);
      try { (root as ReturnType<typeof createRoot> | null)?.unmount(); } catch { /* 忽略 */ }
    }
    Object.assign(window, { __finB1: out });
  })();
}

/* ── SA seek 仲裁（最终版 B2 线追加，用户实报「拖进度条极易误触」）：
 * 真实 useSeekInput hook + 真实 <input type=range> + 父级 onClick 计数。
 * 契约：拖动过阈值 → onInteraction 恰发一次 scrubstart(drag)、松手恰
 * 发一次 scrubend(drag)；scrubbing 在拖动中为 true、松手后 false；
 * 拖动后紧随的 click 必须被共享层吞掉（父级 click 计数不变），而无
 * 位移的普通点击不许误吞（计数 +1）。旧 hook 无 scrub 相位、无
 * scrubbing 态、无 click 吞咽：phases 恒缺、click 恒穿透，本组必红。 ── */
import { useSeekInput } from "../src/features/playback/useSeekInput";
{
  void (async () => {
    const out: Record<string, unknown> = {};
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    try {
      /* 等最吵的邻居（FIN-B1：反复挂载/卸载根＋真实视频播放）收场后再
       * 起手：其生命周期内的焦点变动会经本 hook 的 onBlur 取消拖动
       * （产品语义），与本探针的时序断言相争属夹具伪影。 */
      for (let i = 0; i < 300 && !(window as unknown as { __finB1?: unknown }).__finB1; i++) await sleep(100);
      const phases: string[] = [];
      const seeks: string[] = [];
      let parentClicks = 0;
      function Probe() {
        const seek = useSeekInput({
          time: 10, duration: 100,
          onSeek: (_t, input) => { seeks.push(input); },
          onInteraction: (phase, input) => { phases.push(`${phase}:${input}`); },
        });
        return (
          <div onClick={() => { parentClicks += 1; }}>
            <span data-scrubbing>{String((seek as { scrubbing?: boolean }).scrubbing)}</span>
            <input aria-label="seekarb" type="range" {...seek.inputProps} style={{ ...seek.inputProps.style, width: 200 }} />
          </div>
        );
      }
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      root.render(<Probe />);
      /* 夹具主线程竞争激烈（同页多个真实定时器探针），渲染落定靠轮询等。 */
      for (let i = 0; i < 100 && !host.querySelector("input"); i++) await sleep(50);
      const input = host.querySelector("input") as HTMLInputElement;
      /* 合成 PointerEvent 的 pointerId 不是活动指针，capture 三件套
       * 打桩为空操作（与真实触摸的差异只在 capture 机制本身）。 */
      input.setPointerCapture = () => {};
      input.releasePointerCapture = () => {};
      input.hasPointerCapture = () => false;
      const rect = input.getBoundingClientRect();
      const nativeEvents: string[] = [];
      for (const t of ["pointercancel", "blur", "lostpointercapture", "focus"]) input.addEventListener(t, () => nativeEvents.push(t));
      out.nativeEvents = nativeEvents;
      /* 合并时序日志（调试＋断言共用）：相位与 scrubbing 文本变化同轴记录。 */
      const timeline: string[] = [];
      out.timeline = timeline;
      const scrubSpan = host.querySelector("[data-scrubbing]");
      if (scrubSpan) new MutationObserver(() => timeline.push(`scrubbing=${scrubSpan.textContent}`)).observe(scrubSpan, { childList: true, characterData: true, subtree: true });
      const fire = (type: string, x: number) => input.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, button: 0, clientX: x }));
      const scrubbingText = () => host.querySelector("[data-scrubbing]")?.textContent ?? null;
      /* 拖动：down → 横移 40px（过 3px moved 阈值）→ up → click。
       * down 后先等相位到达再继续：夹具冷启动时 React 根监听装配与
       * 渲染落定存在竞态，同步连发会把首个事件丢在装配前（实测）。 */
      fire("pointerdown", rect.left + 20);
      for (let i = 0; i < 40 && phases.length < 2; i++) await sleep(50);
      /* scrubbing 是渲染态：pointermove 属非离散事件，状态 flush 时机
       * 不定，靠轮询等它落定（邻居探针已收场，窗口内无抢焦源）。 */
      fire("pointermove", rect.left + 60);
      for (let i = 0; i < 20 && scrubbingText() !== "true"; i++) await sleep(50);
      out.scrubbingDuring = scrubbingText();
      fire("pointerup", rect.left + 60);
      for (let i = 0; i < 20 && scrubbingText() !== "false"; i++) await sleep(50);
      out.scrubbingAfter = scrubbingText();
      input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      out.clicksAfterDrag = parentClicks;
      /* 普通点击（无位移）：down → up → click，不许误吞 */
      fire("pointerdown", rect.left + 30);
      fire("pointerup", rect.left + 30);
      input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      out.clicksAfterTap = parentClicks;
      out.phasesAll = [...phases];
      out.seeksAll = [...seeks];
      out.scrubStarts = phases.filter(p => p === "scrubstart:drag").length;
      out.scrubEnds = phases.filter(p => p === "scrubend:drag").length;
      out.dragSeeks = seeks.filter(s => s === "drag");
      root.unmount();
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e);
    }
    Object.assign(window, { __seekArb: out });
  })();
}

/* ── A 播放内核核心探针（最终版 A 线，①用户点名架构债收敛）：
 * usePlaybackKernel 的纯核心（createPlaybackKernelCore）＋facts 组装
 * （buildPlaybackFacts）经动态 import 观测——基线无此模块时 loaded
 * 为 false（红）。判别点：分片 ingest 的采样身份必须是正在播放的
 * level（1）而非分片下载 level（0）；吞吐满 5 片按线路 origin 回写
 * 中位数；notePlaying 受活动门控；facts 组装字段与 VideoSurface
 * 现行发布口径一致。 ── */
{
  void (async () => {
    const out: Record<string, unknown> = { loaded: false };
    try {
      const kernelSpec = "/src/features/playback/usePlaybackKernel.ts";
      const km = await import(/* @vite-ignore */ kernelSpec);
      out.loaded = typeof km.usePlaybackKernel === "function" && typeof km.createPlaybackKernelCore === "function";
      if (out.loaded) {
        const sent: [string, number][] = [];
        const sampler = createSrDensitySampler();
        const core = km.createPlaybackKernelCore({
          sendThroughput: (o: string, b: number) => sent.push([o, b]),
          ingestDensity: (frag: SrFragSample, level: SrLevelInfo) => sampler.ingest(frag, level),
        });
        core.setLineOrigin("https://line.example");
        const fakeHls = {
          currentLevel: 1,
          levels: [
            { frameRate: 30, videoCodec: "avc1.low", width: 640, height: 360, bitrate: 800_000 },
            { frameRate: 30, videoCodec: "avc1.high", width: 1280, height: 720, bitrate: 2_500_000 },
          ],
        };
        let info: ReturnType<typeof core.ingestFrag> = null;
        for (let i = 0; i < 5; i++) {
          info = core.ingestFrag(fakeHls, { frag: { stats: { loaded: 100_000, loading: { start: 0, end: 100 } }, duration: 4, level: 0 } });
        }
        out.frag_playing_level = info?.playingLevel ?? "missing";
        out.frag_density_codec = sampler.current()?.codec ?? "missing";
        out.throughput_sent = [...sent];
        notePlaybackPlaying(false);
        core.notePlaying(true, () => false);
        out.playing_when_inactive = isPlaybackPlaying();
        core.notePlaying(true, () => true);
        out.playing_when_active = isPlaybackPlaying();
        core.notePlaying(false, () => true);
        out.playing_after_pause = isPlaybackPlaying();
        out.facts = km.buildPlaybackFacts({
          w: 1280, h: 720, density: sampler.current(), srMode: "crisp", engine: "hls.js",
          firstRendition: "第 2/2 档", pipeline: "webgpu", srDemoteCount: 1, at: 123,
        });
      }
    } catch { /* 基线无内核模块：loaded 保持 false */ }
    Object.assign(window, { __finA: out });
  })();
}

/* ── B18 Player 接线用例（模块级观测点）：Player 组件 harness 在本
 * 夹具不可及（需 store/Tauri 全量装配），故以「Player 模块经 vite
 * 转换后的源码文本」为观测点断言生产接线存在：notePlaybackPlaying
 * 必须被 import 且在播放/暂停/结束/卸载四类接线点出现（调用点计数
 * ≥5：onPlay/onPlaying 置 true、onPause/onEnded/卸载 置 false）。
 * 事实源语义本身由 run() 内 b18_fact_* 同步断言。 ── */
{
  void (async () => {
    try {
      const src = await fetch("/src/features/playback/Player.tsx").then(r => r.text());
      const calls = (src.match(/notePlaybackPlaying\(/g) || []).length;
      Object.assign(window, { __b18: { playerWired: src.includes("notePlaybackPlaying"), callSites: calls } });
    } catch {
      Object.assign(window, { __b18: { playerWired: false, callSites: 0 } });
    }
  })();
}
