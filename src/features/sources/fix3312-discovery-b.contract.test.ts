/**
 * fix3312/discovery-b 契约（Muse 2026-11-21，任务书即维护者对新
 * 增测试的授权，不变量 11）。运行：
 *   node src/features/sources/fix3312-discovery-b.contract.test.ts
 *
 * 背景（用户 2026-11-21 15:46/15:50 改令＋调查
 * fix3312/evidence/discovery-design-research.md 选项 B）：3.3.11
 * 图片面砍分类/标签行被真机实报「聚合源不可用」，发现设计整体
 * 改走选项 B——①恢复三行；②兴趣直达（disc 按源落盘、最近用过
 * 置顶、标签行内搜索中文反查）；③有限集汉化（只改显示层）。
 * 本契约按三段钉：一段一段追加，段内断言先在旧码上证伪再转绿。
 *
 * (A) 恢复三行·接线（源码文本断言，照 fix335 (D) 先例）：
 *     DiscoveryBar 无 noTaxonomyRows 门控、SourceGallery 不经
 *     stripDiscTaxonomy 派生 disc、types 无 stripDiscTaxonomy
 *     导出。证伪形态：3.3.11 码上三处皆在、断言全红。
 * (B) 恢复三行·适配器级实证（setFetchPage 录制 URL，照
 *     fix3311 (B) 先例）：图片源（006，wp-rest）的 disc
 *     category/tag 实际拼进列表请求——分类/标签筛选对图片面
 *     重新生效（与 (A) 的读取点直读合起来构成端到端恢复）。
 * (C) 登记与去重不回退：discoverySpecFor 对图片 WP 源仍登记
 *     categories＋tagFilter（回滚靠摘门控、不靠剥登记）；fix336
 *     同名标签去重 dedupeTagOptions 保留且 DiscoveryBar 仍消费。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "./registry.ts";
import { discoverySpecFor } from "./adapters/templateCapabilities.ts";
import { createWpRestAdapter } from "./adapters/templates.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { dedupeTagOptions } from "./discoveryOptions.ts";
import type { SourceDef } from "./types.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const def = (id: string): SourceDef => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};

/* ── (A) 门控与失效化已撤（3.3.11 码上全红） ── */
{
  const bar = read("./DiscoveryBar.tsx");
  assert.ok(!bar.includes("noTaxonomyRows"), "DiscoveryBar 无图片面门控 prop（fix3311 门控已撤）");
  assert.ok(bar.includes("discoverySpecFor(def)"), "DiscoveryBar 有效 spec 即登记 spec、无门控改写");

  const gallery = read("./SourceGallery.tsx");
  assert.ok(!gallery.includes("stripDiscTaxonomy"), "SourceGallery 不经 stripDiscTaxonomy 派生 disc（读取点直读）");
  assert.ok(!gallery.includes("noTaxonomyRows"), "SourceGallery 不传图片面门控");

  const types = read("./types.ts");
  assert.ok(!types.includes("stripDiscTaxonomy"), "types 无 stripDiscTaxonomy（失效化函数已删）");
}

/* ── (B) 图片源 disc 的 category/tag 实际过滤列表 ── */
{
  const posts = JSON.stringify([
    { id: 11, link: "https://xiuren.example/p11", title: { rendered: "帖十一" }, excerpt: { rendered: "" }, categories: [23], tags: [7] },
  ]);
  const urls: string[] = [];
  setFetchPage(async (url) => {
    urls.push(url);
    return url.includes("/categories?")
      ? JSON.stringify([{ id: 23, name: "Hot Girl", count: 50 }])
      : url.includes("/tags?")
        ? JSON.stringify([{ id: 7, name: "长腿", count: 99 }])
        : posts;
  });
  const a = createWpRestAdapter(def("xiuren"));
  await a.list(1, 20, { category: "23", tag: "7", sort: "date-asc" });
  const lastPostsUrl = urls.filter((u) => u.includes("/posts?")).pop();
  assert.equal(lastPostsUrl,
    "https://xiuren.biz/wp-json/wp/v2/posts?page=1&per_page=20&orderby=date&order=asc&categories=23&tags=7",
    "图片源 disc 的 category/tag 拼进列表请求（筛选恢复生效）");
}

/* ── (C) 登记表与 fix336 去重不回退 ── */
{
  for (const id of ["xiuren", "everia", "hentaiplay", "hanime-tv"]) {
    const spec = discoverySpecFor(def(id));
    assert.equal(spec.categories?.source, "taxonomy", `${id} 登记仍含 taxonomy 分类`);
    assert.equal(spec.tagFilter, true, `${id} 登记仍含 tagFilter`);
  }
  assert.equal(typeof dedupeTagOptions, "function", "fix336 dedupeTagOptions 保留");
  assert.ok(read("./DiscoveryBar.tsx").includes("dedupeTagOptions"), "DiscoveryBar 仍消费同名去重");
  const deduped = dedupeTagOptions(
    [{ value: "23", label: "XiuRen" }],
    [{ value: "7", label: "xiuren" }, { value: "9", label: "长腿" }],
    undefined,
  );
  assert.deepEqual(deduped.map((o) => o.value), ["9"], "同名标签仍被剔除（fix336 行为不变）");
}

console.log("fix3312-discovery-b contract (segment 1): PASS");
