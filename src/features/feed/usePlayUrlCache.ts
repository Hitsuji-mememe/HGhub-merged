/* ── 播放 URL 缓存（Muse 2026-11-19 根治包，audit6 P1-3/P2-08）──
 * 从 Feed 抽出：playUrls/hevcUrls 此前以未作用域的 `${id}:${ep}` 为键、
 * 无容量上限——切线后当前条目继续用旧线 URL 播放、换账号能读到上一
 * 账号解析的 URL。现键统一为 scopedPlayKey（accountScope:lineEpoch:
 * id:ep），作用域变化整表清空（旧条目既不可达也不占内存），容量经
 * cacheMap 的 FIFO 上限（URL 类 200 条）。version 计数供调用方把
 * 「缓存已变」接进 effect 依赖（替代旧 playUrls[...] 依赖写法）。
 *
 * 切线连续性（整改 B1，Hark G1 P0-1）：整表清空曾把正在播的当前条目
 * 一并清掉——playUrl 变空 → VideoSurface 卸载 → 重挂从 0 播、暂停
 * 意图被冲。现作用域变化时，当前条目（调用方经 currentEntryRef 告知
 * id:ep）先快照、整表清后按新作用域键写回（键迁移），其余条目照旧
 * 失效；自愈要求强制重解析的条目经 skipPreserveRef（id:ep 集）排除
 * 在迁移之外。clearKey 两表都删（旧实现 main 删除成功短路、hevc
 * 残留，同批修复）。 */
import { useCallback, useRef, useState } from "react";
import { noteCacheHit, noteCacheMiss, noteCacheScopeClear, scopedPlayKey, setCapped, URL_CACHE_CAPACITY } from "./cacheMap";
import { tracePlayback } from "../../shared/diagnostics/playbackDiagnostics";

type EntrySnapshot = { main?: string; hevc?: string } | null;

/** 当前条目快照（迁移第一步）：两表都读，缺一存一。 */
export function snapshotEntry(main: Map<string, string>, hevc: Map<string, string>, key: string): EntrySnapshot {
  const m = main.get(key);
  const h = hevc.get(key);
  return m === undefined && h === undefined ? null : { main: m, hevc: h };
}

/** 当前条目写回新作用域键（迁移第二步，整表清后调用）。 */
export function restoreEntry(main: Map<string, string>, hevc: Map<string, string>, key: string, snap: EntrySnapshot): void {
  if (!snap) return;
  if (snap.main !== undefined) setCapped(main, key, snap.main, URL_CACHE_CAPACITY);
  if (snap.hevc !== undefined) setCapped(hevc, key, snap.hevc, URL_CACHE_CAPACITY);
}

/** 两表都删：任一表删掉都算命中（旧实现 || 短路导致 hevc 残留）。 */
export function deleteFromBoth(main: Map<string, string>, hevc: Map<string, string>, key: string): boolean {
  const a = main.delete(key);
  const b = hevc.delete(key);
  return a || b;
}

/** 作用域限定变化判定（整改 B1）：前后内容键（id:ep）相同、作用域键
 * 不同 → 这次 playKey 变化只是切线/换代理，播放连续性必须保留。 */
export function isScopeOnlyChange(prevKey: string, nextKey: string, prevContent: string, nextContent: string): boolean {
  return prevKey !== "" && prevKey !== nextKey && prevContent === nextContent;
}

export function usePlayUrlCache(
  accountScope: string,
  lineEpoch: number,
  currentEntryRef?: { current: { id: number; ep: number } },
  skipPreserveRef?: { current: Set<string> },
) {
  const mainRef = useRef(new Map<string, string>());
  const hevcRef = useRef(new Map<string, string>());
  const [version, setVersion] = useState(0);
  const scopeRef = useRef("");
  const scopePartsRef = useRef({ accountScope: "", lineEpoch: -1 });
  const scope = `${accountScope}:${lineEpoch}`;
  if (scopeRef.current !== scope) {
    /* 作用域失效入统一时间线（飞行记录仪收口）：整表清空是缓存域的
     * 关键事件（切线/换账号），逐次淘汰只记计数不入流水。首帧的
     * 空→初值不算失效，不发事件。当前条目在清表前快照、清后按新键
     * 写回（整改 B1 键迁移）；skip 集内的条目不迁移（自愈重解析）。 */
    let snap: EntrySnapshot = null;
    let migratedKey = "";
    if (scopeRef.current) {
      noteCacheScopeClear();
      tracePlayback("cache.scope_clear", { scope });
      const cur = currentEntryRef?.current;
      const prev = scopePartsRef.current;
      if (cur && cur.id && prev.lineEpoch >= 0) {
        const ck = `${cur.id}:${cur.ep}`;
        if (skipPreserveRef?.current.has(ck)) {
          skipPreserveRef.current.delete(ck);
        } else {
          snap = snapshotEntry(mainRef.current, hevcRef.current, scopedPlayKey(prev.accountScope, prev.lineEpoch, cur.id, cur.ep));
          migratedKey = scopedPlayKey(accountScope, lineEpoch, cur.id, cur.ep);
        }
      }
    }
    scopeRef.current = scope;
    scopePartsRef.current = { accountScope, lineEpoch };
    mainRef.current.clear();
    hevcRef.current.clear();
    if (snap) restoreEntry(mainRef.current, hevcRef.current, migratedKey, snap);
  }

  const keyFor = useCallback(
    (id: number, ep: number) => scopedPlayKey(accountScope, lineEpoch, id, ep),
    [accountScope, lineEpoch],
  );
  const getMain = useCallback((key: string) => {
    const v = mainRef.current.get(key);
    if (v === undefined) noteCacheMiss(); else noteCacheHit();
    return v;
  }, []);
  const getHevc = useCallback((key: string) => {
    const v = hevcRef.current.get(key);
    if (v === undefined) noteCacheMiss(); else noteCacheHit();
    return v;
  }, []);
  const setUrls = useCallback((key: string, main: string, hevc?: string) => {
    setCapped(mainRef.current, key, main, URL_CACHE_CAPACITY);
    if (hevc) setCapped(hevcRef.current, key, hevc, URL_CACHE_CAPACITY);
    setVersion(v => v + 1);
  }, []);
  const clearKey = useCallback((key: string) => {
    if (deleteFromBoth(mainRef.current, hevcRef.current, key)) setVersion(v => v + 1);
  }, []);

  return { keyFor, getMain, getHevc, setUrls, clearKey, version };
}
