import { useCallback, useMemo, useRef, useState } from "react";
import type { WatchProgress } from "./store";

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

/** 资料库拥有的字段形状（store Persist 的子集；偏好字段不归资料库写）。 */
export type LibraryData = {
  likes: number[]; favs: number[]; follows: number[]; history: WatchProgress[];
  postLikes?: number[]; postFavs?: number[];
  likeEpisodes?: { video_id: number; ep: number }[];
  localHistory?: number[];
};

/** 运行时内部形状：可选字段一律归一为数组。 */
type LibraryState = {
  likes: number[]; favs: number[]; follows: number[];
  postLikes: number[]; postFavs: number[];
  likeEpisodes: { video_id: number; ep: number }[];
  history: WatchProgress[];
  localHistory: number[];
};

/** 只挑资料库字段写回 Persist，避免覆盖应用偏好（旧 pickGuestData 同口径）。 */
export function pickLibraryData(data: LibraryData): LibraryData {
  return {
    likes: data.likes, favs: data.favs, follows: data.follows, history: data.history,
    postLikes: data.postLikes, postFavs: data.postFavs, likeEpisodes: data.likeEpisodes, localHistory: data.localHistory,
  };
}

const emptyState = (): LibraryState => ({
  likes: [], favs: [], follows: [], history: [], postLikes: [], postFavs: [], likeEpisodes: [], localHistory: [],
});
const ids = (value: unknown): number[] => Array.isArray(value)
  ? [...new Set(value.filter((id): id is number => Number.isSafeInteger(id) && id > 0))] : [];
const validProgress = (value: unknown): value is WatchProgress => {
  const row = value as WatchProgress | null;
  return !!row && Number.isSafeInteger(row.id) && row.id > 0 && Number.isFinite(row.at)
    && Number.isSafeInteger(row.ep) && row.ep > 0 && Number.isFinite(row.t) && row.t >= 0 && Number.isFinite(row.dur) && row.dur >= 0;
};

export function sanitizeLibraryData(value: Partial<LibraryData> | null | undefined): LibraryState {
  const data = { ...emptyState(), ...value };
  return {
    likes: ids(data.likes), favs: ids(data.favs), follows: ids(data.follows),
    postLikes: ids(data.postLikes), postFavs: ids(data.postFavs),
    history: Array.isArray(data.history) ? data.history.filter(validProgress) : [],
    localHistory: ids(data.localHistory),
    likeEpisodes: Array.isArray(data.likeEpisodes)
      ? data.likeEpisodes.filter(row => Number.isSafeInteger(row?.video_id) && row.video_id > 0 && Number.isSafeInteger(row.ep) && row.ep > 0)
      : [],
  };
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
  return {
    likes: union(t.likes, p.likes),
    favs: union(t.favs, p.favs),
    follows: union(t.follows, p.follows),
    postLikes: union(t.postLikes, p.postLikes),
    postFavs: union(t.postFavs, p.postFavs),
    likeEpisodes: [...t.likeEpisodes, ...p.likeEpisodes.filter(row => !episodeKeys.has(`${row.video_id}:${row.ep}`))],
    history: [...historyById.values()].sort((a, b) => b.at - a.at),
    localHistory: union(t.localHistory, p.localHistory),
  };
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
    state.current = data;
    snapshotRevision.current++;
    saveRef.current(pickLibraryData(data));
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
    const s = state.current!;
    const previous = s.history.find(row => row.id === id);
    const nextEp = ep ?? previous?.ep ?? 1;
    const changed = previous && previous.ep !== nextEp;
    const row: WatchProgress = {
      id, ep: nextEp,
      t: time ?? (changed ? 0 : previous?.t ?? 0),
      dur: duration ?? (changed ? 0 : previous?.dur ?? 0),
      at: Date.now(),
    };
    if (!validProgress(row)) return;
    persist({
      ...s,
      history: [row, ...s.history.filter(item => item.id !== id)],
      localHistory: selected(s.localHistory, id, true),
    });
  }, [renderedClearVersion]);

  const clearHistory = useCallback(async () => {
    clearVersion.current++;
    persist({ ...state.current!, history: [], localHistory: [] });
  }, []);

  const s = state.current;
  const rev = snapshotRevision.current;
  return useMemo(() => ({
    likes: s.likes, favs: s.favs, postLikes: s.postLikes, postFavs: s.postFavs, follows: s.follows, history: s.history,
    isFav: (id: number, kind: Kind = "video") => (kind === "video" ? s.favs : s.postFavs).includes(id),
    setCollected, addHistory, clearHistory,
    actionPending: (key: string) => pending.current.has(key),
  }), [rev, drawTick, setCollected, addHistory, clearHistory]);
}
