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
        at: new Date(startedWall).toISOString(),
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
