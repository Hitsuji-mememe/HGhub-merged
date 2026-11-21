/* ── HLS 播放器共享配置工厂（Muse 2026-11-19 根治包，audit6 P0-A 第 1 层）──
 * VideoSurface（Feed）与 Player（帖子）此前各写一份 Hls 构造，参数逐项
 * 漂移且都没有起播选档策略：hls.js 默认 startLevel=-1 自动、ABR 带宽
 * 估计默认 500kbps 冷启——「画质默认最高档」定版在源流层从未执行，
 * 起播必从低档爬坡。现收敛为一份工厂：
 *  - 起播选档：MANIFEST_PARSED 后、startLoad 前把 startLevel 锁到最高档
 *    （levels 末位）；起播后 ABR 接管调档（lockHighestStartLevel）。
 *  - ABR 播种：abrEwmaDefaultEstimate 用当前线路最近实测吞吐播种，
 *    取不到回退 hls.js 默认 500kbps（resolveAbrSeedBps）。
 *  - 原生引擎路径（AVFoundation）无 rendition 控制 API：此层对原生
 *    明示不可控，只记实际分辨率（见 VideoSurface 的 firstRendition）。
 * 本模块只出纯配置与接线 helper，单测以假 hls/假轮次断言。 */
import type Hls from "hls.js";
import { lastPickRound } from "../../shared/network/autoLine";
import { hostOf } from "../../shared/api/api";

/** hls.js 的 ABR 冷启默认值（bps）：无线路账本可用时回退到它。 */
export const ABR_DEFAULT_ESTIMATE_BPS = 500_000;

/** 从最近一轮选线结果取播种吞吐：当前线路（round.base）对应候选的
 * 实测 kbps（kbps→bps）——旧实现对全部候选取 max，注释自称「当前
 * 线路」却系统性偏高（整改 B11，Hark G1 P2-2/G3 P2-8）。base 对应
 * 候选无实测值返回 null（调用方回退默认）；轮次不带 base/host 的旧
 * 夹具形状才回退全候选 max（兼容既有契约）。 */
export function resolveAbrSeedBps(round: { base?: string; measured: { host?: string; kbps: number | null }[] } | null): number | null {
  if (!round) return null;
  const baseHost = round.base ? hostOf(round.base) : "";
  if (baseHost) {
    const hit = round.measured.find(m => m.host === baseHost && m.kbps != null && m.kbps > 0);
    return hit?.kbps != null ? hit.kbps * 1000 : null;
  }
  let best: number | null = null;
  for (const m of round.measured) {
    if (m.kbps != null && m.kbps > 0) best = best == null ? m.kbps * 1000 : Math.max(best, m.kbps * 1000);
  }
  return best;
}

/** 当前线路的 ABR 播种值（选线账本 tiebreak 的前端可得近似：最近轮次
 * 实测吞吐）。取不到返回 null。 */
export function currentLineSeedBps(): number | null {
  try { return resolveAbrSeedBps(lastPickRound()); } catch { return null; }
}

export function createHlsPlayerConfig(opts: {
  ios: boolean;
  startPosition: number;
  seedBps?: number | null;
  lowLatencyMode?: boolean;
}) {
  return {
    // 禁用从插播/内容引导 JSON 派生直连 URL 的可选功能。
    interstitialsController: undefined,
    contentSteeringController: undefined,
    enableInterstitialPlayback: false,
    // WKWebView 里 hls.js 的 worker 不稳，iOS 关掉
    enableWorker: !opts.ios,
    // Prefer standard MSE on macOS; hls.js handles MMS-only fallback and seek recovery.
    preferManagedMediaSource: false,
    autoStartLoad: false,
    startPosition: opts.startPosition,
    ...(opts.lowLatencyMode !== undefined ? { lowLatencyMode: opts.lowLatencyMode } : {}),
    maxBufferLength: 120,
    maxMaxBufferLength: 240,
    backBufferLength: 30,
    maxBufferHole: 0.5,
    nudgeOffset: 0.25,
    nudgeMaxRetry: 6,
    manifestLoadingTimeOut: 20000,
    /* 清单内部重试只留 1 次（fix3313）：清单级收敛归恢复层有界重试
     * （≤2 次 loadSource）＋起播无进展预算（10s）管辖——旧值 4 与
     * 恢复层相乘成 ≈25 发、分钟级静默转圈（fix3312 定因 §4）。 */
    manifestLoadingMaxRetry: 1,
    fragLoadingTimeOut: 25000,
    fragLoadingMaxRetry: 6,
    fragLoadingRetryDelay: 400,
    /* ABR 播种：有线路实测吞吐时用它替代 500kbps 冷启默认，起播首档
     * 估计不再系统性偏低；startLevel 本身在清单到达后锁定最高档。 */
    abrEwmaDefaultEstimate: opts.seedBps != null && opts.seedBps > 0 ? opts.seedBps : ABR_DEFAULT_ESTIMATE_BPS,
  };
}

/** 清单到达后锁定最高档起播：必须在 startLoad 之前执行（调用方在
 * MANIFEST_PARSED 里先调本函数再 startLoad——本函数只改 startLevel
 * 属性，不订阅事件，保证顺序由调用点控制）。返回锁定的档位序号。 */
export function lockHighestStartLevel(hls: Hls): number {
  const levels = hls.levels;
  if (!levels || levels.length === 0) return -1;
  const top = levels.length - 1;
  try { hls.startLevel = top; } catch { /* 个别版本只读时静默：ABR 播种仍在 */ }
  return top;
}

export type FirstRendition = {
  /** 第 i/N 档（1 起）。 */
  index: number;
  total: number;
  width?: number;
  height?: number;
  bitrate?: number;
  /** 最高档（levels 末位）参数（Muse 2026-11-19 3.3.0批诊断档位线）：
   * 报告「档位：」行的最高档要素来源——此前只记首分片所属档，最高档
   * 分辨率/码率从未被采集，源有几档、最高档是什么在诊断里不可判读。
   * 纯观测附带，不参与任何选档/ABR 决策。 */
  topWidth?: number;
  topHeight?: number;
  topBitrate?: number;
};

export function formatFirstRendition(r: FirstRendition): string {
  const res = r.width && r.height ? ` · ${r.width}x${r.height}` : "";
  const br = r.bitrate ? ` · ${Math.round(r.bitrate / 1000)}kbps` : "";
  return `第 ${r.index}/${r.total} 档${res}${br}`;
}

/** 订阅首分片事件，把「首分片 rendition」报给调用方（只报第一次）。
 * 数据取自 LEVEL_LOADED/FRAG_LOADED 既有事件，不新增请求。 */
export function observeFirstRendition(
  hls: Hls,
  events: { FRAG_LOADED: string },
  onFirst: (r: FirstRendition) => void,
): void {
  let done = false;
  const on = hls.on.bind(hls) as (event: string, cb: (e: unknown, data: { frag: { level: number; type?: string } }) => void) => void;
  on(events.FRAG_LOADED, (_e, data) => {
    if (done) return;
    /* 类型过滤（整改 B13）：音频分片不算首档 rendition。 */
    if (data.frag.type && data.frag.type !== "main") return;
    const levels = hls.levels;
    if (!levels || levels.length === 0) return;
    const level = levels[data.frag.level];
    if (!level) return;
    done = true;
    const top = levels[levels.length - 1];
    onFirst({
      index: data.frag.level + 1,
      total: levels.length,
      width: level.width || undefined,
      height: level.height || undefined,
      bitrate: level.bitrate || undefined,
      topWidth: top?.width || undefined,
      topHeight: top?.height || undefined,
      topBitrate: top?.bitrate || undefined,
    });
  });
}
