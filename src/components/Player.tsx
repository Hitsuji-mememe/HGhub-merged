import { Button, Input } from "./ios/controls";
import { Loader } from "./ios/effects";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import Hls from "hls.js";
import { fmtTime, platform, playlist } from "../api";
import { mediaErrorMessage } from "../mediaErrors";
import { mediaHost, mediaResource, observeHls, usePlayerDiagnostics } from "../playbackDiagnostics";
import { usePlaybackActivity } from "../usePlaybackActivity";
import { useProxyPlaybackRecovery } from "../useProxyPlaybackRecovery";
import { useSeekInput } from "../useSeekInput";
import { useStore } from "../store";
import SuperResCanvas, {
  SR_PRESET_MAP,
  SR_SHORT_LABEL,
  SuperResMenu,
  SuperResSvgDefs,
  getSvgFilterUrl,
} from "./SuperResCanvas";
import { useInlinePlayerFullscreen } from "../useInlinePlayerFullscreen";
import "../styles/post-player.css";
import { ICompress, IExpand, IPauseF, IPlayF, ISparkF, IVol, IVolMute } from "../icons";

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
  const hlsRef = useRef<Hls | null>(null);
  const recoverCountRef = useRef(0);
  const { trace, requestSeek } = usePlayerDiagnostics(videoRef, hlsRef, { view: "post_detail", ...diagnosticContext, active, resource: mediaResource(src) });
  const activity = usePlaybackActivity(videoRef, hlsRef, { active, autoPlay: !!autoPlay, src, trace });
  const { slotRef, wrapRef, host, full, fallback, toggleFull } = useInlinePlayerFullscreen({ active, src, videoRef, activity });
  const proxyRecovery = useProxyPlaybackRecovery(videoRef, src, activity, trace);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [errMsg, setErrMsg] = useState<string>("");
  const [videoReady, setVideoReady] = useState(false);
  /* Muse 2026-11-15 (2.1.2): 全屏方向跟着源走（用户最终定版，与 Feed 一致）——横屏源全屏即横屏、
     竖屏源即竖屏；判定只认 video 元素真实宽高（loadedmetadata 回报），全屏期间判定翻转由下方
     effect 复判重发原生请求；回退全屏且窗口仍竖屏、源为横屏时 CSS 旋转兜底。退出全屏发竖屏请求撤销
     （2.1.1 退出时从不复位方向是个缺口）。旋转钮与 rotateOverride 状态机已整套删除。 */
  const [vsize, setVsize] = useState({ w: 0, h: 0 });
  const [vpLandscape, setVpLandscape] = useState(() => typeof window !== "undefined" && window.innerWidth > window.innerHeight);
  useEffect(() => {
    const onViewport = () => setVpLandscape(window.innerWidth > window.innerHeight);
    window.addEventListener("resize", onViewport);
    window.addEventListener("orientationchange", onViewport);
    return () => { window.removeEventListener("resize", onViewport); window.removeEventListener("orientationchange", onViewport); };
  }, []);
  const landscapeVideo = vsize.w > 0 && vsize.h > 0 && vsize.w > vsize.h;
  const playerRotated = full && fallback && !vpLandscape && landscapeVideo;
  const wasFullRef = useRef(false);
  useEffect(() => {
    if (full) {
      wasFullRef.current = true;
      try { void invoke("set_orientation", { landscape: landscapeVideo }); } catch { /* ignore */ }
    } else if (wasFullRef.current) {
      wasFullRef.current = false;
      try { void invoke("set_orientation", { landscape: false }); } catch { /* ignore */ }
    }
  }, [full, landscapeVideo]);

  const [svgFallback, setSvgFallback] = useState(false);
  const [srOpen, setSrOpen] = useState(false);
  const srSlotRef = useRef<HTMLDivElement>(null);
  const store = useStore();
  const srMode = store?.srMode ?? "off";

  useEffect(() => {
    if (!srOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!srSlotRef.current?.contains(e.target as Node)) setSrOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [srOpen]);

  useEffect(() => {
    if (!active) setSrOpen(false);
  }, [active]);
  const seek = useSeekInput({ time, duration, enabled: active, resetKey: src,
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
    setVideoReady(false);
    setWaiting(false);
    recoverCountRef.current = 0;
    const resume = proxyRecovery.resume();
    const url = playlist(src);
    trace("source.load", { engine: Hls.isSupported() ? "hls.js" : "native", auto_play: autoPlay, resource: mediaResource(src), host: mediaHost(src) });

    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    if (Hls.isSupported()) {
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
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (activity.isActive()) hls.startLoad(resume?.time ?? -1);
        if (autoPlay && !resume) activity.play("manifest_autoplay", true);
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        recoverCountRef.current = 0;
        setErrMsg("");
        setVideoReady(true);
      });
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
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recoverCountRef.current < 4) {
          recoverCountRef.current += 1;
          try { hls.startLoad(video.currentTime || -1); } catch { /* ignore */ }
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoverCountRef.current < 4) {
          recoverCountRef.current += 1;
          try { hls.recoverMediaError(); video.play().catch(() => {}); } catch { /* ignore */ }
          return;
        }
        const detail = `${data.type}/${data.details}/${data.response?.code ?? ""}/${String(data.reason ?? "").slice(0, 80)}`;
        (window as unknown as { __hlsErr?: string }).__hlsErr = detail;
        setErrMsg(detail);
        if (!activity.isActive()) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else { hls.destroy(); hlsRef.current = null; }
      });
    } else {
      // Safari / 部分 WebView 原生支持 HLS
      video.src = url;
      if (autoPlay && !resume) activity.play("native_autoplay", true);
    }

    return () => {
      trace("source.cleanup");
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    };
  }, [src, autoPlay, proxyRecovery.revision]);

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

  /* Muse 2026-11-15 (2.1.1 操作定版): 画面点击延时判定——单击等 240ms 无第二击才切播放，
     双击在第二击立即切播放且只切一次（旧实现单击即切、双击连切两次等于没切）。 */
  const surfaceClickTimer = useRef<number | null>(null);
  const onSurfaceClick = () => {
    if (surfaceClickTimer.current) {
      window.clearTimeout(surfaceClickTimer.current);
      surfaceClickTimer.current = null;
      toggle();
      return;
    }
    surfaceClickTimer.current = window.setTimeout(() => {
      surfaceClickTimer.current = null;
      toggle();
    }, 240) as unknown as number;
  };

  const cycleRate = () => {
    const video = videoRef.current;
    if (!video) return;
    const next = rate === 1 ? 1.25 : rate === 1.25 ? 1.5 : rate === 1.5 ? 2 : 1;
    video.playbackRate = next;
    setRate(next);
  };

  const pct = duration > 0 ? (seek.time / duration) * 100 : 0;
  const videoFilter = svgFallback ? getSvgFilterUrl(srMode) : undefined;

  return (
    <div ref={slotRef} className={`post-player-slot ${className}`}>
    {createPortal(<div ref={wrapRef} className={`post-player relative bg-black overflow-hidden ${playerRotated ? "fs-landscape" : ""}`}
      data-playing={playing} data-fullscreen={full} data-fullscreen-fallback={fallback}>
      <SuperResSvgDefs />
      <div className="absolute inset-0">
      <video
        ref={videoRef}
        poster={poster}
        playsInline
        preload="auto"
        muted={muted}
        loop={loop}
        className="w-full h-full object-contain bg-black"
        style={videoFilter ? { filter: videoFilter } : undefined}
        onClick={onSurfaceClick}
        onLoadedData={() => setVideoReady(true)}
        onCanPlay={() => setVideoReady(true)}
        onPlay={() => { setVideoReady(true); if (activity.isActive()) { setPlaying(true); onTogglePlay?.(true); } }}
        onPause={() => { setPlaying(false); onTogglePlay?.(false); }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => { setVideoReady(true); if (activity.isActive()) { setWaiting(false); setErrMsg(""); onPlaying?.(); } }}
        onSeeked={() => setWaiting(false)}
        onTimeUpdate={(e) => setTime((e.target as HTMLVideoElement).currentTime)}
        onLoadedMetadata={(e) => { const v = e.target as HTMLVideoElement; setDuration(v.duration || 0); setVsize({ w: v.videoWidth || 0, h: v.videoHeight || 0 }); }}
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
        <div className="absolute left-2 top-2 z-30 max-w-[80%] rounded bg-black/70 px-2 py-1 text-[12px] leading-tight text-red-300 break-all">
          {errMsg}
        </div>
      )}

      {waiting && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Loader className="w-9 h-9 spinner" />
        </div>
      )}

      {!playing && !waiting && (
        <Button onClick={onSurfaceClick} aria-label="播放"
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
            {/* Muse 2026-11-15 (2.1.2): 此处原有第二份「当前/总时长」文本与进度行那份完全重复，已删，只留进度行一处 */}
            <div className="flex-1" />
            <div ref={srSlotRef} className="relative">
              <Button
                onClick={() => setSrOpen((v) => !v)}
                aria-label={`超分模式：${SR_SHORT_LABEL[srMode]}`}
                aria-expanded={srOpen}
                title="选择 GPU 画质超分档位"
                aria-pressed={srMode !== "off"}
                className={`px-2 py-0.5 rounded-full text-[12px] font-bold flex items-center gap-1 pressable ${
                  srMode !== "off" ? "bg-primary text-on-primary" : "text-white/85 bg-white/15"
                }`}>
                <ISparkF size={12} />
                <span>{SR_SHORT_LABEL[srMode]}</span>
              </Button>
              {srOpen && (
                <SuperResMenu
                  current={srMode}
                  placement="up"
                  align="right"
                  onSelect={(m) => {
                    store?.setSrMode?.(m);
                    store?.toast?.(`画质增强：${SR_PRESET_MAP[m].hudText}`, m === "off" ? "info" : "ok");
                    setSrOpen(false);
                  }}
                />
              )}
            </div>
            <Button onClick={cycleRate} aria-label={`播放速度 ${rate} 倍`} className="text-[12px] font-bold text-white/85 pressable tabular-nums">{rate}x</Button>
            {/* Muse 2026-11-15 (2.1.2): 旋转钮已删——全屏恒横屏，退出回竖屏，无第二个方向入口 */}
            <Button onClick={toggleFull} aria-label={full ? "退出全屏" : "全屏"} aria-pressed={full} className="pressable">
              {full ? <ICompress size={16} /> : <IExpand size={16} />}
            </Button>
          </div>
        </div>
      )}
      </div>
      {/* Muse 2026-11-15 (2.1.1 简化版): PlaybackLock 锁定浮层已移除 */}
    </div>, host)}
    </div>
  );
}
