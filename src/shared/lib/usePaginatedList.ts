import { useCallback, useEffect, useRef, useState } from "react";
import type { Paged } from "../api/types";
import { traceFeed } from "./feedTrace";

type Options<T> = {
  enabled?: boolean;
  resetKey?: string | number;
  rootMargin?: string;
  /** 诊断轨迹的列表标识（fix2.1 批三#10）：本 hook 的分页事件统一带
   * 上它，feedTraceSummary 按列表隔离汇总；手写分页（频道/专题/标签）
   * 早已带 list，本 hook 此前缺失、多列表同会话时摘要混算。 */
  listId?: string;
  getId: (item: T) => number | string;
  request: (page: number) => Promise<Paged<T> | null | undefined>;
};

/** 分页状态机（Muse 2026-11-19 fix2 A2 重写）：
 * idle → loading → idle（还有更多）/ exhausted（到尾页）/ error（可重试）。
 * 旧实现三处失效模式（真机：吃瓜只出首屏 20 篇、翻页永不恢复）：
 * ①请求无超时——慢线下请求悬挂则 busy/loading 永不释放，哨兵与按钮
 *   双双被 loading 堵死；②err 一置位哨兵 effect 整体停摆，失败一次
 *   即永久停在该页（重试入口只剩列表最底部的行，用户够不着）；
 * ③空页响应把 pages 塌缩到当前页，hasMore 误判到尾提前终止。
 * 现行不变量：同页禁并发（status=loading 直接返回）；每次请求带
 * seq，超时/重置后迟到的响应一律丢弃并记 page.stale；失败只进
 * error 态、页码不前进，重试即重打同一页；终止只认接口
 * pagination.pages，空页但未到尾页照常前进；哨兵只「提请求」，
 * 加载成功后由调度检查哨兵是否仍在预取区、是则续拉下一页，
 * 不再把 IntersectionObserver 的边沿通知当唯一驱动。 */
type PageStatus = "idle" | "loading" | "error" | "exhausted";
const REQUEST_TIMEOUT_MS = 30_000;
const ERROR_RETRY_COOLDOWN_MS = 3_000;
const MAX_AUTO_PREFETCH = 3;

export function usePaginatedList<T>({
  enabled = true,
  resetKey = "",
  rootMargin = "240px",
  listId = "paginated",
  getId,
  request,
}: Options<T>) {
  const [items, setItems] = useState<T[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const generation = useRef(0);
  const machine = useRef<{
    status: PageStatus;
    page: number;
    pages: number;
    seq: number;
    lastFailAt: number;
    autoPrefetch: number;
  }>({ status: "idle", page: 0, pages: 1, seq: 0, lastFailAt: 0, autoPrefetch: 0 });
  const listIdRef = useRef(listId);
  listIdRef.current = listId;
  const requestRef = useRef(request);
  requestRef.current = request;
  const getIdRef = useRef(getId);
  getIdRef.current = getId;
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const sentinelVisible = useRef(false);

  const setStatus = useCallback((to: PageStatus) => {
    const m = machine.current;
    if (m.status === to) return;
    traceFeed("page.state", { list: listIdRef.current, from: m.status, to, page: m.page });
    m.status = to;
    setLoading(to === "loading");
  }, []);

  const runRequest = useCallback(async (reset: boolean, source: string) => {
    const m = machine.current;
    if (!enabled) return;
    if (!reset) {
      if (m.status === "loading" || m.status === "exhausted") return;
      if (m.status === "error" && source === "sentinel"
        && Date.now() - m.lastFailAt < ERROR_RETRY_COOLDOWN_MS) return;
    }
    const gen = reset ? ++generation.current : generation.current;
    const target = reset ? 1 : m.page + 1;
    const seq = ++m.seq;
    if (reset) {
      m.page = 0;
      m.pages = 1;
      m.autoPrefetch = 0;
    }
    setStatus("loading");
    setErr("");
    traceFeed("page.request", { list: listIdRef.current, page: target, source, seq, reset });
    const startedAt = Date.now();
    let timer: number | undefined;
    try {
      const response = await Promise.race([
        requestRef.current(target),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => reject(new Error("__feed_timeout__")), REQUEST_TIMEOUT_MS);
        }),
      ]);
      if (gen !== generation.current || seq !== m.seq) {
        traceFeed("page.stale", { list: listIdRef.current, page: target, seq, why: "late-response" });
        return;
      }
      const incoming = response?.items || [];
      const idOf = getIdRef.current;
      let uniqueCount = 0;
      setItems((previous) => {
        const base = reset ? [] : previous;
        const seen = new Set(base.map(idOf));
        const unique = incoming.filter((item) => {
          const key = idOf(item);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        uniqueCount = unique.length;
        return [...base, ...unique];
      });
      /* 终止只认接口分页：空页不再塌缩 pages（旧失效模式③）。接口
       * 没给 pages 时才回落「空页即到尾」的保守推断。 */
      const resolvedPages = response?.pagination?.pages
        ?? (incoming.length > 0 ? Math.max(m.pages, target) : target);
      m.page = target;
      m.pages = resolvedPages;
      setPage(target);
      setPages(resolvedPages);
      setTotal(Number.isFinite(response?.pagination?.total) ? response!.pagination.total : null);
      const more = target < resolvedPages;
      setHasMore(more);
      traceFeed("page.success", {
        list: listIdRef.current,
        page: target, received: incoming.length, unique: uniqueCount,
        pages: resolvedPages, total: response?.pagination?.total ?? null,
        ms: Date.now() - startedAt,
        scrollTop: scroller.current?.scrollTop ?? null,
        scrollHeight: scroller.current?.scrollHeight ?? null,
        clientHeight: scroller.current?.clientHeight ?? null,
      });
      setStatus(more ? "idle" : "exhausted");
      /* 预取调度：哨兵仍在预取区且未到尾，续拉下一页（有上限防
       * 整页被过滤/内容过矮时的无限连拉）。哨兵边沿通知不再是
       * 唯一驱动（旧失效模式：追加内容后哨兵不重触发即停摆）。
       * reset 成功同样走调度（fix2.1 整改，GPT 四审 #2）：首屏内容
       * 过矮时哨兵在 reset 完成前就已可见、边沿早被消费，旧条件
       * 排除 reset 会让短列表永远停在第一页——MAX_AUTO_PREFETCH
       * 注释本就是为「内容过矮」设的，reset 路径不该被排除在外。 */
      if (more && sentinelVisible.current
        && m.autoPrefetch < MAX_AUTO_PREFETCH) {
        m.autoPrefetch++;
        void runRequest(false, "prefetch");
      } else if (!more || !sentinelVisible.current) {
        m.autoPrefetch = 0;
      }
    } catch (error) {
      if (gen !== generation.current || seq !== m.seq) {
        traceFeed("page.stale", { list: listIdRef.current, page: target, seq, why: "late-error" });
        return;
      }
      const timedOut = error instanceof Error && error.message === "__feed_timeout__";
      if (timedOut) m.seq++; // 让悬挂中的原请求回来时按 stale 丢弃
      m.lastFailAt = Date.now();
      traceFeed("page.fail", {
        list: listIdRef.current,
        page: target, seq, reason: timedOut ? "timeout" : "error",
        ms: Date.now() - startedAt,
        message: timedOut ? `请求超过 ${REQUEST_TIMEOUT_MS / 1000}s 未返回` : (error instanceof Error ? error.message : "加载失败"),
      });
      setErr(timedOut ? "加载超时，请重试" : (error instanceof Error ? error.message : "加载失败，请重试"));
      setStatus("error");
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
      if (gen === generation.current && seq === m.seq && machine.current.status === "loading") {
        setStatus("idle");
      }
    }
  }, [enabled, setStatus]);

  const loadMore = useCallback((reset = false) => {
    void runRequest(reset, reset ? "reset" : "button");
  }, [runRequest]);

  useEffect(() => {
    generation.current++;
    machine.current = { status: "idle", page: 0, pages: 1, seq: 0, lastFailAt: 0, autoPrefetch: 0 };
    setItems([]);
    setPage(0);
    setPages(1);
    setErr("");
    setTotal(null);
    setHasMore(false);
    setLoading(false);
    if (scroller.current) scroller.current.scrollTop = 0;
    if (enabled) void runRequest(true, "reset");
    return () => { generation.current++; };
  }, [enabled, resetKey, runRequest]);

  /* 哨兵：只记录可见性并「提请求」，是否放行由状态机决定（error 态
   * 过冷却后哨兵重入可再触发重试，不再因 err 整体停摆——旧失效
   * 模式②）。自动翻页无条件启用（3.2.2 集成批，用户实报开标签屏蔽
   * 时信息流永不自动续页）：旧 filtering 门（防整页屏蔽连环拉）已
   * 撤销——连拉由 MAX_AUTO_PREFETCH 上限＋接口 pages 终止＋失败
   * 3s 冷却三重兜底，整页被屏蔽时最多多拉 3 页即停。 */
  useEffect(() => {
    const el = sentinel.current;
    if (!enabled || !el || !scroller.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        sentinelVisible.current = entry.isIntersecting;
        traceFeed("sentinel", {
          list: listIdRef.current,
          isIntersecting: entry.isIntersecting,
          ratio: Math.round(entry.intersectionRatio * 100) / 100,
          status: machine.current.status, page: machine.current.page,
        });
        if (entry.isIntersecting) void runRequest(false, "sentinel");
      },
      { root: scroller.current, rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled, rootMargin, runRequest]);

  return { items, page, pages, loading, err, total, hasMore, loadMore, scroller, sentinel };
}
