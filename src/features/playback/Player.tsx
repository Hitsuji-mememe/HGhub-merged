import { Button, Input } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Hls from "hls.js";
import { fmtTime, platform } from "../../shared/api/api";
import { connectNativeMedia, noteNativeFallback, playbackSource } from "./mediaTransport";
import { AppendStallWatchdog } from "./appendStallWatchdog";
import { mediaErrorMessage } from "./mediaErrors";
import { mediaHost, mediaResource, observeHls, usePlayerDiagnostics } from "../../shared/diagnostics/playbackDiagnostics";
import { usePlaybackActivity } from "./usePlaybackActivity";
import { useProxyPlaybackRecovery } from "./useProxyPlaybackRecovery";
import { createHlsRecovery, type HlsRecovery } from "./hlsRecovery";
import { useSeekInput } from "./useSeekInput";
import { useInlinePlayerFullscreen } from "./useInlinePlayerFullscreen";
import "../../styles/post-player.css";
import { ICompress, IExpand, IPauseF, IPlayF, IVol, IVolMute } from "../../shared/ui/icons";
import { useStore } from "../../shared/model/store";
import SuperResCanvas, { effectiveSrMode, SuperResSvgDefs, getSvgFilterUrl } from "./SuperResCanvas";

type Props = {
  src: string;              // 原始 m3u8 地址
  poster?: string;          // 已处理好的封面地址（本地协议）
  autoPlay?: boolean;
  active?: boolean;
  muted?: boolean;
  loop?: boolean;
  onEnded?: () => void;
  onPlaying?: () => void;
  onTogglePlay?: (playing: boolean) => void;
  onToggleMute?: () => void;
  controls?: boolean;
  className?: string;
  diagnosticContext?: Record<string, unknown>;
};

export default function Player({
  src, poster, autoPlay, active = true, muted = false, loop = false, onEnded, onPlaying,
  onTogglePlay, onToggleMute, controls = true, className = "", diagnosticContext = {},
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const latestSource = useRef(src); latestSource.current = src;
  const hlsRef = useRef<Hls | null>(null);
  const recoveryRef = useRef<HlsRecovery | null>(null);
  /* append 卡死自愈计数（F 项，与 VideoSurface 同规则：判死一次重建、
   * 再判死置会话级原生降级；换源清零） */
  const stallAttemptRef = useRef(0);
  const stallSrcRef = useRef(src);
  if (stallSrcRef.current !== src) { stallSrcRef.current = src; stallAttemptRef.current = 0; }
  const { trace, requestSeek } = usePlayerDiagnostics(videoRef, hlsRef, { view: "post_detail", ...diagnosticContext, active, resource: mediaResource(src) });
  const activity = usePlaybackActivity(videoRef, hlsRef, { active, autoPlay: !!autoPlay, src, trace });
  const { slotRef, wrapRef, host, full, fallback, toggleFull } = useInlinePlayerFullscreen({ active, src, videoRef, activity });
  const proxyRecovery = useProxyPlaybackRecovery(videoRef, src, activity, trace);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [errMsg, setErrMsg] = useState<string>("");
  const controlsLocked = false;
  const [videoReady, setVideoReady] = useState(false);
  const [svgFallback, setSvgFallback] = useState(false);
  const store = useStore();
  /* 倍速全局记忆（蓝图 P4）：与 Feed 同源（store.rate），本地状态已回退 */
  const rate = store.rate;
  const setRate = store.setRate;
  /* 超分全自动（2026-11-18）：档位由 srPref + 本源分辨率推导，入口已撤 */
  const [srSize, setSrSize] = useState({ w: 0, h: 0 });
  const [srDensity, setSrDensity] = useState<{ bitrateBps: number; fps?: number } | null>(null);
  const srMode = effectiveSrMode(store?.srPref ?? "auto", srSize.w, srSize.h, srDensity ?? undefined);
  const seek = useSeekInput({ time, duration, enabled: active && !controlsLocked, resetKey: src,
    onInteraction: (phase, input, target, pointerTarget) => trace(`seek.input.${phase}`, { input, target, pointer_target: pointerTarget }),
    onSeek: (target, input) => {
      const video = videoRef.current;
      if (!video || !activity.isActive()) return;
      requestSeek(target, `legacy_${input}`);
      setWaiting(true);
      if (hlsRef.current) {
        try { hlsRef.current.startLoad(target); } catch { /* ignore */ }
      }
      video.currentTime = target;
      trace("seek.assigned", { target });
      setTime(video.currentTime);
    },
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    setErrMsg("");
    setWaiting(false);
    setSrDensity(null);
    const resume = proxyRecovery.resume();
    const source = playbackSource(src, Hls.isSupported());
    let disconnectNative: (() => void) | undefined;
    let stallWatchdog: AppendStallWatchdog | undefined;
    let watchdogPlaying: (() => void) | undefined;
    trace("source.load", { engine: source.engine, auto_play: autoPlay, resource: mediaResource(src), host: mediaHost(src) });

    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    if (source.engine === "hls.js") {
      const hls = new Hls({
        // 禁用从插播/内容引导 JSON 派生直连 URL 的可选功能。
        interstitialsController: undefined,
        contentSteeringController: undefined,
        enableInterstitialPlayback: false,
        // WKWebView 里 hls.js 的 worker 不稳，iOS 关掉
        enableWorker: platform !== "ios",
        // Keep the same macOS seek workaround as the shared player.
        preferManagedMediaSource: false,
        autoStartLoad: false,
        startPosition: resume?.time ?? -1,
        lowLatencyMode: false,
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
          const detail = `${data.type}/${data.details}/${data.response?.code ?? ""}/${String(data.reason ?? "").slice(0, 80)}`;
          (window as unknown as { __hlsErr?: string }).__hlsErr = detail;
          setErrMsg(detail); setWaiting(false); setPlaying(false);
          if (data.type !== Hls.ErrorTypes.NETWORK_ERROR && data.type !== Hls.ErrorTypes.MEDIA_ERROR) {
            hls.destroy(); hlsRef.current = null;
          }
        },
      });
      recoveryRef.current = recovery;
      observeHls(hls, trace, Hls.Events);
      /* append 卡死看门狗（F 项，与 VideoSurface 同签名同处置） */
      stallWatchdog = new AppendStallWatchdog({
        hasBuffered: () => { try { return video.buffered.length > 0 && video.buffered.end(video.buffered.length - 1) > 0; } catch { return false; } },
        isPlaying: () => !video.paused && video.readyState >= 2,
        onStall: () => {
          if (hlsRef.current !== hls) return;
          trace("hls.append_stall", { attempt: stallAttemptRef.current });
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
      hls.loadSource(source.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (activity.isActive()) hls.startLoad(resume?.time ?? -1);
        if (autoPlay && !resume) activity.play("manifest_autoplay", true);
      });
      /* 超分密度：首个完整分片实际码率（与 VideoSurface 同口径，收官批 C 项） */
      hls.on(Hls.Events.FRAG_LOADED, (_e, data) => {
        if (data.part || typeof data.frag.sn !== "number") return;
        stallWatchdog?.fragLoaded();
        const st = data.frag.stats;
        if (st.loaded <= 0 || !(data.frag.duration > 0)) return;
        const fps = hls.levels[data.frag.level]?.frameRate;
        setSrDensity(prev => prev ?? { bitrateBps: (st.loaded * 8) / data.frag.duration, fps: fps && fps > 0 ? fps : undefined });
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        recovery.buffered();
        stallWatchdog?.buffered();
        setErrMsg("");
      });
      hls.on(Hls.Events.ERROR, (_e, data) => recovery.error(data));
    } else {
      disconnectNative = connectNativeMedia(video, source, {
        isCurrent: () => latestSource.current === src && videoRef.current === video,
        onReady: () => { if (activity.isPlayWanted() && !resume) activity.play("native_autoplay", true); },
        onError: message => { trace("source.transport_error"); setWaiting(false); setPlaying(false); setErrMsg(message); },
      });
    }

    return () => {
      disconnectNative?.();
      stallWatchdog?.dispose();
      if (watchdogPlaying) video.removeEventListener("playing", watchdogPlaying);
      recoveryRef.current?.dispose(); recoveryRef.current = null;
      trace("source.cleanup");
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    };
  }, [src, autoPlay, proxyRecovery.revision]);

  useLayoutEffect(() => { recoveryRef.current?.activityChanged(); }, [active]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = muted;
  }, [muted]);

  // iOS 内联播放：部分 WKWebView 只认 HTML 属性，不认 React 的 playsInline
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.setAttribute("webkit-playsinline", "true");
  }, []);

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    trace("toggle.request");
    if (video.paused) activity.play("toggle");
    else activity.pause("toggle");
  };

  const retry = () => {
    if (!activity.isActive()) return;
    setErrMsg(""); setWaiting(true); setPlaying(false);
    proxyRecovery.retry("manual", true);
  };

  const cycleRate = () => {
    const video = videoRef.current;
    if (!video) return;
    const next = rate === 1 ? 1.25 : rate === 1.25 ? 1.5 : rate === 1.5 ? 2 : 1;
    video.playbackRate = next;
    setRate(next);
  };

  const pct = duration > 0 ? (seek.time / duration) * 100 : 0;

  return (
    <div ref={slotRef} className={`post-player-slot ${className}`}>
    {createPortal(<div ref={wrapRef} className="post-player relative bg-black overflow-hidden"
      data-playing={playing} data-fullscreen={full} data-fullscreen-fallback={fallback}>
      <SuperResSvgDefs />
      <div className="absolute inset-0" inert={controlsLocked}>
      <video
        ref={videoRef}
        poster={poster}
        playsInline
        preload="auto"
        muted={muted}
        loop={loop}
        className="w-full h-full object-contain bg-black"
        style={svgFallback ? { filter: getSvgFilterUrl(srMode) } : undefined}
        onClick={toggle}
        onLoadedData={() => setVideoReady(true)}
        onCanPlay={() => setVideoReady(true)}
        onPlay={() => { if (activity.isActive()) { setPlaying(true); onTogglePlay?.(true); } }}
        onPause={() => { setPlaying(false); onTogglePlay?.(false); }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => { if (activity.isActive()) { setWaiting(false); setErrMsg(""); onPlaying?.(); } }}
        onSeeked={() => setWaiting(false)}
        onTimeUpdate={(e) => setTime((e.target as HTMLVideoElement).currentTime)}
        onLoadedMetadata={(e) => { const v = e.target as HTMLVideoElement; setDuration(v.duration || 0); setSrSize({ w: v.videoWidth || 0, h: v.videoHeight || 0 }); }}
        onEnded={() => { if (activity.isActive()) onEnded?.(); }}
        onError={() => {
          if (hlsRef.current) return;
          setWaiting(false);
          setPlaying(false);
          setErrMsg(mediaErrorMessage(videoRef.current?.error ?? null));
        }}
      />
      <SuperResCanvas
        videoRef={videoRef}
        mode={srMode}
        active={active}
        ready={videoReady || playing || time > 0}
        fit="contain"
        srcKey={src}
        onFallbackChange={setSvgFallback}
        onTrace={trace}
      />

      {errMsg && (
        <div role="alert" className="absolute left-2 top-2 z-30 max-w-[80%] rounded bg-black/70 px-2 py-1 text-[12px] leading-tight text-red-300 break-all">
          <span>{errMsg}</span>
          <Button onClick={retry} disabled={!active} className="ml-2 px-2 py-1 text-white">重试</Button>
        </div>
      )}

      {waiting && !errMsg && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Loader className="w-9 h-9 spinner" />
        </div>
      )}

      {!playing && !waiting && !errMsg && (
        <Button onClick={toggle} aria-label="播放"
          className="absolute inset-0 flex items-center justify-center">
          <span className="w-16 h-16 rounded-full bg-black/45 backdrop-blur-sm flex items-center justify-center elev-2 pressable">
            <IPlayF size={26} className="text-white ml-0.5" />
          </span>
        </Button>
      )}

      {controls && (
        <div className="player-inline-controls" role="group" aria-label="播放控制">
          <div className="post-player-seek-row">
            <Input aria-label="播放进度" type="range" {...seek.inputProps}
              className="hg-range" style={{ ...seek.inputProps.style, "--fill": `${pct}%` } as React.CSSProperties} />
            <span className="post-player-time">{fmtTime(seek.time)} / {fmtTime(duration)}</span>
          </div>
          <div className="post-player-actions">
            <Button onClick={toggle} aria-label={playing ? "暂停" : "播放"} className="pressable">
              {playing ? <IPauseF size={16} /> : <IPlayF size={16} />}
            </Button>
            <Button onClick={() => onToggleMute?.()} aria-label={muted ? "取消静音" : "静音"} className="pressable">
              {muted ? <IVolMute size={16} /> : <IVol size={16} />}
            </Button>
            <Button onClick={cycleRate} aria-label={`播放速度 ${rate} 倍`} className="text-[12px] font-bold text-white/85 pressable tabular-nums">{rate}x</Button>
            <Button onClick={toggleFull} aria-label={full ? "退出全屏" : "全屏"} aria-pressed={full} className="pressable">
              {full ? <ICompress size={16} /> : <IExpand size={16} />}
            </Button>
          </div>
        </div>
      )}
      </div>
    </div>, host)}
    </div>
  );
}
