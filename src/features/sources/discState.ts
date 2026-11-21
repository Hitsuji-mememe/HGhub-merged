/**
 * 发现选择落盘（Muse 2026-11-21 fix3312/discovery-b，调查
 * fix3312/evidence/discovery-design-research.md 选项 B 第 2 段
 * 「兴趣直达」）：disc（排序/分类/标签选择）此前只存浏览组件的
 * 会话内存——关 App 重开一切回到默认最新流，这是「每次打开都
 * 被最新流推着走」的直接技术原因。本模块按源落盘 disc＋最近
 * 用过的分类/标签（供 DiscoveryBar 行内置顶），重开直达上次
 * 筛选。
 *
 * 存储口径：自有键 hghubx_disc_v1、try/catch＋归一化读回（照
 * shared/model/contentPreferences 先例）；只存 UI 选择状态，与
 * 3.3.11 已删的 B1 账号会话簇无关（那套是账号 token 会话，本
 * 模块不碰任何凭据/会话）。写入失败静默——本次会话内状态仍
 * 生效，只是重开不恢复，不冒充已保存。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ListDiscovery } from "./types.ts";

export const DISC_STATE_KEY = "hghubx_disc_v1";
/** 每源每维最近用过上限（行内置顶的展示量，超出无意义）。 */
export const DISC_RECENT_LIMIT = 6;
/** 落盘源数上限（防注册表膨胀后无界生长；按最近触达保留）。 */
export const DISC_SOURCE_LIMIT = 40;

export interface SourceDiscRecord {
  disc: ListDiscovery;
  recentCategories: string[];
  recentTags: string[];
}
export type DiscStateMap = Record<string, SourceDiscRecord>;

const cleanField = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

function cleanDisc(v: unknown): ListDiscovery {
  const d = v && typeof v === "object" ? v as Record<string, unknown> : {};
  const out: ListDiscovery = {};
  const category = cleanField(d.category); if (category) out.category = category;
  const sort = cleanField(d.sort); if (sort) out.sort = sort;
  const period = cleanField(d.period); if (period) out.period = period;
  const tag = cleanField(d.tag); if (tag) out.tag = tag;
  return out;
}

function cleanRecents(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || !item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= DISC_RECENT_LIMIT) break;
  }
  return out;
}

/** 落盘原文 → 规范状态：形状不符的条目整条丢弃，不拿坏数据冒充筛选。 */
export function normalizeDiscStateMap(raw: unknown): DiscStateMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: DiscStateMap = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    out[id] = {
      disc: cleanDisc(r.disc),
      recentCategories: cleanRecents(r.recentCategories),
      recentTags: cleanRecents(r.recentTags),
    };
  }
  const keys = Object.keys(out);
  if (keys.length <= DISC_SOURCE_LIMIT) return out;
  const trimmed: DiscStateMap = {};
  for (const k of keys.slice(keys.length - DISC_SOURCE_LIMIT)) trimmed[k] = out[k];
  return trimmed;
}

export function loadDiscStateMap(): DiscStateMap {
  try {
    return normalizeDiscStateMap(JSON.parse(localStorage.getItem(DISC_STATE_KEY) || "null"));
  } catch {
    return {};
  }
}

export function saveDiscStateMap(map: DiscStateMap): void {
  try { localStorage.setItem(DISC_STATE_KEY, JSON.stringify(map)); } catch { /* 存储不可用：会话内仍生效 */ }
}

const pushRecent = (list: string[], value: string | undefined): string[] =>
  value ? [value, ...list.filter((x) => x !== value)].slice(0, DISC_RECENT_LIMIT) : list;

/** 选择变更 → 新状态（纯函数）：disc 替换；category/tag 换新值时
 * 该值进最近用过首位（同值重选不重排、清除选择不动最近列表——
 * 清除不是「用过」）；源记录按最近触达排序以便上限裁剪。 */
export function applyDiscSelection(
  map: DiscStateMap,
  sourceId: string,
  next: ListDiscovery,
): DiscStateMap {
  const prev = map[sourceId];
  const record: SourceDiscRecord = {
    disc: next,
    recentCategories: next.category !== prev?.disc.category
      ? pushRecent(prev?.recentCategories ?? [], next.category)
      : (prev?.recentCategories ?? []),
    recentTags: next.tag !== prev?.disc.tag
      ? pushRecent(prev?.recentTags ?? [], next.tag)
      : (prev?.recentTags ?? []),
  };
  const out: DiscStateMap = { ...map };
  delete out[sourceId];
  out[sourceId] = record;
  const keys = Object.keys(out);
  if (keys.length <= DISC_SOURCE_LIMIT) return out;
  const trimmed: DiscStateMap = {};
  for (const k of keys.slice(keys.length - DISC_SOURCE_LIMIT)) trimmed[k] = out[k];
  return trimmed;
}

/** 三浏览面共用：挂载时读回落盘状态、变更即写回（首次渲染不回
 * 写，避免把刚读回的值原样写一遍）。 */
export function useDiscState(): {
  discStateMap: DiscStateMap;
  applyDisc: (sourceId: string, next: ListDiscovery) => void;
} {
  const [map, setMap] = useState<DiscStateMap>(() => loadDiscStateMap());
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    saveDiscStateMap(map);
  }, [map]);
  const applyDisc = useCallback((sourceId: string, next: ListDiscovery) => {
    setMap((m) => applyDiscSelection(m, sourceId, next));
  }, []);
  return { discStateMap: map, applyDisc };
}
