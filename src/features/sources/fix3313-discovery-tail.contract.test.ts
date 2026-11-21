/**
 * fix3313/discovery-tail 契约（Muse 2026-11-21，任务书即维护者对新
 * 增测试的授权，不变量 11）。运行：
 *   node src/features/sources/fix3313-discovery-tail.contract.test.ts
 *
 * 背景：fix3312/discovery-b 收尾登记的三项未尽事项（见
 * fix3312/evidence/discovery-b-report.md 未尽事项节）：
 * ①条目卡片上的 tags 文案未汉化（汉化只落在发现行 chip）；
 * ②标签行内搜索只覆盖 taxonomy 已取回的 Top-100——006 等源
 *   Top-100 之外的千级长尾标签不可搜；
 * ③disc 落盘的 category/tag id 遇站方改 taxonomy id 时静默过滤
 *   为空列表——无自检、无留痕，下次导出无从判读。
 * 本契约逐项钉（A 卡片汉化／B 长尾搜索／C 失效自检），断言先在
 * 3.3.12 码（fix3312-integration @266a676）上证伪再转绿。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "./registry.ts";
import { createWpRestAdapter } from "./adapters/templates.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { mergeTaxonEntries, resolveStaleDiscFields } from "./discoveryOptions.ts";
import {
  cardTaxonSubtitle, serverTagSearchTerms, tagOptionMatchesQuery, taxonKeysForChineseQuery,
} from "./taxonLabels.ts";
import type { SourceDef, SourceTaxonomy } from "./types.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const def = (id: string): SourceDef => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};

/* ── (A) 卡片汉化：纯函数口径（源表优先/共享兜底/未收录回落） ── */
{
  assert.equal(cardTaxonSubtitle("xiuren", ["Maid"]), "女仆", "卡片标签经共享表汉化");
  assert.equal(cardTaxonSubtitle("xiuren", ["XiuRen"]), "秀人网", "卡片标签经源表汉化（源表优先）");
  assert.equal(cardTaxonSubtitle("xiuren", ["Hot Girl"]), "Hot Girl", "未收录（无公认中文名）回落原名");
  assert.equal(cardTaxonSubtitle("everia", ["Japan", "Maid", "Cosplay"]), "日本 · 女仆",
    "上限 2 条、连接符与旧副标题逐字一致");
  assert.equal(cardTaxonSubtitle("xiuren", []), "", "空标签 → 空串（宿主回落源名）");
  assert.equal(cardTaxonSubtitle("xiuren", undefined), "", "无标签 → 空串");
  const input = ["Maid", "XiuRen"];
  cardTaxonSubtitle("xiuren", input);
  assert.deepEqual(input, ["Maid", "XiuRen"], "只产出显示串、不改写条目数据（value 不变）");
}
/* ── (A) 接线：两浏览面卡片副标题经 cardTaxonSubtitle、旧裸文案已撤
 * （断言适配 fix3314：SourceBrowse 随视频板块删除退役）。 ── */
{
  for (const f of ["./SourceGallery.tsx", "./SourcePosts.tsx"]) {
    const src = read(f);
    assert.ok(src.includes("cardTaxonSubtitle"), `${f} 卡片副标题接汉化`);
    assert.ok(!src.includes('item.tags?.slice(0, 2).join(" · ")'), `${f} 旧裸 tags 副标题已撤`);
  }
}

/* ── (B) 服务端补取：wp-rest searchTags 经 tags 端点 search 参数 ── */
{
  const urls: string[] = [];
  setFetchPage(async (url) => {
    urls.push(url);
    if (url.includes("/tags?") && url.includes("search=")) {
      return JSON.stringify([{ id: 29, name: "MiiTao", count: 22 }]);
    }
    if (url.includes("/tags?")) {
      return JSON.stringify([
        { id: 7, name: "长腿", count: 99 }, { id: 56, name: "Maid", count: 80 },
      ]);
    }
    if (url.includes("/categories?")) return JSON.stringify([{ id: 23, name: "Hot Girl", count: 50 }]);
    throw new Error(`unexpected url ${url}`);
  });
  const adapter = createWpRestAdapter(def("xiuren"));
  assert.equal(typeof adapter.searchTags, "function", "wp-rest 适配器实现 searchTags");
  const tax = await adapter.taxonomy!();
  assert.ok(!tax.tags.some((t) => t.id === "29"), "长尾前提：taxonomy Top-100 不含 id 29");
  const found = await adapter.searchTags!("miitao");
  assert.deepEqual(found, [{ id: "29", name: "MiiTao", count: 22 }], "searchTags 回长尾标签（id 字符串化、计数保留）");
  const searchUrl = urls.find((u) => u.includes("search=")) ?? "";
  assert.ok(searchUrl.includes("/tags?") && searchUrl.includes("search=miitao") && searchUrl.includes("per_page=100"),
    "补取走 tags 端点 search 参数、per_page=100");
  /* 合并：本地已加载项与服务端补取按 id 去重、先到先得、序稳定 */
  const merged = mergeTaxonEntries(tax.tags, [...found, ...found]);
  assert.equal(merged.filter((t) => t.id === "29").length, 1, "合并后长尾标签恰一份");
  assert.deepEqual(merged.slice(0, 2), tax.tags, "本地项序不变、补取项殿后");
  /* Top-100 内原有搜索行为不变：本地匹配口径逐字沿用 */
  const maid = tax.tags.find((t) => t.id === "56")!;
  assert.equal(tagOptionMatchesQuery({ value: maid.id, label: maid.name }, "mai", taxonKeysForChineseQuery("mai")), true,
    "Top-100 内标签本地子串匹配不变");
  assert.equal(tagOptionMatchesQuery({ value: "29", label: "MiiTao" }, "蜜桃社", taxonKeysForChineseQuery("蜜桃社")), true,
    "补取项经中文反查命中（与本地项同口径）");
}
/* ── (B) 搜索词派生：非中文直搜原词、中文经反查键补搜英文原名 ── */
{
  assert.deepEqual(serverTagSearchTerms("MiiTao"), ["MiiTao"], "英文词直搜原词");
  assert.deepEqual(serverTagSearchTerms("  "), [], "空词不发请求");
  const zhTerms = serverTagSearchTerms("蜜桃社");
  assert.ok(zhTerms.includes("miitao"), "中文词派生反查键 miitao（006 源表译名）");
  assert.ok(zhTerms.length <= 3, "派生词数有上限、不放大请求");
  assert.ok(!zhTerms.some((t) => /[^\x00-\x7F]/.test(t)), "派生词不含中文（端点按英文名检索）");
}
/* ── (B) 接线：DiscoveryBar 消费 searchTags＋合并池、types 登记能力 ── */
{
  const bar = read("./DiscoveryBar.tsx");
  assert.ok(bar.includes("searchTags"), "DiscoveryBar 搜索态消费 searchTags 补取");
  assert.ok(bar.includes("mergeTaxonEntries"), "DiscoveryBar 标签池＝本地＋补取合并");
  assert.ok(read("./types.ts").includes("searchTags"), "SourceAdapter 登记 searchTags 能力");
}

/* ── (C) 失效判定纯函数：名单内保留、名单外看探针三态 ── */
{
  const tax: SourceTaxonomy = {
    categories: [{ id: "23", name: "Hot Girl" }],
    tags: [{ id: "7", name: "长腿" }],
  };
  assert.deepEqual(
    await resolveStaleDiscFields({ category: "23", tag: "7" }, tax, async () => false),
    { next: { category: "23", tag: "7" }, staleFields: [] },
    "名单内全保留（探针不参与）");
  assert.deepEqual(
    await resolveStaleDiscFields({ category: "23", tag: "999" }, tax, async () => false),
    { next: { category: "23" }, staleFields: ["tag"] },
    "名单外＋探针明确不存在（404）→ 回落为空并记失效字段");
  assert.deepEqual(
    await resolveStaleDiscFields({ tag: "999" }, tax, async () => true),
    { next: { tag: "999" }, staleFields: [] },
    "名单外＋探针证实在 → 保留（Top-100 窗口外的真标签不误清）");
  assert.deepEqual(
    await resolveStaleDiscFields({ tag: "999" }, tax, async () => null),
    { next: { tag: "999" }, staleFields: [] },
    "名单外＋探针未知（网络失败）→ 保留（未知不是空）");
  assert.deepEqual(
    await resolveStaleDiscFields({ category: "555" }, tax, null),
    { next: {}, staleFields: ["category"] },
    "无探针适配器（taxonomy 即全集）名单外 → 回落为空");
  assert.deepEqual(
    (await resolveStaleDiscFields({ sort: "date-asc", tag: "999" }, tax, async () => false)).next,
    { sort: "date-asc" },
    "只清失效的 taxonomy 字段、sort/period 不受牵连");
}
/* ── (C) wp-rest taxonExists 三态：200 在／404 不在／其余未知 ── */
{
  setFetchPage(async (url) => {
    if (url.includes("/tags/999")) throw new Error("HTTP 404");
    if (url.includes("/tags/7")) return JSON.stringify({ id: 7, name: "长腿" });
    if (url.includes("/categories/555")) throw new Error("connection reset");
    throw new Error(`unexpected url ${url}`);
  });
  const adapter = createWpRestAdapter(def("xiuren"));
  assert.equal(typeof adapter.taxonExists, "function", "wp-rest 适配器实现 taxonExists");
  assert.equal(await adapter.taxonExists!("tag", "7"), true, "端点 200 → 在");
  assert.equal(await adapter.taxonExists!("tag", "999"), false, "端点 HTTP 404 → 明确不在");
  assert.equal(await adapter.taxonExists!("category", "555"), null, "网络错误 → 未知（不清值）");
}
/* ── (C) 接线：DiscoveryBar 自检消费＋诊断账本留痕 ── */
{
  const bar = read("./DiscoveryBar.tsx");
  assert.ok(bar.includes("resolveStaleDiscFields"), "DiscoveryBar 消费失效判定");
  assert.ok(bar.includes("taxonExists"), "DiscoveryBar 名单外走存在性探针");
  assert.ok(bar.includes("disc.taxon_stale"), "失效回落经既有诊断账本留痕（导出可判读）");
  assert.ok(read("./types.ts").includes("taxonExists"), "SourceAdapter 登记 taxonExists 能力");
}

console.log("fix3313-discovery-tail contract: PASS");
