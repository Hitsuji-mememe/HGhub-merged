/**
 * FeedRequestTrace（Muse 2026-11-19 fix2 A2/A3）：分页与封面加载的
 * 结构化证据环——分页失效与封面黑占位此前只能靠猜（哨兵没触发？
 * loading 锁没放？请求超时被吞？），本模块把关键事件按序记进有界
 * 内存环，诊断报告直接读最近一段，慢线复现一次即可定性。
 *
 * 纯旁路：记录失败不许影响业务路径（内部全 try/catch 吞掉）；
 * 只记元数据（页码/计数/耗时/状态），不记 URL 全文（只记 host 与
 * 路径哈希），守仓库日志不变量。
 */

export type FeedTraceEvent = {
  ts: number;
  kind: "page.request" | "page.success" | "page.fail" | "page.stale" | "page.state"
    | "sentinel" | "image";
  data: Record<string, unknown>;
};

const MAX_EVENTS = 240;
const events: FeedTraceEvent[] = [];

export function traceFeed(kind: FeedTraceEvent["kind"], data: Record<string, unknown>): void {
  try {
    events.push({ ts: Date.now(), kind, data });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  } catch { /* 旁路：记录失败不影响业务 */ }
}

/** URL 只留 host + 长度指纹，避免直链进日志（仓库不变量 10）。 */
export function urlFingerprint(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}#${url.length}`;
  } catch {
    return `invalid#${url.length}`;
  }
}

/* —— 封面图状态聚合（A3 状态机计数，供诊断报告读） —— */
export type ImageFailReason = "timeout" | "network" | "decode" | "cancelled";
/* 段位（Muse 2026-11-20 fix331/covers-header）：图片失败此前只有
 * 全局计数——3.3.1 真机诊断实锤「封面已显示 159 · 终局失败 45」无
 * 法归属到面（Feed/源列表/图集混算），源列表与图集的失败在报告里
 * 等于不存在。现 Img 可经 surface 标段位，聚合按段位分桶，全局总
 * 数口径不变；未标段位的旧调用归「未标注」。与 gallery-device 线
 * 共用同一 image 事件/聚合口径，不另起格式。 */
export const IMAGE_SURFACE_UNSET = "未标注";
export type ImageSurfaceStats = {
  displayed: number;
  failed: number;
  byReason: Partial<Record<ImageFailReason, number>>;
};
const imageStats = {
  displayed: 0,
  failed: 0,
  byReason: {} as Partial<Record<ImageFailReason, number>>,
  inFlightPeak: 0,
  bySurface: {} as Record<string, ImageSurfaceStats>,
};
let imageInFlight = 0;

function surfaceBucket(surface?: string): ImageSurfaceStats {
  const key = surface || IMAGE_SURFACE_UNSET;
  let b = imageStats.bySurface[key];
  if (!b) {
    b = { displayed: 0, failed: 0, byReason: {} };
    imageStats.bySurface[key] = b;
  }
  return b;
}

export function imageStarted(): void {
  imageInFlight++;
  if (imageInFlight > imageStats.inFlightPeak) imageStats.inFlightPeak = imageInFlight;
}
export function imageDisplayed(surface?: string): void {
  if (imageInFlight > 0) imageInFlight--;
  imageStats.displayed++;
  surfaceBucket(surface).displayed++;
}
export function imageFailed(reason: ImageFailReason, surface?: string): void {
  if (imageInFlight > 0) imageInFlight--;
  imageStats.failed++;
  imageStats.byReason[reason] = (imageStats.byReason[reason] ?? 0) + 1;
  const b = surfaceBucket(surface);
  b.failed++;
  b.byReason[reason] = (b.byReason[reason] ?? 0) + 1;
}
export function imageRetry(): void {
  if (imageInFlight > 0) imageInFlight--;
}

/* —— 逐图终局失败明细（Muse 2026-11-20 fix331/gallery-device） ——
 * 3.3.1 真机诊断实证：聚合计数只有一行（显示/失败/原因），图集会话
 * 在其中零明细——坏在哪张、死在哪段、烧了几次 attempt 全不可见，
 * 定位只能靠用户截图。现保留最近 48 条**终局**失败明细：面（宿主
 * 经 setImageTraceSurface 标注，图集=gallery、源图集列表=source-list、
 * 缺省 app）、host 指纹（urlFingerprint，不记 URL 全文）、段位
 * （error-event＝本地路由/传输给了错误响应；attempt-timeout＝Img 自
 * 己的 20s 时钟先到；decode＝字节到手但解码失败）、终局原因、
 * attempt 总数、总耗时档与末次 attempt 耗时档。判读键：error-event
 * 且耗时档小（<2s 级）≈上游快速拒绝（如防盗链 403 经本地路由回
 * 502）；耗时档大≈上游重试耗尽/传输抖动。深层段位（上游 HTTP 状态
 * 与 error_kind）在 Rust playback_log 的 network.end/proxy.end 里，
 * 两边靠 host 指纹＋时间对齐。纯旁路：记录失败不影响业务。 */
export type ImageFailureStage = "error-event" | "attempt-timeout" | "decode";
export type ImageFailureRecord = {
  ts: number;
  surface: string;
  fp: string;
  stage: ImageFailureStage;
  reason: ImageFailReason;
  attempts: number;
  totalBucket: string;
  lastBucket: string;
};
const MAX_IMAGE_FAILURES = 48;
const imageFailures: ImageFailureRecord[] = [];
let imageSurface = "app";
export function setImageTraceSurface(surface: string): void {
  imageSurface = surface || "app";
}
export function msBucket(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return "<1s";
  if (ms < 5000) return "1-5s";
  if (ms < 20000) return "5-20s";
  if (ms < 60000) return "20-60s";
  return ">60s";
}
export function recordImageFailure(r: {
  fp: string;
  stage: ImageFailureStage;
  reason: ImageFailReason;
  attempts: number;
  totalMs: number;
  lastMs: number;
}): void {
  try {
    imageFailures.push({
      ts: Date.now(),
      surface: imageSurface,
      fp: r.fp,
      stage: r.stage,
      reason: r.reason,
      attempts: r.attempts,
      totalBucket: msBucket(r.totalMs),
      lastBucket: msBucket(r.lastMs),
    });
    if (imageFailures.length > MAX_IMAGE_FAILURES) {
      imageFailures.splice(0, imageFailures.length - MAX_IMAGE_FAILURES);
    }
  } catch { /* 旁路：记录失败不影响业务 */ }
}

export type FeedTraceSnapshot = {
  events: FeedTraceEvent[];
  image: typeof imageStats & { inFlight: number };
  imageFailures: ImageFailureRecord[];
};

export function feedTraceSnapshot(): FeedTraceSnapshot {
  const bySurface: Record<string, ImageSurfaceStats> = {};
  for (const [k, v] of Object.entries(imageStats.bySurface)) {
    bySurface[k] = { displayed: v.displayed, failed: v.failed, byReason: { ...v.byReason } };
  }
  return {
    events: [...events],
    image: { ...imageStats, byReason: { ...imageStats.byReason }, bySurface, inFlight: imageInFlight },
    imageFailures: [...imageFailures],
  };
}

/** 分页会话的人话摘要（诊断报告用），按列表隔离（fix2.1 批三#10）：
 * 旧实现把整个事件环混算成一组 loadedPages/lastState/lastFail——
 * 同会话打开过多个列表时页数取全局 max、终态取全局最后，互相污染
 * 到无法定性。现在按事件的 list 标识（手写分页与 usePaginatedList
 * 都已带；缺失归「未标注」）逐列表汇总，各列表独立给出已加载页数、
 * 终态与最近失败。无分页事件时返回 null。 */
export function feedTraceSummary(): {
  lists: Array<{
    list: string;
    loadedPages: number;
    lastState: string | null;
    lastFail: string | null;
  }>;
} | null {
  const byList = new Map<string, { loadedPages: number; lastState: string | null; lastFail: string | null }>();
  for (const e of events) {
    if (!e.kind.startsWith("page.")) continue;
    const list = typeof e.data.list === "string" && e.data.list ? e.data.list : "未标注";
    let agg = byList.get(list);
    if (!agg) {
      agg = { loadedPages: 0, lastState: null, lastFail: null };
      byList.set(list, agg);
    }
    if (e.kind === "page.success") agg.loadedPages = Math.max(agg.loadedPages, Number(e.data.page) || 0);
    if (e.kind === "page.state") agg.lastState = String(e.data.to ?? "");
    if (e.kind === "page.fail") agg.lastFail = `${String(e.data.reason ?? "error")}（第 ${String(e.data.page ?? "?")} 页）`;
  }
  if (!byList.size) return null;
  return { lists: [...byList.entries()].map(([list, agg]) => ({ list, ...agg })) };
}
