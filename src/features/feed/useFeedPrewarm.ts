/* ── 首分片预热调度（Muse 2026-11-19 根治包：自 Feed 抽出，Feed.tsx
 * 尺寸预算硬门要求关注点外移）──
 * 当前条目地址一解析完立即预热其清单＋首分片（P0-B 起播优化——旧实现
 * 只热下一条、当前条目冷启全程串行）；下一条仍等本条出画后再热。
 * 失败记时间戳、30s 后可重试一次（P2-07，防失败风暴）；作用域变化
 * 整表作废（键已含作用域，此处再清标记防无界增长）。预热本体见
 * prewarm.ts（只用 fetch 走与播放器逐字相同的本地代理 URL）。 */
import { useEffect, useRef } from "react";
import type { Episode } from "../../shared/api/types";
import { prewarmFirstSegment, prewarmRetryDue, type PrewarmMark } from "./prewarm";

export function useFeedPrewarm(opts: {
  active: boolean;
  kind: "video" | "post";
  scope: string;
  lineEpoch: number;
  playKey: string;
  playingKey: string;
  curId: number;
  curEp: number;
  nextVideoId: number | undefined;
  episodes: Episode[];
  cacheVersion: number;
  keyFor: (id: number, ep: number) => string;
  getMain: (key: string) => string | undefined;
}) {
  const prewarmedRef = useRef<Map<string, PrewarmMark>>(new Map());
  const scopeRef = useRef("");
  const scope = `${opts.scope}:${opts.lineEpoch}`;
  if (scopeRef.current !== scope) {
    scopeRef.current = scope;
    prewarmedRef.current.clear();
  }
  const { active, kind, playKey, playingKey, curId, curEp, nextVideoId, episodes, cacheVersion, keyFor, getMain } = opts;
  useEffect(() => {
    if (!active || kind !== "video") return;
    const targets: { id: number; key: string }[] = [{ id: curId, key: playKey }];
    if (playingKey === playKey) {
      if (nextVideoId) targets.push({ id: nextVideoId, key: keyFor(nextVideoId, 1) });
      const nextEp = episodes.find((e) => e.ep_num === curEp + 1);
      if (nextEp) targets.push({ id: curId, key: keyFor(curId, nextEp.ep_num) });
    }
    const ctrl = new AbortController();
    const now = Date.now();
    for (const t of targets) {
      const raw = getMain(t.key);
      if (!raw) continue;
      const mark = prewarmedRef.current.get(t.key);
      if (!prewarmRetryDue(mark, now)) continue;
      prewarmedRef.current.set(t.key, { at: now, ok: false, retries: (mark?.retries ?? 0) + (mark ? 1 : 0) });
      void prewarmFirstSegment(t.id, raw, ctrl.signal).then(ok => {
        const cur = prewarmedRef.current.get(t.key);
        if (cur && cur.at === now) prewarmedRef.current.set(t.key, { ...cur, ok });
      });
    }
    return () => ctrl.abort();
  }, [active, kind, playingKey, playKey, nextVideoId, curEp, episodes, cacheVersion, keyFor, getMain]);
}
