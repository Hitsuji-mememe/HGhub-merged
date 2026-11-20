/**
 * 图片失败留痕契约（Muse 2026-11-20 fix331/covers-header；本批任务书
 * 即维护者对新增测试的授权，AGENTS 不变量 11）。
 * 运行：node src/shared/diagnostics/fix331-image-trace.contract.test.ts
 *
 * 背景：3.3.1 真机诊断「封面：已显示 159 · 终局失败 45（全 network）」
 * 只有全局一行——失败不归属面、逐图无行，源列表/图集的失败在报告
 * 里等于不存在（device-diag-331-analysis）。本契约钉：
 * (1) feedTrace 聚合按段位分桶（imageDisplayed/imageFailed 的
 *     surface 参数），全局总数口径不变、未标段位归「未标注」；
 * (2) 逐图终局失败事件的字段口径（ev=failed/error ∧ final=true ∧
 *     surface/origin/reason/attempt/ms）足以被导出逐行渲染——origin
 *     是包装前地址的 host#长度指纹、不含完整 URL；
 * (3) 诊断导出源码确实消费 bySurface（防接线脱落）；逐图逐行渲染
 *     已由 fix333-m5 O1 收敛为 imageFailures 明细单段（信息更全），
 *     本条随之改钉明细段在位＋事件逐图行不复活。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { traceFeed, imageStarted, imageDisplayed, imageFailed, feedTraceSnapshot, urlFingerprint } from "../lib/feedTrace.ts";

{
  imageStarted(); imageStarted(); imageStarted();
  imageDisplayed("source-posts");
  imageDisplayed("source-posts");
  imageFailed("network", "source-posts");
  imageFailed("network", "source-browse");
  imageFailed("timeout");
  const snap = feedTraceSnapshot();
  assert.equal(snap.image.displayed, 2, "全局已显示口径不变");
  assert.equal(snap.image.failed, 3, "全局终局失败口径不变");
  assert.equal(snap.image.byReason.network, 2, "全局按形态计数口径不变");
  const posts = snap.image.bySurface["source-posts"];
  assert.ok(posts, "段位 source-posts 必须有分桶");
  assert.equal(posts.displayed, 2, "段位已显示计数");
  assert.equal(posts.failed, 1, "段位终局失败计数");
  assert.equal(posts.byReason.network, 1, "段位按形态计数");
  const browse = snap.image.bySurface["source-browse"];
  assert.equal(browse?.failed, 1, "source-browse 分桶独立、不混算");
  const unset = snap.image.bySurface["未标注"];
  assert.equal(unset?.failed, 1, "未标段位归「未标注」桶");
  assert.equal(unset?.byReason.timeout, 1, "未标注桶形态计数");
}

{
  /* 逐图终局失败：导出过滤谓词 (ev=failed|error ∧ final) 必须恰好
   * 命中终局行，attempt 级失败不冒充终局。 */
  traceFeed("image", { ev: "failed", attempt: 0, reason: "timeout", ms: 20000, surface: "source-posts", origin: "pic.fixture.invalid#52", final: false });
  traceFeed("image", { ev: "error", attempt: 2, reason: "network", ms: 3200, surface: "source-posts", origin: "pic.fixture.invalid#52", final: true });
  traceFeed("image", { ev: "decoded", attempt: 0, surface: "source-posts", origin: "pic.fixture.invalid#52" });
  const snap = feedTraceSnapshot();
  const finals = snap.events.filter(e => e.kind === "image" && (e.data.ev === "failed" || e.data.ev === "error") && e.data.final === true);
  assert.equal(finals.length, 1, "终局谓词只命中终局失败行");
  const d = finals[0].data;
  assert.equal(d.surface, "source-posts", "终局行带段位");
  assert.equal(d.reason, "network", "终局行带形态");
  assert.equal(d.attempt, 2, "终局行带 attempt（0 基，导出 +1 显示）");
  assert.equal(d.origin, "pic.fixture.invalid#52", "终局行带源指纹（host#长度）");
  assert.ok(!String(d.origin).includes("http"), "指纹不含完整 URL");
  assert.equal(urlFingerprint("https://pic.fixture.invalid/upload/x.jpg"), "pic.fixture.invalid#40", "指纹口径＝host#长度");
}

{
  const src = readFileSync(new URL("./diagnosticReport.ts", import.meta.url), "utf8");
  assert.ok(src.includes("snap.image.bySurface"), "导出必须消费段位分桶");
  /* 逐图呈现收敛（fix333-m5 O1）：导出逐行渲染改走 imageFailures
   * 明细环单段（12 条、双耗时档＋stage），原事件逐图行（6 条、单
   * 耗时档）已删——同一失败双段并存易被误计为两批。防脱落断言
   * 随之改钉明细段，并钉事件逐图行不复活。 */
  assert.ok(src.includes("snap.imageFailures.slice(-12)"), "导出必须逐行印终局失败（明细环单段）");
  assert.ok(src.includes("图片失败明细（最近"), "导出逐图明细节标题在位");
  assert.ok(!src.includes("图片失败["), "事件逐图行已删、不许双段复活（m5 O1）");
}

console.log("fix331-image-trace contract: all passed");
