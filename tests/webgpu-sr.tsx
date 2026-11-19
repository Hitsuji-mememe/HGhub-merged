/**
 * WebGPU 超分检证夹具（Muse 2026-11-19，fix2 C；非门禁，证据采集）。
 *
 * ?mode=numeric  GPU（引擎同款 WGSL 模板＋转换权重）vs JS CPU 参考
 *                实现逐像素对照——验证转换器权重布局、mat4 列主序、
 *                pos/neg 激活、残差四件事的数值一致性。
 * ?mode=quality  同源同帧四联屏：原片 720p / 360p 双线性放大 /
 *                现行 WebGL 锐化档（SuperResCanvas crisp 真组件）/
 *                WebGPU 模型超分（真实引擎）。runner 截图后算
 *                PSNR/SSIM（亮度面）并存档 PNG。
 * ?mode=stability 720p 探针片循环驱动引擎 10 分钟，周期采样帧成本
 *                与丢弃数，Device Lost 计数——热稳前置证据（30 分钟
 *                热稳留真机清单）。
 */
import React, { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { RESTORE_PASSES, UPSCALE_PASSES, type SrPass } from "../src/features/playback/anime4kWeights";
import { __test, SR_PRESENT_SHARPEN } from "../src/features/playback/webgpuSr";

/* 呈现 uniform 适配（fin-e2 契约变化）：PRESENT_SHADER 的 uniform 已扩
 * 为 4×vec4（dst/src/RCAS 参数/gateHi），夹具按 natural 档参数写 64B。 */
const PRESENT_UNIFORM_NATURAL = (() => {
  const sp = SR_PRESENT_SHARPEN.natural;
  return new Float32Array([0, 0, 1, 1, 0, 0, 1, 1, sp.coeff, sp.detail, sp.overshoot, sp.gateLo, sp.gateHi, 0, 0, 0]);
})();
import SuperResCanvas from "../src/features/playback/SuperResCanvas";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "numeric";

/* ── CPU 参考实现（与 GLSL 语义逐项对应）────────────────────────── */
type Plane = { w: number; h: number; data: Float32Array };
function sample(plane: Plane, x: number, y: number): [number, number, number, number] {
  const cx = Math.min(plane.w - 1, Math.max(0, x));
  const cy = Math.min(plane.h - 1, Math.max(0, y));
  const i = (cy * plane.w + cx) * 4;
  return [plane.data[i], plane.data[i + 1], plane.data[i + 2], plane.data[i + 3]];
}
function cpuConvPass(input: Map<string, Plane>, pass: Extract<SrPass, { kind: "conv" }>, chainInput: Plane): Plane {
  const { w, h } = chainInput;
  const out: Plane = { w, h, data: new Float32Array(w * h * 4) };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const acc = [...pass.bias];
      for (const t of pass.terms) {
        const src = input.get(t.tex)!;
        let v = sample(src, x + t.dx, y + t.dy);
        if (t.mode === "pos") v = v.map((n) => Math.max(n, 0)) as typeof v;
        else if (t.mode === "neg") v = v.map((n) => Math.max(-n, 0)) as typeof v;
        for (let i = 0; i < 4; i += 1) {
          acc[i] += t.w[0 * 4 + i] * v[0] + t.w[1 * 4 + i] * v[1] + t.w[2 * 4 + i] * v[2] + t.w[3 * 4 + i] * v[3];
        }
      }
      if (pass.residual) {
        const r = sample(chainInput, x, y);
        for (let i = 0; i < 4; i += 1) acc[i] += r[i];
      }
      const o = (y * w + x) * 4;
      for (let i = 0; i < 4; i += 1) out.data[o + i] = acc[i];
    }
  }
  return out;
}
function cpuChain(passes: SrPass[], input: Plane): Plane {
  const tex = new Map<string, Plane>([["MAIN", input]]);
  let current = input;
  for (const pass of passes) {
    if (pass.kind !== "conv") continue;
    current = cpuConvPass(tex, pass, input);
    tex.set(pass.save, current);
  }
  return current;
}

/* ── numeric ─────────────────────────────────────────────────────── */
/* 夹具内 WebGPU 结构类型（仓库未引 @webgpu/types，同 gpuProbe 口径）。 */
type GpuDeviceT = {
  createTexture: (d: Record<string, unknown>) => { createView: () => unknown };
  createBuffer: (d: Record<string, unknown>) => {
    getMappedRange: () => ArrayBuffer;
    unmap: () => void;
    mapAsync: (m: number) => Promise<void>;
  };
  createShaderModule: (d: { code: string }) => unknown;
  createComputePipeline: (d: Record<string, unknown>) => { getBindGroupLayout: (i: number) => unknown };
  createBindGroup: (d: Record<string, unknown>) => unknown;
  createCommandEncoder: () => {
    copyBufferToTexture: (s: Record<string, unknown>, d: Record<string, unknown>, size: number[]) => void;
    copyTextureToBuffer: (s: Record<string, unknown>, d: Record<string, unknown>, size: number[]) => void;
    beginComputePass: () => {
      setPipeline: (p: unknown) => void;
      setBindGroup: (i: number, bg: unknown) => void;
      dispatchWorkgroups: (x: number, y: number) => void;
      end: () => void;
    };
    finish: () => unknown;
  };
  queue: { submit: (c: unknown[]) => void };
};

async function runNumeric() {
  const W = 48;
  const H = 48;
  const input: Plane = { w: W, h: H, data: new Float32Array(W * H * 4) };
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < input.data.length; i += 1) input.data[i] = rand() * 2 - 0.5;
  const expected = cpuChain(RESTORE_PASSES, input);

  const gpu = (navigator as unknown as {
    gpu: { requestAdapter: () => Promise<{ requestDevice: () => Promise<GpuDeviceT> } | null> };
  }).gpu;
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error("no adapter");
  const device = await adapter.requestDevice();
  const usage = 0x04 | 0x08 | 0x02 | 0x01; // TEXTURE_BINDING|STORAGE_BINDING|COPY_DST|COPY_SRC
  /* 数值校验全链用 rgba32float（模板与格式无关，精度更高利于对照；
   * 生产引擎用 rgba16float，格式差异不改变运算结构）。 */
  const makeTex32 = () => device.createTexture({ size: [W, H], format: "rgba32float", usage: usage | 0x10 });
  const tex32 = new Map<string, { createView: () => unknown }>();
  const in32 = makeTex32();
  tex32.set("MAIN", in32);
  const staging = device.createBuffer({ size: input.data.byteLength, usage: 0x02 | 0x04, mappedAtCreation: true });
  new Float32Array(staging.getMappedRange()).set(input.data);
  staging.unmap();
  {
    const enc = device.createCommandEncoder();
    enc.copyBufferToTexture({ buffer: staging, bytesPerRow: W * 16 }, { texture: in32 }, [W, H]);
    device.queue.submit([enc.finish()]);
  }
  for (const pass of RESTORE_PASSES) {
    if (pass.kind !== "conv") continue;
    const outTex = makeTex32();
    tex32.set(pass.save, outTex);
    const inputNames: string[] = [];
    for (const t of pass.terms) if (!inputNames.includes(t.tex)) inputNames.push(t.tex);
    const code = __test.convShader(pass, { withResidual: pass.residual }).replaceAll("rgba16float", "rgba32float");
    const pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: device.createShaderModule({ code }), entryPoint: "main" },
    });
    const entries: { binding: number; resource: unknown }[] = inputNames.map((name, i) => ({
      binding: i,
      resource: tex32.get(name)!.createView(),
    }));
    let next = inputNames.length;
    if (pass.residual) {
      entries.push({ binding: next, resource: in32.createView() });
      next += 1;
    }
    entries.push({ binding: next, resource: outTex.createView() });
    const enc = device.createCommandEncoder();
    const cpass = enc.beginComputePass();
    cpass.setPipeline(pipeline);
    cpass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
    cpass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
    cpass.end();
    device.queue.submit([enc.finish()]);
  }
  const finalTex = tex32.get("MAIN")!;
  const readBuf = device.createBuffer({ size: input.data.byteLength, usage: 0x01 | 0x08 });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: finalTex }, { buffer: readBuf, bytesPerRow: W * 16 }, [W, H]);
  device.queue.submit([enc.finish()]);
  await readBuf.mapAsync(1);
  const got = new Float32Array(readBuf.getMappedRange().slice(0));
  let maxDiff = 0;
  let sumDiff = 0;
  for (let i = 0; i < expected.data.length; i += 1) {
    const d = Math.abs(got[i] - expected.data[i]);
    if (d > maxDiff) maxDiff = d;
    sumDiff += d;
  }
  (window as unknown as { __srNumeric: unknown }).__srNumeric = {
    maxDiff,
    meanDiff: sumDiff / expected.data.length,
    pass: maxDiff < 0.02,
    pixels: W * H,
  };
}

/* ── quality ─────────────────────────────────────────────────────── */
function QualityApp() {
  const webglVideoRef = useRef<HTMLVideoElement | null>(null);
  const gpuVideoRef = useRef<HTMLVideoElement | null>(null);
  const gpuCanvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    const seekAll = async () => {
      const videos = Array.from(document.querySelectorAll("video"));
      await Promise.all(videos.map((v) => new Promise<void>((resolve) => {
        const done = () => resolve();
        if (v.readyState >= 1) done();
        else v.addEventListener("loadedmetadata", done, { once: true });
      })));
      /* 静态场景（单图循环编码）：播放中任意时刻各面板同帧，
       * 截图无需逐帧对齐；WebGL 画布的像素自检也需要播放态帧。 */
      for (const v of videos) {
        v.loop = true;
        await v.play().catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 2600));
      /* WebGPU 面板已隔离到 gpu-only 页（多上下文干扰实测），此处
       * 只管 gt/bilinear/webgl 三面板。 */
      void gpuCanvasRef;
      void gpuVideoRef;
      if (!cancelled) (window as unknown as { __srQualityReady: boolean }).__srQualityReady = true;
    };
    void seekAll();
    return () => { cancelled = true; };
  }, []);
  const panel = { width: 320, height: 180, position: "relative" as const, background: "black" };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "320px", gap: 8, background: "#222" }}>
      <div data-panel="gt" style={panel}>
        <video src="/tests/fixtures-media/master320.mp4" muted playsInline style={{ width: 320, height: 180, objectFit: "contain" }} />
      </div>
      <div data-panel="bilinear" style={panel}>
        <video src="/tests/fixtures-media/src160.mp4" muted playsInline style={{ width: 320, height: 180, objectFit: "contain" }} />
      </div>
      <div data-panel="webgl" style={panel}>
        <video ref={webglVideoRef} src="/tests/fixtures-media/src160.mp4" muted playsInline style={{ width: 320, height: 180, objectFit: "contain" }} />
        <SuperResCanvas videoRef={webglVideoRef} mode="crisp" active ready fit="contain" srcKey="fixture" />
      </div>
    </div>
  );
}

/* ── stability ─────────────────────────────────────────────────────
 * 本机视频摄入两路皆坏（见 gpu-only 注释），稳定性以纹理喂入全链
 * 循环测：每轮 writeTexture 同一帧（720p 探针片首帧像素）→ 摄入趟
 * → Restore → Upscale → D2S → 呈现到离屏目标，10 分钟内记每轮
 * 成本与 device lost 次数。测的是计算管线的长稳（热稳含摄入的
 * 部分留真机 30 分钟清单）。 */
async function runStability() {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.src = "/probe/sr-720p.mp4";
  document.body.appendChild(video);
  await video.play().catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  const W = 1280;
  const H = 720;
  const grab = document.createElement("canvas");
  grab.width = W;
  grab.height = H;
  const gctx = grab.getContext("2d");
  if (!gctx) return;
  gctx.drawImage(video, 0, 0, W, H);
  const pixels = gctx.getImageData(0, 0, W, H);
  video.pause();
  video.remove();

  const nav = navigator as unknown as {
    gpu: {
      requestAdapter: () => Promise<{ requestDevice: () => Promise<GpuDeviceFull> } | null>;
      getPreferredCanvasFormat: () => string;
    };
  };
  const adapter = await nav.gpu.requestAdapter();
  if (!adapter) {
    (window as unknown as { __srStability: unknown }).__srStability = { samples: [], done: true, error: "no adapter" };
    return;
  }
  const device = await adapter.requestDevice();
  let lost = 0;
  const devLost = (device as unknown as { lost: Promise<unknown> }).lost;
  void devLost.then(() => { lost += 1; });
  const format = nav.gpu.getPreferredCanvasFormat();
  const F = 0x04 | 0x08;
  const staging = device.createTexture({ size: [W, H], format: "rgba8unorm", usage: F | 0x02 });
  const ingest = device.createTexture({ size: [W, H], format: "rgba16float", usage: F });
  const ingestPipe = device.createComputePipeline({
    layout: "auto",
    compute: { module: device.createShaderModule({ code: __test.INGEST_SHADER_TEXTURE }), entryPoint: "main" },
  });
  const buildPasses = (passes: SrPass[]) => passes.filter((p): p is Extract<SrPass, { kind: "conv" }> => p.kind === "conv").map((pass) => ({
    pass,
    pipeline: device.createComputePipeline({
      layout: "auto",
      compute: { module: device.createShaderModule({ code: __test.convShader(pass, { withResidual: pass.residual }) }), entryPoint: "main" },
    }),
  }));
  const restorePipes = buildPasses(RESTORE_PASSES);
  const upscalePipes = buildPasses(UPSCALE_PASSES);
  const d2sPipe = device.createComputePipeline({
    layout: "auto",
    compute: { module: device.createShaderModule({ code: __test.D2S_SHADER }), entryPoint: "main" },
  });
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  const target = device.createTexture({ size: [W * 2, H * 2], format, usage: 0x10 | 0x01 });
  const uniform = device.createBuffer({ size: 64, usage: 0x40 | 0x08 });
  device.queue.writeBuffer(uniform, 0, PRESENT_UNIFORM_NATURAL.buffer as ArrayBuffer);
  const presentModule = device.createShaderModule({ code: __test.PRESENT_SHADER });
  const presentPipe = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: presentModule, entryPoint: "vs" },
    fragment: { module: presentModule, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  const chainTex = new Map<string, ReturnType<typeof device.createTexture>>();
  const mkChainTex = () => device.createTexture({ size: [W, H], format: "rgba16float", usage: F });
  for (const { pass } of [...restorePipes, ...upscalePipes]) chainTex.set(pass.save, mkChainTex());
  const out2x = device.createTexture({ size: [W * 2, H * 2], format: "rgba8unorm", usage: F });

  const samples: { t: number; frames: number; lastMs: number; avgMs: number; lost: number }[] = [];
  (window as unknown as { __srStability: unknown }).__srStability = { samples, done: false };
  const costs: number[] = [];
  let frames = 0;
  const started = performance.now();
  const runFrame = async () => {
    const t0 = performance.now();
    device.queue.writeTexture({ texture: staging }, pixels.data, { bytesPerRow: W * 4, rowsPerImage: H }, [W, H]);
    const enc = device.createCommandEncoder();
    const dispatch = (
      pipeline: { getBindGroupLayout: (i: number) => unknown },
      entries: { binding: number; resource: unknown }[],
      w: number,
      h: number,
    ) => {
      const cp = enc.beginComputePass();
      cp.setPipeline(pipeline);
      cp.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
      cp.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
      cp.end();
    };
    dispatch(ingestPipe, [
      { binding: 0, resource: staging.createView() },
      { binding: 1, resource: ingest.createView() },
    ], W, H);
    const runChain = (pipes: typeof restorePipes, chainInput: ReturnType<typeof device.createTexture>, prefix: string) => {
      let last = chainInput;
      for (const { pass, pipeline } of pipes) {
        const outTex = chainTex.get(pass.save)!;
        const inputNames: string[] = [];
        for (const t of pass.terms) if (!inputNames.includes(t.tex)) inputNames.push(t.tex);
        const entries: { binding: number; resource: unknown }[] = inputNames.map((name, j) => ({
          binding: j,
          resource: (name === "MAIN" ? chainInput : chainTex.get(name)!).createView(),
        }));
        let next = inputNames.length;
        if (pass.residual) {
          entries.push({ binding: next, resource: chainInput.createView() });
          next += 1;
        }
        entries.push({ binding: next, resource: outTex.createView() });
        dispatch(pipeline, entries, W, H);
        last = outTex;
        void prefix;
      }
      return last;
    };
    const restored = runChain(restorePipes, ingest, "r");
    const lastUp = runChain(upscalePipes, restored, "u");
    dispatch(d2sPipe, [
      { binding: 0, resource: lastUp.createView() },
      { binding: 1, resource: restored.createView() },
      { binding: 2, resource: sampler },
      { binding: 3, resource: out2x.createView() },
    ], W * 2, H * 2);
    const rpass = enc.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" }],
    });
    rpass.setPipeline(presentPipe);
    rpass.setBindGroup(0, device.createBindGroup({
      layout: presentPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: out2x.createView() },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: uniform } },
      ],
    }));
    rpass.draw(3);
    rpass.end();
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    costs.push(performance.now() - t0);
    frames += 1;
  };
  let lastSample = 0;
  while (performance.now() - started < 600_000 && lost === 0) {
    await runFrame();
    const elapsed = performance.now() - started;
    if (elapsed - lastSample >= 30_000 || frames === 1) {
      lastSample = elapsed;
      const avg = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 0;
      samples.push({
        t: Math.round(elapsed / 1000),
        frames,
        lastMs: Math.round(costs[costs.length - 1] * 10) / 10,
        avgMs: Math.round(avg * 10) / 10,
        lost,
      });
    }
  }
  (window as unknown as { __srStability: { samples: unknown[]; done: boolean } }).__srStability.done = true;
}

/* gpu-only 用的完整结构类型（夹具内）。 */
type GpuPassEncoder = {
  setPipeline: (p: unknown) => void;
  setBindGroup: (i: number, bg: unknown) => void;
  dispatchWorkgroups: (x: number, y: number) => void;
  draw: (n: number) => void;
  end: () => void;
};
type GpuEncoderFull = {
  beginComputePass: () => GpuPassEncoder;
  beginRenderPass: (d: Record<string, unknown>) => GpuPassEncoder;
  copyTextureToBuffer: (s: Record<string, unknown>, d: Record<string, unknown>, size: number[]) => void;
  finish: () => unknown;
};
type GpuDeviceFull = {
  createTexture: (d: Record<string, unknown>) => { createView: () => unknown };
  createBuffer: (d: Record<string, unknown>) => { mapAsync: (m: number) => Promise<void>; getMappedRange: () => ArrayBuffer; unmap: () => void };
  createSampler: (d: Record<string, unknown>) => unknown;
  createShaderModule: (d: { code: string }) => unknown;
  createComputePipeline: (d: Record<string, unknown>) => { getBindGroupLayout: (i: number) => unknown };
  createRenderPipeline: (d: Record<string, unknown>) => { getBindGroupLayout: (i: number) => unknown };
  createBindGroup: (d: Record<string, unknown>) => unknown;
  createCommandEncoder: () => GpuEncoderFull;
  queue: {
    submit: (c: unknown[]) => void;
    onSubmittedWorkDone: () => Promise<void>;
    writeTexture: (dst: Record<string, unknown>, data: Uint8ClampedArray, layout: Record<string, unknown>, size: number[]) => void;
    writeBuffer: (b: unknown, offset: number, data: ArrayBuffer) => void;
  };
};

/* gpu-only：WebGPU 面板单独成页。本机 Chromium（Dawn/SwiftShader）
 * 的视频摄入两路皆坏（copyExternalImageToTexture 杀 GPU 进程、
 * importExternalTexture 拒绝视频帧）且画布交换链呈现亦杀实例——
 * 均为本机软件栈缺陷（计算管线本身经 numeric/分步实测全通）。
 * 故本页从 2D 画布取得同一帧像素、writeTexture 喂入引擎同款
 * WGSL 全链（摄入趟＋Restore＋Upscale＋D2S＋呈现着色器，权重与
 * 模板与生产引擎同一份代码），读回离屏目标截图。被环境替换掉的
 * 只有「视频→纹理」摄入一步与浏览器交换链，报告如实标注。 */
function GpuOnlyApp() {
  const gpuVideoRef = useRef<HTMLVideoElement | null>(null);
  const gpuCanvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const video = gpuVideoRef.current;
      const canvas = gpuCanvasRef.current;
      if (!video || !canvas) return;
      const W = 160;
      const H = 90;
      video.loop = true;
      await video.play().catch(() => {});
      await new Promise((r) => setTimeout(r, 600));
      /* 同帧像素：2D 画布抓当前帧（静态场景，时刻不敏感）。 */
      const grab = document.createElement("canvas");
      grab.width = W;
      grab.height = H;
      const gctx = grab.getContext("2d");
      if (!gctx) return;
      gctx.drawImage(video, 0, 0, W, H);
      const pixels = gctx.getImageData(0, 0, W, H);
      video.pause();

      const nav = navigator as unknown as {
        gpu: {
          requestAdapter: () => Promise<{ requestDevice: () => Promise<GpuDeviceFull> } | null>;
          getPreferredCanvasFormat: () => string;
        };
      };
      const adapter = await nav.gpu.requestAdapter();
      if (!adapter) return;
      const device = await adapter.requestDevice();
      const format = nav.gpu.getPreferredCanvasFormat();
      const F = 0x04 | 0x08; // TEXTURE_BINDING|STORAGE_BINDING
      const stageTimings: Record<string, number> = {};
      const submitAndTime = async (label: string, enc: { finish: () => unknown }) => {
        const t0 = performance.now();
        device.queue.submit([enc.finish()]);
        await device.queue.onSubmittedWorkDone();
        stageTimings[label] = Math.round((performance.now() - t0) * 10) / 10;
      };
      /* 摄入：writeTexture → staging(rgba8) → 摄入趟 → ingest(rgba16f) */
      const staging = device.createTexture({ size: [W, H], format: "rgba8unorm", usage: F | 0x02 });
      device.queue.writeTexture(
        { texture: staging },
        pixels.data,
        { bytesPerRow: W * 4, rowsPerImage: H },
        [W, H],
      );
      const ingest = device.createTexture({ size: [W, H], format: "rgba16float", usage: F });
      {
        const enc = device.createCommandEncoder();
        const pipe = device.createComputePipeline({
          layout: "auto",
          compute: { module: device.createShaderModule({ code: __test.INGEST_SHADER_TEXTURE }), entryPoint: "main" },
        });
        const cp = enc.beginComputePass();
        cp.setPipeline(pipe);
        cp.setBindGroup(0, device.createBindGroup({
          layout: pipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: staging.createView() },
            { binding: 1, resource: ingest.createView() },
          ],
        }));
        cp.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
        cp.end();
        await submitAndTime("ingest", enc);
      }
      const texMap = new Map<string, ReturnType<typeof device.createTexture>>();
      const runPass = (
        enc: ReturnType<typeof device.createCommandEncoder>,
        pass: Extract<SrPass, { kind: "conv" }>,
        chainInput: ReturnType<typeof device.createTexture>,
      ) => {
        const outTex = device.createTexture({ size: [W, H], format: "rgba16float", usage: F });
        texMap.set(pass.save, outTex);
        const inputNames: string[] = [];
        for (const t of pass.terms) if (!inputNames.includes(t.tex)) inputNames.push(t.tex);
        const pipeline = device.createComputePipeline({
          layout: "auto",
          compute: { module: device.createShaderModule({ code: __test.convShader(pass, { withResidual: pass.residual }) }), entryPoint: "main" },
        });
        const entries: { binding: number; resource: unknown }[] = inputNames.map((name, j) => ({
          binding: j,
          resource: (name === "MAIN" ? chainInput : texMap.get(name)!).createView(),
        }));
        let next = inputNames.length;
        if (pass.residual) {
          entries.push({ binding: next, resource: chainInput.createView() });
          next += 1;
        }
        entries.push({ binding: next, resource: outTex.createView() });
        const cp = enc.beginComputePass();
        cp.setPipeline(pipeline);
        cp.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
        cp.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
        cp.end();
        return outTex;
      };
      let restored = ingest;
      {
        const enc = device.createCommandEncoder();
        for (const pass of RESTORE_PASSES) {
          if (pass.kind !== "conv") continue;
          restored = runPass(enc, pass, ingest);
        }
        texMap.clear();
        await submitAndTime("restore", enc);
      }
      let lastTex = restored;
      {
        const enc = device.createCommandEncoder();
        for (const pass of UPSCALE_PASSES) {
          if (pass.kind !== "conv") continue;
          lastTex = runPass(enc, pass, restored);
        }
        const out2x = device.createTexture({ size: [W * 2, H * 2], format: "rgba8unorm", usage: F });
        const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
        const d2sPipe = device.createComputePipeline({
          layout: "auto",
          compute: { module: device.createShaderModule({ code: __test.D2S_SHADER }), entryPoint: "main" },
        });
        const cp = enc.beginComputePass();
        cp.setPipeline(d2sPipe);
        cp.setBindGroup(0, device.createBindGroup({
          layout: d2sPipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: lastTex.createView() },
            { binding: 1, resource: restored.createView() },
            { binding: 2, resource: sampler },
            { binding: 3, resource: out2x.createView() },
          ],
        }));
        cp.dispatchWorkgroups(Math.ceil((W * 2) / 8), Math.ceil((H * 2) / 8));
        cp.end();
        await submitAndTime("upscale+d2s", enc);
        /* 呈现：引擎同款 PRESENT_SHADER → 离屏目标 → 读回。 */
        const target = device.createTexture({ size: [W * 2, H * 2], format, usage: 0x10 | 0x01 });
        const uniform = device.createBuffer({ size: 64, usage: 0x40 | 0x08 });
        device.queue.writeBuffer(uniform, 0, PRESENT_UNIFORM_NATURAL.buffer as ArrayBuffer);
        const module = device.createShaderModule({ code: __test.PRESENT_SHADER });
        const rp = device.createRenderPipeline({
          layout: "auto",
          vertex: { module, entryPoint: "vs" },
          fragment: { module, entryPoint: "fs", targets: [{ format }] },
          primitive: { topology: "triangle-list" },
        });
        const enc2 = device.createCommandEncoder();
        const rpass = enc2.beginRenderPass({
          colorAttachments: [{ view: target.createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" }],
        });
        rpass.setPipeline(rp);
        rpass.setBindGroup(0, device.createBindGroup({
          layout: rp.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: out2x.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: uniform } },
          ],
        }));
        rpass.draw(3);
        rpass.end();
        await submitAndTime("present", enc2);
        const bytesPerRow = W * 2 * 4;
        const buf = device.createBuffer({ size: bytesPerRow * H * 2, usage: 0x01 | 0x08 });
        const enc3 = device.createCommandEncoder();
        enc3.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow }, [W * 2, H * 2]);
        device.queue.submit([enc3.finish()]);
        await buf.mapAsync(1);
        const raw = new Uint8Array(buf.getMappedRange().slice(0));
        buf.unmap();
        canvas.width = W * 2;
        canvas.height = H * 2;
        const ctx2d = canvas.getContext("2d");
        if (ctx2d) {
          const img = ctx2d.createImageData(W * 2, H * 2);
          const isBgra = format.startsWith("bgra");
          for (let i = 0; i < raw.length; i += 4) {
            img.data[i] = isBgra ? raw[i + 2] : raw[i];
            img.data[i + 1] = raw[i + 1];
            img.data[i + 2] = isBgra ? raw[i] : raw[i + 2];
            img.data[i + 3] = 255;
          }
          ctx2d.putImageData(img, 0, 0);
        }
      }
      (window as unknown as { __srGpuStats: unknown }).__srGpuStats = { stageTimings, format };
      if (!cancelled) (window as unknown as { __srQualityReady: boolean }).__srQualityReady = true;
    };
    void run();
    return () => { cancelled = true; };
  }, []);
  return (
    <div data-panel="webgpu" style={{ width: 320, height: 180, position: "relative", background: "black" }}>
      <video ref={gpuVideoRef} src="/tests/fixtures-media/src160.mp4" muted playsInline style={{ width: 320, height: 180, objectFit: "contain", visibility: "hidden" }} />
      <canvas ref={gpuCanvasRef} style={{ width: 320, height: 180, position: "absolute", inset: 0 }} />
    </div>
  );
}

if (mode === "numeric") {
  void runNumeric().catch((e) => {
    (window as unknown as { __srNumeric: unknown }).__srNumeric = { error: String(e), pass: false };
  });
} else if (mode === "stability") {
  void runStability();
} else if (mode === "gpu-only") {
  createRoot(document.getElementById("root")!).render(<GpuOnlyApp />);
} else {
  createRoot(document.getElementById("root")!).render(<QualityApp />);
}
