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
 *    诊断导出（registryDiag 导出路径；原 App 内明细路径已于
 *    fix334/L4 随死面删除），以及
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
 *   SELF_CHECK_SHARD_INTERVAL_MS——任一时刻至多 3 源 × ≤4 请求在
 *   飞，远低于用户浏览的突发量；现行 14 个合格源一轮约分 5 片、
 *    spread 在数分钟内完成；
 * - 全量一轮频率上限：结果 TTL SELF_CHECK_TTL_MS（24h）内不重探
 *   ——一天最多一轮全量，且落盘结果跨进程重启继续算新鲜度；
 * - 浏览面补探（2026-11-20 补，设备数据坐实缺口：3.3.1 真机会话
 *   内自检零刷新、最近结果停在前一日）：进入某源浏览面时若其
 *   结果缺失/已过期/指纹不符，单源后台补探一次
 *   （ensureSourceSelfCheck），完成经订阅通知刷新展示面徽标；
 *   全量调度的时序竞态（清单拉取挂起越过首轮时刻）也由此兜底；
 * - 展示面批量补探（2026-11-20 再补，3.3.2 真机验收坐实缺口：
 *   总览行/切换器只读派生不触发，未点开过的源长挂「未实测」）：
 *   展示状态的面挂载时对本面展示的源批量补探
 *   （ensureSourcesSelfCheck）——与单源补探共用判定/去重/预算，
 *   串行排队、任一时刻至多 1 个补探在飞，不阻塞渲染。
 *
 * 结果指纹（2026-11-20 fix333/m7-selfcheck 分维度，收口 fix331
 * 的「清单版本＋App 版本」两维）：旧口径下纯 UI/文案更新（App
 * 版本必变）与清单无关变更（清单版本必变）都会全量作废已有
 * 结果，09:29 真机「未实测」虚惊即其代价。现指纹三维：①自检
 * 协议版本 SELF_CHECK_PROTOCOL_VERSION——探测步骤/段位/失败
 * 口径变更才 bump；②适配器纪元 SELF_CHECK_ADAPTER_EPOCH——
 * 适配器取页/解析行为变更才 bump（升版纪律：改 adapters/ 下
 * 取页/解析行为必须同步 bump，子系统页在案）；③源切片
 * sourceScope——该源适配器相关切片（模板/基址/生效参数/品类/
 * 取页模式）的 FNV-1a，清单热改只作废被改的那一个源。三维任
 * 一不符判过期；App 版本与清单整体版本不再进指纹。旧两维指
 * 纹结果首次读入时逐条迁移判定（migrateLegacyResult）：同
 * App 版本∧同清单版本者按现行指纹认定、保持新鲜；任一不符
 * 者给哨兵指纹（纪元 0/切片空串）——判过期但不丢弃。
 *
 * 补探排序（2026-11-20 fix333/m7-selfcheck）：批量补探启动序
 * ＝当前面选中源最先、最近打开过的源次之（打开时刻倒序）、
 * 其余按注册表序——全量失效时用户正在看的源先刷新，不必等
 * 注册表序轮到它。「最近打开」以浏览面进入时刻为准（浏览面
 * 钩子经 recordSourceView 落盘 hghubx_source_last_view_v1，
 * 跨重启成立、升级后首轮排序即生效）。排序只重排启动序，串
 * 行与每源预算不变；全量轮次计划（buildSelfCheckPlan）是无
 * 人值守调度、仍按注册表序。
 *
 * 请求预算（硬上限）：每源最多 SELF_CHECK_MAX_REQUESTS_PER_SOURCE
 * =4 个请求——列表 1 页，信号称有下一页时抽查第 2 页 1 页（见下
 * 「分页抽查」），列表有条目才再取 1 条详情，视频类详情可达后抽
 * 同 1 条目续探 1 次取流（只取流不播放，2026-11-20 补：此前自检
 * 只探列表＋详情，取流段失败在诊断里零记录、「可用」不覆盖用户
 * 真正用的那一段）；posts 类正文段与 image 类图集段复用详情响
 * 应判定、不另发请求（这两类实际请求 ≤3）。除抽查外不取第二页。
 *
 * 分页抽查（2026-11-20 fix335/selfcheck-paging 补）：分页信号
 * （fix335/a-pagination 新信号体系）只保证信号形态自洽，信号说
 * 谎（站方忽略页码恒回同一页、导航末页虚报、第 2 页不可达或为
 * 空）时第 1 页照样成功、自检照样全绿，用户翻页才撞见。本线在
 * 列表成功后按同一 Paged 信号（pages＞当前页，与三套 UI 的停
 * 拉判据同口径）多取第 2 页一页：不可达按取页同源形态记、为
 * 空记「解析为空」、与第 1 页条目集全同记「其他」（信号说谎或
 * 分页失效）；部分重叠（置顶类合法重复）不算全同。信号称单页
 * 者标不适用（na）——不多取页、不冒充通过。抽查失败经单一派
 * 生降级部分可用（段名「分页」），不翻列表/详情/末段结论。协
 * 议版本随本段 bump 1→2：v1 结果无抽查段，按指纹不符判过期补
 * 探；落盘旧结果缺本段字段读入归一 skipped，不丢弃。
 *
 * 失败形态口径：与 fetchHealth 的 classifyFetchError 同源（唯一
 * 出处 fetchErrorClassify.ts）——网络不可达/超时/校验拒绝/响应过大
 * 归「网络类」，HTTP 状态单列，模板解析为空认 SourceParseEmptyError
 * 记「解析为空」，详情/取流步的未分类失败各记「详情失败」/「取流
 * 失败」，余者「其他」。各段分开记：后段失败不翻前段结论。 */

import type { SourceAdapter, SourceDef, SourceDetail } from "./types.ts";
import { SourceParseEmptyError } from "./adapters/templates.ts";
import { classifyFetchError } from "./adapters/fetchErrorClassify.ts";
import { getActiveRegistry, getRegistryInfo } from "./manifest.ts";

export const SELF_CHECK_STORAGE_KEY = "hghubx_source_selfcheck_v1";
/** 每源请求硬预算：列表 1 页＋（信号称有下一页时）分页抽查第 2
 * 页 1 页＋（有条目时）详情 1 条＋（视频类）取流 1 次。
 * 按适配器调用计（口径定义见 SourceSelfCheckResult.requests）。 */
export const SELF_CHECK_MAX_REQUESTS_PER_SOURCE = 4;
export const SELF_CHECK_LIST_PAGE_SIZE = 20;
/** 启动延迟：避开启动/注册表解析/首屏取页高峰。 */
export const SELF_CHECK_START_DELAY_MS = 90_000;
/** 分片：每片源数与片间间隔（错峰，不抢占用户取页）。 */
export const SELF_CHECK_SHARD_SIZE = 3;
export const SELF_CHECK_SHARD_INTERVAL_MS = 45_000;
/** 结果新鲜期：全量一轮一天最多一次的落点（逐源判）。 */
export const SELF_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
/** 自检协议版本（指纹维度一）：探测步骤/段位构成/失败分类口径
 * 变更时 bump。v1＝fix331 全链口径（列表＋详情＋品类末段、每源
 * 预算 3）；现行 v2（2026-11-20 fix335/selfcheck-paging）＝v1
 * ＋分页信号一致性抽查段（每源预算 4）——v1 结果无抽查段，按
 * 指纹不符判过期补探；落盘读入时其抽查段归一 skipped（见
 * pagingFieldsOf），不丢弃。 */
export const SELF_CHECK_PROTOCOL_VERSION = 2;
/** 适配器纪元（指纹维度二）：适配器取页/解析行为（adapters/ 下
 * 模板、解析、内置参数形态）变更到可能改变探测结论时 bump。
 * 纯 UI/文案/展示变更不许 bump——那正是本维度要放行的更新。
 * v2（2026-11-20 fix335/a-pagination）：分页信号派生改版（真信号
 * 优先＋满页推断、HTML 整页消费删 slice、WP 越界 400 收尾）——
 * 列表段条目数口径随之变化，旧纪元自检结果按过期补探。 */
export const SELF_CHECK_ADAPTER_EPOCH = 2;
/** 最近打开记录落盘键（hghubx_*，不变量 7）：源 id → 最近一次
 * 进入其浏览面的时刻；只记 id/时刻（不变量 10），供批量补探
 * 排序（M7）。 */
export const SOURCE_LAST_VIEW_STORAGE_KEY = "hghubx_source_last_view_v1";

export type SelfCheckFailureKind = "网络类" | "HTTP 状态" | "解析为空" | "详情失败" | "取流失败" | "其他";
export type SelfCheckDetailState = "ok" | "fail" | "skipped";
/** 分页抽查段状态：ok＝第 2 页可达、非空、与第 1 页不全同；
 * fail＝信号说谎/分页失效（形态见 pagingFailure）；na＝信号称
 * 单页、不适用（未抽查、不冒充通过）；skipped＝列表失败无从
 * 抽查，或结果由旧协议口径产出（读入归一，见 pagingFieldsOf）。 */
export type SelfCheckPagingState = "ok" | "fail" | "na" | "skipped";
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
  /** 分页抽查段（协议 v2 新增）：第 1 页信号称有下一页时多取
   * 第 2 页核对一致性；状态口径见 SelfCheckPagingState。 */
  paging: SelfCheckPagingState;
  pagingFailure: SelfCheckFailureKind | null;
  /** skipped＝列表失败或列表真空、无从探详情。 */
  detail: SelfCheckDetailState;
  detailFailure: SelfCheckFailureKind | null;
  /** 末段（品类第三段）：skipped＝前段失败/无条目/该品类无末段。 */
  tail: SelfCheckTailState;
  tailKind: SelfCheckTailKind | null;
  tailFailure: SelfCheckFailureKind | null;
  /** 探测时的自检协议版本（指纹维度一，见文件头指纹节）。 */
  protocolVersion: number;
  /** 探测时的适配器纪元（指纹维度二）。迁移哨兵 0＝旧结果的适
   * 配器身份无法证实，永不命中现行纪元。 */
  adapterEpoch: number;
  /** 探测时该源的适配器切片指纹（指纹维度三，selfCheckSourceScope
   * 派生）。迁移哨兵空串＝旧结果的该源切片无法证实未变。 */
  sourceScope: string;
  /** 本次自检的适配器调用数（≤ 硬预算）。口径（唯一定义，fix333-m5
   * O2）：列表/分页抽查/详情/取流四次适配器调用各计 1，与 HTTP 请求数不是
   * 一回事——一次调用内可含多次 HTTP（如 002 取流一次调用含 CSRF
   * 取令牌 GET＋握手 POST 共 2 次 HTTP、计 1；010 取流含详情页＋
   * 下载页两取、计 1）。旧口径只叫「请求数」，与真实网络量对不上、
   * 判读易误读；诊断呈现恒带「适配器调用口径」标注（见
   * selfCheckSegmentText/selfCheckDiagLines）。 */
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

/* ── 结果指纹三维（2026-11-20 fix333/m7-selfcheck，见文件头） ── */

function fnv1aHex(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnv1a:${(h >>> 0).toString(16)}`;
}

/** 源切片指纹（纯函数，指纹维度三）：只取该源「适配器相关」的
 * 切片——模板、品类、源种类、取页模式、候选基址、生效参数
 * （含清单热下发覆盖后的值，getActiveRegistry 的 def 即生效
 * 形态）。清单整体版本、显示名、备注、注册表序、启用/成熟度
 * 都不进切片：前者与该源探测结论无关（无关变更不连坐作废），
 * 后几者是展示/资格维度、不是探测结论的身份。参数序列化与
 * adapterParams.fingerprintParams 同口径（键排序＋逐键 JSON）。 */
export function selfCheckSourceScope(def: SourceDef): string {
  const params = def.adapter.params ?? {};
  const paramText = Object.keys(params).sort()
    .map((k) => `${k}=${JSON.stringify(params[k])}`)
    .join("&");
  return fnv1aHex([
    def.adapter.template, def.category, def.kind, def.network.mode,
    def.baseUrls.join(","), paramText,
  ].join("|"));
}

export interface SelfCheckFingerprint {
  protocolVersion: number;
  adapterEpoch: number;
  sourceScope: string;
}

/** 某源的现行指纹（纯函数）：协议/纪元为全局常量、切片按源派生。 */
export function selfCheckFingerprintFor(def: SourceDef): SelfCheckFingerprint {
  return {
    protocolVersion: SELF_CHECK_PROTOCOL_VERSION,
    adapterEpoch: SELF_CHECK_ADAPTER_EPOCH,
    sourceScope: selfCheckSourceScope(def),
  };
}

/** 结果指纹与该源现行指纹是否全维命中（纯函数）：def 缺失（源
 * 已不在注册表）时无从证实切片未变 → 不命中。 */
export function selfCheckFingerprintMatches(r: SourceSelfCheckResult, def: SourceDef | undefined): boolean {
  if (!def) return false;
  const fp = selfCheckFingerprintFor(def);
  return r.protocolVersion === fp.protocolVersion
    && r.adapterEpoch === fp.adapterEpoch
    && r.sourceScope === fp.sourceScope;
}

/** 本轮探测名单（纯函数）：合格且需要补探的源，按注册表 order
 * 序。需要补探的口径与浏览面补探共用 selfCheckNeedsProbe 一处。 */
export function buildSelfCheckPlan(
  sources: SourceDef[],
  results: Record<string, SourceSelfCheckResult>,
  now: number,
): SourceDef[] {
  return sources
    .filter((s) => selfCheckNeedsProbe(s, results, now))
    .sort((a, b) => a.order - b.order);
}

/** 是否需要（补）探（纯函数）：合格 ∧（无结果 ∨ 结果已过期）。
 * 过期口径与派生 classifySelfCheckResult 的 stale 同源——超 TTL
 * 或指纹三维任一不符（协议/纪元/该源切片）即过期。 */
export function selfCheckNeedsProbe(
  def: SourceDef,
  results: Record<string, SourceSelfCheckResult>,
  now: number,
): boolean {
  if (!selfCheckEligible(def)) return false;
  const r = results[def.id];
  if (!r) return true;
  return classifySelfCheckResult(r, def, now).stale;
}

/* ── 源健康单一派生（2026-11-20 用户裁定：全 App 只此一处） ──
 * 展示面（切换器/总览徽标）、诊断（行组计数/App 内明细）与补探
 * 触发都只读本派生，不许再各读静态 maturity 或原始结果拼口径。 */

export type SourceHealthStatus = "unchecked" | "ok" | "partial" | "down";

export interface SourceHealthCore {
  status: SourceHealthStatus;
  /** 结果已过期（超 TTL 或指纹三维任一不符）：结论仅供参考、不冒充新鲜。 */
  stale: boolean;
  at: number | null;
  /** partial/down 时出问题的段名（列表/分页/详情/取流/正文/图集/列表为空）。 */
  segment: string | null;
  failure: SelfCheckFailureKind | null;
}

/** 四态派生（纯函数）：未自检＝无结果；可用＝全链（列表＋分页
 * 抽查＋详情＋品类末段）通；部分可用＝前段通、某深段死或无从
 * 验证（注明段）；不可用＝列表段即死。分页抽查标不适用（单页
 * 源）不降级——不适用不是失败。 */
export function classifySelfCheckResult(
  r: SourceSelfCheckResult | undefined,
  def: SourceDef | undefined,
  now: number,
): SourceHealthCore {
  if (!r) return { status: "unchecked", stale: false, at: null, segment: null, failure: null };
  const stale = now - r.at >= SELF_CHECK_TTL_MS || !selfCheckFingerprintMatches(r, def);
  if (!r.listOk) return { status: "down", stale, at: r.at, segment: "列表", failure: r.listFailure };
  if (r.paging === "fail") return { status: "partial", stale, at: r.at, segment: "分页", failure: r.pagingFailure };
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
): string | undefined {
  const core = classifySelfCheckResult(result, def, now);
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
  lastViewedCache = null;
}

function currentStorage(): SelfCheckStorageLike | null {
  return storageOverride !== undefined ? storageOverride : defaultStorage();
}

/** 结果核心＋末段字段形状（新旧指纹格式共用部分）：末段为全链
 * 格式要件——无末段的结果（只探列表/详情的远古格式）按 fix331
 * 口径读入即丢弃，它们等于没探过、不许冒充已检。 */
function hasSelfCheckCoreShape(r: Record<string, unknown>): boolean {
  return typeof r.sourceId === "string" && r.sourceId !== ""
    && typeof r.at === "number" && Number.isFinite(r.at)
    && typeof r.listOk === "boolean"
    && typeof r.itemCount === "number"
    && (r.detail === "ok" || r.detail === "fail" || r.detail === "skipped")
    && (r.tail === "ok" || r.tail === "fail" || r.tail === "skipped")
    && (r.tailKind === "stream" || r.tailKind === "body" || r.tailKind === "gallery" || r.tailKind === null)
    && typeof r.requests === "number";
}

function isSelfCheckResult(x: unknown): x is SourceSelfCheckResult {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return hasSelfCheckCoreShape(r)
    && typeof r.protocolVersion === "number" && Number.isFinite(r.protocolVersion)
    && typeof r.adapterEpoch === "number" && Number.isFinite(r.adapterEpoch)
    && typeof r.sourceScope === "string";
}

const SELF_CHECK_FAILURE_KINDS: readonly SelfCheckFailureKind[] = ["网络类", "HTTP 状态", "解析为空", "详情失败", "取流失败", "其他"];

/** 分页抽查段读入归一（协议 v1 结果无本段）：字段缺失/非法一律
 * 归一 skipped——旧口径未抽查过，不冒充通过、也不冒充不适用；
 * 协议版本不符本身会判其过期、待补探刷新（见文件头指纹节）。
 * fail 形态只认封闭形态集，非法值归 null（呈现退化为裸失败）。 */
function pagingFieldsOf(r: SourceSelfCheckResult): { paging: SelfCheckPagingState; pagingFailure: SelfCheckFailureKind | null } {
  const raw = r as { paging?: unknown; pagingFailure?: unknown };
  const paging: SelfCheckPagingState = raw.paging === "ok" || raw.paging === "fail" || raw.paging === "na" || raw.paging === "skipped"
    ? raw.paging
    : "skipped";
  const pagingFailure = paging === "fail"
    && typeof raw.pagingFailure === "string"
    && SELF_CHECK_FAILURE_KINDS.includes(raw.pagingFailure as SelfCheckFailureKind)
    ? (raw.pagingFailure as SelfCheckFailureKind)
    : null;
  return { paging, pagingFailure };
}

/** 旧两维指纹结果（fix331 格式：全链字段＋清单版本＋App 版本）。 */
interface LegacySelfCheckResult extends Omit<SourceSelfCheckResult, "protocolVersion" | "adapterEpoch" | "sourceScope"> {
  manifestVersion: number;
  appVersion: string;
}

function isLegacySelfCheckResult(x: unknown): x is LegacySelfCheckResult {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return hasSelfCheckCoreShape(r)
    && typeof r.manifestVersion === "number" && Number.isFinite(r.manifestVersion)
    && typeof r.appVersion === "string" && r.appVersion !== "";
}

/** 旧指纹结果迁移（逐条按新口径判定去留、不无条件全丢）：
 * - 协议版本：能通过全链形状校验的旧结果都由现行全链口径产
 *   出，按 SELF_CHECK_PROTOCOL_VERSION 认定；其分页抽查段是
 *   协议 v2 才有的段，旧结果从未抽查过——归一 skipped 如实标
 *   记未探，不随协议认定冒充已抽查；
 * - 适配器纪元：旧结果只带 App 版本作适配器身份——与当前 App
 *   版本相同即同一份适配器代码、按现行纪元认定；不同则无法
 *   证实适配器未变，给哨兵 0（判过期、待重探，但不丢弃）；
 * - 源切片：旧结果只带清单整体版本——与当前清单版本相同即
 *   整份清单未变、该源切片按现行 def 认定；不同则无法重构旧
 *   切片，给哨兵空串（同上）。
 * 迁移只在读入时做；下一次落盘经 saveSelfCheckResult 合并写
 * 回，存储里自然换成新格式。 */
function migrateLegacyResult(r: LegacySelfCheckResult): SourceSelfCheckResult {
  const sameApp = r.appVersion === getRegistryInfo().appVersion;
  const sameManifest = r.manifestVersion === getActiveRegistry().manifestVersion;
  const def = getActiveRegistry().sources.find((s) => s.id === r.sourceId);
  return {
    sourceId: r.sourceId, at: r.at, listOk: r.listOk, itemCount: r.itemCount,
    listFailure: r.listFailure, paging: "skipped", pagingFailure: null,
    detail: r.detail, detailFailure: r.detailFailure,
    tail: r.tail, tailKind: r.tailKind, tailFailure: r.tailFailure,
    protocolVersion: SELF_CHECK_PROTOCOL_VERSION,
    adapterEpoch: sameApp ? SELF_CHECK_ADAPTER_EPOCH : 0,
    sourceScope: sameManifest && def ? selfCheckSourceScope(def) : "",
    requests: r.requests,
  };
}

function loadFrom(storage: SelfCheckStorageLike | null): Record<string, SourceSelfCheckResult> {
  try {
    const raw = storage?.getItem(SELF_CHECK_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, SourceSelfCheckResult> = {};
    for (const [k, v] of Object.entries(parsed ?? {})) {
      if (isSelfCheckResult(v) && v.sourceId === k) out[k] = { ...v, ...pagingFieldsOf(v) };
      else if (isLegacySelfCheckResult(v) && v.sourceId === k) out[k] = migrateLegacyResult(v);
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

/* ── 最近打开记录（M7 补探排序信号）：源 id → 最近一次进入其
 * 浏览面的时刻。与自检结果同存储绑定（bindSelfCheckStorage 一
 * 并重置缓存，契约可注入假存储模拟重启）。全程旁路：记录失败
 * 吞掉——排序信号缺失只退化为注册表序，不影响浏览与补探。 ── */

let lastViewedCache: Record<string, number> | null = null;

function loadLastViewedFrom(storage: SelfCheckStorageLike | null): Record<string, number> {
  try {
    const raw = storage?.getItem(SOURCE_LAST_VIEW_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed ?? {})) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch { return {}; }
}

/** 读全部最近打开记录（带进程内缓存）。 */
export function getSourceLastViewed(): Record<string, number> {
  if (lastViewedCache === null) lastViewedCache = loadLastViewedFrom(currentStorage());
  return lastViewedCache;
}

/** 记一次「打开某源浏览面」（浏览面钩子调用）：更新缓存并落盘。 */
export function recordSourceView(sourceId: string, at: number = Date.now()): void {
  try {
    const all = { ...getSourceLastViewed(), [sourceId]: at };
    lastViewedCache = all;
    currentStorage()?.setItem(SOURCE_LAST_VIEW_STORAGE_KEY, JSON.stringify(all));
  } catch { /* 旁路：记录失败不影响浏览 */ }
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
}

/** 单源自检：列表 1 页（记成败＋条目数），信号称有下一页时抽
 * 查第 2 页 1 页（记一致性，见文件头「分页抽查」），有条目再取
 * 1 条详情（记可达/失败），详情可达后按品类补末段——视频类抽
 * 同 1 条目续探 1 次取流（只取流不播放，零流记失败）；posts
 * 正文段与 image 图集段复用详情响应判定（正文 HTML/图集图数
 * 为空记解析为空）。全程 ≤ SELF_CHECK_MAX_REQUESTS_PER_SOURCE
 * 个请求——本函数只有 list（第 1 页与抽查第 2 页）/detail/
 * resolve 四处调用点，结构上不可能超预算。本函数不抛错：一
 * 切失败都收敛成结果里的失败形态。 */
export async function runSourceSelfCheck(def: SourceDef, deps: SelfCheckEngineDeps): Promise<SourceSelfCheckResult> {
  const base: SourceSelfCheckResult = {
    sourceId: def.id, at: deps.now(), listOk: false, itemCount: 0,
    listFailure: null, paging: "skipped", pagingFailure: null,
    detail: "skipped", detailFailure: null,
    tail: "skipped", tailKind: selfCheckTailKindFor(def), tailFailure: null,
    ...selfCheckFingerprintFor(def),
    requests: 0,
  };
  let adapter: SourceAdapter | null = null;
  try { adapter = deps.createAdapterFor(def); } catch { adapter = null; }
  if (!adapter) return { ...base, listFailure: "其他" };
  let firstId: string | null = null;
  let firstPage: Awaited<ReturnType<SourceAdapter["list"]>> | null = null;
  try {
    base.requests += 1;
    const page = await adapter.list(1, SELF_CHECK_LIST_PAGE_SIZE);
    base.listOk = true;
    base.itemCount = page.items.length;
    firstId = page.items[0]?.externalId ?? null;
    firstPage = page;
  } catch (e) {
    base.listFailure = selfCheckFailureKind(e, "list");
    return base;
  }
  /* 分页抽查（协议 v2）：判据与三套 UI 的停拉口径同一黑盒信号
   * （pagination.pages＞当前页）。抽查失败只落本段：不翻列表
   * 结论、不阻断详情/末段（各段分开记）。 */
  if (firstPage && firstPage.pagination.pages > firstPage.pagination.page) {
    const firstIds = new Set(firstPage.items.map((it) => it.externalId));
    try {
      base.requests += 1;
      const page2 = await adapter.list(2, SELF_CHECK_LIST_PAGE_SIZE);
      if (page2.items.length === 0) {
        base.paging = "fail";
        base.pagingFailure = "解析为空";
      } else if (page2.items.every((it) => firstIds.has(it.externalId))) {
        base.paging = "fail";
        base.pagingFailure = "其他"; // 第 2 页与第 1 页全同＝信号说谎或分页失效
      } else {
        base.paging = "ok";
      }
    } catch (e) {
      base.paging = "fail";
      base.pagingFailure = selfCheckFailureKind(e, "list");
    }
  } else if (firstPage) {
    base.paging = "na"; // 信号称单页：不适用，不多取页、不冒充通过
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
  /** 批量补探排序：本面当前选中源 id（最先探；单源补探不读）。 */
  selectedId?: string | null;
  /** 批量补探排序：最近打开时刻表（缺省读落盘记录
   * getSourceLastViewed；契约注入用）。 */
  lastViewedAt?: Record<string, number>;
}

/** 启动一次单源补探（单源/批量补探共用核心）：需要补探∧不在飞
 * 才启动；返回补探完成承诺（不 reject），未启动返回 null。完成
 * 经 saveSelfCheckResult 落盘并通知订阅刷新徽标。 */
function launchTopUp(def: SourceDef, deps: SelfCheckTopUpDeps): Promise<void> | null {
  try {
    const now = (deps.now ?? (() => Date.now()))();
    if (!selfCheckNeedsProbe(def, getSelfCheckResults(), now)) return null;
    if (topUpInFlight.has(def.id)) return null;
    topUpInFlight.add(def.id);
    return runSourceSelfCheck(def, { createAdapterFor: deps.createAdapterFor, now: () => now })
      .then((result) => { saveSelfCheckResult(result); })
      .catch(() => { /* 旁路：补探失败不影响浏览 */ })
      .finally(() => { topUpInFlight.delete(def.id); });
  } catch {
    return null;
  }
}

/** 单源补探：结果缺失/已过期/指纹不符才跑（selfCheckNeedsProbe
 * 口径与全量计划同源），在飞去重；完成经 saveSelfCheckResult 落盘
 * 并通知订阅刷新徽标。返回是否真正启动了一次补探。全程旁路：
 * 任何异常吞掉、不抛、不打扰用户。 */
export function ensureSourceSelfCheck(def: SourceDef, deps: SelfCheckTopUpDeps): boolean {
  return launchTopUp(def, deps) !== null;
}

/* ── 展示面批量补探（2026-11-20 fix333/selfcheck-trigger） ──
 * 缺口（3.3.2 真机验收）：补探此前只挂三浏览面、且只探当前选中
 * 的单个源；用户看状态的总览行与切换器只读派生不触发——刚升级
 * 或从未点开过的源在总览长期挂「未实测」，正是用户 2026-11-20
 * 01:02 定的核心痛点。本入口供展示面挂载时对其展示的源批量
 * 补探：判定/去重/资格/每源预算与单源补探全同（launchTopUp 一
 * 处），不另起调度。额外纪律是串行节制：名单内逐个启动并等
 * 其落盘才探下一个、多个展示面同挂载经模块级链依次排队——
 * 任一时刻至多 1 个补探在飞，进页面不打满请求；后到批次启动
 * 时先行结果多已落盘，launchTopUp 按新鲜口径自然跳过。后到/
 * 重复挂载零重探。返回实际启动的补探数；全程旁路、不
 * reject、不阻塞渲染。
 *
 * 启动序（2026-11-20 fix333/m7-selfcheck M7）：进队列前先经
 * orderTopUpCandidates 按「选中源 > 最近打开 > 注册表序」重
 * 排——此前纯注册表序，全量失效时靠后的源最晚刷新，而用户正
 * 在看的源未必排在前面。排序只动启动序，串行/去重/预算不变。 */

let topUpBatchChain: Promise<unknown> = Promise.resolve();

export interface TopUpOrderContext {
  /** 本面当前选中源 id（最先探）。 */
  selectedId?: string | null;
  /** 源 id → 最近打开时刻（缺失＝从未打开）。 */
  lastViewedAt?: Record<string, number>;
}

/** 批量补探排序（纯函数）：选中源最先；其余最近打开过的在前
 * （时刻倒序）；从未打开过的最后。三层内同级按注册表 order
 * 序。不改动入参顺序（返回新数组）。 */
export function orderTopUpCandidates(
  defs: readonly SourceDef[],
  ctx: TopUpOrderContext = {},
): SourceDef[] {
  const selectedId = ctx.selectedId ?? null;
  const viewed = ctx.lastViewedAt ?? {};
  return [...defs].sort((a, b) => {
    const selA = a.id === selectedId ? 0 : 1;
    const selB = b.id === selectedId ? 0 : 1;
    if (selA !== selB) return selA - selB;
    const atA = viewed[a.id] ?? 0;
    const atB = viewed[b.id] ?? 0;
    if (atA !== atB) return atB - atA;
    return a.order - b.order;
  });
}

export function ensureSourcesSelfCheck(defs: readonly SourceDef[], deps: SelfCheckTopUpDeps): Promise<number> {
  const run = async (): Promise<number> => {
    let started = 0;
    const seen = new Set<string>();
    const unique: SourceDef[] = [];
    for (const def of defs) {
      if (seen.has(def.id)) continue;
      seen.add(def.id);
      unique.push(def);
    }
    const ordered = orderTopUpCandidates(unique, {
      selectedId: deps.selectedId,
      lastViewedAt: deps.lastViewedAt ?? getSourceLastViewed(),
    });
    for (const def of ordered) {
      const pending = launchTopUp(def, deps);
      if (pending) {
        started += 1;
        await pending;
      }
    }
    return started;
  };
  const result = topUpBatchChain.then(run, run);
  topUpBatchChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
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

/* ── 诊断呈现构建（导出路径的逐源行经 selfCheckDiagLines 消费，
 * 口径在此一处） ── */

function timeText(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}

/** 单源自检段：恒带「最近自检」口径标注。三段逐段呈现：末段失败单独成
 * 句——取流/正文/图集死在这里必须看得见，不许被「详情可达」盖住。
 * 段尾恒缀请求数＋口径标注（fix333-m5 O2）：requests 是适配器调用
 * 口径（定义见结果字段），不许裸数字出门被误读为 HTTP 请求数。 */
export function selfCheckSegmentText(r: SourceSelfCheckResult): string {
  return `${selfCheckSegmentBody(r)} · 请求 ${r.requests} 次（适配器调用口径）`;
}

/** 分页抽查段呈现子句：失败明示形态（全同的「其他」是残余类、
 * 不缀字面）、不适用明示单页口径；通过/跳过不另缀——通过已由
 * 「可用」结论与调用数承载，跳过只发生在列表已失败（主句已明
 * 示）或旧协议结果（过期标注已明示）。 */
function pagingSegmentClause(r: SourceSelfCheckResult): string {
  if (r.paging === "fail") {
    const kind = r.pagingFailure && r.pagingFailure !== "其他" ? `·${r.pagingFailure}` : "";
    return ` · 分页抽查失败${kind}`;
  }
  if (r.paging === "na") return " · 分页抽查不适用（单页）";
  return "";
}

function selfCheckSegmentBody(r: SourceSelfCheckResult): string {
  const t = timeText(r.at);
  if (!r.listOk) return `最近自检 失败·${r.listFailure ?? "其他"} · 详情未探（${t}）`;
  let body: string;
  if (r.detail === "fail") {
    const kind = r.detailFailure && r.detailFailure !== "详情失败" ? `·${r.detailFailure}` : "";
    body = `最近自检 列表 ${r.itemCount} 条 · 详情失败${kind}（${t}）`;
  } else if (r.detail === "ok") {
    const label = tailSegmentLabel(r.tailKind);
    if (r.tail === "fail") {
      const kind = r.tailFailure && r.tailFailure !== "取流失败" ? `·${r.tailFailure}` : "";
      body = `最近自检 列表 ${r.itemCount} 条 · 详情可达 · ${label}失败${kind}（${t}）`;
    } else if (r.tail === "ok") {
      body = `最近自检 成功 · 列表 ${r.itemCount} 条 · 详情可达 · ${label}可达（${t}）`;
    } else {
      body = `最近自检 成功 · 列表 ${r.itemCount} 条 · 详情可达（${t}）`;
    }
  } else {
    body = `最近自检 成功 · 列表 ${r.itemCount} 条 · 详情未探（无条目）（${t}）`;
  }
  return body + pagingSegmentClause(r);
}

/** 导出路径的自检行组：汇总一行＋有结果的源逐源一行（稳定编号、
 * 零业务名，与 sourceHealthLines 既有口径一致）；无结果源只计数
 * 「未自检」，不冒充本会话取页的「未发生」。汇总计数走单一派生
 * （classifySelfCheckResult 四态）——取流段死的源计「部分可用」，
 * 不再计「通过」。调用方（registryDiag）负责只传自检合格源，
 * 「未自检」分母不含未启用/不合格源。过期结果逐源行缀明示。 */
export function selfCheckDiagLines(
  sources: { id: string; stableId: string; def?: SourceDef }[],
  results: Record<string, SourceSelfCheckResult>,
  now: number = Date.now(),
): string[] {
  let ok = 0;
  let partial = 0;
  let down = 0;
  const per: string[] = [];
  for (const s of sources) {
    const r = results[s.id];
    const core = classifySelfCheckResult(r, s.def, now);
    if (!r || core.status === "unchecked") continue;
    if (core.status === "ok") ok += 1;
    else if (core.status === "partial") partial += 1;
    else down += 1;
    per.push(`自检 ${s.stableId}：${selfCheckSegmentText(r)}${core.stale ? " · 结果已过期" : ""}`);
  }
  const checked = ok + partial + down;
  return [
    `源自检（最近自检口径，与本会话取页分开）：已检 ${checked} · 可用 ${ok} · 部分可用 ${partial} · 不可用 ${down} · 未自检 ${sources.length - checked} · 请求数＝适配器调用口径（列表/分页抽查/详情/取流各计 1，一次调用内可含多次 HTTP）`,
    ...per,
  ];
}
