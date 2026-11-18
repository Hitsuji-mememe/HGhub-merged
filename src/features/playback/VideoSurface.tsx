import { useEffect, useLayoutEffect, useImperativeHandle, useRef, forwardRef, useState } from "react";
import Hls from "hls.js";
import { platform } from "../../shared/api/api";
import { connectNativeMedia, noteNativeFallback, playbackSource } from "./mediaTransport";
import { AppendStallWatchdog } from "./appendStallWatchdog";
import { mediaErrorMessage } from "./mediaErrors";
import { mediaHost, mediaResource, observeHls, usePlayerDiagnostics } from "../../shared/diagnostics/playbackDiagnostics";
import { notePlaybackPlaying, publishPlaybackFacts } from "../../shared/diagnostics/playbackFacts";
import { usePlaybackActivity } from "./usePlaybackActivity";
import { useProxyPlaybackRecovery } from "./useProxyPlaybackRecovery";
import { createHlsRecovery, type HlsRecovery } from "./hlsRecovery";
import { useStore } from "../../shared/model/store";
import SuperResCanvas, { effectiveSrMode, getSvgFilterUrl, SuperResSvgDefs } from "./SuperResCanvas";

export type FragStats = { bytes: number; loadMs: number; fragDuration: number; bitrate: number };

export type VideoHandle = {
  el: () => HTMLVideoElement | null;
  play: () => void;
  retry: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number, source?: string) => void;
  trace: (event: string, data?: Record<string, unknown>) => void;
  rate: (r: number) => void;
  mute: (m: boolean) => void;
  volume: (v: number) => void;
};

type Props = {
  src: string;
  poster?: string;
  autoPlay?: boolean;
  active?: boolean;
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
  onPlaying?: () => void;
  onPause?: () => void;
  onWaiting?: () => void;
  onEnded?: () => void;
  onError?: (msg: string) => void;
  onFragStats?: (s: FragStats) => void;
  onClick?: () => void;
  className?: string;
};

/** 只负责「播」：hls.js + video 元素，控制条由外层渲染。 */
const VideoSurface = forwardRef<VideoHandle, Props>(function VideoSurface(
  { src, poster, autoPlay = true, active = true, measurementKey = src, diagnosticContext = {}, muted = false, loop = false, fit = "contain", volume = 1, rate = 1,
    onTime, onDuration, onSize, onPlaying, onPause, onWaiting, onEnded, onError, onFragStats, onClick, className = "" },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const latestSource = useRef(src); latestSource.current = src;
  const attachedSource = useRef<string | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const fragStatsCbRef = useRef(onFragStats);
  fragStatsCbRef.current = onFragStats;
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
  const [srDensity, setSrDensity] = useState<{ bitrateBps: number; fps?: number; codec?: string } | null>(null);
  /* 码率样本（整改 4）：首分片对 VBR 源没代表性（片头黑场/Logo 会把
   * 码率拉得极低），改取前 3 个完整分片的中位数；换源清零。 */
  const srSamplesRef = useRef<number[]>([]);
  const srMode = effectiveSrMode(store?.srPref ?? "auto", srSize.w, srSize.h, srDensity ?? undefined);
  /* 诊断报告的源规格读取点（收官批 D）：尺寸/密度/档位变化时发布快照 */
  useEffect(() => {
    if (srSize.w <= 0 || srSize.h <= 0) return;
    publishPlaybackFacts({ w: srSize.w, h: srSize.h, bitrateBps: srDensity?.bitrateBps, fps: srDensity?.fps, codec: srDensity?.codec, srMode, engine: engineRef.current || undefined, at: Date.now() });
  }, [srSize, srDensity, srMode]);
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
    setSrDensity(null);
    srSamplesRef.current = [];
    reportSize(videoRef.current);
  }, [measurementKey, src, active]);

  useImperativeHandle(ref, () => ({
    el: () => videoRef.current,
    play: () => activity.play("handle"),
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
  }), []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
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
    let disconnectNative: (() => void) | undefined;
    let stallWatchdog: AppendStallWatchdog | undefined;
    let watchdogPlaying: (() => void) | undefined;
    trace("source.load", { engine: source.engine, auto_play: autoPlay, resource: mediaResource(src), host: mediaHost(src) });

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
      const hls = new Hls({
        // 禁用从插播/内容引导 JSON 派生直连 URL 的可选功能。
        interstitialsController: undefined,
        contentSteeringController: undefined,
        enableInterstitialPlayback: false,
        // WKWebView 里 hls.js 的 worker 不稳，iOS 关掉
        enableWorker: platform !== "ios",
        // Prefer standard MSE on macOS; hls.js handles MMS-only fallback and seek recovery.
        preferManagedMediaSource: false,
        autoStartLoad: false,
        startPosition: resume?.time ?? -1,
        maxBufferLength: 120,
        maxMaxBufferLength: 240,
        backBufferLength: 30,
        maxBufferHole: 0.5,
        nudgeOffset: 0.25,
        nudgeMaxRetry: 6,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 4,
        fragLoadingTimeOut: 25000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 400,
      });
      hlsRef.current = hls;
      const recovery = createHlsRecovery({
        hls, video, url: source.url,
        isCurrent: () => hlsRef.current === hls,
        isActive: activity.isActive,
        resumePlayback: () => activity.play("media_recovery", true),
        onFatal: data => {
          onError?.(`${data.type}/${data.details}`);
          if (data.type !== Hls.ErrorTypes.NETWORK_ERROR && data.type !== Hls.ErrorTypes.MEDIA_ERROR) {
            hls.destroy(); hlsRef.current = null;
          }
        },
      });
      recoveryRef.current = recovery;
      observeHls(hls, trace);
      /* append 卡死看门狗（F 项）：FragLoaded 有而 4s 内 buffered/playing
       * 全无 = append 链无声停滞。第一次判死重建本源重试；重建后再判死
       * 说明本会话 hls.js/MMS 整体坏死，置会话级原生降级并重建（此次
       * playbackSource 直接给 native）。慢网无 FragLoaded 不布防、不误杀。 */
      stallWatchdog = new AppendStallWatchdog({
        hasBuffered: () => { try { return video.buffered.length > 0 && video.buffered.end(video.buffered.length - 1) > 0; } catch { return false; } },
        isPlaying: () => !video.paused && video.readyState >= 2,
        onStall: (state) => {
          if (hlsRef.current !== hls) return;
          trace("hls.append_stall", { attempt: stallAttemptRef.current, state });
          if (stallAttemptRef.current < 1) {
            stallAttemptRef.current += 1;
            proxyRecovery.retry("append_stall", true);
          } else if (noteNativeFallback("append_stall")) {
            proxyRecovery.retry("append_stall_fallback", true);
          }
        },
      });
      watchdogPlaying = () => stallWatchdog?.playing();
      video.addEventListener("playing", watchdogPlaying);
      /* append 生命周期信号（整改 1 四状态判死）：开始/结束喂给看门狗，
       * 到点时据此区分未开始/处理中/已结束无缓冲，处理中先宽限不误杀。 */
      hls.on(Hls.Events.BUFFER_APPENDING, () => stallWatchdog?.appendStarted());
      hls.on(Hls.Events.BUFFER_APPENDED, () => stallWatchdog?.appendEnded());
      /* 分片吞吐上报（2.0.5 卡顿自愈，Muse 2026-11-18 移植）：只报整片，耗时取 stats.loading 起止差 */
      hls.on(Hls.Events.FRAG_LOADED, (_e, data) => {
        if (data.part || typeof data.frag.sn !== "number") return;
        stallWatchdog?.fragLoaded();
        const st = data.frag.stats;
        /* 超分密度（收官批 C 项 + 整改 4）：完整分片实际码率取前 3 片
         * 中位数（单片对 VBR 无代表性）；fps/codec 取自 manifest level，
         * 供判档按编码分阈值、fps 未知时走保守档。 */
        if (st.loaded > 0 && data.frag.duration > 0 && srSamplesRef.current.length < 3) {
          srSamplesRef.current = [...srSamplesRef.current, (st.loaded * 8) / data.frag.duration];
          const sorted = [...srSamplesRef.current].sort((a, b) => a - b);
          const median = sorted[Math.floor(sorted.length / 2)];
          const level = hls.levels[data.frag.level];
          const fps = level?.frameRate;
          setSrDensity({ bitrateBps: median, fps: fps && fps > 0 ? fps : undefined, codec: level?.videoCodec || undefined });
        }
        const cb = fragStatsCbRef.current;
        if (!cb) return;
        const loadMs = st.loading.end > 0 && st.loading.end >= st.loading.start ? st.loading.end - st.loading.start : 0;
        if (loadMs <= 0 || st.loaded <= 0) return;
        cb({ bytes: st.loaded, loadMs, fragDuration: data.frag.duration || 0, bitrate: hls.levels[data.frag.level]?.bitrate ?? 0 });
      });
      hls.loadSource(source.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (activity.isActive()) hls.startLoad(resume?.time ?? -1);
        if (autoPlay && !resume) activity.play("manifest_autoplay", true);
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => { recovery.buffered(); stallWatchdog?.buffered(); });
      hls.on(Hls.Events.ERROR, (_e, data) => recovery.error(data));
    } else {
      disconnectNative = connectNativeMedia(video, source, {
        isCurrent: () => latestSource.current === src && videoRef.current === video,
        onReady: () => { if (activity.isPlayWanted() && !resume) activity.play("native_autoplay", true); },
        onError: message => { trace("source.transport_error"); onError?.(message); },
      });
    }

    return () => {
      attachedSource.current = null;
      notePlaybackPlaying(false);
      disconnectNative?.();
      stallWatchdog?.dispose();
      if (watchdogPlaying) video.removeEventListener("playing", watchdogPlaying);
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
    if (hlsRef.current) return;
    onError?.(mediaErrorMessage(videoRef.current?.error ?? null));
  };

  const videoFilter = svgFallback ? getSvgFilterUrl(srMode) : undefined;

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
        // iOS 有时不触发 ended：靠近片尾自己补一次，保证自动连播
        const d = v.duration;
        if (d && Number.isFinite(d) && v.currentTime > d - 0.3 && !nearEndFiredRef.current) {
          nearEndFiredRef.current = true;
          onEnded?.();
        }
      }}
      onLoadedMetadata={(e) => {
        const v = e.target as HTMLVideoElement;
        reapply(v);
        onDuration?.(v.duration || 0);
        reportSize(v);
      }}
      onPlay={() => { notePlaybackPlaying(true); if (activity.isActive()) onPlaying?.(); }}
      onPause={() => { notePlaybackPlaying(false); onPause?.(); }}
      onWaiting={() => onWaiting?.()}
      onPlaying={(e) => {
        notePlaybackPlaying(true);
        reportSize(e.target as HTMLVideoElement);
        if (activity.isActive()) onPlaying?.();
      }}
      onEnded={() => { if (activity.isActive()) onEnded?.(); }}
        onError={handleVideoError}
      />
      <SuperResCanvas
        videoRef={videoRef}
        mode={srMode}
        active={active}
        ready={ready}
        fit={fit}
        srcKey={src}
        fps={srDensity?.fps}
        onFallbackChange={setSvgFallback}
        onTrace={trace}
      />
    </div>
  );
});

export default VideoSurface;
