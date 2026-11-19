/* ── 播放 URL 缓存（Muse 2026-11-19 根治包，audit6 P1-3/P2-08）──
 * 从 Feed 抽出：playUrls/hevcUrls 此前以未作用域的 `${id}:${ep}` 为键、
 * 无容量上限——切线后当前条目继续用旧线 URL 播放、换账号能读到上一
 * 账号解析的 URL。现键统一为 scopedPlayKey（accountScope:lineEpoch:
 * id:ep），作用域变化整表清空（旧条目既不可达也不占内存），容量经
 * cacheMap 的 FIFO 上限（URL 类 200 条）。version 计数供调用方把
 * 「缓存已变」接进 effect 依赖（替代旧 playUrls[...] 依赖写法）。 */
import { useCallback, useRef, useState } from "react";
import { noteCacheHit, noteCacheMiss, noteCacheScopeClear, scopedPlayKey, setCapped, URL_CACHE_CAPACITY } from "./cacheMap";
import { tracePlayback } from "../../shared/diagnostics/playbackDiagnostics";

export function usePlayUrlCache(accountScope: string, lineEpoch: number) {
  const mainRef = useRef(new Map<string, string>());
  const hevcRef = useRef(new Map<string, string>());
  const [version, setVersion] = useState(0);
  const scopeRef = useRef("");
  const scope = `${accountScope}:${lineEpoch}`;
  if (scopeRef.current !== scope) {
    /* 作用域失效入统一时间线（飞行记录仪收口）：整表清空是缓存域的
     * 关键事件（切线/换账号），逐次淘汰只记计数不入流水。首帧的
     * 空→初值不算失效，不发事件。 */
    if (scopeRef.current) {
      noteCacheScopeClear();
      tracePlayback("cache.scope_clear", { scope });
    }
    scopeRef.current = scope;
    mainRef.current.clear();
    hevcRef.current.clear();
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
    if (mainRef.current.delete(key) || hevcRef.current.delete(key)) setVersion(v => v + 1);
  }, []);

  return { keyFor, getMain, getHevc, setUrls, clearKey, version };
}
