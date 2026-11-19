/**
 * 松手卡顿计数器标尺契约测试（Muse 2026-11-19 3.3.0批诊断标尺线；
 * 新增测试经维护者在任务书中授权，AGENTS 不变量 11）。
 * 运行：node src/features/feed/fix330-diag-hold-ruler.contract.test.ts
 *
 * 背景（suspended-items-investigation 问题 B，代码可证）：旧聚合
 * summarizeHoldEvents 对每个 hold.jank 采样行无条件计一次「卡顿」，
 * 从不读尾窗 gap 分布载荷；而采样行在每次长按结束时无条件落盘
 * （finish() 只以 frames>5 为门）——「长按 N 次·卡顿 N 次」恒等成立，
 * 与真实帧间隔无关。新标尺（只动聚合与报告呈现，采样器零改动）：
 * 尾窗 post_max_gap_ms > 66 或 post_over50 > 0 才计「卡顿」；未达卡顿
 * 判据但尾窗最大间隔 >33ms（或 post_over33 > 0）计「顿帧」；两者皆
 * 不沾、无分布载荷者不计。原始分布字段经聚合照常汇总（计数求和、
 * 最大间隔取最大），报告照印不丢。
 *
 * 证伪夹具两组真实形态（字段名与形态照采样器 hold.jank 落行原样，
 * 参照 suspended-items 调查与 fix322/evidence/sr.md 的真实剖面）：
 * (a) 3.2.1 剖面形态——整帧人为冻结（releaseSkip 跳一整 rVFC 周期
 *     叠加帧队列重定时）：尾窗 max 132ms（≥一整帧冻结量级且 >66）、
 *     post_over50=2，必须仍计「卡顿」；
 * (b) 3.2.2 剖面形态——SR 尝试→呈现 8/15ms、尾窗 max 32ms：必须计
 *     0 卡顿、且不落顿帧档（32<33）。旧聚合对 (b) 计 1 卡顿即为红。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { summarizeHoldEvents } from "./holdJank.ts";

/* (a) 3.2.1 形态：整帧冻结，尾窗分布显著超阈。 */
const jank321 = {
  name: "hold.jank",
  data: {
    sr_engaged: true, pipeline: "webgpu",
    frames: 180, over33: 6, over50: 4, max_gap_ms: 140,
    post_frames: 36, post_over33: 3, post_over50: 2, post_max_gap_ms: 132,
  },
};
/* (b) 3.2.2 形态：尾窗最大间隔 32ms（<33），无一帧超 33ms。 */
const clean322 = {
  name: "hold.jank",
  data: {
    sr_engaged: false, pipeline: "none",
    frames: 150, over33: 0, over50: 0, max_gap_ms: 28,
    post_frames: 36, post_over33: 0, post_over50: 0, post_max_gap_ms: 32,
  },
};

{
  const hs = summarizeHoldEvents([jank321]);
  assert.equal(hs.engaged.janks, 1, "(a) 3.2.1 整帧冻结形态必须仍计卡顿");
  assert.equal(hs.engaged.hesitations, 0, "(a) 已达卡顿判据者不重复落顿帧档");
}
{
  const hs = summarizeHoldEvents([clean322]);
  assert.equal(hs.bypass.janks, 0, "(b) 3.2.2 尾窗 max 32ms 必须计 0 卡顿（旧聚合在此计 1＝红）");
  assert.equal(hs.bypass.hesitations, 0, "(b) 32ms < 33 不落顿帧档");
}

/* 顿帧档与判据边界：33–66 区间未达卡顿判据 → 顿帧；post_over50 > 0
 * 优先于区间（哪怕 max 只有 60）；66 整不算卡顿、67 起算；无分布
 * 载荷的采样行既不计卡顿也不计顿帧（不许拿行数冒充）。 */
{
  const stall = { name: "hold.jank", data: { sr_engaged: true, over33: 2, over50: 0, max_gap_ms: 52, post_over33: 1, post_over50: 0, post_max_gap_ms: 48 } };
  const over50First = { name: "hold.jank", data: { sr_engaged: false, over33: 3, over50: 1, max_gap_ms: 61, post_over33: 2, post_over50: 1, post_max_gap_ms: 60 } };
  const edge66 = { name: "hold.jank", data: { sr_engaged: true, post_over33: 1, post_over50: 0, post_max_gap_ms: 66 } };
  const edge67 = { name: "hold.jank", data: { sr_engaged: true, post_over33: 1, post_over50: 1, post_max_gap_ms: 67 } };
  const noPayload = { name: "hold.jank", data: { sr_engaged: true } };
  const hs = summarizeHoldEvents([stall, over50First, edge66, edge67, noPayload]);
  assert.equal(hs.engaged.janks, 1, "仅 67ms 行计卡顿（66 整只落顿帧、无载荷不计）");
  assert.equal(hs.engaged.hesitations, 2, "48ms 与 66ms 两行落顿帧档");
  assert.equal(hs.bypass.janks, 1, "post_over50 > 0 优先计卡顿（max 60 亦然）");
  assert.equal(hs.bypass.hesitations, 0, "已计卡顿者不落顿帧");
}

/* 原始分布照印不丢：聚合须把 over33/over50/max 与 post_* 汇总进桶
 * （计数求和、最大间隔取最大），报告据此印分布行。 */
{
  const profile = { name: "hold.release_profile", data: { sr_engaged: true } };
  const hs = summarizeHoldEvents([profile, jank321, clean322]);
  assert.deepEqual(
    hs.engaged,
    { holds: 1, janks: 1, hesitations: 0, over33: 6, over50: 4, maxGapMs: 140, postOver33: 3, postOver50: 2, postMaxGapMs: 132 },
    "SR 接管桶：计数按新标尺、分布字段逐项汇总不丢",
  );
  assert.deepEqual(
    hs.bypass,
    { holds: 0, janks: 0, hesitations: 0, over33: 0, over50: 0, maxGapMs: 28, postOver33: 0, postOver50: 0, postMaxGapMs: 32 },
    "判档直通桶：干净行只贡献分布原值、不贡献卡顿/顿帧计数",
  );
}

/* 报告呈现接线：汇总行须卡顿/顿帧并列、分布字段照印。 */
{
  const report = readFileSync(new URL("../../shared/diagnostics/diagnosticReport.ts", import.meta.url), "utf8");
  assert.ok(report.includes("顿帧"), "报告汇总行含顿帧档（与卡顿并列呈现）");
  assert.ok(report.includes("hesitations"), "报告消费聚合器的顿帧计数（hesitations）");
  assert.ok(report.includes("postOver33") && report.includes("postOver50"), "报告印尾窗分布汇总（post_over33/post_over50 不丢）");
}

console.log("fix330-diag-hold-ruler.contract: all assertions passed");
