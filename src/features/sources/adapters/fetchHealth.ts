/* ── 源取页健康记录（Muse 2026-11-19 根治包·飞行记录仪收口）──
 * 源适配器经 fetchPage 取页此前成败无痕：源在用户网络下到底通不通，
 * 只能靠用户复述。现由注入点（main.tsx 的 setFetchPage 包装层）逐次
 * 埋点：按 host 记最近一次结果（成败/错误类别/耗时/时刻）＋成败计数，
 * 并经 tracePlayback 把每次取页送入统一时间线（source.fetch 事件）。
 * 报告侧经 registryDiag 按注册表 baseUrls 的 host 对齐每源呈现。
 * 纪律：只记 host 与类别，不记完整 URL/查询（仓库不变量 10）；
 * 纯旁路，记录失败不影响取页本身。 */

import { tracePlayback } from "../../../shared/diagnostics/playbackDiagnostics";
import { classifyFetchError, type FetchErrorCategory } from "./fetchErrorClassify.ts";

/* 分类口径唯一出处在 fetchErrorClassify.ts（F7 抽出），此处再导出
 * 保持既有导入面不变。 */
export { classifyFetchError };
export type { FetchErrorCategory };

export type FetchHealthRecord = {
  host: string;
  ok: boolean;
  category: FetchErrorCategory | null;
  ms: number;
  at: number;
  okCount: number;
  failCount: number;
};

const byHost = new Map<string, FetchHealthRecord>();

export function recordFetchResult(url: string, ok: boolean, ms: number, errorRaw?: string): void {
  try {
    const host = new URL(url).host || "?";
    const category = ok ? null : classifyFetchError(errorRaw ?? "");
    const prev = byHost.get(host);
    byHost.set(host, {
      host,
      ok,
      category,
      ms,
      at: Date.now(),
      okCount: (prev?.okCount ?? 0) + (ok ? 1 : 0),
      failCount: (prev?.failCount ?? 0) + (ok ? 0 : 1),
    });
    tracePlayback("source.fetch", { host, ok, category: category ?? "", ms });
  } catch { /* 旁路：记录失败不影响取页 */ }
}

/** 只读快照（按 host 排序），供诊断报告对齐每源呈现。 */
export function fetchHealthSnapshot(): FetchHealthRecord[] {
  return [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host));
}
