/**
 * 网络诊断摘要：把 `net_diag` 的 verdict JSON 压成一句话人话，
 * 给 toast / 日志用。逐段长报告版 formatNetDiag 全仓零消费，已随
 * 2026-11-20 收敛清理删除（连同其本地辅助 num/obj/arr/ms/pad）。
 */

type Json = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 结论 → 一句话人话（verdict 是稳定的英文码，方便 grep 统计） */
const VERDICT_TEXT: Record<string, string> = {
  ok: "连通正常",
  ok_proxy: "代理/TUN 接管中，连接正常",
  fake_ip: "被代理 / TUN 接管（fake-ip）",
  dns_fail: "DNS 解析失败",
  dns_false_alarm: "DNS 探测异常，但实际可通",
  dns_hijack: "DNS 被劫持到内网 / 保留地址",
  tcp_timeout: "直连 TCP 探测超时",
  tcp_refused: "直连 TCP 探测被拒",
  tls_intercept: "TLS 证书校验失败",
  tls_fail: "TLS 握手失败",
  proxy_fail: "代理请求失败",
  http_fail: "HTTP 请求失败",
  http_status: "服务端返回错误状态码",
  unknown: "信息不足",
};

/** 一句话摘要，给 toast / 日志用，不占屏。 */
export function shortVerdict(raw: Json): string {
  const verdict = str(raw.verdict) || "unknown";
  return `${verdict} · ${str(raw.summary) || VERDICT_TEXT[verdict] || "未知"}`;
}
