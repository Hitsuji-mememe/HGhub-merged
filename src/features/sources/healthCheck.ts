/* ── 源健康自检（Muse 2026-11-19 fix321-F7 新立项）──
 * 背景：诊断「源总览」里大量源是「未发生」（本会话没被用户点开过
 * 就永远没数据）；源行不行此前只能靠外部逐站人工验——慢，且验的
 * 是浏览器环境、不是 App 自己的取页链。本模块立 App 内自检替代
 * 人工逐站验：对全部已启用源，用其自身适配器走 App 真实取页链
 * （模板适配器经 fetchPage→Rust source_fetch＋当前线路；原生黄果
 * 经既有 api 通道——都是生产路径，不另开裸 fetch）。
 *
 * 纪律（红线）：
 * ① 静默：无弹窗、无任何用户可见打扰；呈现只走既有状态位——
 *    诊断导出与 App 内源明细（registryDiag 两条呈现路径），以及
 *    浏览面原有的状态徽标位（2026-11-20 用户裁定：源可靠性状态
 *    收敛为单一派生 classifySelfCheckResult，切换器/总览的徽标
 *    改读派生，不再各读静态 maturity——此前双轨并存时同一源可
 *    同时是「未实测」与「自检成功」，用户无从知道哪个为准）；
 * ② 只探已启用源：未启用/blocked/preview 不探（blocked 本就不拉
 *    数据，与既有 D 线口径一致；preview-only/none 模板无真数据）；
 * ③ 只记源 id/计数/类别/时刻，不记完整 URL/查询（不变量 10）；
 * ④ 只记观测、不自动处置：不改变任何源的启用/成熟度状态。
 *
 * 调度（静默分批错峰，不抢占用户正常取页）：
 * - 启动后延迟 SELF_CHECK_START_DELAY_MS 才开第一轮——避开启动、
 *   注册表解析与首屏取页高峰；
 * - 每片 SELF_CHECK_SHARD_SIZE 个源、片间间隔
 *   SELF_CHECK_SHARD_INTERVAL_MS——任一时刻至多 3 源 × ≤3 请求在
 *   飞，远低于用户浏览的突发量；现行 14 个合格源一轮约分 5 片、
 *    spread 在数分钟内完成；
 * - 全量一轮频率上限：结果 TTL SELF_CHECK_TTL_MS（24h）内不重探
 *   ——一天最多一轮全量，且落盘结果跨进程重启继续算新鲜度；
 * - 浏览面补探（2026-11-20 补，设备数据坐实缺口：3.3.1 真机会话
 *   内自检零刷新、最近结果停在前一日）：进入某源浏览面时若其
 *   结果缺失/已过期/清单版本已变，单源后台补探一次
 *   （ensureSourceSelfCheck），完成经订阅通知刷新展示面徽标；
 *   全量调度的时序竞态（清单拉取挂起越过首轮时刻）也由此兜底。
 *
 * 请求预算（硬上限）：每源最多 SELF_CHECK_MAX_REQUESTS_PER_SOURCE
 * =3 个请求——列表 1 页，列表有条目才再取 1 条详情，视频类详情
 * 可达后抽同 1 条目续探 1 次取流（只取流不播放，2026-11-20 补：
 * 此前自检只探列表＋详情，取流段失败在诊断里零记录、「可用」
 * 不覆盖用户真正用的那一段）；posts 类正文段与 image 类图集段
 * 复用详情响应判定、不另发请求（这两类实际请求 ≤2）。无第二页。
 *
 * 失败形态口径：与 fetchHealth 的 classifyFetchError 同源（唯一
 * 出处 fetchErrorClassify.ts）——网络不可达/超时/校验拒绝/响应过大
 * 归「网络类」，HTTP 状态单列，模板解析为空认 SourceParseEmptyError
 * 记「解析为空」，详情/取流步的未分类失败各记「详情失败」/「取流
 * 失败」，余者「其他」。三段分开记：后段失败不翻前段结论。 */

import type { SourceAdapter, SourceDef, SourceDetail } from "./types.ts";
import { SourceParseEmptyError } from "./adapters/templates.ts";
import { classifyFetchError } from "./adapters/fetchErrorClassify.ts";
import { getActiveRegistry, getRegistryInfo } from "./manifest.ts";

export const SELF_CHECK_STORAGE_KEY = "hghubx_source_selfcheck_v1";
/** 每源请求硬预算：列表 1 页＋（有条目时）详情 1 条＋（视频类）取流 1 次。 */
export const SELF_CHECK_MAX_REQUESTS_PER_SOURCE = 3;
export const SELF_CHECK_LIST_PAGE_SIZE = 20;
/** 启动延迟：避开启动/注册表解析/首屏取页高峰。 */
export const SELF_CHECK_START_DELAY_MS = 90_000;
/** 分片：每片源数与片间间隔（错峰，不抢占用户取页）。 */
export const SELF_CHECK_SHARD_SIZE = 3;
export const SELF_CHECK_SHARD_INTERVAL_MS = 45_000;
/** 结果新鲜期：全量一轮一天最多一次的落点（逐源判）。 */
export const SELF_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

export type SelfCheckFailureKind = "网络类" | "HTTP 状态" | "解析为空" | "详情失败" | "取流失败" | "其他";
export type SelfCheckDetailState = "ok" | "fail" | "skipped";
export type SelfCheckTailState = "ok" | "fail" | "skipped";
/** 末段种类（按源品类）：stream＝视频取流、body＝posts 正文、gallery＝image 图集。 */
export type SelfCheckTailKind = "stream" | "body" | "gallery";

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
  /** 末段（品类第三段）：skipped＝前段失败/无条目/该品类无末段。 */
  tail: SelfCheckTailState;
  tailKind: SelfCheckTailKind | null;
  tailFailure: SelfCheckFailureKind | null;
  /** 探测时的生效清单版本（结果指纹：清单热改后旧结果判过期）。 */
  manifestVersion: number;
  /** 探测时的 App 版本（结果指纹：适配器代码随 App 换代，旧版本
   * 探得的结果——如旧抓页路线时代的失败——不许冒充现行结论）。 */
  appVersion: string;
  /** 本次实际发出的适配器请求数（≤ 硬预算）。 */
  requests: number;
}

/** 末段种类派生（纯函数，唯一出处）：按源品类定第三段探什么。 */
export function selfCheckTailKindFor(def: SourceDef): SelfCheckTailKind | null {
  if (def.category === "video") return "stream";
  if (def.category === "posts") return "body";
  if (def.category === "image") return "gallery";
  return null;
}

/** 末段中文名（诊断/派生共用口径）。 */
export function tailSegmentLabel(kind: SelfCheckTailKind | null): string {
  return kind === "stream" ? "取流" : kind === "body" ? "正文" : kind === "gallery" ? "图集" : "末段";
}

/** 失败形态分类（纯函数）：口径与 classifyFetchError 对齐——先认
 * 解析为空（结构层），再按取页错误类别归并；详情/取流步的未分类
 * 失败各单列「详情失败」/「取流失败」，与列表步的「其他」分开。 */
export function selfCheckFailureKind(err: unknown, step: "list" | "detail" | "stream"): SelfCheckFailureKind {
  if (err instanceof SourceParseEmptyError) return "解析为空";
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const category = classifyFetchError(raw);
  if (category === "HTTP 状态") return "HTTP 状态";
  if (category === "网络不可达" || category === "超时" || category === "校验拒绝" || category === "响应过大") return "网络类";
  return step === "detail" ? "详情失败" : step === "stream" ? "取流失败" : "其他";
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

/** 本轮探测名单（纯函数）：合格且需要补探的源，按注册表 order
 * 序。需要补探的口径与浏览面补探共用 selfCheckNeedsProbe 一处。 */
export function buildSelfCheckPlan(
  sources: SourceDef[],
  results: Record<string, SourceSelfCheckResult>,
  now: number,
  manifestVersion: number = getActiveRegistry().manifestVersion,
  appVersion: string = getRegistryInfo().appVersion,
): SourceDef[] {
  return sources
    .filter((s) => selfCheckNeedsProbe(s, results, now, manifestVersion, appVersion))
    .sort((a, b) => a.order - b.order);
}

/** 是否需要（补）探（纯函数）：合格 ∧（无结果 ∨ 结果已过期）。
 * 过期口径与派生 classifySelfCheckResult 的 stale 同源——超 TTL、
 * 探测时清单版本与当前不符（清单热改域名/参数后旧结果不算数）、
 * 或探测时 App 版本与当前不符（适配器随 App 换代，旧版本结论不
 * 算数）任一成立即过期。 */
export function selfCheckNeedsProbe(
  def: SourceDef,
  results: Record<string, SourceSelfCheckResult>,
  now: number,
  manifestVersion: number,
  appVersion: string,
): boolean {
  if (!selfCheckEligible(def)) return false;
  const r = results[def.id];
  if (!r) return true;
  return classifySelfCheckResult(r, now, manifestVersion, appVersion).stale;
}

/* ── 源健康单一派生（2026-11-20 用户裁定：全 App 只此一处） ──
 * 展示面（切换器/总览徽标）、诊断（行组计数/App 内明细）与补探
 * 触发都只读本派生，不许再各读静态 maturity 或原始结果拼口径。 */

export type SourceHealthStatus = "unchecked" | "ok" | "partial" | "down";

export interface SourceHealthCore {
  status: SourceHealthStatus;
  /** 结果已过期（超 TTL、清单版本已变或 App 已换代）：结论仅供参考、不冒充新鲜。 */
  stale: boolean;
  at: number | null;
  /** partial/down 时出问题的段名（列表/详情/取流/正文/图集/列表为空）。 */
  segment: string | null;
  failure: SelfCheckFailureKind | null;
}

/** 四态派生（纯函数）：未自检＝无结果；可用＝全链（列表＋详情＋
 * 品类末段）通；部分可用＝前段通、某深段死或无从验证（注明段）；
 * 不可用＝列表段即死。 */
export function classifySelfCheckResult(
  r: SourceSelfCheckResult | undefined,
  now: number,
  manifestVersion: number,
  appVersion: string,
): SourceHealthCore {
  if (!r) return { status: "unchecked", stale: false, at: null, segment: null, failure: null };
  const stale = now - r.at >= SELF_CHECK_TTL_MS || r.manifestVersion !== manifestVersion || r.appVersion !== appVersion;
  if (!r.listOk) return { status: "down", stale, at: r.at, segment: "列表", failure: r.listFailure };
  if (r.detail === "fail") return { status: "partial", stale, at: r.at, segment: "详情", failure: r.detailFailure };
  if (r.detail === "ok") {
    if (r.tail === "fail") return { status: "partial", stale, at: r.at, segment: tailSegmentLabel(r.tailKind), failure: r.tailFailure };
    if (r.tail === "ok" || r.tailKind === null) return { status: "ok", stale, at: r.at, segment: null, failure: null };
    return { status: "partial", stale, at: r.at, segment: tailSegmentLabel(r.tailKind), failure: null };
  }
  /* 列表成功但真空：详情/末段无从验证，不冒充全通。 */
  return { status: "partial", stale, at: r.at, segment: "列表为空", failure: null };
}

/** 徽标文案（展示面唯一口径）：探过的源一律读派生——可用不挂标
 * （与 stable 既有口径一致）、部分可用/不可用直标、过期在结论后
 * 缀「已过期」；从未探过才回落静态 maturity 作底（probe 的「未
 * 实测」只在真未探时成立）。 */
export function sourceHealthBadgeText(
  def: SourceDef,
  result: SourceSelfCheckResult | undefined,
  now: number,
  manifestVersion: number,
  appVersion: string,
): string | undefined {
  const core = classifySelfCheckResult(result, now, manifestVersion, appVersion);
  if (core.status === "unchecked") {
    return def.maturity === "preview" ? "仅预览"
      : def.maturity === "blocked" ? "暂不可用"
      : def.maturity === "probe" ? "未实测"
      : undefined;
  }
  const base = core.status === "ok" ? undefined : core.status === "partial" ? "部分可用" : "不可用";
  if (core.stale) return base ? `${base}·已过期` : "已过期";
  return base;
}

/** 健康状态整句（App 内明细用）：与徽标同派生、信息更全。 */
export function selfCheckStatusText(
  result: SourceSelfCheckResult | undefined,
  now: number,
  manifestVersion: number,
  appVersion: string,
): string {
  const core = classifySelfCheckResult(result, now, manifestVersion, appVersion);
  if (core.status === "unchecked") return "未自检";
  const staleSuffix = core.stale ? "·已过期" : "";
  if (core.status === "ok") return `可用${staleSuffix}`;
  if (core.status === "down") return `不可用（${core.segment ?? "列表"}·${core.failure ?? "其他"}）${staleSuffix}`;
  return `部分可用（${core.segment ?? "深段"}${core.failure ? `·${core.failure}` : ""}）${staleSuffix}`;
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
    /* 末段＋清单版本指纹为现行格式要件：旧格式结果（只探列表/详
     * 情、无指纹）读入即丢弃——按新全链口径它们等于没探过，不许
     * 冒充已检（升级后首轮/补探会重新探齐）。 */
    && (r.tail === "ok" || r.tail === "fail" || r.tail === "skipped")
    && (r.tailKind === "stream" || r.tailKind === "body" || r.tailKind === "gallery" || r.tailKind === null)
    && typeof r.manifestVersion === "number" && Number.isFinite(r.manifestVersion)
    && typeof r.appVersion === "string" && r.appVersion !== ""
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
  notifySelfCheckResults();
}

/* ── 结果订阅（展示面刷新通道）：补探/整轮落盘后通知，消费方
 * （sourceHealth.ts 的 useSyncExternalStore 钩子）据此重渲染徽标
 * ——「探完即刷新标签」的落点。监听器异常逐个吞掉（旁路纪律）。 */

const resultListeners = new Set<() => void>();

export function subscribeSelfCheckResults(fn: () => void): () => void {
  resultListeners.add(fn);
  return () => { resultListeners.delete(fn); };
}

function notifySelfCheckResults(): void {
  for (const fn of [...resultListeners]) {
    try { fn(); } catch { /* 旁路：单个监听器异常不影响其余 */ }
  }
}

/* ── 自检引擎（适配器经注入接缝，测试不访问上游网络） ── */

export interface SelfCheckEngineDeps {
  createAdapterFor: (def: SourceDef) => SourceAdapter | null;
  now: () => number;
  /** 结果指纹用的生效清单版本（缺省读 active 注册表）。 */
  manifestVersion?: () => number;
  /** 结果指纹用的 App 版本（缺省读注册表信息）。 */
  appVersion?: () => string;
}

/** 单源自检：列表 1 页（记成败＋条目数），有条目再取 1 条详情
 * （记可达/失败），详情可达后按品类补末段——视频类抽同 1 条目
 * 续探 1 次取流（只取流不播放，零流记失败）；posts 正文段与
 * image 图集段复用详情响应判定（正文 HTML/图集图数为空记解析
 * 为空）。全程 ≤ SELF_CHECK_MAX_REQUESTS_PER_SOURCE 个请求——
 * 本函数只有 list/detail/resolve 三处调用点，结构上不可能超
 * 预算。本函数不抛错：一切失败都收敛成结果里的失败形态。 */
export async function runSourceSelfCheck(def: SourceDef, deps: SelfCheckEngineDeps): Promise<SourceSelfCheckResult> {
  const base: SourceSelfCheckResult = {
    sourceId: def.id, at: deps.now(), listOk: false, itemCount: 0,
    listFailure: null, detail: "skipped", detailFailure: null,
    tail: "skipped", tailKind: selfCheckTailKindFor(def), tailFailure: null,
    manifestVersion: deps.manifestVersion ? deps.manifestVersion() : getActiveRegistry().manifestVersion,
    appVersion: deps.appVersion ? deps.appVersion() : getRegistryInfo().appVersion,
    requests: 0,
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
  let detailData: SourceDetail | null = null;
  try {
    base.requests += 1;
    detailData = await adapter.detail(firstId);
    base.detail = "ok";
  } catch (e) {
    base.detail = "fail";
    base.detailFailure = selfCheckFailureKind(e, "detail");
    return base;
  }
  if (base.tailKind === "stream") {
    try {
      base.requests += 1;
      const resolved = await adapter.resolve(firstId);
      if (resolved.streams.length > 0) {
        base.tail = "ok";
      } else {
        base.tail = "fail";
        base.tailFailure = "取流失败"; // 零流＝取不到可播地址，与解析出空同罪
      }
    } catch (e) {
      base.tail = "fail";
      base.tailFailure = selfCheckFailureKind(e, "stream");
    }
  } else if (base.tailKind === "body") {
    if ((detailData.contentHtml ?? "").trim().length > 0) {
      base.tail = "ok";
    } else {
      base.tail = "fail";
      base.tailFailure = "解析为空";
    }
  } else if (base.tailKind === "gallery") {
    if (detailData.images.length > 0) {
      base.tail = "ok";
    } else {
      base.tail = "fail";
      base.tailFailure = "解析为空";
    }
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
        if (storage === currentStorage()) {
          resultsCache = all;
          notifySelfCheckResults();
        }
        checked += 1;
      } catch { /* 单源异常不拖垮整轮 */ }
    }
  }
  return { checked };
}

/* ── 浏览面补探（进入源浏览面时触发，见文件头调度节） ── */

const topUpInFlight = new Set<string>();

export interface SelfCheckTopUpDeps {
  createAdapterFor: (def: SourceDef) => SourceAdapter | null;
  now?: () => number;
}

/** 单源补探：结果缺失/已过期/清单版本已变才跑（selfCheckNeedsProbe
 * 口径与全量计划同源），在飞去重；完成经 saveSelfCheckResult 落盘
 * 并通知订阅刷新徽标。返回是否真正启动了一次补探。全程旁路：
 * 任何异常吞掉、不抛、不打扰用户。 */
export function ensureSourceSelfCheck(def: SourceDef, deps: SelfCheckTopUpDeps): boolean {
  try {
    const now = (deps.now ?? (() => Date.now()))();
    if (!selfCheckNeedsProbe(def, getSelfCheckResults(), now, getActiveRegistry().manifestVersion, getRegistryInfo().appVersion)) return false;
    if (topUpInFlight.has(def.id)) return false;
    topUpInFlight.add(def.id);
    void runSourceSelfCheck(def, { createAdapterFor: deps.createAdapterFor, now: () => now })
      .then((result) => { saveSelfCheckResult(result); })
      .catch(() => { /* 旁路：补探失败不影响浏览 */ })
      .finally(() => { topUpInFlight.delete(def.id); });
    return true;
  } catch {
    return false;
  }
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
 * 里的「本会话取页」段并存不互盖。三段逐段呈现：末段失败单独成
 * 句——取流/正文/图集死在这里必须看得见，不许被「详情可达」盖住。 */
export function selfCheckSegmentText(r: SourceSelfCheckResult): string {
  const t = timeText(r.at);
  if (!r.listOk) return `最近自检 失败·${r.listFailure ?? "其他"} · 详情未探（${t}）`;
  if (r.detail === "fail") {
    const kind = r.detailFailure && r.detailFailure !== "详情失败" ? `·${r.detailFailure}` : "";
    return `最近自检 列表 ${r.itemCount} 条 · 详情失败${kind}（${t}）`;
  }
  if (r.detail === "ok") {
    const label = tailSegmentLabel(r.tailKind);
    if (r.tail === "fail") {
      const kind = r.tailFailure && r.tailFailure !== "取流失败" ? `·${r.tailFailure}` : "";
      return `最近自检 列表 ${r.itemCount} 条 · 详情可达 · ${label}失败${kind}（${t}）`;
    }
    if (r.tail === "ok") return `最近自检 成功 · 列表 ${r.itemCount} 条 · 详情可达 · ${label}可达（${t}）`;
    return `最近自检 成功 · 列表 ${r.itemCount} 条 · 详情可达（${t}）`;
  }
  return `最近自检 成功 · 列表 ${r.itemCount} 条 · 详情未探（无条目）（${t}）`;
}

/** 导出路径的自检行组：汇总一行＋有结果的源逐源一行（稳定编号、
 * 零业务名，与 sourceHealthLines 既有口径一致）；无结果源只计数
 * 「未自检」，不冒充本会话取页的「未发生」。汇总计数走单一派生
 * （classifySelfCheckResult 四态）——取流段死的源计「部分可用」，
 * 不再计「通过」。调用方（registryDiag）负责只传自检合格源，
 * 「未自检」分母不含未启用/不合格源。过期结果逐源行缀明示。 */
export function selfCheckDiagLines(
  sources: { id: string; stableId: string }[],
  results: Record<string, SourceSelfCheckResult>,
  now: number = Date.now(),
  manifestVersion: number = getActiveRegistry().manifestVersion,
  appVersion: string = getRegistryInfo().appVersion,
): string[] {
  let ok = 0;
  let partial = 0;
  let down = 0;
  const per: string[] = [];
  for (const s of sources) {
    const r = results[s.id];
    const core = classifySelfCheckResult(r, now, manifestVersion, appVersion);
    if (!r || core.status === "unchecked") continue;
    if (core.status === "ok") ok += 1;
    else if (core.status === "partial") partial += 1;
    else down += 1;
    per.push(`自检 ${s.stableId}：${selfCheckSegmentText(r)}${core.stale ? " · 结果已过期" : ""}`);
  }
  const checked = ok + partial + down;
  return [
    `源自检（最近自检口径，与本会话取页分开）：已检 ${checked} · 可用 ${ok} · 部分可用 ${partial} · 不可用 ${down} · 未自检 ${sources.length - checked}`,
    ...per,
  ];
}
