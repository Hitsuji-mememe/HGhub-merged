/**
 * 松手帧时序契约测试（Muse 2026-11-19 fix322/sr 线；新增测试经维护者
 * 在本批任务书中授权，AGENTS 不变量 11）。
 * 运行：node src/features/playback/fix322-sr-release.contract.test.ts
 *
 * 不变量（本批钉死）：倍速退出 ≥2x 域（松手）后，SR 画布的下一个帧
 * 周期必须照常处理并呈现新帧——松手不许跳过任何帧周期的 SR 处理。
 * 理由：WebGPU 画布是不透明覆盖层（opacity=1 后整幅 clear＋全屏三角），
 * 被跳过的周期里用户看到的是冻结的旧 SR 帧，视频本体在画布之下根本
 * 不可见——旧 releaseSkip「让视频本体先呈现」的让行对象不存在，它只
 * 把画布更新平白推迟一个 rVFC 周期，且该周期恰是速率切换后帧队列
 * 重定时的延迟周期，两段延迟在松手帧上叠加。
 * 配套测量不变量：hold.release_profile 的 SR 呈现时刻必须是该帧 GPU
 * 工作完成（onSubmittedWorkDone 落定、可被合成呈现）的时刻，不是命令
 * 提交时刻——旧实现在 processFrame 同步返回（=提交）时即记 present，
 * GPU 侧停顿对剖面完全不可见，release_to_sr_present_ms 名不副实。
 *
 * 本测试钉三件事：
 * ① 引擎行为（假 GPU 设备，真引擎代码）：processFrame 提交后，
 *    onFrameDone 必须在工作落定时以（提交时刻, 完成时刻）回调一次；
 *    在飞期间第二帧仍被丢弃（inFlight 纪律不变）、落定后恢复处理。
 *    旧引擎无此回调 → 红。
 * ② 画布接线（源码断言，仿 fix321-f3 先例）：WebGpuSrCanvas 不得再
 *    含 releaseSkip 跳帧机制；noteHoldSrPresent 必须由完成回调以
 *    doneAt 触发。旧码两处皆反 → 红。
 * ③ 报告判读面（源码断言）：诊断报告长按松手分组节必须读出
 *    release_profile 分段字段与 hold.jank 尾窗最大间隔——旧报告只印
 *    桶计数、分段值从不出现 → 红。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WebGpuSrEngine } from "./webgpuSr.ts";

/* ── ① 引擎完成回调（假设备） ── */
{
  /* 解析器先置抛错默认：引擎若从不调 onSubmittedWorkDone，调用即红。 */
  let workResolve: () => void = () => { throw new Error("引擎未登记 onSubmittedWorkDone"); };
  let workSeen = false;
  const passStub = { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, draw() {}, end() {} };
  const fakeDevice = {
    createSampler: () => ({}),
    createBuffer: () => ({}),
    createShaderModule: () => ({}),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      beginComputePass: () => passStub,
      beginRenderPass: () => passStub,
      finish: () => ({}),
    }),
    queue: {
      submit() {},
      writeBuffer() {},
      copyExternalImageToTexture() {},
      onSubmittedWorkDone: () => new Promise<void>((r) => { workSeen = true; workResolve = r; }),
    },
    importExternalTexture: () => ({}),
    lost: new Promise<never>(() => {}),
    addEventListener() {},
    destroy() {},
  };
  const fakeGpu = {
    requestAdapter: async () => ({ requestDevice: async () => fakeDevice }),
    getPreferredCanvasFormat: () => "bgra8unorm",
  };
  Object.defineProperty(globalThis, "navigator", { value: { gpu: fakeGpu }, configurable: true });
  const fakeCanvas = {
    getContext: () => ({ configure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) }),
  };

  const doneCalls: { submittedAt: number; doneAt: number }[] = [];
  const engine = await WebGpuSrEngine.create(fakeCanvas as never, {
    path: "copy",
    onLost: () => {},
    onFrameDone: (submittedAt: number, doneAt: number) => { doneCalls.push({ submittedAt, doneAt }); },
  } as never);
  assert.ok(engine, "假设备下引擎应建成");

  const video = { videoWidth: 320, videoHeight: 180, readyState: 2, playbackRate: 1 } as never;
  const rects = { dst: [0, 0, 1, 1] as [number, number, number, number], src: [0, 0, 1, 1] as [number, number, number, number], mode: "natural" as const };

  const did1 = engine.processFrame(video, 33.3, rects);
  assert.equal(did1, true, "首帧应受理");
  assert.equal(doneCalls.length, 0, "工作未落定时完成回调不得触发（提交≠呈现）");

  const did2 = engine.processFrame(video, 33.3, rects);
  assert.equal(did2, false, "在飞期间第二帧仍须丢弃（inFlight 纪律不变）");

  assert.ok(workSeen, "引擎应已登记 onSubmittedWorkDone");
  workResolve();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(doneCalls.length, 1, "工作落定后完成回调恰一次");
  assert.ok(doneCalls[0].submittedAt > 0, "回调带提交时刻");
  assert.ok(doneCalls[0].doneAt >= doneCalls[0].submittedAt, "完成时刻不早于提交时刻");

  const did3 = engine.processFrame(video, 33.3, rects);
  assert.equal(did3, true, "落定后恢复受理下一帧");
  workResolve();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(doneCalls.length, 2, "第二帧落定再回调一次");
  engine.destroy();
}

/* ── ② 画布接线：无跳帧、呈现时刻走完成回调 ── */
{
  const src = readFileSync(new URL("./WebGpuSrCanvas.tsx", import.meta.url), "utf8");
  /* 钉机制不钉词：注释里允许提及旧机制名，跳帧的置位与分支不许存在。 */
  assert.ok(!/releaseSkip\s*=\s*true/.test(src) && !/if\s*\(releaseSkip\)/.test(src), "松手不得跳过帧周期处理（releaseSkip 置位/跳帧分支须移除）");
  assert.ok(src.includes("onFrameDone"), "画布须消费引擎完成回调 onFrameDone");
  assert.ok(/noteHoldSrPresent\(doneAt\)/.test(src), "SR 呈现时刻须以完成时刻 doneAt 入剖面");
}

/* ── ③ 报告判读面：分段值与尾窗最大间隔须出现在报告源码 ── */
{
  const report = readFileSync(new URL("../../shared/diagnostics/diagnosticReport.ts", import.meta.url), "utf8");
  assert.ok(report.includes("release_to_sr_present_ms"), "报告须读出 release_profile 分段（release_to_sr_present_ms）");
  assert.ok(report.includes("post_max_gap_ms"), "报告须读出 hold.jank 尾窗最大帧间隔（post_max_gap_ms）");
}

console.log("fix322-sr-release.contract: all assertions passed");
