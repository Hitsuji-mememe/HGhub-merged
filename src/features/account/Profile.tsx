import { Button, SegmentedControl, Surface } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useEffect, useRef, useState } from "react";
import { api, APP_VERSION, fmt, fmtTime, isMobile, platform } from "../../shared/api/api";
import type { Detail, Post } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { Avatar, Empty, Modal } from "../../shared/ui/ui";
import { MediaCard } from "../../shared/ui/cards";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { IBack, IChevR, IClock, IHeart, ISettings, IStar, IUser } from "../../shared/ui/icons";

/* 线路变化时丢弃缓存详情重挂载（旧实现另有 accountScope 成分，账号
 * 体系拆除后身份恒定，只剩 lineEpoch 代次）。 */
export default function Profile({ wide, active = true }: { wide: boolean; active?: boolean }) {
  const { lineEpoch } = useStore();
  return <ProfileContent key={lineEpoch} wide={wide} active={active} />;
}

function ProfileContent({ wide, active }: { wide: boolean; active: boolean }) {
  const { blockReason } = useContentPreferences();
  const { history, favs, postFavs, setCollected, toast, clearHistory, push, setTab: setMainTab } = useStore();
  const [tab, setTab] = useState<"fav" | "history">("fav");
  const [favKind, setFavKind] = useState<"video" | "post">("video");
  const [videoCache, setVideoCache] = useState<Record<number, Detail>>({});
  const videoCacheRef = useRef(videoCache);
  videoCacheRef.current = videoCache;
  const [postCache, setPostCache] = useState<Record<number, Post>>({});
  const postCacheRef = useRef(postCache);
  postCacheRef.current = postCache;
  const [limits, setLimits] = useState({ favVideo: 12, favPost: 12, history: 12 });
  const [failedIds, setFailedIds] = useState<number[]>([]);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearError, setClearError] = useState("");
  const clearing = useRef(false);
  const [blockedPrompt, setBlockedPrompt] = useState<{
    id: number; kind: "video" | "post"; reason: string; removableFav: boolean;
  } | null>(null);
  const [removingBlocked, setRemovingBlocked] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const showingPosts = tab === "fav" && favKind === "post";
  const limitKey = tab === "history" ? "history" : showingPosts ? "favPost" : "favVideo";
  const ids = tab === "history" ? history.map((h) => h.id) : showingPosts ? postFavs : favs;
  const visibleIds = ids.slice(0, limits[limitKey]);
  const videoCards = !showingPosts ? visibleIds.map(id => videoCache[id]).filter((card): card is Detail => !!card) : [];
  const postCards = showingPosts ? visibleIds.map(id => postCache[id]).filter((card): card is Post => !!card) : [];
  const cardsCount = showingPosts ? postCards.length : videoCards.length;
  const failed = failedIds.filter(id => visibleIds.includes(id));
  const idsKey = visibleIds.join(",");
  /** 观看记录里这条的进度（收藏页没有） */
  const progressOf = (id: number) => (tab === "history" ? history.find((h) => h.id === id) : undefined);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const missing = showingPosts
      ? visibleIds.filter(id => !postCacheRef.current[id])
      : visibleIds.filter(id => !videoCacheRef.current[id]);
    setFailedIds([]);
    if (!missing.length) { setLoading(false); return; }
    setLoading(true);
    if (showingPosts) {
      Promise.allSettled(missing.map(id => api.post(id)))
        .then(results => {
          if (!alive) return;
          const loaded: Record<number, Post> = {};
          const failedList: number[] = [];
          results.forEach((result, index) => {
            if (result.status === "fulfilled" && result.value) loaded[missing[index]] = result.value;
            else failedList.push(missing[index]);
          });
          setPostCache(previous => ({ ...previous, ...loaded }));
          setFailedIds(failedList);
          setLoading(false);
        });
    } else {
      Promise.allSettled(missing.map(id => api.video(id)))
        .then(results => {
          if (!alive) return;
          const loaded: Record<number, Detail> = {};
          const failedList: number[] = [];
          results.forEach((result, index) => {
            if (result.status === "fulfilled" && result.value) loaded[missing[index]] = result.value;
            else failedList.push(missing[index]);
          });
          setVideoCache(previous => ({ ...previous, ...loaded }));
          setFailedIds(failedList);
          setLoading(false);
        });
    }
    return () => { alive = false; };
  }, [active, idsKey, tab, showingPosts, reload]);

  const clearWatchHistory = async () => {
    if (clearing.current) return;
    clearing.current = true;
    setClearBusy(true); setClearError("");
    try {
      await clearHistory();
      if (mounted.current) setClearOpen(false);
    } catch (error) {
      if (mounted.current) setClearError(error instanceof Error ? error.message : "清空失败，观看记录已保留，请重试");
    } finally {
      clearing.current = false;
      if (mounted.current) setClearBusy(false);
    }
  };

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-page-heading shrink-0 px-4 flex items-center">
        {/* 出入口同位（2026-11-18 第9项裁定）：左上返回回播放器 */}
        {isMobile && (
          <Button onClick={() => setMainTab("home")} aria-label="返回播放器" className="ios-icon-button shrink-0 mr-2.5">
            <IBack size={17} />
          </Button>
        )}
        <h1 className="ios-page-title text-on">我的</h1>
        {isMobile && (
          <Button onClick={() => push({ kind: "settings" })} aria-label="设置"
            className="ios-icon-button ml-auto">
            <ISettings size={17} strokeWidth={1.7} />
          </Button>
        )}
      </div>

      <div className="ios-page-body flex-1 scroll-y px-4 pt-2 pb-24">
        {/* 「我的」只有本机收藏/观看历史：登录脸已于 2.2.0 移除，账号
            体系（同步/分桶/登出）于 3.3.0 拆除，资料库纯本地。 */}

        {/* 我的内容 */}
        <SegmentedControl className="mt-4" aria-label="我的内容" activeIndex={tab === "fav" ? 0 : 1}>
          {([["fav", "我的收藏"], ["history", "观看历史"]] as const).map(([k, l]) => (
            <Button aria-pressed={tab === k} key={k} onClick={() => setTab(k)}>{l}</Button>
          ))}
        </SegmentedControl>

        {tab === "fav" && (favs.length > 0 || postFavs.length > 0 || favKind === "post") && (
          <div className="mt-2.5 flex items-center gap-2" role="group" aria-label="收藏内容类型">
            <Button aria-pressed={favKind === "video"} onClick={() => setFavKind("video")} className="ios-filter-pill">
              短剧{favs.length ? ` ${favs.length}` : ""}
            </Button>
            <Button aria-pressed={favKind === "post"} onClick={() => setFavKind("post")} className="ios-filter-pill">
              帖子{postFavs.length ? ` ${postFavs.length}` : ""}
            </Button>
          </div>
        )}

        <div className="mt-3" aria-busy={loading}>
          {loading && !cardsCount ? (
            <div className="flex justify-center py-8"><Loader className="w-7 h-7 spinner" /></div>
          ) : showingPosts && postCards.length ? (
            <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
              {postCards.map((p) => {
                const reason = blockReason(p.tags);
                return <MediaCard key={p.id} blockedReason={reason} title={p.title} cover={p.cover}
                  subtitle={p.tags?.slice(0, 2).join(" · ") || `${fmt(p.hot)} 次浏览`}
                  onOpen={() => {
                    if (reason) setBlockedPrompt({ id: p.id, kind: "post", reason, removableFav: true });
                    else push({ kind: "post", id: p.id });
                  }} />;
              })}
            </div>
          ) : !showingPosts && videoCards.length ? (
            <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
              {videoCards.map((c) => {
                const progress = progressOf(c.id);
                const reason = blockReason(c.tags);
                return <MediaCard key={c.id} blockedReason={reason} title={c.title} cover={c.cover} score={c.score}
                  badge={c.is_finished ? "已完结" : `${c.episode_count} 集`}
                  subtitle={c.tags?.slice(0, 2).join(" · ")}
                  progress={progress ? (progress.t >= 1 ? `第 ${progress.ep} 集 · ${fmtTime(progress.t)}` : `第 ${progress.ep} 集`) : undefined}
                  onOpen={() => {
                    if (reason) {
                      setBlockedPrompt({ id: c.id, kind: "video", reason, removableFav: tab === "fav" });
                      return;
                    }
                    const playableIds = ids.filter(id => {
                      const cached = videoCache[id];
                      return !cached || !blockReason(cached.tags);
                    });
                    const targetIndex = Math.max(0, playableIds.indexOf(c.id));
                    push({
                      kind: "feed", videoIds: playableIds, index: targetIndex,
                      title: tab === "fav" ? "我的收藏" : "观看历史", startEp: progress?.ep, startTime: progress?.t,
                    });
                  }} />;
              })}
            </div>
          ) : failed.length ? (
            <Empty icon={tab === "fav" ? <IStar size={24} /> : <IClock size={24} />}
              title={tab === "fav" ? "收藏加载失败" : "观看记录加载失败"}
              sub="记录仍在，重试后继续浏览。" action="重试" onAction={() => setReload(n => n + 1)} />
          ) : showingPosts ? (
            <Empty icon={<IStar size={24} />} title="还没有收藏帖子"
              sub="在吃瓜页面点收藏，之后就能在这里找到"
              action="去看吃瓜" onAction={() => push({ kind: "posts" })} />
          ) : (
            <Empty icon={tab === "fav" ? <IStar size={24} /> : <IClock size={24} />}
              title={tab === "fav" ? "还没有收藏" : "还没有观看记录"}
              sub={tab === "fav" ? "在剧集页点收藏，之后就能在这里找到" : "看过的剧集会出现在这里"}
              action="去逛逛" onAction={() => push({ kind: "ranks" })} />
          )}
          {cardsCount > 0 && failed.length > 0 && <div role="status" className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-mut">
            <span>{failed.length} 项内容加载失败，已加载内容仍可浏览。</span>
            <Button disabled={loading} onClick={() => setReload(n => n + 1)} className="px-3 text-primary">重试失败内容</Button>
          </div>}
          {cardsCount > 0 && loading && <div className="flex justify-center py-3"><Loader label="加载更多内容" /></div>}
          {ids.length > 0 && <p role="status" className="mt-3 text-[12px] text-mut">已显示 {cardsCount} / {ids.length} 项本机记录</p>}
          {visibleIds.length < ids.length && <Button disabled={loading} onClick={() => setLimits(previous => ({ ...previous, [limitKey]: previous[limitKey] + 12 }))}
            className="mt-3 w-full rounded-(--r-ctl) bg-s3 text-[13px] text-on">加载更多</Button>}
          {tab === "history" && history.length > 0 && (
            <Button disabled={clearBusy} aria-busy={clearBusy} onClick={() => { setClearError(""); setClearOpen(true); }} className="mt-3 w-full h-9 rounded-(--r-ctl) bg-s3 text-[13px] text-mut pressable">{clearBusy ? "正在清空…" : "清空观看历史"}</Button>
          )}
          {clearError && !clearOpen && <p role="alert" className="mt-2 text-[13px] text-danger">{clearError}</p>}
        </div>

        <div className="text-center text-[12px] text-dim mt-5">HGhubX {APP_VERSION} · {platform === "android" ? "Android" : platform === "ios" ? "iOS" : platform === "macos" ? "macOS" : platform === "linux" ? "Linux" : "Windows"} 客户端</div>
      </div>
      <Modal open={!!blockedPrompt} onClose={() => { if (!removingBlocked) setBlockedPrompt(null); }} label="内容已屏蔽">
        {blockedPrompt && (
          <div className="p-5">
            <h2 className="text-[18px] font-bold">该内容命中屏蔽规则</h2>
            <p className="mt-2 text-[14px] text-mut break-words">{blockedPrompt.reason}。你可以在内容偏好中调整屏蔽标签{blockedPrompt.removableFav ? "，或将此内容移出收藏" : ""}。</p>
            <div className="mt-4 flex flex-wrap gap-2.5">
              <Button variant="secondary" disabled={removingBlocked} onClick={() => setBlockedPrompt(null)} className="flex-1">关闭</Button>
              {blockedPrompt.removableFav && (
                <Button variant="danger" disabled={removingBlocked} onClick={() => {
                  setRemovingBlocked(true);
                  void setCollected(blockedPrompt.kind, blockedPrompt.id, false)
                    .then(() => { if (mounted.current) { setBlockedPrompt(null); toast("已取消收藏", "info"); } })
                    .catch(e => { if (mounted.current) toast(e instanceof Error ? e.message : "操作失败", "info"); })
                    .finally(() => { if (mounted.current) setRemovingBlocked(false); });
                }} className="flex-1 rounded-(--r-ctl) px-3">
                  {removingBlocked ? "处理中…" : "取消收藏"}
                </Button>
              )}
              <Button variant="primary" disabled={removingBlocked} onClick={() => {
                setBlockedPrompt(null);
                push({ kind: "settings", section: "内容偏好" });
              }} className="w-full rounded-(--r-ctl) min-h-11 px-4 font-semibold">
                管理屏蔽标签
              </Button>
            </div>
          </div>
        )}
      </Modal>
      <Modal open={clearOpen} onClose={() => { if (!clearing.current) setClearOpen(false); }} label="清空观看历史">
        <div className="p-5">
          <h2 className="text-[18px] font-bold">清空观看历史</h2>
          <p className="mt-2 text-[14px] text-mut">确认清空全部观看历史？本机观看历史会被清除。此操作无法撤销，收藏不会受影响。</p>
          {clearError && <p role="alert" className="mt-3 text-[13px] text-danger">{clearError}</p>}
          <div className="mt-4 flex gap-3">
            <Button variant="secondary" disabled={clearBusy} onClick={() => setClearOpen(false)} className="flex-1">取消</Button>
            <Button variant="danger" disabled={clearBusy} aria-busy={clearBusy} onClick={() => void clearWatchHistory()} className="flex-1 rounded-(--r-ctl) px-3">
              {clearBusy ? "正在清空…" : "确认清空"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

