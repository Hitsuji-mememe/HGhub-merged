/**
 * 外部吃瓜帖浏览页（Muse 2026-11-19 3.3.0 接通批·吃瓜线）：吃瓜帖
 * 分类的外部源浏览组件，与视频 SourceBrowse／图片 SourceGallery 同
 * 批性质——此前唯独 posts 分类从未接浏览组件，非黄果源在 Posts 页
 * 与分类总览一律落诚实提示页（根因见 postsRoute.ts）。
 *
 * 本组件是 createAdapter 在 posts 分类的生产调用者：由 Posts 页
 * （全量形态）与分类总览吃瓜预览（compact 形态）按
 * resolvePostsBrowse 判定挂载（blocked 不进这里、仍走既有诚实
 * 提示页）。数据全程经适配器（list/detail/resolve）走生产取页链，
 * 失败呈现错误态＋重试，不用假数据、不回落黄果数据冒充。
 *
 * 详情形态与原生 PostDetail 同口径（最终版 D2）：先文后视频——
 * 标题/正文在前，播放器区在正文之后；仍是点了才播（resolve 只备
 * 流地址，海报点击才挂 Player）。正文 HTML 经 sanitizeHtml 后以
 * article-body 呈现；无流条目只显封面、不假装可播。
 */
import { Button } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, cover } from "../../shared/api/api";
import { copyText } from "../../shared/lib/clipboard";
import { handleArticleClick, sanitizeHtml } from "../../shared/lib/html";
import { MediaCard } from "../../shared/ui/cards";
import { Empty, Img } from "../../shared/ui/ui";
import { IBack, IFireF, IPlayF } from "../../shared/ui/icons";
import { useStore } from "../../shared/model/store";
import { Player } from "../playback";
import { createAdapter } from "./adapters/index.ts";
import type { SourceDef, SourceDetail, SourceItem } from "./types.ts";

type DetailState =
  | { phase: "loading"; item: SourceItem }
  | { phase: "ready"; item: SourceItem; detail: SourceDetail; streamUrl: string | null; play: boolean }
  | { phase: "error"; item: SourceItem; message: string };

export default function SourcePosts({ def, compact = false, onShowAll, onSettledEmpty }: {
  def: SourceDef;
  /** compact＝分类总览预览形态：只拉第一页少量条目、无哨兵续页，
   * 底部「查看全部」由调用方接（跳吃瓜页）。 */
  compact?: boolean;
  onShowAll?: () => void;
  /** 已结空态回报（fix330/ui-fixes）：首批加载已结算（成功返回过
   * 至少一页）∧非加载∧无错误∧条目为 0 时报 true，其余报 false；
   * 分类总览据此整区隐藏空的吃瓜区。不传则不回报（Posts 页）。 */
  onSettledEmpty?: (empty: boolean) => void;
}) {
  const { toast } = useStore();
  const [items, setItems] = useState<SourceItem[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const busy = useRef(false);
  const seq = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const pageSize = compact ? 8 : 20;

  const load = useCallback(async (reset: boolean) => {
    if (busy.current) return;
    const adapter = createAdapter(def);
    if (!adapter) {
      setLoading(false);
      setErr("该源未注册可用适配器，暂不能浏览");
      return;
    }
    busy.current = true;
    setLoading(true);
    if (reset) setErr(null);
    const mySeq = ++seq.current;
    try {
      const next = reset ? 1 : page + 1;
      const res = await adapter.list(next, pageSize);
      if (mySeq !== seq.current) return;
      setItems((prev) => (reset ? res.items : [...prev, ...res.items.filter((x) => !prev.some((y) => y.externalId === x.externalId))]));
      setPage(next);
      setPages(res.pagination?.pages ?? (res.items.length ? Math.max(reset ? 1 : pages, next) : next));
      setErr(null);
    } catch (e) {
      if (mySeq === seq.current) setErr((e as Error).message || "加载失败");
    } finally {
      if (mySeq === seq.current) { busy.current = false; setLoading(false); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, page, pages, pageSize]);

  /* 自动续页（与 SourceBrowse 同口径）：哨兵接近底部自动拉下一页；
   * 失败置 err 后哨兵停摆、「加载更多」只作兜底。compact 不续页。 */
  useEffect(() => {
    const el = sentinelRef.current;
    if (compact || !el || loading || err || page >= pages || items.length === 0) return;
    const io = new IntersectionObserver((es) => {
      if (es[0].isIntersecting) void load(false);
    }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [compact, loading, err, page, pages, items.length, load]);

  useEffect(() => {
    seq.current++;
    busy.current = false;
    setItems([]); setPage(0); setPages(1); setDetail(null);
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def.id]);

  /* 已结空态回报（fix330/ui-fixes）：page>0 表示至少一页成功返回
   * （失败走 err 不算已结）；源切换时 items/page 先复位、loading
   * 回 true，回报自动回到 false，总览区不会被旧源空态误藏。 */
  const settledEmpty = !loading && !err && items.length === 0 && page > 0;
  useEffect(() => {
    onSettledEmpty?.(settledEmpty);
  }, [settledEmpty, onSettledEmpty]);

  const openItem = useCallback(async (item: SourceItem) => {
    const adapter = createAdapter(def);
    if (!adapter) { setDetail({ phase: "error", item, message: "该源未注册可用适配器" }); return; }
    setDetail({ phase: "loading", item });
    try {
      const [d, res] = await Promise.all([
        adapter.detail(item.externalId),
        adapter.resolve(item.externalId).catch(() => ({ streams: [] as { url: string; kind: "hls" | "file" }[] })),
      ]);
      setDetail({ phase: "ready", item, detail: d, streamUrl: res.streams[0]?.url ?? null, play: false });
    } catch (e) {
      setDetail({ phase: "error", item, message: (e as Error).message || "详情加载失败" });
    }
  }, [def]);

  const openSafeLink = (url: string) => {
    api.openUrl(url).catch(() => {
      copyText(url).then(() => toast("链接已复制", "ok")).catch(() => toast("复制失败", "info"));
    });
  };

  if (detail) {
    return (
      <div className="flex flex-col">
        <div className="flex items-center gap-2 px-4 pt-2 pb-3">
          <Button aria-label="返回列表" onClick={() => setDetail(null)} className="ios-nav-btn"><IBack size={20} /></Button>
          <h2 className="flex-1 min-w-0 truncate text-[15px] font-bold text-on">{detail.item.title}</h2>
        </div>
        {detail.phase === "loading" && (
          <div className="flex justify-center py-16"><Loader className="w-8 h-8 spinner" /></div>
        )}
        {detail.phase === "error" && (
          <Empty icon={<IFireF size={26} />} title="详情加载失败" sub={detail.message} action="重试" onAction={() => void openItem(detail.item)} />
        )}
        {detail.phase === "ready" && (
          <div className="pb-6">
            <div className="px-4 mx-auto max-w-[800px] select-text">
              <h1 className="text-[17px] font-bold text-on leading-snug">{detail.detail.title || detail.item.title}</h1>
              {detail.detail.contentHtml ? (
                <div className="article-body mt-3.5" onClick={(e) => handleArticleClick(e, openSafeLink)}
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(detail.detail.contentHtml) }} />
              ) : detail.detail.description ? (
                <p className="mt-3.5 text-[14px] leading-relaxed text-on/80 whitespace-pre-wrap">{detail.detail.description}</p>
              ) : null}
            </div>
            {/* 先文后视频（D2 同口径）：播放器区在正文之后、点了才播；
                无流条目只显封面。封面 Button 带 rounded-none 断掉全局
                胶囊圆角继承裁切（PostDetail 同批修复口径）。 */}
            <div className="relative w-full bg-black mx-auto mt-5" style={{ height: "min(48vh, 420px)" }}>
              {detail.play && detail.streamUrl ? (
                <Player src={detail.streamUrl} poster={cover(detail.detail.cover || detail.item.cover)} autoPlay active controls
                  scopeKey={`${def.id}:${detail.item.externalId}`}
                  diagnosticContext={{ view: "source_posts", source_id: def.id }}
                  className="w-full h-full" />
              ) : detail.streamUrl ? (
                <Button aria-label="播放视频" onClick={() => setDetail({ ...detail, play: true })} className="absolute inset-0 rounded-none">
                  <Img src={detail.detail.cover || detail.item.cover} eager />
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="w-14 h-14 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center elev-2">
                      <IPlayF size={24} className="text-white ml-0.5" />
                    </span>
                  </span>
                </Button>
              ) : (
                <div className="absolute inset-0"><Img src={detail.detail.cover || detail.item.cover} eager /></div>
              )}
            </div>
            <p className="mt-3 px-4 text-[12px] text-mut">数据源：{def.displayName}（经适配器实时取数，非黄果数据）</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="px-4 pt-2">
      {items.length > 0 && err && (
        <div role="status" className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-mut">
          <span>{err}</span><Button className="px-3 text-primary" onClick={() => void load(false)}>重试</Button>
        </div>
      )}
      {items.length ? (
        <div className="ios-media-grid" data-ui="media-grid">
          {items.map((item) => (
            <MediaCard key={item.externalId} title={item.title} cover={item.cover}
              subtitle={item.tags?.slice(0, 2).join(" · ") || def.displayName}
              onOpen={() => void openItem(item)} />
          ))}
        </div>
      ) : err ? (
        <Empty icon={<IFireF size={26} />} title="加载失败" sub={err} action="重试" onAction={() => void load(true)} />
      ) : loading ? (
        <div className="flex justify-center py-10"><Loader className="w-8 h-8 spinner" /></div>
      ) : (
        <Empty icon={<IFireF size={26} />} title="该源暂无内容" sub="已取数，列表确为空（解析不到条目时已按加载失败处理）" />
      )}
      {!compact && items.length > 0 && <div ref={sentinelRef} style={{ height: 1 }} />}
      {loading && items.length > 0 && <div className="flex justify-center py-3"><Loader className="w-6 h-6 spinner" /></div>}
      {!compact && !loading && err && page < pages && items.length > 0 && (
        <Button onClick={() => void load(false)} className="my-3 px-4 text-primary">加载更多</Button>
      )}
      {!compact && !loading && !err && page >= pages && items.length > 0 && (
        <div className="text-center text-[12px] text-dim py-3">— 已经到底啦 —</div>
      )}
      {compact && items.length > 0 && onShowAll && (
        <Button onClick={onShowAll} className="w-full mt-3 text-primary">查看全部</Button>
      )}
    </div>
  );
}
