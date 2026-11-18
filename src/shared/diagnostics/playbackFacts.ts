/* 当前播放源规格的共享读取点（2026-11-18 收官批 D 项）：VideoSurface 在
 * 尺寸/密度/档位变化时发布，诊断报告生成时读取——报告需要「当前集源
 * 规格（分辨率/码率/密度/超分档位）」，而这些原本只活在播放面局部状态里。
 * 只是内存快照，不落盘；从未播放过则为空。 */

export type PlaybackFacts = {
  w: number;
  h: number;
  /** 首分片实际码率（bps），原生引擎或未取到时缺失。 */
  bitrateBps?: number;
  fps?: number;
  /** 当前生效超分档位（effectiveSrMode 结果）。 */
  srMode: string;
  /** 播放引擎（hls.js / native）。 */
  engine?: string;
  at: number;
};

let facts: PlaybackFacts | null = null;

export function publishPlaybackFacts(next: PlaybackFacts): void {
  facts = next;
}

export function readPlaybackFacts(): PlaybackFacts | null {
  return facts;
}
