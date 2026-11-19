/**
 * 图片源图集浏览页（Muse 2026-11-19 最终版 D 线，①用户点名条目：
 * 图片分区）。分类页「图片」分区点开 image 源后经 Category.
 * ChannelPage（cate="image:<sourceId>"）挂载本页：相册网格（适配器
 * list）→ 点开相册经适配器 detail 取图集 → 大图查看（上一张/下一
 * 张/关闭）。数据全程走适配器，取不到如实错误态＋重试，不假数据、
 * 不回落其他源。blocked 源不进这里（ChannelPage 先拦截走既有诚实
 * 提示页）。
 */
import { Button } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useCallback, useEffect, useRef, useState } from "react";
import { MediaCard } from "../../shared/ui/cards";
import { Empty, Img } from "../../shared/ui/ui";
import { IBack, IChevR, IClose, IGrid } from "../../shared/ui/icons";
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
    return (
      <div className="flex flex-col">
        <div className="flex items-center gap-2 px-4 pt-2 pb-3">
          <Button aria-label="返回相册列表" onClick={() => setAlbum(null)} className="ios-nav-btn"><IBack size={20} /></Button>
          <h2 className="flex-1 min-w-0 truncate text-[15px] font-bold text-on">{album.item.title}</h2>
          {album.phase === "ready" && (
            <span className="shrink-0 text-[12px] text-mut">{album.index + 1} / {album.images.length}</span>
          )}
        </div>
        {album.phase === "loading" && (
          <div className="flex justify-center py-16"><Loader className="w-8 h-8 spinner" /></div>
        )}
        {album.phase === "error" && (
          <Empty icon={<IGrid size={26} />} title="图集加载失败" sub={album.message} action="重试" onAction={() => void openAlbum(album.item)} />
        )}
        {album.phase === "ready" && (
          <div className="px-4 pb-6">
            <div className="relative w-full overflow-hidden rounded-[16px] bg-s2" style={{ aspectRatio: "4 / 5" }}>
              <Img src={album.images[album.index]} alt={album.item.title} eager />
            </div>
            <div className="mt-3 flex items-center justify-between">
              <Button aria-label="上一张" disabled={album.index <= 0}
                onClick={() => setAlbum({ ...album, index: album.index - 1 })}
                className="ios-filter-pill disabled:opacity-40"><span className="inline-flex items-center gap-1"><span className="inline-block -scale-x-100"><IChevR size={14} /></span>上一张</span></Button>
              <Button aria-label="关闭大图" onClick={() => setAlbum(null)} className="ios-nav-btn"><IClose size={18} /></Button>
              <Button aria-label="下一张" disabled={album.index >= album.images.length - 1}
                onClick={() => setAlbum({ ...album, index: album.index + 1 })}
                className="ios-filter-pill disabled:opacity-40"><span className="inline-flex items-center gap-1">下一张<IChevR size={14} /></span></Button>
            </div>
            {album.images.length > 1 && (
              <div className="scroll-x mt-3 flex gap-2" role="group" aria-label="相册图片缩略图">
                {album.images.map((src, i) => (
                  <Button key={`${src}-${i}`} aria-label={`第 ${i + 1} 张`} aria-pressed={i === album.index}
                    onClick={() => setAlbum({ ...album, index: i })}
                    className={`relative h-16 w-12 shrink-0 overflow-hidden rounded-[8px] ${i === album.index ? "ring-2 ring-primary" : "opacity-70"}`}>
                    <Img src={src} alt="" />
                  </Button>
                ))}
              </div>
            )}
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
              onOpen={() => void openAlbum(item)} />
          ))}
        </div>
      ) : err ? (
        <Empty icon={<IGrid size={26} />} title="加载失败" sub={err} action="重试" onAction={() => void load(true)} />
      ) : loading ? (
        <div className="flex justify-center py-10"><Loader className="w-8 h-8 spinner" /></div>
      ) : (
        <Empty icon={<IGrid size={26} />} title="该源暂无相册" sub="适配器已取数，但列表为空" />
      )}
      {loading && items.length > 0 && <div className="flex justify-center py-3"><Loader className="w-6 h-6 spinner" /></div>}
      {!loading && !err && page < pages && items.length > 0 && (
        <Button onClick={() => void load(false)} className="my-3 px-4 text-primary">加载更多</Button>
      )}
      {!loading && !err && page >= pages && items.length > 0 && (
        <div className="text-center text-[12px] text-dim py-3">— 已经到底啦 —</div>
      )}
    </div>
  );
}
