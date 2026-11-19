/* 长按顿感量化采样（Muse 2026-11-19 fix2 A5）：hold 期间以 rAF
 * 测主线程帧间隔分布，结束时经 trace 落一行 hold.jank 汇总进诊断
 * 日志——残余顿感自此有数字（gap>33/50ms 帧数、最大间隔），不再
 * 靠手感。只在 hold 期间运行，每帧仅记时间戳，纯旁路；从 Feed
 * 外移以守 Feed.tsx 行数预算。
 *
 * 松手尾窗（Muse 2026-11-19 根治包·飞行记录仪收口，用户点名验收
 * 标准＝松手「无感」）：卡顿感集中在松手恢复 1x 的瞬间，stop() 不
 * 立即停采，续采 600ms 尾窗并分段统计——hold.jank 一行同时给
 * 「期间」与「松手后」两组帧间隔分布，报告侧可直接判读松手帧
 * 成本，不必靠用户复述手感。 */

type TraceFn = (event: string, data?: Record<string, unknown>) => void;

const TAIL_MS = 600;

/* ── 松手剖面（最终版 B 线任务 3，用户点名验收标准＝松手无感）──
 * 真机两份诊断只钉住「ratechange 后约 0.6s 各有 1 次 hold.jank」，
 * 0.6s 内成本落在哪一段（视频首帧呈现／SR 重接管开始／SR 首帧
 * 呈现）旧埋点分不开。本剖面器以松手（倍速退出 ≥2x 域）为零点，
 * 收齐四个时刻后落一行 hold.release_profile 分段 ms；SR 不在场
 * （WebGL 路径/未接管）时等尾窗（与 hold.jank 同 600ms）到期落
 * 行、SR 段为 null；尾窗内连首帧都没有的 release 不落行（视频已
 * 暂停等场景不制造噪声）。时刻由调用方注入，纯逻辑可单测。 */
export type HoldReleaseProfiler = {
  release: (t: number) => void;
  srAttempt: (t: number) => void;
  srPresent: (t: number) => void;
  firstFrame: (t: number) => void;
};

export function createHoldReleaseProfiler(
  trace: TraceFn,
  opts?: { tailMs?: number; setTimeoutFn?: (fn: () => void, ms: number) => void },
): HoldReleaseProfiler {
  const tailMs = opts?.tailMs ?? TAIL_MS;
  const schedule = opts?.setTimeoutFn ?? ((fn: () => void, ms: number) => { window.setTimeout(fn, ms); });
  let t0: number | null = null;
  let srAttemptAt: number | null = null;
  let srPresentAt: number | null = null;
  let firstFrameAt: number | null = null;
  let emitted = true;

  const emit = () => {
    if (emitted || t0 === null) return;
    if (firstFrameAt === null && srPresentAt === null) return;
    emitted = true;
    trace("hold.release_profile", {
      release_to_first_frame_ms: firstFrameAt === null ? null : Math.round(firstFrameAt - t0),
      release_to_sr_attempt_ms: srAttemptAt === null ? null : Math.round(srAttemptAt - t0),
      sr_attempt_to_present_ms: srAttemptAt === null || srPresentAt === null ? null : Math.round(srPresentAt - srAttemptAt),
      release_to_sr_present_ms: srPresentAt === null ? null : Math.round(srPresentAt - t0),
    });
  };
  const maybeEmit = () => {
    /* 四点齐（首帧＋SR 呈现都在）立即落行，不必等尾窗。 */
    if (firstFrameAt !== null && srPresentAt !== null) emit();
  };

  return {
    release(t: number) {
      t0 = t;
      srAttemptAt = null;
      srPresentAt = null;
      firstFrameAt = null;
      emitted = false;
      schedule(emit, tailMs);
    },
    srAttempt(t: number) {
      if (t0 === null || emitted || srAttemptAt !== null || t < t0) return;
      srAttemptAt = t;
      maybeEmit();
    },
    srPresent(t: number) {
      if (t0 === null || emitted || srPresentAt !== null || t < t0) return;
      srPresentAt = t;
      maybeEmit();
    },
    firstFrame(t: number) {
      if (t0 === null || emitted || firstFrameAt !== null || t < t0) return;
      firstFrameAt = t;
      maybeEmit();
    },
  };
}

/* SR 标记总线：Feed 挂载时注册当前剖面器，WebGPU SR 画布每处理/
 * 呈现一帧顺手上报（无剖面窗口时仅为一次空转判断）。WebGL 路径
 * （SuperResCanvas）不在本线所有权内，未接此总线——其参与的会话
 * 剖面行 SR 段为 null，如实呈现。 */
let activeReleaseProfiler: HoldReleaseProfiler | null = null;
export function setActiveHoldReleaseProfiler(p: HoldReleaseProfiler | null): void {
  activeReleaseProfiler = p;
}
export function noteHoldSrAttempt(t: number): void {
  activeReleaseProfiler?.srAttempt(t);
}
export function noteHoldSrPresent(t: number): void {
  activeReleaseProfiler?.srPresent(t);
}

export function createHoldJankSampler(trace: TraceFn) {
  let raf = 0;
  let last = 0;
  let frames = 0;
  let over33 = 0;
  let over50 = 0;
  let max = 0;
  let postFrames = 0;
  let postOver33 = 0;
  let postOver50 = 0;
  let postMax = 0;
  let startedAt = 0;
  let startedWall = 0;
  let releasedAt = 0;
  let phase: "idle" | "hold" | "tail" = "idle";

  const finish = () => {
    phase = "idle";
    if (frames > 5) {
      trace("hold.jank", {
        /* 按下时刻字段改名 pressedAt（整改 C12）：原名 at 会被
         * tracePlayback 注入的 at 覆盖，落盘值不是按下时刻。 */
        pressedAt: new Date(startedWall).toISOString(),
        dur_ms: Math.round(releasedAt - startedAt),
        frames, over33, over50, max_gap_ms: Math.round(max),
        post_frames: postFrames, post_over33: postOver33, post_over50: postOver50,
        post_max_gap_ms: Math.round(postMax),
      });
    }
  };

  const tick = (now: number) => {
    if (phase === "idle") return;
    const gap = now - last;
    last = now;
    if (phase === "hold") {
      frames++;
      if (gap > 33) over33++;
      if (gap > 50) over50++;
      if (gap > max) max = gap;
    } else {
      postFrames++;
      if (gap > 33) postOver33++;
      if (gap > 50) postOver50++;
      if (gap > postMax) postMax = gap;
      if (now - releasedAt >= TAIL_MS) { finish(); return; }
    }
    raf = requestAnimationFrame(tick);
  };

  return {
    start() {
      if (phase === "hold") return;
      /* 尾窗期间再次按下（整改 C12）：旧实现直接清零上一段数据、
       * 不落账——先 finish 落账再开新段。 */
      if (phase === "tail") finish();
      phase = "hold";
      frames = 0;
      over33 = 0;
      over50 = 0;
      max = 0;
      postFrames = 0;
      postOver33 = 0;
      postOver50 = 0;
      postMax = 0;
      startedAt = performance.now();
      startedWall = Date.now();
      last = startedAt;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    },
    stop() {
      if (phase !== "hold") return;
      phase = "tail";
      releasedAt = performance.now();
    },
  };
}
