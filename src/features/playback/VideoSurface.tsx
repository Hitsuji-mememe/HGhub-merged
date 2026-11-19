import { useEffect, useLayoutEffect, useImperativeHandle, useRef, forwardRef, useState, type MutableRefObject } from "react";
import Hls from "hls.js";
import { platform } from "../../shared/api/api";
import { connectNativeMedia, playbackSource } from "./mediaTransport";
import { AppendStallWatchdog } from "./appendStallWatchdog";
import { createStallWatchdog, wireStallWatchdogSignals } from "./stallWatchdogWiring";
import { mediaErrorMessage } from "./mediaErrors";
import { mediaHost, mediaResource, observeHls, registerHlsVersion, usePlayerDiagnostics } from "../../shared/diagnostics/playbackDiagnostics";
import { notePlaybackPlaying, publishPlaybackFacts } from "../../shared/diagnostics/playbackFacts";
import { usePlaybackActivity } from "./usePlaybackActivity";
import { useProxyPlaybackRecovery } from "./useProxyPlaybackRecovery";
import { createHlsRecovery, type HlsRecovery } from "./hlsRecovery";
import { useStore, type SuperResMode } from "../../shared/model/store";
import { effectiveSrMode, getSvgFilterUrl, presentationPipeline, srVideoFilterMode, SuperResSvgDefs } from "./SuperResCanvas";
import SrCanvas from "./SrCanvas";
import { createHlsPlayerConfig, currentLineSeedBps, formatFirstRendition, lockHighestStartLevel, observeFirstRendition } from "./hlsConfig";
import { useSrDensity } from "./useSrDensity";
import { createFragThroughputReporter, originOf } from "./playbackThroughput";
import { api } from "../../shared/api/api";

export type FragStats = { bytes: number; loadMs: number; fragDuration: number; bitrate: number };

if (Hls.version) registerHlsVersion(Hls.version);

export type VideoHandle = {
  el: () => HTMLVideoElement | null;
  play: (source?: string, automatic?: boolean) => void;
  retry: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number, source?: string) => void;
  trace: (event: string, data?: Record<string, unknown>) => void;
  rate: (r: number) => void;
  mute: (m: boolean) => void;
  volume: (v: number) => void;
  isActive: () => boolean;
  isPlayWanted: () => boolean;
};

type Props = {
  src: string;
  poster?: string;
  autoPlay?: boolean;
  active?: boolean;
  fadeIn?: boolean;
  videoElementRef?: MutableRefObject<HTMLVideoElement | null>;
  measurementKey?: string;
  diagnosticContext?: Record<string, unknown>;
  muted?: boolean;
  loop?: boolean;
  fit?: "contain" | "cover";
  /** 换源后重新套用，避免切集时音量/倍速被浏览器重置 */
  volume?: number;
  rate?: number;
  onTime?: (t: number) => void;
  onDuration?: (d: number) => void;
  onSize?: (w: number, h: number, measurementKey: string) => boolean | void;
  onPlay?: () => void;
  onPlaying?: () => void;
  onPause?: () => void;
  onWaiting?: () => void;
  onSeeked?: () => void;
  onEnded?: () => void;
  onError?: (msg: string) => void;
  /* 跟版合并（Muse 2026-11-18）：上游在切源 effect 里调用 onClearError
   * 清旧错误态；我方调用方暂不传（无参即空操作），先补齐契约避免悬空引用。 */
  onClearError?: () => void;
  onFragStats?: (s: FragStats) => void;
  onClick?: () => void;
  className?: string;
};

/** 只负责「播」：hls.js + video 元素，控制条由外层渲染。 */
const VideoSurface = forwardRef<VideoHandle, Props>(function VideoSurface(
  { src, poster, autoPlay = true, active = true, measurementKey = src, diagnosticContext = {}, muted = false, loop = false, fit = "contain", volume = 1, rate = 1,
    onTime, onDuration, onSize, onPlaying, onPause, onWaiting, onSeeked, onEnded, onError, onClearError, onFragStats, onClick, className = "" },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const latestSource = useRef(src); latestSource.current = src;
  const attachedSource = useRef<string | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const fragStatsCbRef = useRef(onFragStats);
  fragStatsCbRef.current = onFragStats;
  /* 真实播放吞吐回写账本（P0-B ⑤）：每 5 片中位数 bps 节流回写。 */
  const throughputRef = useRef<ReturnType<typeof createFragThroughputReporter> | null>(null);
  if (!throughputRef.current) {
    throughputRef.current = createFragThroughputReporter((origin, bps) => {
      void api.lineRecordPlayback(origin, bps).catch(() => { /* 命令缺失/失败静默 */ });
    });
  }
  const recoveryRef = useRef<HlsRecovery | null>(null);
  /* append 卡死自愈计数（F 项）：同一源第一次判死重建、第二次判死触发
   * 会话级原生降级；换源清零（重建走 revision  bump、src 不变，不清）。 */
  const stallAttemptRef = useRef(0);
  const engineRef = useRef("");
  const stallSrcRef = useRef(src);
  if (stallSrcRef.current !== src) { stallSrcRef.current = src; stallAttemptRef.current = 0; }
  const nearEndFiredRef = useRef(false);
  const reportedSizeRef = useRef({ key: "", w: 0, h: 0 });
  const measurementRef = useRef({ key: measurementKey, onSize });
  measurementRef.current = { key: measurementKey, onSize };
  const [ready, setReady] = useState(false);
  const [svgFallback, setSvgFallback] = useState(false);
  const store = useStore();
  /* 超分全自动（2026-11-18 收官批）：档位由 srPref + 源分辨率 + 码率密度
   * 推导；密度取首个完整分片的实际码率（字节×8÷时长），起播即可估，
   * 取到后自动纠正档位。原生引擎无分片数据，密度留空走纯分辨率规则。 */
  const [srSize, setSrSize] = useState({ w: 0, h: 0 });
  /* 密度采样收敛为共享 hook（audit6 P0-A 第 2 层）：前 3 片中位数＋
   * frameRate＋videoCodec，与 Player 同口径；换源/换线（lineEpoch）重置。 */
  const { density: srDensity, ingest: ingestSrFrag } = useSrDensity(src, store?.lineEpoch ?? 0);
  /* 首分片 rendition（audit6 P0-A 第 1 层）：hls.js 取事件、原生记实际分辨率。 */
  const [firstRendition, setFirstRendition] = useState<string | undefined>(undefined);
  const [webgpuEngaged, setWebgpuEngaged] = useState(false);
  const [srDemoteCount, setSrDemoteCount] = useState(0);
  const srMode = effectiveSrMode(store?.srPref ?? "auto", srSize.w, srSize.h, srDensity ?? undefined);
  /* U1：SuperResCanvas 回报的实际呈现档位（含性能降档结果）。合成层
   * 保底是否挂载按它判（见下方 videoFilter），不按判档 srMode 猜——
   * 判档是 crisp 但已被降到 off 时，保底同样要顶上。 */
  const [canvasSrMode, setCanvasSrModeRaw] = useState<SuperResMode>(srMode);
  const canvasSrModeRef = useRef<SuperResMode>(srMode);
  /* 降档计数（facts 用）：呈现档沿 crisp→natural→off 阶梯下移即 +1。 */
  const setCanvasSrMode = (mode: SuperResMode) => {
    const ladder = ["crisp", "natural", "off"];
    const from = ladder.indexOf(canvasSrModeRef.current);
    const to = ladder.indexOf(mode);
    if (from >= 0 && to > from) setSrDemoteCount(n => n + (to - from));
    canvasSrModeRef.current = mode;
    setCanvasSrModeRaw(mode);
  };
  /* 诊断报告的源规格读取点（收官批 D）：尺寸/密度/档位变化时发布快照；
   * 根治包起同发首分片档位＋实际呈现管线＋降档次数（audit6 P0-A）。 */
  const canvasModeForFacts = canvasSrMode;
  useEffect(() => {
    if (srSize.w <= 0 || srSize.h <= 0) return;
    const fm = srVideoFilterMode({ srPref: store?.srPref ?? "auto", srMode, canvasMode: canvasModeForFacts, svgFallback, canvasOffReason: srMode === "off" ? "judged" : "demoted" });
    publishPlaybackFacts({ w: srSize.w, h: srSize.h, bitrateBps: srDensity?.bitrateBps, fps: srDensity?.fps, codec: srDensity?.codec, srMode, engine: engineRef.current || undefined, firstRendition, pipeline: presentationPipeline({ webgpuEngaged, canvasMode: canvasModeForFacts, filterMode: fm }), srDemoteCount, at: Date.now() });
  }, [srSize, srDensity, srMode, firstRendition, webgpuEngaged, canvasModeForFacts, svgFallback, srDemoteCount, store?.srPref]);
  const { trace, requestSeek } = usePlayerDiagnostics(videoRef, hlsRef, { ...diagnosticContext, active, resource: mediaResource(src) });
  const activity = usePlaybackActivity(videoRef, hlsRef, { active, autoPlay, src, trace });
  const proxyRecovery = useProxyPlaybackRecovery(videoRef, src, activity, trace);

  const reportSize = (v: HTMLVideoElement | null) => {
    if (!v || v !== videoRef.current || attachedSource.current !== latestSource.current || v.readyState < 1) return;
    const w = v.videoWidth || 0;
    const h = v.videoHeight || 0;
    if (w > 0 && h > 0) setSrSize(prev => (prev.w === w && prev.h === h ? prev : { w, h }));
    const current = measurementRef.current;
    if (w > 0 && h > 0 && (current.key !== reportedSizeRef.current.key || w !== reportedSizeRef.current.w || h !== reportedSizeRef.current.h)) {
      // A parent may reject an event during an item transition. Keep it eligible
      // for the next metadata/resize event instead of losing the size forever.
      if (current.onSize?.(w, h, current.key) !== false) {
        reportedSizeRef.current = { key: current.key, w, h };
      }
    }
  };

  useLayoutEffect(() => {
    // Re-emit existing metadata when the same source becomes current again.
    // A newly selected source is ignored until its transport has been attached.
    reportedSizeRef.current = { key: "", w: 0, h: 0 };
    setSrSize({ w: 0, h: 0 });
    setFirstRendition(undefined);
    setSrDemoteCount(0);
    reportSize(videoRef.current);
  }, [measurementKey, src, active]);

  useImperativeHandle(ref, () => ({
    el: () => videoRef.current,
    play: (source = "handle", automatic = false) => activity.play(source, automatic),
    retry: () => { if (activity.isActive()) proxyRecovery.retry("manual", true); },
    pause: () => activity.pause(),
    toggle: () => {
      const v = videoRef.current;
      if (!v) return;
      trace("toggle.request");
      if (v.paused) activity.play("toggle"); else activity.pause("toggle");
    },
    seek: (t: number, source = "handle") => {
      const v = videoRef.current;
      if (!v || !Number.isFinite(t)) return;
      // iOS 上直接赋到 duration 会卡在 ended 态，夹到结尾前 0.15s
      const dur = v.duration && Number.isFinite(v.duration) ? v.duration : 0;
      const target = dur > 0 ? Math.max(0, Math.min(dur - 0.15, t)) : Math.max(0, t);
      if (dur > 0 && target <= dur - 0.3) nearEndFiredRef.current = false;
      requestSeek(target, source);
      if (hlsRef.current) { try { hlsRef.current.startLoad(target); } catch { /* ignore */ } }
      const resume = !v.paused;
      try { v.currentTime = target; trace("seek.assigned", { target, source }); }
      catch (e) { trace("seek.rejected", { error_name: (e as Error).name }); throw e; }
      if (resume) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
    },
    trace,
    rate: (r: number) => { const v = videoRef.current; if (v) v.playbackRate = r; },
    mute: (m: boolean) => { const v = videoRef.current; if (v) v.muted = m; },
    volume: (vol: number) => { const v = videoRef.current; if (v) v.volume = vol; },
    isActive: () => activity.isActive(),
    isPlayWanted: () => activity.isPlayWanted(),
  }), []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    onClearError?.();
    attachedSource.current = null;
    setReady(false);
    reportedSizeRef.current = { key: "", w: 0, h: 0 };
    nearEndFiredRef.current = false;
    const resume = proxyRecovery.resume();
    const onVideoResize = () => reportSize(video);
    video.addEventListener("resize", onVideoResize);
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    const source = playbackSource(src, Hls.isSupported());
    engineRef.current = source.engine;
    throughputRef.current?.setOrigin(originOf(src));
    let disconnectNative: (() => void) | undefined;
    let stallWatchdog: AppendStallWatchdog | undefined;
    let detachWatchdog: (() => void) | undefined;
    /* auto_play 记活状态快照（audit5 条 3）：旧实现记 effect 捕获的旧
     * prop 值，诊断会失真；触发判据与记录口径统一读 activity 活状态。 */
    trace("source.load", { engine: source.engine, auto_play: activity.isPlayWanted(), resource: mediaResource(src), host: mediaHost(src) });

    /* 换源时先把音量/倍速套回去：hls 重新 attach 后浏览器会把它们重置成默认值 */
    const applySettings = () => {
      const v = videoRef.current;
      if (!v) return;
      v.volume = volume;
      v.muted = muted;
      v.playbackRate = rate;
    };
    applySettings();
    attachedSource.current = src;

    if (source.engine === "hls.js") {
      const hls = new Hls(createHlsPlayerConfig({
        ios: platform === "ios",
        startPosition: resume?.time ?? -1,
        seedBps: currentLineSeedBps(),
      }));
      hlsRef.current = hls;
      const recovery = createHlsRecovery({
        hls, video, url: source.url,
        isCurrent: () => hlsRef.current === hls,
        isActive: activity.isActive,
        resumePlayback: () => activity.play("media_recovery", true),
        onFatal: data => {
          const detail = `${data.type}/${data.details}/${data.response?.code ?? ""}/${String(data.reason ?? "").slice(0, 80)}`;
          (window as unknown as { __hlsErr?: string }).__hlsErr = detail;
          const readable = data.type === Hls.ErrorTypes.NETWORK_ERROR
            ? "视频网络加载失败，请检查线路或重试"
            : data.type === Hls.ErrorTypes.MEDIA_ERROR
              ? "视频解码异常，请重试"
              : "视频暂时无法播放，请重试";
          onError?.(readable);
          if (data.type !== Hls.ErrorTypes.NETWORK_ERROR && data.type !== Hls.ErrorTypes.MEDIA_ERROR) {
            hls.destroy(); hlsRef.current = null;
          }
        },
      });
      recoveryRef.current = recovery;
      /* 跟版合并（Muse 2026-11-18）：observeHls 改为显式传 eventsMap
       * （诊断模块不值导入 hls.js，保首屏剥离）；顺手登记版本供快照 trace。 */
      registerHlsVersion(Hls.version);
      observeHls(hls, trace, Hls.Events);
      /* append 卡死看门狗（F 项）：构造、意愿门控、判死/重建/降级/用尽
       * 报错与全部信号接线已收敛到 stallWatchdogWiring 一份（与 Player
       * 共用）；这里只注入本组件的差异——trace 取证字段（复审批 §C：
       * 判死时刻的 readyState 与缓冲末端）、proxyRecovery 重建通道、
       * onError 报错通道，以及分片到达后的自有逻辑（超分密度/吞吐上报）。 */
      stallWatchdog = createStallWatchdog({
        video,
        isCurrent: () => hlsRef.current === hls,
        isPlayWanted: () => activity.isPlayWanted(),
        pauseState: () => activity.pauseState(),
        attemptRef: stallAttemptRef,
        traceStall: (state, attempt) => {
          let bufEnd = -1;
          try { bufEnd = video.buffered.length > 0 ? Math.round(video.buffered.end(video.buffered.length - 1) * 10) / 10 : 0; } catch { /* 保持 -1 */ }
          trace("hls.append_stall", { attempt, state, rs: video.readyState, buf: bufEnd });
        },
        retry: (reason) => proxyRecovery.retry(reason, true),
        onExhausted: (message) => onError?.(message),
      });
      detachWatchdog = wireStallWatchdogSignals({
        hls, video, watchdog: stallWatchdog,
        /* 分片吞吐上报（2.0.5 卡顿自愈，Muse 2026-11-18 移植）：只报整片，耗时取 stats.loading 起止差 */
        onFragLoaded: (data) => {
        const st = data.frag.stats;
        /* 超分密度：共享采样器（前 3 片中位数＋fps/codec，换 level 重采） */
        ingestSrFrag({ loaded: st.loaded, duration: data.frag.duration, level: data.frag.level }, hls.levels[data.frag.level]);
        /* 真实播放吞吐入账（P0-B ⑤）：与下方消费者上报共用同一 loadMs 口径 */
        {
          const loadMs = st.loading.end > 0 && st.loading.end >= st.loading.start ? st.loading.end - st.loading.start : 0;
          if (loadMs > 0) throughputRef.current?.push(st.loaded, loadMs);
        }
        const cb = fragStatsCbRef.current;
        if (!cb) return;
        const loadMs = st.loading.end > 0 && st.loading.end >= st.loading.start ? st.loading.end - st.loading.start : 0;
        if (loadMs <= 0 || st.loaded <= 0) return;
        cb({ bytes: st.loaded, loadMs, fragDuration: data.frag.duration || 0, bitrate: hls.levels[data.frag.level]?.bitrate ?? 0 });
        },
        onFragBuffered: () => recovery.buffered(),
      });
      observeFirstRendition(hls, Hls.Events, r => setFirstRendition(formatFirstRendition(r)));
      hls.loadSource(source.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        /* 起播锁最高档（P0-A 第 1 层）：必须在 startLoad 之前落位。 */
        lockHighestStartLevel(hls);
        if (activity.isActive()) hls.startLoad(resume?.time ?? -1);
        if (activity.isPlayWanted() && !resume) activity.play("manifest_autoplay", true);
      });
      hls.on(Hls.Events.ERROR, (_e, data) => recovery.error(data));
    } else {
      disconnectNative = connectNativeMedia(video, source, {
        isCurrent: () => latestSource.current === src && videoRef.current === video,
        onReady: () => { if (activity.isPlayWanted() && !resume) activity.play("native_autoplay", true); },
        onError: message => { trace("source.transport_error"); onError?.(message); },
      });
    }

    /* 首帧呈现信号（复审批 §6.2）：playing 只是「能播」不等于已出画；
     * requestVideoFrameCallback 可用时记一次真实首帧，报告起播口径以它
     * 为准、无此信号回落 playing（代理判定）。每源注册一次、回调自解。 */
    /* VFC 三件套（audit5 条 6）：存句柄＋cleanup 取消＋回调首行验代次。
     * 旧实现句柄直接丢弃、从不取消、回调不验 attachedSource——换源后
     * 旧回调会在新源首帧上触发，把旧源迟到帧记成新源首帧、污染起播
     * 口径且重复记一条。 */
    const vfcTarget = video as unknown as {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (id: number) => void;
    };
    let vfcId: number | null = null;
    if (typeof vfcTarget.requestVideoFrameCallback === "function") {
      try {
        vfcId = vfcTarget.requestVideoFrameCallback.call(video, () => {
          if (attachedSource.current !== src) return;
          trace("media.first_frame");
        });
      } catch { /* 不可用则静默回落 */ }
    }

    return () => {
      throughputRef.current?.flush();
      if (vfcId != null && typeof vfcTarget.cancelVideoFrameCallback === "function") {
        try { vfcTarget.cancelVideoFrameCallback.call(video, vfcId); } catch { /* 忽略 */ }
      }
      attachedSource.current = null;
      notePlaybackPlaying(false);
      disconnectNative?.();
      stallWatchdog?.dispose();
      detachWatchdog?.();
      video.removeEventListener("resize", onVideoResize);
      recoveryRef.current?.dispose(); recoveryRef.current = null;
      trace("source.cleanup");
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, proxyRecovery.revision]);

  useLayoutEffect(() => { recoveryRef.current?.activityChanged(); }, [active]);

  // iOS 内联播放：部分 WKWebView 只认 HTML 属性
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.setAttribute("webkit-playsinline", "true");
  }, []);

  useEffect(() => { if (videoRef.current) videoRef.current.muted = muted; }, [muted]);
  useEffect(() => { if (videoRef.current) videoRef.current.volume = volume; }, [volume]);
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = rate; }, [rate]);

  const reapply = (v: HTMLVideoElement) => {
    v.volume = volume;
    v.muted = muted;
    v.playbackRate = rate;
  };

  const handleVideoError = () => {
    notePlaybackPlaying(false);
    if (hlsRef.current) return;
    onError?.(mediaErrorMessage(videoRef.current?.error ?? null));
  };

  /* U1 合成层选档（纯函数 srVideoFilterMode 判，触发条件全文在该函数
   * 注释）：WebGL 呈现中不挂（防双重处理）；WebGL 不呈现（自动判档
   * off / 性能降到 off）且用户未显式关时挂 SVG natural 保底；硬故障
   * svgFallback 时挂本档位滤镜（既有路径）。保底的退出全自动：WebGL
   * 升档恢复呈现的同一渲染内摘除，用户零操作。 */
  const filterMode = srVideoFilterMode({ srPref: store?.srPref ?? "auto", srMode, canvasMode: canvasSrMode, svgFallback, canvasOffReason: srMode === "off" ? "judged" : "demoted" });
  const videoFilter = filterMode ? getSvgFilterUrl(filterMode) : undefined;

  return (
    <div className={`relative w-full h-full bg-black overflow-hidden ${className}`}>
      <SuperResSvgDefs />
      <video
        ref={videoRef}
        poster={poster}
        playsInline
        preload="auto"
        muted={muted}
        loop={loop}
        onClick={onClick}
        className={`w-full h-full bg-black ${fit === "cover" ? "object-cover" : "object-contain"}`}
        style={{ opacity: ready ? 1 : 0, transition: "opacity .35s", filter: videoFilter }}
      onLoadedData={(e) => {
        const v = e.target as HTMLVideoElement;
        setReady(true);
        reapply(v);
        reportSize(v);
      }}
      onTimeUpdate={(e) => {
        const v = e.target as HTMLVideoElement;
        reportSize(v);
        onTime?.(v.currentTime);
        // iOS 有时不触发 ended：靠近片尾自己补一次，保证自动连播（暂停态拖动不触发切集）
        const d = v.duration;
        if (!v.paused && activity.isActive() && d && Number.isFinite(d) && v.currentTime > d - 0.3 && !nearEndFiredRef.current) {
          nearEndFiredRef.current = true;
          onEnded?.();
        }
      }}
      onLoadedMetadata={(e) => {
        const v = e.target as HTMLVideoElement;
        reapply(v);
        onDuration?.(v.duration || 0);
        reportSize(v);
        /* 原生路径 rendition 不可控（P0-A 第 1 层明示）：只记实际分辨率。 */
        if (engineRef.current && engineRef.current !== "hls.js" && v.videoWidth > 0) {
          setFirstRendition(`原生实际 ${v.videoWidth}x${v.videoHeight}（档位不可控）`);
        }
      }}
      onPlay={() => { if (activity.isActive()) notePlaybackPlaying(true); }}
      onPause={() => { if (activity.isActive()) notePlaybackPlaying(false); onPause?.(); }}
      onWaiting={() => onWaiting?.()}
      onSeeked={() => onSeeked?.()}
      onPlaying={(e) => {
        if (activity.isActive()) notePlaybackPlaying(true);
        reportSize(e.target as HTMLVideoElement);
        if (activity.isActive()) onPlaying?.();
      }}
      onEnded={() => { notePlaybackPlaying(false); if (activity.isActive()) onEnded?.(); }}
        onError={handleVideoError}
      />
      <SrCanvas
        videoRef={videoRef}
        mode={srMode}
        active={active}
        ready={ready}
        fit={fit}
        srcKey={src}
        fps={srDensity?.fps}
        onFallbackChange={setSvgFallback}
        onActiveModeChange={setCanvasSrMode}
        onPipelineChange={setWebgpuEngaged}
        onTrace={trace}
      />
    </div>
  );
});

export default VideoSurface;
