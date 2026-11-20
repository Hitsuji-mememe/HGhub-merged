import { MediaCard } from "../../shared/ui/cards";
import { Button, Surface } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, cover, fmt, isMobile } from "../../shared/api/api";
import type { Post } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { LOCAL_SCOPE } from "../../shared/model/localLibrary";
import { copyText } from "../../shared/lib/clipboard";
import { Empty, Img, Sheet } from "../../shared/ui/ui";
import { Player } from "../playback";
import { IBack, IFireF, IFlame, IHeart, IHeartF, IPlayF, ISearch, IStar, IStarF } from "../../shared/ui/icons";
import { handleArticleClick, sanitizeHtml } from "../../shared/lib/html";
import { InplaceSearch } from "../search/InplaceSearch";
import { FilteredContent } from "../../shared/ui/FilteredContent";
import { TagBlockMenu } from "../../shared/ui/TagBlockMenu";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { usePaginatedList } from "../../shared/lib/usePaginatedList";
import { firstEnabledSource, sourcesForCategory } from "../sources/registry";
import { getActiveRegistry } from "../sources/manifest";
import { resolvePostsBrowse } from "../sources/postsRoute";
import { resolveSelectedSource } from "../sources/selectedSource";
import SourcePosts from "../sources/SourcePosts";
import { SourcePendingNotice, SourceSwitcher, sourceOptionsForCategory } from "../sources/SourceSwitcher";
import { postHot } from "./postData";
import { tracePlayback } from "../../shared/diagnostics/playbackDiagnostics";

/* 资料库作用域（账号体系拆除后恒定）：请求代次键的前缀成分。 */
const scope = LOCAL_SCOPE;

/* 导航重置判定（Muse 2026-11-19 3.2.1修复F9线）：只有帖子 id 真变化
 * （新导航）才许整页重置（跳顶/清播放/清分段）；lineEpoch/scope
 * 是线路与账号代次，与换帖无关——旧实现把两者绑在同一 effect 上，
 * 播放期线路 epoch 一变就跳顶并撕掉正在播的 Player（用户实报两症状）。 */
export const shouldResetPostForNav = (prevId: number | null, id: number): boolean => prevId !== id;

/* ================= 吃瓜列表 ================= */
export function PostsPage({ onBack, wide, initialSourceId, openExternalId }: {
  onBack: () => void; wide: boolean;
  /** G4 回访直达（fix334/L3）：资料库点开外部帖子收藏时指定初始
   * 源（缺省仍走第一顺位 enabled 源的既有口径）；源已停用/下线时
   * 选中态三态照常落诚实提示，不白屏。 */
  initialSourceId?: string;
  openExternalId?: string;
}) {
  const { push, lineEpoch } = useStore();
  const [searching, setSearching] = useState(false);
  /* 源切换（根治包多源线条目5）：默认吃瓜分类第一顺位 enabled 源；
   * 切换即整页换源、源间不混排。非黄果源按 resolvePostsBrowse
   * 分流（3.3.0 接通批）：blocked 出诚实提示（SourcePendingNotice、
   * 不拉数据），其余经 SourcePosts 走适配器真实渲染，不混入黄果
   * 数据。此前本页对一切非黄果源无条件提示、适配器从未被调用，
   * 是黑料网等已启用源点开仍是提示页的根因（见 postsRoute.ts）。 */
  /* 注册表口径（Muse 2026-11-19 整改 D2）：读 active 表（远程清单
   * 覆盖生效），hg:registry-changed 后刷新；不再读内置表。 */
  const [, setRegistryTick] = useState(0);
  useEffect(() => {
    const onRegistry = () => setRegistryTick((t) => t + 1);
    window.addEventListener("hg:registry-changed", onRegistry);
    return () => window.removeEventListener("hg:registry-changed", onRegistry);
  }, []);
  const postSourceOptions = sourceOptionsForCategory("posts");
  const [sourceId, setSourceId] = useState(() => initialSourceId ?? firstEnabledSource("posts", getActiveRegistry().sources)?.id ?? "huangguo");
  const isNativeSource = sourceId === "huangguo";
  /* 选中态校验（fix333-P2，G5）：选中源不在 active 表时不再以
   * undefined 落通用提示——三态经 resolveSelectedSource 唯一派生，
   * 页头与提示一律读 label，内部 id 永不进文案。 */
  const selectedSource = resolveSelectedSource(
    sourceId,
    sourcesForCategory("posts", getActiveRegistry().sources),
  );
  const activeSource = selectedSource.kind === "active" ? selectedSource.def : undefined;
  const { items, page, pages, loading, err, loadMore, scroller: scrollRef, sentinel } = usePaginatedList<Post>({
    enabled: isNativeSource,
    resetKey: `${lineEpoch}:${sourceId}`,
    listId: "posts:remen-chigua",
    rootMargin: "240px",
    getId: (item) => item.id,
    request: (next) => api.postCategory("remen-chigua", next, 20, "latest"),
  });

  if (!isNativeSource) {
    const postsRoute = resolvePostsBrowse(activeSource);
    return (
      <div className="ios-page absolute inset-0 bg-bg flex flex-col">
        <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
          <div className="ios-subpage-bar">
            <Button aria-label="返回" onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
            <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0"><IFlame size={18} strokeWidth={1.9} /></span>
            <div className="flex-1 min-w-0">
              <h1 className="text-[17px] font-bold text-on leading-tight">吃瓜</h1>
              <div role="status" className="text-[12px] text-mut leading-tight mt-0.5">数据源：{selectedSource.label}</div>
            </div>
          </div>
          <div className="px-4 pb-2"><SourceSwitcher options={postSourceOptions} value={sourceId} onChange={setSourceId} ariaLabel="吃瓜数据源切换" /></div>
        </div>
        <div className="flex-1 scroll-y pb-8">
          {postsRoute === "browse" && activeSource ? (
            <SourcePosts def={activeSource} openExternalId={openExternalId} />
          ) : (
            <SourcePendingNotice displayName={selectedSource.label} maturity={activeSource?.maturity} note={activeSource?.note} selectedKind={selectedSource.kind} />
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
          <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0"><IFlame size={18} strokeWidth={1.9} /></span>
          <div className="flex-1 min-w-0">
            <h1 className="text-[17px] font-bold text-on leading-tight">吃瓜</h1>
            <div role="status" className="text-[12px] text-mut leading-tight mt-0.5">{loading && !items.length ? "加载中…" : `已加载 ${items.length} 篇 · ${Math.max(page, 1)}/${Math.max(pages, 1)} 页`}</div>
          </div>
          <Button onClick={() => setSearching(true)} aria-label="搜索吃瓜" className="ios-nav-btn"><ISearch size={18} /></Button>
        </div>
        <div className="px-4 pb-2"><SourceSwitcher options={postSourceOptions} value={sourceId} onChange={setSourceId} ariaLabel="吃瓜数据源切换" /></div>
      </div>
      <div ref={scrollRef} aria-busy={loading} className="flex-1 scroll-y pt-3.5 pb-8">
        {items.length ? (
          <FilteredContent items={items} scopeKey="posts">{visible => (
          <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
            {visible.map((p) => (
              <MediaCard key={p.id} title={p.title} cover={p.cover} surface="posts-native" subtitle={`${fmt(p.hot)} 次浏览`} onOpen={() => push({ kind: "post", id: p.id })} />
            ))}
          </div>
          )}</FilteredContent>
        ) : loading ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : err ? (
          <Empty icon={<IFireF size={26} />} title="吃瓜内容加载失败" sub={err} action="重试" onAction={() => loadMore(true)} />
        ) : (
          <Empty icon={<IFireF size={26} />} title="暂无吃瓜内容" />
        )}
        <div ref={sentinel} className="h-10" />
        {err && items.length > 0 && (
          <div className="flex flex-wrap items-center justify-center gap-3 py-2 text-[13px] text-danger" role="alert">
            <span>加载更多失败：{err}</span>
            <Button disabled={loading} onClick={() => loadMore()} className="text-primary pressable">重试</Button>
          </div>
        )}
        {!loading && !err && items.length > 0 && page < pages && <Button onClick={() => loadMore()} className="w-full mt-3">加载更多</Button>}
        {loading && items.length > 0 && <div className="flex justify-center py-2"><Loader className="w-6 h-6 spinner" /></div>}
      </div>
      {searching && <InplaceSearch kind="post" postLabel="吃瓜帖子" wide={wide} onClose={() => setSearching(false)} onOpenPost={(p) => push({ kind: "post", id: p.id })} />}
    </div>
  );
}

const isHtml = (s: string) => /<(p|div|br|img|h[1-6]|ul|ol|li|blockquote|span|strong|em)\b/i.test(s);
/* 过滤上游旧品牌标签，避免显示到界面。 */
const HIDDEN_POST_TAG = "\u9ec4\u679c";

/* ================= 吃瓜详情（网页式浏览） ================= */
export function PostDetail({ id, onBack, active = true }: { id: number; onBack: () => void; active?: boolean }) {
  const {
    toast, strictSecurity, muted, setMuted, volume, push, lineEpoch,
    isFav, setCollected, actionPending,
  } = useStore();
  const { preferences, blockReason } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const [post, setPost] = useState<(Post & { content?: string; video_url?: string }) | null>(null);
  const [loadedId, setLoadedId] = useState<number | null>(null);
  const autoBackKey = useRef("");
  const [tagMenu, setTagMenu] = useState(false);
  useEffect(() => { if (!active) { setTagMenu(false); } }, [active]);
  const currentPost = loadedId === id ? post : null;
  const blocked = filtering && currentPost ? blockReason(currentPost.tags) : null;
  const allowed = !filtering || (!!currentPost && !blocked);
  useEffect(() => {
    if (!active || !filtering || !currentPost || !blocked) {
      if (!blocked) autoBackKey.current = "";
      return;
    }
    const key = String(id);
    if (autoBackKey.current === key) return;
    autoBackKey.current = key;
    toast("该内容命中屏蔽标签，已自动返回", "info");
    onBack();
  }, [active, filtering, currentPost, blocked, id, onBack, toast]);
  useEffect(() => { if (!allowed) { setTagMenu(false); } }, [allowed]);
  const [err, setErr] = useState<string | null>(null);
  const [play, setPlay] = useState(false);
  /* 吃瓜帖详情里的 video_url 恒为空，视频地址只在 playback 接口里；
     不解析就整页只有图文（issue #11）。segs 是分段地址，多数帖只有 1 段。 */
  const [segs, setSegs] = useState<string[]>([]);
  const [seg, setSeg] = useState(0);
  const [resolving, setResolving] = useState(false);
  const [reload, setReload] = useState(0);
  const [mediaRetry, setMediaRetry] = useState(0);
  const [mediaError, setMediaError] = useState("");
  const [readProgress, setReadProgress] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const content = post?.content || "";
  const src = segs[seg] || "";
  const safeHtml = useMemo(() => sanitizeHtml(content), [content, strictSecurity]);
  const openSafeLink = (url: string) => {
    api.openUrl(url).catch(() => {
      copyText(url).then(() => toast("链接已复制", "ok")).catch(() => toast("复制失败", "info"));
    });
  };

  const navResetForRef = useRef<number | null>(null);
  const playRef = useRef(false);
  playRef.current = play;
  /* 点播瞬间滚动位置（F9 守卫）：封面 Button 卸载→Player 挂载的切换在
   * WKWebView 上可能因焦点元素消失回滚顶；play 翻真后一帧内漂移则恢复
   * 点击值，未漂移时为无操作。静默恢复，不抢焦点、不弹窗。 */
  const playScrollRef = useRef<number | null>(null);
  const restorePostScrollAfterPlay = () => {
    const el = scrollRef.current;
    const want = playScrollRef.current;
    if (!el || want == null) return;
    requestAnimationFrame(() => { if (Math.abs(el.scrollTop - want) > 2) el.scrollTop = want; });
  };
  useEffect(() => { if (play) restorePostScrollAfterPlay(); }, [play]);

  useEffect(() => {
    let alive = true;
    /* F9 分家：导航重置只认 id 变化；epoch/账号代次变化只刷新数据，
     * 滚动、播放态、分段全保留（分段由 playback effect 非空才替换）。
     * 判读埋点 post_detail.load：真机看 nav_reset/line_epoch/was_playing
     * 与 line.*、source.cleanup 的时序即可定责（见 evidence/f9）。 */
    const navReset = shouldResetPostForNav(navResetForRef.current, id);
    navResetForRef.current = id;
    tracePlayback("post_detail.load", { nav_reset: navReset, line_epoch: lineEpoch, was_playing: playRef.current, scroll_top: Math.round(scrollRef.current?.scrollTop ?? -1) });
    if (navReset) {
      setReadProgress(0);
      scrollRef.current?.scrollTo(0, 0);
      setPost(null);
      setLoadedId(null);
      setPlay(false);
      setSegs([]);
      setSeg(0);
    }
    setTagMenu(false);
    setErr(null);
    api.post(id)
      .then((p) => {
        if (!alive) return;
        setPost(p);
        setLoadedId(id);
        /* 旧接口返回直链时提供回退，不覆盖已经解析出的分段。
         * 帖内视频不默认播放（根治包多源线条目5）：只备好分段，
         * 展示封面/海报，用户点了才播——此处不 setPlay(true)。 */
        if (p.video_url) { setSegs(previous => previous.length ? previous : [p.video_url!]); }
      })
      .catch((e) => { if (alive) setErr((e as Error).message || "加载失败"); });
    return () => { alive = false; };
  }, [id, reload, lineEpoch, scope]);

  useEffect(() => {
    if (!allowed) { setResolving(false); return; }
    let alive = true;
    setResolving(true); setMediaError("");
    api.postPlayback(id)
      .then((r) => {
        if (!alive) return;
        const list = (r?.videos || []).map((v) => v?.url || "").filter(Boolean);
        /* 同上：解析完成只备分段、不自动开播（条目5），海报点击才 setPlay。 */
        if (list.length) { setSegs(list); }
      })
      .catch(e => { if (alive) setMediaError(e instanceof Error ? e.message : "视频解析失败"); })
      .finally(() => { if (alive) setResolving(false); });
    return () => { alive = false; };
  }, [id, reload, mediaRetry, allowed, lineEpoch, scope]);

  // Keep blocked content out of the surface while the host navigates back.
  if (currentPost && blocked) return <div className="absolute inset-0 flex items-center justify-center bg-bg" aria-label="正在返回">
    <Loader className="w-8 h-8 spinner" />
  </div>;

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-subpage-header shrink-0" style={{ paddingTop: isMobile ? "var(--sat, 0px)" : 0 }}>
        <div className="ios-subpage-bar">
          <Button aria-label="返回" onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
          <span className="text-[16px] font-bold text-on">吃瓜详情</span>
          <Button disabled={!currentPost} onClick={() => { if (active && allowed) setTagMenu(true); }} className="ml-auto -mr-2 px-2.5 min-h-9 inline-flex items-center justify-end text-[13px] font-medium text-primary">不感兴趣</Button>
        </div>
      </div>

      <div role="progressbar" aria-label="阅读进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={readProgress} className="h-1 shrink-0 bg-s3 overflow-hidden"><div className="h-full bg-primary" style={{ width: `${readProgress}%` }} /></div>
      <div ref={scrollRef} data-post-scroll className="flex-1 scroll-y pb-8 !px-0" onScroll={event => {
        const el = event.currentTarget;
        const range = el.scrollHeight - el.clientHeight;
        setReadProgress(range > 0 ? Math.round(el.scrollTop / range * 100) : 100);
      }}>
        {err ? (
          <Empty icon={<IFireF size={26} />} title="加载失败" sub={err} action="重试" onAction={() => setReload(n => n + 1)} />
        ) : !currentPost ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : (
          <>
            <div className="px-4 pt-3.5 mx-auto max-w-[800px] select-text">
              <h1 className="text-[17px] font-bold text-on leading-snug">{currentPost.title}</h1>
              <div className="flex items-center gap-2 mt-2 text-[12px] text-mut">
                <span>{currentPost.publish_time || currentPost.created_at}</span>
                <span className="flex items-center gap-1"><IFireF size={10} />{fmt(postHot(currentPost))}</span>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2.5">
                {(currentPost.tags || []).filter((t) => !t.includes(HIDDEN_POST_TAG)).slice(0, 8).map((t) => (
                  <Button key={t} onClick={() => push({ kind: "tag", tag: t, name: t })}
                    className="inline-flex items-center justify-center min-h-0 h-7 px-2.5 rounded-(--r-ctl) bg-s3 text-[12px] text-on/85 hover:bg-s4 pressable">
                    #{t}
                  </Button>
                ))}
              </div>
              <div className="mt-3.5 flex flex-wrap items-center gap-2">
                {(() => {
                  const fav = isFav(id, "post");
                  const favBusy = actionPending(`collect:post:${id}`);
                  const favCount = Math.max(0, (currentPost.counts?.collect ?? 0) + Number(fav));
                  return <>
                    <Button aria-pressed={fav} disabled={favBusy} onClick={() => {
                      void setCollected("post", id, !fav)
                        .then(() => toast(!fav ? "已收藏" : "已取消收藏", !fav ? "star" : "info"))
                        .catch(e => toast(e instanceof Error ? e.message : "操作失败", "info"));
                    }} className="h-9 px-3.5 rounded-full bg-s2 flex items-center gap-1.5 text-[13px] text-on pressable">
                      {fav ? <IStarF size={15} className="text-amber" /> : <IStar size={15} />}
                      <span>{favCount > 0 ? fmt(favCount) : "收藏"}</span>
                    </Button>
                  </>;
                })()}
              </div>
              {currentPost.content && (
                (isHtml(currentPost.content) || (!strictSecurity && /<[a-z][\s\S]*>/i.test(currentPost.content)))
                  ? <div className="article-body mt-3.5" onClick={(e) => handleArticleClick(e, openSafeLink)} dangerouslySetInnerHTML={{ __html: safeHtml }} />
                  : <Surface className="mt-3.5 rounded-(--r-md) bg-s2 p-3.5 text-[14px] leading-relaxed text-on/80 whitespace-pre-wrap">{currentPost.content}</Surface>
              )}
            </div>
            {/* 先文后视频（Muse 2026-11-19 最终版D2线，用户实报）：标题/标签/介绍在前，
                播放器移到介绍之后；仍是点了才播——play 态与分段解析逻辑不变、不自动装载。
                封面圆罩修复同批：播放 Button 加 rounded-none，断掉 .ios-button 胶囊圆角
                (999px) 经 .ios-image{border-radius:inherit} 继承裁切封面的链。 */}
            <div data-post-media className="relative w-full bg-black mx-auto mt-5" style={{ height: isMobile ? "min(48vh, 420px)" : "min(60vh, 640px)" }}>
              {play && src ? (
                <Player src={src} scopeKey={id} poster={cover(currentPost.cover)} autoPlay active={active && !tagMenu} controls muted={muted} volume={volume}
                  onToggleMute={() => setMuted((m) => !m)} diagnosticContext={{ video_id: id, active: active && !tagMenu }} className="w-full h-full"
                  onEnded={() => {
                    /* 多段吃瓜视频：播完自动接下一段；末段保留播放器以便回拖或重看 */
                    if (seg < segs.length - 1) setSeg(seg + 1);
                  }} />
              ) : src ? (
                <Button aria-label="播放视频" onClick={() => { playScrollRef.current = scrollRef.current?.scrollTop ?? null; setPlay(true); }} className="absolute inset-0 rounded-none">
                  <Img src={currentPost.cover} eager />
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="w-14 h-14 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center elev-2">
                        <IPlayF size={24} className="text-white ml-0.5" />
                      </span>
                    </span>
                </Button>
              ) : (
                <div className="absolute inset-0"><Img src={currentPost.cover} eager /></div>
              )}
              {resolving && !src && <div className="absolute inset-0 flex items-center justify-center gap-3 pointer-events-none bg-black/40 text-white"><Loader label="正在解析视频" /><span>正在解析视频…</span></div>}
            </div>
            {mediaError && !src && <div role="alert" className="flex flex-wrap items-center justify-center gap-3 px-4 py-3 text-[13px] text-danger"><span>{mediaError}</span><Button disabled={resolving} onClick={() => setMediaRetry(n => n + 1)} className="text-primary">重新解析</Button></div>}
              {segs.length > 1 && (
                <div role="group" aria-label="视频分段" className="flex items-center gap-2 px-4 py-3 overflow-x-auto">
                  {segs.map((_, i) => (
                    <Button aria-label={`第 ${i + 1} 段`} aria-pressed={i === seg} key={i} onClick={() => { playScrollRef.current = scrollRef.current?.scrollTop ?? null; setSeg(i); setPlay(true); }}
                      className="shrink-0 min-h-11 px-3 rounded-full text-[13px] font-semibold pressable"
                      style={i === seg
                        ? { background: "var(--p-primary)", color: "var(--p-on-primary)" }
                        : { background: "var(--p-s3)", color: "var(--p-on)" }}>
                      {i + 1}
                    </Button>
                  ))}
                </div>
              )}

          </>
        )}
      </div>
      <TagBlockMenu open={tagMenu && active} tags={currentPost?.tags || []} onClose={() => setTagMenu(false)} onSettings={() => push({ kind: "settings", section: "内容偏好" })} />
    </div>
  );
}
