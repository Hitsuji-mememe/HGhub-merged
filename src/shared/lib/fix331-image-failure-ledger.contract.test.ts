/**
 * 逐图终局失败明细契约测试（Muse 2026-11-20 fix331/gallery-device 线；
 * 新增测试经任务书授权——用户 01:06 验收门槛：逐图失败留痕进诊断
 * 导出，下一轮靠数据定位不靠截图。AGENTS 不变量 11 的任务书授权口径
 * 与既有 fix330 契约同例）。
 * 运行：node src/shared/lib/fix331-image-failure-ledger.contract.test.ts
 *
 * 背景（3.3.1 真机诊断判读 device-diag-331-analysis）：诊断里图片只有
 * 一行聚合（已显示 159 · 终局失败 45 · 在途峰值 17），图集会话零明细
 * ——坏在哪张、死在哪段、烧了几次 attempt 全不可见。本测试钉四件事：
 * ①终局失败逐条入环：面标注/host 指纹/段位/attempt 数/双耗时档齐全，
 *   且记录里不出现 URL 全文（只 host#长度指纹）；
 * ②环有界 48：溢出丢最旧、保最新；
 * ③耗时档边界：<1s / 1-5s / 5-20s / 20-60s / >60s 分界逐点；
 * ④生产接线以源码断言钉住：Img 两终局点调用记录、SourceGallery 面
 *   标注两态、诊断导出消费 snapshot.imageFailures 并输出明细节。
 * 旧码（基线 f341437）无 recordImageFailure 导出，import 即红。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  feedTraceSnapshot,
  msBucket,
  recordImageFailure,
  setImageTraceSurface,
  urlFingerprint,
} from "./feedTrace.ts";

/* ── ③ 耗时档边界 ─────────────────────────────────────────────── */
assert.equal(msBucket(0), "<1s");
assert.equal(msBucket(999), "<1s");
assert.equal(msBucket(1000), "1-5s");
assert.equal(msBucket(4999), "1-5s");
assert.equal(msBucket(5000), "5-20s");
assert.equal(msBucket(19999), "5-20s");
assert.equal(msBucket(20000), "20-60s");
assert.equal(msBucket(59999), "20-60s");
assert.equal(msBucket(60000), ">60s");

/* ── ① 逐条入环＋面标注＋无 URL 全文 ───────────────────────────── */
setImageTraceSurface("gallery");
recordImageFailure({
  fp: urlFingerprint("https://images.example.net/album/0001.jpg?sign=SECRET"),
  stage: "error-event",
  reason: "network",
  attempts: 3,
  totalMs: 2600,
  lastMs: 900,
});
{
  const snap = feedTraceSnapshot();
  assert.equal(snap.imageFailures.length, 1);
  const r = snap.imageFailures[0];
  assert.equal(r.surface, "gallery", "面标注取记录时刻的当前面");
  assert.equal(r.fp, "images.example.net#53", "只留 host#长度指纹");
  assert.ok(!JSON.stringify(r).includes("SECRET"), "记录不含 URL 查询与令牌形态");
  assert.ok(!JSON.stringify(r).includes("album"), "记录不含 URL 路径");
  assert.equal(r.stage, "error-event");
  assert.equal(r.reason, "network");
  assert.equal(r.attempts, 3);
  assert.equal(r.totalBucket, "1-5s");
  assert.equal(r.lastBucket, "<1s");
}

/* ── ② 环有界 48、丢最旧保最新 ────────────────────────────────── */
setImageTraceSurface("source-list");
for (let i = 0; i < 60; i++) {
  recordImageFailure({
    fp: `h${i}.example#10`,
    stage: "attempt-timeout",
    reason: "timeout",
    attempts: 3,
    totalMs: 61000,
    lastMs: 20000,
  });
}
{
  const snap = feedTraceSnapshot();
  assert.equal(snap.imageFailures.length, 48, "环上限 48");
  assert.equal(snap.imageFailures[0].fp, "h12.example#10", "最旧 12 条已被丢弃（1 gallery + 60 本轮，先溢 13 中的环内序号）");
  assert.equal(snap.imageFailures[47].fp, "h59.example#10", "最新一条在环尾");
  assert.equal(snap.imageFailures[47].surface, "source-list");
  assert.equal(snap.imageFailures[47].totalBucket, ">60s");
}
setImageTraceSurface("app");

/* ── ④ 生产接线源码断言 ───────────────────────────────────────── */
const ui = readFileSync(new URL("../ui/ui.tsx", import.meta.url), "utf8");
assert.ok((ui.match(/recordImageFailure\(/g) ?? []).length >= 2, "Img 两终局点（时钟/错误事件）都记录明细");
const gallery = readFileSync(new URL("../../features/sources/SourceGallery.tsx", import.meta.url), "utf8");
assert.ok(gallery.includes('setImageTraceSurface(album?.phase === "ready" ? "gallery" : "source-list")'), "SourceGallery 两态面标注在位");
const report = readFileSync(new URL("../diagnostics/diagnosticReport.ts", import.meta.url), "utf8");
assert.ok(report.includes("snap.imageFailures.slice(-12)"), "诊断导出消费失败明细环");
assert.ok(report.includes("图片失败明细（最近"), "诊断导出有图片失败明细节标题行");

console.log("fix331-image-failure-ledger.contract: all assertions passed");
