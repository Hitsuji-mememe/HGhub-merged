/* ── SR 判档帧率实测回填（Muse 2026-11-19 3.3.0批 SR 帧率回填线）──
 * 背景（调查全文见 fix322/evidence/suspended-items-investigation.md
 * 问题 C）：判档 fps 此前只有一个来源——主播放列表 FRAME-RATE 属性
 * （hls.js level.frameRate）。「单档媒体列表直给」的源（主源典型形态）
 * 没有变体行可写该属性，fps 结构性恒未知、低密度集恒落保守 natural。
 * 本模块以 requestVideoFrameCallback 实测帧率回填：
 *   fps = ΔpresentedFrames / ΔmediaTime
 * presentedFrames 与 mediaTime 都是内容域量：倍速只改墙钟呈现节奏、
 * 不改两者的比值，故估计对播放速率不变；掉帧使 presentedFrames 增量
 * 小于 mediaTime 应呈现帧数，估计只会偏低、不会偏高——吸附与判档都
 * 按这个单向误差设计（见 snapMeasuredFps 的保守吸附）。
 *
 * 消费纪律（护栏，改动前先读 SuperResCanvas.effectiveSrMode 的分离
 * 实现）：回填值只供 crisp 判档门（natural↔crisp 的 fpsKnown 分支）；
 * 关超分门（off）与 SR 帧成本预算只认声明 fps，永不消费本模块的
 * 输出。density 内声明值（fps）与回填值（measuredFps）分开存放、
 * 分开消费，不许合并成一个字段。 */

/** 标准率集合：吸附目标。集合外不设档（120 等高帧率源吸附到 60，
 * 是「宁低勿高」的既定取舍：回填只决定 crisp 门开不开，低估不误开
 * off 门——off 门本就不消费回填值）。 */
export const SR_STANDARD_RATES: readonly number[] = [24, 25, 30, 50, 60];

/** 置信门：累计已呈现帧达到此数才允许定版（调查建议 ≥60）。 */
export const SR_FPS_MIN_PRESENTED = 60;
/** 中值滤波的窗口长度（已呈现帧/窗）：60 帧定版时恰 6 窗取中值。 */
export const SR_FPS_WINDOW_FRAMES = 10;
/** 窗口帧率合理区间：超出即判该窗被 seek/跳变污染，整窗丢弃。 */
const SR_FPS_WINDOW_MIN = 5;
const SR_FPS_WINDOW_MAX = 240;

/** 保守吸附：取不大于实测中值的最大标准率（宁低勿高）。
 * 理由：实测误差单向偏低（掉帧），但判档侧的风险不对称——高估会把
 * 本不该开 crisp 的源误判、低估最多维持 natural 保守档；且帧预算侧
 * 虽不消费回填值，判档口径整体取保守端与既有「fps 未知走保守档」
 * 的整改 4 口径一致。故不用调查初稿的向上吸附。
 * 低于 24 的处理：按未知（返回 undefined），不吸附 24。实测中值
 * <24 意味着内容可能真是低帧率（15/20fps 动画、幻灯片式源），吸附
 * 24 等于无证据地宣称 fpsKnown 并打开 crisp 门，与「宁低勿高」矛
 * 盾；标未知后判档维持 natural 保守档，与声明缺失时的既有行为一
 * 致，不产生新行为面。非有限/非正输入同样按未知。 */
export function snapMeasuredFps(rawMedian: number): number | undefined {
  if (!Number.isFinite(rawMedian) || rawMedian <= 0) return undefined;
  let snapped: number | undefined;
  for (const rate of SR_STANDARD_RATES) {
    if (rate <= rawMedian) snapped = rate;
  }
  return snapped;
}

export function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export type SrFpsEstimate = {
  /** 定版回填值（已吸附）；未定版或定版为未知时缺失。 */
  fps?: number;
  /** 定版时的实测中值（未吸附，供诊断判读估计偏差）。 */
  rawMedian?: number;
  /** 是否已一次性定版（定版后锁定，feed 再喂样本也不改）。 */
  settled: boolean;
};

/** rVFC 实测估计器（纯状态机，可单测）：内核层逐回调喂
 * (presentedFrames, mediaTime)，内部按 SR_FPS_WINDOW_FRAMES 分窗算
 * 窗口帧率、累计满 SR_FPS_MIN_PRESENTED 个已呈现帧后取窗口中值、
 * 吸附定版并锁定。seek/跳变窗（窗口帧率出合理区间）整窗丢弃并以
 * 当前样本重立窗基线，不污染中值。 */
export function createSrFpsEstimator() {
  let sessionBase: { pf: number; mt: number } | null = null;
  let windowBase: { pf: number; mt: number } | null = null;
  let windows: number[] = [];
  let estimate: SrFpsEstimate = { settled: false };
  return {
    feed(presentedFrames: number, mediaTime: number): SrFpsEstimate {
      if (estimate.settled) return estimate;
      if (!Number.isFinite(presentedFrames) || !Number.isFinite(mediaTime)) return estimate;
      if (!sessionBase || !windowBase) {
        sessionBase = { pf: presentedFrames, mt: mediaTime };
        windowBase = { pf: presentedFrames, mt: mediaTime };
        return estimate;
      }
      const dPf = presentedFrames - windowBase.pf;
      const dMt = mediaTime - windowBase.mt;
      if (dPf < 0 || dMt < 0) {
        /* 计数回退（换源未复位/计数器重置）：以当前样本重立基线。 */
        sessionBase = { pf: presentedFrames, mt: mediaTime };
        windowBase = { pf: presentedFrames, mt: mediaTime };
        windows = [];
        return estimate;
      }
      if (dPf < SR_FPS_WINDOW_FRAMES) return estimate;
      if (dMt <= 0) {
        /* mediaTime 不前进（暂停定格后恢复的堆积回调）：丢窗重立。 */
        windowBase = { pf: presentedFrames, mt: mediaTime };
        return estimate;
      }
      const windowFps = dPf / dMt;
      windowBase = { pf: presentedFrames, mt: mediaTime };
      if (windowFps < SR_FPS_WINDOW_MIN || windowFps > SR_FPS_WINDOW_MAX) {
        /* seek/跳变污染窗：mediaTime 跳变使该窗比值失真，整窗丢弃。 */
        return estimate;
      }
      windows = [...windows, windowFps];
      const totalPresented = presentedFrames - sessionBase.pf;
      if (totalPresented >= SR_FPS_MIN_PRESENTED && windows.length >= 3) {
        const rawMedian = medianOf(windows);
        estimate = { fps: snapMeasuredFps(rawMedian), rawMedian, settled: true };
      }
      return estimate;
    },
    current(): SrFpsEstimate {
      return estimate;
    },
    reset(): void {
      sessionBase = null;
      windowBase = null;
      windows = [];
      estimate = { settled: false };
    },
  };
}

export type SrFpsEstimator = ReturnType<typeof createSrFpsEstimator>;
