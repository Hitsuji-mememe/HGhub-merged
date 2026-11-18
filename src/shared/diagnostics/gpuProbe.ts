/**
 * WebGPU 四层能力探针（Muse 2026-11-18 U3，口径纠正版）：每会话后台
 * 自动跑一次，结果记入事件账本并缓存，诊断报告生成时只读缓存——
 * 用户不用点、不用看、不用回报；报告生成路径绝不现跑探针。
 *
 * 时机：scheduleGpuProbe() 由启动诊断路径（main.tsx 的
 * scheduleBootDiagnostics、TV bootstrap）在 App 启动后调用一次，
 * 实际执行推迟到 requestIdleCallback（兜底 setTimeout 2.5s），
 * 不阻塞启动、不与起播抢主线程。幂等：重复调度/重复 run 只跑一次。
 *
 * 四层（逐层独立成败，任一层失败不拖垮其他层与报告）：
 *   ① API 层    navigator.gpu 是否存在
 *   ② 设备层    requestAdapter / requestDevice 是否成功
 *   ③ 计算层    最简 WGSL compute pipeline 能否创建并 dispatch 一次
 *   ④ 视频层    能否把一个 video 元素帧 importExternalTexture 为 GPU 纹理
 *               （API 不存在即记不可用；探针视频源由 canvas.captureStream
 *               自构造，不碰任何真实播放元素与播放路径）
 *
 * ── 旁路纪律 ────────────────────────────────────────────────────────────
 * 只报能力：不启用任何 WebGPU 超分路径、不改变播放行为。探针全程
 * 异步、每层 try/catch、整体兜底，任何异常都静默收敛为结果行，
 * 绝不抛错、绝不影响诊断报告既有内容生成。探针自建的 GPUDevice
 * 用完即 destroy 释放；自建的 video/canvas/stream 用完即停轨释放。
 * headless / 老系统预期结果：多为 ① 层即 ✗（无 navigator.gpu）或
 * ② 层 ✗（requestAdapter 返回 null），属正常能力结论、非故障。
 */

import { record } from "./eventLedger";

export type GpuProbeLayer = { ok: boolean; detail: string };
export type GpuProbeResult = {
  api: GpuProbeLayer;
  device: GpuProbeLayer;
  compute: GpuProbeLayer;
  video: GpuProbeLayer;
  adapterInfo: string | null;
  /** 探针完成时刻（ISO）。 */
  at: string;
};

/* 本仓未引入 @webgpu/types，探针只用最小结构类型（按 API 现状取子集，
 * 全部可选链/能力检测调用，避免老实现缺方法时类型或运行时翻车）。 */
type GpuBufferLike = { destroy?: () => void };
type GpuComputePassLike = {
  setPipeline: (pipeline: unknown) => void;
  setBindGroup: (index: number, bindGroup: unknown) => void;
  dispatchWorkgroups: (x: number) => void;
  end: () => void;
};
type GpuDeviceLike = {
  queue: {
    submit: (commandBuffers: unknown[]) => void;
    onSubmittedWorkDone?: () => Promise<void>;
  };
  createBuffer: (desc: { size: number; usage: number }) => GpuBufferLike;
  createShaderModule: (desc: { code: string }) => unknown;
  createComputePipeline: (desc: unknown) => { getBindGroupLayout: (index: number) => unknown };
  createBindGroup: (desc: unknown) => unknown;
  createCommandEncoder: () => {
    beginComputePass: () => GpuComputePassLike;
    finish: () => unknown;
  };
  importExternalTexture?: (desc: { source: HTMLVideoElement }) => unknown;
  destroy?: () => void;
};
type GpuAdapterInfoLike = { vendor?: string; architecture?: string; description?: string };
type GpuAdapterLike = {
  requestDevice: () => Promise<GpuDeviceLike>;
  info?: GpuAdapterInfoLike;
  requestAdapterInfo?: () => Promise<GpuAdapterInfoLike>;
};
type GpuLike = { requestAdapter: () => Promise<GpuAdapterLike | null> };

const fail = (detail: string): GpuProbeLayer => ({ ok: false, detail });
const ok = (detail: string): GpuProbeLayer => ({ ok: true, detail });

function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "未知错误");
  return msg.length > 120 ? `${msg.slice(0, 120)}…` : msg;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(errText(e))); },
    );
  });
}

async function probeLayers(): Promise<GpuProbeResult> {
  const at = new Date().toISOString();
  let device: GpuDeviceLike | null = null;
  try {
    /* ① API 层 */
    const gpu = (navigator as unknown as { gpu?: GpuLike }).gpu;
    if (!gpu || typeof gpu.requestAdapter !== "function") {
      const why = "navigator.gpu 不存在（WebView/系统未提供 WebGPU）";
      return { api: fail(why), device: fail("无 API，未测"), compute: fail("无 API，未测"), video: fail("无 API，未测"), adapterInfo: null, at };
    }
    const api = ok("navigator.gpu 存在");

    /* ② 设备层 */
    let adapter: GpuAdapterLike | null = null;
    try {
      adapter = await withTimeout(gpu.requestAdapter(), 4000, "requestAdapter");
    } catch (e) {
      return { api, device: fail(`requestAdapter 失败：${errText(e)}`), compute: fail("无 GPUDevice，未测"), video: fail("无 GPUDevice，未测"), adapterInfo: null, at };
    }
    if (!adapter) {
      return { api, device: fail("requestAdapter 返回 null（无可用 GPU 适配器）"), compute: fail("无 GPUDevice，未测"), video: fail("无 GPUDevice，未测"), adapterInfo: null, at };
    }
    let adapterInfo: string | null = null;
    try {
      const info = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : undefined);
      if (info) adapterInfo = [info.vendor, info.architecture, info.description].filter(Boolean).join(" / ") || null;
    } catch { /* 适配器信息只是附带说明，取不到不算设备层失败 */ }
    try {
      device = await withTimeout(adapter.requestDevice(), 4000, "requestDevice");
    } catch (e) {
      return { api, device: fail(`requestDevice 失败：${errText(e)}`), compute: fail("无 GPUDevice，未测"), video: fail("无 GPUDevice，未测"), adapterInfo, at };
    }
    const deviceLayer = ok(adapterInfo ? `requestDevice 成功（${adapterInfo}）` : "requestDevice 成功");

    /* ③ 计算层：一条最简 WGSL compute（storage buffer 自增）dispatch 一次。
     * GPUBufferUsage 数值常量：STORAGE=0x80、COPY_DST=0x08（无 types 时用字面量）。 */
    let compute: GpuProbeLayer;
    let probeBuffer: GpuBufferLike | null = null;
    try {
      probeBuffer = device.createBuffer({ size: 4, usage: 0x80 | 0x08 });
      const module = device.createShaderModule({
        code: "@group(0) @binding(0) var<storage, read_write> data: array<u32>;\n@compute @workgroup_size(1) fn main() { data[0] = data[0] + 1u; }",
      });
      const pipeline = device.createComputePipeline({
        layout: "auto",
        compute: { module, entryPoint: "main" },
      });
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: probeBuffer } }],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(1);
      pass.end();
      device.queue.submit([encoder.finish()]);
      if (device.queue.onSubmittedWorkDone) {
        await withTimeout(device.queue.onSubmittedWorkDone(), 2000, "compute 完成等待");
      }
      compute = ok("compute pipeline 已创建并 dispatch 1 个 workgroup");
    } catch (e) {
      compute = fail(`compute dispatch 失败：${errText(e)}`);
    } finally {
      try { probeBuffer?.destroy?.(); } catch { /* 释放失败不影响结论 */ }
    }

    /* ④ 视频层：importExternalTexture 导入自构造 video 的一帧。
     * 视频源 = 2×2 canvas 的 captureStream（探针专用、脱离文档、
     * 静音），不碰任何真实播放元素；无此 API 即记不可用。 */
    let video: GpuProbeLayer;
    if (typeof device.importExternalTexture !== "function") {
      video = fail("GPUDevice.importExternalTexture 不可用");
    } else {
      let el: HTMLVideoElement | null = null;
      let stream: MediaStream | null = null;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 2;
        canvas.height = 2;
        canvas.getContext("2d")?.fillRect(0, 0, 2, 2);
        const capture = (canvas as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream }).captureStream;
        if (typeof capture !== "function") throw new Error("canvas.captureStream 不可用，无法构造探针视频源");
        stream = capture.call(canvas, 1);
        el = document.createElement("video");
        el.muted = true;
        el.playsInline = true;
        el.srcObject = stream;
        await withTimeout(el.play(), 1500, "探针视频 play");
        const deadline = Date.now() + 1200;
        while (el.readyState < 2 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        if (el.readyState < 2) throw new Error(`探针视频帧未就绪（readyState=${el.readyState}）`);
        const texture = device.importExternalTexture({ source: el });
        if (!texture) throw new Error("importExternalTexture 返回空");
        video = ok("importExternalTexture 已导入一帧");
      } catch (e) {
        video = fail(`视频帧导入失败：${errText(e)}`);
      } finally {
        try { el?.pause(); } catch { /* 忽略 */ }
        try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* 忽略 */ }
        try { if (el) el.srcObject = null; } catch { /* 忽略 */ }
      }
    }

    return { api, device: deviceLayer, compute, video, adapterInfo, at };
  } finally {
    /* 探针自建 device 用完释放（destroy 不存在于个别老实现，可选调用）。 */
    try { device?.destroy?.(); } catch { /* 忽略 */ }
  }
}

function allFail(detail: string): GpuProbeResult {
  const layer = fail(detail);
  return { api: layer, device: layer, compute: layer, video: layer, adapterInfo: null, at: new Date().toISOString() };
}

let cached: GpuProbeResult | null = null;
let inflight: Promise<GpuProbeResult> | null = null;
let scheduled = false;

/** 同步读缓存（诊断报告唯一入口）：未跑完返回 null，绝不在此现跑。 */
export function getCachedGpuProbe(): GpuProbeResult | null {
  return cached;
}

/**
 * 跑一次探针并缓存（幂等：已有缓存/在跑时直接复用）。完成后把四层
 * 结论记入事件账本（gpu.probe）。永不 reject：异常收敛为全层失败行。
 */
export function runGpuProbe(): Promise<GpuProbeResult> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = (async () => {
    let result: GpuProbeResult;
    try {
      result = await probeLayers();
    } catch (e) {
      result = allFail(`探针内部异常：${errText(e)}`);
    }
    cached = result;
    try {
      record("gpu.probe", {
        api: result.api.ok,
        device: result.device.ok,
        compute: result.compute.ok,
        video: result.video.ok,
        adapter: result.adapterInfo,
      });
    } catch { /* 记账是旁路，失败不影响缓存结果 */ }
    return result;
  })();
  return inflight;
}

/**
 * 会话级自动调度（幂等）：启动路径调用一次即可，实际执行推迟到
 * 浏览器空闲（requestIdleCallback，超时 5s 兜底）或 2.5s 后，
 * 不阻塞启动与起播。重复调用无副作用。
 */
export function scheduleGpuProbe(): void {
  if (scheduled || cached || inflight) return;
  scheduled = true;
  const start = () => { void runGpuProbe(); };
  try {
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (typeof ric === "function") {
      ric(start, { timeout: 5000 });
      return;
    }
  } catch { /* 落到 setTimeout 兜底 */ }
  setTimeout(start, 2500);
}

/** 报告「WebGPU 探针」节的文本行：只读结果，不触发执行。 */
export function formatGpuProbeLines(result: GpuProbeResult | null): string[] {
  if (!result) {
    return ["本会话尚未完成（启动后后台自动执行一次）——纯旁路，不影响播放与本报告其余内容"];
  }
  const line = (label: string, layer: GpuProbeLayer) => `${label} ${layer.ok ? "✓" : "✗"} ${layer.detail}`;
  return [
    line("API 层", result.api),
    line("设备层", result.device),
    line("计算层", result.compute),
    line("视频层", result.video),
  ];
}
