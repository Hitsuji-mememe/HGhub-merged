import { useCallback, useMemo, useRef, useState } from "react";
import { api } from "../../shared/api/api";
import type { Detail, Post } from "../../shared/api/types";
import { capRecordByFifo, DETAIL_CACHE_CAPACITY } from "./cacheMap";

type Args = {
  videoIds: number[];
  mode: "home" | "context";
  kind: "video" | "post";
  scope: string;
  lineEpoch: number;
  originEpoch?: number;
  filtering: boolean;
  revision: number;
  blockReason: (tags: readonly string[] | undefined) => string | null;
  checked: Record<string, boolean>;
  tagErrors: Record<string, string>;
};

/**
 * Detail/post reads shared by the feed and its panels.
 *
 * The cache key includes account scope and line epoch so a response from a
 * previous login or line can never be published into the current one.
 */
export function useFeedDetails({
  videoIds, mode, kind, scope, lineEpoch, originEpoch = 0, filtering, revision,
  blockReason, checked, tagErrors,
}: Args) {
  const [detailsRaw, setDetailsRaw] = useState<Record<number, Detail>>({});
  const detailsRef = useRef(detailsRaw);
  detailsRef.current = detailsRaw;
  const [postsRaw, setPostsRaw] = useState<Record<number, Post>>({});
  /* 容量上限（audit6 P2-08）：details/posts 各 100 条 FIFO 裁剪，写入面
   * 收敛在本 hook 的 setter 包装里，调用方签名不变。 */
  const setDetails: typeof setDetailsRaw = (updater) => {
    setDetailsRaw(prev => capRecordByFifo(typeof updater === "function" ? (updater as (p: Record<number, Detail>) => Record<number, Detail>)(prev) : updater, DETAIL_CACHE_CAPACITY));
  };
  const setPosts: typeof setPostsRaw = (updater) => {
    setPostsRaw(prev => capRecordByFifo(typeof updater === "function" ? (updater as (p: Record<number, Post>) => Record<number, Post>)(prev) : updater, DETAIL_CACHE_CAPACITY));
  };
  const details = detailsRaw;
  const posts = postsRaw;
  const detailRequests = useRef(new Map<string, Promise<Detail>>());
  /* 重置作用域含线路代次（audit6 P1-3 附带项）：Feed 现把 lineEpoch 经
   * originEpoch 传入——切线即整表重置，不再只随账号变化。 */
  const cacheScope = `${scope}:${originEpoch}`;
  const prevScopeRef = useRef(cacheScope);
  if (prevScopeRef.current !== cacheScope) {
    prevScopeRef.current = cacheScope;
    detailsRef.current = {};
    setDetailsRaw({});
    setPostsRaw({});
  }

  const requestDetail = useCallback((id: number) => {
    const key = `${scope}:${lineEpoch}:${id}`;
    let request = detailRequests.current.get(key);
    if (!request) {
      request = api.video(id).finally(() => {
        if (detailRequests.current.get(key) === request) detailRequests.current.delete(key);
      });
      detailRequests.current.set(key, request);
      if (detailRequests.current.size > 12) {
        detailRequests.current.delete(detailRequests.current.keys().next().value!);
      }
    }
    return request;
  }, [scope, lineEpoch]);

  const effectiveVideoIds = useMemo(
    () => mode === "context" && filtering ? videoIds.filter(id => {
      const key = `${scope}:${lineEpoch}:${kind}:${id}`;
      if (!checked[key]) return true;
      if (tagErrors[key]) return true;
      return !blockReason(kind === "post" ? posts[id]?.tags : details[id]?.tags);
    }) : videoIds,
    [mode, filtering, revision, videoIds, scope, lineEpoch, kind, checked, tagErrors, posts, details, blockReason],
  );

  return {
    details,
    setDetails,
    detailsRef,
    posts,
    setPosts,
    requestDetail,
    effectiveVideoIds,
  };
}
