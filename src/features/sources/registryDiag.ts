/* ── 源健康诊断行（Muse 2026-11-19 根治包·飞行记录仪收口）──
 * 把注册表现势（每源 maturity/启用/生效 origin）与取页健康记录
 * （fetchHealth，按 host）对齐成报告行，经 shared/diagnostics 的
 * provider 钩子被诊断报告消费——用户在自己网络下打开过哪些源、
 * 通没通、败在哪类，一份导出直接可见，不靠复述。未被任何源
 * origin 认领的取页 host 单列，保证时间线外的取页也不丢。 */

import { getRegistryInfo } from "./manifest.ts";
import { fetchHealthSnapshot } from "./adapters/fetchHealth.ts";

function hostOf(url: string): string {
  try { return new URL(url).host || "?"; } catch { return "?"; }
}

function timeText(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}

export function sourceHealthLines(): string[] {
  const info = getRegistryInfo();
  const health = fetchHealthSnapshot();
  const byHost = new Map(health.map(h => [h.host, h]));
  const claimed = new Set<string>();
  const lines: string[] = [];
  for (const s of info.sources) {
    const host = hostOf(s.origin);
    const h = byHost.get(host);
    if (h) claimed.add(host);
    const fetchText = h
      ? `最近取页 ${h.ok ? `成功 ${h.ms}ms` : `失败·${h.category ?? "其他"} ${h.ms}ms`}（${timeText(h.at)}） · 本会话 成 ${h.okCount}/败 ${h.failCount}`
      : "本会话未取页";
    lines.push(`源 ${s.displayName}（${s.id}）：${s.enabled ? "启用" : "停用"} · 成熟度 ${s.maturity} · 生效 ${s.origin} · ${fetchText}`);
  }
  for (const h of health) {
    if (claimed.has(h.host)) continue;
    lines.push(`取页[${h.host}]（未归属注册表源）：最近 ${h.ok ? `成功 ${h.ms}ms` : `失败·${h.category ?? "其他"} ${h.ms}ms`}（${timeText(h.at)}） · 本会话 成 ${h.okCount}/败 ${h.failCount}`);
  }
  return lines;
}
