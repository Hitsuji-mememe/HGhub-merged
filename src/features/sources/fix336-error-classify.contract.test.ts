/**
 * 取页错误分类判序契约（Muse 2026-11-20 fix336 集成裁定；新增测试
 * 依据：仓库不变量 11——本批属「修复既有行为的回归钉」：集成任务书
 * 明列分类器判序修复并要求加契约钉住两条真值，与 fix336-a 契约同例）。
 * 运行：node src/features/sources/fix336-error-classify.contract.test.ts
 *
 * 背景：fix336 线 A 本机实拉中，三个源列表一次即败、错误原文均为
 * `Error: HTTP 403 Forbidden`——响应完整到达的干净 403，却被自检
 * 呈现为「失败·网络类」。根因在分类唯一出处 classifyFetchError 的
 * 判序：校验拒绝规则（含词元 forbidden）排在 HTTP 状态规则之前，
 * 403 的原因短语 Forbidden 先命中校验拒绝，再经 healthCheck 的
 * selfCheckFailureKind 归并为「网络类」。真机五源同为「网络类」
 * 全灭时，正是这条误标把「站点拒绝」与「连接被切断」混成一谈、
 * 掩盖了最后一公里判读。
 *
 * 本契约钉三件：
 * (1) 干净 HTTP 状态错误（含 403＋Forbidden 原因短语、404 带正文形）
 *     → classifyFetchError 判「HTTP 状态」、selfCheckFailureKind
 *     判「HTTP 状态」，不许再落校验拒绝/网络类；
 * (2) 连接级错误（reqwest err_text 链形态：Connect/tcp connect/
 *     Connection refused）→ classifyFetchError 判「网络不可达」、
 *     selfCheckFailureKind 判「网络类」；
 * (3) 防过修：真实校验拒绝（目标校验在发请求前拒绝、无状态码，
 *     样本取 Rust net/tests.rs 既有夹具串「禁止访问内网」）仍判
 *     「校验拒绝」→「网络类」，判序调整不许把校验路径吞掉。
 * 样本均为生产错误串真实形态，不访问网络。
 */
import assert from "node:assert/strict";
import { classifyFetchError } from "./adapters/fetchErrorClassify.ts";
import { selfCheckFailureKind } from "./healthCheck.ts";

/* ── (1) 干净 HTTP 状态：403 原因短语不得再劫持分类 ── */
{
  assert.equal(
    classifyFetchError("Error: HTTP 403 Forbidden"),
    "HTTP 状态",
    "403 Forbidden 必须判 HTTP 状态（线 A 实拉三源的错误原文形态）",
  );
  assert.equal(
    selfCheckFailureKind(new Error("Error: HTTP 403 Forbidden"), "list"),
    "HTTP 状态",
    "自检呈现必须单列 HTTP 状态、不许归并网络类",
  );
  assert.equal(
    classifyFetchError("HTTP 404 Not Found: <html>nginx</html>"),
    "HTTP 状态",
    "404 带正文形态（Rust net/tests.rs 既有夹具串）判 HTTP 状态",
  );
  assert.equal(
    classifyFetchError("HTTP 503 Service Unavailable"),
    "HTTP 状态",
    "503 判 HTTP 状态",
  );
}

/* ── (2) 连接级错误：仍归网络类 ── */
{
  const connectErr =
    "error sending request for url (https://example.invalid/posts.json) ← client error (Connect) ← tcp connect error ← Connection refused (os error 111)";
  assert.equal(
    classifyFetchError(connectErr),
    "网络不可达",
    "连接级错误（err_text 链形态）判网络不可达",
  );
  assert.equal(
    selfCheckFailureKind(new Error(connectErr), "list"),
    "网络类",
    "连接级错误自检归并网络类",
  );
  const dnsErr =
    "error sending request for url (https://example.invalid/posts.json) ← client error (Connect) ← dns error ← failed to lookup address information: Name or service not known";
  assert.equal(classifyFetchError(dnsErr), "网络不可达", "DNS 解析失败判网络不可达");
  assert.equal(selfCheckFailureKind(new Error(dnsErr), "list"), "网络类", "DNS 失败自检归并网络类");
}

/* ── (3) 真实校验拒绝不被判序调整吞掉 ── */
{
  assert.equal(
    classifyFetchError("禁止访问内网"),
    "校验拒绝",
    "目标校验拒绝（无状态码）仍判校验拒绝",
  );
  assert.equal(
    selfCheckFailureKind(new Error("禁止访问内网"), "list"),
    "网络类",
    "校验拒绝自检归并网络类（既有口径不变）",
  );
}

console.log("fix336-error-classify contract ok");
