/**
 * 图片源图集浏览页（Muse 2026-11-19 最终版 D 线，①用户点名条目：
 * 图片分区）。分类页「图片」分区点开 image 源后经 Category.
 * ChannelPage（cate="image:<sourceId>"）挂载本页：相册网格（适配器
 * list）→ 点开相册经适配器 detail 取图集 → 大图查看（AlbumViewer
 * 全屏悬浮层形态，3.2.1 F6 线）。数据全程走适配器，取不到如实错误态＋重试，不假数据、
 * 不回落其他源。blocked 源不进这里（ChannelPage 先拦截走既有诚实
 * 提示页）。
 */
import { Button } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useCallback, useEffect, useRef, useState } from "react";
import { MediaCard } from "../../shared/ui/cards";
import { Empty } from "../../shared/ui/ui";
import { IBack, IGrid } from "../../shared/ui/icons";
import { AlbumViewer } from "./AlbumViewer.tsx";
import { createAdapter } from "./adapters/index.ts";
import type { SourceDef, SourceItem } from "./types.ts";

type AlbumState =
  | { phase: "loading"; item: SourceItem }
  | { phase: "ready"; item: SourceItem; images: string[]; index: number }
  | { phase: "error"; item: SourceItem; message: string };

export default function SourceGallery({ def }: { def: SourceDef }) {
  const [items, setItems] = useState<SourceItem[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [album, setAlbum] = useState<AlbumState | null>(null);
  const busy = useRef(false);
  const seq = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (reset: boolean) => {
    if (busy.current) return;
    const adapter = createAdapter(def);
    if (!adapter) { setLoading(false); setErr("该源未注册可用适配器，暂不能浏览"); return; }
    busy.current = true;
    setLoading(true);
    if (reset) setErr(null);
    const mySeq = ++seq.current;
    try {
      const next = reset ? 1 : page + 1;
      const res = await adapter.list(next, 20);
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
  }, [def, page, pages]);

  /* 自动续页（3.2.2 集成批）：哨兵接近底部自动拉下一页；失败置
   * err 后哨兵停摆、底部「加载更多」按钮只作兜底出现（手点不作
   * 主路径）。连拉由接口 pages 终止与 busy 单飞兜底。 */
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || loading || err || page >= pages || items.length === 0) return;
    const io = new IntersectionObserver((es) => {
      if (es[0].isIntersecting) void load(false);
    }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loading, err, page, pages, items.length, load]);

  useEffect(() => {
    seq.current++;
    busy.current = false;
    setItems([]); setPage(0); setPages(1); setAlbum(null);
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def.id]);

  const openAlbum = useCallback(async (item: SourceItem) => {
    const adapter = createAdapter(def);
    if (!adapter) { setAlbum({ phase: "error", item, message: "该源未注册可用适配器" }); return; }
    setAlbum({ phase: "loading", item });
    try {
      const d = await adapter.detail(item.externalId);
      const images = (d.images?.length ? d.images : [d.cover]).filter(Boolean);
      if (!images.length) { setAlbum({ phase: "error", item, message: "该相册未解析到图片" }); return; }
      setAlbum({ phase: "ready", item, images, index: 0 });
    } catch (e) {
      setAlbum({ phase: "error", item, message: (e as Error).message || "图集加载失败" });
    }
  }, [def]);

  if (album) {
    /* 查看态（Muse 2026-11-19 3.2.1修复F6线）：ready 走全屏查看器
     * AlbumViewer（fixed 覆满视口，壳顶栏/频道页顶栏不再与查看器
     * 顶栏叠层挤压图片）；loading/error 维持既有页内形态与文案不变。 */
    if (album.phase === "ready") {
      return (
        <div className="fixed inset-0 z-40 bg-black">
          <AlbumViewer title={album.item.title} images={album.images} index={album.index}
            onIndexChange={(i) => setAlbum({ ...album, index: i })}
            onBack={() => setAlbum(null)} backLabel="返回相册列表"
            onClose={() => setAlbum(null)} immersive />
        </div>
      );
    }
    return (
      <div className="flex flex-col">
        <div className="flex items-center gap-2 px-4 pt-2 pb-3">
          <Button aria-label="返回相册列表" onClick={() => setAlbum(null)} className="ios-nav-btn"><IBack size={20} /></Button>
          <h2 className="flex-1 min-w-0 truncate text-[15px] font-bold text-on">{album.item.title}</h2>
        </div>
        {album.phase === "loading" && (
          <div className="flex justify-center py-16"><Loader className="w-8 h-8 spinner" /></div>
        )}
        {album.phase === "error" && (
          <Empty icon={<IGrid size={26} />} title="图集加载失败" sub={album.message} action="重试" onAction={() => void openAlbum(album.item)} />
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
              onOpen={() => void openAlbum(item)} />
          ))}
        </div>
      ) : err ? (
        <Empty icon={<IGrid size={26} />} title="加载失败" sub={err} action="重试" onAction={() => void load(true)} />
      ) : loading ? (
        <div className="flex justify-center py-10"><Loader className="w-8 h-8 spinner" /></div>
      ) : (
        <Empty icon={<IGrid size={26} />} title="该源暂无相册" sub="已取数，列表确为空（解析不到条目时已按加载失败处理）" />
      )}
      {items.length > 0 && <div ref={sentinelRef} style={{ height: 1 }} />}
      {loading && items.length > 0 && <div className="flex justify-center py-3"><Loader className="w-6 h-6 spinner" /></div>}
      {!loading && err && page < pages && items.length > 0 && (
        <Button onClick={() => void load(false)} className="my-3 px-4 text-primary">加载更多</Button>
      )}
      {!loading && !err && page >= pages && items.length > 0 && (
        <div className="text-center text-[12px] text-dim py-3">— 已经到底啦 —</div>
      )}
    </div>
  );
}
