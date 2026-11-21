import { Button } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../../shared/api/api";
import type { VideoCard } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { Masonry } from "../../shared/ui/cards";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { CollectionLink, CollectionLinks } from "../../shared/ui/CollectionLink";
import { InplaceSearch } from "../search/InplaceSearch";
import { withRequestTimeout } from "../../shared/lib/withTimeout";
import { dedupedIncoming } from "../../shared/lib/dedup";
import { traceFeed } from "../../shared/lib/feedTrace";

/* 资料库作用域常量已删（fix336/ui-fixes）：它在本地的唯一消费
 * 者是已删的归类补判钩子 key 前缀；作用域口径本身在
 * localLibrary 与各消费面不变。 */
import { Empty } from "../../shared/ui/ui";
import { IAward, IBack, IChevR, IFilm, IFlame, IGrid, ILayers, ISearch, ITag, ITrophy } from "../../shared/ui/icons";
import { getBuiltinRegistry, sourcesForCategory, sourcesForChannel } from "../sources/registry";
import { getActiveRegistry } from "../sources/manifest";
import { SourcePendingNotice, SourceSwitcher, sourceOptionsForCategory, sourceOptionsForChannel } from "../sources/SourceSwitcher";
import { getSourceLastViewed } from "../sources/healthCheck";
import { useSourceSelfCheckOnShow } from "../sources/sourceHealth";
import { isNativeSource, nativeSourceId, sourcesForSurface } from "../sources/surfaces";
import SourceBrowse from "../sources/SourceBrowse";
import SourceGallery from "../sources/SourceGallery";
import { defaultSourceId, resolveSelectedSource } from "../sources/selectedSource";

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

/* ── 归类补判钩子已删（Muse 2026-11-20 fix336/ui-fixes）：它在
 * 本文件的唯一消费者是「视频」频道原生列表的渲染期品类分组
 * （partitionCardsByResolvedKind 只入已确认 video 组）；原生视频
 * 空壳 chip 退场后原生列表不再经本页呈现，分组与补判整链成为
 * 死代码一并移除。搜索面的同名补判是独立实现（Search.tsx /
 * useSearchResults），不受影响。 ── */

/* ================= 分类总览 =================
 * 索引化（Muse 2026-11-20 fix335/e-category，设计
 * fix335/design-category-hub.md 方案②，用户真机反馈「分类页纵深
 * 过大、样式不统一」）：总览回归纯索引——预览全部收进频道内页，
 * 每频道一行统一索引行（OverviewIndexRow），点按 1 次到达内页；
 * 四区名单一律改读 surfaces 派生（sourcesForSurface），不再本地
 * 拼装。总览只回答「有哪些频道/源、状态如何」，内容归内页。
 * 纵深：现行计数 ≈1.0 屏、注册表全启用 ≈1.5 屏封顶（旧形态
 * ≈3.6 屏），量取口径见设计 §1/§3。
 *
 * 频道行收敛（Muse 2026-11-20 fix336/ui-fixes，用户亲定「短剧
 * 视频都是折叠的 你图片反而是这么露出来的」）：总览只留频道行
 * ——短剧/视频/吃瓜/图片四行，行集由 overviewRows 单一数组派
 * 生、页头计数＝行数（恒 4），不再有手算偏移；图片/视频源行整
 * 区退场，源一律进频道内页以 chips 切（图片→ChannelPage 的
 * cate="image" 频道分支、视频→视频频道切换器），源状态徽标随
 * chips 的 healthCheck 单一派生呈现。总览纵深自此与注册表规模
 * 脱钩：页头＋四行＋专题/标签/排行榜入口即全部。 */
export default function Category({ wide, active }: { wide: boolean; active: boolean }) {
  void active; /* 索引为静态派生、无首开预览请求，active 不再门控加载 */
  const { push, setTab } = useStore();
  /* 注册表口径（Muse 2026-11-19 整改 D2）：读 active 表（远程清单
   * 覆盖生效），hg:registry-changed 后刷新；不再读内置表。 */
  const [, setRegistryTick] = useState(0);
  useEffect(() => {
    const onRegistry = () => setRegistryTick((t) => t + 1);
    window.addEventListener("hg:registry-changed", onRegistry);
    return () => window.removeEventListener("hg:registry-changed", onRegistry);
  }, []);
  const activeSources = getActiveRegistry().sources;
  /* 吃瓜补探名单仍读 surfaces 派生（overview-posts 面，与
   * routeForSurface 互为一致）：索引化后吃瓜的 show-batch 靠本面
   * 索引行渲染处同钩子同口径批量补探（fix333/selfcheck-trigger
   * 落点不变）。图片/视频源的补探随源行退场迁往各频道页的切换
   * 器——SourceSwitcher 挂载即对本面选项批量补探，channel-image/
   * channel-video 两面的 topUp 声明同为 show-batch（fix334-
   * surfaces 契约对账）。 */
  const postsRowSources = sourcesForSurface("overview-posts", activeSources);
  useSourceSelfCheckOnShow(postsRowSources);
  /* 频道行集（fix336/ui-fixes 单一派生）：四行写死在此一处——
   * 短剧/视频来自 CHANNELS、吃瓜与图片为固定行；页头计数直接
   * 读行集长度（恒 4），行增减只改此数组、不再有第二处计数。 */
  const overviewRows: { key: string; title: string; icon: ReactNode; onClick: () => void }[] = [
    ...CHANNELS.map((c) => {
      const ChannelIcon = c.Icon;
      return {
        key: c.cate,
        title: c.name,
        icon: <ChannelIcon size={18} strokeWidth={1.9} />,
        onClick: () => push({ kind: "channel", cate: c.cate, name: c.name }),
      };
    }),
    {
      key: "posts",
      title: "吃瓜",
      icon: <IFlame size={18} strokeWidth={1.9} />,
      onClick: () => push({ kind: "posts" }),
    },
    {
      key: "image",
      title: "图片",
      icon: <IGrid size={18} strokeWidth={1.9} />,
      onClick: () => push({ kind: "channel", cate: "image", name: "图片" }),
    },
  ];
  const sectionCount = overviewRows.length;

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
          <span className="text-[12px] text-mut">{sectionCount} 个频道</span>
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

        {/* 频道索引行（fix336/ui-fixes 后总览全部内容行）：四行
            由 overviewRows 单一数组渲染——短剧/视频/图片进
            ChannelPage（图片为 cate="image" 频道分支、页内 chips
            切源）、吃瓜进 PostsPage；总览不再有源行区，源列示
            出处迁频道内页切换器与深链（cate="image:<id>"/
            "video:<id>" 分支保留、资料库回访照常）。 */}
        <section aria-label="频道" className="mb-5 a-rise">
          <div className="flex flex-col gap-2">
            {overviewRows.map((r) => (
              <OverviewIndexRow key={r.key} title={r.title} icon={r.icon} onClick={r.onClick} />
            ))}
          </div>
        </section>

        <div className="text-center text-[12px] text-dim pt-1">— 已展示全部频道 —</div>
      </div>
      {wide && <div />}
    </div>
  );
}

/* 总览统一索引行（fix335/e-category 定版、fix336/ui-fixes 收敛）：
 * 总览只剩频道行后行组件只剩图标＋标题两槽（源行的状态徽标槽随
 * 源行退场删除，徽标口径迁频道页 chips）；行高/底色/字号全行
 * 一致，点按一律进频道内页。 */
function OverviewIndexRow({ icon, title, onClick }: {
  icon?: ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <Button onClick={onClick}
      className="w-full flex items-center gap-3 rounded-[16px] bg-s2 px-4 py-3 text-left pressable">
      {icon && <span className="w-6 shrink-0 flex items-center justify-center text-mut">{icon}</span>}
      <span className="flex-1 min-w-0 truncate text-[14px] font-medium text-on">{title}</span>
      <IChevR size={14} />
    </Button>
  );
}

/* ================= 频道详情页 ================= */
const CHANNEL_SORTS = [
  { value: "latest", label: "最近更新" },
  { value: "hot_window", label: "当前热播" },
  { value: "random", label: "精选推荐" },
] as const;

/* 「视频」频道（cate="original"）原生子筛已删（Muse 2026-11-20
 * fix336/ui-fixes）：ORIGINAL_CATES/originalSort 只服务原生视频
 * 列表，原生空壳 chip 退场后该列表不再经本页呈现，子筛与排序
 * 映射随之移除；原生短剧/吃瓜面不经此常量、不受影响。 */

export function ChannelPage({ cate, name, onBack, wide, openExternalId, openExternalEp }: {
  cate: string; name: string; onBack: () => void; wide: boolean;
  /** G4 回访直达（fix334/L3）：透传给深链分支的浏览组件。 */
  openExternalId?: string;
  /** 续播到集（fix334 清扫已坏-2）：历史回访带入的集序位，只透
   * 传给视频分支的 SourceBrowse（图集无集数概念、不消费）。 */
  openExternalEp?: number;
}) {
  const { push, lineEpoch } = useStore();
  const { preferences } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const [searching, setSearching] = useState(false);
  /* 原生源引用收敛（fix335/e-category）：原生选项与回落值一律经
   * surfaces 的 nativeSourceId 派生、显示名读注册表 def，不再写
   * id 字面量（原生判定仍以 isNativeSource 模板判据为准）。 */
  const nativeId = nativeSourceId();
  const nativeLabel = getBuiltinRegistry().find((d) => d.id === nativeId)?.displayName ?? "黄果";
  /* 频道初始落点（Muse 2026-11-20 fix336/ui-fixes）：
   * - 视频频道（original）：原生空壳 chip 已退场，初始值只在外
   *   部视频源里按既有记忆口径定（defaultSourceId：最近打开优
   *   先、无记忆落首个可用外部源）；无外部源时暂填原生 id 占
   *   位，下方空名单分支落诚实空态、不渲染原生列表。
   * - 短剧频道（ai-duanju）：原生为唯一映射源，初始仍为原生。
   * - 图片频道（cate="image"，本函数下方的频道分支）：同视频口
   *   径，在已启用图片源里按记忆/首源定初始值。 */
  const [channelSourceId, setChannelSourceId] = useState<string>(() =>
    cate === "original"
      ? defaultSourceId(sourcesForChannel("original", getActiveRegistry().sources), getSourceLastViewed()) ?? nativeId
      : nativeId);
  const [imageChannelSourceId, setImageChannelSourceId] = useState<string>(() =>
    defaultSourceId(sourcesForCategory("image", getActiveRegistry().sources), getSourceLastViewed()) ?? "");
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
   * 回落本频道默认源，不跨频道生效。
   * fix336/ui-fixes 改落点：视频频道（original）的名单不再含原
   * 生选项（空壳 chip 退场），回落＝名单首个（外部源）；短剧频
   * 道名单仍以原生打头、回落原生（名单首位即原生，口径统一为
   * 「名单内用选择、名单外落首位」）。 */
  const videoSourceOptions = cate === "original"
    ? sourceOptionsForChannel(cate)
    : [{ id: nativeId, label: nativeLabel }, ...sourceOptionsForChannel(cate)];
  const effectiveChannelSourceId = videoSourceOptions.some((o) => o.id === channelSourceId)
    ? channelSourceId
    : (videoSourceOptions[0]?.id ?? nativeId);
  /* 选中态校验（fix333-P2）：与 effective 回落同口径的派生——effective
   * 已保证 id 在切源片内时 channelSource 必在位，此处只为统一页头/
   * 提示的 label 口径，不再 `?? id`；若将来回落口径变化，停用态仍
   * 落停用分支而非「尚未接通」。 */
  const channelSelected = resolveSelectedSource(
    effectiveChannelSourceId,
    sourcesForChannel(cate, getActiveRegistry().sources),
  );
  const channelSource = channelSelected.kind === "active" ? channelSelected.def : undefined;
  /* 外部视频详情开合（Muse 2026-11-20 fix331/covers-header）：SourceBrowse
   * 详情自带页头，打开时本页外层页头让位（问题②双层标题栏）；频道/
   * 切源变化时复位，避免残留隐藏态把列表页头吞掉。 */
  const [browseDetailOpen, setBrowseDetailOpen] = useState(false);
  useEffect(() => { setBrowseDetailOpen(false); }, [cate, effectiveChannelSourceId]);
  const [serverSort, setServerSort] = useState<(typeof CHANNEL_SORTS)[number]["value"]>("latest");
  /* 原始页落座（Muse 2026-11-19 fix330/ui-fixes，
   * device-verdict-322 #10）：incoming 不预过滤先落座，分页只受
   * 接口速度与 pages 约束——旧实现把过滤/补判 await 进 loadMore
   * 会把分页堵住、整页待判时持续转圈无终态。原「视频」频道的渲
   * 染期品类分组（partitionCardsByResolvedKind）已随原生视频空
   * 壳退场删除（fix336/ui-fixes）：本状态自此只服务短剧频道的
   * 原生列表，items＝原始条目直出。 */
  const [rawPages, setRawPages] = useState<VideoCard[][]>([]);
  const rawItems = rawPages.flat();
  const items = rawItems;
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const filterKey = (sort: string) => `${cate}:${sort}`;
  const [displayedFilter, setDisplayedFilter] = useState(() => filterKey("latest"));
  const [err, setErr] = useState<string | null>(null);
  const busy = useRef(false);
  const requestSeq = useRef(0);
  const lastFailAt = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const scrollContainer = useRef<HTMLDivElement>(null);
  /* 外部源三分支的宿主 scroller（fix335/d-scroll）：下传给
   * SourceGallery/SourceBrowse 供滚动恢复 hook 读写——三分支各自
   * 独立 ref（同一时刻只挂一个分支，互不串扰）。 */
  const imageScroller = useRef<HTMLDivElement>(null);
  const videoScroller = useRef<HTMLDivElement>(null);
  const channelScroller = useRef<HTMLDivElement>(null);
  const imageChannelScroller = useRef<HTMLDivElement>(null);

  const loadMore = async (reset = false, sortOverride: string = serverSort) => {
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
      /* 取数口径（fix336/ui-fixes 后）：本函数只服务短剧频道的原
       * 生列表（视频频道走外部源分支、图片频道走 SourceGallery，
       * 都不经此），一律走 category 接口；原「视频」频道的原生
       * 视频接口专属臂随空壳退场删除。 */
      const res = await withRequestTimeout(api.category(cate, next, 20, sortOverride));
      if (seq !== requestSeq.current) return;
      const pageRaw = res?.items || [];
      setRawPages((prev) => {
        const base = reset ? [] : prev;
        /* rawPages 是原始分页数组：新页 = 相对全部已加载原始页去重
         * 后的本页原始条目（dedupedIncoming 与 appendDeduped 同一
         * 实现，页内重复同步入 seen）。 */
        return [...base, dedupedIncoming(base.flat(), pageRaw, (x) => x.id)];
      });
      setDisplayedFilter(filterKey(sortOverride));
      setPage(next);
      /* 终止只认接口 pages；缺失时仅空页才推断到尾（旧 `|| next`
       * 在接口偶发缺 pages 时把总页数钉死在当前页、提前终止）。
       * reset（换筛选/重拉）时页数基线归 1（fix2.1 整改，GPT 四审
       * #10）：旧写法拿旧筛选的 pages 与 next 取 max，响应缺 pages
       * 时新筛选继承旧总页数、状态行页数与可翻页判断双双失真。 */
      setPages(res?.pagination?.pages ?? ((res?.items?.length ?? 0) > 0 ? Math.max(reset ? 1 : pages, next) : next));
      setErr(null);
      traceFeed("page.success", { list: `channel:${cate}`, page: next, received: pageRaw.length, pages: res?.pagination?.pages ?? null, ms: Date.now() - startedAt });
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
    /* 图片源页（cate="image:<id>"）与视频源页（cate="video:<id>"）
     * 不走黄果频道接口，数据由 SourceGallery/SourceBrowse 经适配
     * 器供给，本 effect 直接跳过。图片频道（cate="image"）与视频
     * 频道（cate="original"）同理：前者走 SourceGallery、后者只
     * 剩外部源分支走 SourceBrowse，原生列表状态不消费、一并跳
     * 过（fix336/ui-fixes）。 */
    if (cate.startsWith("image:") || cate.startsWith("video:") || cate === "image" || cate === "original") return;
    setRawPages([]); setPage(0); setPages(1);
    setServerSort("latest"); setSearching(false);
    void loadMore(true, "latest");
    return () => { requestSeq.current++; busy.current = false; };
    /* eslint-disable-next-line */
  }, [cate, lineEpoch]);
  /* 归类补判触发 effect 已删（fix336/ui-fixes）：它只为原生视频
   * 列表的渲染期分组取 Detail 信号，分组随空壳退场后无消费者。 */
  const filterPending = displayedFilter !== filterKey(serverSort);
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
   * cate="image:<源id>" 为图片单源深链的入口约定（复用既有
   * channel 栈页与 push/pop，不新增路由 kind；原总览图片行入
   * 口已于 fix336/ui-fixes 退场，本深链保留供资料库回访等寻址
   * 场景，与上方 cate="image" 频道页分工）。blocked 源维持
   * 既有诚实提示页、不拉数据；其余经 SourceGallery 走适配器。 */
  const imageSourceId = cate.startsWith("image:") ? cate.slice("image:".length) : null;
  /* 选中态校验（fix333-P2）：深链源 id 同样校验，停用源落停用口径
   * 而非强制 "blocked" 的错因分支；页头一律读 label。 */
  const imageSelected = imageSourceId
    ? resolveSelectedSource(
        imageSourceId,
        sourcesForCategory("image", getActiveRegistry().sources),
      )
    : undefined;
  const imageSource = imageSelected?.kind === "active" ? imageSelected.def : undefined;
  /* 图片频道页（Muse 2026-11-20 fix336/ui-fixes，用户亲定分类
   * 逻辑）：cate="image"（无冒号后缀）为总览图片行的入口约定——
   * 与 image:<id> 深链页分工：深链是寻址单源（资料库回访等），
   * 频道页是带切源 chips 的频道面（与视频频道/吃瓜页同构）。
   * 名单＝已启用图片源（surfaces 的 channel-image 面同源），
   * 默认落点按 defaultSourceId 记忆口径（最近打开优先、无记
   * 忆落首个可用源）；blocked 源留在 chips 上挂健康徽标（切换
   * 器单一派生）、点开落诚实提示，不拉数据。 */
  if (cate === "image") {
    const imageOptions = sourceOptionsForCategory("image");
    const imageDefs = sourcesForCategory("image", getActiveRegistry().sources);
    const effectiveImageSourceId = imageOptions.some((o) => o.id === imageChannelSourceId)
      ? imageChannelSourceId
      : imageDefs[0]?.id;
    const imageChannelSelected = effectiveImageSourceId
      ? resolveSelectedSource(effectiveImageSourceId, imageDefs)
      : undefined;
    const imageChannelSource = imageChannelSelected?.kind === "active" ? imageChannelSelected.def : undefined;
    return (
      <div className="ios-page absolute inset-0 bg-bg flex flex-col">
        <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
          <div className="ios-subpage-bar">
            <Button aria-label="返回" onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
            <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0"><IGrid size={18} strokeWidth={1.9} /></span>
            <div className="flex-1 min-w-0">
              <h1 className="text-[17px] font-bold text-on leading-tight truncate">{name}</h1>
              <div role="status" className="text-[12px] text-mut leading-tight mt-0.5">数据源：{imageChannelSelected?.label ?? ""}</div>
            </div>
          </div>
          <div className="pb-3"><SourceSwitcher options={imageOptions} value={effectiveImageSourceId ?? ""} onChange={setImageChannelSourceId} ariaLabel="图片数据源切换" /></div>
        </div>
        <div ref={imageChannelScroller} className="flex-1 scroll-y pb-8">
          {!imageChannelSelected ? (
            <Empty icon={<IGrid size={26} />} title="暂无可用图片源" sub="当前没有已启用的图片源" />
          ) : !imageChannelSource || imageChannelSource.maturity === "blocked" ? (
            <SourcePendingNotice displayName={imageChannelSelected.label} maturity={imageChannelSource?.maturity} note={imageChannelSource?.note} selectedKind={imageChannelSelected.kind} />
          ) : (
            <SourceGallery def={imageChannelSource} openExternalId={openExternalId} scrollerRef={imageChannelScroller} />
          )}
        </div>
      </div>
    );
  }
  if (imageSourceId) {
    return (
      <div className="ios-page absolute inset-0 bg-bg flex flex-col">
        <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
          <div className="ios-subpage-bar">
            <Button aria-label="返回" onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
            <div className="flex-1 min-w-0">
              <h1 className="text-[17px] font-bold text-on leading-tight truncate">{name}</h1>
              <div role="status" className="text-[12px] text-mut leading-tight mt-0.5">图片 · 数据源：{imageSelected?.label ?? ""}</div>
            </div>
          </div>
        </div>
        <div ref={imageScroller} className="flex-1 scroll-y pb-8">
          {!imageSource || imageSource.maturity === "blocked" ? (
            <SourcePendingNotice displayName={imageSelected?.label ?? name} maturity={imageSource?.maturity} note={imageSource?.note} selectedKind={imageSelected?.kind} />
          ) : (
            <SourceGallery def={imageSource} openExternalId={openExternalId} scrollerRef={imageScroller} />
          )}
        </div>
      </div>
    );
  }
  /* 视频源页（Muse 2026-11-19 fix330-riban-surfaces）：cate=
   * "video:<源id>" 为视频单源深链的入口约定（与 image: 同构、
   * 复用既有 channel 栈页，不新增路由 kind；原总览「视频源」
   * 分区入口已于 fix336/ui-fixes 退场，本深链保留供资料库回访
   * 等寻址场景）。源不在 active 注册表（如清单覆盖后停用）或
   * blocked 时维持诚实提示页、不拉数据；其余经 SourceBrowse
   * 走适配器真取数。 */
  const videoSourceId = cate.startsWith("video:") ? cate.slice("video:".length) : null;
  /* 选中态校验（fix333-P2）：与图片深链页同口径。 */
  const videoSelected = videoSourceId
    ? resolveSelectedSource(
        videoSourceId,
        sourcesForCategory("video", getActiveRegistry().sources),
      )
    : undefined;
  const videoSource = videoSelected?.kind === "active" ? videoSelected.def : undefined;
  if (videoSourceId) {
    return (
      <div className="ios-page absolute inset-0 bg-bg flex flex-col">
        {!browseDetailOpen && (
          <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
            <div className="ios-subpage-bar">
              <Button aria-label="返回" onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
              <div className="flex-1 min-w-0">
                <h1 className="text-[17px] font-bold text-on leading-tight truncate">{name}</h1>
                <div role="status" className="text-[12px] text-mut leading-tight mt-0.5">视频 · 数据源：{videoSelected?.label ?? ""}</div>
              </div>
            </div>
          </div>
        )}
        <div ref={videoScroller} className="flex-1 scroll-y pb-8">
          {!videoSource || videoSource.maturity === "blocked" ? (
            <SourcePendingNotice displayName={videoSelected?.label ?? name} maturity={videoSource?.maturity} note={videoSource?.note} selectedKind={videoSelected?.kind} />
          ) : (
            <SourceBrowse def={videoSource} onDetailOpenChange={setBrowseDetailOpen} openExternalId={openExternalId} openExternalEp={openExternalEp} scrollerRef={videoScroller} />
          )}
        </div>
      </div>
    );
  }
  /* 视频频道无外部源（fix336/ui-fixes）：名单为空时落诚实空态
   * ——原生空壳已退场，不许回落原生列表冒充频道内容。 */
  if (cate === "original" && videoSourceOptions.length === 0) {
    return (
      <div className="ios-page absolute inset-0 bg-bg flex flex-col">
        <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
          <div className="ios-subpage-bar">
            <Button aria-label="返回" onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
            <div className="flex-1 min-w-0">
              <h1 className="text-[17px] font-bold text-on leading-tight truncate">{name}</h1>
              <div role="status" className="text-[12px] text-mut leading-tight mt-0.5">暂无可用视频源</div>
            </div>
          </div>
        </div>
        <div className="flex-1 scroll-y pb-8">
          <Empty icon={<IAward size={26} />} title="暂无可用视频源" sub="当前没有已启用的外部视频源" />
        </div>
      </div>
    );
  }
  /* 外部视频源（Muse 2026-11-19 最终版 D 线，①用户点名＋②实锤
   * createAdapter 生产调用为 0）：blocked 维持既有诚实提示页；
   * 其余（stable/probe）经 SourceBrowse 走适配器真取数，失败错误
   * 态＋重试，不回落黄果数据冒充。fix336/ui-fixes 后视频频道
   * （original）恒走本分支（原生选项已退场）；短剧频道选到外部
   * 映射源时同走本分支。 */
  if (cate === "original" || effectiveChannelSourceId !== nativeId) {
    return (
      <div className="ios-page absolute inset-0 bg-bg flex flex-col">
        {!browseDetailOpen && (
          <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
            <div className="ios-subpage-bar">
              <Button aria-label="返回" onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
              <div className="flex-1 min-w-0">
                <h1 className="text-[17px] font-bold text-on leading-tight truncate">{name}</h1>
                <div role="status" className="text-[12px] text-mut leading-tight mt-0.5">数据源：{channelSelected.label}</div>
              </div>
            </div>
            <div className="pb-3"><SourceSwitcher options={videoSourceOptions} value={effectiveChannelSourceId} onChange={setChannelSourceId} ariaLabel="视频数据源切换" /></div>
          </div>
        )}
        <div ref={channelScroller} className="flex-1 scroll-y pb-8">
          {!channelSource || channelSource.maturity === "blocked" ? (
            <SourcePendingNotice displayName={channelSelected.label} maturity={channelSource?.maturity} note={channelSource?.note} selectedKind={channelSelected.kind} />
          ) : (
            <SourceBrowse def={channelSource} onDetailOpenChange={setBrowseDetailOpen} scrollerRef={channelScroller} />
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
          <Button onClick={() => setSearching(true)} aria-label="搜索短剧" className="ios-nav-btn"><ISearch size={18} /></Button>
        </div>
        {/* 本分支自 fix336/ui-fixes 起只服务短剧频道（视频频道恒
            走外部源分支），排序片与切源片无条件渲染。 */}
        <div className="pb-3 flex flex-wrap gap-2">
          {CHANNEL_SORTS.map((s) => (
            <Button aria-pressed={serverSort === s.value} key={s.value} onClick={() => changeServerSort(s.value)}
              className="ios-filter-pill">{s.label}</Button>
          ))}
        </div>
        <div className="pb-3"><SourceSwitcher options={videoSourceOptions} value={effectiveChannelSourceId} onChange={setChannelSourceId} ariaLabel="视频数据源切换" /></div>
      </div>
      <div ref={scrollContainer} className="flex-1 scroll-y pt-3.5 pb-8" aria-busy={loading}>
        {items.length > 0 && replacing && <p role="status" className="mb-3 text-[12px] text-mut">{loading ? "正在更新，暂时保留上次结果…" : "当前显示上次结果，请重试以更新筛选。"}</p>}
        {items.length > 0 && err && <div role="status" className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-mut"><span>{err}</span><Button className="px-3 text-primary" onClick={() => void loadMore(replacing)}>重试</Button></div>}
        {items.length ? (
          <div inert={replacing || undefined} className={replacing ? "opacity-60" : undefined}>
            <Masonry videos={items} scopeKey={filterKey(serverSort)} wide={wide} onOpen={(v, visible) => { if (!replacing) push({ kind: "feed", videoIds: visible.map((x) => x.id), index: visible.findIndex((x) => x.id === v.id), title: name }); }} />
          </div>
        ) : err ? (
          <Empty icon={<ChannelGlyph size={26} />} title="加载失败" sub={err} action="重试" onAction={() => void loadMore(true)} />
        ) : loading ? (
          <div className="flex justify-center py-10"><Loader className="w-8 h-8 spinner" /></div>
        ) : page < pages ? (
          /* 呈现为空但服务端页未耗尽：哨兵（下方）在视口内会继续
           * 翻页，此处转圈表示「仍在翻页」，有终点兜底。原「视频」
           * 频道的确认门诚实终态已随原生空壳退场删除
           * （fix336/ui-fixes）——该终态只服务恒空的原生视频列
           * 表，频道改走外部源后不存在此呈现。 */
          <div className="flex justify-center py-10"><Loader className="w-8 h-8 spinner" /></div>
        ) : <Empty icon={<ChannelGlyph size={26} />} title="该筛选下暂无内容" sub="换个筛选试试" />}
        <div ref={sentinel} className="h-10" />
        {loading && items.length > 0 && <div className="flex justify-center py-3"><Loader className="w-6 h-6 spinner" /></div>}
        {!loading && !err && !replacing && page < pages && <Button onClick={() => void loadMore()} className="my-3 px-4 text-primary">加载更多</Button>}
        {!loading && !replacing && !err && page >= pages && items.length > 0 && (
          <div className="text-center text-[12px] text-dim py-3">— 已经到底啦 —</div>
        )}
      </div>
      {/* scope="original" 入口已删（fix336/ui-fixes）：本分支只剩
          短剧频道，站内搜索恒走缺省（短剧）口径；InplaceSearch 的
          scope 通道本身保留（组件契约不变）。 */}
      {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list, kw) => push({ kind: "feed", videoIds: list.map((x) => x.id), index: list.findIndex((x) => x.id === v.id), title: kw ? `搜索 · ${kw}` : `搜索 · ${name}` })} />}
    </div>
  );
}
