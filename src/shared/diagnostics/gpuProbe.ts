/**
 * 超分检证探针调度（Muse 2026-11-19 整改 C10：v1 四层探针退役）。
 *
 * v1（probeLayers：API/设备/计算/视频四层，其中视频层用自构造
 * canvas.captureStream 喂临时 video）已删除——其视频层在真机恒
 * 超时假警报、测的不是 SR 纹理摄入能力，与 v2 结论同报告打架。
 * 现只保留 v2（srProbe：真实 MP4＋rVFC 真帧，见文件后半）。
 *
 * 调度解耦：scheduleGpuProbe 保持导出名与签名不变（main.tsx 与
 * tv/bootstrap 都调它），内部只调度 v2（runSrProbe），不再等 v1。
 * 时机：启动后 requestIdleCallback（兜底 setTimeout 2.5s），幂等。
 *
 * v2 访问器稳定性（跨线契约）：getSrProbeResult / runSrProbe /
 * registerSrProbe / formatSrProbeLines / evaluateSrGatesV2 的名字、
 * 返回形状与语义不变——features/playback 的已挂载面补接管依赖它们。
 * 持久化判读（C10）：读到存有原始指标的条目时重跑
 * evaluateSrGatesV2 判读、不直接信存下的 gatesPass；存量只有
 * gatesPass 的旧条目按过期处理（返回 null、走新测）。
 */

import { record } from "./eventLedger";

let scheduled = false;

/**
 * 会话级自动调度（幂等）：启动路径调用一次即可，实际执行推迟到
 * 浏览器空闲（requestIdleCallback，超时 5s 兜底）或 2.5s 后，
 * 不阻塞启动与起播。重复调用无副作用。只调度 v2。
 */
export function scheduleGpuProbe(): void {
  if (scheduled) return;
  scheduled = true;
  const start = () => {
    void runSrProbe();
  };
  try {
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (typeof ric === "function") {
      ric(start, { timeout: 5000 });
      return;
    }
  } catch { /* 落到 setTimeout 兜底 */ }
  setTimeout(start, 2500);
}

/* ── 探针 v2（fix2 超分换代检证，2026-11-19）────────────────────────
 * v1 只答「API 在不在」；v2 用内置固定本地 MP4（720p/1080p、H.264、
 * 各 60 帧）＋ requestVideoFrameCallback 真帧到达后，实测两条纹理
 * 摄入路径与 Anime4K 全链单帧成本——这是超分换代的检证依据。
 * 实现位于 features/playback/srProbe.ts（引擎在 features 层），经
 * registerSrProbe 注册进来：shared 不反向依赖 features（仓库分层）。
 * 未注册（如 TV 版）时 v2 节如实记「未注册」。 */
export type SrProbeResult = {
  at: string;
  /** 结果来源（audit6 P0-A 第 3 层持久化）：persisted＝localStorage 命中、
   * fresh＝本次新测；内存缓存直读时缺失。 */
  source?: "persisted" | "fresh";
  /** 持久化命中时的年龄（天，1 位小数）。 */
  ageDays?: number;
  /** 720p 探针视频真实帧到达（rVFC presentedFrames）。 */
  presented720: number;
  frames720Ok: boolean;
  external: { ok: boolean; msAvg: number | null; msP90: number | null; processed: number; dropped: number };
  copy: { ok: boolean; msAvg: number | null; msP90: number | null; processed: number; dropped: number };
  chain720: { ok: boolean; msAvg: number | null; msP90: number | null; withinBudget: boolean };
  chain1080: { ok: boolean; msAvg: number | null; msP90: number | null };
  deviceLost: number;
  recommendedPath: "external" | "copy" | null;
  /** 门禁 v2（audit6 P0-A 第 3 层）：见 evaluateSrGatesV2。 */
  gatesPass: boolean;
  /** 720p 全链掉帧率（dropped/(processed+dropped)），门禁输入。 */
  droppedRate720?: number;
  /** 尾 1/3 段 avg ÷ 首段 avg（热衰减代理），门禁输入。 */
  tailRatio720?: number | null;
};

/** 门禁 v2（Muse 2026-11-19 根治包，audit6 P0-A 第 3 层）：全部满足才过——
 * 720p avg<33.3 且 P90<33.3；1080p avg<25 且 P90<33.3；deviceLost==0；
 * bench 掉帧率<5%；尾段 avg ≤ 首段×1.2。旧门只看 720p avg 一项。 */
export function evaluateSrGatesV2(r: {
  recommendedPath: "external" | "copy" | null;
  chain720: { ok: boolean; msAvg: number | null; msP90: number | null };
  chain1080: { ok: boolean; msAvg: number | null; msP90: number | null };
  deviceLost: number;
  droppedRate720?: number;
  tailRatio720?: number | null;
}): boolean {
  if (!r.recommendedPath) return false;
  if (!r.chain720.ok || r.chain720.msAvg == null || r.chain720.msP90 == null) return false;
  if (!(r.chain720.msAvg < 33.3 && r.chain720.msP90 < 33.3)) return false;
  if (!r.chain1080.ok || r.chain1080.msAvg == null || r.chain1080.msP90 == null) return false;
  if (!(r.chain1080.msAvg < 25 && r.chain1080.msP90 < 33.3)) return false;
  if (r.deviceLost !== 0) return false;
  if (r.droppedRate720 != null && !(r.droppedRate720 < 0.05)) return false;
  if (r.tailRatio720 != null && !(r.tailRatio720 <= 1.2)) return false;
  return true;
}

/* ── 探针持久化（audit6 P0-A 第 3 层）：结果落 localStorage，键＝设备
 * 型号×iOS 版本×引擎版本；成功命中且 <30 天直接用，禁止每次启动
 * 重跑；失败条目短 TTL 1 天且新测失败不落盘（fin-e，见下方常量）。
 * 设备型号/iOS 版本只取 UA 可得的粗粒度标识（探针键用途，非指纹上报，
 * 不出本机）。引擎版本由 features 注册时注入（shared 不反向依赖）。 */
let srEngineVersion = 0;
export function srProbeCacheKey(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const model = /iPhone|iPad|iPod|Android|Macintosh|Windows/.exec(ua)?.[0] ?? "unknown";
  const osVer = /OS (\d+_\d+)|Android (\d+)|Mac OS X (\d+_\d+)/.exec(ua)?.slice(1).find(Boolean) ?? "?";
  return `hghubx_sr_probe_v1:${model}:${osVer}:e${srEngineVersion}`;
}
const SR_PROBE_MAX_AGE_MS = 30 * 24 * 3600_000;
/* 失败短 TTL（Muse 2026-11-19 最终版 E 线，来源①用户点名 SR 打磨）：
 * 成功结果维持 30 天；失败结果只认 1 天——旧实现失败也吃满 30 天，
 * 一次临时失败（冷启动/驱动抖动）会把超分探针挡住近一个月。且新测
 * 失败不落盘（见 persistSrProbe），重进直接重探；本短 TTL 只兜底
 * 历史版本已落盘的失败条目。 */
export const SR_PROBE_FAILURE_MAX_AGE_MS = 24 * 3600_000;
/** 探针失败判据：门禁不过或无可用摄入路径。读回时以重判后的
 * gatesPass 为准（见 readPersistedSrProbe），不信存量布尔。 */
export function srProbeIsFailure(r: { gatesPass: boolean; recommendedPath: "external" | "copy" | null }): boolean {
  return !r.gatesPass || r.recommendedPath == null;
}
export function readPersistedSrProbe(): SrProbeResult | null {
  try {
    const raw = localStorage.getItem(srProbeCacheKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SrProbeResult;
    const at = Date.parse(parsed.at);
    if (!Number.isFinite(at)) return null;
    const age = Date.now() - at;
    /* 持久化重判（整改 C10）：存有原始指标时重跑门禁判读，不直接
     * 信存下的 gatesPass（门禁口径升级后旧结论可能已不成立）；存量
     * 只有 gatesPass、没有原始指标的旧条目按过期处理。 */
    const hasRawMetrics = typeof parsed.deviceLost === "number"
      && parsed.chain720 != null && parsed.chain1080 != null
      && parsed.external != null && parsed.copy != null
      && "recommendedPath" in parsed;
    if (!hasRawMetrics) return null;
    const gatesPass = evaluateSrGatesV2(parsed);
    const maxAge = srProbeIsFailure({ gatesPass, recommendedPath: parsed.recommendedPath }) ? SR_PROBE_FAILURE_MAX_AGE_MS : SR_PROBE_MAX_AGE_MS;
    if (age < 0 || age >= maxAge) return null;
    return { ...parsed, gatesPass, source: "persisted", ageDays: Math.round((age / 86400_000) * 10) / 10 };
  } catch { return null; }
}
function persistSrProbe(result: SrProbeResult): void {
  /* 失败不落盘（fin-e）：落盘只配成功结果；失败当场返回后下次启动
   * 无条目可命中、直接重探，不被旧失败挡住。 */
  if (srProbeIsFailure(result)) return;
  try { localStorage.setItem(srProbeCacheKey(), JSON.stringify(result)); } catch { /* 存储不可用则下次重跑 */ }
}

type SrProbeRunner = () => Promise<SrProbeResult>;
let srProbeRunner: SrProbeRunner | null = null;
let srProbeCached: SrProbeResult | null = null;
let srProbeInflight: Promise<SrProbeResult | null> | null = null;

export function registerSrProbe(runner: SrProbeRunner, engineVersion = 0): void {
  srProbeRunner = runner;
  srEngineVersion = engineVersion;
}

export function getSrProbeResult(): SrProbeResult | null {
  return srProbeCached;
}

/** 跑 v2（幂等、永不 reject）。持久化命中（成功 <30 天／失败 <1 天，
 * 读时重判门禁，见 readPersistedSrProbe）直接用，不重跑——探针是
 * 分钟级开销，不许每次启动付一遍；失败条目过期即重探。 */
export function runSrProbe(): Promise<SrProbeResult | null> {
  if (srProbeCached) return Promise.resolve(srProbeCached);
  if (!srProbeRunner) return Promise.resolve(null);
  const persisted = readPersistedSrProbe();
  if (persisted) {
    srProbeCached = persisted;
    return Promise.resolve(persisted);
  }
  if (srProbeInflight) return srProbeInflight;
  const runner = srProbeRunner;
  srProbeInflight = (async () => {
    try {
      const fresh = await runner();
      const result: SrProbeResult = { ...fresh, source: "fresh" };
      srProbeCached = result;
      persistSrProbe(result);
      try {
        record("gpu.probe_v2", {
          path: result.recommendedPath,
          chain720_ms: result.chain720.msAvg,
          chain1080_ms: result.chain1080.msAvg,
          gates: result.gatesPass,
          lost: result.deviceLost,
        });
      } catch { /* 记账旁路 */ }
      return result;
    } catch {
      return null;
    }
  })();
  return srProbeInflight;
}

/* ── 生产期统计（Muse 2026-11-19 最终版 E2 线，来源②：GPT 后续复审
 * 条目 1，主代理亲核属实）──────────────────────────────────────────
 * 此前引擎 getStats() 全仓只有探针（srProbe benchPath）在调，生产循环
 * WebGpuSrCanvas 从不发布——报告里的丢帧率/P90 只有探针数字，生产期
 * 无独立证据。现生产侧经 createSrProductionPublisher 周期发布：默认
 * 30s 一次、降级级变化立即发布（轨迹留痕），快照带 phase:"production"，
 * 与探针结果在报告中分节呈现、不混算。发布器只做节流＋汇总，调用方
 * 逐帧 tick 也不会逐帧写任何账本/存储。 */
export type SrProductionStats = {
  phase: "production";
  /** 发布时刻（ISO）。 */
  at: string;
  frames: number;
  droppedStale: number;
  /** droppedStale / (frames + droppedStale)，无帧时 0。 */
  droppedRate: number;
  costAvgMs: number;
  costP90Ms: number;
  path: string | null;
  degrade: 0 | 1 | 2;
  /** 本会话内降级级变化轨迹（含起始级，去重连续重复，上限 16）。 */
  degradeTrail: (0 | 1 | 2)[];
  mode: string | null;
};

export function srDroppedRate(frames: number, dropped: number): number {
  const denom = frames + dropped;
  return denom > 0 ? dropped / denom : 0;
}

/** P90 口径与引擎 getStats 一致：升序后取 floor(n×0.9) 位（封顶末位）。 */
export function srCostP90(costs: number[]): number {
  if (!costs.length) return 0;
  const sorted = [...costs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
}

export function srCostAvg(costs: number[]): number {
  if (!costs.length) return 0;
  return costs.reduce((a, b) => a + b, 0) / costs.length;
}

export type SrProductionInput = {
  frames: number;
  droppedStale: number;
  /** 原始成本窗（夹具/测试用）；与 costAvgMs/costP90Ms 二选一，优先 costs。 */
  costs?: number[];
  costAvgMs?: number;
  costP90Ms?: number;
  degrade: 0 | 1 | 2;
  path: string | null;
  mode: string | null;
};

let srProductionLatest: SrProductionStats | null = null;

export function getSrProductionStats(): SrProductionStats | null {
  return srProductionLatest;
}

/** 生产统计发布器（每 WebGpuSrCanvas 挂载一个实例）：consider() 每次
 * 调用只做廉价节流判定——首次必发、距上次发布 ≥intervalMs 才发、
 * degrade 变化立即发（force 可强制，如卸载收尾）。发布即写入模块级
 * 最新快照供诊断报告读取。nowMs 由调用方注入（performance.now 口径），
 * 夹具以假时钟驱动。 */
export function createSrProductionPublisher(opts?: { intervalMs?: number }): {
  consider: (input: SrProductionInput, nowMs: number, force?: boolean) => SrProductionStats | null;
} {
  const intervalMs = opts?.intervalMs ?? 30_000;
  let lastPublishedAt: number | null = null;
  let lastDegrade: 0 | 1 | 2 | null = null;
  const trail: (0 | 1 | 2)[] = [];
  return {
    consider(input, nowMs, force = false) {
      if (trail[trail.length - 1] !== input.degrade) trail.push(input.degrade);
      const degradeChanged = lastDegrade !== null && input.degrade !== lastDegrade;
      lastDegrade = input.degrade;
      const due = force || lastPublishedAt === null || degradeChanged || nowMs - lastPublishedAt >= intervalMs;
      if (!due) return null;
      lastPublishedAt = nowMs;
      const round2 = (v: number) => Math.round(v * 100) / 100;
      const snap: SrProductionStats = {
        phase: "production",
        at: new Date(nowMs).toISOString(),
        frames: input.frames,
        droppedStale: input.droppedStale,
        droppedRate: srDroppedRate(input.frames, input.droppedStale),
        costAvgMs: round2(input.costs?.length ? srCostAvg(input.costs) : input.costAvgMs ?? 0),
        costP90Ms: round2(input.costs?.length ? srCostP90(input.costs) : input.costP90Ms ?? 0),
        path: input.path,
        degrade: input.degrade,
        degradeTrail: trail.slice(-16),
        mode: input.mode,
      };
      srProductionLatest = snap;
      return snap;
    },
  };
}

export function formatSrProductionLines(s: SrProductionStats | null): string[] {
  if (!s) return ["生产期：暂无（WebGPU 生产管线本会话未运行，或尚未到首个发布周期）"];
  return [
    `生产期（与探针期分开统计）：处理 ${s.frames} 帧 · 过期丢弃 ${s.droppedStale} 帧（丢弃率 ${(s.droppedRate * 100).toFixed(1)}%）`,
    `生产期帧成本：平均 ${s.costAvgMs}ms / P90 ${s.costP90Ms}ms · 摄入路径 ${s.path ?? "未知"} · 呈现档 ${s.mode ?? "未知"}`,
    `生产期降级轨迹：${s.degradeTrail.join(" → ")}（0=全链 2x、1=仅 Restore 1x、2=已停）· 最近发布 ${s.at}`,
  ];
}

export function formatSrProbeLines(result: SrProbeResult | null): string[] {
  if (!srProbeRunner && !result) return ["探针 v2 未注册（本构建无超分检证实现）"];
  if (!result) return ["探针 v2 尚未完成（启动后后台执行）"];
  const ms = (v: number | null) => (v === null ? "—" : `${v}ms`);
  return [
    `结果来源 ${result.source === "persisted" ? `持久化命中（${result.ageDays ?? "?"} 天前）` : result.source === "fresh" ? "本次新测" : "内存缓存"} · 测于 ${result.at}`,
    `720p 真帧到达 ${result.frames720Ok ? "✓" : "✗"}（presentedFrames=${result.presented720}）`,
    `摄入·外部纹理 ${result.external.ok ? "✓" : "✗"} 平均 ${ms(result.external.msAvg)} / P90 ${ms(result.external.msP90)}（处理 ${result.external.processed} 帧、丢弃 ${result.external.dropped}）`,
    `摄入·拷贝 ${result.copy.ok ? "✓" : "✗"} 平均 ${ms(result.copy.msAvg)} / P90 ${ms(result.copy.msP90)}（处理 ${result.copy.processed} 帧、丢弃 ${result.copy.dropped}）`,
    `全链 720p ${result.chain720.ok ? "✓" : "✗"} 平均 ${ms(result.chain720.msAvg)} / P90 ${ms(result.chain720.msP90)}（帧预算 33.3ms：${result.chain720.withinBudget ? "过" : "不过"}）`,
    `全链 1080p ${result.chain1080.ok ? "✓" : "✗"} 平均 ${ms(result.chain1080.msAvg)} / P90 ${ms(result.chain1080.msP90)}（门禁 avg<25 且 P90<33.3）`,
    `720p 掉帧率 ${result.droppedRate720 != null ? `${(result.droppedRate720 * 100).toFixed(1)}%` : "—"}（门禁 <5%） · 尾/首段成本比 ${result.tailRatio720 != null ? result.tailRatio720.toFixed(2) : "—"}（门禁 ≤1.20）`,
    `Device Lost（探针期）${result.deviceLost} 次；建议路径 ${result.recommendedPath ?? "无"}；机器采纳门 v2 ${result.gatesPass ? "过" : "不过"}`,
  ];
}
