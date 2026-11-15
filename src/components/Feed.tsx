import { Button, Image, SegmentedControl } from "./ios/controls";
import { Loader } from "./ios/effects";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, cover, fmt, fmtTime, isMobile, logLine, mediaUrl, playlist } from "../api";
import type { Detail, Episode, PlayInfo, Post, VideoCard } from "../types";import { useStore } from "../store";
import { Img, Sheet } from "./ui";
import VideoSurface, { type VideoHandle } from "./VideoSurface";
import PlayerControls from "./PlayerControls";
import { PlaybackProgress, PlaybackTime } from "./PlaybackProgress";
import { SR_PRESET_MAP, SR_SHORT_LABEL, SuperResMenu } from "./SuperResCanvas";
import { ArticlePanel, CommentsPanel, EpisodesPanel } from "./Panels";
import { setBackHandler } from "../back";
import { copyText } from "../clipboard";
import { tracePlayback } from "../playbackDiagnostics";
import { createPlaybackClock } from "../playbackClock";
import { pickLine } from "../autoLine";
import { useContentPreferences } from "../contentPreferences";
import VideoDetailsPanel from "./VideoDetailsPanel";
import { PreferenceStorageNotice } from "./PreferenceStorageNotice";
import {
  IBack, IBoltF, ICheck, IChevR, IChevronDown, IChevronUp, IClose, ICommentF, ICompress, IExpand, IFileText, IHeart, IHeartF, IMore,
  IList, IPauseF, IPlayF, ISearch, ISparkF, IStar, IStarF, IVol, IVolMute,} from "../icons";

type Props = {
  videoIds: number[];
  startIndex?: number;
  title?: string;
  mode: "home" | "context";
  kind?: "video" | "post";
  active: boolean;
  bottomInset: number;
  onBack?: () => void;
  onNearEnd?: () => void;
  onBlocked?: (id: number) => void;
  /** 从观看记录续播：起始集数与秒数 */
  startEp?: number;
  startTime?: number;
};

const RATES = [0.75, 1, 1.25, 1.5, 2, 3];

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/**
 * 全屏底栏倍速直达选单（深色毛玻璃浮层，样式对齐 SuperResMenu）：点选即定档并
 * 一直生效，取代原「⚡ 钮点按循环切档」；长按只作临时 2x 快进（2.0.4）。
 */
function RateMenu({
  current,
  onSelect,
}: {
  current: number;
  onSelect: (r: number) => void;
}) {
  return (
    <div
      role="menu"
      aria-label="倍速选择"
      data-no-gesture
      onPointerDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        bottom: "calc(100% + 8px)",
        right: 0,
        width: 168,
        background: "rgba(14, 17, 24, 0.92)",
        backdropFilter: "blur(18px)",
        WebkitBackdropFilter: "blur(18px)",
        border: "1px solid rgba(255, 255, 255, 0.14)",
        boxShadow: "0 14px 36px rgba(0, 0, 0, 0.56)",
        borderRadius: 14,
        padding: 6,
        zIndex: 60,
      }}
      className="a-fade">
      <div className="flex items-center justify-between px-2.5 pt-1 pb-1.5 text-[10.5px] font-semibold text-white/55">
        <span className="flex items-center gap-1">
          <IBoltF size={11} className="text-primary" />
          <span>播放倍速</span>
        </span>
        <span className="text-[10px] text-white/40">点选生效</span>
      </div>
      <div className="flex flex-col gap-0.5">
        {RATES.map((r) => {
          const active = current === r;
          return (
            <button
              key={r}
              type="button"
              role="menuitemradio"
              aria-checked={active}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(r);
              }}
              className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-[10px] text-left transition-colors pressable ${
                active ? "bg-white/14" : "hover:bg-white/8"
              }`}>
              <span className={`text-[12px] font-bold ${active ? "text-primary" : "text-white/95"}`}>{r}x</span>
              {active && <ICheck size={14} className="text-primary shrink-0" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── 下一条首分片预热（2.0.6） ──────────────────────────────
 * 取流路径（VideoSurface）：hls.js 用默认 loader 向 playlist(src)
 * （即 `{LOCAL}/hls?u=…`）拉清单，分片与 key 的地址是 Rust 在清单里改写好的
 * `{LOCAL}/seg?u=…`；两类请求都经 Rust `media::handle` 的进程内缓存
 * （PL_CACHE 按 `{prefix}|{上游地址}`、SEG_CACHE 按上游地址）。
 * 所以这里用 fetch() 走与播放器逐字相同的 URL 把清单与首分片先拉一遍，
 * 就能把同一份缓存填好——用户切过去时 hls.js 的请求直接命中。
 * 全程只用 fetch、不碰播放器的 hls 实例，不污染 2.0.5 的分片统计与自愈判据。 */
function firstUriLine(text: string): string | null {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#")) return t;
  }
  return null;
}

function resolveUri(u: string, base: string): string {
  try { return new URL(u, base).href; } catch { return u; }
}

async function prewarmFirstSegment(videoId: number, rawUrl: string, signal: AbortSignal): Promise<void> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  try {
    const plUrl = playlist(rawUrl);
    const r = await fetch(plUrl, { signal });
    if (!r.ok) {
      tracePlayback("feed.prewarm", { video_id: videoId, stage: "playlist_fail", status: r.status, ms: ms() });
      return;
    }
    let text = await r.text();
    tracePlayback("feed.prewarm", { video_id: videoId, stage: "playlist", ms: ms() });
    /* 主清单（多码率）：第一条 URI 行是子清单，它经 /seg 返回时会被二次改写，照拉一遍 */
    if (text.includes("#EXT-X-STREAM-INF")) {
      const variant = firstUriLine(text);
      if (!variant) return;
      const vr = await fetch(resolveUri(variant, plUrl), { signal });
      if (!vr.ok) return;
      text = await vr.text();
    }
    /* init 段（fMP4 的 EXT-X-MAP）先热，再热首个媒体分片；
       URL 全部取自改写后清单的原文，与 hls.js 实际请求逐字一致，缓存键才对得上 */
    const mapUri = /#EXT-X-MAP:[^\n]*URI="([^"]+)"/.exec(text)?.[1];
    if (mapUri) {
      const mr = await fetch(resolveUri(mapUri, plUrl), { signal });
      await mr.arrayBuffer();
      if (signal.aborted) return;
      tracePlayback("feed.prewarm", { video_id: videoId, stage: "map", ms: ms() });
    }
    const seg = firstUriLine(text);
    if (!seg) return;
    const sr = await fetch(resolveUri(seg, plUrl), { signal });
    if (!sr.ok) return;
    const buf = await sr.arrayBuffer();
    tracePlayback("feed.prewarm", { video_id: videoId, stage: "segment", ms: ms(), bytes: buf.byteLength });
  } catch { /* 取消或失败一律静默：预热只是加速，失败不影响正常播放路径 */ }
}
export default function Feed({ videoIds, startIndex = 0, title = "", mode, kind = "video", active, bottomInset, onBack, onNearEnd, onBlocked, startEp, startTime }: Props) {
  const store = useStore();
  const { isLiked, isFav, toggleLikeLocal, toggleFavLocal, toggleFollowLocal, setLiked, setCollected, setFollowing, actionPending, accountScope, muted, setMuted, volume, setVolume, toast, addHistory, user, setLoginOpen, swipeEp, setSwipeEp, preferHevc, setPreferHevc, srMode, setSrMode } = store;  const isDesktop = !isMobile;
  const contentPreferences = useContentPreferences();
  const { preferences, revision, blockReason } = contentPreferences;
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [tagErrors, setTagErrors] = useState<Record<string, string>>({});
  const [details, setDetails] = useState<Record<number, Detail>>({});
  const detailsRef = useRef(details);
  detailsRef.current = details;
  const [posts, setPosts] = useState<Record<number, Post>>({});
  const detailRequests = useRef(new Map<string, Promise<Detail>>());
  const playRequests = useRef(new Map<string, Promise<PlayInfo>>());
  const requestDetail = useCallback((id: number) => {
    const key = `${accountScope}:${store.lineEpoch}:${id}`;
    let request = detailRequests.current.get(key);
    if (!request) {
      request = api.video(id).finally(() => {
        if (detailRequests.current.get(key) === request) detailRequests.current.delete(key);
      });
      detailRequests.current.set(key, request);
      if (detailRequests.current.size > 12) detailRequests.current.delete(detailRequests.current.keys().next().value!);
    }
    return request;
  }, [accountScope, store.lineEpoch]);
  const requestPlay = useCallback((id: number, episode: number) => {
    const key = `${accountScope}:${store.lineEpoch}:${id}:${episode}`;
    let request = playRequests.current.get(key);
    if (!request) {
      request = api.play(id, episode).finally(() => {
        if (playRequests.current.get(key) === request) playRequests.current.delete(key);
      });
      playRequests.current.set(key, request);
      if (playRequests.current.size > 12) playRequests.current.delete(playRequests.current.keys().next().value!);
    }
    return request;
  }, [accountScope, store.lineEpoch]);
  const effectiveVideoIds = useMemo(
    () => mode === "context" && filtering ? videoIds.filter(id => {
      const key = `${accountScope}:${store.lineEpoch}:${kind}:${id}`;
      if (!checked[key]) return true;
      if (tagErrors[key]) return true;
      return !blockReason(kind === "post" ? posts[id]?.tags : details[id]?.tags);
    }) : videoIds,
    [mode, filtering, revision, videoIds, accountScope, store.lineEpoch, kind, checked, tagErrors, posts, details, blockReason],
  );

  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<VideoHandle>(null);
  const [position, setPosition] = useState(() => ({ id: videoIds[startIndex], index: startIndex }));
  const index = useMemo(() => {
    if (!effectiveVideoIds.length) return -1;
    const anchored = effectiveVideoIds.indexOf(position.id);
    if (anchored >= 0) return anchored;
    // Only find a replacement after removal, not on every playback/UI update.
    const source = videoIds.indexOf(position.id);
    if (source >= 0) {
      const visible = new Set(effectiveVideoIds);
      for (let i = source + 1; i < videoIds.length; i++) {
        if (visible.has(videoIds[i])) return effectiveVideoIds.indexOf(videoIds[i]);
      }
      for (let i = source - 1; i >= 0; i--) {
        if (visible.has(videoIds[i])) return effectiveVideoIds.indexOf(videoIds[i]);
      }
    }
    return Math.max(0, Math.min(position.index, effectiveVideoIds.length - 1));
  }, [effectiveVideoIds, videoIds, position.id, position.index]);
  const idsRef = useRef(effectiveVideoIds); idsRef.current = effectiveVideoIds;
  const setIndex = useCallback((next: number) => {
    const id = idsRef.current[next];
    if (id !== undefined) setPosition({ id, index: next });
  }, []);
  const [renderIndex, setRenderIndex] = useState(startIndex);
  const [epMap, setEpMap] = useState<Record<number, number>>(() => (startEp ? { [videoIds[startIndex]]: startEp } : {}));
  const [playUrls, setPlayUrls] = useState<Record<string, string>>({});
  const [hevcUrls, setHevcUrls] = useState<Record<string, string>>({});
  const [playingKey, setPlayingKey] = useState("");
  const [proxyRetry, setProxyRetry] = useState(0);
  const [relatedByVideo, setRelatedByVideo] = useState<Record<string, VideoCard[]>>({});

  const playbackClock = useMemo(() => createPlaybackClock(), []);
  const [duration, setDuration] = useState(0);
  const [vsize, setVsize] = useState({ w: 0, h: 0 });
  const [paused, setPaused] = useState(false);
  const [rate, setRate] = useState(1);
  const [waiting, setWaiting] = useState(false);
  /* 卡顿自愈（2.0.5）：滚动统计最近 3 片的吞吐；waiting 发生时刻；
     自愈护栏（上次触发时刻 / 每集已触发次数 / 等待切线落地的那一集）；
     切线重解析后把播放位置接回去的待办 */
  const fragWindowRef = useRef<{ slow: boolean; kbps: number }[]>([]);
  const lastStallAtRef = useRef(0);
  const healStateRef = useRef<{ lastAt: number; counts: Record<string, number>; pendingKey: string | null; pendingAt: number }>(
    { lastAt: 0, counts: {}, pendingKey: null, pendingAt: 0 },
  );
  const healResumeRef = useRef<{ key: string; t: number } | null>(null);
  /* ── 预加载（2.0.6）── 相邻条目地址预解析的队列（换代丢弃未发起的旧任务，并发 2） */
  const playPrefetchRef = useRef<{ gen: number; inflight: number; queue: { id: number; ep: number; key: string }[] }>(
    { gen: 0, inflight: 0, queue: [] },
  );
  const pumpPrefetchRef = useRef<() => void>(() => {});
  /* 封面预加载：已发起过的原始封面地址不再重复，hold 住 Image 引用防被 GC 掉未完成的加载 */
  const coverWarmRef = useRef<{ done: Set<string>; hold: HTMLImageElement[] }>({ done: new Set(), hold: [] });
  /* 分片预热：同一条（key+地址）只热一次 */
  const prewarmDoneRef = useRef<Set<string>>(new Set());
  /* 预热让行（2.0.10）：当前条目「健康」（已起播且不在 waiting）才准启动下一条的
     分片预热；预热进行中当前条目一进入 waiting，立刻 abort 掉手头这次预热，
     不和当前播放抢单连接限速下那点可怜的吞吐 */
  const healthyRef = useRef(false);
  const prewarmCtlRef = useRef<{ ac: AbortController; videoId: number } | null>(null);
  const [err, setErr] = useState("");
  const [panel, setPanel] = useState<"episodes" | "comments" | "article" | "detail" | null>(null);
  /* 续播：拿到时长后再 seek 一次（只对进入时那一条生效） */
  const resumeRef = useRef<{ key: string; t: number } | null>(
    startTime && startTime > 1 ? { key: `${videoIds[startIndex]}:${startEp || 1}`, t: startTime } : null,
  );
  /* 观看进度：onTime 里节流写回 store，卸载时再兜一次 */
  const liveRef = useRef({ id: 0, ep: 1, dur: 0, t: 0, permissionKey: "", accountScope: "" });
  const historyWriter = useRef(addHistory);
  const lastSaveRef = useRef(0);
  const theater = store.theater;
  const setTheater = store.setTheater;
  const fs = store.fs;
  const clean = store.clean;
  const setClean = store.setClean;
  const setFs = store.setFs;

  /* 桌面：鼠标闲置 2.8s 自动隐藏播放器 UI（沉浸） */
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | undefined>(undefined);
  /* wake() 是 useCallback([])，用 ref 读当前平台/全屏态（fsRef 由 enterFs/exitFs 同步） */
  const isDesktopRef = useRef(isDesktop);
  isDesktopRef.current = isDesktop;
  const fsRef = useRef(fs);
  fsRef.current = fs;
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    /* 移动端全屏：控制层改为单击切换显隐（2.0.3），不武装自动隐藏计时 */
    if (isDesktopRef.current || !fsRef.current) {
      idleTimer.current = window.setTimeout(() => {
        // Keyboard users must keep seeing the focused control/menu.
        if (!boxRef.current?.parentElement?.contains(document.activeElement) || !document.activeElement?.closest(".desktop-controls")) setIdle(true);
      }, 2800);
    }  }, []);
  useEffect(() => {
    if (!isDesktop) return undefined;
    wake();
    return () => window.clearTimeout(idleTimer.current);
  }, [isDesktop, wake]);
  useEffect(() => {
    if (paused) { setIdle(false); window.clearTimeout(idleTimer.current); }
  }, [paused]);
  const [fullscreen, setFullscreen] = useState(false);
  const [heartBurst, setHeartBurst] = useState(0);

  /* 超分档位切换 HUD 与选单（移植自 LNPANDY v1.2.2） */
  const [srHud, setSrHud] = useState<typeof srMode | null>(null);
  const [srMenuPos, setSrMenuPos] = useState<"topbar" | "fs-bottom" | null>(null);
  const srMenuDismissedAtRef = useRef(0);
  /* 全屏底栏倍速选单（2.0.4：⚡ 钮改开菜单选档） */
  const [rateMenuOpen, setRateMenuOpen] = useState(false);
  const rateMenuDismissedAtRef = useRef(0);
  const prevSrRef = useRef(srMode);
  useEffect(() => {
    if (prevSrRef.current === srMode) return;
    prevSrRef.current = srMode;
    if (!active) return;
    setSrHud(srMode);
    const tid = window.setTimeout(() => setSrHud(null), 1300);
    return () => window.clearTimeout(tid);
  }, [srMode, active]);

  useEffect(() => {
    if (!srMenuPos) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest("[data-sr-slot]")) {
        srMenuDismissedAtRef.current = Date.now();
        setSrMenuPos(null);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [srMenuPos]);

  /* 倍速选单：点选单外任意处关闭，并记关闭时刻——关菜单的那一击同时落在手势层时，
     由 onUp 的 320ms 守卫吞掉，不得连带切换全屏控制层显隐或切播放（仿超分选单） */
  useEffect(() => {
    if (!rateMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest("[data-rate-slot]")) {
        rateMenuDismissedAtRef.current = Date.now();
        setRateMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [rateMenuOpen]);

  useEffect(() => {
    setSrMenuPos(null);
    setRateMenuOpen(false);
  }, [clean, fs, index, active]);
  /* —— 移动端手势 —— */
  /* Muse 2026-11-15 (2.1.1 简化版): 长按手势去分区——全屏任意位置长按=临时倍速(2x)，松手恢复菜单定档；
     无减速区、无中心菜单区、无上滑锁定。倍速唯一长期入口是底栏 RateMenu。 */
  const [holdSpeed, setHoldSpeed] = useState(false);
  const holdRef = useRef(false);
  /* Muse 2026-11-15 (2.1.2): 全屏方向无状态机——点全屏=横屏、退出=竖屏（用户定版：
     单一可预测行为，不要自动按宽高猜、不要旋转钮/三态 override，2.1.1 的整套覆盖逻辑已删）。 */
  const [scrub, setScrub] = useState<{ pct: number; target: number } | null>(null);
  const scrubTarget = useRef<number | null>(null);
  /* 进度条拖动 */
  const barRef = useRef<HTMLDivElement>(null);
  const barScrub = useRef(false);
  const [barPct, setBarPct] = useState<number | null>(null);
  const gesture = useRef<{
    x: number; y: number; startY: number; t: number; timer: number | null;
    mode: "idle" | "hold" | "scrub" | "pan"; base: number; width: number; playing: boolean;
  } | null>(null);
  /* 单击 / 双击判定：单击净屏，双击暂停 */
  const lastTapRef = useRef<{ timer: number | null; clean?: boolean; idle?: boolean }>({ timer: null });
  /* 系统是否真的转成了横屏（iOS 原生旋转后为 true） */
  const [vpLandscape, setVpLandscape] = useState(
    () => typeof window !== "undefined" && window.innerWidth > window.innerHeight,
  );
  /* 进出全屏过渡期多次续播，防止 iOS 把播放打断 */
  const keepAliveTimers = useRef<number[]>([]);
  /* 双指缩放：scale 1~4，平移跟手指 */
  const [zoom, setZoom] = useState({ s: 1, x: 0, y: 0, g: false });
  /* 竖屏下看横屏视频：contain = 完整显示，cover = 放大铺满 */
  const [portraitFit, setPortraitFit] = useState<"contain" | "cover">("contain");
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ d0: number; mx0: number; my0: number; s0: number; x0: number; y0: number } | null>(null);

  const curId = effectiveVideoIds[index];
  const nextVideoId = effectiveVideoIds[index + 1];
  const relatedKey = `${store.lineEpoch}:${curId}`;
  const related = relatedByVideo[relatedKey] || [];
  const detail = details[curId];
  const tagKey = `${accountScope}:${store.lineEpoch}:${kind}:${curId}`;
  const permissionKey = `${tagKey}:${revision}`;
  const currentTags = kind === "post" ? posts[curId]?.tags : detail?.tags;
  const tagsReady = !!checked[tagKey];
  const blocked = filtering && tagsReady ? blockReason(currentTags) : null;
  const allowed = !filtering || (tagsReady && !blocked);
  const closePanels = () => { setPanel(null); };
  useEffect(() => { if (blocked && mode === "home" && active) onBlocked?.(curId); }, [blocked, mode, active, curId, onBlocked]);
  useEffect(() => { if (!allowed) { setPanel(null); } }, [allowed]);
  const curEp = epMap[curId] || 1;
  const liked = isLiked(curId, curEp, kind);
  const collected = isFav(curId, kind);
  const likeActionKey = `like:${kind}:${curId}:${curEp}`;
  const collectActionKey = `collect:${kind}:${curId}`;
  const followActionKey = `follow:${kind === "video" ? detail?.author?.id || 0 : 0}`;
  const likePending = actionPending(likeActionKey);
  const collectPending = actionPending(collectActionKey);
  const followPending = actionPending(followActionKey);
  const actionContext = useRef({ accountScope, lineEpoch: store.lineEpoch, id: curId, ep: curEp, kind });
  actionContext.current = { accountScope, lineEpoch: store.lineEpoch, id: curId, ep: curEp, kind };
  const progressScope = useRef(accountScope);
  useLayoutEffect(() => {
    if (progressScope.current === accountScope) return;
    progressScope.current = accountScope;
    resumeRef.current = null;
    lastSaveRef.current = 0;
    liveRef.current = { id: 0, ep: 1, dur: 0, t: 0, permissionKey: "", accountScope };
  }, [accountScope]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const pendingActions = useRef(new Set<string>());
  const playKey = `${curId}:${curEp}`;
  const playGuard = useRef({ allowed, id: curId, permissionKey, playKey });
  playGuard.current = { allowed, id: curId, permissionKey, playKey };
  const isCurrentPlayback = () => playGuard.current.allowed && playGuard.current.id === curId
    && playGuard.current.permissionKey === permissionKey && playGuard.current.playKey === playKey;
  const mainUrl = playUrls[playKey] || "";
  const hevcUrl = hevcUrls[playKey] || "";
  const playUrl = preferHevc && hevcUrl ? hevcUrl : mainUrl;
  const playKeyRef = useRef(playKey);
  playKeyRef.current = playKey;
  /* 地址缓存的 ref 镜像：预解析队列在异步回调里查「是否已有缓存」用，避免闭包过期 */
  const playUrlsRef = useRef(playUrls);
  playUrlsRef.current = playUrls;
  /* 预解析泵：同时最多 2 个 api.play 在飞，队列空了或都已有缓存就收 */
  pumpPrefetchRef.current = () => {
    const st = playPrefetchRef.current;
    while (st.inflight < 2 && st.queue.length > 0) {
      const job = st.queue.shift()!;
      if (playUrlsRef.current[job.key]) continue;
      st.inflight += 1;
      api.play(job.id, job.ep)
        .then((info) => {
          const u = info?.streams?.main || info?.video_url;
          const h = info?.streams?.hevc || info?.video_url_hevc || "";
          if (u) setPlayUrls((m) => (m[job.key] ? m : { ...m, [job.key]: u }));
          if (h) setHevcUrls((m) => (m[job.key] ? m : { ...m, [job.key]: h }));
        })
        .catch(() => { /* 预解析失败静默：用户真切到时走正常解析路径 */ })
        .finally(() => { st.inflight -= 1; pumpPrefetchRef.current(); });
    }
  };

  // 等播放画面就绪再提示，启动动画/协议、加载失败和其他面板不叠加教程。
  useEffect(() => {
    const retry = () => {
      setErr("");
      setWaiting(true);
      // Resolved media is retried in VideoSurface. Only an unresolved API call
      // needs another lookup, so a working stream keeps its episode and position.
      if (!playUrl) setProxyRetry(value => value + 1);
    };
    window.addEventListener("hg:proxy-changed", retry);
    return () => window.removeEventListener("hg:proxy-changed", retry);
  }, [playUrl]);

  /* ── 卡顿自愈（2.0.5） ────────────────────────────────────
   * 各线路只是 API 前门、媒体 CDN 大体同源，逐线测分片测到的是自家网络噪声；
   * 真正要治的是「当前这条播放链的分片吞吐持续跟不上」：最近 3 片吞吐都低于
   * 码率（拿不到码率时用单片耗时 > 片时长判慢）且刚发生过 waiting，才触发。
   * 动作：pickLine("stall", true) 重新选线；若真的切了线（hg:line-changed），
   * 把当前集地址缓存清掉走既有解析 effect 重解析一次（换 CDN 落点）并接回
   * 播放位置。护栏：全局间隔 ≥90s、同集 ≤2 次、手动暂停不触发；pickLine
   * 内部另有 15s 冷却与防重入，且自动选线被用户关掉时它自身就是 no-op。 */
  const maybeHealStall = () => {
    if (isDesktop || !active) return;
    const v = videoRef.current?.el();
    if (!v || paused || v.paused || v.ended) return;
    const now = Date.now();
    if (!lastStallAtRef.current || now - lastStallAtRef.current > 30_000) return;
    const hs = healStateRef.current;
    if (now - hs.lastAt < 90_000) return;
    if ((hs.counts[playKey] || 0) >= 2) return;
    hs.lastAt = now;
    hs.counts[playKey] = (hs.counts[playKey] || 0) + 1;
    hs.pendingKey = playKey;
    hs.pendingAt = now;
    const rates = fragWindowRef.current.map((w) => Math.round(w.kbps)).join("/");
    fragWindowRef.current = [];
    lastStallAtRef.current = 0;
    tracePlayback("line.stallHeal", { stage: "trigger", video_id: curId, episode: curEp, frag_kbps: rates, heal_count: hs.counts[playKey] });
    void pickLine("stall", true).then(() => {
      // 切线事件在 pickLine 内部同步派发，走到这里还没被消费 = 没切成，清掉待办防误伤后续手动切线
      if (healStateRef.current.pendingKey === playKey) healStateRef.current.pendingKey = null;
    });
  };

  const onFragStats = (s: { bytes: number; loadMs: number; fragDuration: number; bitrate: number }) => {
    if (isDesktop || !active) return;
    const loadSec = s.loadMs / 1000;
    if (loadSec <= 0 || s.bytes <= 0) return;
    const kbps = (s.bytes * 8) / loadSec / 1000;
    const slow = s.bitrate > 0 ? kbps < s.bitrate / 1000 : s.fragDuration > 0 && loadSec > s.fragDuration;
    const win = fragWindowRef.current;
    win.push({ slow, kbps });
    if (win.length > 3) win.shift();
    if (win.length === 3 && win.every((w) => w.slow)) maybeHealStall();
  };

  /* 切线落地后重解析当前集：清掉本集缓存地址，借 proxyRetry 递增重跑既有
     「拉播放地址」effect（与 hg:proxy-changed 的重试同一条路径），新地址喂给
     VideoSurface 后 src 变化自然重载；位置靠 healResumeRef 在 onDuration 里接回 */
  useEffect(() => {
    const onLineChanged = () => {
      const hs = healStateRef.current;
      if (!hs.pendingKey || Date.now() - hs.pendingAt > 60_000) return;
      const key = hs.pendingKey;
      hs.pendingKey = null;
      if (key !== playKeyRef.current) return;
      const v = videoRef.current?.el();
      const t = v && Number.isFinite(v.currentTime) ? v.currentTime : 0;
      if (t > 1) healResumeRef.current = { key, t };
      tracePlayback("line.stallHeal", { stage: "re-resolve", key, resume_t: Math.round(t * 10) / 10 });
      setPlayUrls((m) => { if (!m[key]) return m; const n = { ...m }; delete n[key]; return n; });
      setHevcUrls((m) => { if (!m[key]) return m; const n = { ...m }; delete n[key]; return n; });
      setErr("");
      setProxyRetry((n) => n + 1);
    };
    window.addEventListener("hg:line-changed", onLineChanged);
    return () => window.removeEventListener("hg:line-changed", onLineChanged);
  }, []);
  useEffect(() => { setZoom({ s: 1, x: 0, y: 0, g: false }); pinchRef.current = null; pointersRef.current.clear(); }, [playUrl]);
  useEffect(() => { videoRef.current?.trace("page.active", { active, view: mode, video_id: curId, episode: curEp }); }, [active, mode, curId, curEp]);
  const episodes = detail?.episodes || [];
  const post = posts[curId];

  /* 观看进度：onTime 里每 5 秒落一次；退出播放页时再用 liveRef 兜一次 */
  const onTimeTick = (t: number) => {
    if (!isCurrentPlayback()) return;
    // Keep the writer from this observation; a later clear must invalidate old cleanup data.
    if (active) historyWriter.current = addHistory;
    liveRef.current = { id: curId, ep: curEp, dur: duration, t, permissionKey, accountScope };
    playbackClock.publish(t);
    const now = Date.now();
    if (duration > 0 && now - lastSaveRef.current > 5000) {
      lastSaveRef.current = now;
      if (kind === "video" && active) addHistory(curId, curEp, t, duration);
    }
  };

  /* 拿到时长后再续播：只对进入时那一条生效，且不跳到片尾 */
  const onDurationTick = (d: number) => {
    if (!isCurrentPlayback()) return;
    setDuration(d);
    liveRef.current = { id: curId, ep: curEp, dur: d, t: historyWriter.current === addHistory && liveRef.current.id === curId && liveRef.current.ep === curEp && liveRef.current.accountScope === accountScope ? liveRef.current.t : 0, permissionKey, accountScope };

    /* 卡顿自愈重解析后的新源：把触发前的位置接回去（与下方历史续播同机制） */
    const hr = healResumeRef.current;
    if (hr && hr.key === playKey && hr.t > 1 && (!d || hr.t < d - 3)) {
      healResumeRef.current = null;
      videoRef.current?.seek(hr.t, "stall_heal");
      playbackClock.publish(hr.t);
    }
    const r = resumeRef.current;
    if (r && r.key === playKey && r.t > 1 && (!d || r.t < d - 3)) {
      resumeRef.current = null;
      videoRef.current?.seek(r.t, "history_resume");
      playbackClock.publish(r.t);
    }
  };

  /** 统一视图模型：短剧与吃瓜帖子共用同一套播放界面 */
  const meta = kind === "post"
    ? {
        title: post?.title || "",
        cover: post?.cover || "",
        desc: post?.content || post?.desc || "",
        author: "吃瓜",
        authorId: -1,
        tags: post?.tags || [],
        score: 0,
        like: 0,
        comment: post?.counts?.comment ?? 0,
        collect: 0,
        episodes: [] as Episode[],
      }
    : {
        title: detail?.title || "",
        cover: detail?.cover?.trim() || "",
        desc: detail?.description || "",
        author: detail?.author?.name || "HGhubX",
        authorId: detail?.author?.id || -1,
        tags: detail?.tags || [],
        score: detail?.score || 0,
        like: detail?.counts?.like ?? 0,
        comment: detail?.counts?.comment ?? 0,
        collect: detail?.counts?.collect ?? 0,
        episodes: detail?.episodes || [],
      };

  const posterUrl = cover(meta.cover, 900);
  const articleHtml = kind === "post" && !post?.video_url ? (post?.content || "") : "";

  /* 倍速：任意位置长按只作临时 2.0x、松手恢复（2.1.1 起删除上游分区长按）；基准倍速由底栏菜单选定 */
  const effRate = holdSpeed ? 2 : rate;
  /* 进度条显示百分比（拖动时用拖动值） */
  const barProgress = barPct ?? (duration ? playbackClock.getSnapshot() / duration : 0);
  const landscapeVideo = vsize.w > 0 && vsize.h > 0 && vsize.w > vsize.h;
  /* Muse 2026-11-15 (2.1.2): 全屏方向跟着源走（用户最终定版）——横屏源全屏即横屏、竖屏源全屏即竖屏，
     不给手动旋转钮、不要 override。判定只认 video 元素真实宽高（vsize 由 VideoSurface 的
     loadedmetadata/resize 回报 + 进全屏时直读元素播种 + 全屏期间监听复判，见 enterFs 与下方 effect）。
     呈现两条路：原生方向请求（下方统一 effect 按 landscapeVideo 驱动，换源复判）；
     请求未生效（系统竖排锁定等）且源为横屏时 CSS 转 90° 兜底（rotated）。竖屏源不转，fs-immersive 竖屏呈现。
     全屏一律 contain 居中，不裁切放大（fit 在渲染处按 fs 强制 contain）。 */
  const rotated = !isDesktop && fs && !vpLandscape && landscapeVideo;
  /* 竖屏快捷胶囊的显隐：不卸载、只改 opacity，这样淡入淡出都能过渡（#19） */
  const capsuleOn = !fs && !clean && !isDesktop && (landscapeVideo || zoom.s > 1.05);

  /* ── 上下划切集 ──────────────────────────────────────────
   * 「上下划切集」开启时，播放区 overlay 的 touch-action 是 none，
   * 原生滚动不参与：上/下划手势在抬手时一次性判定——
   * 有上一/下一集就切集；没有就切上一/下一部剧。
   * 关闭时保持原生滚动，停稳 150ms 后按所在屏切剧。
   */
  const idxRef = useRef(index);
  idxRef.current = index;
  const anchoredScroll = useRef<number | null>(null);
  useLayoutEffect(() => {
    const id = effectiveVideoIds[index];
    if (id !== undefined && (position.id !== id || position.index !== index)) {
      setPosition({ id, index }); setRenderIndex(index);
    }
    // The scroll container is recreated after the tag gate/one-time prompt.
    // Anchor by content ID before paint, including a nonzero starting position.
    if (boxRef.current) {
      const top = index * (boxRef.current.clientHeight || 1);
      if (Math.abs(boxRef.current.scrollTop - top) > 1) {
        anchoredScroll.current = top;
        boxRef.current.scrollTop = top;
      }
    }
  }, [effectiveVideoIds, index, position.id, position.index, allowed]);
  const swipeTimer = useRef(0);

  const resolveSwipe = useCallback((target: number) => {
    const prev = idxRef.current;
    if (target === prev) return;
    idxRef.current = target;
    setIndex(target);
  }, []);

  /* 滚动定位 */
  const onScroll = useCallback(() => {
    if (fs || pinchRef.current) return;
    const el = boxRef.current;
    if (!el) return;
    if (anchoredScroll.current !== null) {
      const top = anchoredScroll.current;
      anchoredScroll.current = null;
      if (Math.abs(el.scrollTop - top) <= 1) return;
    }
    const h = el.clientHeight || 1;
    const i = Math.max(0, Math.min(effectiveVideoIds.length - 1, Math.round(el.scrollTop / h)));
    if (renderIndex !== i) setRenderIndex(i);
    if (onNearEnd && mode === "home" && i >= effectiveVideoIds.length - 3) onNearEnd();
    window.clearTimeout(swipeTimer.current);
    swipeTimer.current = window.setTimeout(() => resolveSwipe(i), 150);
  }, [effectiveVideoIds.length, onNearEnd, resolveSwipe, fs, mode, renderIndex]);

  const go = useCallback((delta: number) => {
    const el = boxRef.current;
    if (!el) return;
    const next = Math.max(0, Math.min(effectiveVideoIds.length - 1, index + delta));
    el.scrollTo({ top: next * el.clientHeight, behavior: "smooth" });
  }, [index, effectiveVideoIds.length]);

  /* 统一的上下切换：swipeEp 开启且为多集视频时优先切集，否则切剧。
     桌面端键盘 ↑↓ 与右侧按钮都走这里，和移动端上下划手势保持一致。 */
  const stepDir = useCallback((dir: number) => {
    if (swipeEp && kind === "video") {
      const ep = epMap[curId] || 1;
      const total = episodes.length;
      const want = dir === 1 ? (total === 0 || ep < total ? ep + 1 : 0) : (ep > 1 ? ep - 1 : 0);
      if (want) {
        setEpMap((m) => ({ ...m, [curId]: want }));
        setPanel(null);
        return;
      }
    }
    go(dir);
  }, [swipeEp, kind, epMap, curId, episodes.length, go]);

  const canStep = (dir: number) => {
    if (swipeEp && kind === "video") {
      const ep = epMap[curId] || 1;
      const total = episodes.length;
      if (dir === 1 ? (total === 0 || ep < total) : ep > 1) return true;
    }
    const next = index + dir;
    return next >= 0 && next < effectiveVideoIds.length;
  };

  /* With filtering enabled, details are the gate: no media is requested before tags settle. */
  useEffect(() => {
    if (!active) return;
    const epoch = store.lineEpoch;
    const candidates = filtering
      ? [effectiveVideoIds[index], effectiveVideoIds[index + 1], effectiveVideoIds[index - 1]]
      : [effectiveVideoIds[index]];
    const need = candidates.filter((id): id is number => id !== undefined);
    need.forEach(id => {
      const key = `${accountScope}:${epoch}:${kind}:${id}`;
      if (checked[key] || tagErrors[key]) return;
      const request = kind === "post" ? api.post(id) : requestDetail(id);
      request.then(value => {
        if (!mounted.current || actionContext.current.accountScope !== accountScope || actionContext.current.lineEpoch !== epoch) return;
        if (!value) {
          setTagErrors(previous => ({ ...previous, [key]: "标签暂不可用，请重试" }));
          return;
        }
        if (kind === "post") setPosts(previous => ({ ...previous, [id]: value as Post }));
        else setDetails(previous => ({ ...previous, [id]: value as Detail }));
        setTagErrors(previous => { const next = { ...previous }; delete next[key]; return next; });
        setChecked(previous => ({ ...previous, [key]: true }));
      }).catch(error => {
        if (mounted.current && actionContext.current.accountScope === accountScope && actionContext.current.lineEpoch === epoch) {
          setTagErrors(previous => ({ ...previous, [key]: error instanceof Error ? error.message : "标签暂不可用，请重试" }));
        }
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, kind, index, effectiveVideoIds, proxyRetry, store.lineEpoch, accountScope, checked, tagErrors, requestDetail, filtering]);

  /* 封面预加载（2.0.6）：与详情预取同窗口（当前 / +1…+4 / −1）。
     URL 用 cover() 拼装，与 Img 组件逐字一致 → 命中 Rust IMG_CACHE，
     快速连翻时每条都有封面，不再先露灰底骨架 */
  useEffect(() => {
    const st = coverWarmRef.current;
    const ids = [0, 1, 2, 3, 4, -1].map((d) => effectiveVideoIds[index + d]).filter(Boolean);
    for (const id of ids) {
      const raw = details[id]?.cover || posts[id]?.cover || "";
      if (!raw || st.done.has(raw)) continue;
      st.done.add(raw);
      const img = new window.Image();
      const release = () => { const i = st.hold.indexOf(img); if (i >= 0) st.hold.splice(i, 1); };
      img.onload = release;
      img.onerror = release;
      img.src = cover(raw);
      st.hold.push(img);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [details, posts, index, effectiveVideoIds]);

  /* 相关推荐只在用户打开详情时拉取，避免和首播抢占网络。 */
  useEffect(() => {
    if (!active || !curId || kind !== "video" || !allowed || panel !== "detail" || relatedByVideo[relatedKey]) return;
    const id = curId;
    api.related(id).then((r) => {
      if (mounted.current) setRelatedByVideo(previous => ({ ...previous, [relatedKey]: r?.items || [] }));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, curId, kind, allowed, panel, relatedKey, relatedByVideo]);

  /* 拉播放地址 */
  useEffect(() => {
    if (!active || !curId || !allowed) return;
    if (playUrls[playKey]) return;
    let alive = true;
    requestPlay(curId, curEp)
      .then((info) => {
        if (!alive || !isCurrentPlayback()) return;
        const streamUrl = info?.streams?.main || info?.video_url;
        const hevcStream = info?.streams?.hevc || info?.video_url_hevc || "";
        // 接口本身成功但业务失败（status=0 / streams 为空）时不会进 call() 的 catch，
        // 这里把原始 status/msg 落进 debug.log ——「暂无播放地址」的唯一现场证据。
        // src 才是真正喂给播放器的值；video_url 是新接口不再返回的旧字段，别拿它判断成败。
        const raw = info as unknown as Record<string, unknown>;
        const streams = (raw.streams ?? {}) as Record<string, unknown>;
        const streamKind = streams.main ? "main" : info?.video_url ? "video_url" : streams.hevc ? "hevc" : "-";
        let host = "?";
        try { host = new URL(streamUrl || "").host || "?"; } catch { /* 空地址或非 URL */ }
        logLine(
          `[play] id=${curId} ep=${curEp} src=${streamUrl ? "y" : "n"} kind=${streamKind} host=${host}` +
          (streamUrl ? "" : ` status=${String(raw.status ?? "?")} msg=${String(raw.msg ?? "")}`),
        );
        // 「暂无播放地址」的现场：接口成功但没给地址时，status/msg 是唯一证据。
        tracePlayback("play.resolve", {
          video_id: curId, episode: curEp, resolved: !!streamUrl, kind: streamKind, host,
          status: raw.status ?? null, msg: String(raw.msg ?? "") || null,
        });
        if (!streamUrl) throw new Error("暂无播放地址");
        setPlayUrls((m) => ({ ...m, [playKey]: streamUrl }));
        if (hevcStream) setHevcUrls((m) => ({ ...m, [playKey]: hevcStream }));
        if (kind === "video") addHistory(curId, curEp);
      })
      .catch((e) => { if (alive) setErr((e as Error).message || "取播放地址失败"); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, curId, curEp, proxyRetry, allowed, permissionKey, requestPlay]);

  /* 相邻条目地址预解析（2.0.6）：index 一变就发起不等落定，按距离从近到远排队
     （+1、−1、+2、+3、+4），并发上限 2；index 再变时队列整体换代，未发起的旧
     任务直接丢弃。快速连翻扫片时，停下来的那条地址多半已经解析好 */
  useEffect(() => {
    if (kind !== "video") return;
    const st = playPrefetchRef.current;
    st.gen += 1;
    st.queue = [];
    for (const d of [1, -1, 2, 3, 4]) {
      const id = effectiveVideoIds[index + d];
      if (!id) continue;
      const ep = epMap[id] || 1;
      const key = `${id}:${ep}`;
      if (playUrlsRef.current[key]) continue;
      st.queue.push({ id, ep, key });
    }
    pumpPrefetchRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, effectiveVideoIds, kind]);

  /* ── 下一条分片预热（2.0.6） ──────────────────────────────
   * 只热 index+1 的首分片，且要等用户在当前条目停留满 500ms（视为落定）才启动：
   * 连翻途中划过的条目不拉分片、不浪费流量。地址若在落定后才解析完，
   * 就绪时（settledIndex 仍等于 index）补启。 */
  const [settledIndex, setSettledIndex] = useState(-1);
  useEffect(() => {
    const t = window.setTimeout(() => setSettledIndex(index), 500);
    return () => window.clearTimeout(t);
  }, [index]);

  const nextId = effectiveVideoIds[index + 1];
  const nextEp = nextId ? epMap[nextId] || 1 : 1;
  const nextKey = nextId ? `${nextId}:${nextEp}` : "";
  const nextPlayUrl = nextId
    ? (preferHevc && hevcUrls[nextKey] ? hevcUrls[nextKey] : playUrls[nextKey] || "")
    : "";
  useEffect(() => {
    if (kind !== "video" || !nextId || !nextPlayUrl) return;
    if (settledIndex !== index) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    const warmKey = `${nextKey}|${nextPlayUrl}`;
    if (prewarmDoneRef.current.has(warmKey)) return;
    /* 让行闸（2.0.10）：当前条目还没起播或正在 waiting 时不启动分片预热——
       这个闸只管分片预热这一段最贵的，相邻地址预解析与封面预加载不受影响。
       最多等约 10 秒（每 700ms 复查），当前条目转健康后照常启动，没等到就放弃。
       预热已启动后当前条目转 waiting，由 onWaiting 里的 yield_abort 即时掐断。 */
    let cancelled = false;
    let timer = 0;
    let waits = 0;
    let skipped = false;
    let ac: AbortController | null = null;
    const attempt = () => {
      if (cancelled) return;
      if (!healthyRef.current) {
        if (!skipped) {
          skipped = true;
          tracePlayback("feed.prewarm", { video_id: nextId, stage: "yield_skip" });
        }
        if (++waits <= 15) timer = window.setTimeout(attempt, 700);
        return;
      }
      if (prewarmDoneRef.current.has(warmKey)) return;
      prewarmDoneRef.current.add(warmKey);
      const mine = new AbortController();
      ac = mine;
      prewarmCtlRef.current = { ac: mine, videoId: nextId };
      void prewarmFirstSegment(nextId, nextPlayUrl, mine.signal).finally(() => {
        if (prewarmCtlRef.current?.ac === mine) prewarmCtlRef.current = null;
      });
    };
    attempt();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      ac?.abort();
      if (ac && prewarmCtlRef.current?.ac === ac) prewarmCtlRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, nextId, nextKey, nextPlayUrl, settledIndex, index]);

  /* 剧集预热：相邻集提前取好播放地址，切集秒开 */

  /* 当前集拿到地址后再预取下一集，避免首帧加载期间争抢网络。 */
  useEffect(() => {
    if (!active || !curId || kind !== "video" || !allowed || playingKey !== playKey || episodes.length === 0) return;
    let alive = true;
    const ep = epMap[curId] || 1;
    const nextEpisode = ep + 1;
    if (nextEpisode > episodes.length) return;
    const key = `${curId}:${nextEpisode}`;
    if (playUrls[key]) return;
    requestPlay(curId, nextEpisode)
      .then((info) => {
        if (!alive || !playGuard.current.allowed || playGuard.current.permissionKey !== permissionKey) return;
        const u = info?.streams?.main || info?.video_url;
        const h = info?.streams?.hevc || info?.video_url_hevc || "";
        if (u) setPlayUrls((m) => ({ ...m, [key]: u }));
        if (h) setHevcUrls((m) => ({ ...m, [key]: h }));
      })
      .catch(() => { /* 预热失败不影响当前播放 */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, curId, curEp, episodes.length, allowed, permissionKey, playingKey, playKey, requestPlay]);

  /* 当前视频首帧请求完成后，再验证并预取下一部，屏蔽规则始终先于播放地址。 */
  useEffect(() => {
    const nextId = nextVideoId;
    if (!active || !curId || !nextId || kind !== "video" || !allowed || playingKey !== playKey) return;
    let alive = true;
    const currentId = curId;
    const currentPermission = permissionKey;
    const nextKey = `${nextId}:1`;
    if (playUrls[nextKey]) return;
    const stillRelevant = () => alive && mounted.current && playGuard.current.id === currentId
      && playGuard.current.permissionKey === currentPermission && idsRef.current[index + 1] === nextId;
    void (async () => {
      try {
        const nextDetail = detailsRef.current[nextId] || await requestDetail(nextId);
        if (!stillRelevant()) return;
        if (!detailsRef.current[nextId]) {
          setDetails(previous => ({ ...previous, [nextId]: nextDetail }));
          setChecked(previous => ({ ...previous, [`${accountScope}:${store.lineEpoch}:${kind}:${nextId}`]: true }));
        }
        if (filtering && blockReason(nextDetail.tags)) {
          if (mode === "home") onBlocked?.(nextId);
          return;
        }
        const info = await requestPlay(nextId, 1);
        if (!stillRelevant()) return;
        const url = info?.streams?.main || info?.video_url;
        const hevc = info?.streams?.hevc || info?.video_url_hevc || "";
        if (url) setPlayUrls(previous => ({ ...previous, [nextKey]: url }));
        if (hevc) setHevcUrls(previous => ({ ...previous, [nextKey]: hevc }));
      } catch {
        // The next item resolves normally when selected.
      }
    })();
    return () => { alive = false; };
  }, [active, curId, index, nextVideoId, kind, mode, allowed, playingKey, playKey, playUrls[`${nextVideoId}:1`], permissionKey, accountScope, store.lineEpoch, filtering, blockReason, onBlocked, requestDetail, requestPlay]);

  /* 切换条目/集数时重置播放状态 */
  useEffect(() => {
    setDuration(0); setErr(""); setWaiting(true); setPaused(false);
    healthyRef.current = false;

    setPlayingKey("");    playbackClock.publish(0);
    setVsize({ w: 0, h: 0 });
    setPortraitFit("contain");
    /* 自愈监测窗口按集重置（每集的触发次数记在 healStateRef.counts 里，不在此清） */
    fragWindowRef.current = [];
    lastStallAtRef.current = 0;
  }, [playKey]);

  /* 音量/静音同步 */
  useEffect(() => { videoRef.current?.mute(muted); }, [muted]);
  useEffect(() => { videoRef.current?.volume(volume); }, [volume]);
  /* 倍速同步（长按临时 2x / 基准倍速） */
  useEffect(() => { videoRef.current?.rate(effRate); }, [effRate, playKey]);

  /* 离开播放页时把最后位置落盘 */
  useEffect(() => () => {
    const s = liveRef.current;
    if (kind === "video" && s.id && s.dur && playGuard.current.allowed && playGuard.current.id === s.id
      && actionContext.current.accountScope === s.accountScope
      && playGuard.current.playKey === `${s.id}:${s.ep}` && playGuard.current.permissionKey === s.permissionKey) historyWriter.current(s.id, s.ep, s.t, s.dur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 键盘 */
  useEffect(() => {
    if (!active || !allowed) return;
    const seekRelative = (delta: number) => {
      const current = videoRef.current?.el()?.currentTime ?? 0;
      videoRef.current?.seek(Math.max(0, current + delta), "keyboard_shortcut");
    };
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (panel) { if (e.key === "Escape") setPanel(null); return; }
      switch (e.key) {
        case "ArrowDown": e.preventDefault(); stepDir(1); break;
        case "ArrowUp": e.preventDefault(); stepDir(-1); break;
        case " ": e.preventDefault(); videoRef.current?.toggle(); break;
        case "ArrowLeft": e.preventDefault(); seekRelative(-5); break;
        case "ArrowRight": e.preventDefault(); seekRelative(5); break;
        case "f": case "F": toggleFull(); break;
        case "t": case "T": setTheater((v) => !v); break;
        case "m": case "M": setMuted((v) => !v); break;
        case "l": case "L": onLike(); break;
        case "s": case "S": onFav(); break;
        case "c": case "C": setPanel("comments"); break;
        case "e": case "E": setPanel("episodes"); break;
        default: break;
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, allowed, panel, index, stepDir, accountScope, curEp, kind, liked, collected, likePending, collectPending]);

  /* 安卓返回键：面板打开时先关面板 */
  useEffect(() => {
    if (!panel) { setBackHandler(null); return undefined; }
    setBackHandler(() => { setPanel(null); return true; });
    return () => setBackHandler(null);
  }, [panel]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleFull = () => {
    const el = boxRef.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen().catch(() => {});
  };

  /* —— 长按 2x（上滑锁定） / 横拖定位 / 单击暂停 —— */
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDesktop || !active) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      const pts = [...pointersRef.current.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      pinchRef.current = {
        d0: d,
        mx0: (pts[0].x + pts[1].x) / 2,
        my0: (pts[0].y + pts[1].y) / 2,
        s0: zoom.s,
        x0: zoom.x,
        y0: zoom.y,
      };
      if (gesture.current?.timer) window.clearTimeout(gesture.current.timer);
      gesture.current = null;
      if (holdRef.current) { holdRef.current = false; setHoldSpeed(false); }
      setZoom((z) => ({ ...z, g: true }));
      return;
    }
    if (gesture.current || e.button !== 0) return;
    const el = e.currentTarget;
    const width = el.clientWidth || 1;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const g = {
      x: e.clientX, y: e.clientY, startY: e.clientY, t: Date.now(), base: videoRef.current?.el()?.currentTime ?? playbackClock.getSnapshot(), width,
      mode: "idle" as "idle" | "hold" | "scrub" | "pan",
      playing: videoRef.current?.el()?.paused === false,
      /* Muse 2026-11-15 (2.1.1): 长按不分区——任意位置按住 380ms 进入临时倍速，不弹菜单、不改控制层显隐 */
      timer: window.setTimeout(() => {
        const cur = gesture.current;
        if (!cur || cur.mode !== "idle") return;
        cur.mode = "hold";
        holdRef.current = true;
        setHoldSpeed(true);
        try { navigator.vibrate?.(25); } catch { /* ignore */ }
      }, 380) as unknown as number,
    };
    if (!isDesktop && fs && !lastTapRef.current.timer) {
      /* 全屏单击切换显隐以「手势开始前」的控制层状态为准：本 handler 在冒泡上先于
         root 的 pointerdown wake()（它会抢先 setIdle(false)），故在此存快照；
         双击窗口内（已有待执行的翻转计时）不覆盖，保留首击的快照（2.0.3） */
      lastTapRef.current.clean = clean;
      lastTapRef.current.idle = idle;
    }
    gesture.current = g;
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    const p = pinchRef.current;
    if (p && pointersRef.current.size >= 2) {
      const pts = [...pointersRef.current.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const mx = (pts[0].x + pts[1].x) / 2;
      const my = (pts[0].y + pts[1].y) / 2;
      const s = Math.min(4, Math.max(1, p.s0 * (d / p.d0)));
      setZoom({ s, x: p.x0 + (mx - p.mx0), y: p.y0 + (my - p.my0), g: true });
      return;
    }
    const g = gesture.current;
    if (!g || isDesktop) return;
    /* Muse 2026-11-15 (2.1.2): 手势按「视觉坐标」解释——CSS 旋转兜底生效时（rotated，舞台转 90°），
       屏幕坐标与视觉坐标轴互换：视觉横向 = 屏幕纵向位移，视觉上滑 = 屏幕右滑。
       原生真横屏（vpLandscape）时窗口坐标与视觉一致，不换算。不换算的话横屏里横拖会切集、竖拖会快进，全反。 */
    const sdx = e.clientX - g.x;
    const sdy = e.clientY - g.y;
    const dx = rotated ? sdy : sdx;
    const dy = rotated ? -sdx : sdy;

    /* 长按临时倍速中：移动全部吞掉（不切集、不拖进度） */
    if (g.mode === "hold") return;

    if (g.mode === "idle") {
      if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy)) {
        if (g.timer) window.clearTimeout(g.timer);
        g.mode = "scrub";
        videoRef.current?.pause();
      } else if (Math.abs(dy) > 14) {
        if (g.timer) window.clearTimeout(g.timer);
        g.mode = "pan";
      }
      return;
    }

    if (g.mode === "scrub") {
      const total = duration || 0;
      if (!total) return;
      const target = Math.max(0, Math.min(total, g.base + (dx / g.width) * total));
      scrubTarget.current = target;
      setScrub({ pct: (target / total) * 100, target });
    }
  };

  const onUp = (cancelled = false, e?: React.PointerEvent<HTMLDivElement>) => {
    if (e) pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2 && pinchRef.current) {
      pinchRef.current = null;
      // 松手后小于 1.05x 就归位，避免残留"歪着"的画面
      setZoom((z) => (z.s < 1.05 ? { s: 1, x: 0, y: 0, g: false } : { s: z.s, x: z.x, y: z.y, g: false }));
    }
    const g = gesture.current;
    gesture.current = null;
    /* 长按状态必须无条件复位：切集 / 组件重建会把手势对象清掉，
       但 holdRef 若留在 true，下面的 touchmove 会一直 preventDefault，
       整个列表就再也滑不动（表现为「播放后不能上滑」）。 */
    if (holdRef.current) { holdRef.current = false; setHoldSpeed(false); }
    if (!g) return;
    if (g.timer) window.clearTimeout(g.timer);

    if (g.mode === "hold") {
      holdRef.current = false;
      setHoldSpeed(false);
      return;
    }
    if (g.mode === "scrub") {
      const target = scrubTarget.current;
      if (!cancelled && target != null) videoRef.current?.seek(target, "mobile_gesture");
      setScrub(null);
      scrubTarget.current = null;
      if (g.playing && active) videoRef.current?.play();
      return;
    }
    /* 上下划手势（overlay 恒 touch-action:none，原生滚动不参与，这里抬手一次性判定）
       Muse 2026-11-15 (2.1.2): 移动端不再读 swipeEp 开关——右侧栏「切集」钮及其模式开关已删，
       竖滑语义恒定：多集先切集、到头切剧。不存在「先点钮进模式再滑」的中间状态。 */
    if (!cancelled && e && g.mode === "pan") {
      /* 同 onMove：按视觉坐标判定（rotated 时轴互换）——横屏里视觉上滑切下一集、视觉下滑切上一集 */
      const sdy = e.clientY - g.startY;
      const sdx = e.clientX - g.x;
      const dy = rotated ? -sdx : sdy;
      const dx2 = rotated ? sdy : sdx;
      if (Math.abs(dy) > 56 && Math.abs(dy) > Math.abs(dx2)) {
        const dir = dy < 0 ? 1 : -1;
        const ep = epMap[curId] || 1;
        const total = episodes.length;
        const want = dir === 1 ? (total === 0 || ep < total ? ep + 1 : 0) : (ep > 1 ? ep - 1 : 0);
        if (kind === "video" && want) {
          setEpMap((m) => ({ ...m, [curId]: want }));
          toast(`第 ${want}集${total ? ` / ${total}` : ""}`, "info");
          try { navigator.vibrate?.(12); } catch { /* ignore */ }
          return;
        }
        go(dir);
        return;
      }
    }
    if (!cancelled && g.mode === "idle" && Date.now() - g.t < 260 && Date.now() - srMenuDismissedAtRef.current >= 320 && Date.now() - rateMenuDismissedAtRef.current >= 320) {
      const mobileFs = !isDesktop && fs;
      if (mobileFs) {
        /* 2.0.3（用户要求）：移动端全屏控制层改为单击切换显隐、不再自动隐藏。
           翻转以 onDown 存的「手势开始前」快照为准（pointerdown 的 wake() 会抢先
           setIdle(false)，按当前值翻转会重蹈原版「点一下永远关」）；首击等双击
           窗口（230ms）无第二击才执行翻转，第二击取消翻转、恢复快照并只切播放。 */
        if (lastTapRef.current.timer) {
          window.clearTimeout(lastTapRef.current.timer);
          lastTapRef.current.timer = null;
          setClean(lastTapRef.current.clean ?? clean);
          setIdle(lastTapRef.current.idle ?? idle);
          videoRef.current?.toggle();
        } else {
          const snapIdle = lastTapRef.current.idle ?? idle;
          lastTapRef.current.timer = window.setTimeout(() => {
            lastTapRef.current.timer = null;
            if (gesture.current || !fsRef.current) return;
            const wasHidden = snapIdle === true;
            setIdle(!wasHidden);
            setClean(!wasHidden);
          }, 230) as unknown as number;
        }
      } else if (lastTapRef.current.timer) {
        // 非全屏（原行为不变）：首击已立即翻转，第二击恢复首击前的界面，再切换播放。
        window.clearTimeout(lastTapRef.current.timer);
        lastTapRef.current.timer = null;
        setClean(lastTapRef.current.clean ?? false);
        if (!isDesktop && fs) setIdle(lastTapRef.current.idle ?? false);
        videoRef.current?.toggle();
      } else {
        lastTapRef.current.clean = clean;
        lastTapRef.current.idle = idle;
        setClean(!clean);
        if (!isDesktop && fs) setIdle(!idle);
        lastTapRef.current.timer = window.setTimeout(() => {
          lastTapRef.current.timer = null;
        }, 230) as unknown as number;
      }
    }
  };

  useEffect(() => {
    if (!active) {
      setPanel(null);
      onUp(true);
      pointersRef.current.clear();
      pinchRef.current = null;
      if (lastTapRef.current.timer) window.clearTimeout(lastTapRef.current.timer);
      lastTapRef.current.timer = null;
    }
    // Cancel pending gestures when the page is hidden or controls are locked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => () => {
    if (gesture.current?.timer) window.clearTimeout(gesture.current.timer);
    if (lastTapRef.current.timer) window.clearTimeout(lastTapRef.current.timer);
    lastTapRef.current.timer = null;
    gesture.current = null;
    holdRef.current = false;
  }, [playKey]);

  /* 进出全屏：iOS 会在这时把播放打断，过渡期多补几次 play() */
  const keepAlive = useCallback(() => {
    for (const t of keepAliveTimers.current) window.clearTimeout(t);
    keepAliveTimers.current = [];
    for (const delay of [50, 150, 300, 500, 800, 1200]) {
      keepAliveTimers.current.push(window.setTimeout(() => {
        const v = videoRef.current?.el();
        if (v && v.paused) videoRef.current?.play();
      }, delay) as unknown as number);
    }
  }, []);

  /* Muse 2026-11-15 (2.1.2): enterFs 不再收方向参数——方向由源决定：
     进入瞬间直读 video 元素真实宽高播种 vsize（不等异步回填），原生请求由下方统一 effect
     按 landscapeVideo 发出；exitFs 统一发竖屏请求撤销回刷流原状。
     旧版判定失效的根因也在这里一并修：原 enterFs 的方向参数来自闭包里的 vsize 快照，
     切集时 vsize 被清零、回填靠媒体事件赛跑，抢先点全屏就拿到 0/旧值判成竖屏。 */
  const enterFs = useCallback(() => {
    /* 先把当前可见项锁定下来，再收起滚动容器：
       否则进入全屏后 scrollTop 归零，若此前滚动后的 index 还在 150ms 防抖里，
       会被 resolveSwipe(0) 改回第一屏，出现「全屏后变成另一个视频」。 */
    const el = boxRef.current;
    if (el && !isDesktop) {
      window.clearTimeout(swipeTimer.current);
      const h = el.clientHeight || 1;
      const i = Math.max(0, Math.min(effectiveVideoIds.length - 1, Math.round(el.scrollTop / h)));
      if (i !== idxRef.current) resolveSwipe(i);
    }
    /* Muse 2026-11-15 (2.1.2): 全屏 = 纯净模式（用户定版）——进全屏默认全隐（idle+clean 置隐），
       只看视频；单击呼出控制层、再单击收起（沿用 2.0.3 单击翻转）。所以这里不调 wake()（它会亮出控制层）。 */
    setClean(true);
    setIdle(true);
    /* 播种真实宽高：第一帧判定就有据可依（元素还没元数据时播种失败，
       由下方全屏监听 effect 在 loadedmetadata 后复判补上） */
    if (!isDesktop) {
      const v = videoRef.current?.el();
      if (v && v.videoWidth > 0 && v.videoHeight > 0) {
        setVsize((prev) => (prev.w === v.videoWidth && prev.h === v.videoHeight ? prev : { w: v.videoWidth, h: v.videoHeight }));
      }
    }
    setFs(true);
    fsRef.current = true;
    keepAlive();
  }, [isDesktop, keepAlive, resolveSwipe, effectiveVideoIds.length, setClean, setFs]);

  const exitFs = useCallback(() => {
    setClean(false);
    setFs(false);
    fsRef.current = false;
    keepAlive();
    if (!isDesktop) {
      try { void invoke("set_orientation", { landscape: false }); } catch { /* ignore */ }
      try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
    }
  }, [isDesktop, keepAlive, setClean, setFs]);

  /* Muse 2026-11-15 (2.1.2): 全屏方向的原生请求统一由 landscapeVideo 驱动——
     进全屏、切集/换集（playKey 变）、元数据迟到回填，任一让判定翻转都会在这里复判并重发请求，
     横屏源发 landscape、竖屏源发 portrait，不再散落在 enterFs/胶囊/侧栏各发各的。 */
  useEffect(() => {
    if (isDesktop || !fs) return;
    try { void invoke("set_orientation", { landscape: landscapeVideo }); } catch { /* ignore */ }
  }, [isDesktop, fs, landscapeVideo]);

  /* Muse 2026-11-15 (2.1.2): 全屏期间给当前 video 元素挂 loadedmetadata/resize 监听复判宽高——
     VideoSurface 的 onSize 回报若因切集守卫被丢弃，这里直读元素兜底，保证判定永远以真实宽高为准。 */
  useEffect(() => {
    if (isDesktop || !fs) return undefined;
    const v = videoRef.current?.el();
    if (!v) return undefined;
    const read = () => {
      if (v.videoWidth > 0 && v.videoHeight > 0) {
        setVsize((prev) => (prev.w === v.videoWidth && prev.h === v.videoHeight ? prev : { w: v.videoWidth, h: v.videoHeight }));
      }
    };
    read();
    v.addEventListener("loadedmetadata", read);
    v.addEventListener("resize", read);
    return () => {
      v.removeEventListener("loadedmetadata", read);
      v.removeEventListener("resize", read);
    };
  }, [isDesktop, fs, playKey]);

  /* 系统真旋转了（iOS 原生请求成功后），CSS 就不再转 90°；
     物理横置手机时自动进入全屏，竖回时自动退出全屏（对齐 LNPANDY 版）。 */
  useEffect(() => {
    if (isDesktop) return undefined;
    const onViewportChange = () => {
      const isLand = window.innerWidth > window.innerHeight;
      setVpLandscape((prev) => {
        if (prev !== isLand && active) {
          setFs(isLand);
          /* 物理旋转进/出全屏与按钮路径保持同一状态：进全屏纯净全隐、竖回恢复浏览态 chrome */
          if (isLand) { setClean(true); setIdle(true); } else { setClean(false); setIdle(false); }
          keepAlive();
        }
        return isLand;
      });
    };
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("orientationchange", onViewportChange);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("orientationchange", onViewportChange);
    };
  }, [isDesktop, active, setFs, keepAlive]);

  /* 全屏切换或视口旋转后校准滚动容器 scrollTop：
     - 进入全屏时非当前项已隐藏，当前项位于顶部 scrollTop = 0；
     - 退出全屏回到竖屏列表时，立即把 scrollTop 对齐到 index * clientHeight，
       防止错位到其它视频封面（「横屏播放变成别的剧集」的根因）。 */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    if (fs) {
      el.scrollTop = 0;
      return undefined;
    }
    const syncScroll = () => {
      const box = boxRef.current;
      if (!box || fs) return;
      box.scrollTop = index * (box.clientHeight || 1);
    };
    syncScroll();
    const raf = requestAnimationFrame(syncScroll);
    const t1 = window.setTimeout(syncScroll, 120);
    const t2 = window.setTimeout(syncScroll, 350);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [fs, vpLandscape, index]);

  useEffect(() => () => {
    for (const t of keepAliveTimers.current) window.clearTimeout(t);
    keepAliveTimers.current = [];
  }, []);


  /* 长按倍速期间禁止原生滚动，否则上滑会被列表吃掉、长按手势被打断 */
  useEffect(() => {
    if (isDesktop) return undefined;
    const el = boxRef.current;
    if (!el) return undefined;
    const fn = (e: TouchEvent) => { if (holdRef.current && gesture.current?.mode === "hold") e.preventDefault(); };
    el.addEventListener("touchmove", fn, { passive: false });
    return () => el.removeEventListener("touchmove", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop, effectiveVideoIds.length]);

  /* —— 进度条拖动（旋转舞台下按 Y 轴换算） —— */
  const barPctAt = (clientX: number, clientY: number) => {
    const r = barRef.current?.getBoundingClientRect();
    if (!r) return null;
    const span = rotated ? r.height : r.width;
    if (!span) return null;
    const raw = rotated ? (clientY - r.top) / span : (clientX - r.left) / span;
    return Math.max(0, Math.min(1, raw));
  };
  const barSeekTo = (clientX: number, clientY: number) => {
    const pct = barPctAt(clientX, clientY);
    if (pct == null) return null;
    setBarPct(pct);
    return pct;
  };
  const onBarDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    videoRef.current?.trace("seek.input.down", { input: "mobile_bar" });
    barScrub.current = true;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    barSeekTo(e.clientX, e.clientY);
  };
  const onBarMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!barScrub.current) return;
    e.stopPropagation();
    videoRef.current?.trace("seek.input.move", { input: "mobile_bar" });
    barSeekTo(e.clientX, e.clientY);
  };
  const onBarUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!barScrub.current) return;
    barScrub.current = false;
    e.stopPropagation();
    const pct = barPctAt(e.clientX, e.clientY);
    if (pct != null && duration) {
      const target = pct * duration;
      videoRef.current?.trace("seek.input.up", { input: "mobile_bar", target });
      videoRef.current?.seek(target, "mobile_bar");
      playbackClock.publish(target);
    }
    setBarPct(null);
  };

  const togglePip = async () => {
    try {
      const v = videoRef.current?.el();
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v && document.pictureInPictureEnabled) await v.requestPictureInPicture();
      else toast("当前环境不支持画中画", "info");
    } catch { toast("画中画开启失败", "info"); }
  };

  const actionIsCurrent = () => mounted.current && actionContext.current.accountScope === accountScope && actionContext.current.lineEpoch === store.lineEpoch
    && actionContext.current.id === curId && actionContext.current.ep === curEp && actionContext.current.kind === kind;

  const onLike = async () => {
    const pendingKey = `${accountScope}:${likeActionKey}`;
    if (!curId || likePending || pendingActions.current.has(pendingKey)) return;
    pendingActions.current.add(pendingKey);
    const on = !liked;
    try {
      await setLiked(kind, curId, curEp, on);
      if (!actionIsCurrent()) return;
      if (on) setHeartBurst((n) => n + 1);
      toast(on ? "已加入喜欢" : "已取消喜欢", on ? "heart" : "info");
    } catch (error) {
      if (actionIsCurrent()) toast(error instanceof Error ? error.message : "点赞失败，请重试", "info");
    } finally { pendingActions.current.delete(pendingKey); }
  };

  const onFav = async () => {
    const pendingKey = `${accountScope}:${collectActionKey}`;
    if (!curId || collectPending || pendingActions.current.has(pendingKey)) return;
    pendingActions.current.add(pendingKey);
    const on = !collected;
    try {
      await setCollected(kind, curId, on);
      if (actionIsCurrent()) toast(on ? "已收藏" : "已取消收藏", on ? "star" : "info");
    } catch (error) {
      if (actionIsCurrent()) toast(error instanceof Error ? error.message : "收藏失败，请重试", "info");
    } finally { pendingActions.current.delete(pendingKey); }
  };

  const onFollow = async () => {
    const uid = meta.authorId > 0 ? meta.authorId : undefined;
    const pendingKey = `${accountScope}:${followActionKey}`;
    if (!uid || followPending || pendingActions.current.has(pendingKey)) return;
    if (!user) { setLoginOpen(true); return; }
    pendingActions.current.add(pendingKey);
    const on = !store.follows.includes(uid);
    try {
      await setFollowing(uid, on);
      if (actionIsCurrent()) toast(on ? `已关注 ${meta.author}` : "已取消关注", on ? "ok" : "info");
    } catch (error) {
      if (actionIsCurrent()) toast(error instanceof Error ? error.message : "关注失败，请重试", "info");
    } finally { pendingActions.current.delete(pendingKey); }
  };

  const pickEp = (ep: number) => {
    setEpMap((m) => ({ ...m, [curId]: ep }));
    setPanel(null);
  };

  const likeCount = useMemo(() => {
    const base = meta.like;
    const loadedLiked = kind === "video" && detail?.interaction?.liked
      && (detail.interaction.liked_ep === undefined || detail.interaction.liked_ep === curEp);
    return Math.max(0, base + Number(liked) - Number(!!loadedLiked));
  }, [meta.like, liked, kind, detail?.interaction, curEp]);
  const collectCount = useMemo(() => {
    const loadedCollected = kind === "video" && detail?.interaction?.collected;
    return Math.max(0, meta.collect + Number(collected) - Number(!!loadedCollected));
  }, [meta.collect, collected, kind, detail?.interaction]);

  const detailBody = (onClose?: () => void) => <VideoDetailsPanel meta={meta} videoId={curId} episodeCount={episodes.length}
    related={related} following={store.follows.includes(meta.authorId)} followPending={followPending}
    onFollow={() => void onFollow()} onClose={onClose}
    onAuthor={() => { if (meta.authorId > 0) { closePanels(); store.push({ kind: "user", id: meta.authorId, name: meta.author }); } }}
    onRelated={video => { closePanels(); store.push({ kind: "feed", videoIds: related.map(item => item.id), index: related.findIndex(item => item.id === video.id), title: "相关推荐" }); }} />;

  if (curId && mode === "home" && blocked) {
    return <div className="absolute inset-0 bg-black flex items-center justify-center" inert={!active || undefined} aria-hidden={!active || undefined}>
      <Loader className="w-9 h-9 spinner" label="正在跳过内容" />
    </div>;
  }

  if (curId && filtering && !tagsReady && !tagErrors[tagKey]) {
    return <div className="absolute inset-0 bg-black flex items-center justify-center" inert={!active || undefined} aria-hidden={!active || undefined}>
      <Loader className="w-9 h-9 spinner" label="正在加载内容" />
    </div>;
  }

  if (curId && filtering && !tagsReady && tagErrors[tagKey]) {
    return <div className="absolute inset-0 bg-black flex flex-col items-center justify-center gap-3" inert={!active || undefined} aria-hidden={!active || undefined}>
      <span className="text-[13px] text-white/70">暂时无法加载内容</span>
      <Button onClick={() => {
        setTagErrors(previous => { const next = { ...previous }; delete next[tagKey]; return next; });
        setProxyRetry(value => value + 1);
      }} className="min-h-11 rounded-full bg-white/10 px-4 text-white">重试</Button>
    </div>;
  }

  if (!effectiveVideoIds.length) {
    return <div className="absolute inset-0 bg-black flex flex-col items-center justify-center gap-3" inert={!active || undefined} aria-hidden={!active || undefined}>
      <span className="text-[14px] text-white/70">当前列表没有可播放内容</span>
      <PreferenceStorageNotice className="mx-4 max-w-sm" />
      {onBack && <Button onClick={onBack} className="min-h-11 rounded-full bg-white/10 px-5 text-white">返回</Button>}
    </div>;
  }

  return (
    <div
      className={`hg-player-ui ${rotated ? "fs-landscape" : (!isDesktop && fs ? "fs-immersive" : "absolute inset-0")} overflow-hidden bg-black player-root ${isDesktop ? "player-surface" : ""} ${theater ? "is-theater" : ""} ${isDesktop && idle ? "is-idle" : ""}`}
      data-clean={clean}
      inert={!active || undefined}
      aria-hidden={!active || undefined}
      onFocusCapture={() => { if (active && isDesktop) wake(); }}
      onPointerMove={() => { if (isDesktop || fs) wake(); }}
      onPointerDown={() => { if (!isDesktop && fs) wake(); }}>
      <div className="absolute inset-0">
      {/* 氛围背景 */}
      {!isDesktop && posterUrl && (
        <div className="absolute inset-0 scale-110 blur-3xl opacity-25 pointer-events-none">
          <Image src={posterUrl} alt="" className="w-full h-full object-cover" />
        </div>
      )}

      <div ref={boxRef} onScroll={onScroll}
        className={`absolute inset-y-0 left-0 no-bar ${fs ? "overflow-hidden" : "overflow-y-scroll snap-y snap-mandatory overscroll-y-contain"}`}
        style={{ right: isDesktop && panel ? 372 : 0, transition: "right .3s cubic-bezier(.2,0,0,1)" }}>
        {effectiveVideoIds.map((vid, i) => {
          const isActive = i === index;
          const sectionClass = `${fs && !isActive ? "hidden" : "relative w-full h-full"} snap-start snap-always overflow-hidden`;
          // Preserve snap geometry while keeping only the active item and its
          // neighbours mounted; distant cards otherwise create many idle controls.
          if (Math.abs(i - index) > 1 && Math.abs(i - renderIndex) > 1) {
            return <section key={vid} className={sectionClass} aria-hidden="true" />;
          }
          if (filtering && !isActive && (!checked[`${accountScope}:${store.lineEpoch}:${kind}:${vid}`] || tagErrors[`${accountScope}:${store.lineEpoch}:${kind}:${vid}`] || blockReason(kind === "post" ? posts[vid]?.tags : details[vid]?.tags))) {
            return <section key={vid} className={sectionClass} aria-hidden="true" />;
          }
          return (
            <section key={vid} className={sectionClass} inert={!isActive || undefined} aria-hidden={!isActive || undefined}>
              {isActive && playUrl ? (
                <div
                  className="absolute inset-0" style={{ touchAction: "none" }}
                  onPointerDown={onDown} onPointerMove={onMove} onPointerUp={(e) => onUp(false, e)} onPointerCancel={(e) => onUp(true, e)} onLostPointerCapture={(e) => onUp(true, e)}>
                <div style={{ position: "absolute", inset: 0, transform: isDesktop ? undefined : `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.s})`, transformOrigin: "center center", transition: isDesktop || zoom.g ? "none" : "transform .18s ease-out" }}>
                <VideoSurface ref={videoRef} src={playUrl} poster={posterUrl} autoPlay active={active} muted={muted}
                  diagnosticContext={{ active: active, view: mode, kind, video_id: curId, episode: curEp }}
                  volume={volume} rate={effRate}
                  fit={isDesktop || fs ? "contain" : landscapeVideo ? portraitFit : (vpLandscape ? "contain" : "cover")}
                  onClick={() => { if (isDesktop) videoRef.current?.toggle(); }}
                  onTime={onTimeTick}
                  onDuration={onDurationTick}
                  onSize={(w, h) => { if (isCurrentPlayback()) setVsize((prev) => (prev.w === w && prev.h === h ? prev : { w, h })); }}
                  onPlaying={() => { if (isCurrentPlayback()) { setPaused(false); setWaiting(false); setErr(""); setPlayingKey(playKey); healthyRef.current = true; } }}
                  onPause={() => { if (isCurrentPlayback()) setPaused(true); }}
                  onWaiting={() => {
                    if (!isCurrentPlayback()) return;
                    setWaiting(true); lastStallAtRef.current = Date.now(); healthyRef.current = false;
                    const ctl = prewarmCtlRef.current;
                    if (ctl) { prewarmCtlRef.current = null; ctl.ac.abort(); tracePlayback("feed.prewarm", { video_id: ctl.videoId, stage: "yield_abort" }); }
                  }}
                  onFragStats={onFragStats}
                  onEnded={() => { if (!isCurrentPlayback()) return; const next = episodes.find((e) => e.ep_num === curEp + 1); if (next) pickEp(next.ep_num); }}                  onError={(m) => {
                    if (!isCurrentPlayback()) return;
                    setErr(m);
                    if (preferHevc && hevcUrl) {
                      setPreferHevc(false);
                      toast("高清播不了，已切回标准", "info");
                    }
                  }} />
                </div>
                </div>
              ) : (
                <div className="absolute inset-0">
                  {(!filtering || checked[`${accountScope}:${store.lineEpoch}:${kind}:${vid}`]) &&
                    <Img src={details[vid]?.cover || posts[vid]?.cover || ""} eager={Math.abs(i - index) <= 1} />}
                  <div className="absolute inset-0" style={{ background: "rgba(0,0,0,.25)" }} />
                </div>
              )}

              {/* 图文帖：没有视频就给个正文入口 */}
              {isActive && kind === "post" && !!post && !post.video_url && (
                <div className="absolute inset-0 z-10 flex items-center justify-center">
                  <Button type="button" onClick={() => setPanel("article")}
                    className="flex items-center gap-2 h-11 px-5 rounded-full text-[14px] font-semibold pressable elev-3"
                    style={{ background: "rgba(255,255,255,.94)", color: "#0b0e15" }}>
                    <IFileText size={17} />查看图文详情
                  </Button>
                </div>
              )}

              {/* 顶部 */}
              {!fs && !clean && mode === "context" ? (
                isDesktop ? (
                  <div className="desktop-context-header">
                    <Button onClick={onBack} aria-label="返回"><IBack size={17} /></Button>
                    <span>{title}</span>
                    <small>{index + 1} / {effectiveVideoIds.length}</small>
                  </div>
                ) : (
                  <div className="absolute inset-x-0 z-20 flex items-center gap-2 px-2.5" style={{ top: "calc(var(--sat, 0px) + 8px)", paddingRight: 132 }}>
                    <Button onClick={onBack} aria-label="返回" className="hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1"><IBack size={20} /></Button>
                    <span className="text-[15px] font-semibold hg-ink hg-ov-shadow truncate">{title}</span>
                  </div>
                )
              ) : null}
              {!fs && !clean && !isDesktop && mode === "context" && (
                <span className="feed-position-pill absolute z-20 px-2.5 py-1 rounded-full hg-chip text-[12px] font-semibold tabular-nums"
                  style={{ top: "calc(var(--sat, 0px) + 52px)", left: 12, color: "rgba(255,255,255,.94)" }}>
                  {index + 1} / {effectiveVideoIds.length}
                </span>
              )}

              {/* 竖屏下的快捷操作（#19）：
                  横版视频 → 保持原样，居中横排一条（画面上下有黑边，居中不压主体）；
                  竖版视频 → 只剩「切集」图标，贴右边缘，避免压住画面正中。
                  显隐用 opacity + 轻微位移过渡（不卸载），净屏/全屏时慢慢淡出。 */}
              {!isDesktop && (
                <div
                  className={landscapeVideo
                    ? "absolute z-20 w-max max-w-[calc(100%-24px)] whitespace-nowrap"
                    : "absolute z-20"}
                  aria-hidden={!(isActive && capsuleOn)}
                  style={{
                    left: landscapeVideo ? "50%" : undefined,
                    right: landscapeVideo ? undefined : 8,
                    top: landscapeVideo ? "64%" : "auto",
                    bottom: landscapeVideo ? undefined : `calc(var(--sab, 0px) + ${bottomInset + 460}px)`,
                    transform: landscapeVideo
                      ? `translate(-50%, ${isActive && capsuleOn ? 0 : 10}px)`
                      : `translateY(${isActive && capsuleOn ? 0 : 10}px)`,
                    opacity: isActive && capsuleOn ? 1 : 0,
                    pointerEvents: isActive && capsuleOn ? "auto" : "none",
                    transition: "opacity .38s cubic-bezier(.4,0,.2,1), transform .38s cubic-bezier(.4,0,.2,1)",
                  }}>
                  <div className={landscapeVideo
                    ? "inline-flex items-center gap-0.5 h-8 px-1 rounded-full backdrop-blur-xl elev-2 whitespace-nowrap"
                    : "flex flex-col items-stretch gap-1 p-1 rounded-[18px] backdrop-blur-xl elev-2"}
                    style={{ background: "rgba(12,15,22,.58)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.09)" }}>
                    {landscapeVideo && (
                      <>
                        <Button type="button" onClick={() => {
                          if (zoom.s > 1.05) { setZoom({ s: 1, x: 0, y: 0, g: false }); setPortraitFit("contain"); }
                          else setPortraitFit((f) => (f === "contain" ? "cover" : "contain"));
                        }} className="whitespace-nowrap flex items-center justify-center gap-1 h-[26px] px-3 rounded-full text-[12px] font-semibold pressable transition-colors duration-150"
                          style={{ color: "rgba(255,255,255,.9)" }}>
                          {zoom.s > 1.05 ? `还原 ${zoom.s.toFixed(1)}x` : portraitFit === "contain" ? "铺满" : "适应"}
                        </Button>
                        <Button type="button" onClick={() => enterFs()}
                          className="whitespace-nowrap flex items-center justify-center gap-1 h-[26px] px-3 rounded-full text-[12px] font-semibold pressable transition-colors duration-150"
                          style={{ color: "rgba(255,255,255,.9)" }}>
                          <IExpand size={13} /><span>横屏</span>
                        </Button>
                      </>
                    )}
                    {!landscapeVideo && zoom.s > 1.05 && (
                      <>
                        <Button type="button" onClick={() => setZoom({ s: 1, x: 0, y: 0, g: false })}
                          className="whitespace-nowrap flex items-center justify-center gap-1 h-[26px] px-3 rounded-full text-[12px] font-semibold pressable transition-colors duration-150"
                          style={{ color: "rgba(255,255,255,.9)" }}>
                          还原 {zoom.s.toFixed(1)}x
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}
              {/* 右侧操作栏（移动端）：收藏 / 评论 / 全屏 / 分享
                  颜色写死不跟主题走：浅色主题下这些字必须仍是白色 */}
              {!fs && !clean && !isDesktop && (
                <div className="mobile-video-action-rail absolute right-3 z-20 flex flex-col items-center gap-[16px]"
                  style={{ bottom: `calc(var(--sab, 0px) + ${bottomInset + 92}px)` }}>
                  {/* Muse 2026-11-15 (2.1.2): 右侧栏「切集」开关钮已删（用户定版）——选集一按直达
                      （左下「第X集」/全屏底栏「选集」），竖滑切集恒定生效，不再有模式开关。 */}
                  {hevcUrl && (
                    <Button type="button" onClick={() => { setPreferHevc(!preferHevc); toast(preferHevc ? "已切回标准画质" : "已切换高清 HEVC", "ok"); }}
                      className="flex flex-col items-center gap-1 pressable" aria-pressed={preferHevc} aria-label="画质切换">
                      <span className={`flex items-center justify-center h-[22px] min-w-[30px] px-1 rounded-md text-[12px] font-bold hg-ov-shadow ${preferHevc ? "bg-primary text-on-primary" : "hg-chip hg-ink-2"}`}>{preferHevc ? "HD" : "标清"}</span>
                      <span className="text-[12px] hg-ov-shadow" style={{ color: preferHevc ? "#fff" : undefined }}>{preferHevc ? "高清" : "标清"}</span>
                    </Button>
                  )}
                  {kind === "video" && (
                    <Button onClick={() => void onLike()} disabled={likePending} aria-busy={likePending} className="flex flex-col items-center gap-1 pressable" aria-pressed={liked} aria-label="点赞">
                      {liked ? <IHeartF size={27} className="text-neon" /> : <IHeart size={27} className="hg-ink hg-ov-shadow" />}
                      <span className="text-[12px] text-white/90 tabular-nums">{fmt(likeCount)}</span>
                    </Button>
                  )}
                  <Button onClick={() => void onFav()} disabled={collectPending} aria-busy={collectPending} className="flex flex-col items-center gap-1 pressable" aria-pressed={collected} aria-label="收藏">
                    {collected ? <IStarF size={27} className="hg-gold" /> : <IStar size={27} className="hg-ink hg-ov-shadow" />}
                    <span className="text-[12px] text-white/90 tabular-nums">{fmt(collectCount)}</span>
                  </Button>
                  <Button onClick={() => setPanel("comments")} className="flex flex-col items-center gap-1 pressable" aria-label={`评论 ${fmt(meta.comment)} 条`}>
                    <ICommentF size={26} className="hg-ink hg-ov-shadow" />
                    <span className="text-[12px] hg-ink-2 hg-ov-shadow tabular-nums">{fmt(meta.comment)}</span>
                  </Button>
                  <Button onClick={() => enterFs()} className="flex flex-col items-center gap-1 pressable" aria-label="全屏">
                    <IExpand size={26} className="hg-ink hg-ov-shadow" />
                    <span className="text-[12px] hg-ink-2 hg-ov-shadow">全屏</span>
                  </Button>
                </div>
              )}

              {/* 右侧操作栏（桌面） */}
              {!fs && !clean && isDesktop && (
              <div className="absolute z-20 flex flex-col items-center desktop-social">
                <div className="desktop-browse-inline">
                  <Button onClick={() => stepDir(-1)} disabled={!canStep(-1)} aria-label="上一个" title="上一个 ↑">
                    <IChevronUp size={19} strokeWidth={1.8} />
                  </Button>
                  <Button onClick={() => stepDir(1)} disabled={!canStep(1)} aria-label="下一个" title="下一个 ↓">
                    <IChevronDown size={19} strokeWidth={1.8} />
                  </Button>
                    <small>{String(index + 1).padStart(2, "0")} / {String(effectiveVideoIds.length).padStart(2, "0")}</small>
                </div>

                {kind === "video" && (
                  <>
                    <Button onClick={() => void onLike()} disabled={likePending} aria-busy={likePending} aria-label="点赞" className="flex flex-col items-center gap-1 pressable" aria-pressed={liked}>
                      <span key={heartBurst} className={heartBurst ? "a-pop" : ""}>
                        {liked ? <IHeartF size={30} className="text-neon" /> : <IHeart size={30} className="text-white tsh" />}
                      </span>
                      <span className="text-[12px] text-white/90 tabular-nums">{fmt(likeCount)}</span>
                    </Button>

                    <Button onClick={() => setPanel("comments")} aria-label={`评论 ${fmt(meta.comment)} 条`} className="flex flex-col items-center gap-1 pressable">
                      <ICommentF size={27} className="text-white tsh" />
                      <span className="text-[12px] text-white/90 tabular-nums">{fmt(meta.comment)}</span>
                    </Button>

                    <Button onClick={() => void onFav()} disabled={collectPending} aria-busy={collectPending} aria-label="收藏" className="flex flex-col items-center gap-1 pressable" aria-pressed={collected}>
                      {collected ? <IStarF size={27} className="hg-gold" /> : <IStar size={27} className="hg-ink hg-ov-shadow" />}
                      <span className="text-[12px] text-white/90 tabular-nums">{fmt(meta.collect)}</span>
                    </Button>

                    <Button onClick={() => setPanel("episodes")} aria-label="选集" className="flex flex-col items-center gap-1 pressable">
                      <IList size={26} className="text-white tsh" />
                      <span className="text-[12px] text-white/90">选集</span>
                    </Button>
                  </>
                )}

              </div>
              )}

              {/* 桌面：左下信息 */}
              {!fs && !clean && isDesktop && (
              <div className="desktop-video-meta">
                <div className="flex items-center gap-2">
                  <span className="text-[16px] font-bold text-white tsh truncate">@{meta.author}</span>
                  {episodes.length > 0 && (
                    <span className="shrink-0 px-1.5 py-px rounded-md text-[12px] font-bold text-white"
                      style={{ background: "rgba(255,255,255,.16)" }}>
                      第 {curEp}/{episodes.length} 集
                    </span>
                  )}
                   {hevcUrl && (
                     <Button type="button" aria-pressed={preferHevc}
                       onClick={() => { setPreferHevc(!preferHevc); toast(preferHevc ? "已切回标准画质" : "已切换高清 HEVC", "ok"); }}
                       className={`shrink-0 h-[18px] px-1.5 rounded-md text-[12px] font-bold flex items-center pressable transition-colors ${preferHevc ? "bg-primary text-on-primary" : "text-white border border-white/30"}`}>
                       {preferHevc ? "HD" : "标清"}
                     </Button>
                   )}
                   {!!meta.score && (
                  <span className="shrink-0 text-[12px] font-bold hg-gold hg-ov-shadow">{meta.score.toFixed(1)} 分</span>
                  )}
                </div>

                <p className="mt-1 text-[14px] leading-snug hg-ink-2 hg-ov-shadow clamp-2">{meta.title}</p>

                <p className="mt-1 text-[12px] leading-relaxed hg-ink-4 clamp-1">{meta.desc || "暂无简介"}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button aria-label="视频详情" onClick={() => setPanel("detail")} className="min-h-11 px-4 rounded-full hg-chip text-[12px] inline-flex items-center gap-1">
                    详情与标签<IChevR size={13} />
                  </Button>
                </div>
              </div>
              )}

              {/* 移动端：标题 + 详情标签 + 进度线
                  不加任何压暗层——黑边彻底去掉，全靠文字阴影保读；
                  进度条轨道几乎不可见，只用白点标播放位置。 */}
              {!fs && !clean && !isDesktop && (
                <div className="absolute inset-x-0 z-20" style={{ bottom: `calc(var(--sab, 0px) + ${bottomInset}px)` }}>
                  <div className="mobile-video-meta-copy relative pb-2 flex items-center gap-2">
                    <p className="flex-1 min-w-0 text-[15px] font-semibold leading-snug hg-ink-2 hg-ov-shadow-strong clamp-2">{meta.title}</p>
                  </div>
                  <div className="relative pt-1.5 pb-2.5">
                    <div className="mobile-video-meta-copy flex flex-wrap items-center gap-2">
                      {/* Muse 2026-11-15 (2.1.2): 「详情 · 第X集」拆成两个独立点击目标（用户定版）——
                          点「详情」开详情面板（原行为）；点「第X集」直达选集网格，不再穿详情面板。 */}
                      <Button aria-label="视频详情" onClick={() => setPanel("detail")}
                        className="min-h-11 flex items-center gap-0.5 text-[12px] font-medium hg-ink-3 hg-ov-shadow-strong pressable">
                        详情<IChevR size={11} />
                      </Button>
                      {episodes.length > 1 ? (
                        <Button aria-label={`选集，当前第 ${curEp} 集`} onClick={() => setPanel("episodes")}
                          className="min-h-11 flex items-center gap-0.5 text-[12px] font-medium hg-ink-3 hg-ov-shadow-strong pressable">
                          第 {curEp} 集<IChevR size={11} />
                        </Button>
                      ) : (
                        <span className="min-h-11 flex items-center text-[12px] font-medium hg-ink-3 hg-ov-shadow-strong">第 {curEp} 集</span>
                      )}
                    </div>
                    <div ref={barRef} className="mx-4 mt-2 relative" style={{ height: 14, touchAction: "none" }}
                      onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp}>
                      {/* 轨道：几乎看不见，只暗示可拖动 */}
                      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-[2px] rounded-full" style={{ background: "rgba(255,255,255,.1)" }}>
                        <PlaybackProgress clock={playbackClock} duration={duration} preview={barPct} className="h-full rounded-full"
                          style={{ background: "rgba(255,255,255,.26)", transition: barPct !== null ? "none" : "width .25s linear" }} />
                      </div>
                      {/* 进度点：整个进度条唯一的实心元素 */}
                      <PlaybackProgress clock={playbackClock} duration={duration} preview={barPct} position className="absolute top-1/2 w-[7px] h-[7px] rounded-full bg-white pointer-events-none"
                        style={{
                          transform: "translate(-50%, -50%)",
                          boxShadow: "0 0 8px rgba(0,0,0,.55)",
                          transition: barPct !== null ? "none" : "left .25s linear",
                        }} />
                      {barPct !== null && (
                        <div className="absolute left-1/2 -translate-x-1/2 -top-8 px-2.5 py-1 rounded-md hg-chip-strong backdrop-blur-md text-[13px] font-bold tabular-nums whitespace-nowrap">
                          {fmtTime(barPct * (duration || 0))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}


              {/* 横拖定位浮层 */}
              {!isDesktop && scrub && (
                <div className="absolute inset-0 z-30 flex flex-col items-center justify-center pointer-events-none" style={{ background: "rgba(0,0,0,.25)" }}>
                  <span className="text-[26px] font-bold hg-ink tabular-nums hg-ov-shadow">{fmtTime(scrub.target)}</span>
                  <span className="text-[12px] hg-ink-4 mt-1 tabular-nums">/ {fmtTime(duration)}</span>
                  <div className="mt-4 w-[62%] h-[3px] rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,.25)" }}>
                    <div className="h-full bg-white" style={{ width: `${scrub.pct}%` }} />
                  </div>
                </div>
              )}

              {/* 暂停 / 缓冲 */}
              {isActive && paused && !err && (
                <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                  <span className="w-[66px] h-[66px] rounded-full flex items-center justify-center backdrop-blur-md"
                    style={{ background: "rgba(0,0,0,.55)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.12)" }}>
                    <IPlayF size={28} className="hg-ink ml-0.5" />
                  </span>
                </div>
              )}
              {isActive && waiting && !err && !paused && (
                <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none"><Loader className="w-9 h-9 spinner" /></div>
              )}
              {isActive && err && (
                <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
                  <div className="rounded-xl p-5 flex flex-col items-center gap-3 text-[14px] hg-ink-2 pointer-events-auto" style={{ background: "rgba(0,0,0,.7)" }}>
                    <span>视频暂时无法加载</span>
                    <span className="text-[12px] hg-ink-4 max-w-[240px] text-center break-all">{err}</span>
                    <Button className="hg-link text-[14px]" onClick={() => { setErr(""); setWaiting(true); videoRef.current?.play(); }}>重试</Button>
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>

      {/* 桌面控制条 */}
      {isDesktop && (
        <PlayerControls
          paused={paused} duration={duration} rate={rate}
          clock={playbackClock}
          muted={muted} volume={volume} theater={theater} fullscreen={fullscreen}
          visible={active && !idle}
          seekEnabled={active}
          seekKey={playKey}
          nextDisabled={!episodes.some((e) => e.ep_num === curEp + 1) && index >= effectiveVideoIds.length - 1}
          nextTitle={episodes.some((e) => e.ep_num === curEp + 1) ? "下一集 E" : "下一部 ↓"}
          swipeEp={swipeEp}
          onToggleSwipe={() => { setSwipeEp(!swipeEp); toast(swipeEp ? "上下划切集已关闭" : "上下划切集已开启"); }}
          onToggle={() => videoRef.current?.toggle()}
          onSeek={(t, source) => { videoRef.current?.seek(t, source); playbackClock.publish(t); }}
          onSeekInteraction={(phase, input, target, pointerTarget) => videoRef.current?.trace(`seek.input.${phase}`, { input, target, pointer_target: pointerTarget })}
          onRate={(r) => { setRate(r); videoRef.current?.rate(r); }}
          onMute={() => setMuted((m) => !m)}
          onVolume={(v) => setVolume(v)}
          onPip={togglePip}
          onTheater={() => setTheater((v) => !v)}
          onFullscreen={toggleFull}
          onNext={() => {
            const nx = episodes.find((e) => e.ep_num === curEp + 1);
            if (nx) pickEp(nx.ep_num);
            else go(1);
          }}
        />
      )}

      {/* 移动端：倍速状态 / 锁定提示 */}
      {!isDesktop && (holdSpeed || rate !== 1) && (!fs || !idle) && (
        <Button
          onClick={() => {
            if (rate !== 1 && !holdSpeed) setRate(1);
          }}
          className="absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 px-3.5 h-8 rounded-full backdrop-blur-md text-[13px] font-bold elev-2 pressable hg-chip hg-gold"
          style={fs
            ? { bottom: rotated ? 84 : "calc(var(--sab, 0px) + 84px)" }
            : { top: "calc(var(--sat, 0px) + 54px)" }}>
          <IBoltF size={13} />
          {effRate}x {holdSpeed ? "倍速中 · 松开恢复" : "倍速"}
        </Button>
      )}

      {/* 移动端：超分档位切换 HUD（短暂浮现提示当前档位） */}
      {!isDesktop && active && srHud && (
        <div
          className="absolute left-1/2 -translate-x-1/2 z-50 pointer-events-none flex items-center gap-1.5 px-3.5 h-8 rounded-full backdrop-blur-md text-[13px] font-bold elev-2 a-fade hg-chip-strong"
          style={{ top: rotated ? 58 : fs ? "calc(var(--sat, 0px) + 52px)" : "calc(var(--sat, 0px) + 96px)" }}>
          <ISparkF size={13} className={srHud === "off" ? "hg-ink-3" : "text-primary"} />
          <span>{SR_PRESET_MAP[srHud].hudText}</span>
        </div>
      )}

      {/* 移动端全屏进度条，普通模式的进度条位于标题下方 */}
      {!isDesktop && fs && !idle && (
        <div
          className="absolute inset-x-0 z-30 px-4"
          style={{
            bottom: rotated ? 52 : "calc(var(--sab, 0px) + 52px)",
            paddingLeft: rotated ? "calc(var(--sat, 0px) + 16px)" : undefined,
            paddingRight: rotated ? "calc(var(--sab, 0px) + 16px)" : undefined,
            height: 22,
          }}>
          <div ref={barRef} className="relative h-full" style={{ touchAction: "none" }}
            onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp}>
            <div className="absolute inset-x-0 bottom-[8px] h-[2.5px] rounded-full" style={{ background: "rgba(255,255,255,.3)" }}>
              <PlaybackProgress clock={playbackClock} duration={duration} preview={barPct} className="h-full rounded-full bg-white" />
            </div>
          </div>
        </div>
      )}

      {/* 移动端：沉浸全屏（安卓 WebView 不支持 Fullscreen API，改用应用内沉浸层） */}
      {!isDesktop && fs && !idle && (
        <>
          <Button onClick={exitFs} aria-label="退出全屏"
            className="hg-chip-strong absolute z-40 w-9 h-9 rounded-full backdrop-blur-md flex items-center justify-center pressable elev-1"
            style={{
              top: rotated ? 12 : "calc(var(--sat, 0px) + 6px)",
              right: rotated ? "calc(var(--sab, 0px) + 12px)" : 12,
            }}>
            <ICompress size={18} />
          </Button>
          {/* Muse 2026-11-15 (2.1.2): 全屏底栏分段布局——左段 播放+时间（当前/总时长合并为一段文本，
              不再分置两头把总时长挤出屏幕）+声音，右段（ml-auto）超分/倍速/画质/上集/下集（+横屏时选集）。
              旋转钮已删（方向跟源走）；选集直达 episodes 网格（pickEp 选完自动关面板），
              不再绕「详情→选集页签」3 步；竖屏全屏选集钮在右侧中段（同块下方），底栏不塞它。
              排版实算（竖屏全屏最挤情形：长时长+中集+HEVC 全同现）≈371px，375px 屏不溢出；横屏宽度充裕。 */}
          <div className="absolute inset-x-0 z-40 flex items-center gap-1 px-2"
            style={{
              bottom: rotated ? 10 : "calc(var(--sab, 0px) + 10px)",
              paddingLeft: rotated ? "calc(var(--sat, 0px) + 16px)" : undefined,
              paddingRight: rotated ? "calc(var(--sab, 0px) + 16px)" : undefined,
            }}>
            <Button onClick={() => videoRef.current?.toggle()}
              className="hg-chip shrink-0 w-8 h-8 rounded-full flex items-center justify-center pressable">
              {paused ? <IPlayF size={16} /> : <IPauseF size={15} />}
            </Button>
            <span className="shrink-0 text-[11px] font-semibold hg-ink-2 tabular-nums whitespace-nowrap">
              <PlaybackTime clock={playbackClock} />/{fmtTime(duration)}
            </span>
            <Button onClick={() => setMuted((m) => !m)} aria-label={muted ? "取消静音" : "静音"}
              className="hg-chip shrink-0 w-8 h-8 rounded-full flex items-center justify-center pressable">
              {muted ? <IVolMute size={15} /> : <IVol size={15} />}
            </Button>
            <div data-sr-slot className="relative ml-auto shrink-0">
              <Button
                onClick={() => setSrMenuPos((pos) => (pos === "fs-bottom" ? null : "fs-bottom"))}
                aria-label={`超分模式：${SR_SHORT_LABEL[srMode]}`}
                aria-expanded={srMenuPos === "fs-bottom"}
                title="选择 GPU 画质超分档位"
                aria-pressed={srMode !== "off"}
                className={`flex items-center gap-1 px-1.5 h-8 rounded-full text-[12px] font-bold pressable ${srMode !== "off" ? "bg-primary text-on-primary" : "hg-chip hg-ink-2"}`}>
                <ISparkF size={12} />{SR_SHORT_LABEL[srMode]}
              </Button>
              {srMenuPos === "fs-bottom" && (
                <SuperResMenu
                  current={srMode}
                  placement="up"
                  align="right"
                  onSelect={(m) => { setSrMode(m); setSrMenuPos(null); }}
                />
              )}
            </div>
            <div data-rate-slot className="relative shrink-0">
              <Button
                onClick={() => setRateMenuOpen((v) => !v)}
                aria-label={`倍速：${effRate}x`}
                aria-expanded={rateMenuOpen}
                title="选择播放倍速"
                aria-pressed={effRate !== 1}
                className={`flex items-center gap-1 px-1.5 h-8 rounded-full text-[12px] font-bold pressable ${effRate !== 1 ? "bg-primary text-on-primary" : "hg-chip hg-ink-2"}`}>
                <IBoltF size={12} />{effRate}x
              </Button>
              {rateMenuOpen && (
                <RateMenu
                  current={rate}
                  onSelect={(r) => { setRate(r); setRateMenuOpen(false); }}
                />
              )}
            </div>
            {/* Muse 2026-11-15 (2.1.2): 画质切换入口（用户点名的有用控制）——有 HEVC 高清流时才出现，
                与非全屏右侧栏的 HD 钮同一开关（preferHevc，默认已开，见 store 迁移）。 */}
            {hevcUrl && (
              <Button onClick={() => { setPreferHevc(!preferHevc); toast(preferHevc ? "已切回标准画质" : "已切换高清 HEVC", "ok"); }}
                className={`shrink-0 flex items-center px-1.5 h-8 rounded-full text-[12px] font-bold pressable ${preferHevc ? "bg-primary text-on-primary" : "hg-chip hg-ink-2"}`}
                aria-label="画质切换" aria-pressed={preferHevc}>
                {preferHevc ? "HD" : "标清"}
              </Button>
            )}
            {/* Muse 2026-11-15 (2.1.2): 上一集/下一集钮不加（用户终版定版）——有了选集直达，
                上下集钮是多余的。切集只留三条简单路径：选集网格、Feed 内滑动切、播完自动连播。 */}
            {/* 选集钮按方向分位——横屏全屏在底栏（宽度够）；
                竖屏全屏改放右侧中段（见下方独立按钮），底栏不再塞它，总时长不被挤。 */}
            {episodes.length > 1 && (rotated || vpLandscape) && (
              <Button onClick={() => setPanel("episodes")}
                className="shrink-0 flex items-center gap-1 px-1.5 h-8 rounded-full text-[12px] font-semibold hg-chip hg-ink-2 pressable"
                aria-label="选集">
                <IList size={13} />选集
              </Button>
            )}
          </div>
          {/* 竖屏全屏的选集钮：右侧中段（原右侧栏「切集」钮的位置），同属单击呼出的控制层 */}
          {episodes.length > 1 && !rotated && !vpLandscape && (
            <Button onClick={() => setPanel("episodes")} aria-label="选集"
              className="hg-chip-strong absolute z-40 right-3 top-1/2 -translate-y-1/2 w-11 py-2.5 rounded-full backdrop-blur-md flex flex-col items-center gap-1 pressable elev-1">
              <IList size={17} />
              <span className="text-[11px] font-semibold">选集</span>
            </Button>
          )}
        </>
      )}

      {/* 选集 / 评论：桌面停靠在右侧（画面让位），移动端底部弹层 */}
      {isDesktop ? (
        <div className={`desktop-dock-panel ${panel ? "is-open" : ""}`}>
          <div className="desktop-dock-inner">
            {panel === "detail" ? detailBody(() => setPanel(null)) : panel === "episodes" ? (
              <EpisodesPanel videoId={curId} episodes={episodes} current={curEp} onPick={pickEp} onClose={() => setPanel(null)} />
            ) : panel === "comments" ? (
              <CommentsPanel videoId={curId} ep={curEp} total={meta.comment} kind={kind} onClose={() => setPanel(null)} />
            ) : null}
          </div>
        </div>
      ) : (
        <>
          {/* 评论：移动端底部弹层（右侧操作栏「评论」入口） */}
          <Sheet open={active && panel === "comments"} onClose={() => setPanel(null)}>
            <div className="flex flex-col" style={{ height: "72vh" }}>
              <CommentsPanel videoId={curId} ep={curEp} total={meta.comment} kind={kind} onClose={() => setPanel(null)} />
            </div>
          </Sheet>

          {/* 吃瓜图文正文 */}
          <Sheet open={active && panel === "article"} onClose={() => setPanel(null)}>
            <div className="flex flex-col" style={{ height: "78vh" }}>
              <ArticlePanel title={meta.title} html={articleHtml} cover={meta.cover} hot={post?.hot} onClose={() => setPanel(null)} />
            </div>
          </Sheet>

          <Sheet open={active && (panel === "detail" || panel === "episodes")} label={panel === "detail" ? "视频详情" : "选集"} onClose={() => setPanel(null)}>
            <div className="video-details-sheet">
              {/* 双栏抽屉：详情 / 选集 */}
              <div className="shrink-0 flex items-center gap-2 px-4 pb-2">
                <SegmentedControl className="flex-1" aria-label="剧集面板" activeIndex={panel === "detail" ? 0 : 1}>
                  {([["detail", "详情"], ["episodes", "选集"]] as const).map(([k, l]) => (
                    <Button aria-pressed={panel === k} key={k} onClick={() => setPanel(k)}>{l}</Button>
                  ))}
                </SegmentedControl>
                <Button onClick={() => setPanel(null)} aria-label="关闭"
                  className="ios-icon-button">
                  <IClose size={14} />
                </Button>
              </div>

              <div className="flex-1 min-h-0">
                {panel === "episodes" ? (
                  <EpisodesPanel bare videoId={curId} episodes={episodes} current={curEp} onPick={pickEp} onClose={() => setPanel(null)} />
                ) : (
                  detailBody()
                )}
              </div>
            </div>
          </Sheet>
        </>
      )}
      </div>
      {/* Muse 2026-11-15 (2.1.2): 右上浮层（超分 pill/声音/搜索）整层由 fs 统一关断——
          进全屏后画面上只留底栏控制条（声音钮在底栏内），不再逐个元素打补丁；退出全屏整层恢复。
          右侧竖排操作栏与快捷胶囊本来就带 !fs 条件，与此处口径一致。 */}
      {!isDesktop && active && !fs && (
        <div className="absolute z-40 flex items-center gap-2 right-3"
          style={{ top: "calc(var(--sat, 0px) + 6px)" }}>
          {!clean && (
            <div data-sr-slot className="relative">
              <Button
                onClick={() => setSrMenuPos((pos) => (pos === "topbar" ? null : "topbar"))}
                aria-label={`超分模式：${SR_SHORT_LABEL[srMode]}`}
                aria-expanded={srMenuPos === "topbar"}
                title="选择 GPU 画质超分档位"
                aria-pressed={srMode !== "off"}
                className={`h-9 px-2.5 rounded-full flex items-center gap-1 text-[12px] font-bold pressable elev-1 ${srMode !== "off" ? "bg-primary text-on-primary" : "hg-chip hg-ink-2"}`}>
                <ISparkF size={13} />
                <span>{SR_SHORT_LABEL[srMode]}</span>
              </Button>
              {srMenuPos === "topbar" && (
                <SuperResMenu
                  current={srMode}
                  placement="down"
                  align="right"
                  onSelect={(m) => { setSrMode(m); setSrMenuPos(null); }}
                />
              )}
            </div>
          )}
          {!clean && <Button onClick={() => setMuted(m => !m)} aria-label={muted ? "取消静音" : "静音"}
            className="hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1">
            {muted ? <IVolMute size={17} /> : <IVol size={17} />}
          </Button>}
          {!fs && !clean && <Button onClick={() => store.setTab("search")} aria-label="搜索"
            className="hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1"><ISearch size={18} /></Button>}
        </div>
      )}
      {/* Muse 2026-11-15 (2.1.1 简化版): TagBlockMenu 浮层、MobileHoldGuide 提示图、PlaybackLock 锁定浮层均已移除 */}
    </div>
  );
}
