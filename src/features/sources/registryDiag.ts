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
 * 「最近自检」口径与「本会话取页」口径同行并存、标注分清、不互盖。
 * 2026-11-20 fix331/source-reliability：取页归属改按每源全部 host
 * 集合认领（审计 C④）；自检健康状态改读 healthCheck 单一派生
 * （四态计数/状态整句），导出行组分母只计自检合格源。 */

import { getActiveRegistry, getRegistryInfo } from "./manifest.ts";
import { countFetchStates } from "./fetchCounts.ts";
import { fetchHealthSnapshot } from "./adapters/fetchHealth.ts";
import { templateFetchOrigins } from "./adapters/fetchOrigins.ts";
import { readPlaybackFacts } from "../../shared/diagnostics/playbackFacts.ts";
import { getSelfCheckResults, selfCheckDiagLines, selfCheckEligible, selfCheckSegmentText, selfCheckStatusText } from "./healthCheck.ts";
import { adapterParamsSegmentText, classifySourceFault, getAdapterParamsState } from "./adapterParams.ts";
import { getBuiltinRegistry } from "./registry.ts";

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

/* 取页记录归属（2026-11-20 修正，结构审计 C④）：fetchHealth 按
 * 实际请求 host 记录，一个源的流量可落在多个 host（baseUrls 多
 * 个＋模板声明的 API/认证 host）。旧口径只拿 baseUrls[0] 的 host
 * 认领——多域源（目录/认证独立 host、API host 在 baseUrls[1]、
 * 走第二 baseUrl 的源）必然被报「未发生」、真实记录堆进「未归
 * 属」。现按全部 baseUrls ∪ 模板声明 origin 的 host 集合认领
 * （与 allowlist 白名单派生同源），多条记录取最近一条定态。 */
function sourceHostSet(def: { baseUrls: string[]; adapter: { template: string } }): Set<string> {
  const hosts = new Set<string>();
  for (const u of def.baseUrls) {
    const h = hostOf(u);
    if (h !== "?") hosts.add(h);
  }
  for (const o of templateFetchOrigins(def.adapter.template)) {
    const h = hostOf(o);
    if (h !== "?") hosts.add(h);
  }
  return hosts;
}

function latestFetchRecord(hosts: Set<string>, byHost: Map<string, FetchRecord>): FetchRecord | undefined {
  let best: FetchRecord | undefined;
  for (const h of hosts) {
    const r = byHost.get(h);
    if (r && (!best || r.at > best.at)) best = r;
  }
  return best;
}

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
  const defs = getActiveRegistry().sources;
  const health = fetchHealthSnapshot();
  const byHost = new Map(health.map(h => [h.host, h]));
  /* 归属按每源全部 host 集合（C④ 修正）：hostSets 与 info.sources
   * 同序（同出 active 注册表）；claimed 为全部源 host 的并集。 */
  const hostSets = info.sources.map((s, i) => (defs[i] ? sourceHostSet(defs[i]) : new Set<string>()));
  const claimed = new Set<string>();
  for (const set of hostSets) for (const h of set) claimed.add(h);
  const recordOf = (i: number): FetchRecord | undefined => latestFetchRecord(hostSets[i], byHost);
  const unobserved = health.length === 0 && readPlaybackFacts() != null;
  const sources = info.sources;
  const enabled = sources.filter(s => s.enabled).length;
  const byMaturity = new Map<string, number>();
  for (const s of sources) byMaturity.set(s.maturity, (byMaturity.get(s.maturity) ?? 0) + 1);
  /* 三态＋记录缺失计数走 countFetchStates 唯一口径（Muse 2026-11-19
   * 3.2.1修复F3b线）：旧内联计数对无生效地址的源 continue 静默跳过，
   * 三态之和小于源总数、漏计无从察觉；现四计数之和恒等于源总数，
   * 记录缺失 >0 时在 L1 明示（fetchStateText 的既有定性词）。 */
  const fc = countFetchStates(hostSets.map((set) => ({ hosts: [...set] })), byHost);
  const fetchOk = fc.ok;
  const fetchFail = fc.fail;
  const fetchNone = fc.none;
  const lines: string[] = [];
  /* L1 总览计数 */
  lines.push(
    `源总览：注册表 v${info.manifestVersion} · 来源 ${info.registrySource} · 共 ${sources.length} 源 · 启用 ${enabled} · 停用 ${sources.length - enabled} · blocked ${byMaturity.get("blocked") ?? 0} · preview ${byMaturity.get("preview") ?? 0} · 成熟度 ${[...byMaturity.entries()].map(([k, v]) => `${k} ${v}`).join("/")} · 本会话取页 成功 ${fetchOk} · 失败 ${fetchFail} · ${unobserved ? `未观测 ${fetchNone}（观测链无触发）` : `未发生 ${fetchNone}`}${fc.missing > 0 ? ` · 记录缺失 ${fc.missing}` : ""}`,
  );
  /* L2 当前源：注册表首位＝原生主源（现行生产通道）；选择状态未接
   * 入诊断，故只报主源一行，不冒充用户当前选择。 */
  const current = sources[0];
  if (current) {
    const h = recordOf(0);
    lines.push(
      `当前源：${sourceStableId(0)}（原生主源） · ${current.enabled ? "启用" : "停用"} · 成熟度 ${current.maturity} · ${fetchStateText(current, h, unobserved)}`,
    );
  }
  /* L3 其余源按「成熟度×状态」分组计数＋异常编号清单 */
  const groups = new Map<string, number>();
  const anomalies: string[] = [];
  sources.forEach((s, i) => {
    const h = recordOf(i);
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
   * 取页是本会话用户实际触发的观测，两者解决的问题不同。自检
   * 行组只传自检合格源（2026-11-20 修正）：「未自检」分母不含
   * 未启用/blocked/preview 等按规则永不自检的源，不再读起来像
   * 漏检（结构审计 C③）。 */
  lines.push(...selfCheckDiagLines(
    sources
      .map((s, i) => ({ id: s.id, stableId: sourceStableId(i), def: defs[i] }))
      .filter((x) => x.def && selfCheckEligible(x.def)),
    getSelfCheckResults(),
  ));
  return lines;
}

/** App 内明细专用（整改 C8）：含业务名与生效 origin 的逐源明细。
 * 禁止进导出路径——导出/复制/分享文本一律走 sourceHealthLines()。 */
export function sourceHealthDetailLinesInApp(): string[] {
  const info = getRegistryInfo();
  const defs = getActiveRegistry().sources;
  const health = fetchHealthSnapshot();
  const selfCheck = getSelfCheckResults();
  const byHost = new Map(health.map(h => [h.host, h]));
  const claimed = new Set<string>();
  const lines: string[] = [];
  info.sources.forEach((s, i) => {
    /* 归属与导出路径同口径（C④）：按全部 host 集合认领、取最近
     * 一条——明细面不许与导出面两个归属口径。 */
    const hosts = defs[i] ? sourceHostSet(defs[i]) : new Set<string>();
    for (const hst of hosts) claimed.add(hst);
    const h = latestFetchRecord(hosts, byHost);
    const fetchText = h
      ? `最近取页 ${h.ok ? `成功 ${h.ms}ms` : `失败·${h.category ?? "其他"} ${h.ms}ms`}（${timeText(h.at)}） · 本会话 成 ${h.okCount}/败 ${h.failCount}`
      : "本会话未取页";
    /* 自检段（fix321-F7）：「最近自检」与「本会话取页」同行并存、
     * 口径标注分清；无结果写「未自检」，不冒充未发生。健康状态整
     * 句读同一派生（selfCheckStatusText），与展示面徽标同源。 */
    const check = selfCheck[s.id];
    const checkText = check
      ? `${selfCheckSegmentText(check)} · 健康状态 ${selfCheckStatusText(check, defs[i], Date.now())}`
      : "未自检";
    /* 清单参数段＋故障类标注（fix321-F8）：参数来源（清单 vN/已回滚）
     * 只在有下发记录时呈现；故障类按 classifySourceFault 纯函数口径
     * （参数可热修 vs 需发版）标注在自检失败源上，无故障不标。 */
    const paramsText = adapterParamsSegmentText(s.id, getAdapterParamsState());
    const builtinDef = getBuiltinRegistry().find((d) => d.id === s.id);
    const faultClass = builtinDef ? classifySourceFault(builtinDef, check) : null;
    const faultText = faultClass ? ` · 故障类：${faultClass}` : "";
    lines.push(`源 ${s.displayName}（${s.id}）：${s.enabled ? "启用" : "停用"} · 成熟度 ${s.maturity} · 生效 ${s.origin} · ${fetchText} · ${checkText}${paramsText ? ` · ${paramsText}` : ""}${faultText}`);
  });
  for (const h of health) {
    if (claimed.has(h.host)) continue;
    lines.push(`取页[${h.host}]（未归属注册表源）：最近 ${h.ok ? `成功 ${h.ms}ms` : `失败·${h.category ?? "其他"} ${h.ms}ms`}（${timeText(h.at)}） · 本会话 成 ${h.okCount}/败 ${h.failCount}`);
  }
  return lines;
}
