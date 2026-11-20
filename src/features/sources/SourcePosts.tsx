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
 * 流地址，海报点击才挂 Player）。无流条目只显封面、不假装可播。
 *
 * 正文呈现（fix330/reader，用户 23:59 裁定）：不再整页清洗渲染，
 * 经 articleBlocks 提取—重构为内容块（文本段落／图片）原生渲染，
 * 广告/假按钮/导航/推荐/分享件不入块、段级只杀高置信垃圾。降级
 * 链：提取到块→块渲染；定位到内容但全被过滤（正文全是垃圾段）
 * →显简介；提取不到内容（结构未知）→维持 sanitizeHtml 旧渲染，
 * 如实降级不假空。
 */
import { Button } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, cover } from "../../shared/api/api";
import { copyText } from "../../shared/lib/clipboard";
import { handleArticleClick, sanitizeHtml } from "../../shared/lib/html";
import { MediaCard } from "../../shared/ui/cards";
import { Empty, Img } from "../../shared/ui/ui";
import { IBack, IFireF, IPlayF, IStar, IStarF } from "../../shared/ui/icons";
import { useStore } from "../../shared/model/store";
import { externalHashId } from "../../shared/model/localLibrary";
import { registerOverlayBack } from "../../shared/lib/back";
import { Player } from "../playback";
import { extractArticleBlocks } from "./articleBlocks.ts";
import { createAdapter } from "./adapters/index.ts";
import { useStaffPromoVerify } from "./promoVerify.ts";
import { useTitleFallback } from "./titleFallback.ts";
import { useSourceSelfCheckOnView } from "./sourceHealth.ts";
import type { SourceDef, SourceDetail, SourceItem } from "./types.ts";

type DetailState =
  | { phase: "loading"; item: SourceItem }
  | { phase: "ready"; item: SourceItem; detail: SourceDetail; streamUrl: string | null; play: boolean }
  | { phase: "error"; item: SourceItem; message: string };

export default function SourcePosts({ def, compact = false, onShowAll, onSettledEmpty, openExternalId }: {
  def: SourceDef;
  /** compact＝分类总览预览形态：只拉第一页少量条目、无哨兵续页，
   * 底部「查看全部」由调用方接（跳吃瓜页）。 */
  compact?: boolean;
  onShowAll?: () => void;
  /** 已结空态回报（fix330/ui-fixes）：首批加载已结算（成功返回过
   * 至少一页）∧非加载∧无错误∧条目为 0 时报 true，其余报 false；
   * 分类总览据此整区隐藏空的吃瓜区。不传则不回报（Posts 页）。 */
  onSettledEmpty?: (empty: boolean) => void;
  /** G4 回访直达（fix334/L3）：同 SourceBrowse 口径——已加载列表
   * 含目标条目才自动打开、消费一次，不在列表不强求。 */
  openExternalId?: string;
}) {
  /* 进入浏览面补探（fix331/source-reliability）：同 SourceBrowse 口径。 */
  useSourceSelfCheckOnView(def);
  const { toast, isFav, setExternalCollected, actionPending } = useStore();
  const [items, setItems] = useState<SourceItem[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const busy = useRef(false);
  const seq = useRef(0);
  const failAt = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const pageSize = compact ? 8 : 20;

  /* 站务型推广帖异步验杀（fix333/promo-004）：仅声明 staffVerify
   * 的源（当前只有 feedheiliao）生效——列表先正常渲染，后台逐条
   * 抓详情验真伪，已判站务型的卡就地撤下；其余源 hiddenIds 恒空、
   * 条目集与 items 一致。分页/加载状态仍以原始 items 为准（验杀
   * 不改变分页推进），呈现与已结空态按 visibleItems。 */
  const fetchDetailForVerify = useCallback((id: string) => {
    const adapter = createAdapter(def);
    if (!adapter) return Promise.reject(new Error("该源未注册可用适配器"));
    return adapter.detail(id);
  }, [def]);
  const hiddenIds = useStaffPromoVerify(def, items, fetchDetailForVerify);
  /* 空壳卡标题兜底（fix333/m1-title-fallback）：卡内无标题载体的
   * 真帖在适配器层以裸数字 id 充标题（list-noise §4 实证、detail
   * 抽查全是真帖，不许杀）——本 hook 仅对裸 id 标题卡后台抓
   * detail 回填真标题、落盘缓存只补一次，失败保留裸 id 显示、
   * 不撤卡。与验杀共用同一 detail 注入接缝且正交：验杀决定卡
   * 在不在，本 hook 决定卡显示什么标题，在 visibleItems 叠加。 */
  const titleOverrides = useTitleFallback(def, items, fetchDetailForVerify);
  const visibleItems = useMemo(() => {
    const base = hiddenIds.size ? items.filter((i) => !hiddenIds.has(i.externalId)) : items;
    if (!titleOverrides.size) return base;
    return base.map((i) => {
      const t = titleOverrides.get(i.externalId);
      return t && t !== i.title ? { ...i, title: t } : i;
    });
  }, [items, hiddenIds, titleOverrides]);

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
      const fresh = reset ? res.items : res.items.filter((x) => !items.some((y) => y.externalId === x.externalId));
      setItems(reset ? res.items : [...items, ...fresh]);
      setPage(next);
      /* 零新增终止（fix335/a-pagination）：整页条目与已加载集合全重
       * （站方忽略页码恒回同一页等形态）时以当前页为尾页——分页
       * 信号的满页推断只声称「至少还有一页可探」，探到零新增即
       * 实测到底，不许被推断带着无限续拉（审计 §5.2 终止口径）。
       * 判读以原始 items 为准（验杀/标题兜底只影响呈现、同既有
       * 分页口径）；追加只向下生长列表、不动滚动位置（D 线接口）。 */
      setPages(!reset && res.items.length > 0 && fresh.length === 0
        ? next
        : (res.pagination?.pages ?? (res.items.length ? Math.max(reset ? 1 : pages, next) : next)));
      setErr(null);
    } catch (e) {
      if (mySeq === seq.current) { failAt.current = Date.now(); setErr((e as Error).message || "加载失败"); }
    } finally {
      if (mySeq === seq.current) { busy.current = false; setLoading(false); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, page, pages, pageSize, items]);

  /* 自动续页（与 SourceBrowse 同口径，fix335/a-pagination）：哨兵
   * 接近底部自动拉下一页（rootMargin 300px 近底预取、busy 单飞防
   * 并发重复拉）；失败落回「加载更多」按钮重试。失败冷却对齐
   * usePaginatedList 的 ERROR_RETRY_COOLDOWN_MS：旧口径 err 一置
   * 位哨兵整体停摆、瞬时失败即永久转手点；现哨兵保持在册，冷却
   * 3s 内不重试、冷却后哨兵重入可再拉。compact 不续页。 */
  useEffect(() => {
    const el = sentinelRef.current;
    if (compact || !el || loading || page >= pages || items.length === 0) return;
    const io = new IntersectionObserver((es) => {
      if (!es[0].isIntersecting) return;
      if (err && Date.now() - failAt.current < 3000) return;
      void load(false);
    }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [compact, loading, err, page, pages, items.length, load]);

  const openExternalConsumed = useRef<string | null>(null);
  useEffect(() => {
    seq.current++;
    busy.current = false;
    openExternalConsumed.current = null;
    setItems([]); setPage(0); setPages(1); setDetail(null);
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def.id]);

  /* 已结空态回报（fix330/ui-fixes）：page>0 表示至少一页成功返回
   * （失败走 err 不算已结）；源切换时 items/page 先复位、loading
   * 回 true，回报自动回到 false，总览区不会被旧源空态误藏。 */
  const settledEmpty = !loading && !err && visibleItems.length === 0 && page > 0;
  useEffect(() => {
    onSettledEmpty?.(settledEmpty);
  }, [settledEmpty, onSettledEmpty]);

  /* 嵌套返回语义（fix331/gesture-precedence）：详情活在本组件局
   * 部状态里、不推 App 栈——打开期间向统一返回序登记本层消费
   * 方（与弹层同一机制），硬件返回/Escape/边缘手势的 back 先关
   * 详情回列表，不再落穿成退宿主页或切页签（3.3.1 真机主诉）。
   * 登记在册同时是手势链的嵌套资格事实源（backConsumerActive
   * 探针），判定与落点同源、不另报状态。 */
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
      const [d, res] = await Promise.all([
        adapter.detail(item.externalId),
        adapter.resolve(item.externalId).catch(() => ({ streams: [] as { url: string; kind: "hls" | "file" }[] })),
      ]);
      setDetail({ phase: "ready", item, detail: d, streamUrl: res.streams[0]?.url ?? null, play: false });
    } catch (e) {
      setDetail({ phase: "error", item, message: (e as Error).message || "详情加载失败" });
    }
  }, [def]);

  /* 回访直达消费（G4）：在可见列表（验杀/标题兜底后）中命中才
   * 打开，消费一次。 */
  useEffect(() => {
    if (!openExternalId || openExternalConsumed.current === openExternalId) return;
    const target = visibleItems.find((x) => x.externalId === openExternalId);
    if (!target) return;
    openExternalConsumed.current = openExternalId;
    void openItem(target);
  }, [openExternalId, visibleItems, openItem]);

  /* 正文提取—重构（fix330/reader）：ready 详情的 contentHtml 按文档
   * 顺序拆成内容块；标题取 detail 数据（与正文首行重复时去重），
   * 不从正文块里猜。提取结果随详情对象 memo，切换条目自动失效。 */
  const readyDetail = detail?.phase === "ready" ? detail : null;
  const extraction = useMemo(
    () => (readyDetail?.detail.contentHtml
      ? extractArticleBlocks(readyDetail.detail.contentHtml, {
          base: readyDetail.detail.href,
          title: readyDetail.detail.title || readyDetail.item.title,
        })
      : null),
    [readyDetail],
  );

  const openSafeLink = (url: string) => {
    api.openUrl(url).catch(() => {
      copyText(url).then(() => toast("链接已复制", "ok")).catch(() => toast("复制失败", "info"));
    });
  };

  if (detail) {
    /* G4 收藏（fix334/L3）：快照取详情口径的标题/封面（detail 优先
     * 于列表裸数据，与正文标题同源）；帖子不写历史（原生 parity）。 */
    const favItem = detail.phase === "ready"
      ? { ...detail.item, title: detail.detail.title || detail.item.title, cover: detail.detail.cover || detail.item.cover }
      : detail.item;
    const itemHash = externalHashId(favItem);
    const fav = isFav(itemHash, "post");
    const favPending = actionPending(`collect:post:${itemHash}`);
    return (
      <div className="flex flex-col">
        <div className="flex items-center gap-2 px-4 pt-2 pb-3">
          <Button aria-label="返回列表" onClick={() => setDetail(null)} className="ios-nav-btn"><IBack size={20} /></Button>
          <h2 className="flex-1 min-w-0 truncate text-[15px] font-bold text-on">{detail.item.title}</h2>
          <Button aria-label={fav ? "取消收藏" : "收藏"} disabled={favPending}
            onClick={() => {
              void setExternalCollected("post", favItem, !fav);
              toast(fav ? "已取消收藏" : "已收藏", "star");
            }}
            className="grid place-items-center w-9 h-9 shrink-0 rounded-full bg-s2">
            {fav ? <IStarF size={17} className="text-amber" /> : <IStar size={17} />}
          </Button>
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
              {extraction && extraction.blocks.length ? (
                /* 提取—重构渲染：内容块以 article-body 既有段落/图片
                 * 样式原生排版；正文内链接不渲染为锚点，回源走页脚。 */
                <div className="article-body mt-3.5">
                  {extraction.blocks.map((b, i) => (b.type === "image" ? (
                    <img key={i} src={b.src} alt={b.alt} loading="lazy" />
                  ) : b.heading ? (
                    <h3 key={i}>{b.text}</h3>
                  ) : (
                    <p key={i}>{b.text}</p>
                  )))}
                </div>
              ) : extraction?.located && detail.detail.description ? (
                /* 定位到内容但段级过滤全杀（正文全是垃圾段）：显简介，
                 * 不回旧渲染把垃圾端上来。 */
                <p className="mt-3.5 text-[14px] leading-relaxed text-on/80 whitespace-pre-wrap">{detail.detail.description}</p>
              ) : detail.detail.contentHtml ? (
                /* 提取不到内容（结构未知）：维持旧清洗渲染，如实降级。 */
                <div className="article-body mt-3.5" onClick={(e) => handleArticleClick(e, openSafeLink, detail.detail.href)}
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(detail.detail.contentHtml, detail.detail.href) }} />
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
            {/* 回源入口（fix330/reader）：正文已重构为内容块、原文
                链接不在正文内呈现，回源统一走此处打开详情页原文。 */}
            <button type="button" onClick={() => detail.detail.href && openSafeLink(detail.detail.href)}
              className="mt-3 px-4 text-left text-[12px] text-mut">
              数据源：{def.displayName}（经适配器实时取数，非黄果数据）{detail.detail.href ? " · 查看原文" : ""}
            </button>
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
      {visibleItems.length ? (
        <div className="ios-media-grid" data-ui="media-grid">
          {visibleItems.map((item) => (
            <MediaCard key={item.externalId} title={item.title} cover={item.cover} surface="source-posts"
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
      {compact && visibleItems.length > 0 && onShowAll && (
        <Button onClick={onShowAll} className="w-full mt-3 text-primary">查看全部</Button>
      )}
    </div>
  );
}
