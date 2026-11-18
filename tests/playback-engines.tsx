/* 收官批 F/C 逻辑断言夹具（2026-11-18）：以假时钟/假事件序列验证
 * AppendStallWatchdog 三段逻辑（正常出画不触发 / 卡死触发 / 慢网不触发 /
 * 到点复查谓词救场），会话级原生降级对 playbackSource 的作用，以及
 * effectiveSrMode 在模拟源参数下的判档（高密度 1080p→off、低密度
 * 1080p→crisp、720p 低密度→natural 等，含真实采样锚点）。
 * 由 scripts/test-playback-engines.mjs 驱动，结果挂 window.__engines。 */
import { AppendStallWatchdog, type StallClock } from "../src/features/playback/appendStallWatchdog";
import { nativeFallbackState, noteNativeFallback, playbackSource } from "../src/features/playback/mediaTransport";
import { effectiveSrMode, srContentRect, srDemote, srHasConfirmedFrame, srPerfStep, srVideoFilterMode } from "../src/features/playback/SuperResCanvas";

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
    clock.advance(10000);
    results.f_predicate_rescue = stalls;
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

  return results;
}

Object.assign(window, { __engines: run() });
