import { useEffect, useLayoutEffect, useImperativeHandle, useRef, forwardRef, useState, type MutableRefObject } from "react";
import Hls from "hls.js";
import { platform } from "../../shared/api/api";
import { connectNativeMedia, playbackSource } from "./mediaTransport";
import { AppendStallWatchdog } from "./appendStallWatchdog";
import { mediaErrorMessage } from "./mediaErrors";
import { mediaHost, mediaResource, registerHlsVersion } from "../../shared/diagnostics/playbackDiagnostics";
import { useProxyPlaybackRecovery } from "./useProxyPlaybackRecovery";
import { noteHoldHlsAttach } from "../feed/holdJank";
import { createHlsRecovery, type HlsRecovery } from "./hlsRecovery";
import { useStore } from "../../shared/model/store";
import { effectiveSrMode, getSvgFilterUrl, srVideoFilterMode, SuperResSvgDefs } from "./SuperResCanvas";
import SrCanvas from "./SrCanvas";
import { createHlsPlayerConfig, currentLineSeedBps, lockHighestStartLevel } from "./hlsConfig";
import { usePlaybackKernel } from "./usePlaybackKernel";

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
  /** 活动层三态暂停信号（整改 B2）：Feed 的 keepAlive 等意愿门控经此
   * 读取，不再用 Feed.paused 粗信号冒充用户暂停。 */
  pauseState: () => "playing" | "paused_by_user" | "paused_by_system";
};

type Props = {
  src: string;
  /* 流形态（Muse 2026-11-21 fix3310）：同 Player——"file" 经
   * playbackSource 包 /seg 走 native；缺省与 "hls" 同口径。 */
  streamKind?: "hls" | "file";
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
  { src, streamKind, poster, autoPlay = true, active = true, measurementKey = src, diagnosticContext = {}, muted = false, loop = false, fit = "contain", volume = 1, rate = 1,
    onTime, onDuration, onSize, onPlaying, onPause, onWaiting, onSeeked, onEnded, onError, onClearError, onFragStats, onClick, className = "" },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const latestSource = useRef(src); latestSource.current = src;
  const attachedSource = useRef<string | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const fragStatsCbRef = useRef(onFragStats);
  fragStatsCbRef.current = onFragStats;
  const recoveryRef = useRef<HlsRecovery | null>(null);
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
  /* 播放内核收敛（最终版 A 线）：诊断登记/活动层/密度采样/facts
   * 发布/吞吐回写/看门狗/呈现档计数的共用实现在 usePlaybackKernel
   * 一份（与 Player 同），本组件只留渲染与控件差异。判档尺寸以密度
   * 携带的 playing rendition 宽高为准（整改 B4），未取到密度时才
   * 回落显示帧尺寸。U1：合成层保底是否挂载按 SrCanvas 回报的实际
   * 呈现档位（kernel.canvasSrMode）判，不按判档 srMode 猜。 */
  const kernel = usePlaybackKernel({ videoRef, hlsRef, src, active, autoPlay, lineEpoch: store?.lineEpoch ?? 0, diagnosticContext });
  const { trace, requestSeek, activity } = kernel;
  const srDensity = kernel.density;
  const firstRendition = kernel.firstRendition;
  const webgpuEngaged = kernel.webgpuEngaged;
  const srDemoteCount = kernel.srDemoteCount;
  const canvasSrMode = kernel.canvasSrMode;
  const setCanvasSrMode = kernel.setCanvasSrMode;
  const srMode = effectiveSrMode(store?.srPref ?? "auto", srDensity?.width || srSize.w, srDensity?.height || srSize.h, srDensity ?? undefined);
  /* 诊断报告的源规格读取点（收官批 D）：尺寸/密度/档位变化时经内核
   * 发布快照（组装口径在内核一份，Player 同）。 */
  const canvasModeForFacts = canvasSrMode;
  useEffect(() => {
    kernel.publishFacts({ w: srSize.w, h: srSize.h, srMode, srPref: store?.srPref ?? "auto", canvasMode: canvasModeForFacts, svgFallback });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srSize, srDensity, srMode, firstRendition, webgpuEngaged, canvasModeForFacts, svgFallback, srDemoteCount, store?.srPref]);
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
    kernel.resetPresentation();
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
    pauseState: () => activity.pauseState(),
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

    const source = playbackSource(src, Hls.isSupported(), streamKind);
    /* 内核源起点：记引擎、清 playing level、吞吐回写按当前线路 base
     * 记账（整改 B3，不再用媒体地址 origin）。 */
    kernel.beginSource(source.engine);
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
      /* HLS 观察接线经内核一份：版本登记＋observeHls（代次捕获 trace，
       * P2-08）＋playing level 维护＋首分片 rendition 采集。 */
      kernel.attachHls(hls);
      /* append 卡死看门狗（F 项）：构造/意愿门控/信号接线在内核一份
       * （内部即 stallWatchdogWiring，与 Player 共用）；这里只注入本
       * 组件的差异——trace 取证字段（复审批 §C：判死时刻的
       * readyState 与缓冲末端）、proxyRecovery 重建通道、onError
       * 报错通道，以及分片到达后的自有逻辑（frag 统计回调；密度
       * 采样与吞吐入账已在内核 ingest 内完成，口径不变）。 */
      stallWatchdog = kernel.watchdogFor({
        video,
        isCurrent: () => hlsRef.current === hls,
        traceStall: (state, attempt) => {
          let bufEnd = -1;
          try { bufEnd = video.buffered.length > 0 ? Math.round(video.buffered.end(video.buffered.length - 1) * 10) / 10 : 0; } catch { /* 保持 -1 */ }
          trace("hls.append_stall", { attempt, state, rs: video.readyState, buf: bufEnd });
        },
        traceGated: ({ gate, state }) => {
          trace("hls.append_stall_gated", { gate, state, rs: video.readyState });
        },
        retry: (reason) => proxyRecovery.retry(reason, true),
        onExhausted: (message) => onError?.(message),
      });
      detachWatchdog = kernel.wireSignals({
        hls, video, watchdog: stallWatchdog,
        onFragLoaded: (data, info) => {
          const cb = fragStatsCbRef.current;
          if (!cb) return;
          if (info.loadMs <= 0 || info.loaded <= 0) return;
          cb({ bytes: info.loaded, loadMs: info.loadMs, fragDuration: data.frag.duration || 0, bitrate: hls.levels[data.frag.level]?.bitrate ?? 0 });
        },
        onFragBuffered: () => recovery.buffered(),
      });
      hls.loadSource(source.url);
      hls.attachMedia(video);
      /* HLS 实例登记（最终版 B3 线任务 2，纯诊断）：松手剖面据此区分重建前后的实例 */
      noteHoldHlsAttach();
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
      /* 内核源收尾：吞吐兜底 flush＋全局 playing 清零。 */
      kernel.endSource();
      if (vfcId != null && typeof vfcTarget.cancelVideoFrameCallback === "function") {
        try { vfcTarget.cancelVideoFrameCallback.call(video, vfcId); } catch { /* 忽略 */ }
      }
      attachedSource.current = null;
      disconnectNative?.();
      stallWatchdog?.dispose();
      detachWatchdog?.();
      video.removeEventListener("resize", onVideoResize);
      recoveryRef.current?.dispose(); recoveryRef.current = null;
      trace("source.cleanup");
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, streamKind, proxyRecovery.revision]);

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
    kernel.notePlaying(false, true);
    if (hlsRef.current) return;
    onError?.(mediaErrorMessage(videoRef.current?.error ?? null));
  };

  /* U1 合成层选档（纯函数 srVideoFilterMode 判，触发条件全文在该函数
   * 注释）：WebGL 呈现中不挂（防双重处理）；WebGL 不呈现（自动判档
   * off / 性能降到 off）且用户未显式关时挂 SVG natural 保底；硬故障
   * svgFallback 时挂本档位滤镜（既有路径）。保底的退出全自动：WebGL
   * 升档恢复呈现的同一渲染内摘除，用户零操作。 */
  const filterMode = srVideoFilterMode({ srPref: store?.srPref ?? "auto", srMode, canvasMode: canvasSrMode, svgFallback, canvasOffReason: svgFallback ? "unavailable" : srMode === "off" ? "judged" : "demoted" });
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
        /* 原生路径 rendition 记录经内核（不可控口径同前）。 */
        kernel.noteNativeRendition(v.videoWidth, v.videoHeight);
      }}
      onPlay={() => kernel.notePlaying(true)}
      onPause={() => { kernel.notePlaying(false); onPause?.(); }}
      onWaiting={() => onWaiting?.()}
      onSeeked={() => onSeeked?.()}
      onPlaying={(e) => {
        kernel.notePlaying(true);
        reportSize(e.target as HTMLVideoElement);
        if (activity.isActive()) onPlaying?.();
      }}
      onEnded={() => { kernel.notePlaying(false, true); if (activity.isActive()) onEnded?.(); }}
        onError={handleVideoError}
      />
      <SrCanvas
        videoRef={videoRef}
        mode={srMode}
        active={active}
        ready={ready}
        fit={fit}
        srcKey={src}
        /* 帧预算通道只传声明 fps（density.fps）：实测回填值
         * （measuredFps）只进判档 crisp 门，不许走此通道（回填线
         * 护栏 1，见 SuperResCanvas.srCostBudgetMs）。 */
        fps={srDensity?.fps}
        onFallbackChange={setSvgFallback}
        onActiveModeChange={setCanvasSrMode}
        onPipelineChange={kernel.setWebgpuEngaged}
        onTrace={trace}
      />
    </div>
  );
});

export default VideoSurface;
