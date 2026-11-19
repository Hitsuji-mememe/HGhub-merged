/**
 * 源系统入口（Muse 2026-11-19 根治包·多源线）。
 * getRegistryInfo 实体在 ./manifest.ts（诊断线接线点），此处转发。
 */
export type { SourceAdapter, SourceCapabilities, SourceCategory, SourceDef, SourceDetail, SourceItem, SourceKind, SourceMaturity, SourceStream } from "./types";
export { BUILTIN_SOURCES, firstEnabledSource, getBuiltinRegistry, sourcesForCategory } from "./registry";
export { BUILTIN_MANIFEST_VERSION, REMOTE_MANIFEST_URL, getActiveRegistry, getRegistryInfo, resolveRegistry, validateManifest } from "./manifest";
export { createAdapter } from "./adapters/index";
