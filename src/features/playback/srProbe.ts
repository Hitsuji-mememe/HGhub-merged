/**
 * WebGPU 探针 v2 实现（Muse 2026-11-19，fix2 超分换代检证）。
 *
 * 由 main.tsx 在启动时 registerSrProbeV2() 注册进 gpuProbe 的 v2 槽
 * （shared 定义槽位、features 提供实现，避免分层反向依赖）。v1 探针
 * 完成后由 gpuProbe 调度执行，全程旁路：任何失败收敛为结果行，
 * 不影响播放与报告其余内容。
 *
 * 方法（GPT 探针口径）：内置固定本地 MP4（public/probe/sr-720p.mp4、
 * sr-1080p.mp4；H.264、各 60 帧、testsrc2）→ 等 requestVideoFrameCallback
 * 确认真实帧到达（presentedFrames）→ 分别以 external / copy 两条
 * 摄入路径驱动真实引擎（Anime4K 全链）处理帧，记单帧成本分布 →
 * 选较快可用路径 → 同路径测 720p 全链（采纳门帧预算）与 1080p 全链。
 * 探针自建 canvas/video/device，用完即毁；探针 canvas 临时挂到
 * body 外（屏外定位）以保证 WKWebView 也能给出当前纹理。
 */

import { evaluateSrGatesV2, registerSrProbe, type SrProbeResult } from "../../shared/diagnostics/gpuProbe";
import { WebGpuSrEngine, type SrIngestPath } from "./webgpuSr";
import { SR_ENGINE_VERSION } from "./SrCanvas";

type VideoWithVfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, metadata: { presentedFrames: number }) => void) => number;
};

const FRAME_BUDGET_720P_MS = 33.3;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

/** 加载探针视频并等真实帧到达；返回 presentedFrames（达不到抛错）。 */
async function loadProbeVideo(url: string, minPresented: number): Promise<{ video: HTMLVideoElement; presented: number }> {
  const video = document.createElement("video") as VideoWithVfc;
  video.muted = true;
  video.playsInline = true;
  video.loop = true;
  video.preload = "auto";
  video.src = url;
  document.body.appendChild(video);
  video.style.cssText = "position:fixed;left:-9999px;top:0;width:4px;height:4px;pointer-events:none;";
  /* 失败自清理（fix2.1 批三#9）：play 重试失败或等帧超时都会抛错，
   * 旧实现直接冒泡、把已挂进 body 的 video 元素留成孤儿（还带着
   * src 继续加载）。失败路径统一 pause + 清 src + remove 再抛。 */
  try {
    try {
      await withTimeout(video.play(), 6000, "探针视频 play");
    } catch {
      /* play 被拒也继续等帧：loadeddata 后再试一次 */
      await new Promise((r) => setTimeout(r, 300));
      await withTimeout(video.play(), 6000, "探针视频 play 重试");
    }
    const presented = await withTimeout(new Promise<number>((resolve) => {
    if (typeof video.requestVideoFrameCallback !== "function") {
      /* 无 rVFC：以 readyState + currentTime 前进近似真帧（口径如实记 0 起步）。 */
      const t0 = video.currentTime;
      const check = () => {
        if (video.readyState >= 2 && video.currentTime > t0 + 0.2) resolve(minPresented);
        else if (video.readyState >= 2) setTimeout(check, 100);
      };
      check();
      return;
    }
    let last = 0;
    const tick = (_now: number, metadata: { presentedFrames: number }) => {
      last = metadata.presentedFrames;
      if (last >= minPresented) resolve(last);
      else video.requestVideoFrameCallback!(tick);
    };
    video.requestVideoFrameCallback(tick);
    }), 9000, "探针视频真帧到达");
    return { video, presented };
  } catch (error) {
    try { video.pause(); } catch { /* 忽略 */ }
    try { video.removeAttribute("src"); video.load(); } catch { /* 忽略 */ }
    try { video.remove(); } catch { /* 忽略 */ }
    throw error;
  }
}

/* 等帧必须有超时（fix2.1 批三#8）：旧实现纯等 requestVideoFrameCallback，
 * 源不再呈现新帧（解码停滞/视频播完定格）时 promise 永不落定，
 * benchPath 整场挂死且无失败记录。3s 无新帧即 reject，由 benchPath
 * 的 catch 收敛为该路径 ok:false。无 rVFC 时保留 34ms 近似口径。 */
function nextPresentedFrame(video: HTMLVideoElement, timeoutMs = 3000): Promise<void> {
  const v = video as VideoWithVfc;
  if (typeof v.requestVideoFrameCallback !== "function") {
    return new Promise((r) => setTimeout(r, 34));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等帧超时（${Math.round(timeoutMs / 1000)}s 内无新帧呈现）`)), timeoutMs);
    v.requestVideoFrameCallback!(() => { clearTimeout(timer); resolve(); });
  });
}

type BenchResult = { ok: boolean; msAvg: number | null; msP90: number | null; processed: number; dropped: number; tailRatio: number | null };

async function benchPath(
  path: SrIngestPath,
  video: HTMLVideoElement,
  frames: number,
  onLost: () => void,
  deadline = Number.POSITIVE_INFINITY,
): Promise<BenchResult> {
  /* 真实呈现尺寸画布（audit6 P0-A 第 3 层）：旧实现 4×4 画布把 present/
   * composite 成本测成约零、门数值系统性偏乐观。引擎输出为源 2× 上采样，
   * 画布按输出纹理尺寸建，呈现段成本如实入账。 */
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, (video.videoWidth || 640) * 2);
  canvas.height = Math.max(2, (video.videoHeight || 360) * 2);
  canvas.style.cssText = "position:fixed;left:-9999px;top:0;pointer-events:none;";
  document.body.appendChild(canvas);
  let engine: WebGpuSrEngine | null = null;
  let threw = false;
  try {
    engine = await WebGpuSrEngine.create(canvas, { path, onLost });
    if (!engine) return { ok: false, msAvg: null, msP90: null, processed: 0, dropped: 0, tailRatio: null };
    let headAvg: number | null = null;
    let headFrames = 0;
    const headAt = Math.max(1, Math.floor(frames / 3));
    for (let i = 0; i < frames; i += 1) {
      /* 整场总预算（fix2.1 批三#8）：逐帧检查，耗尽即以已处理帧结算 */
      if (Date.now() > deadline) break;
      await nextPresentedFrame(video);
      engine.processFrame(video, 0);
      if (i + 1 === headAt) {
        const mid = engine.getStats();
        headAvg = mid.frames ? mid.costAvgMs : null;
        headFrames = mid.frames;
      }
    }
    /* 等在飞帧结算 */
    await new Promise((r) => setTimeout(r, 600));
    const stats = engine.getStats();
    let tailRatio: number | null = null;
    if (headAvg != null && headAvg > 0 && stats.frames > headFrames && stats.costAvgMs != null) {
      const tailAvg = (stats.costAvgMs * stats.frames - headAvg * headFrames) / (stats.frames - headFrames);
      tailRatio = Math.round((tailAvg / headAvg) * 100) / 100;
    }
    return {
      /* ok 定义（audit6 P0-A 第 3 层）：完成计划帧数 ≥90% 且无同步异常，
       * 废除旧「处理 ≥1 帧即 ok」。 */
      ok: !threw && stats.frames >= Math.floor(frames * 0.9),
      msAvg: stats.frames ? stats.costAvgMs : null,
      msP90: stats.frames ? stats.costP90Ms : null,
      processed: stats.frames,
      dropped: stats.droppedStale,
      tailRatio,
    };
  } catch {
    threw = true;
    return { ok: false, msAvg: null, msP90: null, processed: 0, dropped: 0, tailRatio: null };
  } finally {
    try { engine?.destroy(); } catch { /* 忽略 */ }
    canvas.remove();
  }
}

async function runSrProbeV2(): Promise<SrProbeResult> {
  const at = new Date().toISOString();
  /* 整场 benchmark 总时间预算 90s（fix2.1 批三#8）：各阶段开始前与
   * benchPath 逐帧都检查，耗尽后未跑阶段以失败空结果收敛，探针
   * 永远能在有限时间内交出结果行，不挂死调度方。 */
  const deadline = Date.now() + 90000;
  let deviceLost = 0;
  const onLost = () => { deviceLost += 1; };
  const empty: BenchResult = { ok: false, msAvg: null, msP90: null, processed: 0, dropped: 0, tailRatio: null };
  let presented720 = 0;
  let frames720Ok = false;
  let video720: HTMLVideoElement | null = null;
  let video1080: HTMLVideoElement | null = null;
  try {
    try {
      const loaded = await loadProbeVideo("/probe/sr-720p.mp4", 10);
      video720 = loaded.video;
      presented720 = loaded.presented;
      frames720Ok = presented720 >= 10;
    } catch {
      frames720Ok = false;
    }
    if (!video720 || !frames720Ok) {
      return {
        at, presented720, frames720Ok,
        external: empty, copy: empty,
        chain720: { ok: false, msAvg: null, msP90: null, withinBudget: false },
        chain1080: { ok: false, msAvg: null, msP90: null },
        deviceLost, recommendedPath: null, gatesPass: false,
      };
    }
    const external = await benchPath("external", video720, 24, onLost, deadline);
    const copy = Date.now() > deadline ? empty : await benchPath("copy", video720, 24, onLost, deadline);
    let recommendedPath: SrIngestPath | null = null;
    if (external.ok && copy.ok) {
      recommendedPath = (external.msAvg ?? Infinity) <= (copy.msAvg ?? Infinity) ? "external" : "copy";
    } else if (external.ok) recommendedPath = "external";
    else if (copy.ok) recommendedPath = "copy";
    let chain720 = { ok: false, msAvg: null as number | null, msP90: null as number | null, withinBudget: false };
    let chain1080 = { ok: false, msAvg: null as number | null, msP90: null as number | null };
    if (recommendedPath && Date.now() <= deadline) {
      /* 全链段 300 帧连续处理（audit6 P0-A 第 3 层）：尾段成本比作热衰减门。 */
      const full = await benchPath(recommendedPath, video720, 300, onLost, deadline);
      chain720 = {
        ok: full.ok,
        msAvg: full.msAvg,
        msP90: full.msP90,
        withinBudget: full.ok && full.msAvg !== null && full.msAvg < FRAME_BUDGET_720P_MS,
      };
      (chain720 as { droppedRate?: number }).droppedRate = full.processed + full.dropped > 0 ? full.dropped / (full.processed + full.dropped) : 0;
      (chain720 as { tailRatio?: number | null }).tailRatio = full.tailRatio;
      try {
        if (Date.now() > deadline) throw new Error("整场预算耗尽，跳过 1080p 段");
        const loaded1080 = await loadProbeVideo("/probe/sr-1080p.mp4", 10);
        video1080 = loaded1080.video;
        const b1080 = await benchPath(recommendedPath, video1080, 300, onLost, deadline);
        chain1080 = { ok: b1080.ok, msAvg: b1080.msAvg, msP90: b1080.msP90 };
      } catch {
        chain1080 = { ok: false, msAvg: null, msP90: null };
      }
    }
    const full720 = chain720 as { droppedRate?: number; tailRatio?: number | null };
    const result: SrProbeResult = {
      at, presented720, frames720Ok, external, copy, chain720, chain1080,
      deviceLost, recommendedPath,
      droppedRate720: full720.droppedRate,
      tailRatio720: full720.tailRatio ?? null,
      gatesPass: false,
    };
    result.gatesPass = evaluateSrGatesV2(result);
    return result;
  } finally {
    for (const v of [video720, video1080]) {
      try { v?.pause(); } catch { /* 忽略 */ }
      try { if (v) { v.removeAttribute("src"); v.load(); v.remove(); } } catch { /* 忽略 */ }
    }
  }
}

let registered = false;
export function registerSrProbeV2(): void {
  if (registered) return;
  registered = true;
  registerSrProbe(runSrProbeV2, SR_ENGINE_VERSION);
}
