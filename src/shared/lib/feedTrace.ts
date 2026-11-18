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
const imageStats = {
  displayed: 0,
  failed: 0,
  byReason: {} as Partial<Record<ImageFailReason, number>>,
  inFlightPeak: 0,
};
let imageInFlight = 0;

export function imageStarted(): void {
  imageInFlight++;
  if (imageInFlight > imageStats.inFlightPeak) imageStats.inFlightPeak = imageInFlight;
}
export function imageDisplayed(): void {
  if (imageInFlight > 0) imageInFlight--;
  imageStats.displayed++;
}
export function imageFailed(reason: ImageFailReason): void {
  if (imageInFlight > 0) imageInFlight--;
  imageStats.failed++;
  imageStats.byReason[reason] = (imageStats.byReason[reason] ?? 0) + 1;
}
export function imageRetry(): void {
  if (imageInFlight > 0) imageInFlight--;
}

export type FeedTraceSnapshot = {
  events: FeedTraceEvent[];
  image: typeof imageStats & { inFlight: number };
};

export function feedTraceSnapshot(): FeedTraceSnapshot {
  return {
    events: [...events],
    image: { ...imageStats, byReason: { ...imageStats.byReason }, inFlight: imageInFlight },
  };
}

/** 最近一段分页会话的人话摘要（诊断报告用）：最后一次 page.state
 * 与最后一次失败、已成功加载的页数。无记录时返回 null。 */
export function feedTraceSummary(): {
  loadedPages: number;
  lastState: string | null;
  lastFail: string | null;
} | null {
  if (!events.length) return null;
  let loadedPages = 0;
  let lastState: string | null = null;
  let lastFail: string | null = null;
  for (const e of events) {
    if (e.kind === "page.success") loadedPages = Math.max(loadedPages, Number(e.data.page) || 0);
    if (e.kind === "page.state") lastState = String(e.data.to ?? "");
    if (e.kind === "page.fail") lastFail = `${String(e.data.reason ?? "error")}（第 ${String(e.data.page ?? "?")} 页）`;
  }
  return { loadedPages, lastState, lastFail };
}
