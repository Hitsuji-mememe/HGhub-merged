/* ── 取页观测结构化呈现（Muse 2026-11-20 fix336-a）──
 * 诊断导出缺口收口：Rust 取页链一直在播放日志里记 network.resolve
 * （逐 host 的解析分支/地址种类）与 network.target_failed（逐目标
 * 的失败阶段/错误类），但导出从未汇编这两类记录——真机五个
 * Cloudflare 前置源取页网络类全灭时，最后一公里证据就在日志里
 * 却读不出来（fix336 调查任务一）。现由诊断报告从全量解析日志
 * 按事件消费成独立节：resolve 按 host 汇最近一条＋条数，
 * target_failed 按 resource 汇计数/阶段/错误类/最近时刻。
 * 纪律（不变量 10）：host 是三方域名，一律以首现序编号（host-NN）
 * 呈现、不出原文；resource 本就是全 URL 的不可逆哈希标识
 * （playback_log::resource_id），仅作稳定标识呈现。
 * 本模块只依赖条目结构形状，报告的 LogEntry 结构兼容（与
 * resolveFailLines 同模式）。 */

type FetchObservationEntry = {
  event: string;
  ts: number;
  data: Record<string, unknown>;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : [];
const clock = (ts: number): string =>
  ts ? new Date(ts).toLocaleTimeString("zh-CN", { hour12: false }) : "?";

/** 取页观测节行组：两类记录皆无时回单行明示；resolve 行在前
 * （按编号序），target_failed 行按次数降序在后。 */
export function fetchObservationSectionLines(entries: FetchObservationEntry[]): string[] {
  const hostLabels = new Map<string, string>();
  const resolveByHost = new Map<string, {
    label: string; kinds: string[]; branch: string; allFake: boolean | null;
    addrCount: number | null; records: number; at: number;
  }>();
  const failByResource = new Map<string, {
    count: number; phases: Set<string>; errorKinds: Set<string>; lastAt: number;
  }>();
  for (const e of entries) {
    if (e.event === "network.resolve") {
      const host = str(e.data.host);
      if (!host) continue;
      let label = hostLabels.get(host);
      if (!label) {
        label = `host-${String(hostLabels.size + 1).padStart(2, "0")}`;
        hostLabels.set(host, label);
      }
      const prev = resolveByHost.get(host);
      resolveByHost.set(host, {
        label,
        kinds: strList(e.data.kinds),
        branch: str(e.data.branch),
        allFake: typeof e.data.all_fake === "boolean" ? e.data.all_fake : null,
        addrCount: typeof e.data.count === "number" ? e.data.count : null,
        records: (prev?.records ?? 0) + 1,
        at: e.ts,
      });
    } else if (e.event === "network.target_failed") {
      const resource = str(e.data.resource);
      if (!resource) continue;
      const prev = failByResource.get(resource) ?? {
        count: 0, phases: new Set<string>(), errorKinds: new Set<string>(), lastAt: 0,
      };
      const phase = str(e.data.phase);
      if (phase) prev.phases.add(phase);
      const kind = str(e.data.error_kind);
      if (kind) prev.errorKinds.add(kind);
      prev.count += 1;
      prev.lastAt = e.ts;
      failByResource.set(resource, prev);
    }
  }
  if (resolveByHost.size === 0 && failByResource.size === 0) {
    return ["无记录（本会话无取页解析/目标失败记录）"];
  }
  const out: string[] = [];
  const hosts = [...resolveByHost.values()].sort((a, b) => a.label.localeCompare(b.label));
  for (const h of hosts) {
    const parts = [`解析[${h.label}]：最近 kinds=${h.kinds.length ? h.kinds.join("/") : "?"}`];
    if (h.branch) parts.push(`branch=${h.branch}`);
    if (h.allFake !== null) parts.push(`全假地址=${h.allFake ? "是" : "否"}`);
    if (h.addrCount !== null) parts.push(`地址 ${h.addrCount} 个`);
    parts.push(`共 ${h.records} 条`);
    parts.push(clock(h.at));
    out.push(parts.join(" · "));
  }
  const fails = [...failByResource.entries()]
    .map(([resource, f]) => ({ resource, ...f }))
    .sort((a, b) => b.count - a.count || a.resource.localeCompare(b.resource));
  for (const f of fails) {
    const parts = [`目标失败[${f.resource}]：${f.count} 次`];
    if (f.phases.size) parts.push(`阶段 ${[...f.phases].join("/")}`);
    if (f.errorKinds.size) parts.push(`错误类 ${[...f.errorKinds].join("/")}`);
    parts.push(`最近 ${clock(f.lastAt)}`);
    out.push(parts.join(" · "));
  }
  return out;
}
