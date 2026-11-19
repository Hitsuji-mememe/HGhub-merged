/* 当前播放源规格的共享读取点（2026-11-18 收官批 D 项）：VideoSurface 在
 * 尺寸/密度/档位变化时发布，诊断报告生成时读取——报告需要「当前集源
 * 规格（分辨率/码率/密度/超分档位）」，而这些原本只活在播放面局部状态里。
 * 只是内存快照，不落盘；从未播放过则为空。 */

/** 结构化档位事实（Muse 2026-11-19 3.3.0批诊断档位线）：首分片
 * rendition 的结构化形态，与预格式化字符串 firstRendition 并存——
 * 字符串供「超分：」行后缀，结构化字段供报告独立「档位：」行逐要素
 * 判缺失（三要素：档数 total、当前档序号 currentIndex（1 起）、最高档
 * topWidth/topHeight/topBitrate（levels 末位））。要素在会话中无从取得
 * 时整键缺失，由报告层标「未知」；缺失原因可考时记 missingNote（如
 * 原生引擎不可控），不许拿当前档参数冒充最高档。 */
export type PlaybackLevelFacts = {
  total?: number;
  currentIndex?: number;
  topWidth?: number;
  topHeight?: number;
  topBitrate?: number;
  missingNote?: string;
};

export type PlaybackFacts = {
  w: number;
  h: number;
  /** 前 3 个完整分片实际码率的中位数（bps），原生引擎或未取到时缺失。 */
  bitrateBps?: number;
  /** 声明帧率（主列表 FRAME-RATE）；实测回填值不写此字段——报告
   * 的 bpp 复算与帧率行据此区分声明/实测（回填线护栏：fps 字段恒
   * 只承载声明值，回填走 measuredFps）。 */
  fps?: number;
  /** 判档帧率来源（3.3.0批 SR 帧率回填线）：declared＝fps 为声明
   * 值；measured＝声明缺失、判档 crisp 门由 measuredFps 回填支撑。
   * 与 levelFacts 同口径：来源随事实一并发布，供报告判读。 */
  fpsSource?: "declared" | "measured";
  /** rVFC 实测回填帧率（已吸附）：仅 fpsSource==="measured" 时有，
   * 只支撑判档 crisp 门，不参与 bpp 复算/帧预算。 */
  measuredFps?: number;
  /** 实测中值（未吸附），供判读估计偏差；同 measuredFps 生命周期。 */
  measuredRawFps?: number;
  /** 视频编码（manifest level 的 videoCodec，如 avc1…/hvc1…），未知时缺失。 */
  codec?: string;
  /** 当前生效超分档位（effectiveSrMode 结果）。 */
  srMode: string;
  /** 首分片 rendition（audit6 P0-A 第 1 层）：如「第 3/4 档 · 1280x720 ·
   * 4500kbps」；原生路径为实际分辨率＋不可控标注。未知时缺失。 */
  firstRendition?: string;
  /** 结构化档位事实（3.3.0批诊断档位线），与 firstRendition 同采集点
   * 同步登记；旧发布路径只有字符串时缺失，报告层走字符串回落解析。 */
  levelFacts?: PlaybackLevelFacts;
  /** 实际呈现管线（audit6 P0-A 第 2 层）：webgpu / webgl-crisp /
   * webgl-natural / svg-natural / none——与判档分开记，不许混报。 */
  pipeline?: string;
  /** 本源超分降档次数（性能降档阶梯累计）。 */
  srDemoteCount?: number;
  /** 播放引擎（hls.js / native）。 */
  engine?: string;
  /** 密度采样是否仅为暂定值（E 线 useSrDensity 的可选 provisional
   * 字段）：内核消费侧按可选透传，缺失即未标注，不改变既有口径。 */
  provisional?: boolean;
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
