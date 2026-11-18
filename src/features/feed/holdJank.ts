/* 长按顿感量化采样（Muse 2026-11-19 fix2 A5）：hold 期间以 rAF
 * 测主线程帧间隔分布，结束时经 trace 落一行 hold.jank 汇总进诊断
 * 日志——残余顿感自此有数字（gap>33/50ms 帧数、最大间隔），不再
 * 靠手感。只在 hold 期间运行，每帧仅记时间戳，纯旁路；从 Feed
 * 外移以守 Feed.tsx 行数预算。 */

type TraceFn = (event: string, data?: Record<string, unknown>) => void;

export function createHoldJankSampler(trace: TraceFn) {
  let raf = 0;
  let last = 0;
  let frames = 0;
  let over33 = 0;
  let over50 = 0;
  let max = 0;
  let startedAt = 0;
  let running = false;

  const tick = (now: number) => {
    if (!running) return;
    const gap = now - last;
    last = now;
    frames++;
    if (gap > 33) over33++;
    if (gap > 50) over50++;
    if (gap > max) max = gap;
    raf = requestAnimationFrame(tick);
  };

  return {
    start() {
      if (running) return;
      running = true;
      frames = 0;
      over33 = 0;
      over50 = 0;
      max = 0;
      startedAt = performance.now();
      last = startedAt;
      raf = requestAnimationFrame(tick);
    },
    stop() {
      if (!running) return;
      running = false;
      cancelAnimationFrame(raf);
      if (frames > 5) {
        trace("hold.jank", {
          dur_ms: Math.round(performance.now() - startedAt),
          frames, over33, over50, max_gap_ms: Math.round(max),
        });
      }
    },
  };
}
