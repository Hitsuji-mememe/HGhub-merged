/* ── 源健康自检（Muse 2026-11-19 fix321-F7 新立项）──
 * 背景：诊断「源总览」里大量源是「未发生」（本会话没被用户点开过
 * 就永远没数据）；源行不行此前只能靠外部逐站人工验——慢，且验的
 * 是浏览器环境、不是 App 自己的取页链。本模块立 App 内自检替代
 * 人工逐站验：对全部已启用源，用其自身适配器走 App 真实取页链
 * （模板适配器经 fetchPage→Rust source_fetch＋当前线路；原生黄果
 * 经既有 api 通道——都是生产路径，不另开裸 fetch）。
 *
 * 纪律（红线）：
 * ① 静默：无弹窗、无角标、无任何用户可见打扰；结果只进诊断导出
 *    与 App 内源明细（registryDiag 两条呈现路径），不进任何浏览面；
 * ② 只探已启用源：未启用/blocked/preview 不探（blocked 本就不拉
 *    数据，与既有 D 线口径一致；preview-only/none 模板无真数据）；
 * ③ 只记源 id/计数/类别/时刻，不记完整 URL/查询（不变量 10）；
 * ④ 只记观测、不自动处置：不改变任何源的启用/成熟度状态。
 *
 * 调度（静默分批错峰，不抢占用户正常取页）：
 * - 启动后延迟 SELF_CHECK_START_DELAY_MS 才开第一轮——避开启动、
 *   注册表解析与首屏取页高峰；
 * - 每片 SELF_CHECK_SHARD_SIZE 个源、片间间隔
 *   SELF_CHECK_SHARD_INTERVAL_MS——任一时刻至多 3 源 × ≤2 请求在
 *   飞，远低于用户浏览的突发量；现行 13 个合格源一轮约分 5 片、
 *    spread 在数分钟内完成；
 * - 全量一轮频率上限：结果 TTL SELF_CHECK_TTL_MS（24h）内不重探
 *   ——一天最多一轮全量，且落盘结果跨进程重启继续算新鲜度。
 *
 * 请求预算（硬上限）：每源最多 SELF_CHECK_MAX_REQUESTS_PER_SOURCE
 * =2 个请求——列表 1 页，列表有条目才再取 1 条详情；无第二页、
 * 无 resolve 取流（取流是播放链的事，自检只判列表/详情可达）。
 *
 * 失败形态口径：与 fetchHealth 的 classifyFetchError 同源（唯一
 * 出处 fetchErrorClassify.ts）——网络不可达/超时/校验拒绝/响应过大
 * 归「网络类」，HTTP 状态单列，模板解析为空认 SourceParseEmptyError
 * 记「解析为空」，详情步的未分类失败记「详情失败」，余者「其他」。
 * 列表与详情分开记：详情失败不翻列表结论。 */

import type { SourceAdapter, SourceDef } from "./types.ts";
import { SourceParseEmptyError } from "./adapters/templates.ts";
import { classifyFetchError } from "./adapters/fetchErrorClassify.ts";
import { getActiveRegistry } from "./manifest.ts";

export const SELF_CHECK_STORAGE_KEY = "hghubx_source_selfcheck_v1";
/** 每源请求硬预算：列表 1 页＋（有条目时）详情 1 条。 */
export const SELF_CHECK_MAX_REQUESTS_PER_SOURCE = 2;
export const SELF_CHECK_LIST_PAGE_SIZE = 20;
/** 启动延迟：避开启动/注册表解析/首屏取页高峰。 */
export const SELF_CHECK_START_DELAY_MS = 90_000;
/** 分片：每片源数与片间间隔（错峰，不抢占用户取页）。 */
export const SELF_CHECK_SHARD_SIZE = 3;
export const SELF_CHECK_SHARD_INTERVAL_MS = 45_000;
/** 结果新鲜期：全量一轮一天最多一次的落点（逐源判）。 */
export const SELF_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

export type SelfCheckFailureKind = "网络类" | "HTTP 状态" | "解析为空" | "详情失败" | "其他";
export type SelfCheckDetailState = "ok" | "fail" | "skipped";

export interface SourceSelfCheckResult {
  sourceId: string;
  /** 最近自检时刻（ms epoch）。 */
  at: number;
  listOk: boolean;
  /** 列表条目数（失败时 0）。 */
  itemCount: number;
  listFailure: SelfCheckFailureKind | null;
  /** skipped＝列表失败或列表真空、无从探详情。 */
  detail: SelfCheckDetailState;
  detailFailure: SelfCheckFailureKind | null;
  /** 本次实际发出的适配器请求数（≤ 硬预算）。 */
  requests: number;
}

/** 失败形态分类（纯函数）：口径与 classifyFetchError 对齐——先认
 * 解析为空（结构层），再按取页错误类别归并；详情步的未分类失败
 * 单列「详情失败」，与列表步的「其他」分开。 */
export function selfCheckFailureKind(err: unknown, step: "list" | "detail"): SelfCheckFailureKind {
  if (err instanceof SourceParseEmptyError) return "解析为空";
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const category = classifyFetchError(raw);
  if (category === "HTTP 状态") return "HTTP 状态";
  if (category === "网络不可达" || category === "超时" || category === "校验拒绝" || category === "响应过大") return "网络类";
  return step === "detail" ? "详情失败" : "其他";
}

/** 探测资格（纯函数）：只探已启用、非 blocked/preview、且有真
 * 适配器模板的源。blocked 源 enabled=true 是注册表保留口径，必须
 * 按 maturity 排除（点开都不拉数据，自检更不探）。 */
export function selfCheckEligible(def: SourceDef): boolean {
  if (!def.enabled) return false;
  if (def.maturity === "blocked" || def.maturity === "preview") return false;
  if (def.category === "preview") return false;
  const template = def.adapter.template;
  if (template === "none" || template === "preview-only") return false;
  return true;
}

/** 本轮探测名单（纯函数）：合格且结果缺失/已过期（TTL 外）的源，
 * 按注册表 order 序。结果未过期不重探＝一天最多一轮全量的落点。 */
export function buildSelfCheckPlan(
  sources: SourceDef[],
  results: Record<string, SourceSelfCheckResult>,
  now: number,
): SourceDef[] {
  return sources
    .filter((s) => selfCheckEligible(s))
    .filter((s) => {
      const r = results[s.id];
      return !r || now - r.at >= SELF_CHECK_TTL_MS;
    })
    .sort((a, b) => a.order - b.order);
}

/* ── 落盘（hghubx_* 键，不变量 7；进程重启后诊断仍可读） ── */

export interface SelfCheckStorageLike {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
}

function defaultStorage(): SelfCheckStorageLike | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

let storageOverride: SelfCheckStorageLike | null | undefined;
let resultsCache: Record<string, SourceSelfCheckResult> | null = null;

/** 绑定存储（生产默认 localStorage；契约测试注入假存储模拟重启）。 */
export function bindSelfCheckStorage(storage: SelfCheckStorageLike | null): void {
  storageOverride = storage;
  resultsCache = null;
}

function currentStorage(): SelfCheckStorageLike | null {
  return storageOverride !== undefined ? storageOverride : defaultStorage();
}

function isSelfCheckResult(x: unknown): x is SourceSelfCheckResult {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return typeof r.sourceId === "string" && r.sourceId !== ""
    && typeof r.at === "number" && Number.isFinite(r.at)
    && typeof r.listOk === "boolean"
    && typeof r.itemCount === "number"
    && (r.detail === "ok" || r.detail === "fail" || r.detail === "skipped")
    && typeof r.requests === "number";
}

function loadFrom(storage: SelfCheckStorageLike | null): Record<string, SourceSelfCheckResult> {
  try {
    const raw = storage?.getItem(SELF_CHECK_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, SourceSelfCheckResult> = {};
    for (const [k, v] of Object.entries(parsed ?? {})) {
      if (isSelfCheckResult(v) && v.sourceId === k) out[k] = v;
    }
    return out;
  } catch { return {}; }
}

function storeTo(storage: SelfCheckStorageLike | null, results: Record<string, SourceSelfCheckResult>): void {
  try { storage?.setItem(SELF_CHECK_STORAGE_KEY, JSON.stringify(results)); } catch { /* 落盘失败不影响自检本身 */ }
}

/** 读全部落盘结果（带进程内缓存；诊断呈现口）。 */
export function getSelfCheckResults(): Record<string, SourceSelfCheckResult> {
  if (resultsCache === null) resultsCache = loadFrom(currentStorage());
  return resultsCache;
}

/** 记一条结果并落盘（旁路：任何失败吞掉，不影响调用方）。 */
export function saveSelfCheckResult(result: SourceSelfCheckResult): void {
  const all = { ...getSelfCheckResults(), [result.sourceId]: result };
  resultsCache = all;
  storeTo(currentStorage(), all);
}

/* ── 自检引擎（适配器经注入接缝，测试不访问上游网络） ── */

export interface SelfCheckEngineDeps {
  createAdapterFor: (def: SourceDef) => SourceAdapter | null;
  now: () => number;
}

/** 单源自检：列表 1 页（记成败＋条目数），有条目再取 1 条详情
 * （记可达/失败）。全程 ≤ SELF_CHECK_MAX_REQUESTS_PER_SOURCE 个
 * 请求——本函数只有 list/detail 两处调用点，结构上不可能超预算。
 * 本函数不抛错：一切失败都收敛成结果里的失败形态。 */
export async function runSourceSelfCheck(def: SourceDef, deps: SelfCheckEngineDeps): Promise<SourceSelfCheckResult> {
  const base: SourceSelfCheckResult = {
    sourceId: def.id, at: deps.now(), listOk: false, itemCount: 0,
    listFailure: null, detail: "skipped", detailFailure: null, requests: 0,
  };
  let adapter: SourceAdapter | null = null;
  try { adapter = deps.createAdapterFor(def); } catch { adapter = null; }
  if (!adapter) return { ...base, listFailure: "其他" };
  let firstId: string | null = null;
  try {
    base.requests += 1;
    const page = await adapter.list(1, SELF_CHECK_LIST_PAGE_SIZE);
    base.listOk = true;
    base.itemCount = page.items.length;
    firstId = page.items[0]?.externalId ?? null;
  } catch (e) {
    base.listFailure = selfCheckFailureKind(e, "list");
    return base;
  }
  if (firstId === null) return base; // 结构化真空：列表成功、无条目可探详情
  try {
    base.requests += 1;
    await adapter.detail(firstId);
    base.detail = "ok";
  } catch (e) {
    base.detail = "fail";
    base.detailFailure = selfCheckFailureKind(e, "detail");
  }
  return base;
}

/* ── 调度（启动装配在 main.tsx；纯旁路，异常不影响启动与使用） ── */

export interface SelfCheckDeps extends SelfCheckEngineDeps {
  getSources: () => SourceDef[];
  storage?: SelfCheckStorageLike | null;
  delay: (ms: number) => Promise<void>;
  setTimeoutFn: (fn: () => void, ms: number) => unknown;
}

type PartialDeps = Partial<SelfCheckDeps> & Pick<SelfCheckEngineDeps, "createAdapterFor">;

function resolveDeps(partial: PartialDeps): SelfCheckDeps {
  return {
    getSources: partial.getSources ?? (() => getActiveRegistry().sources),
    createAdapterFor: partial.createAdapterFor,
    now: partial.now ?? (() => Date.now()),
    storage: partial.storage,
    delay: partial.delay ?? ((ms) => new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms) as unknown as { unref?: () => void };
      t.unref?.();
    })),
    setTimeoutFn: partial.setTimeoutFn ?? ((fn, ms) => {
      const t = setTimeout(fn, ms) as unknown as { unref?: () => void };
      t.unref?.();
      return t;
    }),
  };
}

/** 一轮全量自检：按名单分片顺序跑，片间错峰 delay；单源失败只落
 * 该源结果、不拖垮整轮；整轮异常由调用方吞掉（旁路纪律）。 */
export async function runSelfCheckRound(partial: PartialDeps): Promise<{ checked: number }> {
  const deps = resolveDeps(partial);
  const storage = deps.storage !== undefined ? deps.storage : currentStorage();
  const plan = buildSelfCheckPlan(deps.getSources(), loadFrom(storage), deps.now());
  let checked = 0;
  for (let i = 0; i < plan.length; i += SELF_CHECK_SHARD_SIZE) {
    if (i > 0) await deps.delay(SELF_CHECK_SHARD_INTERVAL_MS);
    for (const def of plan.slice(i, i + SELF_CHECK_SHARD_SIZE)) {
      try {
        const result = await runSourceSelfCheck(def, deps);
        const all = { ...loadFrom(storage), [result.sourceId]: result };
        storeTo(storage, all);
        if (storage === currentStorage()) resultsCache = all;
        checked += 1;
      } catch { /* 单源异常不拖垮整轮 */ }
    }
  }
  return { checked };
}

let schedulerStarted = false;

/** 注册自检调度（启动装配处调用一次）：延迟启动一轮，之后不再
 * 自行排期——后续启动靠落盘 TTL 判新鲜度（一天最多一轮全量）。
 * 返回是否注册成功（重复注册/异常均 false 且不抛）。 */
export function startSourceSelfCheckScheduler(partial: PartialDeps): boolean {
  if (schedulerStarted) return false;
  try {
    const deps = resolveDeps(partial);
    deps.setTimeoutFn(() => {
      void runSelfCheckRound(deps).catch(() => { /* 旁路：自检失败不影响使用 */ });
    }, SELF_CHECK_START_DELAY_MS);
    schedulerStarted = true;
    return true;
  } catch {
    return false;
  }
}

/* ── 诊断呈现构建（registryDiag 两条路径共用，口径在此一处） ── */

function timeText(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}

/** 单源自检段（App 内明细用）：恒带「最近自检」口径标注，与明细行
 * 里的「本会话取页」段并存不互盖。 */
export function selfCheckSegmentText(r: SourceSelfCheckResult): string {
  const t = timeText(r.at);
  if (!r.listOk) return `最近自检 失败·${r.listFailure ?? "其他"} · 详情未探（${t}）`;
  if (r.detail === "fail") {
    const kind = r.detailFailure && r.detailFailure !== "详情失败" ? `·${r.detailFailure}` : "";
    return `最近自检 列表 ${r.itemCount} 条 · 详情失败${kind}（${t}）`;
  }
  if (r.detail === "ok") return `最近自检 成功 · 列表 ${r.itemCount} 条 · 详情可达（${t}）`;
  return `最近自检 成功 · 列表 ${r.itemCount} 条 · 详情未探（无条目）（${t}）`;
}

/** 导出路径的自检行组：汇总一行＋有结果的源逐源一行（稳定编号、
 * 零业务名，与 sourceHealthLines 既有口径一致）；无结果源只计数
 * 「未自检」，不冒充本会话取页的「未发生」。 */
export function selfCheckDiagLines(
  sources: { id: string; stableId: string }[],
  results: Record<string, SourceSelfCheckResult>,
): string[] {
  let ok = 0;
  let fail = 0;
  const per: string[] = [];
  for (const s of sources) {
    const r = results[s.id];
    if (!r) continue;
    if (r.listOk && r.detail !== "fail") ok += 1; else fail += 1;
    per.push(`自检 ${s.stableId}：${selfCheckSegmentText(r)}`);
  }
  const checked = ok + fail;
  return [
    `源自检（最近自检口径，与本会话取页分开）：已检 ${checked} · 通过 ${ok} · 失败 ${fail} · 未自检 ${sources.length - checked}`,
    ...per,
  ];
}
