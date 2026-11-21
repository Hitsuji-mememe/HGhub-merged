import { Button, Input } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Hls from "hls.js";
import { fmtTime, platform } from "../../shared/api/api";
import { connectNativeMedia, playbackSource } from "./mediaTransport";
import { AppendStallWatchdog } from "./appendStallWatchdog";
import { mediaErrorMessage } from "./mediaErrors";
import { mediaHost, mediaResource } from "../../shared/diagnostics/playbackDiagnostics";
import { useProxyPlaybackRecovery } from "./useProxyPlaybackRecovery";
import { usePlaybackKernel } from "./usePlaybackKernel";
import { noteHoldHlsAttach } from "../feed/holdJank";
import { createHlsRecovery, type HlsRecovery } from "./hlsRecovery";
import { useSeekInput } from "./useSeekInput";
import { useInlinePlayerFullscreen } from "./useInlinePlayerFullscreen";
import "../../styles/post-player.css";
import { ICompress, IExpand, IPauseF, IPlayF, IVol, IVolMute } from "../../shared/ui/icons";
import { useStore } from "../../shared/model/store";
import { effectiveSrMode, SuperResSvgDefs, getSvgFilterUrl, srVideoFilterMode } from "./SuperResCanvas";
import SrCanvas from "./SrCanvas";
import { createHlsPlayerConfig, currentLineSeedBps, lockHighestStartLevel } from "./hlsConfig";

type Props = {
  src: string;              // 原始 m3u8 地址
  /* 流形态（Muse 2026-11-21 fix3310）：适配器 resolve 的
   * streams[].kind——"file"（MP4 直链）经 playbackSource 包 /seg
   * 走 native；缺省与 "hls" 同口径包 /hls。Feed/api.play 不传。 */
  streamKind?: "hls" | "file";
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
  src, streamKind, poster, autoPlay, active = true, muted = false, loop = false, onEnded, onPlaying,
  onTogglePlay, onToggleMute, controls = true, className = "", diagnosticContext = {}, scopeKey, volume = 1,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const latestSource = useRef(src); latestSource.current = src;
  const hlsRef = useRef<Hls | null>(null);
  const recoveryRef = useRef<HlsRecovery | null>(null);
  /* 播放内核收敛（最终版 A 线）：诊断登记/活动层/密度采样/facts
   * 发布/吞吐回写/看门狗/呈现档计数与 VideoSurface 共用
   * usePlaybackKernel 一份，本组件只留渲染与控件差异。本组件由此
   * 获得 facts 发布与真实吞吐回写（GPT 复审 P2-09 关闭）。store
   * 声明前移仅为给内核传 lineEpoch，消费点不变。 */
  const store = useStore();
  const kernel = usePlaybackKernel({ videoRef, hlsRef, src, active, autoPlay: !!autoPlay, lineEpoch: store?.lineEpoch ?? 0, diagnosticContext: { view: "post_detail", ...diagnosticContext } });
  const { trace, requestSeek, activity } = kernel;
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
  /* 倍速全局记忆（蓝图 P4）：与 Feed 同源（store.rate），本地状态已回退 */
  const rate = store.rate;
  const setRate = store.setRate;
  /* 超分全自动（2026-11-18）：档位由 srPref + 本源分辨率推导，入口已撤 */
  const [srSize, setSrSize] = useState({ w: 0, h: 0 });
  /* 密度采样经内核（与 VideoSurface 同一份采样器，audit6 P0-A
   * 第 2 层；判档采样身份＝正在播放的 level，整改 B4）。 */
  const srDensity = kernel.density;
  /* 判档尺寸以 playing rendition 宽高为准（整改 B4），无密度时回落显示帧尺寸。 */
  const srMode = effectiveSrMode(store?.srPref ?? "auto", srDensity?.width || srSize.w, srDensity?.height || srSize.h, srDensity ?? undefined);
  /* U1 保底回报（fix2 B3 补接，保留）：SrCanvas 的实际呈现档位经
   * 内核 canvasSrMode 回报，据 srVideoFilterMode 在 WebGL 降到 off
   * 时挂 SVG natural 保底，选档纯函数与 VideoSurface 共用一份。 */
  const canvasSrMode = kernel.canvasSrMode;
  const setCanvasSrMode = kernel.setCanvasSrMode;
  const filterMode = srVideoFilterMode({ srPref: store?.srPref ?? "auto", srMode, canvasMode: canvasSrMode, svgFallback, canvasOffReason: svgFallback ? "unavailable" : srMode === "off" ? "judged" : "demoted" });
  /* facts 发布（最终版 A 线补齐，P2-09）：尺寸/密度/档位变化时经
   * 内核发布快照，与 VideoSurface 同组装口径；此前 Player 从不
   * 发布，诊断报告在帖子播放面永远读到 Feed 的旧快照或为空。 */
  useEffect(() => {
    kernel.publishFacts({ w: srSize.w, h: srSize.h, srMode, srPref: store?.srPref ?? "auto", canvasMode: canvasSrMode, svgFallback });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srSize, srDensity, srMode, kernel.firstRendition, kernel.webgpuEngaged, canvasSrMode, svgFallback, kernel.srDemoteCount, store?.srPref]);
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
    /* 密度重置只认 hook 自身的 [srcKey, lineEpoch] 面（整改 B12）：
     * 本 effect 还由 autoPlay/proxyRecovery.revision 触发，同源同线
     * 重建时样本仍有效，此前在此额外 reset 属误清（重建后头几片退回
     * 无密度判档），与 VideoSurface 不对齐，已删。 */
    const resume = proxyRecovery.resume();
    const source = playbackSource(src, Hls.isSupported(), streamKind);
    /* 内核源起点：记引擎、清 playing level、吞吐账本按当前线路记账。 */
    kernel.beginSource(source.engine);
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
      /* HLS 观察接线经内核一份：observeHls（代次捕获 trace，P2-08）
       * ＋playing level 维护＋首分片 rendition 采集。 */
      kernel.attachHls(hls);
      /* append 卡死看门狗（F 项）：构造/意愿门控/信号接线在内核一份
       * （内部即 stallWatchdogWiring，与 VideoSurface 共用）。这里
       * 只注入差异——trace 只记 attempt、proxyRecovery 重建通道、
       * errMsg 报错通道（与本组件 onFatal/原生 onError 同款三件套）。
       * 分片到达的密度采样与吞吐回写在内核 ingest 内完成（本组件
       * 由此获得真实吞吐回写，P2-09）。 */
      stallWatchdog = kernel.watchdogFor({
        video,
        isCurrent: () => hlsRef.current === hls,
        traceStall: (_state, attempt) => trace("hls.append_stall", { attempt }),
        traceGated: ({ gate, state }) => trace("hls.append_stall_gated", { gate, state }),
        retry: (reason) => proxyRecovery.retry(reason, true),
        onExhausted: (message) => { setErrMsg(message); setWaiting(false); setPlaying(false); },
      });
      hls.loadSource(source.url);
      hls.attachMedia(video);
      /* HLS 实例登记（最终版 B3 线任务 2，纯诊断）：与 VideoSurface 同口径 */
      noteHoldHlsAttach();
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        lockHighestStartLevel(hls);
        if (activity.isActive()) hls.startLoad(resume?.time ?? -1);
        if (activity.isPlayWanted() && !resume) activity.play("manifest_autoplay", true);
      });
      detachWatchdog = kernel.wireSignals({
        hls, video, watchdog: stallWatchdog,
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
      /* 内核源收尾（整改 B18 口径不变）：吞吐兜底 flush＋全局
       * playing 清零——源卸载即视为不在播，autoLine 的 main-return
       * 护栏据此判读。 */
      kernel.endSource();
      disconnectNative?.();
      stallWatchdog?.dispose();
      detachWatchdog?.();
      recoveryRef.current?.dispose(); recoveryRef.current = null;
      trace("source.cleanup");
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    };
  }, [src, streamKind, autoPlay, proxyRecovery.revision]);

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
        onPlay={() => { if (activity.isActive()) { kernel.notePlaying(true); setPlaying(true); onTogglePlay?.(true); } }}
        onPause={() => { if (activity.isActive()) kernel.notePlaying(false); setPlaying(false); onTogglePlay?.(false); }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => { if (activity.isActive()) { kernel.notePlaying(true); setWaiting(false); setErrMsg(""); onPlaying?.(); } }}
        onSeeked={() => setWaiting(false)}
        onTimeUpdate={(e) => setTime((e.target as HTMLVideoElement).currentTime)}
        onLoadedMetadata={(e) => { const v = e.target as HTMLVideoElement; setDuration(v.duration || 0); setSrSize({ w: v.videoWidth || 0, h: v.videoHeight || 0 }); kernel.noteNativeRendition(v.videoWidth, v.videoHeight); }}
        onEnded={() => { kernel.notePlaying(false, true); if (activity.isActive()) onEnded?.(); }}
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
        /* 帧预算通道只传声明 fps（density.fps），与 VideoSurface 同
         * 口径：实测回填值不许走此通道（回填线护栏 1）。 */
        fps={srDensity?.fps}
        onFallbackChange={setSvgFallback}
        onActiveModeChange={setCanvasSrMode}
        onPipelineChange={kernel.setWebgpuEngaged}
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
