import { useCallback, useMemo, useRef, useState } from "react";
import type { WatchProgress } from "./store";
import { hashExternalId } from "../../features/sources/types.ts";

type Kind = "video" | "post";

/**
 * 本地资料库（3.3.0 账号体系拆除线）：本 App 是纯本地游客模式，无云端、
 * 无账号。收藏/点赞/关注/历史只存本机（随 store 的 Persist 落
 * `hghubx_app_v1`），不存在远端同步、登录态与分桶。
 *
 * `scope` 判别成分：详情/播放/动作/标签门的 key 曾以 accountScope
 * （`${bucketKey}:${generation}`）区分账号与代次；单一资料库后身份
 * 恒定，收敛为常量 LOCAL_SCOPE，代次判别由 lineEpoch 独立承担。
 */
export const LOCAL_SCOPE = "local";

/**
 * 外部源条目快照（fix334/L3 G4）：外部条目进资料库只存 hashExternalId
 * 桥接哈希（不可逆），Profile 无从靠哈希反查源站条目——回访所需的
 * 最小事实（源 id＋源站 id＋标题/封面快照）随收藏/历史写入同存本侧
 * 表，key＝桥接哈希。快照只作呈现与回访寻址；源现状（停用/下线/
 * blocked）永远以回访落点的 surfaces 派生为准，快照不冒充现状。
 */
export interface ExternalRef {
  sourceId: string;
  externalId: string;
  kind: "video" | "post" | "image";
  title: string;
  cover: string;
  /** 写入时已知的集数（仅 video 有意义；未知则缺省，卡面不编造）。 */
  epCount?: number;
}

/** 写入面条目的最小结构（sources 的 SourceItem 结构兼容）。 */
export interface ExternalItemRef {
  sourceId: string;
  externalId: string;
  title: string;
  cover: string;
}

export type ExternalKind = "video" | "post" | "image";

/** 桥接哈希单一口径：与 sources/types 的 mapToVideoCard/mapToPost 同串。 */
export function externalHashId(item: ExternalItemRef): number {
  return hashExternalId(`${item.sourceId}:${item.externalId}`);
}

/** 资料库拥有的字段形状（store Persist 的子集；偏好字段不归资料库写）。 */
export type LibraryData = {
  likes: number[]; favs: number[]; follows: number[]; history: WatchProgress[];
  postLikes?: number[]; postFavs?: number[];
  likeEpisodes?: { video_id: number; ep: number }[];
  localHistory?: number[];
  /** G4 快照侧表（新可选字段：旧数据无此字段、旧版读新数据忽略，
   * 同一 Persist 键、无迁移，见设计 §4.2）。 */
  extRefs?: Record<number, ExternalRef>;
};

/** 运行时内部形状：可选字段一律归一为数组/记录。 */
export type LibraryState = {
  likes: number[]; favs: number[]; follows: number[];
  postLikes: number[]; postFavs: number[];
  likeEpisodes: { video_id: number; ep: number }[];
  history: WatchProgress[];
  localHistory: number[];
  extRefs: Record<number, ExternalRef>;
};

/** 只挑资料库字段写回 Persist，避免覆盖应用偏好（旧 pickGuestData 同口径）。 */
export function pickLibraryData(data: LibraryData): LibraryData {
  return {
    likes: data.likes, favs: data.favs, follows: data.follows, history: data.history,
    postLikes: data.postLikes, postFavs: data.postFavs, likeEpisodes: data.likeEpisodes, localHistory: data.localHistory,
    extRefs: data.extRefs,
  };
}

const emptyState = (): LibraryState => ({
  likes: [], favs: [], follows: [], history: [], postLikes: [], postFavs: [], likeEpisodes: [], localHistory: [], extRefs: {},
});
const ids = (value: unknown): number[] => Array.isArray(value)
  ? [...new Set(value.filter((id): id is number => Number.isSafeInteger(id) && id > 0))] : [];
const validProgress = (value: unknown): value is WatchProgress => {
  const row = value as WatchProgress | null;
  return !!row && Number.isSafeInteger(row.id) && row.id > 0 && Number.isFinite(row.at)
    && Number.isSafeInteger(row.ep) && row.ep > 0 && Number.isFinite(row.t) && row.t >= 0 && Number.isFinite(row.dur) && row.dur >= 0;
};

/** 快照行合法性：形状合法 ∧ key 与内容重算哈希相等（串源/损坏即丢）。 */
const validExtRef = (key: string, value: unknown): value is ExternalRef => {
  if (!value || typeof value !== "object") return false;
  const r = value as ExternalRef;
  if (typeof r.sourceId !== "string" || !r.sourceId) return false;
  if (typeof r.externalId !== "string" || !r.externalId) return false;
  if (r.kind !== "video" && r.kind !== "post" && r.kind !== "image") return false;
  if (typeof r.title !== "string" || typeof r.cover !== "string") return false;
  if (r.epCount !== undefined && (!Number.isSafeInteger(r.epCount) || r.epCount < 0)) return false;
  const id = Number(key);
  return Number.isSafeInteger(id) && id > 0 && id === hashExternalId(`${r.sourceId}:${r.externalId}`);
};

/** 侧表清洗：只保留合法 ∧ key ∈ keep（仍被收藏/历史集合引用）的行。 */
const sanitizeExtRefs = (value: unknown, keep: ReadonlySet<number>): Record<number, ExternalRef> => {
  const out: Record<number, ExternalRef> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, row] of Object.entries(value as Record<string, unknown>)) {
    const id = Number(key);
    if (keep.has(id) && validExtRef(key, row)) out[id] = row;
  }
  return out;
};

/** 资料库四集合的引用集：快照的存活判据（孤儿修剪的唯一判据）。 */
const referencedIds = (s: Pick<LibraryState, "favs" | "postFavs" | "history" | "localHistory">): Set<number> =>
  new Set([...s.favs, ...s.postFavs, ...s.history.map(row => row.id), ...s.localHistory]);

/** 孤儿修剪：快照无任何集合引用即丢弃（写入路径与读入清洗共用）。 */
const pruneExtRefs = (s: LibraryState): LibraryState => {
  const keep = referencedIds(s);
  const next: Record<number, ExternalRef> = {};
  for (const [key, row] of Object.entries(s.extRefs)) {
    if (keep.has(Number(key))) next[Number(key)] = row;
  }
  return { ...s, extRefs: next };
};

export function sanitizeLibraryData(value: Partial<LibraryData> | null | undefined): LibraryState {
  const data = { ...emptyState(), ...value };
  const base: LibraryState = {
    likes: ids(data.likes), favs: ids(data.favs), follows: ids(data.follows),
    postLikes: ids(data.postLikes), postFavs: ids(data.postFavs),
    history: Array.isArray(data.history) ? data.history.filter(validProgress) : [],
    localHistory: ids(data.localHistory),
    likeEpisodes: Array.isArray(data.likeEpisodes)
      ? data.likeEpisodes.filter(row => Number.isSafeInteger(row?.video_id) && row.video_id > 0 && Number.isSafeInteger(row.ep) && row.ep > 0)
      : [],
    extRefs: {},
  };
  return { ...base, extRefs: sanitizeExtRefs(data.extRefs, referencedIds(base)) };
}

const selected = (list: number[], id: number, on: boolean) => on ? [id, ...list.filter(x => x !== id)] : list.filter(x => x !== id);

/**
 * 两份资料库合并（旧 mergeMigratedAccountData 的去账号版）：history 逐行
 * 按时间戳仲裁（新者胜、平局 target 胜），其余集合取并集（target 顺序
 * 优先），likeEpisodes 按 (video_id, ep) 去重。旧分桶的 dirtyHistory
 * 只是「未上传集数」标记，其进度本体在 history 行内，合并 history 即
 * 保全，不再单独保留该字段。
 */
export function mergeLibraryData(target: LibraryData, previous: LibraryData): LibraryState {
  const t = sanitizeLibraryData(target);
  const p = sanitizeLibraryData(previous);
  const historyById = new Map<number, WatchProgress>();
  for (const row of p.history) historyById.set(row.id, row);
  for (const row of t.history) {
    const old = historyById.get(row.id);
    if (!old || row.at >= old.at) historyById.set(row.id, row);
  }
  const union = (head: number[], tail: number[]) => [...head, ...tail.filter(id => !head.includes(id))];
  const episodeKeys = new Set(t.likeEpisodes.map(row => `${row.video_id}:${row.ep}`));
  const merged: LibraryState = {
    likes: union(t.likes, p.likes),
    favs: union(t.favs, p.favs),
    follows: union(t.follows, p.follows),
    postLikes: union(t.postLikes, p.postLikes),
    postFavs: union(t.postFavs, p.postFavs),
    likeEpisodes: [...t.likeEpisodes, ...p.likeEpisodes.filter(row => !episodeKeys.has(`${row.video_id}:${row.ep}`))],
    history: [...historyById.values()].sort((a, b) => b.at - a.at),
    localHistory: union(t.localHistory, p.localHistory),
    extRefs: {},
  };
  /* 侧表合并：按 key 并集（target 胜），再按合并后集合修剪孤儿。 */
  return { ...merged, extRefs: sanitizeExtRefs({ ...p.extRefs, ...t.extRefs }, referencedIds(merged)) };
}

/**
 * 历史行写入的纯形态（原生 addHistory 与外部 applyExternalHistory
 * 共用同一口径：ep 省略保留原集、换集清进度、行置顶、localHistory
 * 标记）。进度非法（id/ep/t/dur 越界）回 null＝不写。
 */
function historyRowState(s: LibraryState, id: number, ep?: number, time?: number, duration?: number): LibraryState | null {
  const previous = s.history.find(row => row.id === id);
  const nextEp = ep ?? previous?.ep ?? 1;
  const changed = previous && previous.ep !== nextEp;
  const row: WatchProgress = {
    id, ep: nextEp,
    t: time ?? (changed ? 0 : previous?.t ?? 0),
    dur: duration ?? (changed ? 0 : previous?.dur ?? 0),
    at: Date.now(),
  };
  if (!validProgress(row)) return null;
  return {
    ...s,
    history: [row, ...s.history.filter(item => item.id !== id)],
    localHistory: selected(s.localHistory, id, true),
  };
}

const snapshotOf = (item: ExternalItemRef, kind: ExternalKind, epCount: number | undefined, prev: ExternalRef | undefined): ExternalRef => {
  const count = epCount ?? prev?.epCount;
  return {
    sourceId: item.sourceId, externalId: item.externalId, kind,
    title: item.title, cover: item.cover,
    ...(count !== undefined ? { epCount: count } : {}),
  };
};

/**
 * 外部收藏写入的纯形态：video 落 favs、post/image 落 postFavs（与
 * 原生同格、kind 在快照里区分）；收藏同写快照，取消后快照是否存活
 * 只看是否仍被历史引用（孤儿修剪一处判据）。
 */
export function applyExternalCollected(state: LibraryState, kind: ExternalKind, item: ExternalItemRef, on: boolean, epCount?: number): LibraryState {
  const id = externalHashId(item);
  const withFav: LibraryState = kind === "video"
    ? { ...state, favs: selected(state.favs, id, on) }
    : { ...state, postFavs: selected(state.postFavs, id, on) };
  const withRef: LibraryState = on
    ? { ...withFav, extRefs: { ...withFav.extRefs, [id]: snapshotOf(item, kind, epCount, state.extRefs[id]) } }
    : withFav;
  return pruneExtRefs(withRef);
}

/**
 * 外部历史写入的纯形态：行 t=0/dur=0（外部无秒级进度事实，「续播」
 * 只恢复到集、不到秒），集数＝写入时 ordinal；快照同写（已有快照
 * 的 kind 优先，历史首写默认 video——历史只来自播放面）。
 * ordinal 口径：episodeOrdinal 的 0＝未知（externalId 不在 choices
 * 内），不是「第 0 集」——按未提供集数处理（historyRowState 既有
 * 口径：保留原行集数、无原行回 1），历史行与快照照常写入；不许
 * 因集数未知把一次真实观看整行静默吞掉（fix334 清扫已坏-1 放大
 * 器、§4 记账 2 的显式口径）。
 */
export function applyExternalHistory(state: LibraryState, item: ExternalItemRef, epOrdinal?: number, epCount?: number): LibraryState {
  const id = externalHashId(item);
  const ep = epOrdinal !== undefined && epOrdinal >= 1 ? epOrdinal : undefined;
  const withRow = historyRowState(state, id, ep, 0, 0);
  if (!withRow) return state;
  const prev = state.extRefs[id];
  return pruneExtRefs({
    ...withRow,
    extRefs: { ...withRow.extRefs, [id]: snapshotOf(item, prev?.kind ?? "video", epCount, prev) },
  });
}

/* ── 旧账号分桶吸收（一次性升级迁移） ─────────────────────────────
 * 旧版登录用户资料库按 [origin, userId] 分桶存 `hghubx_accounts_v1`。
 * 拆除后该键无任何读写方；若不吸收，曾登录用户的收藏/历史会随桶
 * 孤儿化。loadPersist 时把全桶幂等合并进本机资料库（并集＋时间戳
 * 仲裁，重复吸收不产生重复），合并结果成功写入新键并回读验证后
 * 才删旧键（存储不变量 7）；写失败保留旧键，下次启动重吸收。 */
export const LEGACY_ACCOUNTS_KEY = "hghubx_accounts_v1";
let legacyAbsorbed = false;

export function absorbLegacyAccounts(data: LibraryData): { data: LibraryData; absorbed: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(LEGACY_ACCOUNTS_KEY) || "null") as
      { version?: unknown; accounts?: Record<string, unknown> } | null;
    if (!saved || saved.version !== 1 || !saved.accounts || typeof saved.accounts !== "object") {
      return { data, absorbed: false };
    }
    let merged = sanitizeLibraryData(data);
    for (const bucket of Object.values(saved.accounts)) {
      merged = mergeLibraryData(merged, bucket as LibraryData);
    }
    legacyAbsorbed = true;
    return { data: merged, absorbed: true };
  } catch {
    /* 损坏的分桶缓存不得影响本机资料库读取；旧键保留，下次启动重试。 */
    return { data, absorbed: false };
  }
}

/** 仅在吸收已发生、且合并结果已成功写入新键后调用：删旧分桶键。 */
export function clearAbsorbedLegacyAccounts(): void {
  if (!legacyAbsorbed) return;
  try {
    localStorage.removeItem(LEGACY_ACCOUNTS_KEY);
    legacyAbsorbed = false;
  } catch { /* 删除失败留下次启动重试 */ }
}

/** 纯本地资料库：无远端请求、无身份、写即落盘（经 store 的 save 通道）。 */
export function useLocalLibrary(initial: LibraryData, save: (data: LibraryData) => void) {
  const [drawTick, redraw] = useState(0);
  const snapshotRevision = useRef(0);
  const render = () => { snapshotRevision.current++; redraw(n => n + 1); };
  const saveRef = useRef(save); saveRef.current = save;
  const state = useRef<LibraryState | null>(null);
  if (!state.current) state.current = sanitizeLibraryData(initial);
  const pending = useRef(new Map<string, Promise<void>>());
  /* 清空代次：清空前渲染出的 addHistory 闭包在清空后不得写回（旧
   * accountData 的 clearVersion 守卫同口径，去账号后只留这一道）。 */
  const clearVersion = useRef(0);

  const persist = (data: LibraryState) => {
    /* 每次落盘前修剪孤儿快照：任何路径（原生 setCollected 误触哈希
     * id、清空历史）都不得留下无引用的 extRefs 行。 */
    const pruned = pruneExtRefs(data);
    state.current = pruned;
    snapshotRevision.current++;
    saveRef.current(pickLibraryData(pruned));
    render();
  };

  const setCollected = useCallback((kind: Kind, id: number, on: boolean) => {
    const key = `collect:${kind}:${id}`;
    const existing = pending.current.get(key);
    if (existing) return existing;
    const run = (async () => {
      const data = state.current!;
      persist(kind === "video"
        ? { ...data, favs: selected(data.favs, id, on) }
        : { ...data, postFavs: selected(data.postFavs, id, on) });
    })();
    pending.current.set(key, run); render();
    void run.finally(() => {
      if (pending.current.get(key) === run) { pending.current.delete(key); render(); }
    }).catch(() => {});
    return run;
  }, []);

  const renderedClearVersion = clearVersion.current;
  const addHistory = useCallback((id: number, ep?: number, time?: number, duration?: number) => {
    if (clearVersion.current !== renderedClearVersion) return;
    if (!Number.isSafeInteger(id) || id <= 0) return;
    const next = historyRowState(state.current!, id, ep, time, duration);
    if (next) persist(next);
  }, [renderedClearVersion]);

  /* 外部收藏薄封装（设计 §4.3）：哈希在本层算、快照与收藏同一次
   * persist 落盘；pending 去重与原生 setCollected 同口径（image 与
   * post 同落 postFavs，共用 collect:post 键空间）。 */
  const setExternalCollected = useCallback((kind: ExternalKind, item: ExternalItemRef, on: boolean, epCount?: number) => {
    const id = externalHashId(item);
    const key = `collect:${kind === "video" ? "video" : "post"}:${id}`;
    const existing = pending.current.get(key);
    if (existing) return existing;
    const run = (async () => {
      persist(applyExternalCollected(state.current!, kind, item, on, epCount));
    })();
    pending.current.set(key, run); render();
    void run.finally(() => {
      if (pending.current.get(key) === run) { pending.current.delete(key); render(); }
    }).catch(() => {});
    return run;
  }, []);

  /* 外部历史薄封装：与 addHistory 同受清空代次守卫。 */
  const addExternalHistory = useCallback((item: ExternalItemRef, epOrdinal?: number, epCount?: number) => {
    if (clearVersion.current !== renderedClearVersion) return;
    persist(applyExternalHistory(state.current!, item, epOrdinal, epCount));
  }, [renderedClearVersion]);

  const clearHistory = useCallback(async () => {
    clearVersion.current++;
    persist({ ...state.current!, history: [], localHistory: [] });
  }, []);

  const s = state.current;
  const rev = snapshotRevision.current;
  return useMemo(() => ({
    likes: s.likes, favs: s.favs, postLikes: s.postLikes, postFavs: s.postFavs, follows: s.follows, history: s.history,
    extRefs: s.extRefs,
    isFav: (id: number, kind: Kind = "video") => (kind === "video" ? s.favs : s.postFavs).includes(id),
    setCollected, addHistory, clearHistory, setExternalCollected, addExternalHistory,
    actionPending: (key: string) => pending.current.has(key),
  }), [rev, drawTick, setCollected, addHistory, clearHistory, setExternalCollected, addExternalHistory]);
}
