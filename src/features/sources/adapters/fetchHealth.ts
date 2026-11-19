/* ── 源取页健康记录（Muse 2026-11-19 根治包·飞行记录仪收口）──
 * 源适配器经 fetchPage 取页此前成败无痕：源在用户网络下到底通不通，
 * 只能靠用户复述。现由注入点（main.tsx 的 setFetchPage 包装层）逐次
 * 埋点：按 host 记最近一次结果（成败/错误类别/耗时/时刻）＋成败计数，
 * 并经 tracePlayback 把每次取页送入统一时间线（source.fetch 事件）。
 * 报告侧经 registryDiag 按注册表 baseUrls 的 host 对齐每源呈现。
 * 纪律：只记 host 与类别，不记完整 URL/查询（仓库不变量 10）；
 * 纯旁路，记录失败不影响取页本身。 */

import { tracePlayback } from "../../../shared/diagnostics/playbackDiagnostics";

export type FetchErrorCategory = "校验拒绝" | "网络不可达" | "HTTP 状态" | "超时" | "响应过大" | "其他";

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

/** Rust 侧错误串 → 粗粒度类别（关键词匹配，宁粗勿假）：错误串来自
 * 生产网络栈（目标校验/DNS/重定向复检/流式上限），类别只用于报告
 * 判读方向，不参与任何控制流。 */
export function classifyFetchError(raw: string): FetchErrorCategory {
  const s = raw.toLowerCase();
  if (/过大|超过|上限|too large|exceed/.test(s)) return "响应过大";
  if (/超时|timeout|timed out|deadline/.test(s)) return "超时";
  if (/校验|不允许|非法|禁止|内网|回环|scheme|invalid target|forbidden/.test(s)) return "校验拒绝";
  if (/\b(401|403|404|429|5\d\d)\b|http 状态|status/.test(s)) return "HTTP 状态";
  if (/dns|解析|connect|连接|网络|不可达|unreachable|reset|eof|tls|证书/.test(s)) return "网络不可达";
  return "其他";
}

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
