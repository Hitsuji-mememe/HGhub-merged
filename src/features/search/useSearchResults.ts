import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../shared/api/api";
import { withRequestTimeout } from "../../shared/lib/withTimeout";
import {
  filterSearchCardsByKind,
  hasEpisodeStructureSignal,
  type EpisodeStructureSignal,
} from "../../shared/lib/contentKind";
import type { Post, VideoCard } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";

type SearchKind = "video" | "post";
type Result = {
  keyword: string; kind: SearchKind; items: (VideoCard | Post)[];
  page: number; pages: number; total: number | null;
};
type Request = { keyword: string; kind: SearchKind; page: number };
const CACHE_TTL = 60_000;
const CACHE_LIMIT = 8;
const CACHE_ITEMS = 200;

/** Keep query identity together with its cards so pending searches never relabel old content. */
export function useSearchResults(scope?: "original") {
  const { lineEpoch, accountScope } = useStore();
  const [rawResult, setRawResult] = useState<Result | null>(null);
  const [request, setRequest] = useState<Request | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<Result | null>(null);
  const attempt = useRef<Request | null>(null);
  const busy = useRef(false);
  const sequence = useRef(0);
  const cache = useRef(new Map<string, { result: Result; at: number }>());
  useEffect(() => () => { sequence.current++; }, []);
  const envKey = `${accountScope}:${lineEpoch}`;
  const prevEnvRef = useRef(envKey);
  /* F4c 补判规范信号（与全局搜索 Search.tsx 同接缝/同口径）：key=
   * `${accountScope}:${lineEpoch}:${id}`，值只存 Detail 的剧集结构
   * 信号；请求登记先行、成败都不重复查同一 ID；写入后经版本号触发
   * 下方性质门重跑、条目自动归位。 */
  const canonicalSignals = useRef(new Map<string, EpisodeStructureSignal>());
  const kindLookupRequested = useRef(new Set<string>());
  const [canonicalVersion, setCanonicalVersion] = useState(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const publish = (value: Result | null) => { current.current = value; setRawResult(value); };

  /* ── F4c 性质门（验收 C 定性违例修复）：站内搜索两面此前未接性质
   * 判定——original 面（呈现「视频」）仅 is_original 过滤放行多集剧、
   * 无 scope 面（呈现「短剧」）零过滤混入单条。视频结果一律过
   * shared/lib/contentKind 的 filterSearchCardsByKind（唯一出处）：
   * 目标性质与呈现标签同口径（scope === "original" ? "video" :
   * "drama"），drama/video 互斥、unknown 暂不呈现、补判到达自动
   * 归位。服务端 total 是未过滤计数、与门后条数不可比，置 null
   * （original 面原已如此）。帖子结果不走性质门、原样呈现。 ── */
  const targetKind = scope === "original" ? "video" : "drama";
  const result = useMemo<Result | null>(() => {
    if (!rawResult || rawResult.kind !== "video") return rawResult;
    const items = filterSearchCardsByKind(
      rawResult.items as VideoCard[], targetKind,
      (card) => canonicalSignals.current.get(`${envKey}:${card.id}`),
    );
    return { ...rawResult, items, total: null };
    // canonicalVersion 是补判到达的失效信号：补判写入 Map 后自增触发重跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawResult, canonicalVersion, envKey, targetKind]);

  /* ── F4c 补判：搜索载荷信号缺失的条目按 ID 查 Detail 规范信号 ──
   * 只查信号缺失者（自带正计数者已可判定）；并发 Math.min(4, …)
   * 与全局搜索同口径 ≤4；失败静默（不弹窗、不置错误态），条目保持
   * unknown 暂扣，成功后经性质门重跑归位到正确面。 */
  useEffect(() => {
    if (rawResult?.kind !== "video") return;
    const queue = (rawResult.items as VideoCard[]).filter((v) => {
      const key = `${envKey}:${v.id}`;
      return !hasEpisodeStructureSignal(v) && !kindLookupRequested.current.has(key);
    });
    if (!queue.length) return;
    queue.forEach((v) => kindLookupRequested.current.add(`${envKey}:${v.id}`));
    const worker = async () => {
      while (queue.length > 0) {
        const v = queue.shift()!;
        try {
          const d = await api.video(v.id);
          if (d) {
            canonicalSignals.current.set(`${envKey}:${v.id}`, {
              total_episodes: d.total_episodes, episode_count: d.episode_count, episodes: d.episodes,
            });
            if (alive.current) setCanonicalVersion((x) => x + 1);
          }
        } catch { /* 静默：补不到保持 unknown 安全侧 */ }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => worker()));
  }, [rawResult, envKey]);
  const run = async (next: Request, reuse = false) => {
    if (busy.current && (next.page > 1 || (attempt.current?.keyword === next.keyword
      && attempt.current.kind === next.kind && attempt.current.page === next.page))) return;
    const seq = ++sequence.current;
    attempt.current = next;
    setRequest(next);
    setError(null);
    const key = JSON.stringify([envKey, scope, next.kind, next.keyword]);
    const cached = cache.current.get(key);
    if (reuse && cached && Date.now() - cached.at < CACHE_TTL) {
      publish(cached.result);
      busy.current = false;
      setLoading(false);
      return;
    }
    // Same-kind searches keep their old cards and original keyword until replacement arrives.
    // Type switches only display results belonging to the selected type.
    if (current.current?.kind !== next.kind) publish(null);
    busy.current = true;
    setLoading(true);
    try {
      /* 超时护栏（fix2 A2 推广）：悬挂请求会把 busy 永久堵死、同词
       * 翻页与重试双亡；30s 竞速超时走 catch 置错误态。 */
      const response = await withRequestTimeout(api.search(next.keyword, next.page, 20, next.kind));
      if (sequence.current !== seq) return;
      const old = current.current;
      const base = next.page > 1 && old?.keyword === next.keyword && old.kind === next.kind ? old.items : [];
      const seen = new Set(base.map(item => item.id));
      const incoming = (response?.items || []).filter(item => !(scope === "original" && next.kind === "video") || item.is_original === 1);
      const items = [...base, ...incoming.filter(item => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      })];
      const total = response?.pagination?.total;
      const value: Result = { keyword: next.keyword, kind: next.kind, items, page: next.page,
        pages: Math.max(next.page, response?.pagination?.pages || next.page),
        total: scope === "original" || !Number.isFinite(total) || total < items.length ? null : total };
      publish(value);
      cache.current.delete(key);
      if (items.length <= CACHE_ITEMS) cache.current.set(key, { result: value, at: Date.now() });
      while (cache.current.size > CACHE_LIMIT) cache.current.delete(cache.current.keys().next().value!);
    } catch (error) {
      if (sequence.current === seq) setError(error instanceof Error ? error.message : "搜索失败，请重试");
    } finally {
      if (sequence.current === seq) { busy.current = false; setLoading(false); }
    }
  };
  const search = (keyword: string, kind: SearchKind, reuse = false) => {
    const trimmed = keyword.trim();
    if (trimmed) void run({ keyword: trimmed, kind, page: 1 }, reuse);
  };
  const loadMore = () => {
    const data = current.current, latest = attempt.current;
    if (!data || !latest || data.keyword !== latest.keyword || data.kind !== latest.kind || data.page >= data.pages) return;
    void run({ keyword: data.keyword, kind: data.kind, page: data.page + 1 });
  };
  const retry = () => { if (!busy.current && attempt.current) void run(attempt.current); };
  const clear = () => {
    sequence.current++;
    busy.current = false; attempt.current = null;
    publish(null); setRequest(null); setLoading(false); setError(null);
  };
  useEffect(() => {
    if (prevEnvRef.current === envKey) return;
    prevEnvRef.current = envKey;
    sequence.current++;
    busy.current = false;
    if (attempt.current) void run({ ...attempt.current, page: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envKey]);
  return { result, request, loading, error, search, loadMore, retry, clear };
}
