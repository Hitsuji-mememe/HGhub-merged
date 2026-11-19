import { Button, Surface } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmt } from "../../shared/api/api";
import type { Paged, UserProfile, VideoCard } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { usePaginatedList } from "../../shared/lib/usePaginatedList";
import { Masonry } from "../../shared/ui/cards";
import { InplaceSearch } from "../search/InplaceSearch";
import { Avatar, Empty } from "../../shared/ui/ui";
import { IBack, IChevronDown, IGrid, IHeart, ISearch, IUser } from "../../shared/ui/icons";

/** Keep pagination local to the scrolling page and reject responses from an old author. */
function useUserVideos(enabled: boolean, resetKey: string | number, request: (page: number) => Promise<Paged<VideoCard>>) {
  return usePaginatedList<VideoCard>({
    enabled,
    resetKey,
    listId: `user-videos:${String(resetKey)}`,
    rootMargin: "200px",
    getId: (item) => item.id,
    request,
  });
}

type VideoState = ReturnType<typeof useUserVideos>;
function PaginationFeedback({ state }: { state: VideoState }) {
  if (!state.items.length) return null;
  return <>
    {state.err && <div role="status" className="mt-3 rounded-(--r-md) bg-s2 p-3 text-[13px]">
      <p className="font-semibold">加载更多失败</p><p className="mt-1 break-words text-mut">{state.err}</p>
      <Button onClick={() => void state.loadMore()} className="mt-2 px-4 text-primary">重试</Button>
    </div>}
    {state.loading ? <div className="flex justify-center py-3"><Loader label="加载更多作品" /></div>
      : !state.err && state.hasMore ? <Button onClick={() => void state.loadMore()} className="mt-3 w-full rounded-(--r-ctl) bg-s3">加载更多</Button>
      : !state.err && <p className="py-3 text-center text-[12px] text-mut">— 已展示全部作品 —</p>}
    <div ref={state.sentinel} className="h-8" aria-hidden="true" />
  </>;
}
const countLabel = ({ items, total }: VideoState) => `已加载 ${items.length}${total === null ? "" : ` / ${total}`} 部`;

export function UserPage({ id, name, onBack, wide }: { id: number; name?: string; onBack: () => void; wide: boolean }) {
  const { lineEpoch } = useStore();
  return <UserContent key={`${lineEpoch}:${id}`} id={id} name={name} onBack={onBack} wide={wide} />;
}

function UserContent({ id, name, onBack, wide }: { id: number; name?: string; onBack: () => void; wide: boolean }) {
  const { push } = useStore();
  const [searching, setSearching] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.userStats>> | null>(null);
  const [infoError, setInfoError] = useState("");
  const [infoLoading, setInfoLoading] = useState(true);
  const [infoReload, setInfoReload] = useState(0);
  const mounted = useRef(false);
  const request = useCallback((page: number) => api.userVideos(id, page, 20), [id]);
  const state = useUserVideos(true, `${id}`, request);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, [id]);
  useEffect(() => { setProfile(null); setStats(null); }, [id]);
  useEffect(() => {
    let alive = true;
    setInfoLoading(true); setInfoError("");
    Promise.allSettled([api.user(id), api.userStats(id)]).then(([profileResult, statsResult]) => {
      if (!alive) return;
      if (profileResult.status === "fulfilled") setProfile(profileResult.value);
      if (statsResult.status === "fulfilled") setStats(statsResult.value);
      const failures = [profileResult, statsResult].filter(result => result.status === "rejected") as PromiseRejectedResult[];
      if (failures.length) setInfoError(failures.map(result => result.reason instanceof Error ? result.reason.message : "资料加载失败").filter((value, index, all) => all.indexOf(value) === index).join("；"));
      setInfoLoading(false);
    });
    return () => { alive = false; };
  }, [id, infoReload]);

  const stat = (value: number | undefined) => value === undefined ? "—" : fmt(value);

  return <div className="ios-page absolute inset-0 bg-bg flex flex-col">
    <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
      <div className="ios-subpage-bar">
        <Button aria-label="返回" onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
        <h1 className="flex-1 min-w-0 text-[17px] font-bold text-on leading-tight truncate">{profile?.nickname || name || "用户主页"}</h1>
        <Button onClick={() => setSearching(true)} aria-label="搜索短剧" className="ios-nav-btn"><ISearch size={18} /></Button>
      </div>
    </div>
    <div ref={state.scroller} className="flex-1 scroll-y pt-3.5 pb-8">
      <Surface className="rounded-(--r-lg) bg-s1 p-4 elev-1 a-rise">
        <div className="flex items-center gap-3.5">
          <Avatar size={56} name={profile?.nickname || name || "U"} hue={220} ring />
          <div className="flex-1 min-w-0">
            <p className="text-[16px] font-bold text-on break-words">{profile?.nickname || name || (infoLoading ? "正在读取资料…" : "用户资料暂不可用")}</p>
            {profile?.username && <p className="text-[12px] text-mut mt-0.5 break-words">@{profile.username} · ID {id}</p>}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-mut" aria-busy={infoLoading}>
            <span>作品 <b className="text-on">{stat(stats?.video_count)}</b></span>
            <span>粉丝 <b className="text-on">{stat(stats?.followers)}</b></span>
            <span>获赞 <b className="text-on">{stat(stats?.like_count)}</b></span>
          </div>

        </div>
      </Surface>
      {infoError && <div role="status" className="mt-3 rounded-(--r-md) bg-s2 p-3 text-[13px]">
        <p className="font-semibold">资料信息未完整加载</p><p className="mt-1 text-mut break-words">{infoError}</p>
        <Button disabled={infoLoading} onClick={() => setInfoReload(value => value + 1)} className="mt-2 px-3 text-primary">重试资料</Button>
      </div>}
      {profile?.sign && <details className="group mt-3 text-[13px] text-mut"><summary className="cursor-pointer min-h-11 flex items-center gap-2 text-on">作者简介<IChevronDown size={16} className="group-open:rotate-180" /></summary><p className="leading-relaxed whitespace-pre-wrap break-words">{profile.sign}</p></details>}
      <div className="mt-4 mb-2.5 flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-[14px] font-bold text-on">作品</h2><p role="status" className="text-[12px] text-mut">{countLabel(state)}</p></div>
      {state.loading && !state.items.length ? <div className="flex justify-center py-12"><Loader /></div>
        : state.err && !state.items.length ? <Empty icon={<IGrid size={26} />} title="作品加载失败" sub={state.err} action="重试" onAction={() => void state.loadMore()} />
        : state.items.length ? <Masonry videos={state.items} scopeKey={id} wide={wide} onOpen={(v, visible) => push({ kind: "feed", videoIds: visible.map(x => x.id), index: visible.findIndex(x => x.id === v.id), title: profile?.nickname || name || "用户作品" })} />
        : <Empty icon={<IGrid size={26} />} title="暂无作品" />}
      <PaginationFeedback state={state} />
    </div>
    {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list, kw) => push({ kind: "feed", videoIds: list.map(x => x.id), index: list.findIndex(x => x.id === v.id), title: kw ? `搜索 · ${kw}` : "搜索" })} />}
  </div>;
}
