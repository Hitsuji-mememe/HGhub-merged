/**
 * 外部源视频浏览页（Muse 2026-11-19 最终版 D 线，①用户点名条目：
 * 外部源浏览页接通；②实锤问题：createAdapter 此前只有测试调用、
 * 生产调用为 0——根治包以来最大功能缺口）。
 *
 * 本组件是 createAdapter 的生产调用者：频道页选中非黄果 video 源时
 * 由 Category.ChannelPage 挂载（blocked 源不进这里、仍走既有诚实
 * 提示页 SourcePendingNotice）。数据全程经适配器（list/detail/
 * resolve），失败呈现错误态＋重试，不用假数据、不静默回落黄果
 * 数据冒充。probe 源同样真取数，取不到即错误态。
 *
 * 播放：点开条目先经适配器 resolve 取播放地址，再以现有 props
 * 消费既有 Player（src/poster/autoPlay/active/controls/scopeKey，
 * 与 Posts 页同款用法）——不改 Player 内部。Feed 页（push kind=
 * "feed"）按黄果数值 id 走仓内 api，承接不了外部源流地址，故外部
 * 详情在本页内呈现、返回走本页内状态（与栈页 push/pop 口径并存，
 * 不新增路由 kind）。
 */
import { Button } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useCallback, useEffect, useRef, useState } from "react";
import { cover } from "../../shared/api/api";
import { MediaCard } from "../../shared/ui/cards";
import { Empty } from "../../shared/ui/ui";
import { IBack, IFilm } from "../../shared/ui/icons";
import { Player } from "../playback";
import { registerOverlayBack } from "../../shared/lib/back";
import { createAdapter } from "./adapters/index.ts";
import type { SourceDef, SourceItem } from "./types.ts";

type DetailState =
  | { phase: "loading"; item: SourceItem }
  | { phase: "ready"; item: SourceItem; streamUrl: string }
  | { phase: "error"; item: SourceItem; message: string };

export default function SourceBrowse({ def, onDetailOpenChange }: {
  def: SourceDef;
  /** 详情开合回报（Muse 2026-11-20 fix331/covers-header，3.3.1 真机
   * 首验问题②）：本组件挂在 ChannelPage 内，详情自带一层页头（返回
   * 列表＋标题）；详情打开时宿主必须让位自己的页头，否则双层标题
   * 栏＋两枚返回键同屏（真机图 1 实锤）。宿主据此隐藏外层页头，
   * 详情关闭自动恢复。 */
  onDetailOpenChange?: (open: boolean) => void;
}) {
  const [items, setItems] = useState<SourceItem[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  useEffect(() => {
    onDetailOpenChange?.(detail !== null);
  }, [detail, onDetailOpenChange]);
  const busy = useRef(false);
  const seq = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);

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
    setItems([]); setPage(0); setPages(1); setDetail(null);
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def.id]);

  /* 嵌套返回语义（fix331/gesture-precedence）：详情在本页内状态
   * 呈现、不推栈（文件头既有口径）——打开期间向统一返回序登记
   * 本层消费方，back 先关详情回列表，不再落穿成退整个频道页；
   * 登记同时是手势链嵌套资格的事实源（backConsumerActive）。 */
  const detailOpen = detail !== null;
  useEffect(() => {
    if (!detailOpen) return undefined;
    return registerOverlayBack(() => { setDetail(null); return true; });
  }, [detailOpen]);

  const openItem = useCallback(async (item: SourceItem) => {
    const adapter = createAdapter(def);
    if (!adapter) { setDetail({ phase: "error", item, message: "该源未注册可用适配器" }); return; }
    setDetail({ phase: "loading", item });
    try {
      const res = await adapter.resolve(item.externalId);
      const stream = res.streams[0];
      if (!stream) { setDetail({ phase: "error", item, message: "该条目未解析到可播放地址" }); return; }
      setDetail({ phase: "ready", item, streamUrl: stream.url });
    } catch (e) {
      setDetail({ phase: "error", item, message: (e as Error).message || "播放地址解析失败" });
    }
  }, [def]);

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
          <Empty icon={<IFilm size={26} />} title="播放地址获取失败" sub={detail.message} action="重试" onAction={() => void openItem(detail.item)} />
        )}
        {detail.phase === "ready" && (
          <div className="px-4">
            <Player src={detail.streamUrl} poster={cover(detail.item.cover)} autoPlay active controls
              scopeKey={`${def.id}:${detail.item.externalId}`}
              diagnosticContext={{ view: "source_browse", source_id: def.id }}
              className="w-full aspect-video" />
            <p className="mt-3 text-[12px] text-mut">数据源：{def.displayName}（经适配器实时取数，非黄果数据）</p>
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
            <MediaCard key={item.externalId} title={item.title} cover={item.cover} surface="source-browse"
              subtitle={item.tags?.slice(0, 2).join(" · ") || def.displayName}
              onOpen={() => void openItem(item)} />
          ))}
        </div>
      ) : err ? (
        <Empty icon={<IFilm size={26} />} title="加载失败" sub={err} action="重试" onAction={() => void load(true)} />
      ) : loading ? (
        <div className="flex justify-center py-10"><Loader className="w-8 h-8 spinner" /></div>
      ) : (
        <Empty icon={<IFilm size={26} />} title="该源暂无内容" sub="已取数，列表确为空（解析不到条目时已按加载失败处理）" />
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
