import { Button, Form, Input, SegmentedControl, Surface } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, cover, fmt, isMobile } from "../../shared/api/api";
import type { HotSearchVideo, Post, RankItem, VideoCard } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { LOCAL_SCOPE, externalHashId } from "../../shared/model/localLibrary";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { MediaCard, RankRow } from "../../shared/ui/cards";
import { FilteredContent } from "../../shared/ui/FilteredContent";
import { Empty, Img } from "../../shared/ui/ui";
import { SearchTags } from "./SearchTags";
import { IBack, IChevR, IClose, IFilm, IFireF, IPlayF, IRefresh, ISearch, IStar, IStarF, ITrophy } from "../../shared/ui/icons";
import { withRequestTimeout } from "../../shared/lib/withTimeout";
import { registerOverlayBack } from "../../shared/lib/back";
import { copyText } from "../../shared/lib/clipboard";
import { handleArticleClick, sanitizeHtml } from "../../shared/lib/html";
import { tracePlayback } from "../../shared/diagnostics/playbackDiagnostics";

/* 资料库作用域（账号体系拆除后恒定）：代次键的前缀成分。 */
const scope = LOCAL_SCOPE;
import { AlbumViewer } from "../sources/AlbumViewer";
import { extractArticleBlocks } from "../sources/articleBlocks.ts";
import { nativeSourceId } from "../sources/surfaces";
import { getActiveRegistry } from "../sources/manifest";
import { createAdapter } from "../sources/adapters/index.ts";
import { sourceStableId } from "../sources/registryDiag";
import type { SourceDef, SourceDetail, SourceItem } from "../sources/types";
import { useTitleFallback } from "../sources/titleFallback.ts";
import { episodeChoicesForSurface, episodeOrdinal, type EpisodeChoice } from "../sources/episodes.ts";
import { EpisodePicker } from "../sources/EpisodePicker";
import { Player } from "../playback";
import { fetchHealthSnapshot } from "../sources/adapters/fetchHealth.ts";
import {
  GLOBAL_SEARCH_TABS, aggregateHits, fanoutSearch, kindSignalOfDetail,
  loadWithFallback, needsCanonicalKindLookup, orderCopiesForDisplay, searchKindForHuangguoVideo, structuralCompletenessOf, summarizeFanoutFailures,
  type CopyAssessment, type CopyRef, type EpisodeStructureSignal, type FanoutFailureSummary, type FanoutHit, type GlobalSearchKind, type MergedHit,
} from "./multiSourceSearch";
import { copyCacheKey, loadSearchCopy } from "./copyLoader";
import { assembleSearchGallery } from "./searchGallery";

/* 全局搜索（Muse 2026-11-19 最终版 D3 线，用户亲点＋定稿）：
 * 提交后三路并发——黄果视频（api.search kind=video，按 is_original
 * 分视频/短剧）、黄果帖子（api.searchPosts）、外部源扇出
 * （fanoutSearch：active 注册表经 searchPolicyFor 分层纳入、经
 * createAdapter 调各源 search；单源超时＋每源上限、onPartial 渐进
 * 呈现先到先显）。全部结果统一成 FanoutHit 后经 aggregateHits
 * 跨源合并（多信号置信门、索引层合并保留全部副本）＋同类混排
 * （相关性优先、源等级只作 tiebreak、单源首屏贡献上限），页签
 * 恒四类（GLOBAL_SEARCH_TABS），永不按源分段。外部单源失败
 * 经 tracePlayback 留痕（search.source_fail）之外，扇出落定后由
 * summarizeFanoutFailures 汇总在结果区呈现（fix333/m4-search 修
 * 清扫 P4：此前 failures 零呈现，部分失败看不出结果不完整、全
 * 部失败与「无结果」不可区分）——部分失败一行点名失败源＋重试，
 * 全部失败走 alert 行且空态换失败文案，不弹窗、不整页报错；
 * 黄果通道失败保留既有错误行＋重试（其余源结果照常）。
 * 外部条目点击走 D 线接通口径：视频 resolve→Player、图片 detail→
 * 图集、帖子 detail→正文，均在本页详情层呈现（外部源无黄果数值
 * id 路由）；多集条目（fix334/L2 G3）视频/短剧详情带选集
 * （EpisodePicker，适用性经 episodes.episodeChoicesForSurface
 * 派生），切集在当前副本内经 copyLoader 按集 resolve 换流、
 * 失败诚实呈现不回落第一集；SourceBrowse 是第一条同治路径。
 * 多副本可切换（副本 pills），默认副本按「可用性→
 * 结构完整度→历史可靠性→分层 tiebreak」选择链定，失败经
 * loadWithFallback 静默顺延（search.copy_fail 留痕）——自动顺延
 * 仅限身份已确认的合并条目，身份未确认时只试默认副本、失败后
 * 由用户手动选副本（手动切换不受身份门限）。
 * 3.2.1 F1：黄果已由原生两路（视频 api.search＋帖子 api.searchPosts）
 * 完整覆盖，扇出侧排除黄果（FANOUT_EXCLUDE_NATIVE）——其 native
 * 适配器 search 只重复调 api.searchPosts，同一帖子会双路到达；
 * 聚合层同源去重（multiSourceSearch 同源同 ID/同题同封面合并）作
 * 第二道防线。
 * 3.2.1 F4b：通用搜索端点载荷缺剧集结构信号（见 shared/lib/
 * contentKind 文件头根因），原生视频命中先按 searchKindForHuangguoVideo
 * 归类：自带信号直接判、信号缺失以 api.video(id) 的 Detail 规范信号
 * 补判（hgCanonicalSignals，并发 4、静默失败）；补不到 → unknown
 * 暂扣、不进任何页签，绝不默认落视频、也不猜落短剧。 */

type HgState<T> = { keyword: string; items: T[]; page: number; pages: number } | null;

type ExtReady = {
  merged: MergedHit;
  ordered: CopyRef[];
  active: CopyRef;
  streamUrl?: string;
  detail?: SourceDetail;
  images?: string[];
  /** 单图模型画廊组装（fix337/search-gallery）：组装成立时的入选
   * 条目集，与 images 一一对应、当前条目随 imgIdx 在集内跟随
   * （标题/收藏作用于所见条目）；未组装（图集源等）缺省、images
   * 恒为活副本 detail 图集，行为逐字不变。副本切换时与 epExternalId
   * 同列显式剔除（见 switchCopy），不许把上一副本的画廊带进新副本。 */
  galleryItems?: SourceItem[];
  /** 当前在播的集（externalId，fix334/L2 G3）：缺省＝detail 首集
   * （resolve 条目 id 的默认集）；副本切换/重开详情时不带此字段、
   * 自然回落默认集。 */
  epExternalId?: string;
  /** 切集失败的诚实呈现（留当前集继续播，不回落第一集冒充成功）。 */
  epError?: string;
};
type ExtDetailState =
  | { phase: "loading"; merged: MergedHit }
  | { phase: "ready"; data: ExtReady }
  | { phase: "error"; merged: MergedHit; message: string };

/** 扇出排除（3.2.1 F1）：已由原生通道完整覆盖、不进 fanoutSearch 的源。 */
const FANOUT_EXCLUDE_NATIVE = new Set([nativeSourceId()]);

/* ── 搜索面空壳卡标题兜底（fix333/m1-title-fallback 残余，集成轮定夺接入）──
 * M1 的 useTitleFallback 只接了 SourcePosts：搜索结果经 fanoutSearch
 * 扇出呈现、不经 SourcePosts，裸 id 标题卡在搜索面无覆盖。本泵每源
 * 一个实例、调同一 hook（识别/缓存/泵口径全同），覆盖集回报父组件
 * 在聚合前叠加到条目上——MergedHit 展示标题取代表副本 item.title、
 * 合并标题信号也同受益。fetchDetail 与 SourcePosts 的
 * fetchDetailForVerify 同构造（createAdapter(def).detail 注入接缝）。
 * 接缝实测：扇出条目即 SourceItem、按 sourceId 分组后与 hook 的
 * (def, items, fetchDetail) 形态严丝合缝，无需改 hook 与扇出。 */
function ExtTitleFallbackPump({ def, items, onOverrides }: {
  def: SourceDef;
  items: SourceItem[];
  onOverrides: (sourceId: string, map: ReadonlyMap<string, string>) => void;
}) {
  const fetchDetail = useCallback((id: string) => {
    const adapter = createAdapter(def);
    if (!adapter) return Promise.reject(new Error("该源未注册可用适配器"));
    return adapter.detail(id);
  }, [def]);
  const overrides = useTitleFallback(def, items, fetchDetail);
  useEffect(() => { onOverrides(def.id, overrides); }, [def.id, overrides, onOverrides]);
  return null;
}

const EMPTY_EXT_TITLE_OVERRIDES: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map();

export default function Search({ active, wide }: { active: boolean; wide: boolean }) {
  const { push, searchHist, addSearch, clearSearchHist, lineEpoch, setTab: setMainTab,
    isFav, setExternalCollected, addExternalHistory, actionPending, toast, setTabBarHeld } = useStore();
  /* G4 历史写入去重键（源:条目:当前集）：同集重复 playing 不重复
   * 记、换集/换条目自动再记（fix334/L3，与 SourceBrowse 同口径）。 */
  const extHistoryKeyRef = useRef("");
  const { preferences } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [tab, setTab] = useState<GlobalSearchKind>("video");
  const [hgVideo, setHgVideo] = useState<HgState<VideoCard>>(null);
  /* F4b 补判规范信号：key=`${scope}:${lineEpoch}:${id}`（作用域
   * 与代次进口径同 useFeedDetails），值只存 Detail 的剧集结构信号。 */
  const [hgCanonicalSignals, setHgCanonicalSignals] = useState<Record<string, EpisodeStructureSignal>>({});
  const kindLookupRequested = useRef(new Set<string>());
  const [hgPost, setHgPost] = useState<HgState<Post>>(null);
  const [extHits, setExtHits] = useState<FanoutHit[]>([]);
  /* 扇出失败呈现汇总（fix333/m4-search）：扇出落定后由
   * summarizeFanoutFailures 生成；null＝未落定/无失败呈现。 */
  const [extSummary, setExtSummary] = useState<FanoutFailureSummary | null>(null);
  /* 搜索面标题兜底覆盖集（源 id → externalId → 真标题）：由
   * ExtTitleFallbackPump 逐源回报，聚合前叠加到 extHits 条目上；
   * 随 extHits 同步清空（submit/清空两路径），不跨搜索残留。 */
  const [extTitleOverrides, setExtTitleOverrides] = useState<ReadonlyMap<string, ReadonlyMap<string, string>>>(EMPTY_EXT_TITLE_OVERRIDES);
  const onExtTitleOverrides = useCallback((sourceId: string, map: ReadonlyMap<string, string>) => {
    setExtTitleOverrides((prev) => (prev.get(sourceId) === map ? prev : new Map(prev).set(sourceId, map)));
  }, []);
  /* 扇出条目按源分组（泵的挂载名单）：def 以 active 注册表为准，
   * 找不到 def 的组不挂泵（无从构造 detail 接缝）。 */
  const extTitleGroups = useMemo(() => {
    const by = new Map<string, { def: SourceDef; items: SourceItem[] }>();
    if (!extHits.length) return by;
    const sources = getActiveRegistry().sources;
    for (const h of extHits) {
      const def = sources.find((s) => s.id === h.sourceId);
      if (!def) continue;
      let g = by.get(h.sourceId);
      if (!g) { g = { def, items: [] }; by.set(h.sourceId, g); }
      g.items.push(h.item);
    }
    return by;
  }, [extHits]);
  const [hgLoading, setHgLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [extLoading, setExtLoading] = useState(false);
  const [hgError, setHgError] = useState<string | null>(null);
  const [extDetail, setExtDetail] = useState<ExtDetailState | null>(null);
  /* 详情层独立代次（fix335/detail-guard，照 SourceGallery albumSeq
   * 先例；与切集 extEpSeq 分开——切集落点另有 stillCurrent 身份校
   * 验）：openExternal/manualPick/switchCopy 打开时取号、落地前比
   * 对；关闭/改开/新搜索任一发生，在飞加载的迟到响应整路丢弃。 */
  const extDetailSeq = useRef(0);
  /* 关闭详情层＝作废在飞加载（与改开同列为作废触发点）：先行
   * extDetailSeq++ 再清状态。全部关闭落点（返回序登记/页头返回
   * 钮/查看器返回/提交与清空搜索/转原生副本）共用。 */
  const closeExtDetail = useCallback(() => {
    extDetailSeq.current++;
    setExtDetail(null);
  }, []);
  /* 正文外链打开（与 SourcePosts openSafeLink 同实现同口径）：
   * 系统打开失败回落复制链接＋toast。 */
  const openSafeLink = (url: string) => {
    api.openUrl(url).catch(() => {
      copyText(url).then(() => toast("链接已复制", "ok")).catch(() => toast("复制失败", "info"));
    });
  };
  const [imgIdx, setImgIdx] = useState(0);
  /* 嵌套返回语义（fix331/gesture-precedence）：外部详情层虽带
   * role="dialog"（手势链 inOverlay 只许 back），此前却未登记返
   * 回消费方——back 在统一返回序里无人接、落穿成切页签/退页。
   * 打开期间登记本层消费方（与弹层同一机制），back 先关详情回
   * 搜索结果；登记同时是手势链嵌套资格的事实源。 */
  const extDetailOpen = extDetail !== null;
  useEffect(() => {
    if (!extDetailOpen) return undefined;
    return registerOverlayBack(() => { closeExtDetail(); return true; });
  }, [extDetailOpen, closeExtDetail]);
  /* 底栏让位（fix337/album-chrome，3.3.6 真机复报）：图片详情的
   * 全屏查看器覆层嵌在本详情层（absolute z-30）的层叠上下文
   * 内，覆层 z-40 只在上下文内有效，压不过根层 z-50 的壳底栏
   * ——3.3.6 盖住了同上下文的详情页头，底栏仍漏出压住缩略图
   * 条下半截。与 fs/clean 同口径：查看器在场期间持有让位标
   * 记、整栏不渲染。持有条件与图片分支覆层的渲染条件逐字同
   * 源（ready∧图片∧有图才有覆层），关闭/切副本/卸载由
   * cleanup 释放。 */
  const albumOverlayOpen = extDetail?.phase === "ready" && extDetail.data.merged.kind === "image" && (extDetail.data.images?.length ?? 0) > 0;
  useEffect(() => {
    if (!albumOverlayOpen) return undefined;
    setTabBarHeld(true);
    return () => { setTabBarHeld(false); };
  }, [albumOverlayOpen, setTabBarHeld]);
  const seqRef = useRef(0);
  const moreSentinelRef = useRef<HTMLDivElement>(null);
  const detailCache = useRef(new Map<string, SourceDetail>());
  const inputRef = useRef<HTMLInputElement>(null);
  const [hotVideos, setHotVideos] = useState<HotSearchVideo[]>([]);
  const [hotLoading, setHotLoading] = useState(false);
  const [hotError, setHotError] = useState<string | null>(null);
  const [hotTagState, setHotTagState] = useState<{
    epoch: number;
    tags: Record<number, readonly string[]>;
    failed: number[];
    retry: number;
  }>({ epoch: lineEpoch, tags: {}, failed: [], retry: 0 });
  const hotBusy = useRef(false);
  const hotSeq = useRef(0);
  const hotEpoch = useRef(lineEpoch);
  const hotLoadedAt = useRef(0);
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  /* 移动端进入搜索页不自动聚焦：iOS 会立刻弹键盘遮住内容（#20）。
     桌面端没有软键盘，聚焦便于直接打字。 */
  useEffect(() => {
    if (active && !isMobile) inputRef.current?.focus();
  }, [active]);

  const refreshHot = async (force = false) => {
    if (hotBusy.current && !force) return;
    const seq = ++hotSeq.current;
    const reqEpoch = hotEpoch.current;
    hotBusy.current = true;
    setHotLoading(true);
    setHotError(null);
    try {
      const res = await api.searchHot();
      if (!aliveRef.current || seq !== hotSeq.current || reqEpoch !== hotEpoch.current) return;
      setHotVideos(res.items);
      hotLoadedAt.current = Date.now();
    } catch (e) {
      if (!aliveRef.current || seq !== hotSeq.current || reqEpoch !== hotEpoch.current) return;
      setHotError(e instanceof Error ? e.message : "热搜榜加载失败，请重试");
    } finally {
      if (seq === hotSeq.current) {
        hotBusy.current = false;
        if (aliveRef.current) setHotLoading(false);
      }
    }
  };
  useEffect(() => {
    const epochChanged = hotEpoch.current !== lineEpoch;
    if (epochChanged) {
      hotEpoch.current = lineEpoch;
      hotLoadedAt.current = 0;
      hotBusy.current = false;
      setHotVideos([]);
      setHotError(null);
    }
    // 切换主导航时短暂复用榜单；手动刷新或切线路后重新获取官网内容。
    if (active && (epochChanged || Date.now() - hotLoadedAt.current > 60_000)) void refreshHot(epochChanged);
  }, [active, lineEpoch]);

  /* ── 全局搜索三路（黄果视频/黄果帖子/外部扇出） ── */
  const runHgVideo = async (keyword: string, page: number, seq: number) => {
    const res = await withRequestTimeout(api.search(keyword, page, 20, "video"));
    if (seq !== seqRef.current) return;
    const incoming = (res?.items ?? []) as VideoCard[];
    setHgVideo((prev) => {
      const base = page > 1 && prev?.keyword === keyword ? prev.items : [];
      const seen = new Set(base.map((x) => x.id));
      const items = [...base, ...incoming.filter((x) => !seen.has(x.id))];
      return { keyword, items, page, pages: Math.max(page, res?.pagination?.pages || page) };
    });
  };
  const runHgPost = async (keyword: string, page: number, seq: number) => {
    const res = await withRequestTimeout(api.searchPosts(keyword, page, 20));
    if (seq !== seqRef.current) return;
    const incoming = res?.items ?? [];
    setHgPost((prev) => {
      const base = page > 1 && prev?.keyword === keyword ? prev.items : [];
      const seen = new Set(base.map((x) => x.id));
      const items = [...base, ...incoming.filter((x) => !seen.has(x.id))];
      return { keyword, items, page, pages: Math.max(page, res?.pagination?.pages || page) };
    });
  };

  const submit = (keyword: string) => {
    const k = keyword.trim();
    if (!k) return;
    setQ(k);
    setSubmitted(k);
    addSearch(k);
    const seq = ++seqRef.current;
    setHgError(null);
    setHgVideo(null);
    setHgPost(null);
    setExtHits([]);
    setExtSummary(null);
    setExtTitleOverrides(EMPTY_EXT_TITLE_OVERRIDES);
    closeExtDetail();
    setHgLoading(true);
    setExtLoading(true);
    void (async () => {
      const settled = await Promise.allSettled([runHgVideo(k, 1, seq), runHgPost(k, 1, seq)]);
      if (seq !== seqRef.current) return;
      setHgLoading(false);
      const failed = settled.find((r) => r.status === "rejected");
      if (failed && failed.status === "rejected") {
        setHgError(failed.reason instanceof Error ? failed.reason.message : "搜索失败，请重试");
      }
    })();
    void (async () => {
      /* FANOUT_EXCLUDE_NATIVE（3.2.1 F1）：黄果不进扇出——原生两路已
       * 覆盖其视频与帖子，扇出适配器只会重复 api.searchPosts。 */
      const defs = getActiveRegistry().sources.filter((d) => !FANOUT_EXCLUDE_NATIVE.has(d.id));
      const out = await fanoutSearch(k, defs, (d) => createAdapter(d), {
        onFailure: (sourceId) => {
          const idx = defs.findIndex((s) => s.id === sourceId);
          tracePlayback("search.source_fail", { source: sourceStableId(idx >= 0 ? idx : 0) });
        },
        /* 渐进呈现：先落定的源先显；聚合排序是全序，已显条目相对序不被后到结果打乱。 */
        onPartial: (hits) => { if (seq === seqRef.current) setExtHits(hits); },
      });
      if (seq !== seqRef.current) return;
      setExtHits(out.hits);
      setExtSummary(summarizeFanoutFailures(out.failures, defs, out.searched));
      setExtLoading(false);
    })();
  };

  const submitRef = useRef(submit);
  submitRef.current = submit;
  const submittedRef = useRef("");
  submittedRef.current = submitted;
  const envKey = `${scope}:${lineEpoch}`;
  const prevEnvRef = useRef(envKey);
  useEffect(() => {
    if (prevEnvRef.current === envKey) return;
    prevEnvRef.current = envKey;
    if (submittedRef.current) submitRef.current(submittedRef.current);
  }, [envKey]);

  const loadMore = () => {
    const seq = seqRef.current;
    if (tab === "video" || tab === "drama") {
      if (!hgVideo || hgVideo.page >= hgVideo.pages || moreLoading) return;
      setMoreLoading(true);
      void runHgVideo(submitted, hgVideo.page + 1, seq)
        .catch((e) => { if (seq === seqRef.current) setHgError(e instanceof Error ? e.message : "加载更多失败"); })
        .finally(() => { if (seq === seqRef.current) setMoreLoading(false); });
    } else if (tab === "post") {
      if (!hgPost || hgPost.page >= hgPost.pages || moreLoading) return;
      setMoreLoading(true);
      void runHgPost(submitted, hgPost.page + 1, seq)
        .catch((e) => { if (seq === seqRef.current) setHgError(e instanceof Error ? e.message : "加载更多失败"); })
        .finally(() => { if (seq === seqRef.current) setMoreLoading(false); });
    }
  };
  const hasMore = (tab === "video" || tab === "drama")
    ? Boolean(hgVideo && hgVideo.page < hgVideo.pages)
    : tab === "post" ? Boolean(hgPost && hgPost.page < hgPost.pages) : false;

  /* 自动续页（3.2.2 集成批）：结果接近底部自动加载下一页（黄果
   * 通道分页）；加载失败（hgError）后哨兵停摆，底部「加载更多」
   * 按钮只作兜底出现、不作主路径。 */
  useEffect(() => {
    const el = moreSentinelRef.current;
    if (!el || !hasMore || moreLoading || hgError) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMore(); }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore, moreLoading, hgError, tab, submitted]);

  /* ── F4b 补判＋fix322 标记升级：性质未决定的原生条目按 ID 查
   * Detail 规范信号——触发门 needsCanonicalKindLookup（共用出处）：
   * 无自带标记且集数 ≤1 者都查（搜索载荷恒无标记；1 集与普通视频
   * 同形、必须靠 Detail 的 tracking 品类标记裁决，fix322 前只查
   * 信号缺失者、单集短剧被结构直判放行进视频页签）；规范信号经
   * kindSignalOfDetail 单点构造（集数＋品类标记，摘字段不许再丢
   * 标记）。并发 4（同热搜标签补查先例）；失败静默（不弹窗、不整
   * 页报错），条目保持 unknown 暂扣，成功后经 hgCanonicalSignals
   * 触发 groups 重归类到正确页签。请求登记先行（成败都登记），
   * 同作用域内不重复查同一 ID。 */
  useEffect(() => {
    if (!active || !hgVideo?.items.length) return;
    const queue = hgVideo.items.filter((v) => {
      const key = `${envKey}:${v.id}`;
      return needsCanonicalKindLookup(v) && !kindLookupRequested.current.has(key);
    });
    if (!queue.length) return;
    queue.forEach((v) => kindLookupRequested.current.add(`${envKey}:${v.id}`));
    let cancelled = false;
    const loaded: Record<string, EpisodeStructureSignal> = {};
    const worker = async () => {
      while (!cancelled && queue.length > 0) {
        const v = queue.shift()!;
        try {
          const d = await api.video(v.id);
          if (d) loaded[`${envKey}:${v.id}`] = kindSignalOfDetail(d);
        } catch { /* 静默：补不到保持 unknown 安全侧 */ }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => worker())).then(() => {
      if (cancelled || !aliveRef.current || !Object.keys(loaded).length) return;
      setHgCanonicalSignals((prev) => ({ ...prev, ...loaded }));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, hgVideo, envKey]);

  /* ── 聚合：黄果与外部统一成 FanoutHit 后跨源合并＋混排 ── */
  const groups = useMemo(() => {
    const parseTs = (s?: string) => {
      const t = s ? Date.parse(s) : NaN;
      return Number.isFinite(t) ? t : undefined;
    };
    const nativeHits: FanoutHit[] = [];
    let seq = 0;
    for (const v of hgVideo?.items ?? []) {
      /* F4b：归类以条目数据为准——自带信号直接判、缺失信号用补判的
       * 规范信号判；仍 unknown 的暂扣（不生成命中、不进任何页签）。 */
      const resolvedKind = searchKindForHuangguoVideo(v, hgCanonicalSignals[`${envKey}:${v.id}`]);
      if (resolvedKind === "unknown") continue;
      nativeHits.push({
        sourceId: nativeSourceId(), sourceName: "黄果", kind: resolvedKind,
        item: { sourceId: nativeSourceId(), externalId: String(v.id), title: v.title, cover: v.cover, href: "", tags: v.tags ?? [], hot: v.hot },
        weight: 100, hot: v.hot ?? 0, seq: seq++, publishedAt: parseTs(v.created_at),
      });
    }
    for (const p of hgPost?.items ?? []) {
      nativeHits.push({
        sourceId: nativeSourceId(), sourceName: "黄果", kind: "post",
        item: { sourceId: nativeSourceId(), externalId: String(p.id), title: p.title, cover: p.cover, href: "", tags: p.tags ?? [], hot: p.hot },
        weight: 100, hot: p.hot ?? 0, seq: seq++, publishedAt: parseTs(p.publish_time ?? p.created_at),
      });
    }
    const ext = extHits.map((h) => {
      /* 标题兜底覆盖在聚合前叠加：MergedHit 展示字段取代表副本
       * item.title，裸 id 卡回填真标题后卡面与合并信号同受益。 */
      const t = extTitleOverrides.get(h.sourceId)?.get(h.item.externalId);
      const item = t && t !== h.item.title ? { ...h.item, title: t } : h.item;
      return { ...h, item, seq: 100_000 + h.seq };
    });
    return aggregateHits([...nativeHits, ...ext]);
  }, [hgVideo, hgPost, extHits, hgCanonicalSignals, envKey, extTitleOverrides]);

  const openNativeCopy = (merged: MergedHit, copy: CopyRef) => {
    if (merged.kind === "post") {
      push({ kind: "post", id: Number(copy.item.externalId) });
      return;
    }
    const ids = (hgVideo?.items ?? []).map((x) => x.id);
    const id = Number(copy.item.externalId);
    push({ kind: "feed", videoIds: ids, index: Math.max(0, ids.indexOf(id)), title: `搜索 · ${submitted}` });
  };

  /* 副本加载核已抽至 ./copyLoader（fix330-riban-surfaces）：生产
   * 路径可被契约直驱；video/drama 在彼处先走适配器 detail 段再
   * resolve（此前直调 resolve、详情面拿不到 detail）。本处只组装
   * 生产依赖（active 注册表＋工厂＋组件级 detail 缓存）。 */
  const loadCopy = async (merged: MergedHit, copy: CopyRef, episodeExternalId?: string): Promise<Omit<ExtReady, "merged" | "ordered" | "active">> =>
    loadSearchCopy(merged.kind, copy, {
      getDef: (id) => getActiveRegistry().sources.find((s) => s.id === id),
      makeAdapter: (def) => createAdapter(def),
      detailCache: detailCache.current,
    }, episodeExternalId ? { episodeExternalId } : undefined);

  /* 搜索宿主画廊组装应用点（fix337/search-gallery，008-detail 同
   * 批横扫）：booru 家族单图模型在搜索面同根未修——副本 detail
   * 恒 1 图、查看器只喂 detail 即无从前后翻。三落点（openExternal/
   * manualPick/switchCopy）共用本应用点：组装以当前结果列表
   * （groups，点开时刻快照）为界、按活副本所属源取载体（判定/
   * 拼装唯一出处 searchGallery→albumGallery）；成立时以组装图集
   * 覆写 value.images（查看器仍只读 data.images 单字段——与底栏
   * 让位条件的同源前提，组装形态不另开数据字段）、带 galleryItems
   * 供标题/收藏跟随，起始 index＝点开位；不成立（图集源 detail
   * 多图等）原样返回、index 0，与现行行为逐字一致。判定吃
   * detail.images 原值：copyLoader 的封面回落图（images 里的
   * [cover]）不算单图模型签名（与 SourceGallery 同口径）。 */
  const applySearchGallery = (merged: MergedHit, copy: CopyRef, value: Omit<ExtReady, "merged" | "ordered" | "active">)
    : { value: Omit<ExtReady, "merged" | "ordered" | "active">; index: number } => {
    if (merged.kind !== "image") return { value, index: 0 };
    const asm = assembleSearchGallery(groups[merged.kind], copy, value.detail?.images ?? []);
    if (!asm) return { value, index: 0 };
    return { value: { ...value, images: asm.images, galleryItems: asm.items }, index: asm.index };
  };

  const traceCopyFail = (sourceId: string) => {
    const defs = getActiveRegistry().sources;
    const idx = defs.findIndex((s) => s.id === sourceId);
    tracePlayback("search.copy_fail", { source: sourceStableId(idx >= 0 ? idx : 0) });
  };

  const openExternal = async (merged: MergedHit) => {
    /* 代次守卫（fix335/detail-guard）：旧码评估＋顺延两段 await 后
     * 无条件 setExtDetail——加载中关闭后详情层自行复活、改开他条
     * 被旧响应覆盖，夹具旧红在案。取号后落地前比对，过期整路丢
     * 弃（评估段的 detail 只写按副本键的缓存、无状态落点，不在此
     * 守卫范围）。 */
    const mySeq = ++extDetailSeq.current;
    setExtDetail({ phase: "loading", merged });
    setImgIdx(0);
    const extCopies = merged.copies.filter((c) => c.sourceId !== nativeSourceId());
    /* 多副本时逐副本实测评估（可用性＋结构完整度）＋历史可靠性
     * （取页健康成功率），按选择链定默认副本与顺延序：可用性 →
     * 结构完整度 → 历史可靠性 → 分层权重（最后 tiebreak）。
     * 结构完整度只认图数/文长/有无视频，不判画质。 */
    const assessments = new Map<string, CopyAssessment>();
    if (extCopies.length > 1) {
      const health = fetchHealthSnapshot();
      await Promise.all(extCopies.map(async (c) => {
        const def = getActiveRegistry().sources.find((s) => s.id === c.sourceId);
        const adapter = def ? createAdapter(def) : null;
        let available: boolean | null = null;
        let structural: CopyAssessment["structural"] = null;
        if (adapter) {
          try {
            const d = await adapter.detail(c.item.externalId);
            detailCache.current.set(copyCacheKey(c), d);
            available = true;
            structural = structuralCompletenessOf(d);
          } catch { available = false; }
        }
        let reliability: number | null = null;
        if (def) {
          let host = "";
          try { host = new URL(def.baseUrls[0]).host; } catch { host = ""; }
          const rec = health.find((h) => h.host === host);
          if (rec && rec.okCount + rec.failCount > 0) reliability = rec.okCount / (rec.okCount + rec.failCount);
        }
        assessments.set(c.sourceId, { available, structural, reliability });
      }));
    }
    const ordered = orderCopiesForDisplay(extCopies, assessments);
    const got = await loadWithFallback(ordered, (copy) => loadCopy(merged, copy), {
      /* 自动顺延仅限身份已确认的合并条目；未确认时只试默认副本。 */
      allowAutoSwitch: merged.identityConfirmed,
      onFail: (copy) => traceCopyFail(copy.sourceId),
    });
    if (mySeq !== extDetailSeq.current) return;
    if (!got) {
      setExtDetail({
        phase: "error", merged,
        message: merged.identityConfirmed ? "全部来源副本均加载失败" : "默认副本加载失败（该合并条目身份未确认，不自动切换，可手动选副本）",
      });
      return;
    }
    /* 画廊组装以顺延定出的活副本为界（fix337/search-gallery）。 */
    const g = applySearchGallery(merged, got.copy, got.value);
    setImgIdx(g.index);
    setExtDetail({ phase: "ready", data: { merged, ordered, active: got.copy, ...g.value } });
  };

  /* 手动选副本（不受身份门限）：错误态与详情态共用。 */
  const manualPick = async (merged: MergedHit, copy: CopyRef) => {
    if (copy.sourceId === nativeSourceId()) {
      closeExtDetail();
      openNativeCopy(merged, copy);
      return;
    }
    /* 代次守卫（fix335/detail-guard）：取号后落地前比对，加载中
     * 关闭/改开时迟到响应整路丢弃（夹具旧红在案）。 */
    const mySeq = ++extDetailSeq.current;
    setExtDetail({ phase: "loading", merged });
    try {
      const value = await loadCopy(merged, copy);
      if (mySeq !== extDetailSeq.current) return;
      const g = applySearchGallery(merged, copy, value);
      setImgIdx(g.index);
      setExtDetail({
        phase: "ready",
        data: { merged, ordered: merged.copies.filter((c) => c.sourceId !== nativeSourceId()), active: copy, ...g.value },
      });
    } catch {
      if (mySeq !== extDetailSeq.current) return;
      traceCopyFail(copy.sourceId);
      setExtDetail({ phase: "error", merged, message: "该副本加载失败，可换其他副本或重试" });
    }
  };

  /* 切集（fix334/L2 G3）：在当前副本内以所选集 externalId 经加载
   * 核重新取流（copyLoader 按集 resolve），只换 streamUrl 与当前
   * 集标注、不动副本序。竞态以 extEpSeq 只认最后一次点选且落点
   * 校验仍是同一详情/同一副本；失败（含无流）诚实呈现：留当前
   * 集继续播＋epError 明示，不静默回落第一集冒充成功（与副本切
   * 换的静默保持口径不同——切集是用户明确点选的集，落空必须
   * 让用户知道没切成）。 */
  const extEpSeq = useRef(0);
  const switchEpisode = async (merged: MergedHit, current: ExtReady, choice: EpisodeChoice) => {
    if (choice.externalId === current.epExternalId) return;
    const mySeq = ++extEpSeq.current;
    const stillCurrent = (d: ExtReady) => d.merged === merged && d.active === current.active && extEpSeq.current === mySeq;
    try {
      const value = await loadCopy(merged, current.active, choice.externalId);
      if (!value.streamUrl) throw new Error("未解析到可播放地址");
      setExtDetail((cur) => (cur?.phase === "ready" && stillCurrent(cur.data)
        ? { phase: "ready", data: { ...cur.data, streamUrl: value.streamUrl, detail: value.detail ?? cur.data.detail, epExternalId: choice.externalId, epError: undefined } }
        : cur));
    } catch {
      traceCopyFail(current.active.sourceId);
      setExtDetail((cur) => (cur?.phase === "ready" && stillCurrent(cur.data)
        ? { phase: "ready", data: { ...cur.data, epError: `切换到「${choice.label}」失败（仍在播放当前集）` } }
        : cur));
    }
  };

  const switchCopy = async (merged: MergedHit, copy: CopyRef, current: ExtReady) => {
    if (copy.sourceId === current.active.sourceId && copy.item.externalId === current.active.item.externalId) return;
    if (copy.sourceId === nativeSourceId()) {
      closeExtDetail();
      openNativeCopy(merged, copy);
      return;
    }
    /* 代次守卫（fix335/detail-guard）：切换取号后落地前比对，
     * 切换中关闭/再切换时迟到响应整路丢弃（夹具旧红在案）；失
     * 败侧本就无状态落点（仅留痕），不守。 */
    const mySeq = ++extDetailSeq.current;
    try {
      const value = await loadCopy(merged, copy);
      if (mySeq !== extDetailSeq.current) return;
      const g = applySearchGallery(merged, copy, value);
      setImgIdx(g.index);
      /* 副本切换不带选集状态（ExtReady 类型口径、fix334 清扫已
       * 坏-1）：上一副本的 epExternalId/epError 显式剔除、新副本
       * 回落默认集——带过去会让新副本当前集标注/scopeKey 串集，
       * 且 onPlaying 写历史时 ordinal 对不上新副本 choices、整行
       * 静默丢失。画廊条目集同列（fix337/search-gallery）：组装
       * 以新副本所属源为界重算，galleryItems 显式钉为本次组装
       * 结果（未组装即 undefined），不许 {...current} 把上一副本
       * 的画廊带过来让标题/收藏跟随错位到他源条目。 */
      setExtDetail({ phase: "ready", data: { ...current, active: copy, ...g.value, epExternalId: undefined, epError: undefined, galleryItems: g.value.galleryItems } });
    } catch {
      /* 切换失败静默保持当前副本（不弹窗、不打断），留痕即可。 */
      const defs = getActiveRegistry().sources;
      const idx = defs.findIndex((s) => s.id === copy.sourceId);
      tracePlayback("search.copy_fail", { source: sourceStableId(idx >= 0 ? idx : 0) });
    }
  };

  const openMerged = (merged: MergedHit) => {
    const first = merged.copies[0];
    if (!first) return;
    if (first.sourceId === nativeSourceId()) { openNativeCopy(merged, first); return; }
    void openExternal(merged);
  };

  const querying = submitted.length > 0;
  const loading = hgLoading || extLoading || moreLoading;
  const currentGroup = groups[tab];
  const tabLabel = GLOBAL_SEARCH_TABS.find((t) => t.kind === tab)?.label ?? "";
  const currentHotTags = hotTagState.epoch === lineEpoch ? hotTagState.tags : {};
  const currentHotFailed = hotTagState.epoch === lineEpoch ? hotTagState.failed : [];
  const hotFailedSet = new Set(currentHotFailed);
  const missingHotIds = filtering
    ? hotVideos.map(v => v.video_id).filter(id => !(id in currentHotTags) && !hotFailedSet.has(id))
    : [];
  const missingHotKey = missingHotIds.join(",");
  const hotTagPending = filtering && missingHotIds.length > 0;

  /* 官网热搜 HTML 不含标签；仅在开启屏蔽规则时按当前线路并发补查详情标签，未核验前不提前展示。 */
  useEffect(() => {
    if (!active || querying || !filtering || !missingHotIds.length) return;
    let cancelled = false;
    const reqEpoch = lineEpoch;
    const queue = [...missingHotIds];
    const loaded: Record<number, readonly string[]> = {};
    const failed: number[] = [];
    const worker = async () => {
      while (!cancelled && queue.length > 0) {
        const id = queue.shift()!;
        try {
          const detail = await api.video(id);
          if (detail && typeof detail === "object") loaded[id] = Array.isArray(detail.tags) ? detail.tags : [];
          else failed.push(id);
        } catch {
          failed.push(id);
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => worker())).then(() => {
      if (cancelled || !aliveRef.current || hotEpoch.current !== reqEpoch) return;
      setHotTagState(prev => {
        const baseTags = prev.epoch === reqEpoch ? prev.tags : {};
        const baseFailed = prev.epoch === reqEpoch ? prev.failed : [];
        const nextTags = { ...baseTags, ...loaded };
        const nextFailed = [...new Set([...baseFailed.filter(id => !(id in nextTags)), ...failed])];
        return { epoch: reqEpoch, tags: nextTags, failed: nextFailed, retry: prev.retry };
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, querying, filtering, lineEpoch, missingHotKey, hotTagState.retry]);

  const verifiedHotVideos = filtering
    ? hotVideos.filter(v => v.video_id in currentHotTags).map(v => ({ ...v, tags: currentHotTags[v.video_id] }))
    : hotVideos.map(v => ({ ...v, tags: undefined as readonly string[] | undefined }));

  const renderHotList = (list: typeof verifiedHotVideos) => list.length > 0 ? (
    <ol className="ios-search-hot-grid mt-3" aria-busy={hotLoading || hotTagPending}>
      {list.map((video, i) => (
        <li key={video.video_id} className="min-w-0">
          <Button aria-label={`播放 ${video.title}`} title={video.title} className="ios-search-hot-item"
            onClick={() => push({ kind: "feed", videoIds: list.map(item => item.video_id), index: i, title: "热搜榜" })}>
            <span aria-hidden="true" className={`ios-search-hot-rank ${i < 3 ? "text-primary" : "text-mut"}`}>{String(i + 1).padStart(2, "0")}</span>
            <span className="ios-search-hot-content">
              <span className="ios-search-hot-title">{video.title}</span>
              {video.plays && <span className="ios-search-hot-plays"><IPlayF size={10} />{video.plays}</span>}
            </span>
            <IChevR size={15} className="text-mut" />
          </Button>
        </li>
      ))}
    </ol>
  ) : null;

  const renderExtDetail = () => {
    if (!extDetail) return null;
    const merged = extDetail.phase === "ready" ? extDetail.data.merged : extDetail.merged;
    const activeCopy = extDetail.phase === "ready" ? extDetail.data.active : null;
    return (
      <div className="ios-page absolute inset-0 z-30 bg-bg flex flex-col" role="dialog" aria-modal="true" aria-label="搜索结果详情">
        <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
          <div className="ios-subpage-bar">
            <Button aria-label="返回搜索结果" onClick={closeExtDetail} className="ios-nav-btn"><IBack size={20} /></Button>
            <h2 className="flex-1 min-w-0 truncate text-[15px] font-bold text-on">{merged.title}</h2>
            {extDetail.phase === "ready" && (() => {
              /* G4 收藏（fix334/L3）：作用于当前活副本条目，kind 按
               * 合并条目品类映射（video/drama→video、post→post、
               * image→image）；快照标题取合并标题（代表副本口径，
               * 与卡面一致），集数取 detail 事实。 */
              const data = extDetail.data;
              const kind = merged.kind === "post" ? "post" : merged.kind === "image" ? "image" : "video";
              const itemHash = externalHashId(data.active.item);
              const fav = isFav(itemHash, kind === "video" ? "video" : "post");
              const favPending = actionPending(`collect:${kind === "video" ? "video" : "post"}:${itemHash}`);
              return (
                <Button aria-label={fav ? "取消收藏" : "收藏"} disabled={favPending}
                  onClick={() => {
                    void setExternalCollected(kind,
                      { ...data.active.item, title: merged.title || data.active.item.title },
                      !fav, kind === "video" ? (data.detail?.episodes.length || undefined) : undefined);
                    toast(fav ? "已取消收藏" : "已收藏", "star");
                  }}
                  className="grid place-items-center w-9 h-9 shrink-0 rounded-full bg-s2">
                  {fav ? <IStarF size={17} className="text-amber" /> : <IStar size={17} />}
                </Button>
              );
            })()}
          </div>
          {merged.copies.length > 1 && extDetail.phase !== "loading" && (
            <div className="pb-3 flex flex-wrap items-center gap-2" role="group" aria-label="来源副本切换">
              <span className="text-[12px] text-mut">来源副本</span>
              {merged.copies.map((c: CopyRef) => (
                <Button key={`${c.sourceId}:${c.item.externalId}`} aria-pressed={activeCopy?.sourceId === c.sourceId && activeCopy?.item.externalId === c.item.externalId}
                  onClick={() => {
                    if (extDetail.phase === "ready") void switchCopy(merged, c, extDetail.data);
                    else if (extDetail.phase === "error") void manualPick(merged, c);
                  }}
                  className="ios-filter-pill">{c.sourceName}</Button>
              ))}
            </div>
          )}
        </div>
        <div className="flex-1 scroll-y pb-8">
          {extDetail.phase === "loading" && (
            <div className="flex justify-center py-16"><Loader label="正在加载" className="w-8 h-8 spinner" /></div>
          )}
          {extDetail.phase === "error" && (
            <Empty icon={<IFilm size={26} />} title="加载失败" sub={extDetail.message} action="重试" onAction={() => void openExternal(merged)} />
          )}
          {extDetail.phase === "ready" && (() => {
            const data = extDetail.data;
            if (merged.kind === "video" || merged.kind === "drama") {
              /* 选集（fix334/L2 G3）：适用性经派生（宿主面
               * search-external-detail 路由∧模板 multi），多集时在
               * Player 下渲染 EpisodePicker；scopeKey 随当前集变更
               * 防串集缓存。单集/不适用无选集区、观感不变。 */
              const activeDef = getActiveRegistry().sources.find((s) => s.id === data.active.sourceId);
              const choices = episodeChoicesForSurface("search-external-detail", activeDef, data.detail);
              const currentEpId = data.epExternalId ?? choices[0]?.externalId ?? data.active.item.externalId;
              const currentChoice = choices.find((c) => c.externalId === currentEpId);
              return (
                <div className="pt-2">
                  {/* 呈现对齐（fix335/c-presentation）：与 SourceBrowse
                   * 同治——播放器脱 px-4、套 SourcePosts 同款定高
                   * 容器填满，不再 aspect-video 小格子（审计
                   * audit-player-size S1）；注记/选集/简介留 px-4。 */}
                  {data.streamUrl ? (
                    <div className="relative w-full bg-black" style={{ height: "min(48vh, 420px)" }}>
                      <Player src={data.streamUrl} poster={cover(data.active.item.cover)} autoPlay active controls
                        scopeKey={`search:${data.active.sourceId}:${currentEpId}`}
                        onPlaying={() => {
                          /* G4 历史写入（fix334/L3）：真起播首帧才记，
                           * 集数＝当前集 ordinal（无 detail 时以选集序
                           * 位兜底）；去重键含当前集，换集再记。 */
                          const key = `${data.active.sourceId}:${data.active.item.externalId}:${currentEpId}`;
                          if (extHistoryKeyRef.current === key) return;
                          extHistoryKeyRef.current = key;
                          addExternalHistory({ ...data.active.item, title: merged.title || data.active.item.title },
                            data.detail ? episodeOrdinal(data.detail, currentEpId)
                              : Math.max(1, choices.findIndex((c) => c.externalId === currentEpId) + 1),
                            choices.length || undefined);
                        }}
                        diagnosticContext={{ view: "search_external", source_id: data.active.sourceId }}
                        className="w-full h-full" />
                    </div>
                  ) : (
                    <div className="px-4">
                      <Empty icon={<IFilm size={26} />} title="播放地址获取失败" />
                    </div>
                  )}
                  <div className="px-4">
                    <p className="mt-3 text-[12px] text-mut">数据源：{data.active.sourceName}（经适配器实时取数）</p>
                    {choices.length > 1 && currentChoice && (
                      <p className="mt-1 text-[12px] text-mut">当前播放：{currentChoice.label}</p>
                    )}
                    {choices.length > 1 && (
                      <EpisodePicker choices={choices} currentKey={currentEpId}
                        onPick={(c) => void switchEpisode(merged, data, c)} />
                    )}
                    {data.epError && <p role="alert" className="mt-2 text-[12px] text-danger">{data.epError}</p>}
                    {data.detail?.description && <p className="mt-2 text-[13px] text-on/85 leading-relaxed">{data.detail.description}</p>}
                  </div>
                </div>
              );
            }
            if (merged.kind === "image") {
              const images = data.images ?? [];
              const idx = Math.min(imgIdx, Math.max(0, images.length - 1));
              /* 画廊跟随（fix337/search-gallery）：组装成立时当前
               * 条目随 idx 在 galleryItems 内跟随——标题取当前条目
               * 标题、顶栏收藏作用于当前条目（与源内宿主
               * SourceGallery 同语义，钮形同抄其 headerAction）；
               * 未组装（图集源）galleryItems 缺省：标题恒合并标题、
               * 不注入顶栏动作，行为逐字不变。收藏口径与本页页头
               * 收藏同：kind=image 落 post 桶、桥接哈希定条目。 */
              const galleryItems = data.galleryItems;
              const curItem = galleryItems?.[idx] ?? data.active.item;
              const curHash = externalHashId(curItem);
              const curFav = isFav(curHash, "post");
              const curFavPending = actionPending(`collect:post:${curHash}`);
              /* 盖全屏（Muse 2026-11-20 fix336/ui-fixes，用户真机
               * 实报＋18:40 亲口确认）：旧 h-full 内嵌形态把查看器
               * 塞进详情页滚动区——详情页头漏在上方成双标题栏、
               * 壳底部导航漏出。改与 SourceGallery 源内宿主逐字
               * 同形态：fixed inset-0 z-40 顶层覆盖＋immersive
               * 安全区让位，单一标题栏（查看器自带 chrome）、底层
               * 页面全盖住；返回落点（closeExtDetail）与
               * 数据源注记（悬浮层底部）不变。无图时仍走页内
               * 注记行（无查看器可盖）。订正（fix337/album-
               * chrome）：「导航全盖住」对壳底栏不成立——底栏
               * z-50 在根层、覆层被本详情层 z-30 上下文困住，
               * 改走持有让位标记整栏离场（见 extDetailOpen 旁
               * 的 albumOverlayOpen effect）。 */
              return images.length > 0 ? (
                <div className="fixed inset-0 z-40 bg-black">
                  <AlbumViewer title={galleryItems ? (curItem.title || merged.title) : merged.title} images={images} index={idx}
                    onIndexChange={setImgIdx}
                    onBack={closeExtDetail} backLabel="返回搜索结果"
                    footerNote={`数据源：${data.active.sourceName}（经适配器实时取数）`} immersive
                    headerAction={galleryItems ? (
                      <Button aria-label={curFav ? "取消收藏" : "收藏"} disabled={curFavPending}
                        onClick={() => {
                          void setExternalCollected("image", curItem, !curFav);
                          toast(curFav ? "已取消收藏" : "已收藏", "star");
                        }}
                        className="grid place-items-center w-11 h-11 shrink-0 rounded-full bg-black/40 text-white">
                        {curFav ? <IStarF size={19} className="text-amber" /> : <IStar size={19} />}
                      </Button>
                    ) : undefined} />
                </div>
              ) : (
                <p className="px-4 pt-2 text-[12px] text-mut">数据源：{data.active.sourceName}（经适配器实时取数）</p>
              );
            }
            /* 正文全文（fix335/c-presentation S2）：副本页此前只消费
             * cover/description/images，detail.contentHtml 在手却不
             * 渲染——与正身 SourcePosts 同一提取—重构链补齐（判据/
             * 过滤单一出处 extractArticleBlocks，不另起一套）。降级
             * 链与正身同构：提取到块→块渲染（块已按文档序含正文
             * 图）；定位到内容但段级全杀→显简介；提取不到→
             * sanitizeHtml 旧渲染；再无→简介。 */
            const postDetail = data.detail;
            const postExtraction = postDetail?.contentHtml
              ? extractArticleBlocks(postDetail.contentHtml, {
                  base: postDetail.href,
                  title: postDetail.title || merged.title,
                })
              : null;
            const postBlocks = postExtraction && postExtraction.blocks.length ? postExtraction.blocks : null;
            return (
              <div className="px-4 pt-2">
                {data.detail?.cover || data.active.item.cover ? (
                  <div className="relative w-full overflow-hidden rounded-[16px] bg-s2" style={{ aspectRatio: "16 / 9" }}>
                    <Img src={data.detail?.cover || data.active.item.cover} alt={merged.title} eager />
                  </div>
                ) : null}
                {postBlocks ? (
                  <div className="article-body mt-3.5">
                    {postBlocks.map((b, i) => (b.type === "image" ? (
                      <img key={i} src={b.src} alt={b.alt} loading="lazy" />
                    ) : b.heading ? (
                      <h3 key={i}>{b.text}</h3>
                    ) : (
                      <p key={i}>{b.text}</p>
                    )))}
                  </div>
                ) : postExtraction?.located && postDetail?.description ? (
                  /* 定位到内容但段级过滤全杀（正文全是垃圾段）：显
                   * 简介，不回旧渲染把垃圾端上来（正身同口径）。 */
                  <p className="mt-3.5 text-[14px] leading-relaxed text-on/80 whitespace-pre-wrap">{postDetail.description}</p>
                ) : postDetail?.contentHtml ? (
                  /* 提取不到内容（结构未知）：维持旧清洗渲染，如实降级。 */
                  <div className="article-body mt-3.5" onClick={(e) => handleArticleClick(e, openSafeLink, postDetail.href)}
                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(postDetail.contentHtml, postDetail.href) }} />
                ) : postDetail?.description ? (
                  <p className="mt-3.5 text-[14px] leading-relaxed text-on/80 whitespace-pre-wrap">{postDetail.description}</p>
                ) : null}
                {/* 图片纵列：提取块已按文档序含正文图，块渲染时不
                 * 重复；仅降级路径保留（只有 images 字段的帖子不
                 * 丢图）。 */}
                {!postBlocks && (data.detail?.images ?? []).length > 0 && (
                  <div className="mt-3 flex flex-col gap-2">
                    {data.detail!.images.map((src, i) => (
                      <div key={`${src}-${i}`} className="relative w-full overflow-hidden rounded-[12px] bg-s2">
                        <Img src={src} alt="" />
                      </div>
                    ))}
                  </div>
                )}
                <p className="mt-3 text-[12px] text-mut">数据源：{data.active.sourceName}（经适配器实时取数）</p>
              </div>
            );
          })()}
        </div>
      </div>
    );
  };

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      {/* 标题兜底泵（不渲染）：逐源后台补裸 id 卡真标题，覆盖集经
          extTitleOverrides 在聚合前叠加。 */}
      {[...extTitleGroups.values()].map((g) => (
        <ExtTitleFallbackPump key={g.def.id} def={g.def} items={g.items} onOverrides={onExtTitleOverrides} />
      ))}
      <div className="ios-page-heading shrink-0 flex items-center gap-2.5 px-4">
        {/* 出入口同位（2026-11-18 第9项裁定）：左上返回回播放器 */}
        {!wide && (
          <Button onClick={() => setMainTab("home")} aria-label="返回播放器" className="ios-icon-button shrink-0">
            <IBack size={17} />
          </Button>
        )}
        <h1 className="ios-page-title">搜索</h1>
      </div>
      {/* 搜索栏 */}
      <div className="shrink-0 pb-3 flex items-center gap-2.5" >
        <Form className="ios-search-form flex-1 min-w-0 flex items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); submit(q); }}>
          <ISearch size={17} className="text-mut shrink-0" />
          <Input aria-label="搜索视频、短剧、帖子、图片…" ref={inputRef} value={q}
            onChange={(e) => {
              const next = e.target.value;
              setQ(next);
              if (!next && submitted) { setSubmitted(""); seqRef.current++; setHgVideo(null); setHgPost(null); setExtHits([]); setExtSummary(null); setExtTitleOverrides(EMPTY_EXT_TITLE_OVERRIDES); setHgError(null); closeExtDetail(); }
            }}
            placeholder="搜索视频、短剧、帖子、图片…"
            className="flex-1 min-w-0 bg-transparent text-[14px] text-on placeholder-dim outline-none" />
          {(q || submitted) && <Button aria-label="清空搜索" type="button" onClick={() => { seqRef.current++; setHgVideo(null); setHgPost(null); setExtHits([]); setExtSummary(null); setExtTitleOverrides(EMPTY_EXT_TITLE_OVERRIDES); setHgError(null); closeExtDetail(); setQ(""); setSubmitted(""); inputRef.current?.focus(); }} className="ios-icon-button ios-search-clear"><IClose size={16} /></Button>}
        </Form>
        <Button onClick={() => push({ kind: "ranks" })} aria-label="排行榜"
          variant="primary" className="ios-icon-button ios-search-shortcut">
          <ITrophy size={19} />
        </Button>
      </div>

      <div className="flex-1 scroll-y pb-24">
        {!querying ? (
          <>
            <Surface role="region" aria-label="热搜榜" className="mt-1 rounded-(--r-md) bg-s2 p-3.5 a-rise">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="flex items-center gap-1.5 text-[14px] font-semibold text-on/90"><IFireF size={15} className="text-primary" />热搜榜</h2>
                  <Button onClick={() => void refreshHot()} disabled={hotLoading} aria-label="刷新热搜榜"
                    className="-mr-2 px-2 inline-flex items-center justify-end gap-1 text-[12px] text-mut pressable">
                    {hotLoading ? <Loader className="w-3 h-3" /> : <IRefresh size={12} />}{hotLoading ? "刷新中" : "刷新"}
                  </Button>
                </div>
                {hotError && <p role="status" className="mt-2 text-[12px] text-mut leading-relaxed">
                  {hotVideos.length > 0 ? "刷新失败，保留上次榜单。" : "热搜榜暂不可用。"}{hotError}
                </p>}
                {hotVideos.length > 0 ? (
                  filtering ? (
                    <>
                      {hotTagPending && !verifiedHotVideos.length && (
                        <p role="status" className="mt-3 text-[12px] text-mut">正在按屏蔽偏好核验热搜榜…</p>
                      )}
                      {verifiedHotVideos.length > 0 && (
                        <FilteredContent items={verifiedHotVideos} scopeKey={`hot:${lineEpoch}`} className="mt-3 mb-0 bg-s3/80">
                          {visible => renderHotList(visible)}
                        </FilteredContent>
                      )}
                      {!hotTagPending && currentHotFailed.length > 0 && (
                        <div role="status" className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[12px] text-mut">
                          <span>{currentHotFailed.length} 条热搜未能核验标签，已暂缓展示</span>
                          <Button onClick={() => setHotTagState(prev => ({
                            epoch: lineEpoch,
                            tags: prev.epoch === lineEpoch ? prev.tags : {},
                            failed: [],
                            retry: prev.retry + 1,
                          }))} className="-mr-2 px-2 min-h-9 inline-flex items-center text-primary">重试核验</Button>
                        </div>
                      )}
                    </>
                  ) : renderHotList(verifiedHotVideos)
                ) : !hotError && <p role="status" className="mt-3 text-[12px] text-mut">{hotLoading ? "加载中…" : "暂无热搜影片"}</p>}
              </Surface>

            {searchHist.length > 0 && (
              <Surface role="region" aria-label="搜索历史" className="mt-4 rounded-(--r-md) bg-s2 p-3.5 a-rise">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-[14px] font-semibold text-on/90">搜索历史</h2>
                  <Button onClick={clearSearchHist} className="-mr-2 px-2 inline-flex items-center justify-end text-[12px] text-mut pressable">清空</Button>
                </div>
                <div className="flex flex-wrap gap-2 mt-3">
                  {searchHist.map((h) => (
                    <Button key={h} onClick={() => { setQ(h); submit(h); }} className="ios-filter-pill text-on/90">{h}</Button>
                  ))}
                </div>
              </Surface>
            )}

            <SearchTags key={JSON.stringify([lineEpoch, scope])} active={active} />
          </>
        ) : (
          <>
            <SegmentedControl className="mt-1 mb-3" aria-label="搜索结果类型" activeIndex={Math.max(0, GLOBAL_SEARCH_TABS.findIndex((t) => t.kind === tab))}>
              {GLOBAL_SEARCH_TABS.map((t) => (
                <Button aria-pressed={tab === t.kind} key={t.kind} onClick={() => setTab(t.kind)}>{t.label}</Button>
              ))}
            </SegmentedControl>
            <div role="status" className="text-[12px] text-mut mb-2.5" aria-live="polite">
              {loading && <span className="block">{moreLoading ? "正在加载更多…" : `正在搜索「${submitted}」…`}</span>}
              {!loading && <>「{submitted}」已加载 <span className="text-primary font-bold">{currentGroup.length}</span> 条{tabLabel}</>}
            </div>
            {hgError && <div role="alert" className="flex flex-wrap items-center gap-2 mb-3 text-[13px] text-danger">
              <span>「{submitted}」黄果通道搜索失败：{hgError}（其他来源结果不受影响）</span>
              <Button onClick={() => submit(submitted)} disabled={loading} className="px-3 text-primary">重试</Button>
            </div>}
            {/* 扇出失败呈现（fix333/m4-search 修 P4）：部分失败点名
             * 失败源＋计数（结果可能不完整）；全部失败走 alert 并与
             * 下方空态的失败文案呼应，不再与「无结果」同形。 */}
            {extSummary && extSummary.failed.length > 0 && (extSummary.allFailed ? (
              <div role="alert" className="flex flex-wrap items-center gap-2 mb-3 text-[13px] text-danger">
                <span>外部来源全部搜索失败：{extSummary.failed.map((f) => f.sourceName).join("、")}（共 {extSummary.total} 个来源；结果仅来自黄果通道）</span>
                <Button onClick={() => submit(submitted)} disabled={loading} className="px-3 text-primary">重试</Button>
              </div>
            ) : (
              <div role="status" className="flex flex-wrap items-center gap-2 mb-3 text-[13px] text-mut">
                <span>{extSummary.failed.length} 个来源搜索失败：{extSummary.failed.map((f) => f.sourceName).join("、")}（结果可能不完整，其余来源不受影响）</span>
                <Button onClick={() => submit(submitted)} disabled={loading} className="px-3 text-primary">重试</Button>
              </div>
            ))}
            <section aria-label="搜索结果" aria-busy={loading}>
              {currentGroup.length > 0 ? <>
                <FilteredContent items={currentGroup} scopeKey={JSON.stringify([submitted, tab])}>{visible => <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
                  {visible.map((m) => (
                    <MediaCard key={`${m.kind}:${m.sourceId}:${m.item.externalId}:${m.title}`} title={m.title} cover={m.cover}
                      subtitle={m.alsoOn.length ? `${m.sourceName} · 多源都有` : m.sourceName}
                      onOpen={() => openMerged(m)} />
                  ))}
                </div>}</FilteredContent>
                <div ref={moreSentinelRef} style={{ height: 1 }} />
                <div className="flex justify-center py-4">
                  {moreLoading ? <Loader label="搜索结果更新中" className="w-6 h-6 spinner" />
                    : hasMore ? (hgError ? (
                      <Button onClick={loadMore} className="px-5 h-9 rounded-(--r-ctl) bg-s3 text-[13px] text-on/85 pressable">加载更多</Button>
                    ) : null) : <span className="text-[12px] text-dim">— 已经到底啦 —</span>}
                </div>
              </> : loading ? (
                <div className="flex justify-center py-12"><Loader label="正在搜索" className="w-8 h-8 spinner" /></div>
              ) : extSummary?.allFailed ? (
                <Empty icon={<ISearch size={26} />} title="外部来源搜索全部失败" sub="没有拿到任何外部来源的结果，请重试或检查网络后再试"
                  action="重试搜索" onAction={() => submit(submitted)} />
              ) : (
                <Empty icon={<ISearch size={26} />} title="没有找到相关内容" sub="换个关键词试试，比如「都市」「逆袭」"
                  action="看看排行榜" onAction={() => push({ kind: "ranks" })} />
              )}
            </section>
          </>
        )}
      </div>
      {renderExtDetail()}
    </div>
  );
}

/* ================= 排行榜 ================= */
const RANK_TABS = [
  { k: "hot", label: "热播榜" },
  { k: "recommend", label: "推荐榜" },
  { k: "potential", label: "潜力榜" },
] as const;

export function RankPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push, lineEpoch } = useStore();
  type RankKind = typeof RANK_TABS[number]["k"];
  type RankState = { items: RankItem[]; loadedAt: number; loading: boolean; error: string };
  const [tab, setTab] = useState<RankKind>("hot");
  const [states, setStates] = useState<Partial<Record<RankKind, RankState>>>({});
  const cache = useRef<Partial<Record<RankKind, RankState>>>({});
  const pending = useRef(new Set<string>());
  const alive = useRef(true);
  const epochRef = useRef(lineEpoch);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = async (kind: RankKind) => {
    const reqEpoch = epochRef.current;
    const inflightKey = `${reqEpoch}:${kind}`;
    if (pending.current.has(inflightKey)) return;
    pending.current.add(inflightKey);
    const previous = cache.current[kind];
    const update = (state: RankState) => {
      cache.current[kind] = state;
      if (alive.current) setStates(current => ({ ...current, [kind]: state }));
    };
    update({ items: previous?.items ?? [], loadedAt: previous?.loadedAt ?? 0, loading: true, error: "" });
    try {
      const res = await api.rank(kind);
      if (reqEpoch !== epochRef.current) return;
      update({ items: res?.items || [], loadedAt: Date.now(), loading: false, error: "" });
    } catch (error) {
      if (reqEpoch !== epochRef.current) return;
      update({ items: previous?.items ?? [], loadedAt: previous?.loadedAt ?? 0, loading: false,
        error: error instanceof Error ? error.message : "榜单加载失败，请重试" });
    } finally { pending.current.delete(inflightKey); }
  };
  useEffect(() => {
    if (epochRef.current !== lineEpoch) {
      epochRef.current = lineEpoch;
      cache.current = {};
      pending.current.clear();
      setStates({});
    }
    if (!cache.current[tab]?.loadedAt || Date.now() - cache.current[tab]!.loadedAt > 60_000) void load(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, lineEpoch]);
  const state = states[tab];
  const items = state?.items ?? [];
  const loading = state?.loading ?? true;
  const err = state?.error ?? "";
  const max = Math.max(1, ...items.map((x) => x.metric_value || 0));
  const meta = RANK_TABS.find((t) => t.k === tab)!;

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-subpage-header shrink-0 relative overflow-hidden" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(90% 120% at 100% 0%, var(--p-pc) 0%, transparent 60%)", opacity: 0.32 }} />
        <div className="relative">
          <div className="ios-subpage-bar">
            <Button aria-label="返回" onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
            <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0"><ITrophy size={19} /></span>
            <div className="flex-1 min-w-0">
              <h1 className="text-[17px] font-bold text-on leading-tight">排行榜</h1>
              <div className="text-[12px] text-mut leading-tight mt-0.5">{meta.label}{items.length ? ` · TOP ${items.length}` : ""}</div>
            </div>
            <Button aria-label="刷新榜单" disabled={loading} onClick={() => void load(tab)} className="ios-nav-btn">
              {loading ? <Loader label="正在更新榜单" className="w-4 h-4" /> : <IRefresh size={18} />}
            </Button>
          </div>
          <SegmentedControl className="mb-3" aria-label="榜单类型" activeIndex={RANK_TABS.findIndex(item => item.k === tab)}>
            {RANK_TABS.map((t) => (
              <Button aria-pressed={tab === t.k} key={t.k} onClick={() => setTab(t.k)}>{t.label}</Button>
            ))}
          </SegmentedControl>
        </div>
      </div>

      <div className="flex-1 scroll-y pt-3.5 pb-8">
        {err && <div role="alert" className="flex flex-wrap items-center gap-2 mb-3 text-[13px] text-danger">
          <span>榜单加载失败：{err}{items.length > 0 ? "；已保留上次榜单" : ""}</span>
          <Button onClick={() => void load(tab)} disabled={loading} className="px-3 text-primary">重试</Button>
        </div>}
        <section aria-label={meta.label} aria-busy={loading}>
          {items.length > 0 ? <>
            {loading && <p role="status" className="text-[12px] text-mut mb-2">正在刷新，当前显示上次榜单…</p>}
            <FilteredContent items={items} scopeKey={tab}>{visible => visible.map((it) => (
              <RankRow key={`${it.video_id}-${it.rank}`} item={it} metricMax={max}
                onOpen={() => push({ kind: "feed", videoIds: visible.map((x) => x.video_id), index: visible.findIndex((x) => x.video_id === it.video_id), title: meta.label })} />
            ))}</FilteredContent>
          </> : loading ? (
            <div className="flex justify-center py-12"><Loader label="正在加载榜单" className="w-8 h-8 spinner" /></div>
          ) : !err && (
            <Empty icon={<ITrophy size={26} />} title="榜单暂时为空" />
          )}
        </section>
        {wide && <div className="h-2" />}
      </div>
    </div>
  );
}
