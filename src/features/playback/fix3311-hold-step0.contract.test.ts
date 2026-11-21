/**
 * 长按松手第 0 步判读面契约测试（Muse 2026-11-21 fix3311/small-features；
 * 新增测试经维护者在本批任务书中授权，AGENTS 不变量 11）。
 * 运行：node src/features/playback/fix3311-hold-step0.contract.test.ts
 *
 * 背景（fix3311 长按根因调查 §5 第 0 步＋§4-①）：形态 A 的二选一
 * （媒体引擎速率切换重定时 vs 主线程并发阻塞）在现行剖面下不可分——
 * 判别字段（rvfc_expected_display_time 等）其实已在账本里，只是
 * 报告剖面行没印；且剖面 attempt 归因有虚高（松手后第一帧撞上在飞
 * 帧被丢弃时，attempt 落在死帧上、present 等下一帧，虚高约一帧
 * 间隔，见调查裁定 6）。第 0 步只改测量、不改体感行为：
 * ① 剖面器落行补 rvfc_expected_display_delta_ms（expectedDisplayTime
 *    相对 release 的差，与 t0 同为 performance 时间原点：差≈帧间隔
 *    量级指向引擎重定时、差≈0 而分段迟到指向主线程阻塞）；
 * ② 报告剖面行增印已记录字段（预期呈现差/mediaTime/SR 画布龄/
 *    画布重挂/HLS 重建），并给剖面行与 hold.jank 行加可配对序号
 *    （release_profile 与其后 ~600ms 的 hold.jank 为同一次松手，
 *    按账本顺序逐条配对，分布从此可逐次判读、不再只有桶聚合）；
 * ③ WebGpuSrCanvas 的 noteHoldSrAttempt 移到 processFrame 返回
 *    did=true 之后（时刻仍取调用前的提交时刻），did=false 的丢弃
 *    帧不进剖面 attempt。
 *
 * 本测试钉三件事：剖面器新字段的数值口径（行为测试，注入时钟）；
 * 报告格式化纯函数对模拟账本的输出（新字段与配对序号实证出现、
 * 孤儿 jank 不冒充配对）；画布接线源码断言（attempt 在 processFrame
 * 之后且受 did 门控）。基点：①字段不存在、②格式化函数不存在、
 * ③attempt 在调用前无条件记 → 全红。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHoldReleaseProfiler } from "../feed/holdJank.ts";
import { formatHoldProfileLines } from "../../shared/diagnostics/holdProfileLines.ts";

/* ── ① 剖面器：expectedDisplayTime 相对 release 的差 ── */
{
  const rows: { event: string; data?: Record<string, unknown> }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const profiler = createHoldReleaseProfiler((event, data) => { rows.push({ event, data }); }, {
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); },
    startLongtask: () => null,
    context: () => ({ srEngaged: true, pipeline: "webgpu" }),
    lifecycle: () => ({ feedMountedAt: 0, srMountedAt: 500, srUnmountedAt: null }),
    hlsInstanceId: () => "hls-1",
  });
  profiler.release(1000);
  profiler.firstFrame(1062, { mediaTime: 3.25, presentedFrames: 41, expectedDisplayTime: 1040 });
  profiler.srAttempt(1061);
  profiler.srPresent(1073);
  const row = rows.find((r) => r.event === "hold.release_profile");
  assert.ok(row, "四点齐应落一行 hold.release_profile");
  assert.equal(row.data?.rvfc_expected_display_delta_ms, 40, "预期呈现差＝expectedDisplayTime(1040) − release(1000)");
  assert.equal(row.data?.rvfc_expected_display_time, 1040, "原始 expectedDisplayTime 字段逐字保留");
  assert.equal(row.data?.rvfc_media_time, 3.25, "mediaTime 字段逐字保留");
  assert.equal(row.data?.sr_canvas_age_ms, 500, "SR 画布龄＝release − srMountedAt");
  assert.equal(row.data?.sr_canvas_remounted, false, "窗口内未重挂");
  assert.equal(row.data?.hls_rebuilt_during_window, false, "窗口内 HLS 未重建");

  /* 无 rVFC metadata（rAF 回落）：差记 null、不伪造 0。 */
  const rows2: { event: string; data?: Record<string, unknown> }[] = [];
  const profiler2 = createHoldReleaseProfiler((event, data) => { rows2.push({ event, data }); }, {
    setTimeoutFn: () => {},
    startLongtask: () => null,
    context: () => ({ srEngaged: false, pipeline: "none" }),
    lifecycle: () => ({ feedMountedAt: null, srMountedAt: null, srUnmountedAt: null }),
    hlsInstanceId: () => null,
  });
  profiler2.release(2000);
  profiler2.firstFrame(2012);
  profiler2.srPresent(2020);
  const row2 = rows2.find((r) => r.event === "hold.release_profile");
  assert.ok(row2, "无 metadata 也应落行");
  assert.equal(row2.data?.rvfc_expected_display_delta_ms, null, "无 expectedDisplayTime 时差为 null");
}

/* ── ② 报告格式化：新字段与配对序号在模拟输出中实证出现 ── */
{
  const jank = { over33: 5, over50: 3, max_gap_ms: 140, post_over33: 3, post_over50: 2, post_max_gap_ms: 132 };
  const profile = {
    sr_engaged: true, release_to_first_frame_ms: 62, release_to_sr_attempt_ms: 61,
    sr_attempt_to_present_ms: 12, release_to_sr_present_ms: 73, longtask_max_ms: null,
    rvfc_expected_display_delta_ms: 40, rvfc_media_time: 3.25, sr_canvas_age_ms: 500,
    sr_canvas_remounted: false, hls_rebuilt_during_window: true,
  };
  const events = [
    { name: "hold.jank", data: { sr_engaged: true, ...jank } }, // 孤儿 jank（无前置剖面）：不配对、不冒充
    { name: "hold.release_profile", data: profile },
    { name: "hold.jank", data: { sr_engaged: true, ...jank } },
    { name: "hold.release_profile", data: { ...profile, sr_engaged: false } },
    { name: "hold.jank", data: { sr_engaged: false, ...jank } },
  ];
  const lines = formatHoldProfileLines(events);
  const p1 = lines.find((l) => l.startsWith("松手剖面#1"));
  const p2 = lines.find((l) => l.startsWith("松手剖面#2"));
  const j1 = lines.find((l) => l.startsWith("松手尾窗#1"));
  const j2 = lines.find((l) => l.startsWith("松手尾窗#2"));
  assert.ok(p1 && p2, "两条剖面行带序号 #1/#2 出现");
  assert.ok(j1 && j2, "两条尾窗行与剖面同号配对出现（孤儿 jank 不占号）");
  assert.ok(p1.includes("预期呈现差 40ms"), "剖面行印预期呈现差");
  assert.ok(p1.includes("mediaTime 3.25s"), "剖面行印 rVFC mediaTime");
  assert.ok(p1.includes("SR 画布龄 500ms"), "剖面行印 SR 画布龄");
  assert.ok(p1.includes("画布重挂 否"), "剖面行印画布重挂标志");
  assert.ok(p1.includes("HLS 重建 是"), "剖面行印 HLS 重建标志");
  assert.ok(p1.includes("首帧 62ms") && p1.includes("SR 呈现 73ms"), "既有分段字段口径逐字保留");
  assert.ok(j1.includes("尾窗 max 132ms") && j1.includes("期间 max 140ms"), "尾窗行印该次松手的期间/尾窗分布（逐次判读）");
  assert.ok(p2.includes("[判档直通]"), "桶标随剖面自带 sr_engaged 走");
  assert.deepEqual(formatHoldProfileLines([]), [], "空账本无行");
}

/* ── ③ 画布接线：attempt 在 processFrame 之后、受 did 门控 ── */
{
  const src = readFileSync(new URL("./WebGpuSrCanvas.tsx", import.meta.url), "utf8");
  const attemptIdx = src.indexOf("noteHoldSrAttempt(attemptAt)");
  const callIdx = src.indexOf("eng.processFrame(");
  assert.ok(callIdx >= 0 && attemptIdx > callIdx, "noteHoldSrAttempt 必须在 processFrame 调用之后（受理后记账）");
  assert.ok(src.includes("if (did) noteHoldSrAttempt(attemptAt);"), "attempt 只记 did=true 的受理帧（丢弃帧不进剖面）");
  const report = readFileSync(new URL("../../shared/diagnostics/diagnosticReport.ts", import.meta.url), "utf8");
  assert.ok(report.includes("formatHoldProfileLines(holdEvents)"), "报告长按节经 formatHoldProfileLines 出剖面/尾窗行");
}

console.log("fix3311-hold-step0.contract: all assertions passed");
