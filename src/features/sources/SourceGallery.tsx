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
import { IBack, IGrid, IStar, IStarF } from "../../shared/ui/icons";
import { AlbumViewer } from "./AlbumViewer.tsx";
import { registerOverlayBack } from "../../shared/lib/back";
import { useScrollKeeper } from "../../shared/lib/useScrollKeeper";
import { useStore } from "../../shared/model/store";
import { externalHashId } from "../../shared/model/localLibrary";
import { setImageTraceSurface } from "../../shared/lib/feedTrace";
import { createAdapter } from "./adapters/index.ts";
import { noteSourceListSuccess, useSourceSelfCheckOnView } from "./sourceHealth.ts";
import { assembleAlbumGallery } from "./albumGallery.ts";
import DiscoveryBar from "./DiscoveryBar";
import { discFingerprint, EMPTY_LIST_DISCOVERY, type ListDiscovery } from "./types.ts";
import type { SourceDef, SourceItem } from "./types.ts";

type AlbumState =
  | { phase: "loading"; item: SourceItem }
  /* galleryItems（fix337/008-detail）：单图模型画廊组装成立时的
   * 入选条目集——item 随 index 在集内跟随（标题/收藏作用于当前
   * 所见条目）；未组装（图集源等）时缺省、item 恒为点开条目。 */
  | { phase: "ready"; item: SourceItem; images: string[]; index: number; galleryItems?: SourceItem[] }
  | { phase: "error"; item: SourceItem; message: string };

export default function SourceGallery({ def, openExternalId, scrollerRef }: {
  def: SourceDef;
  /** G4 回访直达（fix334/L3）：同 SourceBrowse 口径——已加载列表
   * 含目标相册才自动打开、消费一次，不在列表不强求。 */
  openExternalId?: string;
  /** 宿主 scroller 下传（fix335/d-scroll）：滚动恢复 hook 据此读写
   * 宿主滚动容器；未传（分类总览 compact 等形态）时恢复静默不生效。 */
  scrollerRef?: { current: HTMLElement | null };
}) {
  /* 进入浏览面补探（fix331/source-reliability）：同 SourceBrowse 口径。 */
  useSourceSelfCheckOnView(def);
  const { isFav, setExternalCollected, actionPending, toast } = useStore();
  const [items, setItems] = useState<SourceItem[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [album, setAlbum] = useState<AlbumState | null>(null);
  const busy = useRef(false);
  const seq = useRef(0);
  /* 相册 detail 专用代次（fix335/a-album-guard）：与列表 load 的
   * seq 分开——同 SourceBrowse epSeq 先例（一面一 seq）；若与 load
   * 共用，openAlbum 抢占会让在飞 load 的 finally 跳过 busy 复位、
   * 列表单飞闩死锁。 */
  const albumSeq = useRef(0);
  const failAt = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);
  /* 发现维度（fix335/f-discovery）：同 SourceBrowse 口径——disc 按
   * 源 id 隔离、指纹进滚动恢复 key，空 disc 时 key 与 D 线逐字一致。 */
  const [discMap, setDiscMap] = useState<Record<string, ListDiscovery>>({});
  const disc = discMap[def.id] ?? EMPTY_LIST_DISCOVERY;
  const discFp = discFingerprint(disc);
  const discArg = discFp ? disc : undefined;
  const applyDisc = useCallback((next: ListDiscovery) => {
    setDiscMap((m) => ({ ...m, [def.id]: next }));
  }, [def.id]);
  /* 滚动恢复（fix335/d-scroll）：相册分支替换列表期间宿主 scroller
   * 高度塌缩、scrollTop 被钳 0——打开相册前 capture、回列表且数据
   * 就位后由 hook 写回（机制见 shared/lib/useScrollKeeper）。 */
  const { captureScroll } = useScrollKeeper(`gallery:${def.id}${discFp ? `:${discFp}` : ""}`, scrollerRef, album === null && items.length > 0);

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
      const res = await adapter.list(next, 20, discArg);
      if (mySeq !== seq.current) return;
      const fresh = reset ? res.items : res.items.filter((x) => !items.some((y) => y.externalId === x.externalId));
      setItems(reset ? res.items : [...items, ...fresh]);
      /* 自检成功推翻（fix337/008-detail）：真实 list 成功撞上落盘
       * 的列表段失败结论时即时送探针复核，不让旧结论继续冒充
       * 现行状态（机制见 healthCheck.reprobeSelfCheckOnListSuccess）。 */
      noteSourceListSuccess(def);
      setPage(next);
      /* 零新增终止（fix335/a-pagination）：整页条目与已加载集合全重
       * （站方忽略页码恒回同一页等形态）时以当前页为尾页——分页
       * 信号的满页推断只声称「至少还有一页可探」，探到零新增即
       * 实测到底，不许被推断带着无限续拉（审计 §5.2 终止口径）。
       * 追加只向下生长列表、不动滚动位置（D 线滚动恢复的接口）。 */
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
  }, [def, page, pages, items, discArg]);

  /* 自动续页（3.2.2 集成批＋fix335/a-pagination）：哨兵接近底部自动
   * 拉下一页（rootMargin 300px 近底预取、busy 单飞防并发重复拉）；
   * 失败落回底部「加载更多」按钮重试（手点不作主路径）。失败冷却
   * 对齐 usePaginatedList 的 ERROR_RETRY_COOLDOWN_MS：旧口径 err 一
   * 置位哨兵整体停摆、瞬时失败即永久转手点；现哨兵保持在册，冷却
   * 3s 内不重试、冷却后哨兵重入可再拉。连拉由接口 pages 终止、零
   * 新增终止与 busy 单飞三重兜底。 */
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || loading || page >= pages || items.length === 0) return;
    const io = new IntersectionObserver((es) => {
      if (!es[0].isIntersecting) return;
      if (err && Date.now() - failAt.current < 3000) return;
      void load(false);
    }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loading, err, page, pages, items.length, load]);

  const openExternalConsumed = useRef<string | null>(null);
  /* 维度切换重置（fix335/f-discovery）：同 SourceBrowse 口径——依赖
   * 扩为 [源, 指纹]，同源切换维度重置重拉并置顶，新指纹位置隔离。 */
  const prevFaceKey = useRef<{ id: string; fp: string } | null>(null);
  useEffect(() => {
    seq.current++;
    albumSeq.current++;
    busy.current = false;
    openExternalConsumed.current = null;
    setItems([]); setPage(0); setPages(1); setAlbum(null);
    const prev = prevFaceKey.current;
    if (prev && prev.id === def.id && prev.fp !== discFp && scrollerRef?.current) {
      scrollerRef.current.scrollTop = 0;
    }
    prevFaceKey.current = { id: def.id, fp: discFp };
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def.id, discFp]);

  /* 关相册＝同时作废在飞 detail（fix335/a-album-guard）：加载中
   * 返回/关闭后迟到响应不得把已关覆层复活（同切源复活一病）。 */
  const closeAlbum = useCallback(() => {
    albumSeq.current++;
    setAlbum(null);
  }, []);

  /* 嵌套返回语义（fix331/gesture-precedence）：相册查看态活在本
   * 组件局部状态里（fixed 覆层但无弹层登记）——打开期间向统一
   * 返回序登记本层消费方，back 先关相册回网格，不再落穿成退整
   * 个频道页；登记同时是手势链嵌套资格的事实源
   * （backConsumerActive）。 */
  const albumOpen = album !== null;
  useEffect(() => {
    if (!albumOpen) return undefined;
    return registerOverlayBack(() => { closeAlbum(); return true; });
  }, [albumOpen, closeAlbum]);

  /* 逐图失败明细的面标注（fix331/gallery-device）：图集查看态记
   * gallery、相册网格记 source-list，诊断导出据此分面定位；卸载还原
   * 缺省 app。3.3.1 诊断里图集会话零明细，此标注补上这个面。 */
  useEffect(() => {
    setImageTraceSurface(album?.phase === "ready" ? "gallery" : "source-list");
  }, [album?.phase]);
  useEffect(() => () => setImageTraceSurface("app"), []);

  const openAlbum = useCallback(async (item: SourceItem) => {
    captureScroll();
    const adapter = createAdapter(def);
    if (!adapter) { setAlbum({ phase: "error", item, message: "该源未注册可用适配器" }); return; }
    /* 代次守卫（fix335/a-album-guard，照 load 的 seq 既有形态）：
     * 切源（重置 effect 先行 albumSeq++）、改开他册、加载中关闭
     * 任一发生，本次 detail 的迟到响应直接丢弃——旧码无条件
     * setAlbum，慢 detail 落地会把旧源相册覆层复活到新源列表
     * 之上（A 线旁记、夹具三场景旧红在案）。 */
    const mySeq = ++albumSeq.current;
    setAlbum({ phase: "loading", item });
    try {
      const d = await adapter.detail(item.externalId);
      if (mySeq !== albumSeq.current) return;
      const images = (d.images?.length ? d.images : [d.cover]).filter(Boolean);
      if (!images.length) { setAlbum({ phase: "error", item, message: "该相册未解析到图片" }); return; }
      /* 单图模型画廊组装（fix337/008-detail）：detail 恰 1 图且已
       * 加载列表条目自带大图时，以列表为画廊沿帖前后翻（组装判
       * 定唯一出处 albumGallery.ts）；不成立维持单册形态。判定吃
       * detail.images 原值——封面回落（images 里的 [d.cover]）不
       * 算单图模型签名，不许拿预览图混进画廊充数。 */
      const asm = assembleAlbumGallery(items, item, d.images ?? []);
      if (asm) {
        setAlbum({ phase: "ready", item: asm.items[asm.index], images: asm.images, index: asm.index, galleryItems: asm.items });
      } else {
        setAlbum({ phase: "ready", item, images, index: 0 });
      }
    } catch (e) {
      if (mySeq === albumSeq.current) { setAlbum({ phase: "error", item, message: (e as Error).message || "图集加载失败" }); }
    }
  }, [def, captureScroll, items]);

  /* 回访直达消费（G4）：目标相册在已加载列表中才打开，消费一次。 */
  useEffect(() => {
    if (!openExternalId || openExternalConsumed.current === openExternalId) return;
    const target = items.find((x) => x.externalId === openExternalId);
    if (!target) return;
    openExternalConsumed.current = openExternalId;
    void openAlbum(target);
  }, [openExternalId, items, openAlbum]);

  if (album) {
    /* 查看态（Muse 2026-11-19 3.2.1修复F6线）：ready 走全屏查看器
     * AlbumViewer（fixed 覆满视口，壳顶栏/频道页顶栏不再与查看器
     * 顶栏叠层挤压图片）；loading/error 维持既有页内形态与文案不变。 */
    if (album.phase === "ready") {
      /* G4 收藏（fix334/L3）：kind=image 落 postFavs、快照同写，
       * 钮经 AlbumViewer 顶栏动作槽注入（随 chrome 淡出）。 */
      const itemHash = externalHashId(album.item);
      const fav = isFav(itemHash, "post");
      const favPending = actionPending(`collect:post:${itemHash}`);
      return (
        <div className="fixed inset-0 z-40 bg-black">
          <AlbumViewer title={album.item.title} images={album.images} index={album.index}
            onIndexChange={(i) => setAlbum({ ...album, index: i, item: album.galleryItems?.[i] ?? album.item })}
            onBack={closeAlbum} backLabel="返回相册列表"
            onClose={closeAlbum} immersive
            headerAction={(
              <Button aria-label={fav ? "取消收藏" : "收藏"} disabled={favPending}
                onClick={() => {
                  void setExternalCollected("image", album.item, !fav);
                  toast(fav ? "已取消收藏" : "已收藏", "star");
                }}
                className="grid place-items-center w-11 h-11 shrink-0 rounded-full bg-black/40 text-white">
                {fav ? <IStarF size={19} className="text-amber" /> : <IStar size={19} />}
              </Button>
            )} />
        </div>
      );
    }
    return (
      <div className="flex flex-col">
        <div className="flex items-center gap-2 px-4 pt-2 pb-3">
          <Button aria-label="返回相册列表" onClick={closeAlbum} className="ios-nav-btn"><IBack size={20} /></Button>
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
      <DiscoveryBar def={def} disc={disc} onDiscChange={applyDisc} />
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
