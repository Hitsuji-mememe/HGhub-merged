import { Button, Image, SegmentedControl } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useFsOrientation } from "../playback/useFsOrientation";
import { api, cover, fmt, fmtTime, isMobile, logLine, playlist } from "../../shared/api/api";
import type { Detail, Episode, PlayInfo, Post, VideoCard } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { LOCAL_SCOPE } from "../../shared/model/localLibrary";
import { Img, Sheet } from "../../shared/ui/ui";
import { ArticlePanel, EpisodesPanel } from "./Panels";
import { useSocialCounts } from "./ActionRail";
import { useProgressFlush } from "./useProgressFlush";
import { setBackHandler } from "../../shared/lib/back";
import { GESTURE_EDGE_PX } from "../../shared/lib/gestureGate";
import { useDetailNext } from "./useDetailNext";
import { copyText } from "../../shared/lib/clipboard";
import {
  PlaybackProgress, PlaybackTime, PlayerControls, VideoSurface,
  createPlaybackClock, type VideoHandle,
} from "../playback";
import { tracePlayback } from "../../shared/diagnostics/playbackDiagnostics";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import VideoDetailsPanel from "./VideoDetailsPanel";
import { PreferenceStorageNotice } from "../../shared/ui/PreferenceStorageNotice";
import { stageXY, HOLD_DELAY_MS } from "./mobileHold";
import { useFsIdle } from "./fsIdle";
import { RateMenu } from "./RateMenu";
import { useFeedPrewarm } from "./useFeedPrewarm";
import { consumeHealResume, recordHealResume, useStallHeal } from "./stallHeal";
import { useFeedDetails } from "./useFeedDetails";
import { isScopeOnlyChange, usePlayUrlCache } from "./usePlayUrlCache";
import { useFsKeepAlive } from "./useFsKeepAlive";
import { capStringRecordByFifo } from "./cacheMap";
import { holdState } from "./holdState";
import { createHoldJankSampler, createHoldReleaseProfiler, noteHoldSurfaceMount, noteHoldSurfaceUnmount, setActiveHoldReleaseProfiler } from "./holdJank";
import { HoldBadge } from "./HoldBadge";
import {
  IBack, IBoltF, IChevR, IChevronDown, IChevronUp, IClose, ICompress, IExpand, IFileText,
  ICheck, IHeart, IHeartF, ILink, IList, INext, IPauseF, IPlayF, ISearch, IStar, IStarF, IVertSwap, IVol, IVolMute,
} from "../../shared/ui/icons";

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

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

export default function Feed({ videoIds, startIndex = 0, title = "", mode, kind = "video", active, bottomInset, onBack, onNearEnd, onBlocked, startEp, startTime }: Props) {
  const store = useStore();
  const { isFav, setCollected, actionPending, muted, setMuted, volume, setVolume, rate, setRate, toast, addHistory, preferHevc, setPreferHevc } = store;
  /* 资料库作用域恒定（账号体系拆除后身份不再变化）：代次键的前缀
   * 成分保留，使缓存/守卫键式与旧版同构（不变量 2 的 scope 成分）。 */
  const scope = LOCAL_SCOPE;
  const isDesktop = !isMobile;
  const contentPreferences = useContentPreferences();
  const { preferences, revision, blockReason } = contentPreferences;
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const [tagMenu, setTagMenu] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [tagErrors, setTagErrors] = useState<Record<string, string>>({});
  const playRequests = useRef(new Map<string, Promise<PlayInfo>>());
  const requestPlay = useCallback((id: number, episode: number) => {
    const key = `${scope}:${store.lineEpoch}:${id}:${episode}`;
    let request = playRequests.current.get(key);
    if (!request) {
      request = api.play(id, episode).finally(() => {
        if (playRequests.current.get(key) === request) playRequests.current.delete(key);
      });
      playRequests.current.set(key, request);
      if (playRequests.current.size > 12) playRequests.current.delete(playRequests.current.keys().next().value!);
    }
    return request;
  }, [scope, store.lineEpoch]);
  const { details, setDetails, detailsRef, posts, setPosts, requestDetail, effectiveVideoIds } = useFeedDetails({
    videoIds, mode, kind, scope, lineEpoch: store.lineEpoch, originEpoch: store.lineEpoch, filtering, revision,
    blockReason, checked, tagErrors,
  });

  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<VideoHandle>(null);
  const holdTargetRef = useRef<HTMLDivElement>(null);
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
  /* 播放 URL 缓存（audit6 P1-3/P2-08）：作用域键＋200 条 FIFO，见 usePlayUrlCache。
     整改 B1：currentEntryRef 告知缓存层当前条目（作用域变化时键迁移保位）；
     playSkipRef 是自愈强制重解析的内容键集（在 skip 集内不迁移）。 */
  const currentEntryRef = useRef({ id: 0, ep: 1 });
  const playSkipRef = useRef(new Set<string>());
  const playCache = usePlayUrlCache(scope, store.lineEpoch, currentEntryRef, playSkipRef);
  const [playingKey, setPlayingKey] = useState("");
  const [proxyRetry, setProxyRetry] = useState(0);
  const [relatedByVideo, setRelatedByVideo] = useState<Record<string, VideoCard[]>>({});

  const playbackClock = useMemo(() => createPlaybackClock(), []);
  const [duration, setDuration] = useState(0);
  const [vsize, setVsize] = useState({ key: "", w: 0, h: 0 });
  const [paused, setPaused] = useState(false);
  const controlsLocked = false;
  /* 倍速为全局记忆（store.rate，蓝图 P4）：Feed 本地状态已回退，与帖子播放器同源 */
  const [rateMenuOpen, setRateMenuOpen] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [err, setErr] = useState("");
  const [panel, setPanel] = useState<"episodes" | "article" | "detail" | null>(null);
  /* 「内容」入口恒落详情页（2026-11-18 用户真机纠正）：蓝图 P2 的
     「落上次页」记忆使用户先看过选集后，「内容」与「选集」两钮完全
     同效（实测投诉「选集和内容重复」）。详情页经核查本无选集网格/
     集数列表（只有「共 X 集」元信息），重复源就是这条落点记忆，
     故删除：选集只由选集钮到达、评论只由抽屉页签到达（播放面评论
     入口已随右栏撤销）、内容恒落详情，三入口互不重复。 */
  /* 续播：拿到时长后再 seek 一次（只对进入时那一条生效）。键用内容键
     id:ep（顺藤检出 S1，随整改 B1）：旧作用域键在挂载后切线即与新
     playKey 永不相等、续播静默丢失，与自愈接回同病。 */
  const resumeRef = useRef<{ key: string; t: number } | null>(
    startTime && startTime > 1 ? { key: `${videoIds[startIndex]}:${startEp || 1}`, t: startTime } : null,
  );
  /* 观看进度：onTime 里节流写回 store，卸载时再兜一次 */
  const liveRef = useRef({ id: 0, ep: 1, dur: 0, t: 0, permissionKey: "", scope: "" });
  /* 切线连续性（整改 B1）：按内容键 id:ep 记最后已知播放位置（作用域
     变化时登记接回）＋上一 playKey/内容键（判定是否仅作用域变化）。 */
  const lastPosRef = useRef(new Map<string, number>());
  const prevPlayRef = useRef({ playKey: "", contentKey: "" });
  const historyWriter = useRef(addHistory);
  const lastSaveRef = useRef(0);
  const fs = store.fs;
  const clean = store.clean;
  const setClean = store.setClean;
  const setFs = store.setFs;

  const [fullscreen, setFullscreen] = useState(false);
  /* 点赞动画计数 heartBurst 已随社交栏撤下删除（2026-11-18） */
  /* —— 移动端手势 —— */
  const holdRef = useRef(false);
  /* 长按倍速走外部 store（holdState）+ videoRef 直通道，不进 Feed 状态；
     rateRef 供手势回调读最新基准倍速（复位 hold 时恢复用） */
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const resetHold = () => { jankSamplerRef.current?.stop(); holdRef.current = false; if (holdState.get() !== 0) { holdState.set(0); videoRef.current?.rate(rateRef.current); } };
  /* 长按顿感量化采样（fix2 A5，实现在 holdJank.ts）：hold 起止钩子 */
  const jankSamplerRef = useRef<ReturnType<typeof createHoldJankSampler> | null>(null);
  if (!jankSamplerRef.current) {
    jankSamplerRef.current = createHoldJankSampler((event, data) => videoRef.current?.trace(event, data));
  }
  const startHoldJank = () => jankSamplerRef.current?.start();
  /* 松手剖面（最终版 B 线任务 3，实现在 holdJank.ts）：ratechange
   * 退出 ≥2x 域即松手零点；SR 段时刻由 WebGPU 画布经总线上报、
   * 首帧呈现走 rVFC。剖面行与 hold.jank 同 trace 通道进诊断账本。 */
  const releaseProfilerRef = useRef<ReturnType<typeof createHoldReleaseProfiler> | null>(null);
  if (!releaseProfilerRef.current) {
    releaseProfilerRef.current = createHoldReleaseProfiler((event, data) => videoRef.current?.trace(event, data));
  }
  useEffect(() => {
    const profiler = releaseProfilerRef.current;
    if (!profiler || !active) return undefined;
    setActiveHoldReleaseProfiler(profiler);
    /* 播放面生命周期登记（B3 任务 2）：剖面行以此算面龄，区分冷/热面松手 */
    noteHoldSurfaceMount("feed", performance.now());
    let el: HTMLVideoElement | null = null;
    let prevRate = 0;
    let poll = 0;
    const onRateChange = () => {
      if (!el) return;
      const now = el.playbackRate;
      if (prevRate >= 2 && now < 2) {
        profiler.release(performance.now());
        const vv = el as HTMLVideoElement & {
          requestVideoFrameCallback?: (
            cb: (now: number, metadata: { mediaTime: number; presentedFrames: number; expectedDisplayTime: number }) => void,
          ) => number;
        };
        if (typeof vv.requestVideoFrameCallback === "function") {
          /* rVFC metadata 一并入剖面（B3 任务 2）：呈现帧序/预期呈现时刻 */
          vv.requestVideoFrameCallback((_now, metadata) => profiler.firstFrame(performance.now(), {
            mediaTime: metadata.mediaTime,
            presentedFrames: metadata.presentedFrames,
            expectedDisplayTime: metadata.expectedDisplayTime,
          }));
        } else {
          requestAnimationFrame(() => profiler.firstFrame(performance.now()));
        }
      }
      prevRate = now;
    };
    const attach = () => {
      el = videoRef.current?.el() ?? null;
      if (!el) return false;
      prevRate = el.playbackRate;
      el.addEventListener("ratechange", onRateChange);
      return true;
    };
    if (!attach()) {
      poll = window.setInterval(() => { if (attach()) window.clearInterval(poll); }, 500);
    }
    return () => {
      window.clearInterval(poll);
      el?.removeEventListener("ratechange", onRateChange);
      setActiveHoldReleaseProfiler(null);
      noteHoldSurfaceUnmount("feed", performance.now());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  const [scrub, setScrub] = useState<{ pct: number; target: number } | null>(null);
  const scrubTarget = useRef<number | null>(null);
  /* scrub 退出不变量：任何退出路径都经此清 scrub+scrubTarget；restorePlay
     由调用方按手势快照 g.playing 决定（原本暂停的绝不被播起来），且当前
     active 才恢复播放 */
  const clearScrub = (restorePlay: boolean) => { setScrub(null); scrubTarget.current = null; if (restorePlay && active) videoRef.current?.play(); };
  /* 进度条拖动 */
  const barRef = useRef<HTMLDivElement>(null);
  const barScrub = useRef(false);
  const barDrag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  /* 拖动结束后的尾随 click 吞咽标记（B2 追加，与共享层同口径）。 */
  const barClickSwallow = useRef(false);
  const [barPct, setBarPct] = useState<number | null>(null);
  const gesture = useRef<{
    x: number; y: number; startY: number; t: number; timer: number | null;
    mode: "idle" | "hold" | "scrub" | "pan"; base: number; width: number; playing: boolean;
    rotated: boolean;
    /* 边缘起手（左右缘各 GESTURE_EDGE_PX，屏幕坐标）：本面只做归属
       ——边缘起手不 scrub/pan/hold；返回的判定与触发统一归壳层链
       （shared/lib/gestureGate＋app/gestureChain，fix330/gesture-back
       一致性批），本面旧自带判定（28px 锁定/64px 触发/doEdgeBack）
       已删。rawX/rawY 为屏幕坐标（旋转舞台下方向判定不走舞台坐标）。
       右缘左滑同为返回（2026-11-18 第10项裁定）由统一判定保留。 */
    edge: boolean; edgeR: boolean; rawX: number; rawY: number;
  } | null>(null);
  /* 系统是否真的转成了横屏（iOS 原生旋转后为 true） */
  const [vpLandscape, setVpLandscape] = useState(
    () => typeof window !== "undefined" && window.innerWidth > window.innerHeight,
  );
  /* 双指缩放：scale 1~4，平移跟手指 */
  const [zoom, setZoom] = useState({ s: 1, x: 0, y: 0, g: false });
  /* 横屏：fit 恒 contain 不裁切（原 portraitFit 铺满切换随蓝图回退，缩放
     仍可手动裁）。自动旋转已彻底取消（2026-11-18 缺陷8 用户真机裁定）：
     滑到横屏源被自动转进横屏全屏是骚扰——进横屏只有一个入口，用户
     亲手点顶栏全屏钮。P3 的偏好记忆与按集自动进逻辑全删，旧键
     hghub_land_pref 就此弃用（不再读写）。横屏轻提示 LandHint 已于
     3.2.2 砍单删除（一次性引导浮层），旧键 hghub_land_hint_seen
     就此弃用（不再读写）。 */
  /* 单击/双击判定（上游 v2.2.0 lastTapRef 同位）：第一击的显隐快照 + 判定计时器；
     immersedKeyRef：开场默认沉浸（蓝图 P0）守卫——每集首次真正起播时收起控件
     一次（默认态只有视频），同一集内 seek/缓冲恢复不重复收起 */
  const tapJudgeRef = useRef<{ timer: number; clean: boolean; idle: boolean } | null>(null); const immersedKeyRef = useRef<string>("");
  /* 待判定单击的统一取消口（B2 追加）：页面失活清理与进度条 scrub 起手
   * 共用——scrub 独占期内绝不许挂起的单击判定到期翻显隐。 */
  const cancelPendingTapJudge = () => { if (tapJudgeRef.current) { window.clearTimeout(tapJudgeRef.current.timer); tapJudgeRef.current = null; } };
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ d0: number; mx0: number; my0: number; s0: number; x0: number; y0: number } | null>(null);

  const curId = effectiveVideoIds[index];
  const nextVideoId = effectiveVideoIds[index + 1];
  const relatedKey = `${store.lineEpoch}:${curId}`;
  const related = relatedByVideo[relatedKey] || [];
  const detail = details[curId];
  const tagKey = `${scope}:${store.lineEpoch}:${kind}:${curId}`;
  const permissionKey = `${tagKey}:${revision}`;
  const currentTags = kind === "post" ? posts[curId]?.tags : detail?.tags;
  const tagsReady = !!checked[tagKey];
  const blocked = filtering && tagsReady ? blockReason(currentTags) : null;
  const allowed = !filtering || (tagsReady && !blocked);
  const closePanels = () => { setPanel(null); setTagMenu(false); };
  const openPreferences = () => { closePanels(); store.push({ kind: "settings", section: "内容偏好" }); };
  const openTagMenu = openPreferences;
  const openTag = (tag: string) => { closePanels(); store.push({ kind: "tag", tag, name: tag }); };
  useEffect(() => { setTagMenu(false); setPanel(null); }, [curId, store.lineEpoch, scope]);
  useEffect(() => { if (blocked && mode === "home" && active) onBlocked?.(curId); }, [blocked, mode, active, curId, onBlocked]);
  useEffect(() => { if (!allowed) { setPanel(null); setTagMenu(false); } }, [allowed]);
  const curEp = epMap[curId] || 1;
  currentEntryRef.current = { id: curId, ep: curEp };
  const collected = isFav(curId, kind);
  const collectActionKey = `collect:${kind}:${curId}`;
  const collectPending = actionPending(collectActionKey);
  const actionContext = useRef({ scope, lineEpoch: store.lineEpoch, id: curId, ep: curEp, kind });
  actionContext.current = { scope, lineEpoch: store.lineEpoch, id: curId, ep: curEp, kind };
  /* 旧实现在此有「账号作用域变化 → 清续播进度」的重置 effect：
   * scope 恒定后永不触发，已删除（切线重置由 lineEpoch 键式承担）。 */
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const pendingActions = useRef(new Set<string>());
  /* 播放键作用域化（audit6 P1-3）：scope:lineEpoch:id:ep，与请求层键式统一 */
  const playKey = playCache.keyFor(curId, curEp);
  /* 内容键（整改 B1）：epoch 无关的条目标识，切线连续性全链以它对账 */
  const contentKey = `${curId}:${curEp}`;
  const playGuard = useRef({ allowed, id: curId, permissionKey, playKey });
  playGuard.current = { allowed, id: curId, permissionKey, playKey };
  const isCurrentPlayback = () => playGuard.current.allowed && playGuard.current.id === curId
    && playGuard.current.permissionKey === permissionKey && playGuard.current.playKey === playKey;
  const mainUrl = playCache.getMain(playKey) || "";
  const hevcUrl = playCache.getHevc(playKey) || "";
  /* Muse 2026-11-18 (2.2.0 合并, 移植 2.1.4): HEVC 回退按集锁定——解码/格式类失败只锁当前集，
     切集后新集重新优先高清；网络类失败不锁。
     审计修订（同日）: 单值锁会被后一集覆盖、切回已锁集时重试+重复弹提示 → 改 Set 保全历史；
     锁键带 lineEpoch，切线后旧锁自然失效（坏流可能只是单线路问题）；分类收窄见 onError。 */
  const [hevcDeadKeys, setHevcDeadKeys] = useState<ReadonlySet<string>>(new Set());
  const hevcKey = `${store.lineEpoch}:${playKey}`;
  const playUrl = preferHevc && hevcUrl && !hevcDeadKeys.has(hevcKey) ? hevcUrl : mainUrl;
  /* 卡顿自愈（2.0.5）：逻辑在 ./stallHeal，Feed 只接线 */
  const { lastStallAtRef, healResumeRef, onFragStats, resetHealWindow } = useStallHeal({
    active, isDesktop, playKey, curId, curEp, videoRef, paused,
    invalidatePlay: (ck: string) => { playSkipRef.current.add(ck); }, setErr, setProxyRetry,
  });
  const measurementKey = JSON.stringify([scope, store.lineEpoch, permissionKey, playKey, playUrl]);
  const videoSize = vsize.key === measurementKey ? vsize : { key: measurementKey, w: 0, h: 0 };
  // 等播放画面就绪再提示，启动动画/协议、加载失败和其他面板不叠加教程。
  /* Muse 2026-11-18 (2.2.0 合并): 长按引导浮层按 2.1.1 定版移除，恒 false */
  const showHoldGuide = false;
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
  useEffect(() => { setZoom({ s: 1, x: 0, y: 0, g: false }); pinchRef.current = null; pointersRef.current.clear(); }, [playUrl]);
  useEffect(() => { videoRef.current?.trace("page.active", { active, view: mode, video_id: curId, episode: curEp }); }, [active, mode, curId, curEp]);
  const episodes = detail?.episodes || [];
  const post = posts[curId];

  /* 观看进度：onTime 里每 5 秒落一次；退出播放页时再用 liveRef 兜一次 */
  const onTimeTick = (t: number) => {
    if (!isCurrentPlayback()) return;
    // Keep the writer from this observation; a later clear must invalidate old cleanup data.
    if (active) historyWriter.current = addHistory;
    liveRef.current = { id: curId, ep: curEp, dur: duration, t, permissionKey, scope };
    lastPosRef.current.set(contentKey, t);
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
    liveRef.current = { id: curId, ep: curEp, dur: d, t: historyWriter.current === addHistory && liveRef.current.id === curId && liveRef.current.ep === curEp && liveRef.current.scope === scope ? liveRef.current.t : 0, permissionKey, scope };
    /* 接回登记消费（整改 B1）：按内容键命中——自愈重解析与切线保位
     * 共用此口径，epoch 变不再影响命中；只消费一次。 */
    const healT = consumeHealResume(healResumeRef.current, curId, curEp);
    if (healT !== null && healT > 1 && (!d || healT < d - 3)) {
      videoRef.current?.seek(healT, "stall_heal");
      playbackClock.publish(healT);
    }
    const r = resumeRef.current;
    if (r && r.key === contentKey && r.t > 1 && (!d || r.t < d - 3)) {
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
        collect: detail?.counts?.collect ?? 0,
        episodes: detail?.episodes || [],
      };

  const posterUrl = cover(meta.cover, 900);
  const articleHtml = kind === "post" && !post?.video_url ? (post?.content || "") : "";

  /* 倍速：底栏 RateMenu 定档（store.rate）；长按任意位置固定 2x 临时加速走 holdState，松手恢复 */
  /* 沉浸全屏 + 横屏视频 → 舞台旋转 90°，看起来就是横屏 */
  const rotated = !isDesktop && fs && videoSize.w > videoSize.h && videoSize.h > 0 && !vpLandscape;
  const landscapeVideo = videoSize.w > 0 && videoSize.h > 0 && videoSize.w > videoSize.h;
  /* 竖屏即全屏呈现（Muse 2026-11-18 用户裁定）：竖屏源把多余内容隐藏后
     与全屏无实质区别（抖音竖屏无全屏概念），Feed 播放时直接以全屏那套
     控件/底栏呈现，不再要用户手动点全屏、不产生进入/退出步骤。fsUi 只管
     呈现门控；真实 fs 的滚动锁定、方向请求、分节隐藏仍只认 store.fs。
     横屏源维持手动进/退全屏。fsUi 下退出钮不出现（无进入动作即无退出
     语义，空间还给其余控件、不新增按钮填空）；页签带由 App 按 clean 驱动
     （fsUi 显隐与 clean 镜像，见 onUp tap 分支），底栏高度随 bottomInset
     让位，不与页签带叠层。 */
  const fsUi = fs || (!isDesktop && kind === "video" && !landscapeVideo);
  /* 控件闲置隐藏：桌面 2.8s；移动全屏呈现（fs/fsUi）按设置秒数（#146-3）。
     调用点在 fsUi 定义之后：自动隐藏要覆盖竖屏即全屏呈现态。 */
  const { idle, setIdle, wake, arm } = useFsIdle(isDesktop, fsUi, paused, store.fsIdleSecs, boxRef, barPct !== null);
  /* 单击判定到期读现值（整改 B5）：clean/idle/fsUi 的每渲染镜像 ref，超时回调不吃点击时捕获的快照 */
  const cleanRef = useRef(clean); cleanRef.current = clean; const idleRef = useRef(idle); idleRef.current = idle; const fsUiRef = useRef(fsUi); fsUiRef.current = fsUi; const vpLandRef = useRef(vpLandscape); vpLandRef.current = vpLandscape;
  /* 竖屏快捷胶囊的显隐：不卸载、只改 opacity，这样淡入淡出都能过渡（#19） */
  /* 胶囊显隐只由缩放驱动（定版：仅 zoom>1.05 显示），不挂 clean：
     clean 的驱动源几经变更（播放状态→单击解耦），若继续挂 !clean，
     播放中双指放大后胶囊会被显隐模型连带误杀——「还原」点不到、只能
     捏回去（Muse 2026-11-18 portrait-fit 回归实锤）。 */
  const capsuleOn = !fs && !isDesktop && zoom.s > 1.05;

  /* ── 竖滑切作品（2026-11-18 用户真机纠正，推翻凌晨「滑动切集恒开」）──
   * 竖滑恒沿 feed 流切换下一个/上一个作品，绝不在同一作品内换集；
   * 集内切换只走选集抽屉 / 操作行上下集钮 / 片尾自动下一集。
   * 普通态走原生滚动（touch-action: pan-y），停稳 150ms 后按所在屏
   * 切作品；全屏态滚动锁定（overflow-hidden），手势在抬手时一次性
   * 判定、按 index 直切。swipeEp 字段自此恒 false，仅留旧配置兼容。
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

  /* 统一的上下切换：恒切作品（竖滑语义定版，见上方注释）。
     桌面端键盘 ↑↓ 与右侧按钮都走这里，和移动端竖滑保持一致。 */
  const stepDir = useCallback((dir: number) => {
    go(dir);
  }, [go]);

  const canStep = (dir: number) => {
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
      const key = `${scope}:${epoch}:${kind}:${id}`;
      if (checked[key] || tagErrors[key]) return;
      const request = kind === "post" ? api.post(id) : requestDetail(id);
      request.then(value => {
        if (!mounted.current || actionContext.current.scope !== scope || actionContext.current.lineEpoch !== epoch) return;
        if (!value) {
          setTagErrors(previous => ({ ...previous, [key]: "标签暂不可用，请重试" }));
          return;
        }
        if (kind === "post") setPosts(previous => ({ ...previous, [id]: value as Post }));
        else setDetails(previous => ({ ...previous, [id]: value as Detail }));
        setTagErrors(previous => { const next = { ...previous }; delete next[key]; return next; });
        setChecked(previous => ({ ...previous, [key]: true }));
      }).catch(error => {
        if (mounted.current && actionContext.current.scope === scope && actionContext.current.lineEpoch === epoch) {
          setTagErrors(previous => ({ ...previous, [key]: error instanceof Error ? error.message : "标签暂不可用，请重试" }));
        }
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, kind, index, effectiveVideoIds, proxyRetry, store.lineEpoch, scope, checked, tagErrors, requestDetail, filtering]);

  /* 相关推荐只在用户打开详情时拉取，避免和首播抢占网络。 */
  useEffect(() => {
    if (!active || !curId || kind !== "video" || !allowed || panel !== "detail" || relatedByVideo[relatedKey]) return;
    const id = curId;
    api.related(id).then((r) => {
      if (mounted.current) setRelatedByVideo(previous => capStringRecordByFifo({ ...previous, [relatedKey]: r?.items || [] }, 100));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, curId, kind, allowed, panel, relatedKey, relatedByVideo]);

  /* 拉播放地址 */
  useEffect(() => {
    if (!active || !curId || !allowed) return;
    if (playCache.getMain(playKey)) return;
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
        playCache.setUrls(playKey, streamUrl, hevcStream || undefined);
        if (kind === "video") addHistory(curId, curEp);
      })
      .catch((e) => { if (alive) setErr((e as Error).message || "取播放地址失败"); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, curId, curEp, proxyRetry, allowed, permissionKey, requestPlay]);

  /* 当前集拿到地址后再预取下一集，避免首帧加载期间争抢网络。 */
  useEffect(() => {
    if (!active || !curId || kind !== "video" || !allowed || playingKey !== playKey || episodes.length === 0) return;
    let alive = true;
    const ep = epMap[curId] || 1;
    const nextEpisode = ep + 1;
    if (nextEpisode > episodes.length) return;
    const key = playCache.keyFor(curId, nextEpisode);
    if (playCache.getMain(key)) return;
    requestPlay(curId, nextEpisode)
      .then((info) => {
        if (!alive || !playGuard.current.allowed || playGuard.current.permissionKey !== permissionKey) return;
        const u = info?.streams?.main || info?.video_url;
        const h = info?.streams?.hevc || info?.video_url_hevc || "";
        if (u) playCache.setUrls(key, u, h || undefined);
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
    const nextKey = playCache.keyFor(nextId, 1);
    if (playCache.getMain(nextKey)) return;
    const stillRelevant = () => alive && mounted.current && playGuard.current.id === currentId
      && playGuard.current.permissionKey === currentPermission && idsRef.current[index + 1] === nextId;
    void (async () => {
      try {
        const nextDetail = detailsRef.current[nextId] || await requestDetail(nextId);
        if (!stillRelevant()) return;
        if (!detailsRef.current[nextId]) {
          setDetails(previous => ({ ...previous, [nextId]: nextDetail }));
          setChecked(previous => ({ ...previous, [`${scope}:${store.lineEpoch}:${kind}:${nextId}`]: true }));
        }
        if (filtering && blockReason(nextDetail.tags)) {
          if (mode === "home") onBlocked?.(nextId);
          return;
        }
        const info = await requestPlay(nextId, 1);
        if (!stillRelevant()) return;
        const url = info?.streams?.main || info?.video_url;
        const hevc = info?.streams?.hevc || info?.video_url_hevc || "";
        if (url) playCache.setUrls(nextKey, url, hevc || undefined);
      } catch {
        // The next item resolves normally when selected.
      }
    })();
    return () => { alive = false; };
  }, [active, curId, index, nextVideoId, kind, mode, allowed, playingKey, playKey, playCache.version, permissionKey, scope, store.lineEpoch, filtering, blockReason, onBlocked, requestDetail, requestPlay]);

  /* 首分片预热调度（当前条目即时预热＋下一条出画后预热＋失败重试）：
     实现在 useFeedPrewarm（Feed 尺寸预算外移），本体见 prewarm.ts */
  useFeedPrewarm({
    active, kind, scope, lineEpoch: store.lineEpoch, playKey, playingKey,
    curId, curEp, nextVideoId, episodes, cacheVersion: playCache.version,
    keyFor: playCache.keyFor, getMain: playCache.getMain,
  });

  /* 续播多点保存（蓝图 P4）：暂停/切后台/离开即时刷盘，守卫见 useProgressFlush */
  const flushProgressRef = useProgressFlush({ kind, paused, liveRef, playGuard, actionContext, historyWriter });

  /* 切换条目/集数时重置播放状态（重置前尝试刷上一集位置：守卫仍对账
     旧 playKey 时才写，选集路径已在 pickEp 同步刷过，此处兜底滑动切条目）。
     整改 B1：同 id:ep 仅作用域变化（切线/换代理）不算切换——不重置
     暂停意图、不 publish(0)；切换前最后已知位置登记接回，新面时长
     就绪时由 onDurationTick 接回（与自愈共用登记表）。 */
  useEffect(() => {
    const prev = prevPlayRef.current;
    const scopeOnly = isScopeOnlyChange(prev.playKey, playKey, prev.contentKey, contentKey);
    prevPlayRef.current = { playKey, contentKey };
    if (scopeOnly) {
      const t = lastPosRef.current.get(contentKey) || 0;
      if (t > 1) recordHealResume(healResumeRef.current, curId, curEp, t);
      setPlayingKey(playKey);
      return;
    }
    flushProgressRef.current();
    setDuration(0); setErr(""); setWaiting(true); setPaused(false);
    setPlayingKey("");
    resetHealWindow();
    playbackClock.publish(0);
  }, [playKey]);

  /* 音量/静音同步 */
  useEffect(() => { videoRef.current?.mute(muted); }, [muted]);
  useEffect(() => { videoRef.current?.volume(volume); }, [volume]);
  /* 倍速同步只剩 VideoSurface 内部 rate effect 一处（prop 传 store.rate）；
     长按倍速由手势回调经 videoRef.rate() 直通道下发，不再经 Feed effect */

  /* 键盘 */
  useEffect(() => {
    if (!active || !allowed || controlsLocked || showHoldGuide) return;
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
        case "m": case "M": setMuted((v) => !v); break;
        case "s": case "S": onFav(); break;
        case "e": case "E": setPanel("episodes"); break;
        default: break;
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, allowed, controlsLocked, showHoldGuide, panel, index, stepDir, scope, curEp, kind, collected, collectPending]);

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

  /* 暂停不锁显（2026-11-18 用户真机纠正，删除解耦版的「暂停锁显」）：
     显隐与播放状态彻底解耦——单击在播放/暂停任一状态都只翻显隐，
     暂停不强制全显、也不阻止隐藏；恢复播放的入口有二（再单击呼出
     控制层点播放钮、或双击画面），不靠锁显保底。桌面有自己的
     hover/闲置模型，不跟随。 */

  /* 边缘返回不在本面触发（fix330/gesture-back 一致性批）：旧版面内
     自带判定（doEdgeBack：先关面板、再退全屏、最后 onBack）已删。
     壳层链在边缘起手时经统一返回序分发——面板经本面登记的
     setBackHandler／以 Sheet 呈现时经弹层自身的 overlay 登记先行
     消费，退全屏与退栈（context 模式即 onBack 的落点）由返回序
     后续步骤处理：落点与旧序等价，判定全 App 只剩一处。 */

  /* —— 长按固定 2x（松手恢复） / 横拖定位 / 单击显隐 —— */
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDesktop || controlsLocked || !active || showHoldGuide) return;
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
      const pg = gesture.current;
      if (pg?.timer) window.clearTimeout(pg.timer);
      /* pinch 打断 scrub：先按 scrub 退出不变量清状态并按 g.playing 恢复，
         否则 scrub 浮层残留且视频停在 scrub 的暂停态无人恢复 */
      if (pg?.mode === "scrub" || scrub !== null) clearScrub(pg?.playing ?? false);
      gesture.current = null;
      resetHold();
      setZoom((z) => ({ ...z, g: true }));
      return;
    }
    if (gesture.current || e.button !== 0) return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const rot = rotated;
    const width = (rot ? rect.height : el.clientWidth) || 1;
    const [sx, sy] = stageXY(rot, e.clientX, e.clientY);
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const g = {
      x: sx, y: sy, startY: sy, t: Date.now(), base: videoRef.current?.el()?.currentTime ?? playbackClock.getSnapshot(), width,
      mode: "idle" as "idle" | "hold" | "scrub" | "pan",
      rotated: rot,
      edge: e.clientX <= GESTURE_EDGE_PX,
      edgeR: window.innerWidth - e.clientX <= GESTURE_EDGE_PX, rawX: e.clientX, rawY: e.clientY,
      playing: videoRef.current?.el()?.paused === false,
      timer: window.setTimeout(() => {
        const cur = gesture.current;
        if (!cur || cur.mode !== "idle" || cur.edge || cur.edgeR) return;
        cur.mode = "hold";
        /* Muse 2026-11-18 (真机反馈修回 2.1.5 定版): 长按去分区、固定 2x——任意位置
           长按即临时加速，松手立即恢复原速，绝不锁定、不换挡。合并时引入的左右滑
           换挡 2/3/4/6x 被用户裁定为多余复杂（松手恢复后下次仍从 2x 起、用不上），已删。 */
        holdRef.current = true;
        holdState.set(2); videoRef.current?.rate(2);
        startHoldJank();
        try { navigator.vibrate?.(25); } catch { /* ignore */ }
      }, HOLD_DELAY_MS) as unknown as number,
    };
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
    const [sx, sy] = stageXY(g.rotated, e.clientX, e.clientY);
    const dx = sx - g.x, dy = sy - g.y;

    /* 长按中：固定 2x，移动不做任何事，松手恢复（定版语义） */
    if (g.mode === "hold") return;

    /* 边缘起手整体让行（fix330/gesture-back 一致性批）：方向未定前
       不许 scrub/pan 抢占（hold 已在 timer 处被 edge 挡下）；返回的
       判定与触发归壳层链（屏幕坐标、统一门控），本面不再锁定/代行
       （旧 28px／1.5 锥角锁定＋64px 触发已删）。判定认屏幕坐标而非
       舞台坐标——CSS 旋转舞台下屏幕方向与舞台方向不同，返回手势
       认的是屏幕边缘。 */
    if (g.edge || g.edgeR) return;

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
    resetHold();
    if (!g) return;
    if (g.timer) window.clearTimeout(g.timer);

    /* 松手即恢复原速：hold 已在上方无条件复位，不留任何锁定态（定版语义） */
    if (g.mode === "hold") return;
    if (g.mode === "scrub") {
      const target = scrubTarget.current;
      if (!cancelled && target != null) videoRef.current?.seek(target, "mobile_gesture");
      setScrub(null);
      scrubTarget.current = null;
      if (g.playing && active) videoRef.current?.play();
      return;
    }
    /* 边缘起手收尾：成返回手势的已由壳层链在 touchend 以统一门控
       触发（本面不代行）；未成手势的边缘拖动一律吞掉（不落 pan/
       切集），只有轻点（<10px）放行到下方单击分支。 */
    if ((g.edge || g.edgeR) && (cancelled || !e || Math.hypot(e.clientX - g.rawX, e.clientY - g.rawY) >= 10)) return;
    /* 竖滑手势（竖滑语义定版：恒切作品）：普通态 overlay 是
       touch-action:pan-y，原生滚动接管、本分支不到达；全屏态滚动
       锁定（touch-action:none + overflow-hidden），这里抬手一次性
       判定、按 index 直切下一/上一作品，绝不切集。 */
    if (!cancelled && e && g.mode === "pan") {
      const [ux, uy] = stageXY(g.rotated, e.clientX, e.clientY);
      const dy = uy - g.startY;
      const dx2 = ux - g.x;
      if (Math.abs(dy) > 56 && Math.abs(dy) > Math.abs(dx2)) {
        if (fs) {
          const dir = dy < 0 ? 1 : -1;
          const next = Math.max(0, Math.min(effectiveVideoIds.length - 1, idxRef.current + dir));
          if (next !== idxRef.current) resolveSwipe(next);
        }
      }
    }
    if (!cancelled && g.mode === "idle" && Date.now() - g.t < 260) {
      /* 单击/双击判定（Muse 2026-11-18 用户改派定版，判定结构与上游
         v2.2.0 lastTapRef 同位）：第一击只快照显隐并起 250ms 判定计时、
         不执行任何变更；窗口内第二击到达 = 双击——取消待执行显隐（显隐
         从未变过，天然无闪烁）、恢复快照兜底、改判切换暂停/播放且不碰
         显隐；窗口到期才执行单击显隐。绝不用「先翻显隐、第二击再翻
         回来」：中间态会真实渲染，正是用户骂的闪烁来源。单击显隐语义
         沿解耦版（只翻显隐不碰播放），且暂停态与播放态完全同权——
         暂停锁显已按用户真机纠正删除，暂停时单击照样可隐藏/呼出；
         延迟是双击判定的必要代价。暂停/播放双路径并存：双击画面 +
         控制层底部中央钮，各自单义、不算耦合。按钮/进度条/面板不
         落在手势面内，不触发本分支。 */
      if (tapJudgeRef.current) {
        window.clearTimeout(tapJudgeRef.current.timer);
        const snap = tapJudgeRef.current;
        tapJudgeRef.current = null;
        setClean(snap.clean);
        if (fsUi) setIdle(snap.idle);
        videoRef.current?.toggle();
      } else {
        /* 到期执行读现值（整改 B5）：250ms 内 clean/idle/fsUi 可能已被
         * 其他路径（闲置隐藏、进出全屏）改动，按点击时快照翻转会翻错
         * 方向；快照只保留在 tapJudgeRef 供双击恢复路径使用。 */
        const timer = window.setTimeout(() => {
          tapJudgeRef.current = null;
          if (fsUiRef.current) {
            if (idleRef.current) { wake(); setClean(false); } else { setIdle(true); setClean(true); }
          } else setClean(!cleanRef.current);
        }, 250) as unknown as number;
        tapJudgeRef.current = { timer, clean, idle };
      }
    }
  };

  useEffect(() => {
    if (!active || controlsLocked || showHoldGuide) {
      if (!active) { setPanel(null); setTagMenu(false); }
      onUp(true);
      pointersRef.current.clear();
      pinchRef.current = null;
      /* 待判定的单击不许跨页/跨锁执行（与上游 lastTapRef 清理同位） */
      cancelPendingTapJudge();
    }
    // Cancel pending gestures when the page is hidden or controls are locked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, controlsLocked, showHoldGuide]);

  useEffect(() => () => {
    if (gesture.current?.timer) window.clearTimeout(gesture.current.timer);
    if (tapJudgeRef.current) window.clearTimeout(tapJudgeRef.current.timer);
    tapJudgeRef.current = null;
    gesture.current = null;
    /* Muse 2026-11-18 (审计修复延续): 切集必须同清 hold——只清 holdRef 时
       hold 倍速会残留到新集且再无 pointerup 能清；resetHold 同清 ref 与
       外部 store 并把 video 倍速恢复基准，先复位再换源。 */
    resetHold();
    /* scrub 残留同清：切集时 scrub 浮层/目标不许带进新集；不恢复旧播放
       （restorePlay=false），新集自有起播逻辑 */
    clearScrub(false);
  }, [playKey]);

  /* 进出全屏：iOS 会在这时把播放打断，过渡期多次续播（audit6 P1-4：
     实现收敛到 useFsKeepAlive——三查＋意愿门＋切条即清定时器；
     整改 B2：第①查改活动层三态信号，系统打断不再被当用户暂停） */
  const playKeyRef = useRef(playKey);
  playKeyRef.current = playKey;
  const keepAlive = useFsKeepAlive({
    playKey,
    pauseState: () => videoRef.current?.pauseState() ?? "paused_by_system",
    currentPlayKey: () => playKeyRef.current,
    isVideoPaused: () => videoRef.current?.el()?.paused === true,
    play: () => videoRef.current?.play("fs_keepalive", true),
  });

  const enterFs = useCallback((landscape: boolean) => {
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
    /* 进全屏先全显控件（恢复入口优先，解耦版）；之后显隐由单击决定 */
    setClean(false);
    setFs(true);
    wake();
    keepAlive();
    if (!isDesktop) {
      /* isTauri 守卫（顺手修复）：非 Tauri 环境（浏览器夹具/预览）下
         invoke 会以未处理 rejection 形式报错，同步 try/catch 挡不住；
         与 shared/lib/clipboard 的既有惯例一致。 */
      try { if (isTauri()) void invoke("set_orientation", { landscape }); } catch { /* ignore */ }
      if (landscape) {
        try {
          (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.("landscape")?.catch(() => {});
        } catch { /* ignore */ }
      }
    }
  }, [isDesktop, keepAlive, resolveSwipe, effectiveVideoIds.length, setClean, setFs, wake]);

  const exitFs = useCallback(() => {
    /* 退全屏回普通态先全显控件（恢复入口优先，解耦版）；之后显隐由单击决定 */
    setClean(false);
    setFs(false);
  }, [setClean, setFs]);

  /* 顶栏全屏钮（缺陷7 + 缺陷8 收口，2026-11-18 用户再裁定）：横屏源在
     控制层顶栏恒有明确入口，这是进横屏的唯一入口——点击进横屏全屏；
     全屏时同位变退出钮。竖屏源不渲染（竖屏已满屏呈现，无此语义）。 */
  const toggleLandscapeFs = useCallback(() => {
    if (fs) { exitFs(); return; }
    enterFs(true);
  }, [fs, exitFs, enterFs]);

  useFsOrientation(fs, isDesktop, keepAlive);

  /* 若用户在视频首帧宽高解析出来前已点进全屏，解析出横屏后自动补发横屏方向请求 */
  useEffect(() => {
    if (isDesktop || !fs || !landscapeVideo) return;
    try { if (isTauri()) void invoke("set_orientation", { landscape: true }); } catch { /* ignore */ }
    try {
      (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.("landscape")?.catch(() => {});
    } catch { /* ignore */ }
  }, [isDesktop, fs, landscapeVideo]);

  /* 系统真旋转了（iOS 原生请求成功后），CSS 就不再转 90°；
     物理横置手机时自动进入全屏，竖回时自动退出全屏（对齐 LNPANDY 版）。 */
  useEffect(() => {
    if (isDesktop) return undefined;
    const onViewportChange = () => {
      const isLand = window.innerWidth > window.innerHeight;
      /* setFs/keepAlive/wake 挪出状态更新器（整改 B6）：更新器须纯，
       * 副作用在其中会被双调用/丢弃语义影响；改读 vpLandRef 现值在
       * 更新器外判定与调用，横置进全屏/竖回退出的行为一字不变。 */
      if (vpLandRef.current !== isLand && active) { setFs(isLand); keepAlive(); wake(); }
      vpLandRef.current = isLand;
      setVpLandscape(isLand);
    };
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("orientationchange", onViewportChange);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("orientationchange", onViewportChange);
    };
  }, [isDesktop, active, setFs, keepAlive, wake]);

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

  /* 长按倍速期间禁止原生滚动，否则上滑会被列表吃掉、锁不住倍速 */
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
    if (pct != null) setBarPct(pct);
    return pct;
  };
  /* 进度条只认拖动（2026-11-18 收官批 A1，用户真机纠正）：单击/误触进度条
   * 不再 seek——按下只记录起点，位移过 8px 才算拖动（开始预览），
   * 松手才落点 seek；无位移抬手什么都不发生。 */
  const onBarDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    /* scrub 独占（B2 追加）：进度条起手即取消挂起的单击显隐判定——
     * 判定窗（250ms）内开始拖条，旧实现到期照样翻显隐、拖一半控件
     * 跳变；自此 scrub 期间显隐/切集/滚动全部让位于 scrub 锁（区内
     * pointer capture＋stopPropagation＋touchAction:none 已挡其余）。 */
    cancelPendingTapJudge();
    videoRef.current?.trace("seek.input.down", { input: "mobile_bar" });
    barScrub.current = true;
    barDrag.current = { x: e.clientX, y: e.clientY, moved: false };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const onBarMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!barScrub.current) return;
    e.stopPropagation();
    const drag = barDrag.current;
    if (drag && !drag.moved && (rotated ? Math.abs(e.clientY - drag.y) : Math.abs(e.clientX - drag.x)) < 8) return;
    if (drag) drag.moved = true;
    videoRef.current?.trace("seek.input.move", { input: "mobile_bar" });
    barSeekTo(e.clientX, e.clientY);
  };
  const onBarUp = (e: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    if (!barScrub.current) return;
    barScrub.current = false;
    e.stopPropagation();
    /* pointercancel 只清拖动态、不提交 seek（整改 B9，与主手势面 onUp(true) 口径一致） */
    const pct = !cancelled && barDrag.current?.moved ? barPctAt(e.clientX, e.clientY) : null;
    if (barDrag.current?.moved) barClickSwallow.current = true;
    barDrag.current = null;
    if (pct != null && duration) {
      const target = pct * duration;
      videoRef.current?.trace("seek.input.up", { input: "mobile_bar", target });
      videoRef.current?.seek(target, "mobile_bar");
      playbackClock.publish(target);
    }
    setBarPct(null);
  };
  /* click-after-drag 吞咽（B2 追加）：拖动后的 click 只许落在 scrub 区
   * 本身，不许冒泡触发任何宿主 click 语义；无位移的抬手不吞。 */
  const onBarClick = (e: React.MouseEvent) => { if (barClickSwallow.current) { barClickSwallow.current = false; e.stopPropagation(); } };


  const actionIsCurrent = () => mounted.current && actionContext.current.scope === scope && actionContext.current.lineEpoch === store.lineEpoch
    && actionContext.current.id === curId && actionContext.current.ep === curEp && actionContext.current.kind === kind;


  const onFav = async () => {
    const pendingKey = `${scope}:${collectActionKey}`;
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


  const pickEp = (ep: number) => {
    flushProgressRef.current(); // 切集前先刷当前集位置（此刻 liveRef/playGuard 仍是旧集）
    setEpMap((m) => ({ ...m, [curId]: ep }));
    setPanel(null);
  };

  /* 控制层（蓝图 P1）：顶栏返回与操作行上下集。
     返回与硬件返回同序：全屏先退全屏、context 回上一页、home 回浏览页。
     收官批 E 项：home 落点由分类改搜索——与顶栏放大镜、画面右划三者同门
     同落点（全 App 进浏览区只落搜索一个点；分类经链上右划/页签到达）。 */
  const goBack = () => { if (fs) exitFs(); else if (mode === "context" && onBack) onBack(); else store.setTab("search"); };
  const epIdx = episodes.findIndex((e) => e.ep_num === curEp);
  const stepEp = (d: 1 | -1) => { const t = episodes[epIdx + d]; if (t) pickEp(t.ep_num); };

  /* 详情页左划下一条（fix2.1 批四#12）：来源列表上下文即本组件自持
   * 的 effectiveVideoIds/index，无需外部传参；注册逻辑见 useDetailNext。 */
  useDetailNext({ enabled: active && mode === "context", episodes, curEp, index, count: effectiveVideoIds.length, pickEp, go });

  /* 收藏计数（上游原算法在 ActionRail.useSocialCounts；点赞已于 3.2.2 砍单删除） */
  const { collectCount } = useSocialCounts(meta, detail, kind, collected);

  const detailBody = (onClose?: () => void) => <VideoDetailsPanel meta={meta} videoId={curId} episodeCount={episodes.length}
    related={related} onTag={openTag} onClose={onClose} onPreferences={openTagMenu}
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
      className={`hg-player-ui ${rotated ? "fs-landscape" : (!isDesktop && fs ? "fs-immersive" : "absolute inset-0")} overflow-hidden bg-black player-root ${controlsLocked ? "is-locked" : ""} ${isDesktop ? "player-surface" : ""} ${isDesktop && idle ? "is-idle" : ""}`}
      data-clean={clean}
      inert={!active || undefined}
      aria-hidden={!active || undefined}
      onFocusCapture={() => { if (active && isDesktop) wake(); }}
      onPointerMove={() => { if (isDesktop) wake(); }}>
      <div className="absolute inset-0" inert={controlsLocked}>
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
          if (filtering && !isActive && (!checked[`${scope}:${store.lineEpoch}:${kind}:${vid}`] || tagErrors[`${scope}:${store.lineEpoch}:${kind}:${vid}`] || blockReason(kind === "post" ? posts[vid]?.tags : details[vid]?.tags))) {
            return <section key={vid} className={sectionClass} aria-hidden="true" />;
          }
          return (
            <section key={vid} className={sectionClass} inert={!isActive || undefined} aria-hidden={!isActive || undefined}>
              {isActive && playUrl ? (
                <div ref={holdTargetRef} data-mobile-hold-target={!isDesktop || undefined}
                  data-player-surface="true"
                  className="absolute inset-0" style={{ touchAction: fs ? "none" : "pan-y" }}
                  onPointerDown={onDown} onPointerMove={onMove} onPointerUp={(e) => onUp(false, e)} onPointerCancel={(e) => onUp(true, e)} onLostPointerCapture={(e) => onUp(true, e)}>
                <div style={{ position: "absolute", inset: 0, transform: isDesktop ? undefined : `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.s})`, transformOrigin: "center center", transition: isDesktop || zoom.g ? "none" : "transform .18s ease-out" }}>
                <VideoSurface ref={videoRef} src={playUrl} poster={posterUrl} autoPlay active={active && !tagMenu && !showHoldGuide} muted={muted}
                  diagnosticContext={{ active: active && !tagMenu && !showHoldGuide, view: mode, kind, video_id: curId, episode: curEp }}
                  volume={volume} rate={rate}
                  measurementKey={measurementKey}
                  fit="contain"
                  onClick={() => { if (isDesktop) videoRef.current?.toggle(); }}
                  onTime={onTimeTick}
                  onDuration={onDurationTick}
                  onSize={(w, h, key) => {
                    if (key !== measurementKey || !isCurrentPlayback()) return false;
                    setVsize((prev) => (prev.key === key && prev.w === w && prev.h === h ? prev : { key, w, h }));
                    return true;
                  }}
                  onPlaying={() => { if (isCurrentPlayback()) { setPaused(false); setWaiting(false); setErr(""); setPlayingKey(playKey); if (!isDesktop && immersedKeyRef.current !== playKey) { immersedKeyRef.current = playKey; setClean(true); setIdle(true); } } }}
                  onPause={() => { if (isCurrentPlayback()) setPaused(true); }}
                  onWaiting={() => { if (isCurrentPlayback()) { setWaiting(true); lastStallAtRef.current = Date.now(); } }}
                  onFragStats={onFragStats}
                  onEnded={() => { if (!isCurrentPlayback()) return; const next = episodes.find((e) => e.ep_num === curEp + 1); if (next) pickEp(next.ep_num); }}
                  onError={(m) => {
                    if (!isCurrentPlayback()) return;
                    setErr(m); setWaiting(false);
                    /* 分类只认解码/格式证据：旧正则的裸 mediaError 会把 bufferStalled/bufferFull
                       等非解码 fatal 也锁死（审计实测命中）；hls 串形如 mediaError/<details>，
                       原生串靠 mediaErrors 的 (decode)/(format) token 命中。 */
                    const decodeErr = /decode|SRC_NOT_SUPPORTED|format/i.test(m);
                    if (decodeErr && preferHevc && hevcUrl && !hevcDeadKeys.has(hevcKey)) {
                      setHevcDeadKeys((prev) => new Set(prev).add(hevcKey));
                      toast("本集高清播不了，已切标准", "info");
                    }
                  }} />
                </div>
                </div>
              ) : (
                <div className="absolute inset-0">
                  {(!filtering || checked[`${scope}:${store.lineEpoch}:${kind}:${vid}`]) &&
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

              {/* 顶部：移动端视频条目由单一控制层顶栏接管（蓝图 P1），此处只剩桌面与图文 */}
              {!fs && !clean && mode === "context" && (isDesktop || kind !== "video") ? (
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
              {!fsUi && !clean && !isDesktop && mode === "context" && kind !== "video" && (
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
                    ? "inline-flex items-center gap-0.5 min-h-8 px-1 rounded-full backdrop-blur-xl elev-2 whitespace-nowrap"
                    : "flex flex-col items-stretch gap-1 p-1 rounded-[18px] backdrop-blur-xl elev-2"}
                    style={{ background: "rgba(12,15,22,.58)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.09)" }}>
                    {landscapeVideo && zoom.s > 1.05 && (
                      <>
                        <Button type="button" onClick={() => setZoom({ s: 1, x: 0, y: 0, g: false })}
                          className="whitespace-nowrap flex items-center justify-center gap-1 h-[26px] px-3 rounded-full text-[12px] font-semibold pressable transition-colors duration-150"
                          style={{ color: "rgba(255,255,255,.9)" }}>
                          {`还原 ${zoom.s.toFixed(1)}x`}
                        </Button>
                        <Button type="button" onClick={() => enterFs(true)}
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
              {/* 右栏已整体撤销（2026-11-18 用户再裁定）：喜欢删除、评论只在
                  抽屉评论页、收藏移入控制层顶栏——视频区不再有任何右栏覆层，
                  底部信息行整行无遮挡（原缺陷1 的重叠随右栏消失不复存在，
                  test-layout 改为负断言守门）。 */}

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
                  <Button onClick={() => setPanel("episodes")} aria-label="选集" className="flex flex-col items-center gap-1 pressable">
                    <IList size={26} className="text-white tsh" />
                    <span className="text-[12px] text-white/90">选集</span>
                  </Button>
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
              {!fsUi && !isDesktop && kind === "post" && (
                <div data-feed-info-zone="true" className="absolute inset-x-0 z-20" style={{ bottom: `calc(var(--sab, 0px) + ${bottomInset}px)` }}>
                  {/* 图文帖保留原信息块；视频条目的信息已并入单一控制层（蓝图 P1） */}
                  {!clean && (
                  <div className="mobile-video-meta-copy relative pb-2 flex items-center gap-2">
                    <p className="flex-1 min-w-0 text-[15px] font-semibold leading-snug hg-ink-2 hg-ov-shadow-strong clamp-2">{meta.title}</p>
                  </div>
                  )}
                  <div className="relative pt-1.5 pb-2.5">
                    {!clean && (
                    <div className="mobile-video-meta-copy flex flex-wrap items-center gap-2">
                      {/* Muse 2026-11-18 (真机反馈修回 2.1.2 定版): 「详情 · 第X集」拆成两个独立
                          点击目标——点「详情」开详情面板；点「第X集」直达选集网格，不穿详情面板。
                          2.2.0 合并时退回合并按钮，用户实测「要点详情再点集数」，本次恢复拆分。 */}
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
                    )}
                    {/* 热区 ≥28px（B2 追加，用户实报误触）：旧高 14px，起手稍偏即落进手势面被判 tap/pan */}
                    <div data-feed-scrub-zone="true" ref={barRef} className="mx-4 mt-2 relative" style={{ height: 28, touchAction: "none" }}
                      onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={(e) => onBarUp(e, true)} onClick={onBarClick}>
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

              {/* 画面中央不再放暂停钮（蓝图 P1，GPT 理由成立：中央是观看区
                  且单手够不到）——暂停/播放统一走控制层底部中央钮与双击；
                  8275a16 的中央大钮至此回退。桌面保留原只读暂停指示。 */}
              {isActive && paused && !err && isDesktop && (
                <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                  <span className="w-[66px] h-[66px] rounded-full flex items-center justify-center backdrop-blur-md" style={{ background: "rgba(0,0,0,.55)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.12)" }}>
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
                    <Button className="hg-link text-[14px]" onClick={() => {
                      setErr(""); setWaiting(true);
                      if (playUrl && videoRef.current) videoRef.current.retry();
                      else setProxyRetry(value => value + 1);
                    }}>重试</Button>
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
          muted={muted} volume={volume} fullscreen={fullscreen}
          visible={active && !idle}
          seekEnabled={active && !controlsLocked}
          seekKey={playKey}
          dockInset={panel ? 372 : 0}
          nextDisabled={!episodes.some((e) => e.ep_num === curEp + 1) && index >= effectiveVideoIds.length - 1}
          nextTitle={episodes.some((e) => e.ep_num === curEp + 1) ? "下一集 E" : "下一部 ↓"}
          onToggle={() => videoRef.current?.toggle()}
          onSeek={(t, source) => { videoRef.current?.seek(t, source); playbackClock.publish(t); }}
          onSeekInteraction={(phase, input, target, pointerTarget) => videoRef.current?.trace(`seek.input.${phase}`, { input, target, pointer_target: pointerTarget })}
          onRate={(r) => { setRate(r); videoRef.current?.rate(r); }}
          onMute={() => setMuted((m) => !m)}
          onVolume={(v) => setVolume(v)}
          onFullscreen={toggleFull}
          onNext={() => {
            const nx = episodes.find((e) => e.ep_num === curEp + 1);
            if (nx) pickEp(nx.ep_num);
            else go(1);
          }}
        />
      )}

      {/* 移动端：倍速状态 / 锁定提示 */}
      {/* 锁定提示并入倍速胶囊：锁定只看上滑距离，不存在「拖到某个位置」的目标 */}
      {!isDesktop && <HoldBadge fs={fs} idle={idle} onResetRate={() => { setRate(1); videoRef.current?.rate(1); }} />}

      {/* 控件隐藏时只留一条细进度线贴底（蓝图：默认态只有视频 + 细进度条）；
          暂停态同权（锁显删除后暂停隐藏控件也只剩这条线）。
          收官批 A5：真实全屏（fs）隐藏态例外——用户裁定全屏藏就全藏，
          细线与时间一并消失、画面零覆层；竖屏信息流态（fsUi 非 fs）保留。 */}
      {!isDesktop && kind === "video" && !fs && (fsUi ? idle : clean) && (
        <div className="absolute inset-x-0 z-30 pointer-events-none" style={{ bottom: rotated ? 0 : "var(--sab, 0px)", paddingLeft: rotated ? "max(52px, env(safe-area-inset-left))" : 0, paddingRight: rotated ? "max(52px, env(safe-area-inset-right))" : 0 }}>
          <div className="h-[2.5px]" style={{ background: "rgba(255,255,255,.3)" }}>
            <PlaybackProgress clock={playbackClock} duration={duration} preview={null} className="h-full bg-white" />
          </div>
        </div>
      )}

      {/* ── 单一控制层（蓝图 P1，Muse 2026-11-18）──
          移动端视频条目的信息与操作只属于这一层：顶栏（返回/集数定位/
          静音/搜索）+ 底部（剧名·集数与时间行/可拖进度条/操作行），同显
          同隐、不拆多个悬浮层；显隐走解耦模型（普通态 clean、全屏呈现态
          idle；暂停不锁显，播放/暂停同权）。操作行固定构成：上一集 | 选集（抽屉单入口，
          恒落选集页）| 暂停/播放（底部中央 52px）| 下一集 | 倍速 | 全屏（仅横屏源）。
          蓝图双入口（选集/内容两钮）已按 2026-11-18 第11项极简裁定合并：
          详情/评论只在抽屉内点页签到达。此前并存的全屏
          底栏、独立全屏进度条、两处退出钮与中央大钮至此合并回退——真实
          全屏的退出由顶栏返回承担（与硬件返回同序：先退全屏）。底栏
          44px 地板与不出视口的几何教训（2.2.0 溢出修复）由 test-layout
          按视口矩阵继续守门。 */}
      {!isDesktop && kind === "video" && (fsUi ? !idle : !clean) && (
        <div className="hg-chrome-in absolute inset-x-0 top-0 z-40 flex items-center gap-2 px-3" style={{ paddingTop: "calc(var(--sat, 0px) + 6px)", paddingBottom: 20, background: "linear-gradient(to bottom, rgba(21,23,27,.9), transparent)" }}>
          <Button onClick={goBack} aria-label="返回" className="hg-chip-strong w-11 h-11 rounded-full backdrop-blur-md flex items-center justify-center pressable elev-1">
            <IBack size={20} />
          </Button>
          {/* 集数定位：竖屏居中；真实全屏（横屏）时居中会压在画面主体
              （人脸）上（2026-11-18 晚用户真机截图裁定），改贴左跟在返回
              钮之后，右侧用占位把静音钮顶回右缘。 */}
          <span className={fs ? "text-[13px] font-semibold text-[#A1A5AD] hg-ov-shadow tabular-nums" : "flex-1 text-center text-[13px] font-semibold text-[#A1A5AD] hg-ov-shadow tabular-nums"}>
            {episodes.length > 1 ? `第 ${curEp} 集 / 共 ${episodes.length} 集` : "正片"}
          </span>
          {fs && <span className="flex-1" />}
          <Button onClick={() => setMuted((m) => !m)} aria-label={muted ? "取消静音" : "静音"} className="hg-chip-strong w-11 h-11 rounded-full backdrop-blur-md flex items-center justify-center pressable elev-1">
            {muted ? <IVolMute size={18} /> : <IVol size={18} />}
          </Button>
          {/* 收藏自右栏移入顶栏（2026-11-18 用户再裁定）：只随控制层出现、
              平时零遮挡；收藏态以金色实心星明确区分（aria-pressed 同步）。
              收官批 A4：真实全屏（fs）顶栏再精简——收藏/搜索属浏览类动作，
              不进全屏，只留返回/集数定位/静音；竖屏呈现态（fsUi 非 fs）不变。 */}
          {!fs && (<>
            <Button onClick={() => void onFav()} disabled={collectPending} aria-busy={collectPending} aria-pressed={collected} aria-label="收藏" className="hg-chip-strong w-11 h-11 rounded-full backdrop-blur-md flex items-center justify-center pressable elev-1">
              {collected ? <IStarF size={18} className="hg-gold" /> : <IStar size={18} />}
            </Button>
            <Button onClick={() => store.setTab("search")} aria-label="搜索" className="hg-chip-strong w-11 h-11 rounded-full backdrop-blur-md flex items-center justify-center pressable elev-1">
              <ISearch size={18} />
            </Button>
          </>)}
        </div>
      )}
      {!isDesktop && kind === "video" && (fsUi ? !idle : !clean) && (
        <div data-feed-info-zone="true" className="hg-chrome-in absolute inset-x-0 bottom-0 z-40"
          style={{ paddingBottom: `calc(var(--sab, 0px) + ${bottomInset}px + 6px)`, background: "linear-gradient(to top, rgba(21,23,27,.92), rgba(21,23,27,.55) 55%, transparent)" }}>
          {/* 信息行（收官批 A6/A7 合并）：原三行（剧名+集数 / 热度 / 进度）
              压成一行——左=剧名（可截断）+热度三数字灰色小字同行跟随，
              右=时间；「第X集」删除（顶栏已有「第X集/共Y集」，A6 去重）。
              热度仍只读（判热门程度用，不做按钮；收藏在顶栏星钮、评论在
              抽屉）。热度与时间 shrink-0，长剧名先截断、不挤压右侧。 */}
          <div className="px-4 pb-0.5 flex items-baseline gap-2">
            <span className="min-w-0 truncate text-[15px] font-semibold text-[#F5F5F5] hg-ov-shadow">{meta.title}</span>
            <span className="shrink-0 text-[11px] font-medium text-[#A1A5AD] tabular-nums">藏 {fmt(collectCount)}</span>
            <span className="shrink-0 ml-auto text-[11px] font-semibold text-[#A1A5AD] tabular-nums"><PlaybackTime clock={playbackClock} /> / {fmtTime(duration)}</span>
          </div>
          {/* 热区 ≥28px（B2 追加，同信息区 scrub 区口径）：旧包裹高 22px */}
          <div className="px-4" style={{ height: 28 }}>
            <div data-feed-scrub-zone="true" ref={barRef} className="relative h-full" style={{ touchAction: "none" }}
              onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={(e) => onBarUp(e, true)} onClick={onBarClick}>
              <div className="absolute inset-x-0 bottom-[8px] h-[2.5px] rounded-full" style={{ background: "rgba(255,255,255,.3)" }}>
                <PlaybackProgress clock={playbackClock} duration={duration} preview={barPct} className="h-full rounded-full bg-white" />
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between px-2"
            style={{ paddingLeft: rotated ? "calc(var(--sat, 0px) + 16px)" : undefined, paddingRight: rotated ? "calc(var(--sab, 0px) + 16px)" : undefined }}>
            <Button onClick={() => stepEp(-1)} disabled={epIdx <= 0} aria-label="上一集"
              className="hg-chip w-11 h-11 rounded-full flex items-center justify-center pressable disabled:opacity-35">
              <INext size={18} style={{ transform: "scaleX(-1)" }} />
            </Button>
            <Button onClick={() => setPanel("episodes")} aria-label="选集"
              className="hg-chip h-11 px-3 rounded-full flex items-center gap-1 text-[13px] font-semibold pressable">
              <IList size={15} />选集
            </Button>
            <Button onClick={() => videoRef.current?.toggle()} aria-label={paused ? "播放" : "暂停"}
              className="hg-chip-strong w-[52px] h-[52px] rounded-full backdrop-blur-md flex items-center justify-center pressable elev-1">
              {paused ? <IPlayF size={24} className="ml-0.5" /> : <IPauseF size={22} />}
            </Button>
            <Button onClick={() => stepEp(1)} disabled={epIdx < 0 || epIdx >= episodes.length - 1} aria-label="下一集"
              className="hg-chip w-11 h-11 rounded-full flex items-center justify-center pressable disabled:opacity-35">
              <INext size={18} />
            </Button>
            <div className="relative">
              <Button onClick={() => setRateMenuOpen((v) => !v)} aria-label="倍速选择" aria-expanded={rateMenuOpen}
                className={`h-11 px-3 rounded-full flex items-center gap-1 text-[13px] font-bold pressable ${rate !== 1 ? "bg-primary text-on-primary" : "hg-chip"}`}>
                <IBoltF size={13} />{rate}x
              </Button>
              {rateMenuOpen && (
                <RateMenu current={rate} onSelect={(r) => { setRate(r); videoRef.current?.rate(r); setRateMenuOpen(false); }} />
              )}
            </div>
            {/* 全屏钮（缺陷7 入口、第11项定版位置）：操作行右端，仅横屏源
                渲染，进/退同位，随控制层显隐 */}
            {landscapeVideo && (
              <Button onClick={toggleLandscapeFs} aria-label={fs ? "退出全屏" : "全屏"}
                className="hg-chip w-11 h-11 rounded-full flex items-center justify-center pressable">
                {fs ? <ICompress size={18} /> : <IExpand size={18} />}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* 选集 / 详情 / 评论三页签面板：桌面停靠在右侧（画面让位），移动端底部弹层。
          Muse 2026-11-18 (用户裁定): 评论从独立弹层并入本面板页签；移动端操作行
          只剩「选集」单入口、恒落选集页（第11项合并裁定，推翻蓝图双入口），
          详情在面板内点页签切换、无页签记忆（评论页签已于 3.2.2 砍单删除）。 */}
      {isDesktop ? (
        <div className={`desktop-dock-panel ${panel ? "is-open" : ""}`}>
          <div className="desktop-dock-inner">
            {(panel === "detail" || panel === "episodes") ? (
              <>
                <div className="shrink-0 flex items-center gap-2 px-4 pt-3 pb-2">
                  <SegmentedControl className="flex-1" aria-label="剧集面板" activeIndex={panel === "episodes" ? 0 : 1}>
                    {([["episodes", "选集"], ["detail", "详情"]] as const).map(([k, l]) => (
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
                    detailBody(() => setPanel(null))
                  )}
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          {/* 吃瓜图文正文 */}
          <Sheet open={active && panel === "article"} onClose={() => setPanel(null)}>
            <div className="flex flex-col" style={{ height: "78dvh" }}>
              <ArticlePanel title={meta.title} html={articleHtml} cover={meta.cover} hot={post?.hot} onClose={() => setPanel(null)} />
            </div>
          </Sheet>

          <Sheet open={active && (panel === "detail" || panel === "episodes")} label={panel === "episodes" ? "选集" : "视频详情"} onClose={() => setPanel(null)}>
            <div className="video-details-sheet">
              {/* 两页签抽屉：选集 / 详情，单入口恒落选集，页签内切换 */}
              <div className="shrink-0 flex items-center gap-2 px-4 pb-2">
                <SegmentedControl className="flex-1" aria-label="剧集面板" activeIndex={panel === "episodes" ? 0 : 1}>
                  {([["episodes", "选集"], ["detail", "详情"]] as const).map(([k, l]) => (
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
      {/* 右上工具组：视频条目的静音/搜索已并入单一控制层顶栏（蓝图 P1），此处只剩图文帖 */}
      {!isDesktop && kind !== "video" && !controlsLocked && active && (!fsUi || !idle) && (
        <div className={`absolute z-40 flex items-center gap-2 ${fs ? "" : "right-3"}`}
          style={{
            top: rotated ? 12 : "calc(var(--sat, 0px) + 6px)",
            // 触屏下按钮实际 44px：退出键占 12–56，锁定组从 68 起，留 12px 间距
            right: fs ? (rotated ? "calc(var(--sab, 0px) + 68px)" : 68) : undefined,
          }}>
          {!fsUi && !clean && <Button onClick={() => setMuted(m => !m)} aria-label={muted ? "取消静音" : "静音"}
            className="hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1">
            {muted ? <IVolMute size={17} /> : <IVol size={17} />}
          </Button>}
          {!fsUi && !clean && <Button onClick={() => store.setTab("search")} aria-label="搜索"
            className="hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1"><ISearch size={18} /></Button>}
        </div>
      )}
    </div>
  );
}
