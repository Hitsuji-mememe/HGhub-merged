/**
 * 取页观测契约（Muse 2026-11-20 fix336-a 线；新增测试依据：仓库
 * 不变量 11——本批属「修复既有行为的回归钉」：诊断导出补取页观测
 * 是 fix336 调查任务一点名的导出缺口修复，任务书明列「给一条契约
 * 钉住新节存在与字段」，与既有 fix33x 诊断契约同例）。
 * 运行：node src/shared/diagnostics/fix336-fetch-observations.contract.test.ts
 *
 * 背景：真机五个 Cloudflare 前置源取页网络类全灭，最后一公里证据
 * （network.resolve 的解析分支、network.target_failed 的失败阶段）
 * 一直躺在播放日志里、诊断导出从未汇编；逐源失败也只有类别没有
 * 原文。本契约钉三件：
 * (1) fetchObservationSectionLines 行为：resolve 按 host 汇最近一条
 *     （首现序编号、零域名出门）、target_failed 按 resource 汇
 *     计数/阶段/错误类、两类皆无时单行明示；
 * (2) 逐源错误原文 provider 两态：未注册＝null（报告标未接）、
 *     已注册＝行组（可为空数组），不许混；
 * (3) 接线文本钉：诊断报告新节在位且在取流失败留痕之后、报告头
 *     「诊断原则」已把取页观测列入已接入（不再挂未接入）、main.tsx
 *     注册错误 provider、registryDiag 备好实现、fetchHealth 记录
 *     带 error 字段与清洗函数。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fetchObservationSectionLines } from "./fetchObservations.ts";
import {
  registerSourceFetchErrorProvider,
  sourceFetchErrorLines,
} from "./sourceRegistry.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* ── (1) 汇编行为 ── */
{
  assert.deepEqual(
    fetchObservationSectionLines([]),
    ["无记录（本会话无取页解析/目标失败记录）"],
    "无记录时单行明示",
  );
  const T = (s: string) => Date.parse(`2026-11-20T10:00:${s}Z`);
  const lines = fetchObservationSectionLines([
    { event: "network.resolve", ts: T("01"), data: { host: "alpha.example.com", kinds: ["fake"], count: 1, all_fake: true, branch: "fake_trusted" } },
    { event: "network.resolve", ts: T("02"), data: { host: "beta.example.org", kinds: ["v4"], count: 2, all_fake: false, branch: "system" } },
    { event: "network.resolve", ts: T("03"), data: { host: "alpha.example.com", kinds: ["v4", "v6"], count: 3, all_fake: false, branch: "system_raced" } },
    { event: "network.target_failed", ts: T("04"), data: { resource: "r0123abcd", phase: "connect", error_kind: "connect" } },
    { event: "network.target_failed", ts: T("05"), data: { resource: "r0123abcd", phase: "tls", error_kind: "tls" } },
    { event: "network.target_failed", ts: T("06"), data: { resource: "r9999ffff", phase: "connect", error_kind: "dns" } },
    { event: "web.play.resolve", ts: T("07"), data: { host: "ignored.example.net" } },
  ]);
  assert.equal(lines.length, 4, "2 条解析行＋2 条目标失败行");
  assert.match(lines[0], /^解析\[host-01\]：最近 kinds=v4\/v6 · branch=system_raced · 全假地址=否 · 地址 3 个 · 共 2 条 · /,
    "同 host 取最近一条、条数累计、首现序编号");
  assert.match(lines[1], /^解析\[host-02\]：最近 kinds=v4 · branch=system · 全假地址=否 · 地址 2 个 · 共 1 条 · /,
    "第二 host 编号 host-02");
  assert.match(lines[2], /^目标失败\[r0123abcd\]：2 次 · 阶段 connect\/tls · 错误类 connect\/tls · 最近 /,
    "同 resource 汇计数与阶段/错误类集合、按次数降序在前");
  assert.match(lines[3], /^目标失败\[r9999ffff\]：1 次 · 阶段 connect · 错误类 dns · 最近 /,
    "单次目标失败行");
  const joined = lines.join("\n");
  assert.ok(!joined.includes("example.com") && !joined.includes("example.org") && !joined.includes("example.net"),
    "零域名出门：host 只以编号呈现、无关事件不入节");
}

/* ── (2) 错误 provider 两态 ── */
{
  assert.equal(sourceFetchErrorLines(), null, "未注册时为 null（报告标未接）");
  registerSourceFetchErrorProvider(() => []);
  assert.deepEqual(sourceFetchErrorLines(), [], "已注册无错误时为空数组（与未接分明）");
  registerSourceFetchErrorProvider(() => ["取页错误[source-008]：网络类 · 样例 · 10:00:00"]);
  assert.equal(sourceFetchErrorLines()?.length, 1, "已注册有错误时出行组");
}

/* ── (3) 接线文本钉 ── */
{
  const report = read("./diagnosticReport.ts");
  const idxFail = report.indexOf("── 取流失败留痕");
  const idxObs = report.indexOf("── 取页观测（解析与目标失败）");
  assert.ok(idxFail >= 0 && idxObs > idxFail, "取页观测节在位且位于取流失败留痕之后");
  assert.ok(report.includes("fetchObservationSectionLines(entries)"), "观测节消费全量解析日志");
  assert.ok(report.includes("取页观测（解析分支与目标失败＋逐源最近取页错误原文）"),
    "报告头已接入清单含取页观测");
  assert.ok(!report.includes("未接入：源取页观测链"), "取页观测不再挂未接入");
  const main = read("../../main.tsx");
  assert.ok(main.includes("registerSourceFetchErrorProvider(() => sourceFetchErrorLines())"),
    "main.tsx 注册逐源错误 provider");
  const diag = read("../../features/sources/registryDiag.ts");
  assert.ok(diag.includes("export function sourceFetchErrorLines()"), "registryDiag 备好错误行实现");
  const health = read("../../features/sources/adapters/fetchHealth.ts");
  assert.ok(health.includes("error: string | null") && health.includes("export function sanitizeFetchError"),
    "fetchHealth 记录带清洗后的失败原文");
}

console.log("fix336-fetch-observations contract ok");
