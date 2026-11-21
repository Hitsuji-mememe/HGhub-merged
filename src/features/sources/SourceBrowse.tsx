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
 *
 * 选集（2026-11-20 fix334/L2 G3）：openItem 改 detail＋resolve
 * 并发（照 SourcePosts 既有形态）——detail 供选集与当前集标注，
 * 失败降级不阻断取流（详情口径比取流挑剔的源不因接线回归为不
 * 可播，与 search/copyLoader 同口径），成败仍由 resolve 定。多集
 * 条目（适用性经 episodes.episodeChoicesForSurface 派生：宿主面
 * play-external 路由∧模板 multi）在 Player 下渲染 EpisodePicker，
 * 选集以所选 externalId 重新 resolve 换流、Player scopeKey 随当
 * 前集变更防串集缓存；切集失败留当前集继续播＋错误行明示，不
 * 静默回落第一集冒充成功。Search 外部详情是第二条同治路径。
 *
 * 收藏/历史（2026-11-20 fix334/L3 G4）：详情头收藏钮经 store 的
 * setExternalCollected 写桥接哈希＋extRefs 快照；Player onPlaying
 * 首帧经 addExternalHistory 记历史（集数＝当前集 ordinal）。回访
 * 经 openExternalId prop 直达（资料库/Profile 发起）。
 *
 * 续播到集（2026-11-20 fix334 清扫修复，已坏-2 补实现）：历史回访
 * 另经 openExternalEp 带入记录的集序位，openItem 按 ordinal 取回
 * choices[ordinal-1] 起播（外部续播只到集、不到秒，与资料库行
 * t=0/dur=0 口径一致）；目标集缺位或取流失败回落默认集起播并
 * 明示，不静默冒充恢复成功。此前 ep 只记录与显示、回访恒回第
 * 一集，子系统页「只恢复到集」的口径自本批起与实现一致。
 */
import { Button } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useCallback, useEffect, useRef, useState } from "react";
import { cover } from "../../shared/api/api";
import { MediaCard } from "../../shared/ui/cards";
import { Empty } from "../../shared/ui/ui";
import { IBack, IFilm, IStar, IStarF } from "../../shared/ui/icons";
import { Player } from "../playback";
import { registerOverlayBack } from "../../shared/lib/back";
import { useScrollKeeper } from "../../shared/lib/useScrollKeeper";
import { useStore } from "../../shared/model/store";
import { externalHashId } from "../../shared/model/localLibrary";
import { createAdapter } from "./adapters/index.ts";
import { noteSourceListSuccess, useSourceSelfCheckOnView } from "./sourceHealth.ts";
import { episodeChoicesForSurface, episodeOrdinal, type EpisodeChoice } from "./episodes.ts";
import { EpisodePicker } from "./EpisodePicker";
import DiscoveryBar from "./DiscoveryBar";
import { discFingerprint, EMPTY_LIST_DISCOVERY, type ListDiscovery } from "./types.ts";
import type { SourceDef, SourceDetail, SourceItem } from "./types.ts";

type DetailState =
  | { phase: "loading"; item: SourceItem }
  | {
      phase: "ready"; item: SourceItem; detail?: SourceDetail; streamUrl: string;
      /** 首条流的形态（fix3310 kind 透传）：与 streamUrl 同源于
       * resolve 结果，Player 据此分流 /hls 与 /seg。 */
      streamKind: "hls" | "file";
      /** 当前实际在播的集（externalId）：选集换流与 scopeKey 的事实源。 */
      currentEpExternalId: string;
      /** 切集失败的诚实呈现（留当前集继续播，不回落第一集冒充成功）。 */
      epError?: string;
    }
  | { phase: "error"; item: SourceItem; message: string };

export default function SourceBrowse({ def, onDetailOpenChange, openExternalId, openExternalEp, scrollerRef }: {
  def: SourceDef;
  /** 宿主 scroller 下传（fix335/d-scroll）：滚动恢复 hook 据此读写
   * 宿主滚动容器；未传时恢复静默不生效。 */
  scrollerRef?: { current: HTMLElement | null };
  /** 详情开合回报（Muse 2026-11-20 fix331/covers-header，3.3.1 真机
   * 首验问题②）：本组件挂在 ChannelPage 内，详情自带一层页头（返回
   * 列表＋标题）；详情打开时宿主必须让位自己的页头，否则双层标题
   * 栏＋两枚返回键同屏（真机图 1 实锤）。宿主据此隐藏外层页头，
   * 详情关闭自动恢复。 */
  onDetailOpenChange?: (open: boolean) => void;
  /** G4 回访直达（fix334/L3）：资料库点开外部收藏/历史时带入目标
   * 条目 externalId——首屏列表含该条目才自动打开（消费一次），不
   * 在首屏不强求翻页寻找（设计 D-3）。 */
  openExternalId?: string;
  /** 续播到集（fix334 清扫已坏-2）：历史回访带入该行记录的集序
   * 位（1 起）；仅回访直达消费，列表点开不带、行为不变。 */
  openExternalEp?: number;
}) {
  const { isFav, setExternalCollected, addExternalHistory, actionPending, toast } = useStore();
  /* 进入浏览面补探（fix331/source-reliability）：自检结果缺失/
   * 过期时后台单源补探，徽标探完即刷新，不阻塞本面取数。 */
  useSourceSelfCheckOnView(def);
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
  /* 详情面独立代次（fix335/detail-guard，照 SourceGallery albumSeq
   * 先例）：与列表 load 的 seq 分开——共用会让 openItem 抢占在飞
   * load 的 finally 状态复位。切源/改开/关闭任一发生，在飞 detail
   * 的迟到响应整路丢弃。 */
  const detailSeq = useRef(0);
  const failAt = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);
  /* 发现维度（fix335/f-discovery）：disc 按源 id 隔离存放（换源不
   * 串维度）；指纹进滚动恢复 key——切换维度后位置按新指纹隔离，
   * 空 disc 时 key 与 D 线逐字一致。 */
  const [discMap, setDiscMap] = useState<Record<string, ListDiscovery>>({});
  const disc = discMap[def.id] ?? EMPTY_LIST_DISCOVERY;
  const discFp = discFingerprint(disc);
  const discArg = discFp ? disc : undefined;
  const applyDisc = useCallback((next: ListDiscovery) => {
    setDiscMap((m) => ({ ...m, [def.id]: next }));
  }, [def.id]);
  /* 滚动恢复（fix335/d-scroll）：详情分支替换列表期间宿主 scroller
   * 高度塌缩、scrollTop 被钳 0——打开详情前 capture、回列表且数据
   * 就位后由 hook 写回（机制见 shared/lib/useScrollKeeper）。 */
  const { captureScroll } = useScrollKeeper(`browse:${def.id}${discFp ? `:${discFp}` : ""}`, scrollerRef, detail === null && items.length > 0);

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
      const res = await adapter.list(next, 20, discArg);
      if (mySeq !== seq.current) return;
      const fresh = reset ? res.items : res.items.filter((x) => !items.some((y) => y.externalId === x.externalId));
      setItems(reset ? res.items : [...items, ...fresh]);
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
      /* 自检成功推翻（fix337/008-detail）：同 SourceGallery 口径。 */
      noteSourceListSuccess(def);
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
  /* 历史写入去重键（条目:当前集）：同集反复 playing（暂停续播/寻址）
   * 不重复记，换集才以新 ordinal 再记一行。 */
  const historyKeyRef = useRef("");
  /* 维度切换重置（fix335/f-discovery）：重置 effect 依赖扩为
   * [源, 指纹]——同源内切换维度走同一重置路径（seq 作废在飞 load、
   * 列表清空重拉），且滚动置顶：新维度是新列表、旧位置无意义；
   * 位置恢复只在同指纹内经详情往返发生（keeper 语义）。换源时
   * 不在此置顶（宿主滚动由换源路径自理，与 D 线口径一致）。 */
  const prevFaceKey = useRef<{ id: string; fp: string } | null>(null);
  useEffect(() => {
    seq.current++;
    detailSeq.current++;
    busy.current = false;
    openExternalConsumed.current = null;
    historyKeyRef.current = "";
    setItems([]); setPage(0); setPages(1); setDetail(null);
    const prev = prevFaceKey.current;
    if (prev && prev.id === def.id && prev.fp !== discFp && scrollerRef?.current) {
      scrollerRef.current.scrollTop = 0;
    }
    prevFaceKey.current = { id: def.id, fp: discFp };
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def.id, discFp]);

  /* 关闭详情＝作废在飞 detail（与切源同列为作废触发点）：先行
   * detailSeq++ 再清状态，迟到响应落地时比对不过、直接丢弃，不
   * 会把已关详情复活。全部关闭落点（返回序登记/页头返回钮）共用。 */
  const closeDetail = useCallback(() => {
    detailSeq.current++;
    setDetail(null);
  }, []);

  /* 嵌套返回语义（fix331/gesture-precedence）：详情在本页内状态
   * 呈现、不推栈（文件头既有口径）——打开期间向统一返回序登记
   * 本层消费方，back 先关详情回列表，不再落穿成退整个频道页；
   * 登记同时是手势链嵌套资格的事实源（backConsumerActive）。 */
  const detailOpen = detail !== null;
  useEffect(() => {
    if (!detailOpen) return undefined;
    return registerOverlayBack(() => { closeDetail(); return true; });
  }, [detailOpen, closeDetail]);

  const openItem = useCallback(async (item: SourceItem, startEpOrdinal?: number) => {
    captureScroll();
    historyKeyRef.current = "";
    /* 代次守卫（fix335/detail-guard）：旧码 await 后无条件
     * setDetail——切源后旧源迟到响应把详情复活到新源列表之上、
     * 改开他条被旧响应覆盖、加载中关闭后详情自行复活，夹具三
     * 场景旧红在案。取号后落地前比对，过期整路丢弃。 */
    const mySeq = ++detailSeq.current;
    const adapter = createAdapter(def);
    if (!adapter) { setDetail({ phase: "error", item, message: "该源未注册可用适配器" }); return; }
    setDetail({ phase: "loading", item });
    /* 续播到集（fix334 清扫已坏-2 补实现，设计 §4.4 机制）：回访
     * 带入 ordinal>1 时先取 detail 定 choices、按 ordinal 取回
     * 目标集再 resolve，起播落点即记录的集（复用 L2 选集派生，
     * 不另造路径）；命中即返回。目标集缺位（集表漂移）或其取流
     * 失败 → 落回下方默认路径起播，并以 epError 明示未恢复到记
     * 录集，不静默串集冒充成功。 */
    const wantEp = startEpOrdinal !== undefined && startEpOrdinal > 1 ? startEpOrdinal : undefined;
    let prefetched: SourceDetail | undefined;
    let prefetchedDone = false;
    if (wantEp) {
      try { prefetched = await adapter.detail(item.externalId); } catch { prefetched = undefined; }
      prefetchedDone = true;
      const preChoices = episodeChoicesForSurface("play-external", def, prefetched);
      const target = preChoices[wantEp - 1];
      if (target) {
        try {
          const res = await adapter.resolve(target.externalId);
          const stream = res.streams[0];
          if (!stream) throw new Error("未解析到可播放地址");
          setDetail({
            phase: "ready", item, detail: prefetched, streamUrl: stream.url, streamKind: stream.kind,
            currentEpExternalId: target.externalId,
          });
          return;
        } catch { /* 回落默认集＋明示（下方 ready 构造带 epError） */ }
      }
    }
    /* detail＋resolve 并发（照 SourcePosts 既有形态）：detail 供
     * 选集，失败降级（detail=undefined、无选集区）不阻断取流；
     * resolve 定成败，错误口径与此前单 resolve 时一致。续播路径
     * 已取的 detail 直接复用、不重复请求。 */
    const [detailRes, streamRes] = await Promise.allSettled([
      prefetchedDone ? Promise.resolve(prefetched) : adapter.detail(item.externalId),
      adapter.resolve(item.externalId),
    ]);
    if (mySeq !== detailSeq.current) return;
    if (streamRes.status === "rejected") {
      setDetail({ phase: "error", item, message: (streamRes.reason as Error).message || "播放地址解析失败" });
      return;
    }
    const stream = streamRes.value.streams[0];
    if (!stream) { setDetail({ phase: "error", item, message: "该条目未解析到可播放地址" }); return; }
    const d = detailRes.status === "fulfilled" ? detailRes.value : undefined;
    const choices = episodeChoicesForSurface("play-external", def, d);
    setDetail({
      phase: "ready", item, detail: d, streamUrl: stream.url, streamKind: stream.kind,
      currentEpExternalId: choices[0]?.externalId ?? item.externalId,
      ...(wantEp ? { epError: `未能恢复到第 ${wantEp} 集，已从第一集播放` } : {}),
    });
  }, [def, captureScroll]);

  /* 回访直达消费（G4）：目标条目出现在已加载列表中才打开，消费
   * 一次；不在列表（含未加载完）不做任何强求动作。历史回访另带
   * openExternalEp（续播到集）随本次打开一并消费。 */
  useEffect(() => {
    if (!openExternalId || openExternalConsumed.current === openExternalId) return;
    const target = items.find((x) => x.externalId === openExternalId);
    if (!target) return;
    openExternalConsumed.current = openExternalId;
    void openItem(target, openExternalEp);
  }, [openExternalId, openExternalEp, items, openItem]);

  /* 切集：以所选集 externalId 重新 resolve 换流。竞态以 epSeq 只
   * 认最后一次点选；失败（含无流）不换流、不回落第一集——留在
   * 当前集继续播，epError 明示切到哪集失败。 */
  const epSeq = useRef(0);
  const pickEpisode = useCallback(async (choice: EpisodeChoice) => {
    const cur = detail;
    if (!cur || cur.phase !== "ready" || choice.externalId === cur.currentEpExternalId) return;
    const adapter = createAdapter(def);
    if (!adapter) return;
    const mySeq = ++epSeq.current;
    const applyIfCurrent = (patch: Partial<Extract<DetailState, { phase: "ready" }>>) => {
      setDetail((prev) => (prev && prev.phase === "ready" && prev.item === cur.item && epSeq.current === mySeq
        ? { ...prev, ...patch }
        : prev));
    };
    try {
      const res = await adapter.resolve(choice.externalId);
      const stream = res.streams[0];
      if (!stream) throw new Error("未解析到可播放地址");
      applyIfCurrent({ streamUrl: stream.url, streamKind: stream.kind, currentEpExternalId: choice.externalId, epError: undefined });
    } catch (e) {
      applyIfCurrent({ epError: `切换到「${choice.label}」失败：${(e as Error).message || "播放地址解析失败"}（仍在播放当前集）` });
    }
  }, [def, detail]);

  if (detail) {
    const choices = detail.phase === "ready" ? episodeChoicesForSurface("play-external", def, detail.detail) : [];
    const currentChoice = detail.phase === "ready"
      ? choices.find((c) => c.externalId === detail.currentEpExternalId)
      : undefined;
    /* G4 收藏态（fix334/L3）：以桥接哈希查既有收藏集合——与 Profile
     * 出卡、原生收藏钮同一事实源。 */
    const itemHash = externalHashId(detail.item);
    const fav = isFav(itemHash, "video");
    const favPending = actionPending(`collect:video:${itemHash}`);
    return (
      <div className="flex flex-col">
        <div className="flex items-center gap-2 px-4 pt-2 pb-3">
          <Button aria-label="返回列表" onClick={closeDetail} className="ios-nav-btn"><IBack size={20} /></Button>
          <h2 className="flex-1 min-w-0 truncate text-[15px] font-bold text-on">{detail.item.title}</h2>
          {choices.length > 1 && currentChoice && (
            <span className="shrink-0 text-[12px] text-mut">{currentChoice.label}</span>
          )}
          <Button aria-label={fav ? "取消收藏" : "收藏"} disabled={favPending}
            onClick={() => {
              void setExternalCollected("video", detail.item, !fav, choices.length || undefined);
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
          <Empty icon={<IFilm size={26} />} title="播放地址获取失败" sub={detail.message} action="重试" onAction={() => void openItem(detail.item)} />
        )}
        {detail.phase === "ready" && (
          <div>
            {/* 呈现对齐（fix335/c-presentation）：播放器与 SourcePosts
             * 同规格——脱详情自带 px-4、套同款定高容器、Player 填满
             * 容器，不再是 aspect-video 小格子（审计
             * audit-player-size 头条）；数据源注记与选集留在 px-4
             * 块内，scopeKey/起播记史口径逐字不变。 */}
            <div className="relative w-full bg-black" style={{ height: "min(48vh, 420px)" }}>
              <Player src={detail.streamUrl} streamKind={detail.streamKind} poster={cover(detail.item.cover)} autoPlay active controls
                scopeKey={`${def.id}:${detail.currentEpExternalId}`}
                onPlaying={() => {
                  /* G4 历史写入（fix334/L3）：真起播首帧才记，集数＝
                   * 当前集 ordinal；同集重复 playing 不重复记（去重
                   * 键含当前集，换集自动再记）。 */
                  const key = `${detail.item.externalId}:${detail.currentEpExternalId}`;
                  if (historyKeyRef.current === key) return;
                  historyKeyRef.current = key;
                  addExternalHistory(detail.item,
                    detail.detail ? episodeOrdinal(detail.detail, detail.currentEpExternalId) : 1,
                    choices.length || undefined);
                }}
                diagnosticContext={{ view: "source_browse", source_id: def.id }}
                className="w-full h-full" />
            </div>
            <div className="px-4">
              <p className="mt-3 text-[12px] text-mut">数据源：{def.displayName}（经适配器实时取数，非黄果数据）</p>
              {choices.length > 1 && (
                <EpisodePicker choices={choices} currentKey={detail.currentEpExternalId}
                  onPick={(c) => void pickEpisode(c)} />
              )}
              {detail.epError && <p role="alert" className="mt-2 text-[12px] text-danger">{detail.epError}</p>}
            </div>
          </div>
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
