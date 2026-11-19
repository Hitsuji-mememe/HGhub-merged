/* ── 源诊断（Muse 2026-11-19 根治包·飞行记录仪收口；2026-11-19
 * 整改 C8 报告格式重构）──
 * 本文件有两条路径，严格分开：
 * ① sourceHealthLines()＝默认导出路径（经 provider 钩子被诊断报告
 *    消费）：只出 L1 总览计数＋L2 当前源一行＋L3 分组计数与异常编号
 *    清单，全程稳定编号（source-001…，按 active 注册表顺序）、零业
 *    务名、零域名/host。
 * ② sourceHealthDetailLinesInApp()＝App 内明细专用：含业务名与生效
 *    origin，供 App 内排障界面用；禁止进导出路径（任何导出/复制/
 *    分享文本都不许调用它拼段）。
 * 两条路径都并入源健康自检结果（fix321-F7，healthCheck.ts 落盘）：
 * 「最近自检」口径与「本会话取页」口径同行并存、标注分清、不互盖。 */

import { getRegistryInfo } from "./manifest.ts";
import { fetchHealthSnapshot } from "./adapters/fetchHealth.ts";
import { readPlaybackFacts } from "../../shared/diagnostics/playbackFacts.ts";
import { getSelfCheckResults, selfCheckDiagLines, selfCheckSegmentText } from "./healthCheck.ts";

function hostOf(url: string): string {
  try { return new URL(url).host || "?"; } catch { return "?"; }
}

function timeText(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}

/** 源稳定编号：按 active 注册表顺序 source-001…（整改 C8）。 */
export function sourceStableId(index: number): string {
  return `source-${String(index + 1).padStart(3, "0")}`;
}

type RegistrySourceInfo = ReturnType<typeof getRegistryInfo>["sources"][number];
type FetchRecord = ReturnType<typeof fetchHealthSnapshot>[number];

/* 取页三态（diag-audit #13）：分清「未发生／未观测／记录缺失」——
 * 本会话有播放而 fetchHealth 为空时是观测链无触发（未观测），不许
 * 逐源印「未取页」冒充未发生。 */
function fetchStateText(
  s: RegistrySourceInfo,
  h: FetchRecord | undefined,
  unobserved: boolean,
): string {
  if (!s.origin) return "记录缺失（无生效地址）";
  if (h) {
    return `取页 ${h.ok ? `成功 ${h.ms}ms` : `失败·${h.category ?? "其他"} ${h.ms}ms`}（${timeText(h.at)}） · 本会话 成 ${h.okCount}/败 ${h.failCount}`;
  }
  if (unobserved) return "未观测（观测链无触发）";
  return "未发生（本会话未取页）";
}

/** 默认导出路径的源段（L1/L2/L3，整改 C8）：稳定编号、零业务词。 */
export function sourceHealthLines(): string[] {
  const info = getRegistryInfo();
  const health = fetchHealthSnapshot();
  const byHost = new Map(health.map(h => [h.host, h]));
  const claimed = new Set<string>();
  for (const s of info.sources) {
    const host = hostOf(s.origin);
    if (byHost.has(host)) claimed.add(host);
  }
  const unobserved = health.length === 0 && readPlaybackFacts() != null;
  const sources = info.sources;
  const enabled = sources.filter(s => s.enabled).length;
  const byMaturity = new Map<string, number>();
  for (const s of sources) byMaturity.set(s.maturity, (byMaturity.get(s.maturity) ?? 0) + 1);
  let fetchOk = 0;
  let fetchFail = 0;
  let fetchNone = 0;
  for (const s of sources) {
    const h = s.origin ? byHost.get(hostOf(s.origin)) : undefined;
    if (!s.origin) continue; // 记录缺失单独在 L2/明细口径，不混入三态计数
    if (h) {
      if (h.ok) fetchOk++; else fetchFail++;
    } else fetchNone++;
  }
  const lines: string[] = [];
  /* L1 总览计数 */
  lines.push(
    `源总览：注册表 v${info.manifestVersion} · 来源 ${info.registrySource} · 共 ${sources.length} 源 · 启用 ${enabled} · 停用 ${sources.length - enabled} · blocked ${byMaturity.get("blocked") ?? 0} · preview ${byMaturity.get("preview") ?? 0} · 成熟度 ${[...byMaturity.entries()].map(([k, v]) => `${k} ${v}`).join("/")} · 本会话取页 成功 ${fetchOk} · 失败 ${fetchFail} · ${unobserved ? `未观测 ${fetchNone}（观测链无触发）` : `未发生 ${fetchNone}`}`,
  );
  /* L2 当前源：注册表首位＝原生主源（现行生产通道）；选择状态未接
   * 入诊断，故只报主源一行，不冒充用户当前选择。 */
  const current = sources[0];
  if (current) {
    const h = current.origin ? byHost.get(hostOf(current.origin)) : undefined;
    lines.push(
      `当前源：${sourceStableId(0)}（原生主源） · ${current.enabled ? "启用" : "停用"} · 成熟度 ${current.maturity} · ${fetchStateText(current, h, unobserved)}`,
    );
  }
  /* L3 其余源按「成熟度×状态」分组计数＋异常编号清单 */
  const groups = new Map<string, number>();
  const anomalies: string[] = [];
  sources.forEach((s, i) => {
    const h = s.origin ? byHost.get(hostOf(s.origin)) : undefined;
    if ((h && !h.ok) || s.maturity === "blocked") anomalies.push(sourceStableId(i));
    if (i === 0) return;
    const status = !s.enabled ? "停用" : s.maturity === "blocked" ? "blocked" : s.maturity === "preview" ? "preview" : "启用";
    const key = `${s.maturity}×${status}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  });
  if (sources.length > 1) {
    lines.push(`其余源分组：${[...groups.entries()].map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  }
  lines.push(`异常源（取页失败/blocked）：${anomalies.length ? anomalies.join("、") : "无"}`);
  const unclaimed = health.filter(h => !claimed.has(h.host)).length;
  if (unclaimed > 0) lines.push(`未归属注册表源的取页记录：${unclaimed} 个（仅计数，host 不入导出）`);
  /* 源健康自检（fix321-F7）：「最近自检」口径与上面「本会话取页」
   * 三态并存不互盖——自检是 App 主动探测的落盘结果（跨会话），
   * 取页是本会话用户实际触发的观测，两者解决的问题不同。 */
  lines.push(...selfCheckDiagLines(
    sources.map((s, i) => ({ id: s.id, stableId: sourceStableId(i) })),
    getSelfCheckResults(),
  ));
  return lines;
}

/** App 内明细专用（整改 C8）：含业务名与生效 origin 的逐源明细。
 * 禁止进导出路径——导出/复制/分享文本一律走 sourceHealthLines()。 */
export function sourceHealthDetailLinesInApp(): string[] {
  const info = getRegistryInfo();
  const health = fetchHealthSnapshot();
  const selfCheck = getSelfCheckResults();
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
    /* 自检段（fix321-F7）：「最近自检」与「本会话取页」同行并存、
     * 口径标注分清；无结果写「未自检」，不冒充未发生。 */
    const check = selfCheck[s.id];
    const checkText = check ? selfCheckSegmentText(check) : "未自检";
    lines.push(`源 ${s.displayName}（${s.id}）：${s.enabled ? "启用" : "停用"} · 成熟度 ${s.maturity} · 生效 ${s.origin} · ${fetchText} · ${checkText}`);
  }
  for (const h of health) {
    if (claimed.has(h.host)) continue;
    lines.push(`取页[${h.host}]（未归属注册表源）：最近 ${h.ok ? `成功 ${h.ms}ms` : `失败·${h.category ?? "其他"} ${h.ms}ms`}（${timeText(h.at)}） · 本会话 成 ${h.okCount}/败 ${h.failCount}`);
  }
  return lines;
}
