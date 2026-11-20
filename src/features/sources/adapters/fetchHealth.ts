/* ── 源取页健康记录（Muse 2026-11-19 根治包·飞行记录仪收口）──
 * 源适配器经 fetchPage 取页此前成败无痕：源在用户网络下到底通不通，
 * 只能靠用户复述。现由注入点（main.tsx 的 setFetchPage 包装层）逐次
 * 埋点：按 host 记最近一次结果（成败/错误类别/耗时/时刻）＋成败计数，
 * 并经 tracePlayback 把每次取页送入统一时间线（source.fetch 事件）。
 * 报告侧经 registryDiag 按注册表 baseUrls 的 host 对齐每源呈现。
 * 纪律：只记 host、类别与清洗后的失败原文，不记完整 URL/查询（仓库不变量 10）；
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
  /* 最近一次失败的错误原文（Muse 2026-11-20 fix336-a：诊断导出
   * 「逐源最近取页错误」的数据源——此前只落类别，真机五源网络类
   * 全灭时定不了最后一公里，见 fix336 调查任务一的导出缺口）。
   * 落盘前经 sanitizeFetchError 清洗（折叠空白/截断/剥查询串/自有
   * host 脱敏）；从未失败过的 host 为 null。 */
  error: string | null;
};

/* 错误原文落盘清洗（纯函数，契约直测）：错误串可能带完整 URL（含
 * 查询）与代理凭据形态，只留判读所需的失败形态——折叠空白、剥掉
 * http(s) URL 的查询串、自有 host 替换为 [host]、截断 240 字。
 * 凭据脱敏另有 Rust 侧 err_text 链在错误产生处先行处理，此处只做
 * 结构清洗，不冒充凭据防线。 */
export function sanitizeFetchError(raw: string, ownHost: string): string {
  let s = String(raw ?? "").replace(/\s+/g, " ").trim();
  s = s.replace(/https?:\/\/[^\s?#]+(?:\?[^\s]*)?/gi, (m) => m.split("?")[0]);
  if (ownHost && ownHost !== "?") s = s.split(ownHost).join("[host]");
  if (s.length > 240) s = `${s.slice(0, 240)}…`;
  return s;
}

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
      /* 保留最近一次失败的原文：其后成功不冲掉（抖动源正需要看那次
       * 失败长什么样）；呈现侧同行带 ok/计数，读者能分清新旧。 */
      error: ok ? (prev?.error ?? null) : sanitizeFetchError(errorRaw ?? "", host),
    });
    tracePlayback("source.fetch", { host, ok, category: category ?? "", ms });
  } catch { /* 旁路：记录失败不影响取页 */ }
}

/** 只读快照（按 host 排序），供诊断报告对齐每源呈现。 */
export function fetchHealthSnapshot(): FetchHealthRecord[] {
  return [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host));
}
