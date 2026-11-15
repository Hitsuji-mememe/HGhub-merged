import { useEffect, useImperativeHandle, useRef, forwardRef, useState } from "react";
import Hls from "hls.js";
import { isLocalMedia, platform, playlist } from "../api";
import { mediaErrorMessage } from "../mediaErrors";
import { mediaHost, mediaResource, observeHls, usePlayerDiagnostics } from "../playbackDiagnostics";
import { usePlaybackActivity } from "../usePlaybackActivity";
import { useProxyPlaybackRecovery } from "../useProxyPlaybackRecovery";
import { useStore } from "../store";
import SuperResCanvas, { getSvgFilterUrl, SuperResSvgDefs } from "./SuperResCanvas";

/** hls 分片下载统计（Feed 卡顿自愈监测用）：一片下载完成时上报 */
export type FragStats = { bytes: number; loadMs: number; fragDuration: number; bitrate: number };

export type VideoHandle = {
  el: () => HTMLVideoElement | null;
  play: () => void;
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
  diagnosticContext?: Record<string, unknown>;
  muted?: boolean;
  loop?: boolean;
  fit?: "contain" | "cover";
  /** 换源后重新套用，避免切集时音量/倍速被浏览器重置 */
  volume?: number;
  rate?: number;
  onTime?: (t: number) => void;
  onDuration?: (d: number) => void;
  onSize?: (w: number, h: number) => void;
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
  { src, poster, autoPlay = true, active = true, diagnosticContext = {}, muted = false, loop = false, fit = "contain", volume = 1, rate = 1,
    onTime, onDuration, onSize, onPlaying, onPause, onWaiting, onEnded, onError, onFragStats, onClick, className = "" },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  /* hls 引擎在 effect 里创建，回调用 ref 读最新 props，避免闭包过期 */
  const fragStatsCbRef = useRef(onFragStats);
  fragStatsCbRef.current = onFragStats;
  const recoverCountRef = useRef(0);
  const recoverTimerRef = useRef<number | null>(null);
  const nearEndFiredRef = useRef(false);
  const reportedSizeRef = useRef({ w: 0, h: 0 });
  const [ready, setReady] = useState(false);
  const [svgFallback, setSvgFallback] = useState(false);
  const store = useStore();
  const srMode = store?.srMode ?? "off";
  const { trace, requestSeek } = usePlayerDiagnostics(videoRef, hlsRef, { ...diagnosticContext, active, resource: mediaResource(src) });
  const activity = usePlaybackActivity(videoRef, hlsRef, { active, autoPlay, src, trace });
  const proxyRecovery = useProxyPlaybackRecovery(videoRef, src, activity, trace);

  const reportSize = (v: HTMLVideoElement | null) => {
    if (!v) return;
    const w = v.videoWidth || 0;
    const h = v.videoHeight || 0;
    if (w > 0 && h > 0 && (w !== reportedSizeRef.current.w || h !== reportedSizeRef.current.h)) {
      reportedSizeRef.current = { w, h };
      onSize?.(w, h);
    }
  };

  useImperativeHandle(ref, () => ({
    el: () => videoRef.current,
    play: () => activity.play("handle"),
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
    setReady(false);
    reportedSizeRef.current = { w: 0, h: 0 };
    nearEndFiredRef.current = false;
    recoverCountRef.current = 0;
    const resume = proxyRecovery.resume();
    const onVideoResize = () => reportSize(video);
    video.addEventListener("resize", onVideoResize);
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    const proxied = isLocalMedia(src);
    const url = proxied ? src : playlist(src);
    const useHls = !url.includes("/seg?u=");
    trace("source.load", { engine: useHls && Hls.isSupported() ? "hls.js" : "native", auto_play: autoPlay, resource: mediaResource(src), host: mediaHost(src) });

    /* 换源时先把音量/倍速套回去：hls 重新 attach 后浏览器会把它们重置成默认值 */
    const applySettings = () => {
      const v = videoRef.current;
      if (!v) return;
      v.volume = volume;
      v.muted = muted;
      v.playbackRate = rate;
    };
    applySettings();

    if (useHls && Hls.isSupported()) {
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
        // Muse 2026-11-15（合并 v2.1.0 时按用户拍板）：预缓冲 30s → 120s，慢档波段靠库存撑播放；
        // maxMaxBufferLength 是 hls.js 的硬上限，必须同步抬高否则 120 会被砍回 60。
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
      observeHls(hls, trace);
      /* 分片吞吐上报（2.0.5 卡顿自愈）：只报整片（跳过分片 part 与 init 段），
         耗时取 stats.loading 的起止差（含首字节等待），码率取该片所属 level */
      hls.on(Hls.Events.FRAG_LOADED, (_e, data) => {
        const cb = fragStatsCbRef.current;
        if (!cb || data.part || typeof data.frag.sn !== "number") return;
        const st = data.frag.stats;
        const loadMs = st.loading.end > 0 && st.loading.end >= st.loading.start ? st.loading.end - st.loading.start : 0;
        if (loadMs <= 0 || st.loaded <= 0) return;
        cb({ bytes: st.loaded, loadMs, fragDuration: data.frag.duration || 0, bitrate: hls.levels[data.frag.level]?.bitrate ?? 0 });
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (activity.isActive()) hls.startLoad(resume?.time ?? -1);
        if (autoPlay && !resume) activity.play("manifest_autoplay", true);
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => { recoverCountRef.current = 0; });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) {
          if (
            data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR ||
            data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR
          ) {
            try { hls.startLoad(video.currentTime || -1); } catch { /* ignore */ }
          }
          return;
        }
        if (!activity.isActive()) return;
        const retry = () => {
          recoverCountRef.current += 1;
          const delay = 250 * recoverCountRef.current;
          if (recoverTimerRef.current) window.clearTimeout(recoverTimerRef.current);
          recoverTimerRef.current = window.setTimeout(() => {
            try {
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad(video.currentTime || -1);
              else hls.recoverMediaError();
            } catch { /* ignore */ }
          }, delay);
        };
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recoverCountRef.current < 4) { retry(); return; }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoverCountRef.current < 4) { retry(); return; }
        onError?.(`${data.type}/${data.details}`);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else { hls.destroy(); hlsRef.current = null; }
      });
    } else {
      video.src = url;
      if (autoPlay && !resume) activity.play("native_autoplay", true);
    }

    return () => {
      video.removeEventListener("resize", onVideoResize);
      if (recoverTimerRef.current) { window.clearTimeout(recoverTimerRef.current); recoverTimerRef.current = null; }
      trace("source.cleanup");
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, proxyRecovery.revision]);

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
      onPlay={() => { if (activity.isActive()) onPlaying?.(); }}
      onPause={() => onPause?.()}
      onWaiting={() => onWaiting?.()}
      onPlaying={(e) => {
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
        onFallbackChange={setSvgFallback}
        onTrace={trace}
      />
    </div>
  );
});

export default VideoSurface;
