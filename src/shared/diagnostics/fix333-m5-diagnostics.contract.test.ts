/**
 * 诊断补齐契约（Muse 2026-11-20 fix333-m5 线；新增测试经本批任务书
 * 授权——用户 11:10 亲令残余清剿、任务书明列「契约钉四件各自的不
 * 变量」，AGENTS 不变量 11 的任务书授权口径与既有 fix33x 契约同例）。
 * 运行：node src/shared/diagnostics/fix333-m5-diagnostics.contract.test.ts
 *
 * 背景：fix332 清扫记账四条诊断残余——P5 取流分段留痕只有 002 有
 * 且只躺导出尾部原始日志（010/011/012 无段级留痕）；O1 图片失败
 * 双段并存（事件逐图行 6 条 vs 明细环 12 条、字段口径不同，易误计
 * 为两批失败）；O2 自检 requests 计适配器调用数却裸称「请求数」、
 * 与真实网络量对不上；O4 段位标签表只含三面，gallery/source-list
 * 在导出露英文原名。本契约钉四件：
 * (1) P5：四源 resolve 段失败同落 source.resolve_fail（组装纯函数
 *     键集合封闭＋三源段调用点齐全），导出有结构化留痕节消费之
 *     （resolveFailSectionLines 行为：双事件名形态兼容＝旧日志可读、
 *     段名中文标签、汇总＋最近 12 条）；
 * (2) O1：导出逐图只剩明细环单段（事件逐图行不复活、明细段在位）；
 * (3) O2：自检呈现恒带「适配器调用口径」标注（单源段＋汇总定义行）；
 * (4) O4：imageSurfaceLabel 六面中文标签齐全、未知回落原值；导出
 *     分桶行与明细行共用该标签函数、无本地残表。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveFailureEventData } from "../../features/sources/adapters/resolveTrace.ts";
import { resolveFailSectionLines } from "./resolveFailLines.ts";
import { imageSurfaceLabel } from "../lib/feedTrace.ts";
import { selfCheckDiagLines, selfCheckSegmentText, type SourceSelfCheckResult } from "../../features/sources/healthCheck.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* ── (1) P5：组装纯函数键集合封闭（与 002 原口径逐字一致） ── */
{
  assert.deepEqual(
    resolveFailureEventData("source-011", "fetch", "stream_fetch_failed", 403, 0),
    { source: "source-011", segment: "fetch", code: "stream_fetch_failed", status: 403, attempt: 0 },
    "留痕数据：编号/段名/固定码/状态/尝试序",
  );
  const noStatus = resolveFailureEventData("source-010", "decode", "stream_unavailable", undefined, 0);
  assert.deepEqual(Object.keys(noStatus).sort(), ["attempt", "code", "segment", "source"], "无状态时 status 键整缺、键集合封闭");
}

/* ── (1) P5：段调用点齐全（源码断言，仿既有契约先例；
 * 断言适配 fix338/registry-cut：011 已摘除，其 episode 段留痕随
 * 适配器同删、改验负向；留痕规模 13→10 点。
 * 断言适配 fix339/registry-cut-2：009/010 已摘除，templates.ts 内
 * 留痕调用点随两适配器删码全数退役；生产调用方收敛为 002
 * （hanimeApi.ts，csrf/handshake/decode 三段 6 点），本节改钉
 * hanimeApi 在位＋templates 负向，设施覆盖不降。
 * 断言适配 fix3310/video-add-2：009/010 试装恢复，templates.ts 内
 * 留痕调用点随两适配器原样回滚（010 detail/fetch/decode 段、009
 * watch/download 段），本节改钉两文件均在位；011 episode 段不
 * 恢复、负向不变）
 * 断言适配 fix3311/registry-cleanup：009 试装判删回，其 watch/
 * download 段留痕随适配器同删、改验负向（与 011 episode 同口
 * 径）；010 三段在位不变） ── */
{
  /* 断言适配（fix3314）：002 hanimeApi 与 010 wp-rest jw 分支随视
   * 频板块整组删除退场，traceResolveFailure 的生产调用点全数消
   * 失；设施定义（resolveTrace.ts）与读侧（留痕节）保留在位——
   * 写侧无调用方这一事实记入 fix3314 审计登记（瘦身候选），本节
   * 改钉「定义在位＋全部旧段负向」。 */
  const rt = read("../../features/sources/adapters/resolveTrace.ts");
  assert.ok(rt.includes("export function traceResolveFailure"), "留痕设施定义保留在位（fix3314 审计登记其写侧无调用方）");
  const tpl = read("../../features/sources/adapters/templates.ts");
  assert.ok(!tpl.includes("traceResolveFailure"), "templates 留痕调用点已随 jw 分支退场（fix3314）");
  for (const seg of ["detail", "fetch", "decode", "watch", "download", "episode", "csrf", "handshake"]) {
    assert.ok(!tpl.includes(`traceResolveFailure(def.id, "${seg}"`), `段 ${seg} 留痕不在 templates（fix3314）`);
  }
  assert.throws(() => read("../../features/sources/adapters/hanimeApi.ts"), "hanimeApi.ts 已整删（fix3314）");
}

/* ── (1) P5：结构化留痕节行为 ── */
{
  type E = { event: string; ts: number; data: Record<string, unknown> };
  const ev = (event: string, data: Record<string, unknown>): E => ({ event, ts: 1_700_000_000_000, data });
  assert.deepEqual(resolveFailSectionLines([]), ["无记录（本会话无取流段失败）"], "无事件明示无记录、不塌缩");
  assert.deepEqual(
    resolveFailSectionLines([ev("web.media.playing", {})]),
    ["无记录（本会话无取流段失败）"],
    "无关事件不入留痕节",
  );
  const lines = resolveFailSectionLines([
    ev("web.source.resolve_fail", { source: "source-002", segment: "handshake", code: "handshake_http_error", status: 403, attempt: 0 }),
    ev("source.resolve_fail", { source: "source-011", segment: "fetch", code: "stream_fetch_failed", attempt: 0 }),
    ev("web.source.resolve_fail", { source: "source-012", segment: "episode", code: "episode_fetch_failed", status: 502, attempt: 0 }),
  ]);
  assert.equal(lines[0], "共 3 条（最近 3 条）：", "汇总行计数口径");
  assert.ok(lines[1].includes("取流失败[source-002]") && lines[1].includes("握手段") && lines[1].includes("HTTP 403") && lines[1].includes("第 1 次尝试"), "002 行：编号/中文段名/状态/尝试序齐全");
  assert.ok(lines[2].includes("流表取数段") && !lines[2].includes("HTTP"), "011 行：无状态不假报 HTTP");
  assert.ok(lines[3].includes("集页取数段") && lines[3].includes("HTTP 502"), "012 行：集页段中文标签");
  const many = resolveFailSectionLines(
    Array.from({ length: 15 }, (_, i) => ev("web.source.resolve_fail", { source: "source-010", segment: "watch", code: `c${i}`, attempt: 0 })),
  );
  assert.equal(many.length, 13, "超 12 条只印最近 12 条＋汇总行");
  assert.equal(many[0], "共 15 条（最近 12 条）：", "汇总行报全量计数");
  assert.ok(many[1].includes("· c3 ·") || many[1].includes("c3"), "窗口从第 4 条起（最近 12）");
  const report = read("./diagnosticReport.ts");
  assert.ok(report.includes("── 取流失败留痕"), "导出有取流失败留痕节");
  assert.ok(report.includes("resolveFailSectionLines(entries)"), "留痕节消费全量解析日志（非尾段切片）");
}

/* ── (2) O1：逐图单段 ── */
{
  const report = read("./diagnosticReport.ts");
  assert.ok(report.includes("snap.imageFailures.slice(-12)"), "逐图明细环仍被消费（留痕不丢）");
  assert.ok(report.includes("图片失败明细（最近"), "逐图明细节在位");
  assert.ok(!report.includes("图片失败["), "事件逐图行已删、双段不复活");
  assert.ok(!report.includes("imgFinalFails"), "事件逐图行变量不复活");
}

/* ── (3) O2：自检呈现口径标注 ── */
{
  /* 夹具指纹字段随 M7 三维指纹形状（3.3.3 集成轮对账修订：M7 改型
   * 后本契约旧形状 manifestVersion/appVersion 与 selfCheckDiagLines
   * 五参调用只在类型层过期，O2 断言内容不变）。 */
  const fixture: SourceSelfCheckResult = {
    sourceId: "fixture", at: 1_700_000_000_000, listOk: true, itemCount: 7,
    listFailure: null, paging: "skipped", pagingFailure: null,
    detail: "ok", detailFailure: null,
    tail: "ok", tailKind: "stream", tailFailure: null,
    protocolVersion: 1, adapterEpoch: 1, sourceScope: "fixture-scope", requests: 3,
  };
  const seg = selfCheckSegmentText(fixture);
  assert.ok(seg.includes("请求 3 次（适配器调用口径）"), "单源段恒带请求数＋口径标注");
  const lines = selfCheckDiagLines(
    [{ id: "fixture", stableId: "source-099" }],
    { fixture },
    1_700_000_000_000,
  );
  assert.ok(lines[0].includes("请求数＝适配器调用口径"), "汇总行带口径定义");
  assert.ok(lines[0].includes("一次调用内可含多次 HTTP"), "汇总行定义含 HTTP 关系说明");
  assert.ok(lines[1].includes("请求 3 次（适配器调用口径）"), "逐源行同口径");
}

/* ── (4) O4：面中文标签 ── */
{
  assert.equal(imageSurfaceLabel("source-posts"), "外部源·吃瓜列表");
  assert.equal(imageSurfaceLabel("source-browse"), "外部源·视频列表");
  assert.equal(imageSurfaceLabel("posts-native"), "原生吃瓜列表");
  assert.equal(imageSurfaceLabel("gallery"), "图集", "图集面中文标签（原露英文）");
  assert.equal(imageSurfaceLabel("source-list"), "外部源·图集列表", "源图集列表面中文标签（原露英文）");
  assert.equal(imageSurfaceLabel("app"), "应用内");
  assert.equal(imageSurfaceLabel("未标注"), "未标注", "未标注桶保持原样");
  assert.equal(imageSurfaceLabel("some-future-surface"), "some-future-surface", "未知面回落原值、不假译");
  const report = read("./diagnosticReport.ts");
  assert.ok(report.includes("imageSurfaceLabel(surface)"), "分桶行共用标签函数");
  assert.ok(report.includes("imageSurfaceLabel(f.surface)"), "明细行共用标签函数");
  assert.ok(!report.includes("imgSurfaceLabels"), "报告本地残表已删、标签单一出处");
}

console.log("fix333-m5-diagnostics contract: all passed");
