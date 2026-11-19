import { Button } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmt } from "../../shared/api/api";
import type { Post, VideoCard } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { LOCAL_SCOPE } from "../../shared/model/localLibrary";
import { MediaCard, Masonry, RowCard } from "../../shared/ui/cards";
import { FilteredContent } from "../../shared/ui/FilteredContent";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { CollectionLink, CollectionLinks } from "../../shared/ui/CollectionLink";
import { InplaceSearch } from "../search/InplaceSearch";
import { withRequestTimeout } from "../../shared/lib/withTimeout";
import { dedupedIncoming } from "../../shared/lib/dedup";
import {
  kindSignalOfDetail,
  needsCanonicalKindLookup,
  partitionCardsByResolvedKind,
  type EpisodeStructureSignal,
} from "../../shared/lib/contentKind";
import { traceFeed } from "../../shared/lib/feedTrace";

/* 资料库作用域（账号体系拆除后恒定）：代次键的前缀成分。 */
const scope = LOCAL_SCOPE;
import { Empty } from "../../shared/ui/ui";
import { IAward, IBack, IChevR, IFilm, IFlame, IGrid, ILayers, ISearch, ITag, ITrophy } from "../../shared/ui/icons";
import { firstEnabledSource, sourcesForCategory, sourcesForChannel } from "../sources/registry";
import { getActiveRegistry } from "../sources/manifest";
import { SourcePendingNotice, SourceSwitcher, sourceOptionsForCategory, sourceOptionsForChannel } from "../sources/SourceSwitcher";
import SourceBrowse from "../sources/SourceBrowse";
import SourceGallery from "../sources/SourceGallery";
import SourcePosts from "../sources/SourcePosts";
import { resolvePostsBrowse } from "../sources/postsRoute";

/* 短剧三类合一（根治包多源线条目5）：原 AI成人短剧 / AI成人漫剧
 * （及原创内的短剧/漫剧子筛）合并为一个「短剧」入口，cate 取
 * ai-duanju 为代表走既有 category 接口。
 * 分类修订（Muse 2026-11-19 最终版 D 线，①用户亲定条目7）：
 * cate="original" 频道显示名改「视频」（cate id 不变、接口不变），
 * 其频道页撤除 ai-manju/ai-duanju 子筛（与短剧频道同内容），只留
 * 全部；短剧频道（ai-duanju）本身不动。 */
export const CHANNELS = [
  { cate: "ai-duanju", name: "短剧", Icon: IFilm },
  { cate: "original", name: "视频", Icon: IAward },
] as const;

/* ── 归类补判（fix322 标记线，浏览面接缝）：性质未决定的条目按 ID
 * 查 Detail 规范信号（kindSignalOfDetail 单点构造：集数结构＋
 * tracking 品类标记）。key=`${scope}:${lineEpoch}:${id}`
 * （作用域/线路代次进 key，同搜索面口径，仓库不变量 2）；请求登
 * 记先行、成败都不重复查同一 ID；并发 4；单查 15s 超时兜底、失
 * 败静默——条目保持 unknown 暂扣（不进任何呈现组），信号到达后
 * 经 version 自增触发调用方重算自动归位。总览与频道页共用。 ── */
function useCanonicalKindSignals(envKey: string) {
  const signalsRef = useRef(new Map<string, EpisodeStructureSignal>());
  const requestedRef = useRef(new Set<string>());
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);
  const [version, setVersion] = useState(0);
  const fetchFor = useCallback(async (cards: readonly VideoCard[]): Promise<void> => {
    const queue = cards.filter((v) => needsCanonicalKindLookup(v) && !requestedRef.current.has(`${envKey}:${v.id}`));
    if (!queue.length) return;
    queue.forEach((v) => requestedRef.current.add(`${envKey}:${v.id}`));
    const worker = async () => {
      while (queue.length > 0) {
        const v = queue.shift()!;
        try {
          const d = await withRequestTimeout(api.video(v.id), 15_000);
          if (d) signalsRef.current.set(`${envKey}:${v.id}`, kindSignalOfDetail(d));
        } catch { /* 静默：补不到保持 unknown 安全侧 */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => worker()));
    if (aliveRef.current) setVersion((x) => x + 1);
  }, [envKey]);
  const signalFor = useCallback(
    (card: VideoCard) => signalsRef.current.get(`${envKey}:${card.id}`),
    [envKey],
  );
  return { fetchFor, signalFor, version };
}

/* ================= 分类总览 ================= */
export default function Category({ wide, active }: { wide: boolean; active: boolean }) {
  const { push, lineEpoch, setTab } = useStore();
  const kindSignals = useCanonicalKindSignals(`${scope}:${lineEpoch}`);
  const [rows, setRows] = useState<Record<string, VideoCard[]>>({});
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  /* 注册表口径（Muse 2026-11-19 整改 D2）：读 active 表（远程清单
   * 覆盖生效），hg:registry-changed 后刷新；不再读内置表。 */
  const [, setRegistryTick] = useState(0);
  useEffect(() => {
    const onRegistry = () => setRegistryTick((t) => t + 1);
    window.addEventListener("hg:registry-changed", onRegistry);
    return () => window.removeEventListener("hg:registry-changed", onRegistry);
  }, []);
  const activeSources = getActiveRegistry().sources;
  /* 吃瓜数据源（条目5）：默认第一顺位 enabled 源，切换整段换源不混排 */
  const postSourceOptions = sourceOptionsForCategory("posts");
  const [postsSourceId, setPostsSourceId] = useState(() => firstEnabledSource("posts", getActiveRegistry().sources)?.id ?? "huangguo");
  const postsSource = sourcesForCategory("posts", activeSources).find((s) => s.id === postsSourceId);
  const mounted = useRef(false);
  const started = useRef(false);
  const pending = useRef(new Set<string>());
  const errorsRef = useRef(errors);
  errorsRef.current = errors;
  const lineEpochRef = useRef(lineEpoch);
  lineEpochRef.current = lineEpoch;
  const retryKeys = useRef(new Set<string>());

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const loadPreview = useCallback(async (key: string): Promise<void> => {
    if (pending.current.has(key)) return;
    const requestEpoch = lineEpochRef.current;
    pending.current.add(key);
    setLoading(m => ({ ...m, [key]: true }));
    setErrors(m => ({ ...m, [key]: "" }));
    try {
      if (key === "posts") {
        const result = await api.postCategory("remen-chigua", 1, 8, "latest");
        if (requestEpoch !== lineEpochRef.current) { retryKeys.current.add(key); return; }
        if (mounted.current) setPosts(result?.items || []);
      } else {
        /* 「视频」频道（original）内混排多集剧集，预览按内容性质
         * 分组（F4 线）：窗口放大到 20 条再分组，视频区取 video 组
         * 前 8、drama 组补入短剧区，避免过滤后预览饿死。 */
        const result = key === "original"
          ? await api.originalVideos("all", 1, 20, "new")
          : await api.category(key, 1, 8, "latest");
        if (requestEpoch !== lineEpochRef.current) { retryKeys.current.add(key); return; }
        if (mounted.current) setRows(m => ({ ...m, [key]: result?.items || [] }));
      }
    } catch (error) {
      const stale = requestEpoch !== lineEpochRef.current;
      if (mounted.current && !stale) setErrors(m => ({ ...m, [key]: (error as Error).message || "加载失败" }));
      /* 请求在旧线路上发出、期间线路已切换：等 finally 里用新线路补拉一次 */
      if (stale) retryKeys.current.add(key);
    } finally {
      pending.current.delete(key);
      if (mounted.current) setLoading(m => ({ ...m, [key]: false }));
      const retry = retryKeys.current.delete(key);
      if (retry && mounted.current) void loadPreview(key);
    }
  }, []);

  useEffect(() => {
    // 首次打开分类才加载，避免启动时后台频道请求/封面与首页视频竞争网络。
    if (!active || started.current) return;
    started.current = true;
    CHANNELS.forEach(c => { void loadPreview(c.cate); });
    void loadPreview("posts");
  }, [active, loadPreview]);

  /* 线路切换后：已打开过的分类在新线路上重新获取，避免残留旧线路数据 */
  const prevEpoch = useRef(lineEpoch);
  useEffect(() => {
    if (prevEpoch.current === lineEpoch) return;
    prevEpoch.current = lineEpoch;
    if (!started.current) return;
    setRows({});
    setPosts([]);
    setErrors({});
    CHANNELS.forEach(c => { void loadPreview(c.cate); });
    void loadPreview("posts");
  }, [lineEpoch, loadPreview]);

  /* 总览归类补判（fix322）：original 预览窗口到达后，对性质未决
   * 定者（单集/无信号、无标记）批量查 Detail 品类标记；信号写入
   * 后 version 自增触发下方分组重算、条目自动归位。 */
  useEffect(() => {
    const originals = rows["original"];
    if (originals?.length) void kindSignals.fetchFor(originals);
  }, [rows, kindSignals]);

  /* 性质分组（Muse 2026-11-19 3.2.1 修复 F4 线＋fix322 标记线，
   * 与搜索共用 shared/lib/contentKind 统一裁决）：总览视频区只出
   * resolved video 组；original 频道里的 drama 组条目补入短剧区
   * （按 id 去重），多集条目在总览只归短剧一处、不在两区重复出
   * 现；unknown 组（补判未到/无标记）暂不呈现于任一区。重算依
   * 赖 kindSignals.version（补判到达信号），render 期现算。 */
  void kindSignals.version;
  const originalKindGroups = partitionCardsByResolvedKind(rows["original"] || [], kindSignals.signalFor);

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-page-heading shrink-0 px-4">
        <div className="flex items-center gap-2.5">
          {/* 出入口同位（2026-11-18 第9项裁定）：浏览区各页左上角统一
              返回钮回播放器，与播放器顶栏左上返回钮（进浏览区）同角 */}
          {!wide && (
            <Button onClick={() => setTab("home")} aria-label="返回播放器" className="ios-icon-button shrink-0">
              <IBack size={17} />
            </Button>
          )}
          <h1 className="ios-page-title text-on">分类</h1>
          <span className="text-[12px] text-mut">{CHANNELS.length + 2} 个频道</span>
        </div>
      </div>

      <div className="flex-1 scroll-y pb-24 pt-2">
        {/* 排行榜入口：只在移动端显示（底部导航没有排行榜，桌面侧栏已有） */}
        {!wide && (
          <CollectionLink icon={<ITrophy size={18} />} title="排行榜"
            onClick={() => push({ kind: "ranks" })} className="mb-2.5 w-full" />
        )}

        {/* 专题 + 标签入口 */}
        <CollectionLinks className="ios-category-links mb-6">
          <CollectionLink icon={<ILayers size={18} />} title="专题"
            onClick={() => push({ kind: "topics" })} />
          <CollectionLink icon={<ITag size={18} />} title="标签"
            onClick={() => push({ kind: "tags" })} />
        </CollectionLinks>

        {CHANNELS.map((c, ci) => {
          const rawList = rows[c.cate] || [];
          const list = c.cate === "original"
            ? originalKindGroups.video.slice(0, 8)
            : c.cate === "ai-duanju"
              ? [...rawList, ...originalKindGroups.drama.filter((d) => !rawList.some((x) => x.id === d.id))]
              : rawList;
          const ChannelIcon = c.Icon;
          return (
            <section key={c.cate} aria-label={c.name} className="mb-6 a-rise" style={{ animationDelay: `${Math.min(ci * 50, 300)}ms` }}>
              <Button onClick={() => push({ kind: "channel", cate: c.cate, name: c.name })}
                className="w-full flex items-center gap-3 mb-3 text-left pressable group">
                <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0">
                  <ChannelIcon size={18} strokeWidth={1.9} />
                </span>
                <span className="flex-1 min-w-0">
                  <span role="heading" aria-level={2} className="block text-[16px] font-bold text-on leading-tight">{c.name}</span>
                </span>
                <span className="inline-flex items-center gap-0.5 text-[13px] font-medium leading-none text-mut group-hover:text-primary transition-colors shrink-0">
                  <span>全部</span><IChevR size={14} />
                </span>
              </Button>
              <FilteredContent items={list} scopeKey={c.cate}>{visible => <div className="scroll-x flex gap-3 snap-x" role="group" aria-label={`${c.name}影片预览`}>
                {visible.map((v) => (
                  <RowCard key={v.id} v={v} onOpen={() => push({ kind: "feed", videoIds: visible.map((x) => x.id), index: visible.findIndex((x) => x.id === v.id), title: c.name })} />
                ))}
                {!list.length && <PreviewStatus name={c.name} loading={loading[c.cate] !== false} error={errors[c.cate]} onRetry={() => void loadPreview(c.cate)} />}
              </div>}</FilteredContent>
            </section>
          );
        })}

        {/* 吃瓜 */}
        <section aria-label="吃瓜" className="mb-5 a-rise">
          <Button onClick={() => push({ kind: "posts" })}
            className="w-full flex items-center gap-3 mb-3 text-left pressable group">
            <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0">
              <IFlame size={18} strokeWidth={1.9} />
            </span>
            <span className="flex-1 min-w-0">
              <span role="heading" aria-level={2} className="block text-[16px] font-bold text-on leading-tight">吃瓜</span>
            </span>
            <span className="inline-flex items-center gap-0.5 text-[13px] font-medium leading-none text-mut group-hover:text-primary transition-colors shrink-0">
              <span>全部</span><IChevR size={14} />
            </span>
          </Button>
          <div className="mb-3"><SourceSwitcher options={postSourceOptions} value={postsSourceId} onChange={setPostsSourceId} ariaLabel="吃瓜数据源切换" /></div>
          {postsSourceId === "huangguo" ? (
          <FilteredContent items={posts} scopeKey="posts">{visible => <div className="scroll-x flex gap-3 snap-x" role="group" aria-label="吃瓜内容预览">
            {visible.map((post) => (
              <div key={post.id} className="ios-row-card"><MediaCard title={post.title} cover={post.cover}
                subtitle={`${fmt(post.hot)} 次浏览`} onOpen={() => push({ kind: "post", id: post.id })} /></div>
            ))}
            {!posts.length && <PreviewStatus name="吃瓜" loading={loading.posts !== false} error={errors.posts} onRetry={() => void loadPreview("posts")} />}
          </div>}</FilteredContent>
          ) : resolvePostsBrowse(postsSource) === "browse" && postsSource ? (
            /* 吃瓜预览接线（3.3.0 接通批，与 Posts 页同判定）：非黄果
             * 非 blocked 源经 SourcePosts compact 真取数；blocked 仍
             * 走诚实提示。此前本预览对一切非黄果源无条件提示。 */
            <SourcePosts def={postsSource} compact onShowAll={() => push({ kind: "posts" })} />
          ) : (
            <SourcePendingNotice displayName={postsSource?.displayName ?? postsSourceId} maturity={postsSource?.maturity} note={postsSource?.note} />
          )}
        </section>

        {/* 图片分区（Muse 2026-11-19 最终版 D 线，①用户亲定条目8；
            2026-11-19 fix321-F2 修订）：只列 active 注册表
            category="image" 的已启用源（sourcesForCategory 只返回
            enabled，maturity 徽标照 SourceSwitcher 口径），点开推
            既有 channel 栈页（cate="image:<源id>"）进图集浏览页。
            浏览面只显示已启用源：停用状态的源不在此排队，只在源管理/
            诊断明细面可见（远程清单启用后自动转入本列表）。 */}
        <section aria-label="图片" className="mb-5 a-rise">
          <div className="flex items-center gap-3 mb-3">
            <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0"><IGrid size={18} strokeWidth={1.9} /></span>
            <span role="heading" aria-level={2} className="block text-[16px] font-bold text-on leading-tight">图片</span>
          </div>
          <div className="flex flex-col gap-2">
            {sourcesForCategory("image", activeSources).map((s) => (
              <Button key={s.id} onClick={() => push({ kind: "channel", cate: `image:${s.id}`, name: s.displayName })}
                className="w-full flex items-center gap-3 rounded-[16px] bg-s2 px-4 py-3 text-left pressable">
                <span className="flex-1 min-w-0 text-[14px] font-medium text-on">{s.displayName}</span>
                {s.maturity === "blocked"
                  ? <span className="shrink-0 rounded-full bg-s3 px-2 py-0.5 text-[11px] font-semibold text-mut">暂不可用</span>
                  : s.maturity === "probe"
                    ? <span className="shrink-0 rounded-full bg-s3 px-2 py-0.5 text-[11px] font-semibold text-mut">未实测</span>
                    : null}
                <IChevR size={14} />
              </Button>
            ))}
          </div>
        </section>


        <div className="text-center text-[12px] text-dim pt-1">— 已展示全部频道 —</div>
      </div>
      {wide && <div />}
    </div>
  );
}

function PreviewStatus({ name, loading, error, onRetry }: { name: string; loading: boolean; error?: string; onRetry: () => void }) {
  return <div role="status" aria-busy={loading} className="h-[150px] flex flex-col justify-center items-start gap-2 text-[12px] text-dim px-1">
    <span>{loading ? "加载中…" : error || "暂无内容"}</span>
    {!loading && error && <Button aria-label={`重试${name}`} onClick={onRetry} className="text-primary pressable">重试</Button>}
  </div>;
}

/* ================= 频道详情页 ================= */
const CHANNEL_SORTS = [
  { value: "latest", label: "最近更新" },
  { value: "hot_window", label: "当前热播" },
  { value: "random", label: "精选推荐" },
] as const;

/* 「视频」频道（cate="original"）子筛（Muse 2026-11-19 最终版
 * D 线，①用户亲定条目7）：原 ai-manju（原创漫剧）/ai-duanju（原创
 * 短剧）子筛与短剧频道同内容、已撤除，只留全部。 */
const ORIGINAL_CATES = [
  { value: "all", label: "全部" },
] as const;

const originalSort = (cate: (typeof ORIGINAL_CATES)[number]["value"]) =>
  cate === "all" ? "new" : "latest";

export function ChannelPage({ cate, name, onBack, wide }: { cate: string; name: string; onBack: () => void; wide: boolean }) {
  const { push, lineEpoch } = useStore();
  const kindSignals = useCanonicalKindSignals(`${scope}:${lineEpoch}`);
  const { preferences } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const [searching, setSearching] = useState(false);
  /* 视频数据源（条目5）：黄果为本频道原生源；切其他源整页换源不混排 */
  const [channelSourceId, setChannelSourceId] = useState("huangguo");
  /* 注册表口径（整改 D2）：同 Category，读 active 表并订阅刷新 */
  const [, setRegistryTick] = useState(0);
  useEffect(() => {
    const onRegistry = () => setRegistryTick((t) => t + 1);
    window.addEventListener("hg:registry-changed", onRegistry);
    return () => window.removeEventListener("hg:registry-changed", onRegistry);
  }, []);
  /* 切源片按频道-源映射（Muse 2026-11-19 fix321-F2）：只列对本
   * 频道有真实品类映射的源（sourcesForChannel(cate)），无映射源
   * 不进本频道列表；陈旧选择（来自其他频道）不在本频道映射内时
   * 回落原生黄果，不跨频道生效。 */
  const videoSourceOptions = [{ id: "huangguo", label: "黄果" }, ...sourceOptionsForChannel(cate)];
  const effectiveChannelSourceId = channelSourceId === "huangguo" || videoSourceOptions.some((o) => o.id === channelSourceId)
    ? channelSourceId
    : "huangguo";
  const channelSource = sourcesForChannel(cate, getActiveRegistry().sources).find((s) => s.id === effectiveChannelSourceId);
  const [serverSort, setServerSort] = useState<(typeof CHANNEL_SORTS)[number]["value"]>("latest");
  const [originalCate, setOriginalCate] = useState<(typeof ORIGINAL_CATES)[number]["value"]>("all");
  const [pageItems, setPageItems] = useState<VideoCard[][]>([]);
  const items = pageItems.flat();
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const filterKey = (sort: string, original: string) => `${cate}:${cate === "original" ? original : sort}`;
  const [displayedFilter, setDisplayedFilter] = useState(() => filterKey("latest", "all"));
  const [err, setErr] = useState<string | null>(null);
  const busy = useRef(false);
  const requestSeq = useRef(0);
  const lastFailAt = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const scrollContainer = useRef<HTMLDivElement>(null);

  const loadMore = async (reset = false, sortOverride: string = serverSort, originalCateOverride = originalCate) => {
    const seq = reset ? ++requestSeq.current : requestSeq.current;
    if (!reset && (busy.current || page >= pages)) return;
    busy.current = true;
    setLoading(true);
    setErr(null);
    if (reset) setRefreshing(true);
    try {
      const next = reset ? 1 : page + 1;
      /* 超时护栏（fix2 A2 推广）：无超时悬挂会把 busy 永久堵死、
       * 哨兵与按钮双亡（吃瓜同病）；30s 竞速超时走 catch 置 err，
       * 迟到响应被 race 丢弃。 */
      traceFeed("page.request", { list: `channel:${cate}`, page: next, reset });
      const startedAt = Date.now();
      const res = await withRequestTimeout(cate === "original"
        ? api.originalVideos(originalCateOverride, next, 20, originalSort(originalCateOverride))
        : api.category(cate, next, 20, sortOverride));
      if (seq !== requestSeq.current) return;
      const rawItems = res?.items || [];
      /* 性质过滤（F4 线＋fix322 标记线）：「视频」频道服务端分页内
       * 混排剧集与单条，incoming 先经统一裁决只入 resolved video
       * 组。fix322 前只看集数结构——单集短剧与普通视频同形被放行
       * （3.2.1 真机实锤）；现每页先对性质未决定者（无标记且集数
       * ≤1）批量补判 Detail 品类标记（useCanonicalKindSignals，
       * 并发 4、静默失败），标记定夺后 drama 与 unknown（补判失
       * 败/Detail 无标记）都不入列表。补判在 busy 内完成、await
       * 后复检 seq 防迟到写入。分页取舍：过滤只作用于入列表的条
       * 目，page/pages 仍按服务端原值推进与终止（见下方
       * setPages），单页可见数可少于 20、整页被滤光时哨兵/加载
       * 更多继续翻下一服务端页，不提前到底也不死循环。 */
      let incomingItems = rawItems;
      if (cate === "original") {
        await kindSignals.fetchFor(rawItems);
        if (seq !== requestSeq.current) return;
        incomingItems = partitionCardsByResolvedKind(rawItems, kindSignals.signalFor).video;
      }
      setPageItems((prev) => {
        const base = reset ? [] : prev;
        /* pageItems 是分页数组：新页 = 相对全部已加载页去重后的 incoming
         * （dedupedIncoming 与 appendDeduped 同一实现，页内重复同步入 seen） */
        return [...base, dedupedIncoming(base.flat(), incomingItems, (x) => x.id)];
      });
      setDisplayedFilter(filterKey(sortOverride, originalCateOverride));
      setPage(next);
      /* 终止只认接口 pages；缺失时仅空页才推断到尾（旧 `|| next`
       * 在接口偶发缺 pages 时把总页数钉死在当前页、提前终止）。
       * reset（换筛选/重拉）时页数基线归 1（fix2.1 整改，GPT 四审
       * #10）：旧写法拿旧筛选的 pages 与 next 取 max，响应缺 pages
       * 时新筛选继承旧总页数、状态行页数与可翻页判断双双失真。 */
      setPages(res?.pagination?.pages ?? ((res?.items?.length ?? 0) > 0 ? Math.max(reset ? 1 : pages, next) : next));
      setErr(null);
      traceFeed("page.success", { list: `channel:${cate}`, page: next, received: rawItems.length, kindFiltered: rawItems.length - incomingItems.length, pages: res?.pagination?.pages ?? null, ms: Date.now() - startedAt });
    } catch (e) {
      traceFeed("page.fail", { list: `channel:${cate}`, page: reset ? 1 : page + 1, reason: "error", message: (e as Error).message || "加载失败" });
      if (seq === requestSeq.current) { lastFailAt.current = Date.now(); setErr((e as Error).message || "加载失败"); }
    } finally {
      if (seq === requestSeq.current) {
        busy.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    }
  };

  const changeServerSort = (value: (typeof CHANNEL_SORTS)[number]["value"]) => {
    if (value === serverSort) return;
    if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
    setServerSort(value);
    setErr(null);
    void loadMore(true, value);
  };

  useEffect(() => {
    /* 图片源页（cate="image:<id>"）不走黄果频道接口，数据由
     * SourceGallery 经适配器供给，本 effect 直接跳过。 */
    if (cate.startsWith("image:")) return;
    setPageItems([]); setPage(0); setPages(1);
    setServerSort("latest"); setOriginalCate("all"); setSearching(false);
    void loadMore(true, "latest", "all");
    return () => { requestSeq.current++; busy.current = false; };
    /* eslint-disable-next-line */
  }, [cate, lineEpoch]);
  const filterPending = displayedFilter !== filterKey(serverSort, originalCate);
  const replacing = refreshing || filterPending;
  /* 哨兵不再因 err 整体停摆（fix2 A2 推广，吃瓜同病）：错误态下哨兵
   * 保持挂载，冷却 3s 后重入视区可再触发重试（loadMore 在 err 时
   * 页码未前进、重打的正是失败页）；错误行重试按钮仍在。 */
  useEffect(() => {
    const el = sentinel.current;
    if (!el || loading || replacing || page >= pages) return;
    const io = new IntersectionObserver((es) => {
      if (!es[0].isIntersecting) return;
      if (err && Date.now() - lastFailAt.current < 3000) return;
      void loadMore();
    }, { root: scrollContainer.current, rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pages, loading, err, replacing]);

  const ChannelGlyph = CHANNELS.find(c => c.cate === cate)?.Icon ?? IFilm;
  /* 图片源页（Muse 2026-11-19 最终版 D 线，①用户亲定条目8）：
   * cate="image:<源id>" 为分类页图片分区的入口约定（复用既有
   * channel 栈页与 push/pop，不新增路由 kind）。blocked 源维持
   * 既有诚实提示页、不拉数据；其余经 SourceGallery 走适配器。 */
  const imageSourceId = cate.startsWith("image:") ? cate.slice("image:".length) : null;
  const imageSource = imageSourceId
    ? sourcesForCategory("image", getActiveRegistry().sources).find((s) => s.id === imageSourceId)
    : undefined;
  if (imageSourceId) {
    return (
      <div className="ios-page absolute inset-0 bg-bg flex flex-col">
        <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
          <div className="ios-subpage-bar">
            <Button aria-label="返回" onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
            <div className="flex-1 min-w-0">
              <h1 className="text-[17px] font-bold text-on leading-tight truncate">{name}</h1>
              <div role="status" className="text-[12px] text-mut leading-tight mt-0.5">图片 · 数据源：{imageSource?.displayName ?? imageSourceId}</div>
            </div>
          </div>
        </div>
        <div className="flex-1 scroll-y pb-8">
          {!imageSource || imageSource.maturity === "blocked" ? (
            <SourcePendingNotice displayName={imageSource?.displayName ?? name} maturity={imageSource?.maturity ?? "blocked"} note={imageSource?.note} />
          ) : (
            <SourceGallery def={imageSource} />
          )}
        </div>
      </div>
    );
  }
  /* 外部视频源（Muse 2026-11-19 最终版 D 线，①用户点名＋②实锤
   * createAdapter 生产调用为 0）：blocked 维持既有诚实提示页；
   * 其余（stable/probe）经 SourceBrowse 走适配器真取数，失败错误
   * 态＋重试，不回落黄果数据冒充。 */
  if (effectiveChannelSourceId !== "huangguo") {
    return (
      <div className="ios-page absolute inset-0 bg-bg flex flex-col">
        <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
          <div className="ios-subpage-bar">
            <Button aria-label="返回" onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
            <div className="flex-1 min-w-0">
              <h1 className="text-[17px] font-bold text-on leading-tight truncate">{name}</h1>
              <div role="status" className="text-[12px] text-mut leading-tight mt-0.5">数据源：{channelSource?.displayName ?? effectiveChannelSourceId}</div>
            </div>
          </div>
          <div className="pb-3"><SourceSwitcher options={videoSourceOptions} value={effectiveChannelSourceId} onChange={setChannelSourceId} ariaLabel="视频数据源切换" /></div>
        </div>
        <div className="flex-1 scroll-y pb-8">
          {!channelSource || channelSource.maturity === "blocked" ? (
            <SourcePendingNotice displayName={channelSource?.displayName ?? effectiveChannelSourceId} maturity={channelSource?.maturity} note={channelSource?.note} />
          ) : (
            <SourceBrowse def={channelSource} />
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="ios-subpage-bar">
          <Button aria-label="返回" onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
          <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0"><ChannelGlyph size={18} strokeWidth={1.9} /></span>
          <div className="flex-1 min-w-0">
            <h1 className="text-[17px] font-bold text-on leading-tight truncate">{name}</h1>
            <div role="status" className="text-[12px] text-mut leading-tight mt-0.5">{replacing ? (loading ? "正在更新筛选结果…" : "筛选更新失败") : `已加载 ${items.length} 部 · ${page}/${Math.max(pages, 1)} 页`}</div>
          </div>
          <Button onClick={() => setSearching(true)} aria-label={cate === "original" ? "搜索视频" : "搜索短剧"} className="ios-nav-btn"><ISearch size={18} /></Button>
        </div>
        {cate !== "original" && (
          <div className="pb-3 flex flex-wrap gap-2">
            {CHANNEL_SORTS.map((s) => (
              <Button aria-pressed={serverSort === s.value} key={s.value} onClick={() => changeServerSort(s.value)}
                className="ios-filter-pill">{s.label}</Button>
            ))}
          </div>
        )}
        <div className="pb-3"><SourceSwitcher options={videoSourceOptions} value={effectiveChannelSourceId} onChange={setChannelSourceId} ariaLabel="视频数据源切换" /></div>
      </div>
      <div ref={scrollContainer} className="flex-1 scroll-y pt-3.5 pb-8" aria-busy={loading}>
        {items.length > 0 && replacing && <p role="status" className="mb-3 text-[12px] text-mut">{loading ? "正在更新，暂时保留上次结果…" : "当前显示上次结果，请重试以更新筛选。"}</p>}
        {items.length > 0 && err && <div role="status" className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-mut"><span>{err}</span><Button className="px-3 text-primary" onClick={() => void loadMore(replacing)}>重试</Button></div>}
        {items.length ? (
          <div inert={replacing || undefined} className={replacing ? "opacity-60" : undefined}>
            <Masonry videos={items} scopeKey={filterKey(serverSort, originalCate)} wide={wide} onOpen={(v, visible) => { if (!replacing) push({ kind: "feed", videoIds: visible.map((x) => x.id), index: visible.findIndex((x) => x.id === v.id), title: name }); }} />
          </div>
        ) : err ? (
          <Empty icon={<ChannelGlyph size={26} />} title="加载失败" sub={err} action="重试" onAction={() => void loadMore(true)} />
        ) : loading ? (
          <div className="flex justify-center py-10"><Loader className="w-8 h-8 spinner" /></div>
        ) : <Empty icon={<ChannelGlyph size={26} />} title="该筛选下暂无内容" sub="换个筛选试试" />}
        <div ref={sentinel} className="h-10" />
        {loading && items.length > 0 && <div className="flex justify-center py-3"><Loader className="w-6 h-6 spinner" /></div>}
        {!loading && !err && !replacing && page < pages && <Button onClick={() => void loadMore()} className="my-3 px-4 text-primary">加载更多</Button>}
        {!loading && !replacing && !err && page >= pages && items.length > 0 && (
          <div className="text-center text-[12px] text-dim py-3">— 已经到底啦 —</div>
        )}
      </div>
      {searching && <InplaceSearch kind="video" scope={cate === "original" ? "original" : undefined} wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list, kw) => push({ kind: "feed", videoIds: list.map((x) => x.id), index: list.findIndex((x) => x.id === v.id), title: kw ? `搜索 · ${kw}` : `搜索 · ${name}` })} />}
    </div>
  );
}
