/**
 * WebGPU 模型超分引擎（Muse 2026-11-19，fix2 超分换代正式线）。
 *
 * 管线 = Anime4K CNN（S 档，MIT，bloc97）：Restore_CNN_Soft（同分辨率
 * 残差修复 4 趟）→ Upscale_CNN_x2（4 趟卷积＋Depth-to-Space，输出 2x）。
 * 权重由 scripts/convert-anime4k.mjs 从 GLSL 原文机械转换
 * （anime4kWeights.ts），WGSL 以同列主序 mat4x4 乘法重放，数值路径
 * 与 mpv GLSL 一致；数值正确性由 tests/webgpu-sr 夹具对 CPU 参考
 * 实现逐像素校验（门限见夹具）。
 *
 * GPT 探针六坑逐项处置：
 *  ① 色彩空间：不做线性化——Anime4K 在 mpv 中同样直接处理编码值，
 *     本引擎 ingest（copyExternalImageToTexture 默认 srgb / 外部纹理
 *     原值）与呈现（canvas 默认 srgb）全程编码空间，与参考实现一致。
 *  ② 纹理拷贝成本：双摄入路径（importExternalTexture 零拷贝 /
 *     copyExternalImageToTexture 拷贝）由探针 v2 实测择优，运行时
 *     按探针结论选路；拷贝路是外部纹理不可用时的兜底。
 *  ③ 帧调度：一次只处理一帧，在飞帧未完成时新帧直接丢弃（丢弃
 *     过期帧，绝不排队积压）；丢弃计数进 stats 供诊断。
 *  ④ Device Lost：device.lost 触发即整引擎作废并回调上层回退
 *     WebGL 锐化管线，本会话不再重试 WebGPU。
 *  ⑤ 热降频：帧成本 EMA/P90 持续超预算（源帧间隔）→ 先降为只跑
 *     Restore 不上采样（输出 1x 呈现），仍超标 → 停引擎回退锐化档。
 *  ⑥ 内容适配：Anime4K 为动漫线条优化；真人源走同一管线属其已知
 *     弱项（Restore_Soft 为最温和档），采纳与否由同帧对比证据裁定，
 *     不在此处预设。
 *
 * 旁路纪律：引擎只被 WebGpuSrCanvas 在「探针 v2 门全过」时挂载；
 * 任何初始化失败返回 null，调用方回退现行 SuperResCanvas，两条
 * 管线永不同时呈现（不叠加）。
 */

import { RESTORE_PASSES, UPSCALE_PASSES, type SrPass } from "./anime4kWeights";

/* 本仓未引入 @webgpu/types：按 API 现状取最小结构子集（同 gpuProbe 口径）。 */
type GpuTextureLike = {
  createView: () => unknown;
  destroy?: () => void;
};
type GpuDeviceLike = {
  createTexture: (desc: Record<string, unknown>) => GpuTextureLike;
  createShaderModule: (desc: { code: string }) => unknown;
  createComputePipeline: (desc: Record<string, unknown>) => { getBindGroupLayout: (i: number) => unknown };
  createRenderPipeline?: (desc: Record<string, unknown>) => { getBindGroupLayout: (i: number) => unknown };
  createBindGroup: (desc: Record<string, unknown>) => unknown;
  createBuffer: (desc: { size: number; usage: number }) => unknown;
  createCommandEncoder: () => GpuEncoderLike;
  createSampler: (desc: Record<string, unknown>) => unknown;
  queue: {
    submit: (cmds: unknown[]) => void;
    onSubmittedWorkDone: () => Promise<void>;
    writeBuffer?: (buffer: unknown, offset: number, data: ArrayBuffer) => void;
    copyExternalImageToTexture?: (src: Record<string, unknown>, dst: Record<string, unknown>, size: number[]) => void;
  };
  importExternalTexture?: (desc: { source: HTMLVideoElement }) => unknown;
  lost: Promise<{ reason?: string; message?: string }>;
  addEventListener?: (type: string, cb: (e: { error?: { message?: string } }) => void) => void;
  destroy?: () => void;
};
type GpuEncoderLike = {
  beginComputePass: () => {
    setPipeline: (p: unknown) => void;
    setBindGroup: (i: number, bg: unknown) => void;
    dispatchWorkgroups: (x: number, y: number) => void;
    end: () => void;
  };
  beginRenderPass: (desc: Record<string, unknown>) => {
    setPipeline: (p: unknown) => void;
    setBindGroup: (i: number, bg: unknown) => void;
    draw: (n: number) => void;
    end: () => void;
  };
  finish: () => unknown;
};
type GpuCanvasContextLike = {
  configure: (desc: Record<string, unknown>) => void;
  getCurrentTexture: () => GpuTextureLike;
};

export type SrIngestPath = "external" | "copy";
export type SrEngineStats = {
  frames: number;
  droppedStale: number;
  costAvgMs: number;
  costP90Ms: number;
  path: SrIngestPath;
  /** 当前降级级：0=全链 2x、1=仅 Restore 1x、2=已停（回退锐化）。 */
  degrade: 0 | 1 | 2;
  /** 最近一次致死错误（lost/未捕获错误）摘要，供诊断报告引用。 */
  lastError: string | null;
};

const GPU_TEXTURE_USAGE = { TEXTURE_BINDING: 0x04, STORAGE_BINDING: 0x08, COPY_DST: 0x02, RENDER_ATTACHMENT: 0x10 } as const;

function convShader(pass: Extract<SrPass, { kind: "conv" }>, opts: { withResidual: boolean }): string {
  const inputTexNames: string[] = [];
  for (const t of pass.terms) if (!inputTexNames.includes(t.tex)) inputTexNames.push(t.tex);
  const decls: string[] = [];
  let binding = 0;
  const bindingOf = new Map<string, number>();
  for (const name of inputTexNames) {
    decls.push(`@group(0) @binding(${binding}) var inTex${binding}: texture_2d<f32>;`);
    bindingOf.set(name, binding);
    binding += 1;
  }
  let residualBinding = -1;
  if (opts.withResidual) {
    residualBinding = binding;
    decls.push(`@group(0) @binding(${binding}) var residualTex: texture_2d<f32>;`);
    binding += 1;
  }
  const outBinding = binding;
  decls.push(`@group(0) @binding(${outBinding}) var outTex: texture_storage_2d<rgba16float, write>;`);
  const loadExpr = (texName: string, dx: number, dy: number, mode: string) => {
    const b = bindingOf.get(texName)!;
    const base = `textureLoad(inTex${b}, clamp(p + vec2<i32>(${dx}, ${dy}), vec2<i32>(0), dims${b} - vec2<i32>(1)), 0)`;
    if (mode === "pos") return `max(${base}, vec4<f32>(0.0))`;
    if (mode === "neg") return `max(-(${base}), vec4<f32>(0.0))`;
    return base;
  };
  const dimsDecls = inputTexNames.map((_, i) => `  let dims${i} = vec2<i32>(textureDimensions(inTex${i}));`).join("\n");
  const terms = pass.terms.map((t) => {
    const w = t.w.map((n) => `${n}`).join(", ");
    return `  acc += mat4x4<f32>(${w}) * ${loadExpr(t.tex, t.dx, t.dy, t.mode)};`;
  }).join("\n");
  return `
${decls.join("\n")}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let outDims = vec2<i32>(textureDimensions(outTex));
  if (i32(gid.x) >= outDims.x || i32(gid.y) >= outDims.y) { return; }
  let p = vec2<i32>(i32(gid.x), i32(gid.y));
${dimsDecls}
  var acc = vec4<f32>(${pass.bias.map((n) => `${n}`).join(", ")});
${terms}
${opts.withResidual ? "  acc += textureLoad(residualTex, clamp(p, vec2<i32>(0), vec2<i32>(textureDimensions(residualTex)) - vec2<i32>(1)), 0);" : ""}
  textureStore(outTex, p, acc);
}`;
}

/* 摄入拷贝趟：把视频帧（外部纹理或 copyExternalImageToTexture 的
 * staging 纹理）统一落成 rgba16float 的 ingest 纹理，之后全链只读
 * 普通纹理——残差趟需要链首原帧纹理，外部纹理无法以 texture_2d
 * 形态重绑，故必须先落地。这趟拷贝的成本正是探针 v2 要量的
 * 「纹理拷贝成本」（六坑②）。 */
const INGEST_SHADER_EXTERNAL = `
@group(0) @binding(0) var srcTex: texture_external;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = vec2<i32>(textureDimensions(outTex));
  if (i32(gid.x) >= dims.x || i32(gid.y) >= dims.y) { return; }
  let p = vec2<i32>(i32(gid.x), i32(gid.y));
  textureStore(outTex, p, textureLoad(srcTex, p));
}`;
const INGEST_SHADER_TEXTURE = `
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = vec2<i32>(textureDimensions(outTex));
  if (i32(gid.x) >= dims.x || i32(gid.y) >= dims.y) { return; }
  let p = vec2<i32>(i32(gid.x), i32(gid.y));
  textureStore(outTex, p, textureLoad(srcTex, p, 0));
}`;

const D2S_SHADER = `
@group(0) @binding(0) var lastTex: texture_2d<f32>;
@group(0) @binding(1) var baseTex: texture_2d<f32>;
@group(0) @binding(2) var baseSampler: sampler;
@group(0) @binding(3) var outTex: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let outDims = vec2<i32>(textureDimensions(outTex));
  if (i32(gid.x) >= outDims.x || i32(gid.y) >= outDims.y) { return; }
  let p = vec2<i32>(i32(gid.x), i32(gid.y));
  let srcP = p / vec2<i32>(2);
  let sub = p - srcP * vec2<i32>(2);
  let detail4 = textureLoad(lastTex, srcP, 0);
  let detail = detail4[sub.y * 2 + sub.x];
  let uv = (vec2<f32>(f32(gid.x), f32(gid.y)) + vec2<f32>(0.5)) / vec2<f32>(f32(outDims.x), f32(outDims.y));
  let base = textureSampleLevel(baseTex, baseSampler, uv, 0.0);
  textureStore(outTex, p, vec4<f32>(base.rgb + detail, 1.0));
}`;

/* 呈现矩形：dst=画布内的内容矩形（UV，contain 时即 srContentRect，
 * 矩形外填黑，与 <video> 的 object-contain 黑边一致）；src=源内的
 * 采样矩形（cover 时为居中裁切窗，与 object-cover 一致）。 */
const PRESENT_SHADER = `
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> rects: array<vec4<f32>, 2>;
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  var out: VsOut;
  let xy = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  out.uv = vec2<f32>(xy.x, 1.0 - xy.y);
  out.pos = vec4<f32>(xy * 2.0 - 1.0, 0.0, 1.0);
  return out;
}
@fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let dst = rects[0];
  let src = rects[1];
  let inside = in.uv.x >= dst.x && in.uv.x <= dst.x + dst.z && in.uv.y >= dst.y && in.uv.y <= dst.y + dst.w;
  /* textureSample 必须在均匀控制流调用（隐式导数）：无条件采样，
   * 矩形外用 select 填黑，不许 if 内提前 return 包住采样。 */
  let localUv = clamp((in.uv - dst.xy) / dst.zw, vec2<f32>(0.0), vec2<f32>(1.0));
  let sampled = textureSample(srcTex, srcSampler, src.xy + localUv * src.zw);
  return select(vec4<f32>(0.0, 0.0, 0.0, 1.0), sampled, inside);
}`;

type ChainPass = {
  pass: SrPass;
  pipeline: { getBindGroupLayout: (i: number) => unknown };
  inputTexNames: string[];
};

/* 夹具专用导出（tests/webgpu-sr 数值校验）：让校验页用与引擎完全
 * 相同的 WGSL 模板驱动 GPU，与 CPU 参考实现逐像素对照。生产路径
 * 不引用此导出。 */
export const __test = { convShader, D2S_SHADER, INGEST_SHADER_TEXTURE, PRESENT_SHADER };

export class WebGpuSrEngine {
  private device: GpuDeviceLike;
  private ctx: GpuCanvasContextLike;
  private canvasFormat: string;
  private path: SrIngestPath;
  private onLost: () => void;
  private textures = new Map<string, GpuTextureLike>();
  private restoreChain: ChainPass[] = [];
  private upscaleChain: ChainPass[] = [];
  private ingestPipeline: { getBindGroupLayout: (i: number) => unknown } | null = null;
  private d2s: { pipeline: { getBindGroupLayout: (i: number) => unknown } } | null = null;
  private presentPipeline: { getBindGroupLayout: (i: number) => unknown } | null = null;
  private presentUniform: unknown = null;
  private sampler: unknown;
  private w = 0;
  private h = 0;
  private inFlight = false;
  private dead = false;
  private lastError: string | null = null;
  private stats = { frames: 0, droppedStale: 0, costs: [] as number[], degrade: 0 as 0 | 1 | 2 };
  private overStreak = 0;

  private constructor(device: GpuDeviceLike, ctx: GpuCanvasContextLike, format: string, path: SrIngestPath, onLost: () => void) {
    this.device = device;
    this.ctx = ctx;
    this.canvasFormat = format;
    this.path = path;
    this.onLost = onLost;
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    /* 呈现矩形 uniform：2×vec4（dst/src），UNIFORM=0x40 | COPY_DST=0x08。 */
    this.presentUniform = device.createBuffer({ size: 32, usage: 0x40 | 0x08 });
    void device.lost.then((info) => {
      this.failFatally(`device lost: ${info?.reason ?? "?"} ${info?.message ?? ""}`);
    });
    /* 本引擎独占该 device：任何未捕获的校验/带外错误都说明管线状态
     * 不可信（如摄入拷贝被拒），按死亡处理回退锐化档，不带病呈现。 */
    try {
      device.addEventListener?.("uncapturederror", (e) => {
        this.failFatally(`uncaptured: ${e?.error?.message ?? "?"}`);
      });
    } catch { /* 老实现无此事件：靠 lost 与成本门兜底 */ }
  }

  /* 统一死亡处理（fix2.1 批二#6）：device lost / 未捕获错误 /
   * processFrame 同步异常 / 成本降级到停，四条致死路径收敛到同一
   * 出口——dead 置位、degrade=2、lastError 记录、onLost 只回调一次。
   * 旧实现 processFrame 的 catch 只复位 inFlight，同步异常（如
   * ensureTextures 建纹理失败）不置 dead、不回调，上层永远等不到
   * 回退信号，与引擎头注的死亡承诺不符。destroy() 先置 dead，
   * 故销毁后的 lost 不会误报 onLost。 */
  private failFatally(reason: string) {
    if (this.dead) return;
    this.dead = true;
    this.stats.degrade = 2;
    this.lastError = reason.slice(0, 200);
    try { this.onLost(); } catch { /* 上层回调异常不外溢 */ }
  }

  static async create(canvas: HTMLCanvasElement, opts: { path: SrIngestPath; onLost: () => void }): Promise<WebGpuSrEngine | null> {
    /* device 一旦建成，后续任何失败（ctx 为 null、configure/构造/
     * buildPipelines 抛错）都必须先 destroy 再返回 null（fix2.1
     * 批二#7）：旧实现两条早退路径漏销毁，失败重试会漏出 GPU 设备。 */
    let device: GpuDeviceLike | null = null;
    try {
      const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<{ requestDevice: () => Promise<GpuDeviceLike> } | null>; getPreferredCanvasFormat: () => string } }).gpu;
      if (!gpu) return null;
      const adapter = await gpu.requestAdapter();
      if (!adapter) return null;
      device = await adapter.requestDevice();
      const ctx = (canvas.getContext("webgpu") as unknown as GpuCanvasContextLike | null);
      if (!ctx) {
        try { device.destroy?.(); } catch { /* 忽略 */ }
        return null;
      }
      const format = gpu.getPreferredCanvasFormat();
      ctx.configure({ device, format, alphaMode: "opaque" });
      const engine = new WebGpuSrEngine(device, ctx, format, opts.path, opts.onLost);
      engine.buildPipelines();
      return engine;
    } catch {
      try { device?.destroy?.(); } catch { /* 忽略 */ }
      return null;
    }
  }

  private buildPipelines() {
    const build = (passes: SrPass[]): ChainPass[] => {
      const out: ChainPass[] = [];
      for (const pass of passes) {
        if (pass.kind === "d2s") continue;
        const inputTexNames: string[] = [];
        for (const t of pass.terms) if (!inputTexNames.includes(t.tex)) inputTexNames.push(t.tex);
        const code = convShader(pass, { withResidual: pass.residual });
        const module = this.device.createShaderModule({ code });
        const pipeline = this.device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
        out.push({ pass, pipeline, inputTexNames });
      }
      return out;
    };
    this.restoreChain = build(RESTORE_PASSES);
    this.upscaleChain = build(UPSCALE_PASSES);
    const ingestModule = this.device.createShaderModule({
      code: this.path === "external" ? INGEST_SHADER_EXTERNAL : INGEST_SHADER_TEXTURE,
    });
    this.ingestPipeline = this.device.createComputePipeline({ layout: "auto", compute: { module: ingestModule, entryPoint: "main" } });
    const d2sModule = this.device.createShaderModule({ code: D2S_SHADER });
    this.d2s = { pipeline: this.device.createComputePipeline({ layout: "auto", compute: { module: d2sModule, entryPoint: "main" } }) };
    if (this.device.createRenderPipeline) {
      const module = this.device.createShaderModule({ code: PRESENT_SHADER });
      this.presentPipeline = this.device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format: this.canvasFormat }] },
        primitive: { topology: "triangle-list" },
      });
    }
  }

  private makeTex(key: string, w: number, h: number, format: string, usage: number) {
    const old = this.textures.get(key);
    try { old?.destroy?.(); } catch { /* 忽略 */ }
    const tex = this.device.createTexture({ size: [w, h], format, usage });
    this.textures.set(key, tex);
    return tex;
  }

  private ensureTextures(w: number, h: number) {
    if (this.w === w && this.h === h) return;
    this.w = w;
    this.h = h;
    const F = GPU_TEXTURE_USAGE.TEXTURE_BINDING | GPU_TEXTURE_USAGE.STORAGE_BINDING;
    this.makeTex("ingest", w, h, "rgba16float", F);
    /* staging 必须带 RENDER_ATTACHMENT：Dawn 对 copyExternalImageToTexture
     * 的目标纹理要求 CopyDst＋RenderAttachment，缺了拷贝被校验拒绝、
     * ingest 读到空纹理（夹具实测，2026-11-19）。 */
    this.makeTex("staging", w, h, "rgba8unorm", GPU_TEXTURE_USAGE.TEXTURE_BINDING | GPU_TEXTURE_USAGE.COPY_DST | GPU_TEXTURE_USAGE.RENDER_ATTACHMENT);
    for (const p of RESTORE_PASSES) if (p.kind === "conv") this.makeTex(`r:${p.save}`, w, h, "rgba16float", F);
    for (const p of UPSCALE_PASSES) if (p.kind === "conv") this.makeTex(`u:${p.save}`, w, h, "rgba16float", F);
    this.makeTex("out2x", w * 2, h * 2, "rgba8unorm", F);
  }

  private texFor(chain: "r" | "u", name: string, chainInput: GpuTextureLike): GpuTextureLike {
    if (name === "MAIN") return chain === "r" ? chainInput : this.textures.get("r:MAIN")!;
    return this.textures.get(`${chain}:${name}`)!;
  }

  /**
   * 处理一帧。返回 false = 本帧被丢弃（在飞/已停/尺寸未就绪）。
   * frameIntervalMs 为源帧间隔（预算），未知传 0（不做降级判定）。
   * presentRects = 呈现矩形（UV）：dst 画布内容矩形、src 源采样窗；
   * 缺省全幅（夹具/探针用）。
   */
  processFrame(
    video: HTMLVideoElement,
    frameIntervalMs: number,
    presentRects?: { dst: [number, number, number, number]; src: [number, number, number, number] },
  ): boolean {
    if (this.dead || this.stats.degrade === 2) return false;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h || video.readyState < 2) return false;
    if (this.inFlight) {
      this.stats.droppedStale += 1;
      return false;
    }
    const device = this.device;
    const t0 = performance.now();
    try {
      /* ensureTextures 必须在 try 内（fix2.1 批二#6）：建纹理是同步
       * GPU 调用，失败属不可恢复——旧实现把它放在 try 外，异常直接
       * 冒泡出 processFrame、引擎不死不回退、调用方帧循环还会被打断。 */
      this.ensureTextures(w, h);
      const ingest = this.textures.get("ingest")!;
      let ingestSource: unknown;
      if (this.path === "external") {
        if (typeof device.importExternalTexture !== "function") return false;
        ingestSource = device.importExternalTexture({ source: video });
      } else {
        if (typeof device.queue.copyExternalImageToTexture !== "function") return false;
        device.queue.copyExternalImageToTexture({ source: video }, { texture: this.textures.get("staging") }, [w, h]);
        ingestSource = this.textures.get("staging")!.createView();
      }
      const encoder = device.createCommandEncoder();
      {
        const bg = device.createBindGroup({
          layout: this.ingestPipeline!.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: ingestSource },
            { binding: 1, resource: ingest.createView() },
          ],
        });
        const cpass = encoder.beginComputePass();
        cpass.setPipeline(this.ingestPipeline!);
        cpass.setBindGroup(0, bg);
        cpass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
        cpass.end();
      }
      /* 链首输入：restore 链 = ingest（原帧）；upscale 链 = r:MAIN
       * （修复结果）。残差趟加回的正是本链的链首输入。 */
      const chainInputOf = (chain: "r" | "u"): GpuTextureLike =>
        chain === "r" ? ingest : this.textures.get("r:MAIN")!;
      const runChain = (chainPasses: ChainPass[], chain: "r" | "u") => {
        const chainInput = chainInputOf(chain);
        for (const cp of chainPasses) {
          const pass = cp.pass as Extract<SrPass, { kind: "conv" }>;
          const entries: { binding: number; resource: unknown }[] = [];
          cp.inputTexNames.forEach((name, i) => {
            entries.push({ binding: i, resource: this.texFor(chain, name, chainInput).createView() });
          });
          let nextBinding = cp.inputTexNames.length;
          if (pass.residual) {
            entries.push({ binding: nextBinding, resource: chainInput.createView() });
            nextBinding += 1;
          }
          entries.push({ binding: nextBinding, resource: this.textures.get(`${chain}:${pass.save}`)!.createView() });
          const bg = device.createBindGroup({ layout: cp.pipeline.getBindGroupLayout(0), entries });
          const cpass = encoder.beginComputePass();
          cpass.setPipeline(cp.pipeline);
          cpass.setBindGroup(0, bg);
          cpass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
          cpass.end();
        }
      };
      runChain(this.restoreChain, "r");
      const restored = this.textures.get("r:MAIN")!;
      let presentSource: GpuTextureLike;
      if (this.stats.degrade === 0) {
        runChain(this.upscaleChain, "u");
        /* D2S：u:conv2d_last_tf + restored 基底 → out2x */
        const d2sBg = device.createBindGroup({
          layout: this.d2s!.pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.textures.get("u:conv2d_last_tf")!.createView() },
            { binding: 1, resource: restored.createView() },
            { binding: 2, resource: this.sampler },
            { binding: 3, resource: this.textures.get("out2x")!.createView() },
          ],
        });
        const cpass = encoder.beginComputePass();
        cpass.setPipeline(this.d2s!.pipeline);
        cpass.setBindGroup(0, d2sBg);
        cpass.dispatchWorkgroups(Math.ceil((w * 2) / 8), Math.ceil((h * 2) / 8));
        cpass.end();
        presentSource = this.textures.get("out2x")!;
      } else {
        presentSource = restored;
      }
      /* 呈现：全屏三角采样 presentSource → canvas 当前纹理。
       * presentSource 为 rgba16float 时不能直接作 storage 写出 1x，
       * 故 degrade=1 也走采样呈现（restored 本身即纹理）。 */
      if (this.presentPipeline) {
        const rects = presentRects ?? { dst: [0, 0, 1, 1] as const, src: [0, 0, 1, 1] as const };
        if (typeof device.queue.writeBuffer === "function") {
          const data = new Float32Array([...rects.dst, ...rects.src]);
          device.queue.writeBuffer(this.presentUniform, 0, data.buffer as ArrayBuffer);
        }
        const view = this.ctx.getCurrentTexture().createView();
        const bg = device.createBindGroup({
          layout: this.presentPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: presentSource.createView() },
            { binding: 1, resource: this.sampler },
            { binding: 2, resource: { buffer: this.presentUniform } },
          ],
        });
        const rpass = encoder.beginRenderPass({
          colorAttachments: [{ view, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" }],
        });
        rpass.setPipeline(this.presentPipeline);
        rpass.setBindGroup(0, bg);
        rpass.draw(3);
        rpass.end();
      }
      this.inFlight = true;
      device.queue.submit([encoder.finish()]);
      void device.queue.onSubmittedWorkDone().then(() => {
        this.inFlight = false;
        const cost = performance.now() - t0;
        this.stats.frames += 1;
        this.stats.costs.push(cost);
        if (this.stats.costs.length > 240) this.stats.costs.splice(0, this.stats.costs.length - 240);
        /* 降级判定：预算 = 帧间隔；连续 30 帧平均超预算 → 降一级。 */
        if (frameIntervalMs > 0 && this.stats.costs.length >= 30) {
          const recent = this.stats.costs.slice(-30);
          const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
          if (avg > frameIntervalMs) {
            this.overStreak += 1;
            if (this.overStreak >= 2) {
              this.overStreak = 0;
              this.stats.costs = [];
              if (this.stats.degrade === 0) this.stats.degrade = 1;
              else if (this.stats.degrade === 1) {
                this.failFatally("帧成本持续超预算，引擎停用");
              }
            }
          } else {
            this.overStreak = 0;
          }
        }
      }).catch(() => { this.inFlight = false; });
      return true;
    } catch (error) {
      /* 同步异常统一走死亡处理（fix2.1 批二#6）：置 dead、记
       * lastError、onLost 只回调一次，上层据此回退 WebGL 锐化。 */
      this.inFlight = false;
      this.failFatally(`processFrame 同步异常: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  getStats(): SrEngineStats {
    const sorted = [...this.stats.costs].sort((a, b) => a - b);
    const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
    const p90 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] : 0;
    return {
      frames: this.stats.frames,
      droppedStale: this.stats.droppedStale,
      costAvgMs: Math.round(avg * 100) / 100,
      costP90Ms: Math.round(p90 * 100) / 100,
      path: this.path,
      degrade: this.stats.degrade,
      lastError: this.lastError,
    };
  }

  get isDead(): boolean {
    return this.dead || this.stats.degrade === 2;
  }

  destroy() {
    this.dead = true;
    for (const tex of this.textures.values()) {
      try { tex.destroy?.(); } catch { /* 忽略 */ }
    }
    this.textures.clear();
    try { this.device.destroy?.(); } catch { /* 忽略 */ }
  }
}
