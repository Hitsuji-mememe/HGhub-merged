/* ── 取流失败留痕结构化呈现（Muse 2026-11-20 fix333-m5 P5）──
 * source.resolve_fail 事件此前只躺在诊断导出尾部「播放日志（尾
 * 8000 字符）」原文里：无结构化行，会话日志一长还会被尾段截断
 * 挤出（fix332 清扫 P5）。现由诊断报告从全量解析日志（读的是整
 * 份日志文件、非尾段切片）按事件消费成独立节：稳定编号/段名中文
 * 标签/固定码/HTTP 状态/尝试序/时刻，四源同口径（留痕落点在
 * features/sources/adapters/resolveTrace.ts，002/010/011/012 段名
 * 各按其管线）。段名标签只译已知词表，未知段名回落原值如实
 * 呈现。本模块只依赖条目结构形状，报告的 LogEntry 结构兼容。 */

type ResolveFailEntry = {
  event: string;
  ts: number;
  data: Record<string, unknown>;
};

const RESOLVE_SEGMENT_LABELS: Record<string, string> = {
  csrf: "CSRF 令牌",
  handshake: "握手",
  decode: "解码判读",
  detail: "详情取数",
  fetch: "流表取数",
  watch: "详情页取数",
  download: "下载页取数",
  episode: "集页取数",
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 留痕节行组：无事件时回单行明示；有事件时汇总行＋最近 12 条
 * 逐条行。事件名兼容落盘的 web. 前缀与裸名两种形态。 */
export function resolveFailSectionLines(entries: ResolveFailEntry[]): string[] {
  const fails = entries.filter((e) => e.event === "web.source.resolve_fail" || e.event === "source.resolve_fail");
  if (!fails.length) return ["无记录（本会话无取流段失败）"];
  const shown = fails.slice(-12);
  const lines = [`共 ${fails.length} 条（最近 ${shown.length} 条）：`];
  for (const e of shown) {
    const d = e.data;
    const source = str(d.source) || "未标注";
    const segment = str(d.segment);
    const segText = segment ? `${RESOLVE_SEGMENT_LABELS[segment] ?? segment}段` : "未标注段";
    const status = num(d.status);
    const attempt = num(d.attempt);
    const time = e.ts ? new Date(e.ts).toLocaleTimeString("zh-CN", { hour12: false }) : "?";
    lines.push(`· 取流失败[${source}] ${segText} · ${str(d.code) || "?"}${status != null ? ` · HTTP ${status}` : ""}${attempt != null ? ` · 第 ${attempt + 1} 次尝试` : ""} · ${time}`);
  }
  return lines;
}
