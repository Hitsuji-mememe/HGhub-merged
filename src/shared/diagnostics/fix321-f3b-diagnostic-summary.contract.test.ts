/**
 * 诊断汇总层逐节对账契约测试（Muse 2026-11-19 3.2.1修复F3b线；
 * 新增测试经维护者在本批任务书中授权，AGENTS 不变量 11）。
 * 运行：node src/shared/diagnostics/fix321-f3b-diagnostic-summary.contract.test.ts
 *
 * 背景（3.2.0 第二份真机诊断实锤）：与第一份同会话、播放进行中，
 * 报告却写「最近播放：无最近播放记录」「最近一次播放流水：（无记录）」，
 * 同份报告账本尾段里 player-6 正在 media.playing、hlsFragLoaded 连串。
 * 根因在汇总层：analyzeFlow 只认播放日志「最后一行 pid 段」且段内必须
 * 有 web.source.load，读到的窗口里该段无 load（轮转/导出裁剪/尾段混入
 * 他 pid 行/写队列未落盘均可致）即整体塌缩成「无记录」，且从不与事件
 * 账本交叉核对、无通道状态明示。本测试逐节钉「汇总 vs 原始记录一致」：
 * ①最近播放/流水：分段选择必须落到最新一个含 source.load 的段，
 *   不许被尾段 pid 绑架；②结论交叉核对：账本证据函数对播放/卡死
 *   计数与原始账本事件一致（报告据此明示通道状态，不再假报无记录）；
 * ③Feed 分页与封面：汇总函数对合成原始事件的计数逐项吻合；
 * ④源总览三态：成功/失败/未发生/记录缺失四计数之和＝源总数，
 *   无生效地址的源不许被静默漏计；⑤长按松手分组（F3 已修）复核。
 * 报告侧接线（analyzeFlow 用 selectFlowSegment、读日志前 flush、
 * 无段时账本明示、registryDiag 用 countFetchStates）以源码断言钉住，
 * 仿 fix321-f3 先例。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectFlowSegment, ledgerPlaybackEvidence } from "./flowSegments.ts";
import { countFetchStates } from "../../features/sources/fetchCounts.ts";
import { traceFeed, imageStarted, imageDisplayed, imageFailed, feedTraceSummary, feedTraceSnapshot } from "../lib/feedTrace.ts";
import { summarizeHoldEvents } from "../../features/feed/holdJank.ts";

/* ── ① 最近播放分段选择 ────────────────────────────────────────────
 * 合成原始记录（parseLog 后的 LogEntry 形态）：pid 111 段是一段完整
 * 播放（source.load→resolve→manifest→fragLoaded→append→buffered→
 * playing，player-6，与第二份诊断账本尾段同构）；文件尾段 pid 222
 * 只有环境/调试行、无 source.load（尾段 pid 不是当前播放段）。 */
type E = { event: string; ts: number; pid: number | null; data: Record<string, unknown>; mono: number | null };
const ev = (event: string, pid: number | null, mono: number, data: Record<string, unknown> = {}): E =>
  ({ event, ts: 1_700_000_000_000 + mono, pid, data, mono });
const playSeg: E[] = [
  ev("web.source.load", 111, 1000, { player: "player-6" }),
  ev("web.play.resolve", 111, 1010, {}),
  ev("web.hls.manifest", 111, 1200, { player: "player-6" }),
  ev("web.hlsFragLoaded", 111, 1500, { player: "player-6" }),
  ev("web.hls.buffer_appended", 111, 1600, { player: "player-6" }),
  ev("web.hlsFragBuffered", 111, 1700, { player: "player-6" }),
  ev("web.media.playing", 111, 1900, { player: "player-6" }),
  ev("web.hlsFragLoaded", 111, 4000, { player: "player-6" }),
];
const tailSeg: E[] = [
  ev("diagnostics.env", 222, 9000, {}),
  ev("debug.line", 222, 9100, {}),
];
{
  /* 第二份诊断场景：最后一行 pid 段无 load —— 旧口径（只取最后 pid
   * 段）在此得空段、analyzeFlow 返回 null、报告假报「无记录」；
   * 新口径必须回落到最新含 load 的段。 */
  const entries = [...playSeg, ...tailSeg];
  const seg = selectFlowSegment(entries);
  assert.ok(seg.some(e => e.event === "web.source.load"), "分段选择落到含 source.load 的段（第二份诊断场景不许再无记录）");
  assert.ok(seg.every(e => e.pid === 111), "选中的是 pid 111 播放段，不是尾段 pid 222");
  assert.ok(seg.some(e => e.event === "web.media.playing"), "选中段含 playing（流水阶段齐）");
}
{
  /* 无回归：最后 pid 段本身含 load 时仍选它（最新段优先）。 */
  const newer: E[] = [ev("web.source.load", 222, 9500, { player: "player-7" }), ev("web.media.playing", 222, 9900, { player: "player-7" })];
  const seg = selectFlowSegment([...playSeg, ...newer]);
  assert.ok(seg.every(e => e.pid === 222), "最后段含 load 时仍选最后段");
}
{
  /* 全文无 load：回落旧口径（最后 pid 段），让上层如实走明示分支。 */
  const seg = selectFlowSegment([...tailSeg]);
  assert.deepEqual(seg, tailSeg, "无任何 load 时回落最后 pid 段");
  assert.deepEqual(selectFlowSegment([]), [], "空集回空集");
}

/* ── ② 账本交叉核对证据 ────────────────────────────────────────────
 * 账本形态（LedgerEvent：name 无 web. 前缀、instanceId 归属实例）：
 * 与第二份诊断账本尾段同构——source.load/media.playing/hlsFragLoaded
 * 在账本里活着，汇总层据此明示「日志通道无完整段」，不许报无记录。 */
{
  const ledger = [
    { name: "source.load", instanceId: "player-6" },
    { name: "hls.manifest", instanceId: "player-6" },
    { name: "hlsFragLoaded", instanceId: "player-6" },
    { name: "media.playing", instanceId: "player-6" },
    { name: "hls.append_stall", instanceId: "player-6" },
    { name: "hls.append_stall", instanceId: "player-6" },
    { name: "media.pause", instanceId: "player-6" },
  ];
  const evidence = ledgerPlaybackEvidence(ledger);
  assert.equal(evidence.hasPlayback, true, "账本有完整播放段 → hasPlayback");
  assert.equal(evidence.stallCount, 2, "账本卡死计数与原始事件一致");
  assert.deepEqual(ledgerPlaybackEvidence([]), { hasPlayback: false, stallCount: 0 }, "账本为空 → 无播放证据（此时报无记录才成立）");
  assert.equal(ledgerPlaybackEvidence([{ name: "player.mount", instanceId: "player-1" }]).hasPlayback, false, "仅实例挂载不算播放证据");
}

/* ── ③ Feed 分页与封面计数 ───────────────────────────────────────── */
{
  traceFeed("page.request", { list: "channel:original", page: 1 });
  traceFeed("page.success", { list: "channel:original", page: 1 });
  traceFeed("page.success", { list: "channel:original", page: 2 });
  traceFeed("page.state", { list: "channel:original", to: "ready" });
  traceFeed("page.success", { list: "channel:ai-duanju", page: 1 });
  traceFeed("page.fail", { list: "channel:ai-duanju", page: 2, reason: "error" });
  imageStarted(); imageStarted(); imageDisplayed(); imageFailed("timeout");
  const summary = feedTraceSummary();
  assert.ok(summary, "有分页事件时摘要非空");
  const orig = summary.lists.find(l => l.list === "channel:original");
  const drama = summary.lists.find(l => l.list === "channel:ai-duanju");
  assert.equal(orig?.loadedPages, 2, "original 已加载页数与原始事件一致");
  assert.equal(orig?.lastState, "ready", "original 终态与原始事件一致");
  assert.equal(drama?.loadedPages, 1, "ai-duanju 已加载页数与原始事件一致（按列表隔离、不混算）");
  assert.ok(drama?.lastFail?.includes("error"), "ai-duanju 最近失败与原始事件一致");
  const snap = feedTraceSnapshot();
  assert.equal(snap.image.displayed, 1, "封面已显示计数与原始记录一致");
  assert.equal(snap.image.failed, 1, "封面失败计数与原始记录一致");
  assert.equal(snap.image.byReason.timeout, 1, "封面失败原因计数与原始记录一致");
  assert.equal(snap.image.inFlightPeak, 2, "封面在途峰值与原始记录一致");
}

/* ── ④ 源总览三态计数 ────────────────────────────────────────────── */
{
  const hostOf = (u: string): string => { try { return new URL(u).host || "?"; } catch { return "?"; } };
  const sources = [
    { origin: "https://a.example.com" },
    { origin: "https://b.example.com" },
    { origin: "https://c.example.com" },
    { origin: "" },
  ];
  const byHost = new Map([["a.example.com", { ok: true }], ["b.example.com", { ok: false }]]);
  const counts = countFetchStates(sources, byHost, hostOf);
  assert.deepEqual(counts, { ok: 1, fail: 1, none: 1, missing: 1 }, "成功/失败/未发生/记录缺失逐项与原始记录一致");
  assert.equal(counts.ok + counts.fail + counts.none + counts.missing, sources.length, "四计数之和＝源总数（无源被静默漏计）");
}

/* ── ⑤ 长按松手分组复核（F3 已修口径：账本保留窗全集） ─────────── */
{
  const hs = summarizeHoldEvents([
    { name: "hold.release_profile", data: { sr_engaged: true } },
    { name: "hold.jank", data: { sr_engaged: true } },
    { name: "hold.jank", data: { sr_engaged: false } },
  ]);
  assert.deepEqual(hs.engaged, { holds: 1, janks: 1 }, "SR 接管组与账本原始事件一致");
  assert.deepEqual(hs.bypass, { holds: 0, janks: 1 }, "判档直通组与账本原始事件一致");
}

/* ── 报告侧接线断言 ──────────────────────────────────────────────── */
{
  const report = readFileSync(new URL("./diagnosticReport.ts", import.meta.url), "utf8");
  assert.ok(report.includes("selectFlowSegment(entries)"), "analyzeFlow 经 selectFlowSegment 选段（不绑最后一行 pid）");
  assert.ok(
    (report.match(/await flushPlaybackLog\(\)/g) ?? []).length >= 2,
    "buildDiagnosticReport 与 buildFullDiagnosticExport 读日志前都先 flush 写队列（读到的不是过期快照）",
  );
  assert.ok(report.includes("ledgerPlaybackEvidence"), "最近播放/流水/降级结论与事件账本交叉核对");
  assert.ok(report.includes("诊断日志无完整播放段"), "日志无完整段但账本有播放时明示通道状态，不假报无记录（沿用日志状态明示体系）");
  const registry = readFileSync(new URL("../../features/sources/registryDiag.ts", import.meta.url), "utf8");
  assert.ok(registry.includes("countFetchStates("), "源总览三态计数走 countFetchStates 唯一口径");
  assert.ok(registry.includes("记录缺失 ${"), "源总览 L1 含记录缺失计数（>0 才印），无生效地址的源不漏计");
}

console.log("fix321-f3b-diagnostic-summary.contract: all assertions passed");
