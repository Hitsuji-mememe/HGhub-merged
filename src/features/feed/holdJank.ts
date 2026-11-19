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
  firstFrame: (t: number, meta?: HoldFrameMeta) => void;
};

/* ── 剖面判别力与补字段（最终版 B3 线任务 2/3）──
 * 用户侧没有手动 SR 引擎开关（设置只有自动/关闭），做不了 A/B 实
 * 验——剖面必须自带判别力：sr_engaged 显式布尔＋pipeline 名由管线
 * 切换点（SrCanvas）经总线实时登记，剖面/jank 落行时读取，不许靠
 * SR 段 null 反推。生命周期（Feed 播放面/SR 画布 mount 时刻）与
 * HLS 实例 ID（attach 时登记、单调递增）同走总线，全部只进 trace
 * 账本、零用户可见提示。 */
export type HoldProfileContext = { srEngaged: boolean; pipeline: string };
export type HoldFrameMeta = { mediaTime?: number; presentedFrames?: number; expectedDisplayTime?: number };
export type HoldSurfaceLifecycle = {
  feedMountedAt: number | null; srMountedAt: number | null; srUnmountedAt: number | null;
};

let pipelineState: HoldProfileContext = { srEngaged: false, pipeline: "none" };
export function noteHoldPipelineState(s: HoldProfileContext): void {
  pipelineState = { srEngaged: s.srEngaged, pipeline: s.pipeline };
}
export function getHoldPipelineState(): HoldProfileContext {
  return pipelineState;
}

let surfaceLifecycle: HoldSurfaceLifecycle = { feedMountedAt: null, srMountedAt: null, srUnmountedAt: null };
export function noteHoldSurfaceMount(kind: "feed" | "sr", t: number): void {
  surfaceLifecycle = kind === "feed"
    ? { ...surfaceLifecycle, feedMountedAt: t }
    : { ...surfaceLifecycle, srMountedAt: t };
}
export function noteHoldSurfaceUnmount(kind: "feed" | "sr", t: number): void {
  surfaceLifecycle = kind === "feed"
    ? { ...surfaceLifecycle, feedMountedAt: null }
    : { ...surfaceLifecycle, srUnmountedAt: t };
}
export function getHoldSurfaceLifecycle(): HoldSurfaceLifecycle {
  return surfaceLifecycle;
}

let hlsSeq = 0;
let currentHlsId: string | null = null;
/** HLS attach 时登记新实例 ID（重建即新号），返回该 ID。 */
export function noteHoldHlsAttach(): string {
  hlsSeq += 1;
  currentHlsId = `hls-${hlsSeq}`;
  return currentHlsId;
}
export function getHoldHlsInstanceId(): string | null {
  return currentHlsId;
}

/* 主线程长任务观察（PerformanceObserver 'longtask'）：release 时
 * 启动、落行时断开；条目按 startTime≥t0 归属本窗。不支持的环境
 * 返回 null → 剖面长任务字段如实记 null，不伪造 0。 */
function defaultStartLongtask(note: (startMs: number, durationMs: number) => void): (() => void) | null {
  try {
    if (typeof PerformanceObserver === "undefined") return null;
    const supported = (PerformanceObserver as unknown as { supportedEntryTypes?: readonly string[] }).supportedEntryTypes;
    if (Array.isArray(supported) && !supported.includes("longtask")) return null;
    const po = new PerformanceObserver(list => {
      for (const e of list.getEntries()) note(e.startTime, e.duration);
    });
    po.observe({ type: "longtask", buffered: false });
    return () => { try { po.disconnect(); } catch { /* 已断开 */ } };
  } catch {
    return null;
  }
}

export type HoldReleaseProfilerOpts = {
  tailMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => void;
  context?: () => HoldProfileContext;
  startLongtask?: (note: (startMs: number, durationMs: number) => void) => (() => void) | null;
  lifecycle?: () => HoldSurfaceLifecycle;
  hlsInstanceId?: () => string | null;
};

export function createHoldReleaseProfiler(
  trace: TraceFn,
  opts?: HoldReleaseProfilerOpts,
): HoldReleaseProfiler {
  const tailMs = opts?.tailMs ?? TAIL_MS;
  const schedule = opts?.setTimeoutFn ?? ((fn: () => void, ms: number) => { window.setTimeout(fn, ms); });
  const contextOf = opts?.context ?? getHoldPipelineState;
  const lifecycleOf = opts?.lifecycle ?? getHoldSurfaceLifecycle;
  const hlsIdOf = opts?.hlsInstanceId ?? getHoldHlsInstanceId;
  const startLongtask = opts?.startLongtask ?? defaultStartLongtask;
  let t0: number | null = null;
  let srAttemptAt: number | null = null;
  let srPresentAt: number | null = null;
  let firstFrameAt: number | null = null;
  let frameMeta: HoldFrameMeta | null = null;
  let ctxAtRelease: HoldProfileContext = { srEngaged: false, pipeline: "none" };
  let lcAtRelease: HoldSurfaceLifecycle = { feedMountedAt: null, srMountedAt: null, srUnmountedAt: null };
  let hlsAtRelease: string | null = null;
  let longtask: { count: number; max: number; total: number } | null = null;
  let stopLongtask: (() => void) | null = null;
  let emitted = true;

  const emit = () => {
    if (emitted || t0 === null) return;
    if (firstFrameAt === null && srPresentAt === null) return;
    emitted = true;
    stopLongtask?.();
    stopLongtask = null;
    const lcNow = lifecycleOf();
    const hlsNow = hlsIdOf();
    trace("hold.release_profile", {
      release_to_first_frame_ms: firstFrameAt === null ? null : Math.round(firstFrameAt - t0),
      release_to_sr_attempt_ms: srAttemptAt === null ? null : Math.round(srAttemptAt - t0),
      sr_attempt_to_present_ms: srAttemptAt === null || srPresentAt === null ? null : Math.round(srPresentAt - srAttemptAt),
      release_to_sr_present_ms: srPresentAt === null ? null : Math.round(srPresentAt - t0),
      /* 判别力（B3 任务 3）：接管/直通显式布尔＋管线名，release 时刻快照 */
      sr_engaged: ctxAtRelease.srEngaged,
      pipeline: ctxAtRelease.pipeline,
      /* rVFC metadata（B3 任务 2）：rAF 回落无 metadata → null */
      rvfc_media_time: frameMeta?.mediaTime ?? null,
      rvfc_presented_frames: frameMeta?.presentedFrames ?? null,
      rvfc_expected_display_time: frameMeta?.expectedDisplayTime ?? null,
      /* 主线程长任务（B3 任务 2）：不支持记 null，支持且无任务记 0 */
      longtask_count: longtask === null ? null : longtask.count,
      longtask_max_ms: longtask === null ? null : Math.round(longtask.max),
      longtask_total_ms: longtask === null ? null : Math.round(longtask.total),
      /* 组件生命周期（B3 任务 2）：年龄以 release 为终点，窗口内重挂/卸载另记 */
      feed_surface_age_ms: lcAtRelease.feedMountedAt === null ? null : Math.round(t0 - lcAtRelease.feedMountedAt),
      sr_canvas_age_ms: lcAtRelease.srMountedAt === null ? null : Math.round(t0 - lcAtRelease.srMountedAt),
      sr_canvas_remounted: lcNow.srMountedAt !== null && lcNow.srMountedAt !== lcAtRelease.srMountedAt,
      sr_canvas_unmounted: lcNow.srUnmountedAt !== null && lcNow.srUnmountedAt !== lcAtRelease.srUnmountedAt && lcNow.srUnmountedAt >= t0,
      /* HLS 实例（B3 任务 2）：release 时实例 ID＋窗口内是否重建 */
      hls_instance_id: hlsAtRelease,
      hls_rebuilt_during_window: hlsNow !== hlsAtRelease,
    });
  };
  const maybeEmit = () => {
    /* 四点齐（首帧＋SR 呈现都在）立即落行，不必等尾窗。 */
    if (firstFrameAt !== null && srPresentAt !== null) emit();
  };

  return {
    release(t: number) {
      stopLongtask?.();
      stopLongtask = null;
      t0 = t;
      srAttemptAt = null;
      srPresentAt = null;
      firstFrameAt = null;
      frameMeta = null;
      ctxAtRelease = contextOf();
      lcAtRelease = lifecycleOf();
      hlsAtRelease = hlsIdOf();
      longtask = null;
      /* emitted 必须先复位再启观察器：观察器回调可能在启动调用内
       * 同步触发（buffered/注入源），晚复位会把本窗条目误判为旧窗。 */
      emitted = false;
      const stop = startLongtask((startMs, durationMs) => {
        if (t0 === null || emitted || startMs < t0) return;
        if (longtask === null) longtask = { count: 0, max: 0, total: 0 };
        longtask.count += 1;
        longtask.total += durationMs;
        if (durationMs > longtask.max) longtask.max = durationMs;
      });
      if (stop !== null) {
        stopLongtask = stop;
        if (longtask === null) longtask = { count: 0, max: 0, total: 0 };
      }
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
    firstFrame(t: number, meta?: HoldFrameMeta) {
      if (t0 === null || emitted || firstFrameAt !== null || t < t0) return;
      firstFrameAt = t;
      frameMeta = meta ?? null;
      maybeEmit();
    },
  };
}

/* ── 判别力聚合器（最终版 B3 线任务 3）：诊断事件序列 → 按
 * sr_engaged 显式布尔分桶计数。无显式布尔的事件（旧行/他类）不入
 * 桶——不许靠 SR 段 null 之类侧信号推断。纯函数，真机判读与单测
 * 共用同一口径。 ── */
export type HoldEventSummary = {
  engaged: { holds: number; janks: number };
  bypass: { holds: number; janks: number };
};
export function summarizeHoldEvents(
  events: readonly { name?: string; event?: string; data?: Record<string, unknown> }[],
): HoldEventSummary {
  const out: HoldEventSummary = { engaged: { holds: 0, janks: 0 }, bypass: { holds: 0, janks: 0 } };
  for (const e of events) {
    const name = e.name ?? e.event;
    if (name !== "hold.release_profile" && name !== "hold.jank") continue;
    const engaged = e.data?.sr_engaged;
    if (typeof engaged !== "boolean") continue;
    const bucket = engaged ? out.engaged : out.bypass;
    if (name === "hold.release_profile") bucket.holds += 1;
    else bucket.janks += 1;
  }
  return out;
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

export function createHoldJankSampler(trace: TraceFn, contextOf: () => HoldProfileContext = getHoldPipelineState) {
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
      const ctx = contextOf();
      trace("hold.jank", {
        /* 按下时刻字段改名 pressedAt（整改 C12）：原名 at 会被
         * tracePlayback 注入的 at 覆盖，落盘值不是按下时刻。 */
        pressedAt: new Date(startedWall).toISOString(),
        dur_ms: Math.round(releasedAt - startedAt),
        frames, over33, over50, max_gap_ms: Math.round(max),
        post_frames: postFrames, post_over33: postOver33, post_over50: postOver50,
        post_max_gap_ms: Math.round(postMax),
        /* 判别力（B3 任务 3）：与 hold.release_profile 同口径显式登记 */
        sr_engaged: ctx.srEngaged,
        pipeline: ctx.pipeline,
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
