/**
 * 远程清单（一级变更通道，Muse 2026-11-19 根治包·多源线 条目3）。
 *
 * 回退链：远程 JSON 清单 → last-good（localStorage 缓存）→ 内置注册表。
 * 清单只做覆盖层：按 id 覆盖 enabled（熔断位，可远程下线）与 baseUrls，
 * 不新增/删除源（名单冻结在内置注册表）。schema 校验不过即整份丢弃；
 * minAppVersion 高于当前 App 版本的清单不生效。
 *
 * getRegistryInfo() 导出路径：src/features/sources/manifest.ts
 * （诊断线接线点：版本号 + 每源生效 origin + 数据来源）。
 */
import { BUILTIN_SOURCES, getBuiltinRegistry } from "./registry.ts";
import type { SourceDef } from "./types.ts";

/** 远程清单 URL：全仓唯一集中点，改地址只改这一行。 */
export const REMOTE_MANIFEST_URL = "https://hghubx.pages.dev/sources-manifest.json";
export const MANIFEST_CACHE_KEY = "hghubx_sources_manifest_last_good";
/** 不反向依赖 shared/api（其顶层含 Tauri/navigator 副作用）：版本号由
 * resolveRegistry 入参注入，未注入时用此兜底（与 package.json 同步）。 */
export const FALLBACK_APP_VERSION = "2.2.0";
export const BUILTIN_MANIFEST_VERSION = 1;

export interface ManifestSourceOverride {
  id: string;
  enabled?: boolean;
  baseUrls?: string[];
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
      if (!Array.isArray(entry.baseUrls) || entry.baseUrls.some((u) => typeof u !== "string" || !/^https?:\/\//.test(u))) return null;
    }
    sources.push({ id: entry.id, enabled: entry.enabled as boolean | undefined, baseUrls: entry.baseUrls as string[] | undefined });
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

export function applyManifest(builtin: SourceDef[], manifest: SourcesManifest): SourceDef[] {
  const byId = new Map(manifest.sources.map((s) => [s.id, s]));
  return builtin.map((def) => {
    const over = byId.get(def.id);
    if (!over) return def;
    return {
      ...def,
      enabled: over.enabled !== undefined ? over.enabled : def.enabled,
      baseUrls: over.baseUrls && over.baseUrls.length ? over.baseUrls : def.baseUrls,
    };
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

  try {
    const manifest = validateManifest(await fetcher(deps?.url ?? REMOTE_MANIFEST_URL));
    if (usable(manifest)) {
      try { storage?.setItem(MANIFEST_CACHE_KEY, JSON.stringify(manifest)); } catch { /* 缓存失败不影响本轮生效 */ }
      return setActive({ sources: applyManifest(getBuiltinRegistry(), manifest), manifestVersion: manifest.manifestVersion, source: "remote" });
    }
  } catch { /* 远程失败 → last-good */ }

  try {
    const cached = storage?.getItem(MANIFEST_CACHE_KEY);
    const manifest = cached ? validateManifest(JSON.parse(cached)) : null;
    if (usable(manifest)) {
      return setActive({ sources: applyManifest(getBuiltinRegistry(), manifest), manifestVersion: manifest.manifestVersion, source: "last-good" });
    }
  } catch { /* 缓存损坏 → 内置 */ }

  return setActive({ sources: getBuiltinRegistry(), manifestVersion: BUILTIN_MANIFEST_VERSION, source: "builtin" });
}

export function getActiveRegistry(): ResolvedRegistry {
  return active;
}

/** 诊断线接线：版本号 + 每源生效 origin（baseUrls 首个）+ 启用态。 */
export function getRegistryInfo(): {
  manifestVersion: number;
  appVersion: string;
  registrySource: RegistrySource;
  builtinCount: number;
  sources: { id: string; displayName: string; enabled: boolean; maturity: SourceDef["maturity"]; origin: string }[];
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
    })),
  };
}
