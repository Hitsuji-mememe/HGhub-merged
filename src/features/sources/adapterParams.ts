/* ── 清单参数下发（Muse 2026-11-19 fix321-F8 新立项「适配器抗失效」）──
 * 背景：站点改域名/改结构此前只能靠发版修。本模块给 hls-site 模板源
 * 建「清单参数下发」通道：远程清单以声明式参数（adapterParams）下发
 * 模板参数，客户端 schema 校验后覆盖生效，应用后经 F7 式自检验证、
 * 变坏自动回滚内置参数。wp-rest/chigua 模板本批不扩（其参数形态与
 * 校验口径不同，留后续批次）。
 *
 * 红线（与 manifest.ts 既有通道的关系）：
 * ① 只许声明式参数，绝不引入远程代码执行：可下发字段冻结为
 *    hls-site 模板现行 params 字段——listPath / itemLinkPattern /
 *    detailPath（templates.ts 的 htmlListAdapter 消费 listPath 与
 *    itemLinkPattern；detailPath 为注册表全 hls-site 源声明的参数
 *    字段）。取流提取（parse.ts 的 extractM3u8/extractMp4）是固定
 *    正则、模板不消费任何参数字段，故不设取流下发字段——不许发明
 *    模板不消费的字段。baseUrls 走 manifest 既有通道、归入本机制
 *    口径（同为声明式下发、同受 https 起点校验）。
 * ② 不放宽既有安全校验：路径须相对路径形态（以 / 起头、无 scheme、
 *    非协议相对），禁 javascript:/data: 等危险形态；长度上限。
 * ③ 参数不得改变源的 enabled/maturity（既有通道与人工口径），
 *    名单冻结不变（只给已注册源、且仅 hls-site 模板生效）。
 * ④ 静默：应用/回滚零用户可见打扰，只落盘＋进诊断呈现。
 * ⑤ 与既有「整份丢弃」口径的差异（有意为之）：enabled/baseUrls 等
 *    既有字段非法仍整份丢弃（熔断/域名是安全面，宁可全退）；单个
 *    条目的 adapterParams 非法只丢该条目参数——参数是增益面，坏参数
 *    退回内置即安全，没理由连同整份清单的熔断/改域名覆盖一起丢。
 *
 * 状态机（落盘 hghubx_adapter_params_v1，不变量 7）：
 *   applyManifest 覆盖生效 → 记 applied 快照（status=pending）
 *   → 启动后 verifyAppliedAdapterParams 对 pending 源跑一次自检：
 *     应用前自检为好（或未知）且应用后变坏（列表失败/解析为空）
 *       → 回滚内置参数（revertSource 生效点）＋记 rejected 版本，
 *         同 paramsVersion 此后不再应用（防抖动循环）；
 *     自检通过（或应用前已坏、非本次变坏）→ status=applied 保留。
 */

import type { SourceDef } from "./types.ts";
import type { SourceSelfCheckResult } from "./healthCheck.ts";

export const ADAPTER_PARAMS_STORAGE_KEY = "hghubx_adapter_params_v1";

/** 可下发字段冻结集（见文件头①）。 */
export const ADAPTER_PARAM_FIELDS = ["listPath", "itemLinkPattern", "detailPath"] as const;
export type AdapterParamField = (typeof ADAPTER_PARAM_FIELDS)[number];
export type AdapterParams = Partial<Record<AdapterParamField, string>>;

export const MAX_PARAM_PATH_LENGTH = 256;
export const MAX_PARAM_PATTERN_LENGTH = 128;

const DANGEROUS_SCHEME = /(?:javascript|data|vbscript|file|blob)\s*:/i;

/** 单字段形态校验：路径类（listPath/detailPath）须相对路径形态；
 * 图案类（itemLinkPattern）为 href 子串匹配片段，只禁危险形态。 */
function validParamValue(field: AdapterParamField, value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (/[\u0000-\u0020\\]/.test(value)) return false; // 控制符/空白/反斜杠一律拒
  if (DANGEROUS_SCHEME.test(value)) return false;
  if (value.includes("://")) return false;
  if (field === "itemLinkPattern") return value.length <= MAX_PARAM_PATTERN_LENGTH;
  if (!value.startsWith("/") || value.startsWith("//")) return false; // 相对路径形态
  return value.length <= MAX_PARAM_PATH_LENGTH;
}

/** adapterParams schema 校验（纯函数）：合法 → 归一化参数对象；
 * 任一字段非法/未知字段/空对象 → null（调用方只丢该条目参数）。 */
export function validateAdapterParams(raw: unknown): AdapterParams | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return null;
  const out: AdapterParams = {};
  for (const [k, v] of entries) {
    if (!(ADAPTER_PARAM_FIELDS as readonly string[]).includes(k)) return null;
    if (!validParamValue(k as AdapterParamField, v)) return null;
    out[k as AdapterParamField] = v as string;
  }
  return out;
}

/** 内置参数指纹（FNV-1a，稳定可复现）：快照里记基线身份，回滚与
 * 诊断据此确认「回滚目标＝出厂内置参数」，不记参数明文之外的信息。 */
export function fingerprintParams(params: Record<string, unknown> | undefined): string {
  const keys = Object.keys(params ?? {}).sort();
  const text = keys.map((k) => `${k}=${JSON.stringify((params ?? {})[k])}`).join("&");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnv1a:${(h >>> 0).toString(16)}`;
}

/* ── 落盘状态（hghubx_* 键；进程重启后回滚防抖与诊断继续成立） ── */

export interface AppliedParamsRecord {
  sourceId: string;
  paramsVersion: number;
  params: AdapterParams;
  appliedAt: number;
  /** 应用前内置 adapter.params 的指纹（基线身份）。 */
  builtinFingerprint: string;
  status: "pending" | "applied" | "rolled-back";
}

export interface AdapterParamsState {
  applied: Record<string, AppliedParamsRecord>;
  /** 已回滚的 paramsVersion（per-source）：同版本不再重复应用。 */
  rejected: Record<string, number[]>;
}

export interface AdapterParamsStorageLike {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
}

function defaultStorage(): AdapterParamsStorageLike | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

let storageOverride: AdapterParamsStorageLike | null | undefined;
let stateCache: AdapterParamsState | null = null;

/** 绑定存储（生产默认 localStorage；契约测试注入假存储模拟重启）。 */
export function bindAdapterParamsStorage(storage: AdapterParamsStorageLike | null): void {
  storageOverride = storage;
  stateCache = null;
}

function currentStorage(): AdapterParamsStorageLike | null {
  return storageOverride !== undefined ? storageOverride : defaultStorage();
}

function isAppliedRecord(x: unknown): x is AppliedParamsRecord {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return typeof r.sourceId === "string" && r.sourceId !== ""
    && typeof r.paramsVersion === "number" && Number.isInteger(r.paramsVersion)
    && typeof r.appliedAt === "number" && Number.isFinite(r.appliedAt)
    && typeof r.builtinFingerprint === "string"
    && (r.status === "pending" || r.status === "applied" || r.status === "rolled-back")
    && validateAdapterParams(r.params) !== null;
}

function loadState(): AdapterParamsState {
  if (stateCache !== null) return stateCache;
  const empty: AdapterParamsState = { applied: {}, rejected: {} };
  try {
    const raw = currentStorage()?.getItem(ADAPTER_PARAMS_STORAGE_KEY);
    if (!raw) { stateCache = empty; return stateCache; }
    const parsed = JSON.parse(raw) as { applied?: Record<string, unknown>; rejected?: Record<string, unknown> };
    const applied: Record<string, AppliedParamsRecord> = {};
    for (const [k, v] of Object.entries(parsed.applied ?? {})) {
      if (isAppliedRecord(v) && v.sourceId === k) applied[k] = v;
    }
    const rejected: Record<string, number[]> = {};
    for (const [k, v] of Object.entries(parsed.rejected ?? {})) {
      if (Array.isArray(v)) rejected[k] = v.filter((n): n is number => typeof n === "number" && Number.isInteger(n));
    }
    stateCache = { applied, rejected };
  } catch { stateCache = empty; }
  return stateCache;
}

function saveState(state: AdapterParamsState): void {
  stateCache = state;
  try { currentStorage()?.setItem(ADAPTER_PARAMS_STORAGE_KEY, JSON.stringify(state)); } catch { /* 落盘失败不影响应用本身 */ }
}

export function getAdapterParamsState(): AdapterParamsState {
  return loadState();
}

export function isParamsVersionRejected(sourceId: string, paramsVersion: number): boolean {
  return (loadState().rejected[sourceId] ?? []).includes(paramsVersion);
}

/** 记已应用快照（applyManifest 覆盖生效点调用）：同源同版本且参数
 * 相同则保留原状态（不把已确认 applied 打回 pending）；新版本/新
 * 参数记 pending、待启动后自检验证。旁路：失败吞掉。 */
export function recordAppliedParams(rec: Omit<AppliedParamsRecord, "status">): void {
  try {
    const state = loadState();
    const prev = state.applied[rec.sourceId];
    if (prev && prev.paramsVersion === rec.paramsVersion
      && fingerprintParams(prev.params as Record<string, unknown>) === fingerprintParams(rec.params as Record<string, unknown>)) {
      return;
    }
    saveState({
      ...state,
      applied: { ...state.applied, [rec.sourceId]: { ...rec, status: "pending" } },
    });
  } catch { /* 旁路 */ }
}

function setRecordStatus(sourceId: string, status: AppliedParamsRecord["status"]): void {
  const state = loadState();
  const prev = state.applied[sourceId];
  if (!prev) return;
  saveState({ ...state, applied: { ...state.applied, [sourceId]: { ...prev, status } } });
}

function markRejected(sourceId: string, paramsVersion: number): void {
  const state = loadState();
  const list = state.rejected[sourceId] ?? [];
  if (!list.includes(paramsVersion)) {
    saveState({ ...state, rejected: { ...state.rejected, [sourceId]: [...list, paramsVersion] } });
  }
  setRecordStatus(sourceId, "rolled-back");
}

/* ── 校验后自检与自动回滚（接缝全注入，测试不访问上游网络） ── */

export interface VerifyAdapterParamsDeps {
  /** 当前生效注册表（getActiveRegistry().sources）。 */
  getSources: () => SourceDef[];
  /** F7 式轻量自检（生产注入 healthCheck.runSourceSelfCheck 的接线）。 */
  runCheck: (def: SourceDef) => Promise<SourceSelfCheckResult>;
  /** 应用前该源最近自检结果（F7 落盘口径）；无记录＝未知。 */
  getPriorResult: (sourceId: string) => SourceSelfCheckResult | undefined;
  /** 回滚生效点：把 active 注册表中该源 adapter.params 复位内置。 */
  revertSource: (sourceId: string) => boolean;
  now: () => number;
}

/** 参数应用后验证（启动装配在 resolveRegistry 落定后调用，纯旁路）：
 * 只处理 status=pending 的已应用源——逐源跑一次自检（复用 F7 引擎
 * 语义，经 runCheck 接缝），应用前为好/未知且应用后列表失败（含解析
 * 为空）→ 回滚＋rejected；其余 → 确认 applied。全程静默、不抛错。 */
export async function verifyAppliedAdapterParams(deps: VerifyAdapterParamsDeps): Promise<{ confirmed: string[]; rolledBack: string[] }> {
  const confirmed: string[] = [];
  const rolledBack: string[] = [];
  try {
    const state = loadState();
    const byId = new Map(deps.getSources().map((s) => [s.id, s]));
    for (const rec of Object.values(state.applied)) {
      if (rec.status !== "pending") continue;
      const def = byId.get(rec.sourceId);
      if (!def) { setRecordStatus(rec.sourceId, "applied"); continue; } // 源已不在生效表：无从验证，不回滚不存在的东西
      /* 应用前结果必须先读：生产接线里 runCheck 会把验证结果落进
       * 同一自检存储，晚读就会把应用后结果误当应用前基线。 */
      const prior = deps.getPriorResult(rec.sourceId);
      let post: SourceSelfCheckResult;
      try { post = await deps.runCheck(def); } catch { continue; } // 自检本身异常：保留 pending，下轮再验
      const priorBad = prior !== undefined && !prior.listOk;
      const postBad = !post.listOk; // 列表失败/解析为空均收敛为 listOk=false（F7 口径）
      if (postBad && !priorBad) {
        if (deps.revertSource(rec.sourceId)) {
          markRejected(rec.sourceId, rec.paramsVersion);
          rolledBack.push(rec.sourceId);
          continue;
        }
      }
      setRecordStatus(rec.sourceId, "applied");
      confirmed.push(rec.sourceId);
    }
  } catch { /* 旁路：验证失败不影响使用 */ }
  return { confirmed, rolledBack };
}

/* ── 与 F7 联动定性：故障分类（纯函数） ──
 * 口径：hls-site 源的失败形态若落在「声明式参数能修」的范围——
 * 解析为空（listPath/itemLinkPattern 与新结构不符）、列表 HTTP 状态
 * （404 类：列表路径失效）、网络类（baseUrl 不可达：域名通道可修）
 * ——标「参数可热修」；其余一律「需发版」：非 hls-site 模板
 * （none/native/wp-rest/chigua/danbooru 的解析在代码里）、详情步
 * 失败（现行 hls-site 模板详情不消费可下发参数）、未分类失败
 * （其他：多为代码级解析/登录/取页契约问题）。无故障或无自检
 * 结果 → null（不标注，不冒充定性）。 */
export type SourceFaultClass = "参数可热修" | "需发版";

export function classifySourceFault(def: SourceDef, result: SourceSelfCheckResult | undefined): SourceFaultClass | null {
  if (!result) return null;
  const failed = !result.listOk || result.detail === "fail";
  if (!failed) return null;
  if (def.adapter.template !== "hls-site") return "需发版";
  if (!result.listOk && (result.listFailure === "解析为空" || result.listFailure === "HTTP 状态" || result.listFailure === "网络类")) {
    return "参数可热修";
  }
  return "需发版";
}

/** 诊断呈现段：参数来源一眼可读——清单 vN（已应用/待验证）或
 * 已回滚到的版本；无记录返回空串。原唯一生产消费者（registryDiag
 * App 内明细）已于 fix334/L4 随死面删除，本构建器保留契约覆盖，
 * 去留留清扫裁定。 */
export function adapterParamsSegmentText(sourceId: string, state: AdapterParamsState = loadState()): string {
  const rec = state.applied[sourceId];
  if (rec) {
    if (rec.status === "rolled-back") return `参数来源：清单 v${rec.paramsVersion} 已回滚（自检变坏、恢复内置）`;
    return `参数来源：清单 v${rec.paramsVersion}（${rec.status === "applied" ? "已应用" : "待验证"}）`;
  }
  const rejected = state.rejected[sourceId] ?? [];
  if (rejected.length) return `参数来源：内置（清单 v${rejected[rejected.length - 1]} 已回滚）`;
  return "";
}
