/**
 * 3.3.3 残余清剿 M4 线契约测试（Muse 2026-11-20；本批任务书即
 * 维护者对新增测试的授权，AGENTS 不变量 11）。
 * 运行：node src/features/search/fix333-m4.contract.test.ts
 *
 * 覆盖两件事：
 * (1) 清扫 P4——搜索扇出失败 UI 零呈现：Search 此前只消费
 *     fanoutSearch 的 hits，failures 仅经 onFailure 落播放日志痕，
 *     部分源失败时用户看不出结果不完整、全部发起源失败时结果区
 *     与「无结果」不可区分。定版：扇出落定后经纯函数
 *     summarizeFanoutFailures 汇总（分母只计实际发起源——无搜索
 *     段源静默出局不入分母），Search 分部分/全部两形态呈现
 *     （点名失败源＋计数＋重试；全失败空态换失败文案）。
 * (2) list-noise 残余——卡片容器判据在搜索页的成立性：list 与
 *     search 共用 parseAnchorList，但搜索结果页 chrome 从未单独
 *     采样。本契约以列表页同批夹具驱动生产适配器 search 路径钉
 *     同口径排除；真实搜索页采样证据（003/004/005 各 3 词条页，
 *     漏入 0、误杀 0、005 的 missing 逐条归因推广过滤）在
 *     fix333/evidence/m4-search/。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fanoutSearch, summarizeFanoutFailures } from "./multiSourceSearch.ts";
import { getBuiltinRegistry } from "../sources/registry.ts";
import { setFetchPage } from "../sources/adapters/fetchPage.ts";
import { createChiguaAdapter } from "../sources/adapters/templates.ts";
import type { SourceAdapter, SourceDef, SourceItem } from "../sources/types.ts";

const def = (id: string): SourceDef => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};
const item = (sourceId: string, n: number): SourceItem => ({
  sourceId, externalId: `${sourceId}-${n}`, title: `条目${n}`, cover: "", href: "", tags: [],
});
const okAdapter = (id: string, n = 2): SourceAdapter => ({
  sourceId: id,
  list: async () => ({ items: [], pagination: { page: 1, pages: 1, size: 0, total: 0 } }),
  detail: async () => { throw new Error("unused"); },
  resolve: async () => { throw new Error("unused"); },
  search: async () => ({ items: Array.from({ length: n }, (_, i) => item(id, i + 1)), pagination: { page: 1, pages: 1, size: n, total: n } }),
});
const failAdapter = (id: string, message: string): SourceAdapter => ({
  sourceId: id,
  list: async () => { throw new Error("unused"); },
  detail: async () => { throw new Error("unused"); },
  resolve: async () => { throw new Error("unused"); },
  search: async () => { throw new Error(message); },
});

const d003 = def("51chigua");
const d005 = def("meiridasai");
const d004 = def("feedheiliao");

/* ── (1a) 部分失败：汇总点名失败源、全失败标志为假、分母＝发起源 ── */
{
  const adapters: Record<string, SourceAdapter> = {
    [d003.id]: failAdapter(d003.id, "HTTP 503"),
    [d005.id]: okAdapter(d005.id),
  };
  const out = await fanoutSearch("词", [d003, d005], (d) => adapters[d.id] ?? null);
  assert.equal(out.failures.length, 1, "失败恰一条");
  assert.equal(out.hits.length, 2, "成功源条目照常");
  const s = summarizeFanoutFailures(out.failures, [d003, d005], out.searched);
  assert.equal(s.total, 2, "分母＝实际发起源（成功＋失败）");
  assert.equal(s.allFailed, false, "部分失败不许报全失败");
  assert.equal(s.failed.length, 1);
  assert.equal(s.failed[0].sourceId, d003.id);
  assert.equal(s.failed[0].sourceName, d003.displayName, "呈现用注册表显示名、不外显内部 id");
  assert.equal(s.failed[0].message, "HTTP 503", "失败形态消息保留");
}

/* ── (1b) 全部失败：allFailed 成立、与无结果可区分 ── */
{
  const adapters: Record<string, SourceAdapter> = {
    [d003.id]: failAdapter(d003.id, "网络不可达"),
    [d005.id]: failAdapter(d005.id, "搜索超时"),
  };
  const out = await fanoutSearch("词", [d003, d005], (d) => adapters[d.id] ?? null);
  assert.equal(out.hits.length, 0);
  const s = summarizeFanoutFailures(out.failures, [d003, d005], out.searched);
  assert.equal(s.total, 2);
  assert.equal(s.allFailed, true, "发起源全灭必须判全失败");
  assert.deepEqual(new Set(s.failed.map((f) => f.sourceId)), new Set([d003.id, d005.id]), "失败源逐个点名");
}

/* ── (1c) 零失败：汇总为空、allFailed 为假 ── */
{
  const adapters: Record<string, SourceAdapter> = {
    [d003.id]: okAdapter(d003.id),
    [d005.id]: okAdapter(d005.id),
  };
  const out = await fanoutSearch("词", [d003, d005], (d) => adapters[d.id] ?? null);
  const s = summarizeFanoutFailures(out.failures, [d003, d005], out.searched);
  assert.equal(s.failed.length, 0);
  assert.equal(s.allFailed, false);
  assert.equal(s.total, 2);
}

/* ── (1d) 静默出局不入分母：无搜索段源（004）不发请求、不记失败，
 *      不许把其余源的全失败稀释成部分失败 ── */
{
  let called004 = false;
  const out = await fanoutSearch("词", [d003, d004], (d) => {
    if (d.id === d004.id) { called004 = true; return failAdapter(d.id, "不应被调用"); }
    return failAdapter(d.id, "网络不可达");
  });
  assert.equal(called004, false, "无搜索段源不许进扇出");
  assert.ok(!out.searched.includes(d004.id));
  const s = summarizeFanoutFailures(out.failures, [d003, d004], out.searched);
  assert.equal(s.total, 1, "分母只计发起源");
  assert.equal(s.allFailed, true, "唯一发起源失败＝全失败");
}

/* ── (1e) Search 接线：落定后汇总入 state、两形态呈现文案在位 ── */
{
  const src = readFileSync(new URL("./Search.tsx", import.meta.url), "utf8");
  assert.ok(src.includes("summarizeFanoutFailures(out.failures, defs, out.searched)"), "Search 必须消费 fanout 的 failures 汇总（P4 本体）");
  assert.ok(src.includes("setExtSummary"), "汇总必须入呈现 state");
  assert.ok(src.includes("个来源搜索失败"), "部分失败呈现（点名＋计数）在位");
  assert.ok(src.includes("外部来源全部搜索失败"), "全部失败 alert 行在位");
  assert.ok(src.includes("外部来源搜索全部失败"), "全部失败空态文案在位（与无结果区分）");
}

/* ── (2) 搜索路径容器判据：与列表同批夹具、同排除集 ── */
{
  const fx = (name: string) => readFileSync(new URL(`../sources/adapters/fixtures/${name}`, import.meta.url), "utf8");
  const searchHrefs = async (d: SourceDef, html: string): Promise<string[]> => {
    setFetchPage(async () => html);
    const res = await createChiguaAdapter(d).search!("词", 1, 60);
    return res.items.map((it) => it.href);
  };
  const h003 = await searchHrefs(d003, fx("chigua-list-nav-footer.html"));
  assert.ok(h003.length === 3 && h003.every((h) => ["/archives/101/", "/archives/102/", "/archives/103/"].some((p) => h.includes(p))),
    `搜索路径只许三张真卡，实际：${h003.join(",")}`);
  assert.ok(!h003.some((h) => h.includes("/archives/901/") || h.includes("/archives/902/") || h.includes("/archives/905/") || h.includes("/archives/904/")),
    "搜索页页眉导航/页脚站务/sponsored 锚点必须被容器判据杀掉（与列表同口径）");
  const h004 = await searchHrefs(d004, fx("heiliao-list-footer-ssp.html"));
  assert.ok(h004.length === 2 && h004.some((h) => h.includes("/archives/201/")) && h004.some((h) => h.includes("/archives/202/")),
    `搜索路径只许两张真卡，实际：${h004.join(",")}`);
  assert.ok(!h004.some((h) => h.includes("/archives/801/") || h.includes("/archives/802/") || h.includes("/archives/803/") || h.includes("/archives/996/")),
    "搜索页页脚组与 ssp 仿卡必须被杀掉（与列表同口径）");
}

console.log("fix333-m4-search contract: all assertions passed");
