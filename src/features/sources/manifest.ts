/**
 * 远程清单（一级变更通道，Muse 2026-11-19 根治包·多源线 条目3）。
 *
 * 回退链：远程 JSON 清单 → last-good（localStorage 缓存）→ 内置注册表。
 * 清单只做覆盖层：按 id 覆盖 enabled（熔断位，可远程下线）与 baseUrls，
 * 不新增/删除源（名单冻结在内置注册表）。schema 校验不过即整份丢弃；
 * minAppVersion 高于当前 App 版本的清单不生效。
 * fix321-F8 起另有 adapterParams 参数下发（仅 hls-site）：其校验/应用/
 * 回滚状态机在 adapterParams.ts，参数非法只丢该条目参数（不整份丢）。
 *
 * getRegistryInfo() 导出路径：src/features/sources/manifest.ts
 * （诊断线接线点：版本号 + 每源生效 origin + 数据来源）。
 */
import { BUILTIN_SOURCES, getBuiltinRegistry } from "./registry.ts";
import type { SourceDef } from "./types.ts";
import {
  fingerprintParams,
  isParamsVersionRejected,
  recordAppliedParams,
  validateAdapterParams,
  type AdapterParams,
} from "./adapterParams.ts";

/** 远程清单 URL：全仓唯一集中点，改地址只改这一行。
 * 2026-11-19 最终版 D 线改址：旧 hghubx.pages.dev 项目不存在（DNS 不
 * 解析、悬空地址，根治包照上游项目名想当然所致），改走新建的
 * hghub-registry.pages.dev 托管；CSP 五处口径同步放行该 origin。 */
export const REMOTE_MANIFEST_URL = "https://hghub-registry.pages.dev/sources-manifest.json";
export const MANIFEST_CACHE_KEY = "hghubx_sources_manifest_last_good";
/** 不反向依赖 shared/api（其顶层含 Tauri/navigator 副作用）：版本号由
 * resolveRegistry 入参注入，未注入时用此兜底（与 package.json 同步）。 */
export const FALLBACK_APP_VERSION = "3.3.1";
export const BUILTIN_MANIFEST_VERSION = 1;

export interface ManifestSourceOverride {
  id: string;
  enabled?: boolean;
  baseUrls?: string[];
  /** 清单参数下发（fix321-F8）：仅对 hls-site 模板源生效的声明式
   * 模板参数；paramsVersion 为 per-source 参数版本（回滚防抖锚）；
   * minAppVersion 为条目级版本门（高于当前 App 版本时仅参数不应用，
   * enabled/baseUrls 既有覆盖不受影响）。三者任一非法 → 只丢参数。 */
  adapterParams?: AdapterParams;
  paramsVersion?: number;
  minAppVersion?: string;
}

export interface SourcesManifest {
  manifestVersion: number;
  minAppVersion: string;
  sources: ManifestSourceOverride[];
}

export type RegistrySource = "remote" | "last-good" | "builtin";

export interface ResolvedRegistry {
  sources: SourceDef[];
  manifestVersion: number;
  source: RegistrySource;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** schema 校验：必填/类型不过 → null（整份丢弃，走下一段回退）。 */
export function validateManifest(raw: unknown): SourcesManifest | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.manifestVersion !== "number" || !Number.isFinite(raw.manifestVersion)) return null;
  if (typeof raw.minAppVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(raw.minAppVersion)) return null;
  if (!Array.isArray(raw.sources)) return null;
  const sources: ManifestSourceOverride[] = [];
  for (const entry of raw.sources) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id) return null;
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") return null;
    if (entry.baseUrls !== undefined) {
      /* 只许 https 起点（Muse 2026-11-19 整改 D7，G5 P1-4）：清单是我方
       * 自有通道，http 明文起点可被中间人篡改，一律整份丢弃。内置注册表
       * 不经本校验、不受影响。 */
      if (!Array.isArray(entry.baseUrls) || entry.baseUrls.some((u) => typeof u !== "string" || !/^https:\/\//.test(u))) return null;
    }
    /* adapterParams 校验（fix321-F8）：与 enabled/baseUrls 的整份丢弃
     * 口径有别——参数非法只丢该条目参数（理由见 adapterParams.ts
     * 文件头⑤）。paramsVersion 须为正整数、minAppVersion 须为
     * x.y.z 形态，任一不合 → 参数整体不下发，既有覆盖照常。 */
    let adapterParams: AdapterParams | undefined;
    let paramsVersion: number | undefined;
    let minAppVersion: string | undefined;
    if (entry.adapterParams !== undefined) {
      const validParams = validateAdapterParams(entry.adapterParams);
      const validVersion = typeof entry.paramsVersion === "number" && Number.isInteger(entry.paramsVersion) && entry.paramsVersion > 0;
      const validGate = entry.minAppVersion === undefined
        || (typeof entry.minAppVersion === "string" && /^\d+\.\d+\.\d+$/.test(entry.minAppVersion));
      if (validParams !== null && validVersion && validGate) {
        adapterParams = validParams;
        paramsVersion = entry.paramsVersion as number;
        minAppVersion = entry.minAppVersion as string | undefined;
      }
    }
    sources.push({
      id: entry.id, enabled: entry.enabled as boolean | undefined, baseUrls: entry.baseUrls as string[] | undefined,
      adapterParams, paramsVersion, minAppVersion,
    });
  }
  return { manifestVersion: raw.manifestVersion, minAppVersion: raw.minAppVersion, sources };
}

/** "2.10.0" > "2.2.0" 式语义比较：a>b 返回正数。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number(n) || 0);
  const pb = b.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function applyManifest(builtin: SourceDef[], manifest: SourcesManifest, appVersion: string = FALLBACK_APP_VERSION): SourceDef[] {
  const byId = new Map(manifest.sources.map((s) => [s.id, s]));
  return builtin.map((def) => {
    const over = byId.get(def.id);
    if (!over) return def;
    let next: SourceDef = {
      ...def,
      enabled: over.enabled !== undefined ? over.enabled : def.enabled,
      baseUrls: over.baseUrls && over.baseUrls.length ? over.baseUrls : def.baseUrls,
    };
    /* 参数下发应用（fix321-F8）：仅 hls-site 模板、条目版本门达标、
     * 该 paramsVersion 未被自检回滚拒绝过时，才把校验过的参数覆盖
     * 到生效 def 的 adapter.params（未下发字段保留内置值）；生效
     * 结果对适配器创建透明（createAdapter 读生效 def 即得新参数）。
     * 参数不触碰 enabled/maturity。覆盖同时记已应用快照（pending，
     * 待启动后自检验证/回滚，见 adapterParams.ts）。 */
    if (over.adapterParams && over.paramsVersion !== undefined
      && def.adapter.template === "hls-site"
      && (over.minAppVersion === undefined || compareVersions(over.minAppVersion, appVersion) <= 0)
      && !isParamsVersionRejected(def.id, over.paramsVersion)) {
      next = { ...next, adapter: { ...next.adapter, params: { ...(def.adapter.params ?? {}), ...over.adapterParams } } };
      recordAppliedParams({
        sourceId: def.id,
        paramsVersion: over.paramsVersion,
        params: over.adapterParams,
        appliedAt: Date.now(),
        builtinFingerprint: fingerprintParams(def.adapter.params),
      });
    }
    return next;
  });
}

interface StorageLike {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

let active: ResolvedRegistry = { sources: getBuiltinRegistry(), manifestVersion: BUILTIN_MANIFEST_VERSION, source: "builtin" };
let activeAppVersion = FALLBACK_APP_VERSION;

/** 解析落定埋点（Muse 2026-11-19 整改 D2）：动态 import 避免
 * manifest→shared/diagnostics 的静态环（diagnostics 侧经 provider
 * 钩子反向消费本模块数据）；埋点失败不影响解析结果。 */
function traceRegistryApplied(r: ResolvedRegistry): void {
  void import("../../shared/diagnostics/playbackDiagnostics")
    .then((m) => m.tracePlayback("registry.applied", { version: r.manifestVersion, source: r.source, count: r.sources.length }))
    .catch(() => { /* 诊断不可用时静默 */ });
}

function setActive(r: ResolvedRegistry): ResolvedRegistry {
  active = r;
  traceRegistryApplied(r);
  return active;
}

/**
 * 启动后台拉取并解析注册表（三段回退）。fetcher/storage/appVersion
 * 可注入（契约测试用）；生产默认 fetch + localStorage。
 */
export async function resolveRegistry(deps?: {
  fetcher?: (url: string) => Promise<unknown>;
  storage?: StorageLike | null;
  appVersion?: string;
  url?: string;
}): Promise<ResolvedRegistry> {
  const appVersion = deps?.appVersion ?? FALLBACK_APP_VERSION;
  activeAppVersion = appVersion;
  const storage = deps?.storage !== undefined ? deps.storage : defaultStorage();
  const fetcher = deps?.fetcher ?? (async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    return res.json();
  });
  const usable = (m: SourcesManifest | null): m is SourcesManifest =>
    m !== null && compareVersions(m.minAppVersion, appVersion) <= 0;

  /* 防回滚（Muse 2026-11-19 整改 D4，G5 P2-2）：先读 last-good 版本，
   * 远程清单版本低于它时不生效、不覆盖缓存，直接用 last-good；
   * 版本相等或更高才接受远程。 */
  let cachedManifest: SourcesManifest | null = null;
  try {
    const cached = storage?.getItem(MANIFEST_CACHE_KEY);
    cachedManifest = cached ? validateManifest(JSON.parse(cached)) : null;
  } catch { /* 缓存损坏 → 视为无 last-good，后续按内置兜底 */ }

  try {
    const manifest = validateManifest(await fetcher(deps?.url ?? REMOTE_MANIFEST_URL));
    if (usable(manifest) && (cachedManifest === null || manifest.manifestVersion >= cachedManifest.manifestVersion)) {
      try { storage?.setItem(MANIFEST_CACHE_KEY, JSON.stringify(manifest)); } catch { /* 缓存失败不影响本轮生效 */ }
      return setActive({ sources: applyManifest(getBuiltinRegistry(), manifest, appVersion), manifestVersion: manifest.manifestVersion, source: "remote" });
    }
  } catch { /* 远程失败 → last-good */ }

  if (usable(cachedManifest)) {
    return setActive({ sources: applyManifest(getBuiltinRegistry(), cachedManifest, appVersion), manifestVersion: cachedManifest.manifestVersion, source: "last-good" });
  }

  return setActive({ sources: getBuiltinRegistry(), manifestVersion: BUILTIN_MANIFEST_VERSION, source: "builtin" });
}

export function getActiveRegistry(): ResolvedRegistry {
  return active;
}

/** 参数回滚生效点（fix321-F8）：把 active 注册表中该源的
 * adapter.params 复位为内置注册表原值（enabled/baseUrls 等其余
 * 生效覆盖不动）。源不在生效表/已是内置参数时返回 false。 */
export function revertActiveSourceParams(sourceId: string): boolean {
  const builtin = getBuiltinRegistry().find((s) => s.id === sourceId);
  if (!builtin) return false;
  let changed = false;
  const sources = active.sources.map((s) => {
    if (s.id !== sourceId) return s;
    changed = true;
    return { ...s, adapter: { ...s.adapter, params: builtin.adapter.params } };
  });
  if (changed) active = { ...active, sources };
  return changed;
}

/** 诊断线接线：版本号 + 每源生效 origin（baseUrls 首个）+ 启用态。 */
export function getRegistryInfo(): {
  manifestVersion: number;
  appVersion: string;
  registrySource: RegistrySource;
  builtinCount: number;
  sources: { id: string; displayName: string; enabled: boolean; maturity: SourceDef["maturity"]; origin: string; template: string }[];
} {
  return {
    manifestVersion: active.manifestVersion,
    appVersion: activeAppVersion,
    registrySource: active.source,
    builtinCount: BUILTIN_SOURCES.length,
    sources: active.sources.map((s) => ({
      id: s.id,
      displayName: s.displayName,
      enabled: s.enabled,
      maturity: s.maturity,
      origin: s.baseUrls[0] ?? "",
      template: s.adapter.template,
    })),
  };
}
