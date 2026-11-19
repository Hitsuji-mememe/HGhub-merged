/* ── 真实播放吞吐回写（Muse 2026-11-19 根治包，audit6 P0-B 前端半⑤）──
 * 选线账本此前只有主动探测样本、真实播放分片从未入账（条 7）。这里把
 * VideoSurface 既有的分片统计（每片 loaded/loadMs）聚合后节流回写：
 * 每 5 片 flush 一次（中位数 bps），暂停/结束由 flush() 兜底（调用方在
 * cleanup 调用）。发送失败静默——记账是旁路，不许影响播放。 */
export function createFragThroughputReporter(send: (origin: string, bps: number) => void) {
  let samples: number[] = [];
  let origin = "";
  const reporter = {
    setOrigin(next: string): void {
      if (next === origin) return;
      reporter.flush();
      origin = next;
    },
    push(bytes: number, loadMs: number): void {
      if (!(bytes > 0) || !(loadMs > 0)) return;
      samples.push((bytes * 8) / (loadMs / 1000));
      if (samples.length >= 5) reporter.flush();
    },
    flush(): void {
      if (samples.length && origin) {
        const sorted = [...samples].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        try { send(origin, Math.round(median)); } catch { /* 旁路静默 */ }
      }
      samples = [];
    },
    pending(): number {
      return samples.length;
    },
  };
  return reporter;
}

/** 从播放地址取 origin（账本键）：解析失败返回空串（不回写）。 */
export function originOf(raw: string): string {
  try { return new URL(raw).origin; } catch { return ""; }
}
