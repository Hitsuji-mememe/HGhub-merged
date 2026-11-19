/**
 * SR 帧率回填契约测试（Muse 2026-11-19 3.3.0批 SR 帧率回填线；
 * 新增测试经维护者在任务书中授权，AGENTS 不变量 11）。
 * 运行：node src/features/playback/fix330-sr-fps.contract.test.ts
 * 判档真函数断言在 tests/playback-engines.tsx 的 C2 组（.tsx 判档函数
 * 无法被 node 直接 import，与 fix322-sr-release 的分工一致：纯逻辑
 * 在此功能断言、JSX 侧接线在此源码断言、判档行为在浏览器夹具断言）。
 *
 * 背景（调查问题 C）：判档 fps 只有一个来源（主列表 FRAME-RATE），
 * 单档媒体列表直给的源结构性无此属性、fps 恒未知、低密度集恒落
 * 保守 natural。本测试钉四件事：
 * ① 估计器：rVFC 序列（ΔpresentedFrames/ΔmediaTime）满 60 已呈现帧
 *    后一次性定版锁定；掉帧只使估计偏低、seek 污染窗被丢弃。
 * ② 保守吸附：标准率 {24/25/30/50/60} 向下吸附（宁低勿高），低于
 *    24 按未知。旧口径（调查初稿的向上吸附）在 29.9→30 上与此相反。
 * ③ 采样器分离：回填只进 measuredFps、fps（声明）恒不被实测覆盖；
 *    声明在时 fpsSource=declared 且 measured 不合并。
 * ④ 接线分离（源码断言）：crisp 门认 fpsKnownForCrisp、off 门只认
 *    fpsKnownDeclared、bpp 只认声明 fps、双播放面帧预算通道只传
 *    density.fps、内核以估计器回填并把来源写进 facts。旧码无
 *    measuredFps 概念、单 fpsKnown 混喂三处 → 本组在旧码上红。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSrFpsEstimator, medianOf, snapMeasuredFps } from "./srFpsEstimate.ts";
import { createSrDensitySampler } from "./useSrDensity.ts";

/* ── ① 估计器：定版、锁定、掉帧偏低、seek 窗丢弃 ─────────────────── */
{
  const est = createSrFpsEstimator();
  let r = est.current();
  for (let k = 0; k <= 59; k++) r = est.feed(k, k / 30);
  assert.equal(r.settled, false, "未满 60 已呈现帧不得定版");
  r = est.feed(60, 60 / 30);
  assert.equal(r.settled, true, "满 60 已呈现帧应定版");
  assert.equal(r.fps, 30, "30fps 内容定版 30");
  const locked = est.feed(500, 500 / 60);
  assert.equal(locked.fps, 30, "定版后锁定：后续样本不改判（不来回跳档）");
}
{
  /* 掉帧：呈现率 27（30fps 内容约一成掉帧）→ 中值 27 → 向下吸附 25。 */
  const est = createSrFpsEstimator();
  let r = est.current();
  for (let k = 0; k <= 70; k++) r = est.feed(k, k / 27);
  assert.equal(r.settled, true);
  assert.equal(r.fps, 25, "掉帧使估计偏低、吸附宁低勿高（27→25）");
}
{
  /* seek 污染窗：mediaTime 跳变 5s 的窗帧率出合理区间、整窗丢弃，
   * 其余窗仍定版 30。 */
  const est = createSrFpsEstimator();
  let r = est.current();
  for (let k = 0; k <= 30; k++) r = est.feed(k, k / 30);
  r = est.feed(40, 40 / 30 + 5);
  for (let k = 41; k <= 110; k++) r = est.feed(k, k / 30 + 5);
  assert.equal(r.settled, true, "seek 窗丢弃后仍可定版");
  assert.equal(r.fps, 30, "seek 污染窗不入中值");
}
{
  /* 低帧率内容：20fps → 定版为未知（fps 缺失），不吸附 24。 */
  const est = createSrFpsEstimator();
  let r = est.current();
  for (let k = 0; k <= 70; k++) r = est.feed(k, k / 20);
  assert.equal(r.settled, true, "低帧率同样一次性定版（定版为未知）");
  assert.equal(r.fps, undefined, "低于 24 按未知处理");
  /* 中值滤波：奇数取中、偶数取中二均值。 */
  assert.equal(medianOf([30, 10, 20]), 20);
  assert.equal(medianOf([30, 10]), 20);
}

/* ── ② 保守吸附表 ────────────────────────────────────────────────── */
assert.equal(snapMeasuredFps(24), 24);
assert.equal(snapMeasuredFps(25), 25);
assert.equal(snapMeasuredFps(29.9), 25, "向下吸附：29.9→25（不向上取 30）");
assert.equal(snapMeasuredFps(30.4), 30);
assert.equal(snapMeasuredFps(50), 50);
assert.equal(snapMeasuredFps(59.9), 50, "向下吸附：59.9→50（估计偏低时不冒认 60）");
assert.equal(snapMeasuredFps(60), 60);
assert.equal(snapMeasuredFps(120), 60, "集合上限 60：更高帧率向下吸附到 60");
assert.equal(snapMeasuredFps(23.99), undefined, "低于 24 按未知");
assert.equal(snapMeasuredFps(0), undefined);
assert.equal(snapMeasuredFps(Number.NaN), undefined);

/* ── ③ 采样器分离：声明/实测分开存放、声明优先 ───────────────────── */
{
  /* 单档列表形态：level 无 frameRate，3 片定稿后 fps 恒缺失。 */
  const sampler = createSrDensitySampler();
  const lvl = { bitrate: 1_219_000, width: 720, height: 1280 };
  let d = null as ReturnType<typeof sampler.ingest>;
  for (let i = 0; i < 3; i++) d = sampler.ingest({ loaded: 1000, duration: 2, level: 0 }, lvl);
  assert.equal(d?.provisional, false, "3 片定稿");
  assert.equal(d?.fps, undefined, "单档形态声明 fps 恒缺失");
  assert.equal(d?.fpsSource, undefined);
  d = sampler.noteMeasuredFps(30, 30.2);
  assert.equal(d?.measuredFps, 30, "回填进 measuredFps");
  assert.equal(d?.measuredRawFps, 30.2, "未吸附中值随回填入 density 供诊断");
  assert.equal(d?.fps, undefined, "回填不得写声明字段 fps");
  assert.equal(d?.fpsSource, "measured");
}
{
  /* 声明在时：回填不合并、fpsSource 恒 declared。 */
  const sampler = createSrDensitySampler();
  const lvl = { frameRate: 30, bitrate: 8_000_000, width: 1920, height: 1080 };
  let d = null as ReturnType<typeof sampler.ingest>;
  for (let i = 0; i < 3; i++) d = sampler.ingest({ loaded: 1000, duration: 2, level: 0 }, lvl);
  assert.equal(d?.fps, 30);
  assert.equal(d?.fpsSource, "declared");
  d = sampler.noteMeasuredFps(50, 50);
  assert.equal(d?.fps, 30, "声明值不被实测覆盖");
  assert.equal(d?.measuredFps, undefined, "声明在时实测不合并");
  /* 换源复位清回填暂存。 */
  sampler.reset();
  assert.equal(sampler.current(), null);
}

/* ── ④ 接线分离（源码断言） ──────────────────────────────────────── */
{
  const sr = readFileSync(new URL("./SuperResCanvas.tsx", import.meta.url), "utf8");
  assert.ok(/const fpsKnownForCrisp = fpsKnownDeclared \|\|/.test(sr), "crisp 门须有独立的 fpsKnownForCrisp（声明或实测）");
  assert.ok(/if \(bpp < low\) return fpsKnownForCrisp \? "crisp" : "natural";/.test(sr), "低密度 crisp 门只认 fpsKnownForCrisp");
  assert.ok(/if \(short > 720\) return fpsKnownDeclared \? "off" : "natural";/.test(sr), "关超分门只认声明 fps（fpsKnownDeclared），不吃回填");
  assert.ok(sr.includes("srBpp(w, h, d?.bitrateBps, d?.fps)"), "bpp 只认声明 fps 计算");
  assert.ok(!sr.includes("srBpp(w, h, d?.bitrateBps, d?.measuredFps"), "bpp 不许改吃回填值");
  assert.ok(sr.includes("srCostBudgetMs(fpsRef.current)"), "帧成本预算经 srCostBudgetMs 且只喂声明 fps 通道（fpsRef=fps prop）");
}
{
  const kernel = readFileSync(new URL("./usePlaybackKernel.ts", import.meta.url), "utf8");
  assert.ok(kernel.includes("createSrFpsEstimator()"), "内核层持有 rVFC 估计器测帧率");
  assert.ok(kernel.includes("noteMeasuredFpsRef.current(est.fps, est.rawMedian)"), "内核定版后经密度采样器一次性回填");
  assert.ok(kernel.includes('traceRef.current("sr.fps_measured"'), "回填定版留诊断痕（来源可判读）");
  assert.ok(kernel.includes('fpsSource: "measured" as const'), "facts 写 fps 来源（实测）");
  assert.ok(kernel.includes('fpsSource: "declared" as const'), "facts 写 fps 来源（声明）");
}
{
  for (const file of ["./VideoSurface.tsx", "./Player.tsx"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(src.includes("fps={srDensity?.fps}"), `${file} 帧预算通道只传声明 fps`);
    assert.ok(!src.includes("fps={srDensity?.measuredFps}"), `${file} 帧预算通道不许传回填值`);
    assert.ok(!src.includes("fps={srDensity?.fps ?? srDensity?.measuredFps}"), `${file} 帧预算通道不许回退到回填值`);
  }
}

console.log("fix330-sr-fps.contract: all assertions passed");
