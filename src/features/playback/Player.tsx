import { Button, Input } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Hls from "hls.js";
import { fmtTime, platform } from "../../shared/api/api";
import { connectNativeMedia, playbackSource } from "./mediaTransport";
import { AppendStallWatchdog } from "./appendStallWatchdog";
import { createStallWatchdog, wireStallWatchdogSignals } from "./stallWatchdogWiring";
import { mediaErrorMessage } from "./mediaErrors";
import { mediaHost, mediaResource, observeHls, usePlayerDiagnostics } from "../../shared/diagnostics/playbackDiagnostics";
import { notePlaybackPlaying } from "../../shared/diagnostics/playbackFacts";
import { usePlaybackActivity } from "./usePlaybackActivity";
import { useProxyPlaybackRecovery } from "./useProxyPlaybackRecovery";
import { createHlsRecovery, type HlsRecovery } from "./hlsRecovery";
import { useSeekInput } from "./useSeekInput";
import { useInlinePlayerFullscreen } from "./useInlinePlayerFullscreen";
import "../../styles/post-player.css";
import { ICompress, IExpand, IPauseF, IPlayF, IVol, IVolMute } from "../../shared/ui/icons";
import { useStore, type SuperResMode } from "../../shared/model/store";
import { effectiveSrMode, SuperResSvgDefs, getSvgFilterUrl, srVideoFilterMode } from "./SuperResCanvas";
import SrCanvas from "./SrCanvas";
import { createHlsPlayerConfig, currentLineSeedBps, lockHighestStartLevel } from "./hlsConfig";
import { useSrDensity } from "./useSrDensity";

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
  /* 跟版合并（Muse 2026-11-18）：上游 Posts 已在传 scopeKey（帖子 id），
   * 补进契约并透传全屏 hook 的作用域键（不变量 2：作用域进 key），
   * 缺省时 hook 自行回退 src。 */
  scopeKey?: string | number;
  /* 跟版合并（同上）：上游 Posts 同时在传 volume（store 全局音量）；
   * 我方帖子播放器此前无音量契约，补齐并落到 video 元素（iOS 上为 no-op）。 */
  volume?: number;
};

export default function Player({
  src, poster, autoPlay, active = true, muted = false, loop = false, onEnded, onPlaying,
  onTogglePlay, onToggleMute, controls = true, className = "", diagnosticContext = {}, scopeKey, volume = 1,
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
  const { slotRef, wrapRef, host, full, fallback, toggleFull } = useInlinePlayerFullscreen({ active, src, scopeKey, videoRef, activity });
  const proxyRecovery = useProxyPlaybackRecovery(videoRef, src, activity, trace);
  /* 音量契约落地（跟版合并，Muse 2026-11-18）：换源与音量变化时同步到
   * video 元素；与静音相互独立（muted 走元素属性，volume 走增益）。 */
  useEffect(() => {
    const v = videoRef.current;
    if (v) { try { v.volume = Math.min(1, Math.max(0, volume)); } catch { /* iOS 忽略 */ } }
  }, [volume, src]);
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
  /* 密度采样与 VideoSurface 共用一份（audit6 P0-A 第 2 层）：旧实现用
   * 首样本锁定、无 codec，判档口径与 Feed 不可比，现删除改走共享 hook。 */
  const { density: srDensity, ingest: ingestSrFrag } = useSrDensity(src, store?.lineEpoch ?? 0);
  /* 正在播放的 level（整改 B4，与 VideoSurface 同口径）：判档采样只认这一档。 */
  const playingLevelRef = useRef(-1);
  /* 判档尺寸以 playing rendition 宽高为准（整改 B4），无密度时回落显示帧尺寸。 */
  const srMode = effectiveSrMode(store?.srPref ?? "auto", srDensity?.width || srSize.w, srDensity?.height || srSize.h, srDensity ?? undefined);
  /* U1 保底回报补接（Muse 2026-11-19 fix2 B3 不对称答复：漏接）：
   * VideoSurface 早已接 onActiveModeChange 并据 srVideoFilterMode 在
   * WebGL 降到 off 时挂 SVG natural 保底，Player 此前未接——同一
   * 「默认增强档不缺席」承诺在帖子播放器里缺席（判档 off/性能降 off
   * 时直接裸播无保底）。无任何设计理由区别对待，属漏接，现补齐，
   * 选档纯函数与 VideoSurface 共用一份。 */
  const [canvasSrMode, setCanvasSrMode] = useState<SuperResMode>(srMode);
  const filterMode = srVideoFilterMode({ srPref: store?.srPref ?? "auto", srMode, canvasMode: canvasSrMode, svgFallback, canvasOffReason: svgFallback ? "unavailable" : srMode === "off" ? "judged" : "demoted" });
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
    playingLevelRef.current = -1;
    /* 密度重置只认 hook 自身的 [srcKey, lineEpoch] 面（整改 B12）：
     * 本 effect 还由 autoPlay/proxyRecovery.revision 触发，同源同线
     * 重建时样本仍有效，此前在此额外 reset 属误清（重建后头几片退回
     * 无密度判档），与 VideoSurface 不对齐，已删。 */
    const resume = proxyRecovery.resume();
    const source = playbackSource(src, Hls.isSupported());
    let disconnectNative: (() => void) | undefined;
    let stallWatchdog: AppendStallWatchdog | undefined;
    let detachWatchdog: (() => void) | undefined;
    trace("source.load", { engine: source.engine, auto_play: activity.isPlayWanted(), resource: mediaResource(src), host: mediaHost(src) });

    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    if (source.engine === "hls.js") {
      const hls = new Hls(createHlsPlayerConfig({
        ios: platform === "ios",
        startPosition: resume?.time ?? -1,
        seedBps: currentLineSeedBps(),
        lowLatencyMode: false,
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
          setErrMsg(detail); setWaiting(false); setPlaying(false);
          if (data.type !== Hls.ErrorTypes.NETWORK_ERROR && data.type !== Hls.ErrorTypes.MEDIA_ERROR) {
            hls.destroy(); hlsRef.current = null;
          }
        },
      });
      recoveryRef.current = recovery;
      observeHls(hls, trace, Hls.Events);
      /* append 卡死看门狗（F 项）：构造、意愿门控、判死/重建/降级/用尽
       * 报错与全部信号接线已收敛到 stallWatchdogWiring 一份（与
       * VideoSurface 共用）；本组件此前漏传 shouldEscalate、onStall 不查
       * 意愿、没接 BUFFER_APPENDING/APPENDED，现经共享实现一并补齐。
       * 这里只注入差异——trace 只记 attempt、proxyRecovery 重建通道、
       * errMsg 报错通道（与本组件 onFatal/原生 onError 同款三件套）。 */
      stallWatchdog = createStallWatchdog({
        video,
        isCurrent: () => hlsRef.current === hls,
        isPlayWanted: () => activity.isPlayWanted(),
        pauseState: () => activity.pauseState(),
        attemptRef: stallAttemptRef,
        traceStall: (_state, attempt) => trace("hls.append_stall", { attempt }),
        retry: (reason) => proxyRecovery.retry(reason, true),
        onExhausted: (message) => { setErrMsg(message); setWaiting(false); setPlaying(false); },
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => { playingLevelRef.current = data.level; });
      hls.loadSource(source.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        lockHighestStartLevel(hls);
        if (activity.isActive()) hls.startLoad(resume?.time ?? -1);
        if (activity.isPlayWanted() && !resume) activity.play("manifest_autoplay", true);
      });
      detachWatchdog = wireStallWatchdogSignals({
        hls, video, watchdog: stallWatchdog,
        /* 超分密度：共享采样器（与 VideoSurface 同口径，audit6 P0-A 第 2 层；
         * 整改 B4：采样身份与 rendition 全部取正在播放的 level） */
        onFragLoaded: (data) => {
          const pl = playingLevelRef.current >= 0 ? playingLevelRef.current : hls.currentLevel;
          const pLevel = pl >= 0 ? hls.levels[pl] : undefined;
          ingestSrFrag(
            { loaded: data.frag.stats.loaded, duration: data.frag.duration, level: pl >= 0 ? pl : data.frag.level },
            pLevel ? { frameRate: pLevel.frameRate, videoCodec: pLevel.videoCodec, width: pLevel.width, height: pLevel.height, bitrate: pLevel.bitrate } : undefined,
          );
        },
        onFragBuffered: () => { recovery.buffered(); setErrMsg(""); },
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
      /* 全局播放事实源（整改 B18）：与 VideoSurface 同一置位口径——
       * 源卸载即视为不在播，autoLine 的 main-return 护栏据此判读。 */
      notePlaybackPlaying(false);
      disconnectNative?.();
      stallWatchdog?.dispose();
      detachWatchdog?.();
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
        style={filterMode ? { filter: getSvgFilterUrl(filterMode) } : undefined}
        onClick={toggle}
        onLoadedData={() => setVideoReady(true)}
        onCanPlay={() => setVideoReady(true)}
        onPlay={() => { if (activity.isActive()) { notePlaybackPlaying(true); setPlaying(true); onTogglePlay?.(true); } }}
        onPause={() => { if (activity.isActive()) notePlaybackPlaying(false); setPlaying(false); onTogglePlay?.(false); }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => { if (activity.isActive()) { notePlaybackPlaying(true); setWaiting(false); setErrMsg(""); onPlaying?.(); } }}
        onSeeked={() => setWaiting(false)}
        onTimeUpdate={(e) => setTime((e.target as HTMLVideoElement).currentTime)}
        onLoadedMetadata={(e) => { const v = e.target as HTMLVideoElement; setDuration(v.duration || 0); setSrSize({ w: v.videoWidth || 0, h: v.videoHeight || 0 }); }}
        onEnded={() => { notePlaybackPlaying(false); if (activity.isActive()) onEnded?.(); }}
        onError={() => {
          if (hlsRef.current) return;
          setWaiting(false);
          setPlaying(false);
          setErrMsg(mediaErrorMessage(videoRef.current?.error ?? null));
        }}
      />
      <SrCanvas
        videoRef={videoRef}
        mode={srMode}
        active={active}
        ready={videoReady || playing || time > 0}
        fit="contain"
        srcKey={src}
        fps={srDensity?.fps}
        onFallbackChange={setSvgFallback}
        onActiveModeChange={setCanvasSrMode}
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
