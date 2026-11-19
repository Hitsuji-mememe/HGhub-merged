/**
 * 长按松手分组汇总·数据源契约测试（Muse 2026-11-19 3.2.1修复F3线；
 * 新增测试经维护者在本批任务书中授权，AGENTS 不变量 11）。
 * 运行：node src/features/feed/fix321-f3-hold-summary.contract.test.ts
 *
 * 背景（3.2.0 真机诊断实锤的自相矛盾）：同一份诊断里「账本事件（尾
 * 64 条）」有 hold.release_profile ×3 与 hold.jank ×3（player-1,
 * gen=0），「长按松手分组」节却报两组长按 0 次、卡顿 0 次。
 * 断点定位：hold.* 事件经 trace→账本绑定落进**事件账本**
 * （eventLedger.LedgerEvent：name 键＋data 原样保留，sr_engaged 落账
 * 完整）；而汇总节旧实现把**播放日志** LogEntry[]（按最后一个 pid
 * 过滤）喂给 summarizeHoldEvents——两套存储不同，且日志落盘名由
 * Rust 统一加 web. 前缀（web.hold.jank，playback_log.rs），聚合器按
 * hold.jank/hold.release_profile 精确匹配恒不命中。
 *
 * 本测试钉两件事（一契约一回归）：
 * ① 账本形态事件集走聚合器 → 两组计数非零且按 sr_engaged 分组正确，
 *    无显式布尔的事件不入桶（不许猜）；
 * ② 报告汇总节的生产调用点确实吃 ledgerSnapshot().events（数据源
 *    接线断言，仿 final-d3.contract.test.ts 源码断言先例）——旧实现
 *    在此断言上为红。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { summarizeHoldEvents } from "./holdJank.ts";

/* 账本形态（LedgerEvent 全形态：seq/ts/monoMs/name/instanceId/data）：
 * release_profile ×3（接管 2＋直通 1）、jank ×3（接管 1＋直通 2），
 * 与 3.2.0 真机账本尾段同构（player-1, gen=0）。 */
const ledgerEvents = [
  { seq: 41, ts: "2026-11-19T10:04:31.000Z", monoMs: 61000, name: "hold.release_profile", instanceId: "player-1", data: { generation: 0, sr_engaged: true, pipeline: "webgpu" } },
  { seq: 42, ts: "2026-11-19T10:04:33.000Z", monoMs: 63000, name: "hold.jank", instanceId: "player-1", data: { generation: 0, sr_engaged: true, pipeline: "webgpu" } },
  { seq: 55, ts: "2026-11-19T10:05:02.000Z", monoMs: 92000, name: "hold.release_profile", instanceId: "player-1", data: { generation: 0, sr_engaged: true, pipeline: "webgpu" } },
  { seq: 71, ts: "2026-11-19T10:06:10.000Z", monoMs: 160000, name: "hold.release_profile", instanceId: "player-1", data: { generation: 0, sr_engaged: false, pipeline: "none" } },
  { seq: 72, ts: "2026-11-19T10:06:12.000Z", monoMs: 162000, name: "hold.jank", instanceId: "player-1", data: { generation: 0, sr_engaged: false, pipeline: "none" } },
  { seq: 73, ts: "2026-11-19T10:06:20.000Z", monoMs: 170000, name: "hold.jank", instanceId: "player-1", data: { generation: 0, sr_engaged: false, pipeline: "none" } },
  /* 无 sr_engaged 显式布尔的 hold 事件：不入桶、不推断 */
  { seq: 80, ts: "2026-11-19T10:07:00.000Z", monoMs: 210000, name: "hold.jank", instanceId: "player-1", data: { generation: 0 } },
  /* 无关事件：忽略 */
  { seq: 81, ts: "2026-11-19T10:07:01.000Z", monoMs: 211000, name: "media.playing", instanceId: "player-1", data: { generation: 0 } },
];

{
  const hs = summarizeHoldEvents(ledgerEvents);
  assert.deepEqual(hs.engaged, { holds: 2, janks: 1 }, "SR 接管组：release_profile ×2、jank ×1");
  assert.deepEqual(hs.bypass, { holds: 1, janks: 2 }, "判档直通组：release_profile ×1、jank ×2");
}

/* 旧数据源形态（播放日志落盘行经 parseLog 后的 event 键＋web. 前缀）
 * 喂同一聚合器恒 0——这正是旧汇总节的实际输入形态，钉住它防「靠放宽
 * 聚合器名称匹配来凑数」的假修法：修法只能是换数据源。 */
{
  const logShaped = ledgerEvents.map(e => ({ event: `web.${e.name}`, data: e.data }));
  const hs = summarizeHoldEvents(logShaped);
  assert.deepEqual(hs, { engaged: { holds: 0, janks: 0 }, bypass: { holds: 0, janks: 0 } }, "播放日志形态（web. 前缀）恒 0：旧数据源不可用");
}

/* ② 数据源接线：报告汇总节必须以账本快照事件为 summarizeHoldEvents
 * 的入参（与账本尾段同源），不许再喂播放日志 entries 的 pid 过滤集。 */
{
  const report = readFileSync(new URL("../../shared/diagnostics/diagnosticReport.ts", import.meta.url), "utf8");
  const sectionStart = report.indexOf("长按松手分组（SR 接管 vs 判档直通）");
  assert.ok(sectionStart >= 0, "报告含长按松手分组节标题行");
  const section = report.slice(Math.max(0, sectionStart - 1500), sectionStart + 800);
  /* 断言适配（fix322/sr）：汇总节改以同一份账本快照变量 holdEvents
   * 同时供桶计数与松手剖面分段判读，调用形态由直传快照改为变量；
   * 契约口径不变且更严——数据源仍须是 ledgerSnapshot().events，
   * 且计数与分段同源一份快照。 */
  assert.ok(
    section.includes("const holdEvents = ledgerSnapshot().events") && section.includes("summarizeHoldEvents(holdEvents)"),
    "汇总节吃事件账本快照（holdEvents = ledgerSnapshot().events → summarizeHoldEvents(holdEvents)）",
  );
  assert.ok(
    !/summarizeHoldEvents\(\s*session\b/.test(section),
    "汇总节不再把播放日志 pid 过滤集（session）喂给聚合器",
  );
}

console.log("fix321-f3-hold-summary.contract: all assertions passed");
