/* ── 播放内核收敛（最终版 A 线，①用户点名架构债；Muse 2026-11-19）──
 * VideoSurface（Feed）与 Player（帖子）此前各有一套 facts 发布／吞吐
 * 回写／看门狗／诊断接线，且已实证漂移：Player 不发布 PlaybackFacts、
 * 不回写真实播放吞吐（GPT 复审 P2-09，②实锤）。本 hook 把两面共用
 * 的内核收敛为一份：活动层消费、notePlaybackPlaying、facts 发布、
 * HLS 分片吞吐 reporter 回写、SR 密度采样接入、append 看门狗接线、
 * 诊断实例登记/注销（usePlayerDiagnostics 内含账本绑定）。两面只留
 * 渲染与控件差异。纯核心 createPlaybackKernelCore 与 facts 组装
 * buildPlaybackFacts 可独立单测（tests/playback-engines A 组）。 */
import { useEffect, useRef, useState, type RefObject } from "react";
import Hls, { type FragLoadedData } from "hls.js";
import { api } from "../../shared/api/api";
import { mediaResource, observeHls, registerHlsVersion, usePlayerDiagnostics } from "../../shared/diagnostics/playbackDiagnostics";
import { notePlaybackPlaying, publishPlaybackFacts, type PlaybackFacts } from "../../shared/diagnostics/playbackFacts";
import { usePlaybackActivity } from "./usePlaybackActivity";
import { createFragThroughputReporter, currentLineOrigin } from "./playbackThroughput";
import { createStallWatchdog, wireStallWatchdogSignals, type StallGate, type StallRetryReason } from "./stallWatchdogWiring";
import type { AppendStallWatchdog, AppendStallState } from "./appendStallWatchdog";
import { useSrDensity, type SrDensity, type SrFragSample, type SrLevelInfo } from "./useSrDensity";
import { formatFirstRendition, observeFirstRendition } from "./hlsConfig";
import { presentationPipeline, srVideoFilterMode } from "./SuperResCanvas";
import type { SrPref, SuperResMode } from "../../shared/model/store";

/* ── 纯核心：分片 ingest 的采样身份／吞吐口径与 playing 信号门控 ── */

export type KernelLevelInfo = { frameRate?: number; videoCodec?: string; width?: number; height?: number; bitrate?: number };
export type KernelHlsLike = { currentLevel: number; levels: Array<KernelLevelInfo | undefined> };
export type KernelFragData = {
  frag: {
    stats: { loaded: number; loading: { start: number; end: number } };
    duration: number;
    level: number;
  };
};
export type KernelFragInfo = { loaded: number; loadMs: number; fragLevel: number; playingLevel: number };

export function createPlaybackKernelCore(deps: {
  /** 吞吐回写通道（生产＝api.lineRecordPlayback，失败静默）。 */
  sendThroughput: (origin: string, bps: number) => void;
  /** SR 密度采样接入（生产＝useSrDensity.ingest）。 */
  ingestDensity: (frag: SrFragSample, level: SrLevelInfo) => void;
}) {
  const throughput = createFragThroughputReporter(deps.sendThroughput);
  let playingLevel = -1;
  return {
    setLineOrigin(origin: string): void {
      throughput.setOrigin(origin);
    },
    flushThroughput(): void {
      throughput.flush();
    },
    setPlayingLevel(level: number): void {
      playingLevel = level;
    },
    resetPlayingLevel(): void {
      playingLevel = -1;
    },
    /** 分片到达的统一 ingest（整改 B4 口径）：采样身份与 rendition
     * 信息全部取正在播放的 level（LEVEL_SWITCHED 维护、currentLevel
     * 兜底），不取分片的下载 level；吞吐与密度共用同一 loadMs 口径。 */
    ingestFrag(hls: KernelHlsLike, data: KernelFragData): KernelFragInfo {
      const pl = playingLevel >= 0 ? playingLevel : hls.currentLevel;
      const pLevel = pl >= 0 ? hls.levels[pl] : undefined;
      deps.ingestDensity(
        { loaded: data.frag.stats.loaded, duration: data.frag.duration, level: pl >= 0 ? pl : data.frag.level },
        pLevel ? { frameRate: pLevel.frameRate, videoCodec: pLevel.videoCodec, width: pLevel.width, height: pLevel.height, bitrate: pLevel.bitrate } : undefined,
      );
      const st = data.frag.stats;
      const loadMs = st.loading.end > 0 && st.loading.end >= st.loading.start ? st.loading.end - st.loading.start : 0;
      if (loadMs > 0) throughput.push(st.loaded, loadMs);
      return { loaded: st.loaded, loadMs, fragLevel: data.frag.level, playingLevel: pl };
    },
    /** 全局 playing 事实置位：只认活动面（isActive 门控与两面现行
     * onPlay/onPlaying/onPause 口径一致）；源卸载的清零走 endSource
     * 的无条件路径，不经此门控。 */
    notePlaying(playing: boolean, isActive: () => boolean): void {
      if (isActive()) notePlaybackPlaying(playing);
    },
  };
}

export type PlaybackKernelCore = ReturnType<typeof createPlaybackKernelCore>;

/** facts 组装（纯函数）：字段口径以 VideoSurface 现行发布为准；
 * 可选字段未取到时整键缺失，不写 undefined。density 的可选
 * provisional（E 线）按可选透传。 */
export function buildPlaybackFacts(input: {
  w: number;
  h: number;
  density?: (SrDensity & { provisional?: boolean }) | null;
  srMode: string;
  engine?: string;
  firstRendition?: string;
  pipeline?: string;
  srDemoteCount?: number;
  at: number;
}): PlaybackFacts {
  const d = input.density ?? undefined;
  return {
    w: input.w,
    h: input.h,
    ...(d?.bitrateBps !== undefined ? { bitrateBps: d.bitrateBps } : {}),
    ...(d?.fps !== undefined ? { fps: d.fps } : {}),
    ...(d?.codec !== undefined ? { codec: d.codec } : {}),
    srMode: input.srMode,
    ...(input.firstRendition !== undefined ? { firstRendition: input.firstRendition } : {}),
    ...(input.pipeline !== undefined ? { pipeline: input.pipeline } : {}),
    ...(input.srDemoteCount !== undefined ? { srDemoteCount: input.srDemoteCount } : {}),
    ...(input.engine !== undefined ? { engine: input.engine } : {}),
    ...(d?.provisional !== undefined ? { provisional: d.provisional } : {}),
    at: input.at,
  };
}

/* ── hook：两播放面共用的内核接线 ── */

export function usePlaybackKernel(opts: {
  videoRef: RefObject<HTMLVideoElement | null>;
  hlsRef: RefObject<Hls | null>;
  src: string;
  active: boolean;
  autoPlay: boolean;
  lineEpoch: number;
  diagnosticContext?: Record<string, unknown>;
}) {
  const { videoRef, hlsRef, src, active } = opts;
  /* 诊断实例登记/注销：usePlayerDiagnostics 挂载 register、卸载
   * dispose 账本绑定，两面共用一份（原各自调用同一 hook，保留）。 */
  const diag = usePlayerDiagnostics(videoRef, hlsRef, { ...(opts.diagnosticContext ?? {}), active, resource: mediaResource(src) });
  const activity = usePlaybackActivity(videoRef, hlsRef, { active, autoPlay: opts.autoPlay, src, trace: diag.trace });
  /* SR 密度采样：共享 hook（未满 3 片为已采样本上中位数、满 3 片
   * 定稿，provisional 不驱动判档；＋frameRate＋videoCodec，换源/
   * 换线重置——口径以 useSrDensity.ts 文件头为准，E 线定版），
   * 两面同口径。density 的 provisional 字段按可选消费。 */
  const { density, ingest } = useSrDensity(src, opts.lineEpoch);
  const ingestRef = useRef(ingest);
  ingestRef.current = ingest;
  const densityRef = useRef(density);
  densityRef.current = density;

  const coreRef = useRef<PlaybackKernelCore | null>(null);
  if (!coreRef.current) {
    coreRef.current = createPlaybackKernelCore({
      sendThroughput: (origin, bps) => {
        void api.lineRecordPlayback(origin, bps).catch(() => { /* 命令缺失/失败静默 */ });
      },
      ingestDensity: (frag, level) => ingestRef.current(frag, level),
    });
  }
  const core = coreRef.current;

  /* append 卡死自愈计数：同一源第一次判死重建、第二次判死触发会话
   * 级原生降级；换源清零（两面同规则，现收敛一份）。 */
  const stallAttemptRef = useRef(0);
  const stallSrcRef = useRef(src);
  if (stallSrcRef.current !== src) {
    stallSrcRef.current = src;
    stallAttemptRef.current = 0;
  }

  /* facts 呈现侧状态：首分片 rendition、WebGPU 接管、实际呈现档位
   * 与降档计数（呈现档沿 crisp→natural→off 阶梯下移即累计）。 */
  const engineRef = useRef("");
  const [firstRendition, setFirstRenditionState] = useState<string | undefined>(undefined);
  const firstRenditionRef = useRef<string | undefined>(undefined);
  const setFirstRendition = (next: string | undefined) => {
    firstRenditionRef.current = next;
    setFirstRenditionState(next);
  };
  const [webgpuEngaged, setWebgpuEngagedState] = useState(false);
  const webgpuRef = useRef(false);
  const setWebgpuEngaged = (next: boolean) => {
    webgpuRef.current = next;
    setWebgpuEngagedState(next);
  };
  const [srDemoteCount, setSrDemoteCountState] = useState(0);
  const demoteRef = useRef(0);
  /* 初值与两面旧实现一致：尺寸未知时 effectiveSrMode 判 "natural"，
   * 组件 useState(srMode) 的首渲染值即此；SrCanvas 挂载后经
   * onActiveModeChange 同步真实呈现档。 */
  const [canvasSrMode, setCanvasSrModeState] = useState<SuperResMode>("natural");
  const canvasSrModeRef = useRef<SuperResMode>("natural");
  const setCanvasSrMode = (mode: SuperResMode) => {
    const ladder = ["crisp", "natural", "off"];
    const from = ladder.indexOf(canvasSrModeRef.current);
    const to = ladder.indexOf(mode);
    if (from >= 0 && to > from) {
      demoteRef.current += to - from;
      setSrDemoteCountState(demoteRef.current);
    }
    canvasSrModeRef.current = mode;
    setCanvasSrModeState(mode);
  };
  /** 换源时呈现侧事实复位（两面 layout 期的清零动作收敛一份）。 */
  const resetPresentation = () => {
    setFirstRendition(undefined);
    demoteRef.current = 0;
    setSrDemoteCountState(0);
  };

  /* 线路切换后吞吐账本键跟随新线路 base（整改 B3）：lineEpoch 变化
   * 即刷新（hg:line-changed 时 lastPickRound 已先行更新）。 */
  useEffect(() => {
    core.setLineOrigin(currentLineOrigin());
  }, [core, opts.lineEpoch]);

  /** 源装载起点：记引擎、清 playing level、吞吐账本按当前线路记账。 */
  const beginSource = (engine: string) => {
    engineRef.current = engine;
    core.resetPlayingLevel();
    core.setLineOrigin(currentLineOrigin());
  };
  /** 源卸载收尾：吞吐兜底 flush＋全局 playing 清零（无条件，与两面
   * 现行 cleanup 口径一致）。诊断实例注销由 usePlayerDiagnostics
   * 自身的 effect 清理负责，不在此重复。 */
  const endSource = () => {
    core.flushThroughput();
    notePlaybackPlaying(false);
  };
  /** HLS 观察接线：版本登记＋observeHls（以代次捕获 trace 登记，
   * P2-08：旧实例迟到事件按起源代次拒收）＋playing level 维护＋
   * 首分片 rendition 采集。 */
  const attachHls = (hls: Hls) => {
    if (Hls.version) registerHlsVersion(Hls.version);
    observeHls(hls, diag.captureTrace(), Hls.Events);
    hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
      core.setPlayingLevel(data.level);
    });
    observeFirstRendition(hls, Hls.Events, r => setFirstRendition(formatFirstRendition(r)));
  };
  /** 原生路径 rendition 不可控（P0-A 第 1 层明示）：只记实际分辨率。 */
  const noteNativeRendition = (w: number, h: number) => {
    if (engineRef.current && engineRef.current !== "hls.js" && w > 0) {
      setFirstRendition(`原生实际 ${w}x${h}（档位不可控）`);
    }
  };
  /** 看门狗构造：意愿门控/判死/重建/降级全在 stallWatchdogWiring
   * 一份；此处只注入内核的 activity 与判死计数，调用方给差异
   * （isCurrent／trace 字段／retry 通道／报错通道）。 */
  const watchdogFor = (o: {
    video: HTMLVideoElement;
    isCurrent: () => boolean;
    traceStall: (state: AppendStallState, attempt: number) => void;
    traceGated?: (info: { gate: StallGate; state: AppendStallState }) => void;
    retry: (reason: StallRetryReason) => void;
    onExhausted: (message: string) => void;
  }): AppendStallWatchdog => createStallWatchdog({
    video: o.video,
    isCurrent: o.isCurrent,
    isPlayWanted: () => activity.isPlayWanted(),
    pauseState: () => activity.pauseState(),
    attemptRef: stallAttemptRef,
    traceStall: o.traceStall,
    traceGated: o.traceGated,
    retry: o.retry,
    onExhausted: o.onExhausted,
  });
  /** 看门狗信号接线：分片到达先经内核统一 ingest（密度＋吞吐），
   * 再走调用方自有逻辑（frag 统计回调等）。 */
  const wireSignals = (o: {
    hls: Hls;
    video: HTMLVideoElement;
    watchdog: AppendStallWatchdog;
    onFragLoaded?: (data: FragLoadedData, info: KernelFragInfo) => void;
    onFragBuffered?: () => void;
  }): (() => void) => wireStallWatchdogSignals({
    hls: o.hls,
    video: o.video,
    watchdog: o.watchdog,
    onFragLoaded: (data) => {
      const info = core.ingestFrag(o.hls as unknown as KernelHlsLike, data as unknown as KernelFragData);
      o.onFragLoaded?.(data, info);
    },
    onFragBuffered: o.onFragBuffered,
  });
  /** playing 事实置位（活动门控）：播放面事件处理器统一经此；
   * force=true 为无条件置位（ended/error 的清零口径，两面现行一致）。 */
  const notePlaying = (playing: boolean, force = false) => {
    if (force) {
      notePlaybackPlaying(playing);
      return;
    }
    core.notePlaying(playing, activity.isActive);
  };
  /** facts 发布：尺寸/判档由调用方给（渲染侧状态），其余字段（密度/
   * 引擎/首档/管线/降档）全部取内核呈现侧状态，一份组装口径。 */
  const publishFacts = (input: { w: number; h: number; srMode: SuperResMode; srPref: SrPref; canvasMode: SuperResMode; svgFallback: boolean }) => {
    if (input.w <= 0 || input.h <= 0) return;
    const fm = srVideoFilterMode({
      srPref: input.srPref, srMode: input.srMode, canvasMode: input.canvasMode, svgFallback: input.svgFallback,
      canvasOffReason: input.svgFallback ? "unavailable" : input.srMode === "off" ? "judged" : "demoted",
    });
    publishPlaybackFacts(buildPlaybackFacts({
      w: input.w,
      h: input.h,
      density: densityRef.current,
      srMode: input.srMode,
      engine: engineRef.current || undefined,
      firstRendition: firstRenditionRef.current,
      pipeline: presentationPipeline({ webgpuEngaged: webgpuRef.current, canvasMode: input.canvasMode, filterMode: fm }),
      srDemoteCount: demoteRef.current,
      at: Date.now(),
    }));
  };

  return {
    trace: diag.trace,
    requestSeek: diag.requestSeek,
    activity,
    density,
    core,
    beginSource,
    endSource,
    attachHls,
    noteNativeRendition,
    watchdogFor,
    wireSignals,
    notePlaying,
    publishFacts,
    resetPresentation,
    firstRendition,
    webgpuEngaged,
    setWebgpuEngaged,
    srDemoteCount,
    canvasSrMode,
    setCanvasSrMode,
  };
}
