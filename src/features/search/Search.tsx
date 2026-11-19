import { Button, Form, Input, SegmentedControl, Surface } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, cover, fmt, isMobile } from "../../shared/api/api";
import type { HotSearchVideo, Post, RankItem, VideoCard } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { MediaCard, RankRow } from "../../shared/ui/cards";
import { FilteredContent } from "../../shared/ui/FilteredContent";
import { Empty, Img } from "../../shared/ui/ui";
import { SearchTags } from "./SearchTags";
import { IBack, IChevR, IClose, IFilm, IFireF, IPlayF, IRefresh, ISearch, ITrophy } from "../../shared/ui/icons";
import { withRequestTimeout } from "../../shared/lib/withTimeout";
import { tracePlayback } from "../../shared/diagnostics/playbackDiagnostics";
import { AlbumViewer } from "../sources/AlbumViewer";
import { getActiveRegistry } from "../sources/manifest";
import { createAdapter } from "../sources/adapters/index.ts";
import { sourceStableId } from "../sources/registryDiag";
import type { SourceDetail } from "../sources/types";
import { Player } from "../playback";
import { fetchHealthSnapshot } from "../sources/adapters/fetchHealth.ts";
import {
  GLOBAL_SEARCH_TABS, aggregateHits, fanoutSearch, kindSignalOfDetail,
  loadWithFallback, needsCanonicalKindLookup, orderCopiesForDisplay, searchKindForHuangguoVideo, structuralCompletenessOf,
  type CopyAssessment, type CopyRef, type EpisodeStructureSignal, type FanoutHit, type GlobalSearchKind, type MergedHit,
} from "./multiSourceSearch";

/* 全局搜索（Muse 2026-11-19 最终版 D3 线，用户亲点＋定稿）：
 * 提交后三路并发——黄果视频（api.search kind=video，按 is_original
 * 分视频/短剧）、黄果帖子（api.searchPosts）、外部源扇出
 * （fanoutSearch：active 注册表经 searchPolicyFor 分层纳入、经
 * createAdapter 调各源 search；单源超时＋每源上限、onPartial 渐进
 * 呈现先到先显）。全部结果统一成 FanoutHit 后经 aggregateHits
 * 跨源合并（多信号置信门、索引层合并保留全部副本）＋同类混排
 * （相关性优先、源等级只作 tiebreak、单源首屏贡献上限），页签
 * 恒四类（GLOBAL_SEARCH_TABS），永不按源分段。外部单源失败
 * 静默跳过、只经 tracePlayback 留痕（search.source_fail），不弹窗、
 * 不整页报错；黄果通道失败保留既有错误行＋重试（其余源结果照常）。
 * 外部条目点击走 D 线接通口径：视频 resolve→Player、图片 detail→
 * 图集、帖子 detail→正文，均在本页详情层呈现（外部源无黄果数值
 * id 路由）；多副本可切换（副本 pills），默认副本按「可用性→
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
};
type ExtDetailState =
  | { phase: "loading"; merged: MergedHit }
  | { phase: "ready"; data: ExtReady }
  | { phase: "error"; merged: MergedHit; message: string };

const copyCacheKey = (c: CopyRef) => `${c.sourceId}:${c.item.externalId}`;

/** 扇出排除（3.2.1 F1）：已由原生通道完整覆盖、不进 fanoutSearch 的源。 */
const FANOUT_EXCLUDE_NATIVE = new Set(["huangguo"]);

export default function Search({ active, wide }: { active: boolean; wide: boolean }) {
  const { push, searchHist, addSearch, clearSearchHist, lineEpoch, accountScope, setTab: setMainTab } = useStore();
  const { preferences } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [tab, setTab] = useState<GlobalSearchKind>("video");
  const [hgVideo, setHgVideo] = useState<HgState<VideoCard>>(null);
  /* F4b 补判规范信号：key=`${accountScope}:${lineEpoch}:${id}`（作用域
   * 与代次进口径同 useFeedDetails），值只存 Detail 的剧集结构信号。 */
  const [hgCanonicalSignals, setHgCanonicalSignals] = useState<Record<string, EpisodeStructureSignal>>({});
  const kindLookupRequested = useRef(new Set<string>());
  const [hgPost, setHgPost] = useState<HgState<Post>>(null);
  const [extHits, setExtHits] = useState<FanoutHit[]>([]);
  const [hgLoading, setHgLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [extLoading, setExtLoading] = useState(false);
  const [hgError, setHgError] = useState<string | null>(null);
  const [extDetail, setExtDetail] = useState<ExtDetailState | null>(null);
  const [imgIdx, setImgIdx] = useState(0);
  const seqRef = useRef(0);
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
    setExtDetail(null);
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
      setExtLoading(false);
    })();
  };

  const submitRef = useRef(submit);
  submitRef.current = submit;
  const submittedRef = useRef("");
  submittedRef.current = submitted;
  const envKey = `${accountScope}:${lineEpoch}`;
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
        sourceId: "huangguo", sourceName: "黄果", kind: resolvedKind,
        item: { sourceId: "huangguo", externalId: String(v.id), title: v.title, cover: v.cover, href: "", tags: v.tags ?? [], hot: v.hot },
        weight: 100, hot: v.hot ?? 0, seq: seq++, publishedAt: parseTs(v.created_at),
      });
    }
    for (const p of hgPost?.items ?? []) {
      nativeHits.push({
        sourceId: "huangguo", sourceName: "黄果", kind: "post",
        item: { sourceId: "huangguo", externalId: String(p.id), title: p.title, cover: p.cover, href: "", tags: p.tags ?? [], hot: p.hot },
        weight: 100, hot: p.hot ?? 0, seq: seq++, publishedAt: parseTs(p.publish_time ?? p.created_at),
      });
    }
    const ext = extHits.map((h) => ({ ...h, seq: 100_000 + h.seq }));
    return aggregateHits([...nativeHits, ...ext]);
  }, [hgVideo, hgPost, extHits, hgCanonicalSignals, envKey]);

  const openNativeCopy = (merged: MergedHit, copy: CopyRef) => {
    if (merged.kind === "post") {
      push({ kind: "post", id: Number(copy.item.externalId) });
      return;
    }
    const ids = (hgVideo?.items ?? []).map((x) => x.id);
    const id = Number(copy.item.externalId);
    push({ kind: "feed", videoIds: ids, index: Math.max(0, ids.indexOf(id)), title: `搜索 · ${submitted}` });
  };

  const loadCopy = async (merged: MergedHit, copy: CopyRef): Promise<Omit<ExtReady, "merged" | "ordered" | "active">> => {
    const def = getActiveRegistry().sources.find((s) => s.id === copy.sourceId);
    if (!def) throw new Error("源不在注册表");
    const adapter = createAdapter(def);
    if (!adapter) throw new Error("该源未注册可用适配器");
    if (merged.kind === "video" || merged.kind === "drama") {
      const res = await adapter.resolve(copy.item.externalId);
      const stream = res.streams[0];
      if (!stream) throw new Error("该副本未解析到可播放地址");
      return { streamUrl: stream.url, detail: detailCache.current.get(copyCacheKey(copy)) };
    }
    let detail = detailCache.current.get(copyCacheKey(copy));
    if (!detail) {
      detail = await adapter.detail(copy.item.externalId);
      detailCache.current.set(copyCacheKey(copy), detail);
    }
    if (merged.kind === "image") {
      const images = (detail.images?.length ? detail.images : [detail.cover]).filter(Boolean);
      if (!images.length) throw new Error("该副本未解析到图片");
      return { detail, images };
    }
    return { detail };
  };

  const traceCopyFail = (sourceId: string) => {
    const defs = getActiveRegistry().sources;
    const idx = defs.findIndex((s) => s.id === sourceId);
    tracePlayback("search.copy_fail", { source: sourceStableId(idx >= 0 ? idx : 0) });
  };

  const openExternal = async (merged: MergedHit) => {
    setExtDetail({ phase: "loading", merged });
    setImgIdx(0);
    const extCopies = merged.copies.filter((c) => c.sourceId !== "huangguo");
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
    if (!got) {
      setExtDetail({
        phase: "error", merged,
        message: merged.identityConfirmed ? "全部来源副本均加载失败" : "默认副本加载失败（该合并条目身份未确认，不自动切换，可手动选副本）",
      });
      return;
    }
    setExtDetail({ phase: "ready", data: { merged, ordered, active: got.copy, ...got.value } });
  };

  /* 手动选副本（不受身份门限）：错误态与详情态共用。 */
  const manualPick = async (merged: MergedHit, copy: CopyRef) => {
    if (copy.sourceId === "huangguo") {
      setExtDetail(null);
      openNativeCopy(merged, copy);
      return;
    }
    setExtDetail({ phase: "loading", merged });
    try {
      const value = await loadCopy(merged, copy);
      setImgIdx(0);
      setExtDetail({
        phase: "ready",
        data: { merged, ordered: merged.copies.filter((c) => c.sourceId !== "huangguo"), active: copy, ...value },
      });
    } catch {
      traceCopyFail(copy.sourceId);
      setExtDetail({ phase: "error", merged, message: "该副本加载失败，可换其他副本或重试" });
    }
  };

  const switchCopy = async (merged: MergedHit, copy: CopyRef, current: ExtReady) => {
    if (copy.sourceId === current.active.sourceId && copy.item.externalId === current.active.item.externalId) return;
    if (copy.sourceId === "huangguo") {
      setExtDetail(null);
      openNativeCopy(merged, copy);
      return;
    }
    try {
      const value = await loadCopy(merged, copy);
      setImgIdx(0);
      setExtDetail({ phase: "ready", data: { ...current, active: copy, ...value } });
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
    if (first.sourceId === "huangguo") { openNativeCopy(merged, first); return; }
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
            <Button aria-label="返回搜索结果" onClick={() => setExtDetail(null)} className="ios-nav-btn"><IBack size={20} /></Button>
            <h2 className="flex-1 min-w-0 truncate text-[15px] font-bold text-on">{merged.title}</h2>
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
              return (
                <div className="px-4 pt-2">
                  {data.streamUrl ? (
                    <Player src={data.streamUrl} poster={cover(data.active.item.cover)} autoPlay active controls
                      scopeKey={`search:${data.active.sourceId}:${data.active.item.externalId}`}
                      diagnosticContext={{ view: "search_external", source_id: data.active.sourceId }}
                      className="w-full aspect-video" />
                  ) : (
                    <Empty icon={<IFilm size={26} />} title="播放地址获取失败" />
                  )}
                  <p className="mt-3 text-[12px] text-mut">数据源：{data.active.sourceName}（经适配器实时取数）</p>
                  {data.detail?.description && <p className="mt-2 text-[13px] text-on/85 leading-relaxed">{data.detail.description}</p>}
                </div>
              );
            }
            if (merged.kind === "image") {
              const images = data.images ?? [];
              const idx = Math.min(imgIdx, Math.max(0, images.length - 1));
              /* 同形态同治（Muse 2026-11-19 3.2.1修复F6线）：与
               * SourceGallery 同病（写死 4/5 盒子＋上下张按钮行挤压
               * 图片），共用 AlbumViewer 全屏形态——本页在详情页内
               * h-full 填满剩余高度，数据源注记收进悬浮层底部，
               * 返回走查看器悬浮层返回钮（与页头返回同落点）。 */
              return (
                <div className="h-full">
                  {images.length > 0 ? (
                    <AlbumViewer title={merged.title} images={images} index={idx}
                      onIndexChange={setImgIdx}
                      onBack={() => setExtDetail(null)} backLabel="返回搜索结果"
                      footerNote={`数据源：${data.active.sourceName}（经适配器实时取数）`} />
                  ) : (
                    <p className="px-4 pt-2 text-[12px] text-mut">数据源：{data.active.sourceName}（经适配器实时取数）</p>
                  )}
                </div>
              );
            }
            return (
              <div className="px-4 pt-2">
                {data.detail?.cover || data.active.item.cover ? (
                  <div className="relative w-full overflow-hidden rounded-[16px] bg-s2" style={{ aspectRatio: "16 / 9" }}>
                    <Img src={data.detail?.cover || data.active.item.cover} alt={merged.title} eager />
                  </div>
                ) : null}
                {data.detail?.description && <p className="mt-3 text-[13px] text-on/85 leading-relaxed">{data.detail.description}</p>}
                {(data.detail?.images ?? []).length > 0 && (
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
              if (!next && submitted) { setSubmitted(""); seqRef.current++; setHgVideo(null); setHgPost(null); setExtHits([]); setHgError(null); setExtDetail(null); }
            }}
            placeholder="搜索视频、短剧、帖子、图片…"
            className="flex-1 min-w-0 bg-transparent text-[14px] text-on placeholder-dim outline-none" />
          {(q || submitted) && <Button aria-label="清空搜索" type="button" onClick={() => { seqRef.current++; setHgVideo(null); setHgPost(null); setExtHits([]); setHgError(null); setExtDetail(null); setQ(""); setSubmitted(""); inputRef.current?.focus(); }} className="ios-icon-button ios-search-clear"><IClose size={16} /></Button>}
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

            <SearchTags key={JSON.stringify([lineEpoch, accountScope])} active={active} />
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
            <section aria-label="搜索结果" aria-busy={loading}>
              {currentGroup.length > 0 ? <>
                <FilteredContent items={currentGroup} scopeKey={JSON.stringify([submitted, tab])}>{visible => <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
                  {visible.map((m) => (
                    <MediaCard key={`${m.kind}:${m.sourceId}:${m.item.externalId}:${m.title}`} title={m.title} cover={m.cover}
                      subtitle={m.alsoOn.length ? `${m.sourceName} · 多源都有` : m.sourceName}
                      onOpen={() => openMerged(m)} />
                  ))}
                </div>}</FilteredContent>
                <div className="flex justify-center py-4">
                  {moreLoading ? <Loader label="搜索结果更新中" className="w-6 h-6 spinner" />
                    : hasMore ? (
                      <Button onClick={loadMore} className="px-5 h-9 rounded-(--r-ctl) bg-s3 text-[13px] text-on/85 pressable">加载更多</Button>
                    ) : <span className="text-[12px] text-dim">— 已经到底啦 —</span>}
                </div>
              </> : loading ? (
                <div className="flex justify-center py-12"><Loader label="正在搜索" className="w-8 h-8 spinner" /></div>
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
