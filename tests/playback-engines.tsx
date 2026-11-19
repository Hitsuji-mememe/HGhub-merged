/* 收官批 F/C 逻辑断言夹具（2026-11-18）：以假时钟/假事件序列验证
 * AppendStallWatchdog 三段逻辑（正常出画不触发 / 卡死触发 / 慢网不触发 /
 * 到点复查谓词救场），会话级原生降级对 playbackSource 的作用，以及
 * effectiveSrMode 在模拟源参数下的判档（高密度 1080p→off、低密度
 * 1080p→crisp、720p 低密度→natural 等，含真实采样锚点）。
 * 由 scripts/test-playback-engines.mjs 驱动，结果挂 window.__engines。 */
import { AppendStallWatchdog, type StallClock } from "../src/features/playback/appendStallWatchdog";
import { nativeFallbackState, noteNativeFallback, playbackSource, resetNativeFallbackForTests } from "../src/features/playback/mediaTransport";
import { createStallWatchdog } from "../src/features/playback/stallWatchdogWiring";
import { effectiveSrMode, presentationPipeline, srContentRect, srDemote, srHasConfirmedFrame, srPerfStep, srVideoFilterMode } from "../src/features/playback/SuperResCanvas";
import { createSrDensitySampler } from "../src/features/playback/useSrDensity";
import { evaluateSrGatesV2 } from "../src/shared/diagnostics/gpuProbe";
import { capRecordByFifo, scopedPlayKey, setCapped } from "../src/features/feed/cacheMap";
import { prewarmRetryDue } from "../src/features/feed/prewarm";
import { ABR_DEFAULT_ESTIMATE_BPS, createHlsPlayerConfig, formatFirstRendition, lockHighestStartLevel, resolveAbrSeedBps } from "../src/features/playback/hlsConfig";

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
      const calls = { retry: [] as string[], exhausted: [] as string[], traced: [] as { state: string; attempt: number }[] };
      const attemptRef = { current: over.attempt ?? 0 };
      const wd = createStallWatchdog({
        video: fakeVideo(over.bufferedLen ?? 0),
        isCurrent: () => over.current !== false,
        isPlayWanted: () => over.wanted !== false,
        pauseState: () => over.pause ?? "playing",
        attemptRef,
        traceStall: (state, attempt) => calls.traced.push({ state, attempt }),
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
    /* W5 旧实例判死 → 丢弃（换源后旧 hls 的回调不许动新源） */
    {
      const h = harness({ current: false });
      h.wd.fragLoaded();
      h.clock.advance(4000);
      results.w5_stale_no_retry = h.calls.retry;
      results.w5_stale_no_exhausted = h.calls.exhausted;
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
    resetNativeFallbackForTests();
  }

  return results;
}

Object.assign(window, { __engines: run() });

/* ── KA keepAlive 渲染探针（audit6 P1-4）：真实 hook + 真实定时器 ──
 * A：过渡中用户暂停（paused 翻 true，effect 清定时器＋回调三查）→
 * 1.2s 窗内零 play；B：未暂停 → 过渡打断后仍续播（play 被调用）。 */
import React from "react";
import { createRoot } from "react-dom/client";
import { useFsKeepAlive } from "../src/features/feed/useFsKeepAlive";
{
  const state = { paused: false, pausedNow: false, keyNow: "k1", plays: 0 };
  let trigger: (() => void) | null = null;
  function Probe({ paused }: { paused: boolean }) {
    const keepAlive = useFsKeepAlive({
      paused, playKey: "k1",
      isUserPaused: () => state.pausedNow,
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
    root.render(<Probe paused={false} />);
    await sleep(30);
    trigger?.(); // 进全屏：调度六发（首发在 +50ms）
    await sleep(15);
    state.pausedNow = true; // 用户在首发落地前暂停：六发必须全灭
    root.render(<Probe paused />); // paused 变化 → 清定时器
    await sleep(1400);
    const pausedPlays = state.plays;
    // B：恢复未暂停态，重新调度 → 应续播
    state.pausedNow = false;
    state.plays = 0;
    root.render(<Probe paused={false} />);
    await sleep(30);
    trigger?.();
    await sleep(1400);
    Object.assign(window, { __keepAlive: { pausedPlays, resumedPlays: state.plays } });
    root.unmount();
  })();
}
