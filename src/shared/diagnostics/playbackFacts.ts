/* 当前播放源规格的共享读取点（2026-11-18 收官批 D 项）：VideoSurface 在
 * 尺寸/密度/档位变化时发布，诊断报告生成时读取——报告需要「当前集源
 * 规格（分辨率/码率/密度/超分档位）」，而这些原本只活在播放面局部状态里。
 * 只是内存快照，不落盘；从未播放过则为空。 */

export type PlaybackFacts = {
  w: number;
  h: number;
  /** 前 3 个完整分片实际码率的中位数（bps），原生引擎或未取到时缺失。 */
  bitrateBps?: number;
  fps?: number;
  /** 视频编码（manifest level 的 videoCodec，如 avc1…/hvc1…），未知时缺失。 */
  codec?: string;
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

/* 是否有视频正在实际播放（2026-11-18 晚整改 3）：自动选线的健康复检
 * 用它做护栏——播放中不做回切主站这类会打断播放的常规切换；故障类
 * 切换（当前线已死/卡顿自愈）不走这个信号、不受影响。VideoSurface 在
 * playing/pause 与源卸载时更新。 */
let playingNow = false;

export function notePlaybackPlaying(playing: boolean): void {
  playingNow = playing;
}

export function isPlaybackPlaying(): boolean {
  return playingNow;
}

export function readPlaybackFacts(): PlaybackFacts | null {
  return facts;
}
