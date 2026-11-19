import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import type Hls from "hls.js";
import type { FragBufferedData, FragLoadedData, FragLoadingData, HlsListeners } from "hls.js";
import { copyText } from "../lib/clipboard";
import { createLedgerBinding, type LedgerBinding } from "./eventLedger";

let registeredHlsVersion: string | null = null;
export function registerHlsVersion(version: string) {
  registeredHlsVersion = version;
}

type Data = Record<string, unknown>;
type Status = { enabled: boolean; path: string | null; error: string | null };
type Entry = { event: string; data: Data };
type Snapshot = Status & { ready: boolean; pending: boolean };

// Separate transport also lets browser regressions verify diagnostics without Tauri or upstream.
export const playbackLogApi = {
  status: () => invoke<Status>("playback_log_status"),
  set: (enabled: boolean) => invoke<Status>("playback_log_set", { enabled }),
  write: (entries: Entry[]) => invoke<void>("playback_log_write", { entries }),
  read: () => invoke<string>("playback_log_read"),
};
let state: Snapshot = { enabled: false, path: null, error: null, ready: false, pending: false };
const listeners = new Set<() => void>();
const session = globalThis.crypto?.randomUUID?.() ?? `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
let init: Promise<void> | undefined;
let queue: Entry[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let writing: Promise<void> = Promise.resolve();
let nextPlayer = 0;
function publish(next: Partial<Snapshot>) {
  state = { ...state, ...next };
  listeners.forEach(fn => fn());
}
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const usePlaybackLog = () => useSyncExternalStore(subscribe, () => state);
export const playbackLogEnabled = () => state.enabled && !state.pending && !state.error;

export function tracePlayback(event: string, data: Data = {}) {
  /* 只有 error 态（初始化多次重试仍失败）才丢弃；ready 之前先入队，
   * init 完成时统一 flush——旧实现在 init 完成前静默丢事件，启动
   * 竞态下事件丢失会让报告误判（2026-11-18 终版加固）。 */
  if (state.error) return;
  // Bounded batches; sustained dragging must not create unlimited IPC or disk work.
  if (queue.length >= 512) {
    queue.splice(0, queue.length - 510);
    queue.unshift({ event: "queue.dropped", data: { session } });
  }
  queue.push({ event, data: { ...data, session, at: new Date().toISOString(), mono_ms: Math.round(performance.now()) } });
  if (!state.ready) return;
  if (!timer) timer = setTimeout(() => { void flushPlaybackLog(); }, 250);
}

export async function flushPlaybackLog() {
  clearTimeout(timer); timer = undefined;
  const entries = queue; queue = [];
  writing = writing.catch(() => {}).then(async () => {
    for (let i = 0; i < entries.length; i += 128) await playbackLogApi.write(entries.slice(i, i + 128));
  });
  try { await writing; }
  catch { publish({ error: "诊断日志写入失败，请检查可用空间后重新开启" }); }
}

export function initPlaybackLog() {
  return init ??= (async () => {
    /* 记录始终开启（2026-11-18 收官批 D 钉死）：原开关只管细节粒度，
     * 诊断合并后设置页不再有开关——状态为关时自动打开并持久化，
     * 保证诊断报告永远有最近播放流水可用。set 失败不挡启动。
     * 启动重试（同日晚终版加固）：冷启动/全新安装首启时日志状态
     * 可能尚未就绪，旧实现一次失败即整场静默——真机实锤在播却零
     * 记录、报告误报无播放。退避重试四次，全败才落 error 态，且
     * 报告会明示日志状态，不再假装没播过。 */
    const delays = [0, 1500, 4000, 10000];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      try {
        let saved = await playbackLogApi.status();
        if (!saved.enabled) {
          try { saved = await playbackLogApi.set(true); } catch { /* 保持原状态，下次启动再试 */ }
        }
        publish({ ...saved, ready: true });
        void flushPlaybackLog();
        tracePlayback("app.start", { version: __APP_VERSION__, platform: navigator.platform, user_agent: navigator.userAgent, hls_version: registeredHlsVersion, media_source: !!window.MediaSource, managed_media_source: "ManagedMediaSource" in window });
        return;
      } catch { /* 状态未就绪：退避后重试 */ }
    }
    init = undefined;
    publish({ error: "无法读取诊断日志设置" });
  })();
}

export async function setPlaybackLog(on: boolean) {
  if (!state.ready || state.pending) throw new Error("日志设置尚未就绪");
  publish({ pending: true });
  try {
    await flushPlaybackLog();
    const saved = await playbackLogApi.set(on);
    publish({ ...saved, pending: false });
    tracePlayback("app.snapshot", { version: __APP_VERSION__, platform: navigator.platform, user_agent: navigator.userAgent, hls_version: registeredHlsVersion, media_source: !!window.MediaSource, managed_media_source: "ManagedMediaSource" in window });
  } finally { if (state.pending) publish({ pending: false }); }
}

export async function copyPlaybackLog() {
  await flushPlaybackLog();
  const text = await playbackLogApi.read();
  if (!text) throw new Error("尚无诊断日志，请开启后复现问题");
  await copyText(text);
}

function isLocalMediaWrapper(url: URL) {
  return url.protocol === "hg:" || url.hostname === "hg.localhost"
    || (url.hostname === "127.0.0.1" && (/^\/([0-9a-f]{64}\/)?(img|hls|seg)$/.test(url.pathname)));
}

export function mediaResource(raw: string) {
  try {
    const url = new URL(raw);
    if (isLocalMediaWrapper(url)) raw = url.searchParams.get("u") || raw;
  } catch { /* still fingerprint invalid targets without logging their contents */ }
  let hash = 2166136261;
  for (const b of new TextEncoder().encode(raw)) hash = Math.imul(hash ^ b, 16777619) >>> 0;
  return `r${hash.toString(16).padStart(8, "0")}`;
}

/**
 * 只取 host，用来判断「是哪条 CDN / 哪个接口域名」。
 * 不含 path 与 query，所以能落盘：出问题时一眼看出是源站、还是某个分片域名挂了。
 */
export function mediaHost(raw: string): string {
  try {
    const url = new URL(raw);
    if (isLocalMediaWrapper(url)) {
      const inner = url.searchParams.get("u");
      if (inner) return new URL(inner).host;
    }
    return url.host;
  } catch {
    return "?";
  }
}

function ranges(value: TimeRanges) {
  return Array.from({ length: Math.min(value.length, 12) }, (_, i) => [round(value.start(i)), round(value.end(i))]);
}
const round = (n: number) => Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
const engines = new WeakMap<Hls, string>();
export function mediaSnapshot(v: HTMLVideoElement, hls?: Hls | null) {
  return { time: round(v.currentTime), duration: round(v.duration), paused: v.paused, seeking: v.seeking, ready: v.readyState, network: v.networkState,
    buffered: ranges(v.buffered), seekable: ranges(v.seekable), muted: v.muted, volume: v.volume, rate: v.playbackRate,
    buffering_enabled: hls?.bufferingEnabled, loading_enabled: hls?.loadingEnabled, media_error: v.error?.code ?? null,
    engine: hls ? engines.get(hls) : "native", prefer_managed: hls?.config.preferManagedMediaSource,
    visible: getComputedStyle(v).visibility !== "hidden" && v.getClientRects().length > 0 };
}

export function usePlayerDiagnostics(videoRef: RefObject<HTMLVideoElement | null>, hlsRef: RefObject<Hls | null>, context: Data) {
  const id = useRef<string>("");
  if (!id.current) id.current = `player-${++nextPlayer}`;
  const current = useRef(context); current.current = context;
  /* 事件账本接线（Muse 2026-11-19 根治包，诊断一级模块）：实例挂载
   * register、卸载 unregister；trace 全量镜像经 recordIfCurrent 入账，
   * 键＝(playerInstanceId, sourceGeneration)——generation 随资源指纹
   * 变化递增，报告侧按此隔离消费、禁跨源混合。卸载后的迟到回调被
   * recordIfCurrent 挡下计 droppedLate，不入窗口。 */
  const generation = useRef(0);
  const lastResource = useRef<unknown>(undefined);
  if (lastResource.current !== context.resource) {
    if (lastResource.current !== undefined) generation.current += 1;
    lastResource.current = context.resource;
  }
  /* 账本绑定（Muse 2026-11-19 整改 C1）：(id, generation) 注册时
   * 成对存下，注销后迟到回调不重注册、真实累加 droppedLate（旧
   * mirrorLedger 在 id 为 null 时重新注册，迟到事件被当新实例入账、
   * droppedLate 结构性恒 0）。注销顺序：主 effect 清理先经账本发出
   * player.unmount 再 dispose，注销动作本身不算迟到事件；主 effect
   * 未运行（如 video 缺失）时由其后声明的兜底清理 dispose（幂等）。 */
  const ledgerBinding = useRef<LedgerBinding | null>(null);
  if (!ledgerBinding.current) ledgerBinding.current = createLedgerBinding();
  const mirrorLedger = (event: string, data: Data) => {
    try {
      ledgerBinding.current?.record(event, data, generation.current);
    } catch { /* 记账旁路 */ }
  };
  const snapshot = () => {
    const v = videoRef.current;
    return { player: id.current, ...current.current, ...(v ? mediaSnapshot(v, hlsRef.current) : {}) };
  };
  const trace = (event: string, data: Data = {}) => {
    mirrorLedger(event, data);
    if (!playbackLogEnabled()) return;
    try { tracePlayback(event, { ...snapshot(), seek: pending.current?.id, ...data }); } catch { /* diagnostics must never interrupt playback */ }
  };
  const pending = useRef<{ id: number; target: number; start: number; seeks: number; seeked: boolean } | null>(null);
  const seekSeq = useRef(0);
  const requestSeek = (target: number, source: string) => {
    /* 账本独立于日志开关（Muse 2026-11-19 整改 C2）：此处不再前置
     * 判 playbackLogEnabled——trace 内部镜像无条件执行、落盘才受
     * 开关控制；旧前置 return 让日志不可用时账本同时失明。 */
    const previous = pending.current;
    if (previous) trace("seek.superseded", { seek: previous.id, next_target: round(target), elapsed_ms: Math.round(performance.now() - previous.start) });
    pending.current = { id: ++seekSeq.current, target, start: performance.now(), seeks: 0, seeked: false };
    trace("seek.request", { seek: seekSeq.current, target: round(target), source });
    if (videoRef.current && !videoRef.current.seeking && Math.abs(videoRef.current.currentTime - target) < .001) {
      trace("seek.noop", { seek: seekSeq.current });
      pending.current = null;
    }
  };

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let frame: number | undefined;
    let lastHeartbeat = 0;
    let timeoutReported = 0;
    const emit = (event: string, data: Data = {}) => {
      mirrorLedger(event, data);
      if (playbackLogEnabled()) {
        try { tracePlayback(event, { player: id.current, ...current.current, ...mediaSnapshot(v, hlsRef.current), ...data }); } catch { /* detached or changing ranges */ }
      }
    };
    const finish = (method: string, frameTime?: number) => {
      const p = pending.current;
      if (!p || !p.seeked) return;
      emit(method === "paused_ready" ? "seek.ready" : "seek.resumed", { seek: p.id, target: round(p.target), elapsed_ms: Math.round(performance.now() - p.start), method, frame_time: frameTime == null ? null : round(frameTime) });
      pending.current = null;
    };
    const onEvent = (e: Event) => {
      /* C2：不前置判日志开关——emit 内镜像无条件、落盘受开关控制。 */
      const p = pending.current;
      if (e.type === "seeking" && p) p.seeks++;
      if (e.type === "seeked" && p) p.seeked = true;
      emit(`media.${e.type}`, p ? { seek: p.id, target: round(p.target), elapsed_ms: Math.round(performance.now() - p.start), seeking_events: p.seeks } : {});
      if (e.type === "seeked") {
        if (frame != null) v.cancelVideoFrameCallback?.(frame);
        if (v.paused && v.readyState >= 2) finish("paused_ready");
        else if (v.requestVideoFrameCallback) {
          const expected = p?.id;
          frame = v.requestVideoFrameCallback((_now, metadata) => {
            if (pending.current?.id === expected) finish("video_frame", metadata.mediaTime);
          });
        }
      }
      if (e.type === "playing" && !v.requestVideoFrameCallback) finish("playing");
    };
    const events = ["loadstart", "loadedmetadata", "loadeddata", "play", "pause", "playing", "waiting", "stalled", "seeking", "seeked", "ended", "error", "emptied", "abort", "ratechange", "volumechange", "canplay"];
    events.forEach(event => v.addEventListener(event, onEvent));
    const stateChange = () => { emit("player.snapshot"); };
    const unsubscribe = subscribe(stateChange);
    const heartbeat = setInterval(() => {
      /* C2：心跳/超时同样先入账本，落盘与否由 emit 内部决定。 */
      const p = pending.current;
      if (p && performance.now() - p.start > 8000 && timeoutReported !== p.id) {
        timeoutReported = p.id;
        emit("seek.timeout", { seek: p.id, target: round(p.target), elapsed_ms: Math.round(performance.now() - p.start) });
      }
      if (performance.now() - lastHeartbeat >= 5000) { lastHeartbeat = performance.now(); emit("player.heartbeat"); }
    }, 1000);
    emit("player.mount");
    return () => {
      /* C1 注销顺序：先经账本发出 player.unmount（此时绑定仍活跃、
       * 正常入账），再 dispose——注销动作本身不变成迟到事件。 */
      emit("player.unmount");
      try { ledgerBinding.current?.dispose(); } catch { /* 记账旁路 */ }
      events.forEach(event => v.removeEventListener(event, onEvent));
      clearInterval(heartbeat); unsubscribe();
      if (frame != null) v.cancelVideoFrameCallback?.(frame);
    };
  }, []);
  /* C1 兜底注销：主 effect 未运行（mount 时 video 缺失等）时绑定仍
   * 可能经 trace 注册过实例；本清理声明在主 effect 之后，React 按
   * 声明序执行清理，dispose 幂等、不会与上方顺序冲突。 */
  useEffect(() => () => {
    try { ledgerBinding.current?.dispose(); } catch { /* 记账旁路 */ }
  }, []);
  useEffect(() => { trace("player.context"); }, [context.active, context.view, context.video_id, context.episode, context.resource]);
  return { trace, requestSeek };
}

type HlsEventsMap = typeof Hls.Events;

export function observeHls(hls: Hls, trace: (event: string, data?: Data) => void, eventsMap: HlsEventsMap) {
  hls.on(eventsMap.MEDIA_ATTACHED, (_event, data) => {
    const source = data.mediaSource;
    engines.set(hls, source?.constructor.name || "MediaSource");
    trace("hls.attached", { engine: engines.get(hls), prefer_managed: hls.config.preferManagedMediaSource });
    if (source) {
      const start = () => trace("mms.startstreaming");
      const end = () => trace("mms.endstreaming");
      source.addEventListener("startstreaming", start);
      source.addEventListener("endstreaming", end);
      /* MediaSource 状态跃迁（Muse 2026-11-18 诊断探针，仅记录不改行为）：
         2.2.0 修复版真机出现「分片已下载但不 buffered、无 error」的无声停滞，
         FRAG_LOADED 与 FRAG_BUFFERED 之间缺一环证据——补 sourceopen/ended/close
         与 readyState，配合下方 BUFFER_APPENDED / SourceBuffer 事件钉死卡点。 */
      const state = (name: string) => () => trace(`mse.${name}`, { ready_state: source.readyState });
      const onOpen = state("sourceopen"), onEnded = state("sourceended"), onClose = state("sourceclose");
      source.addEventListener("sourceopen", onOpen);
      source.addEventListener("sourceended", onEnded);
      source.addEventListener("sourceclose", onClose);
      hls.once(eventsMap.DESTROYING, () => {
        source.removeEventListener("startstreaming", start); source.removeEventListener("endstreaming", end);
        source.removeEventListener("sourceopen", onOpen); source.removeEventListener("sourceended", onEnded); source.removeEventListener("sourceclose", onClose);
      });
    }
  });
  /* append 链探针（同上，仅记录）：BUFFER_APPENDED 是 FRAG_BUFFERED 的前一环，
     SourceBuffer 的 updateend/error 区分「没调 append / 调了没完成 / 完成了但
     buffered 没涨」三种根因。 */
  hls.on(eventsMap.BUFFER_APPENDED, (_event, data) => {
    /* C2：不前置判日志开关，trace 内部镜像无条件执行。 */
    const spans: Data = {};
    for (const [kind, value] of Object.entries(data.timeRanges)) if (value) spans[kind] = ranges(value);
    trace("hls.buffer_appended", { sb_type: data.type, fragment: data.frag.sn, start: round(data.frag.start), duration: round(data.frag.duration), ranges: spans });
  });
  hls.on(eventsMap.BUFFER_CREATED, (_event, data) => {
    const removers: Array<() => void> = [];
    for (const [kind, track] of Object.entries(data.tracks)) {
      const buffer = track?.buffer;
      if (!buffer) continue;
      const onUpdateEnd = () => { trace("mse.updateend", { sb_type: kind, updating: buffer.updating, buffered: ranges(buffer.buffered) }); };
      const onError = () => trace("mse.sb_error", { sb_type: kind });
      buffer.addEventListener("updateend", onUpdateEnd);
      buffer.addEventListener("error", onError);
      removers.push(() => { buffer.removeEventListener("updateend", onUpdateEnd); buffer.removeEventListener("error", onError); });
    }
    if (removers.length) hls.once(eventsMap.DESTROYING, () => removers.forEach(fn => fn()));
  });
  hls.on(eventsMap.MANIFEST_PARSED, () => trace("hls.manifest", { levels: hls.levels.length }));
  for (const event of [eventsMap.FRAG_LOADING, eventsMap.FRAG_LOADED, eventsMap.FRAG_BUFFERED, eventsMap.FRAG_LOAD_EMERGENCY_ABORTED] as (keyof HlsListeners)[]) {
    hls.on(event, ((_event: string, data: FragLoadingData | FragLoadedData | FragBufferedData) => {
      /* C2：不前置判日志开关，trace 内部镜像无条件执行。 */
      const { frag } = data;
      const loading = frag.stats.loading;
      trace(String(event), { resource: mediaResource(frag.url), host: mediaHost(frag.url), fragment: frag.sn, start: round(frag.start), duration: round(frag.duration), bytes: frag.stats.loaded,
        load_ms: loading.end > 0 && loading.end >= loading.start ? round(loading.end - loading.start) : null,
        first_byte_ms: loading.first > 0 && loading.first >= loading.start ? round(loading.first - loading.start) : null });
    }) as HlsListeners[typeof event]);
  }
  hls.on(eventsMap.ERROR, (_event, data) => trace("hls.error", { type: data.type, detail: data.details, fatal: data.fatal, status: data.response?.code,
    fragment: data.frag?.sn, resource: data.frag ? mediaResource(data.frag.url) : undefined, host: data.frag ? mediaHost(data.frag.url) : undefined }));
}

export function installPlaybackPageEvents() {
  document.addEventListener("visibilitychange", () => tracePlayback("page.visibility", { visibility: document.visibilityState }));
  window.addEventListener("pagehide", () => { tracePlayback("page.hide"); void flushPlaybackLog(); });
  document.addEventListener("securitypolicyviolation", e => tracePlayback("security.csp_violation", { directive: e.effectiveDirective, disposition: e.disposition, resource: mediaResource(e.blockedURI) }));
}
