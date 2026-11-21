/**
 * fix3311/discovery-rework 契约（Muse 2026-11-21，任务书即维护者
 * 对新增测试的授权，不变量 11）。
 * 运行：node src/features/sources/fix3311-discovery-rework.contract.test.ts
 *
 * 裁定（用户 2026-11-20 发现轴亲定＋2026-11-21 10:53 委托助手裁
 * 定；牵连面见 fix3311/evidence/holistic-polish-audit.md §8 五点）：
 * 图片面发现只走排序＋查找——分类行与标签筛选行下线、taxonomy
 * 清单不再取数、存量 disc 的 category/tag 在图片面读取点失效化；
 * 视频面（002 的 brand/标签 chips）与吃瓜面行为逐字不动；标签总
 * 览页/搜索热门题材/标签落地页不在 scope。
 *
 * 覆盖：
 * (A) stripDiscTaxonomy 纯函数：剥 category/tag、保 sort/period、
 *     不改入参、无两字段时同引用返回（disc 对象身份喂 SourceGallery
 *     的 load 依赖，干净时不许换新对象）；剥后指纹不含 cat/tag。
 * (B) 适配器级过滤实证（setFetchPage 录制 URL，照 fix335 (B)
 *     先例）：原始 disc 的 category/tag 确实拼进 WP 列表请求——
 *     这是「存量筛选实际过滤列表」的基点形态；经 stripDiscTaxonomy
 *     后的 disc 发出的请求与「只带 sort 的 disc」逐字一致，即图
 *     片面读取点失效化后列表回到全量。
 * (C) 面门控接线（源码文本断言，照 fix335 (D) 先例）：SourceGallery
 *     以 stripDiscTaxonomy 派生 disc 并向 DiscoveryBar 传
 *     noTaxonomyRows；SourceBrowse/SourcePosts 不含 noTaxonomyRows
 *     （两面逐字不动）；DiscoveryBar 的有效 spec 在门控下剥
 *     categories/tagFilter，needsTaxonomy 与行渲染同吃门控后
 *     spec——分类/标签行不渲染且 taxonomy 不取数。
 * (D) 登记表不动（防误伤）：discoverySpecFor 对 002（hanime-api、
 *     视频面）与 021（wp-rest、视频面）仍登记 categories＋
 *     tagFilter；同为 wp-rest 的图片源 006 登记同样不变——删行
 *     靠图片面组件门控，不靠剥登记表。
 *
 * 证伪形态：基点 @275ded0 上 stripDiscTaxonomy 与 noTaxonomyRows
 * 均不存在——(A) 导入即红、(C) 文本断言红；实跑记录见
 * fix3311/evidence/discovery-rework.md。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "./registry.ts";
import { discoverySpecFor } from "./adapters/templateCapabilities.ts";
import { createWpRestAdapter } from "./adapters/templates.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { discFingerprint, stripDiscTaxonomy, type ListDiscovery, type SourceDef } from "./types.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const def = (id: string): SourceDef => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};

/* ── (A) 纯函数：剥两字段、保其余、不改入参、干净同引用 ── */
{
  const dirty: ListDiscovery = { category: "23", tag: "7", sort: "date-asc", period: "week" };
  const clean = stripDiscTaxonomy(dirty);
  assert.deepEqual(clean, { sort: "date-asc", period: "week" }, "剥 category/tag、保 sort/period");
  assert.ok(!("category" in clean) && !("tag" in clean), "结果无 category/tag 键（非 undefined 占位）");
  assert.deepEqual(dirty, { category: "23", tag: "7", sort: "date-asc", period: "week" }, "入参不被原地改");
  assert.equal(discFingerprint(clean), "sort=date-asc&period=week", "剥后指纹不含 cat/tag（滚动 key 同步失效化）");

  const already: ListDiscovery = { sort: "hot" };
  assert.equal(stripDiscTaxonomy(already), already, "无两字段时同引用返回（渲染/依赖稳定性）");
  const empty: ListDiscovery = {};
  assert.equal(stripDiscTaxonomy(empty), empty, "空 disc 同引用返回");
  assert.deepEqual(stripDiscTaxonomy({ category: "23" }), {}, "只有 category 时剥成空 disc");
  assert.deepEqual(stripDiscTaxonomy({ tag: "7" }), {}, "只有 tag 时剥成空 disc");
}

/* ── (B) 适配器级：原始 disc 真过滤、剥后请求与纯 sort 逐字一致 ── */
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
  /* list 还会拉 taxonomy 做条目名映射，断言对象只取 /posts? 请求。 */
  const lastPostsUrl = () => urls.filter((u) => u.includes("/posts?")).pop();

  await a.list(1, 20, { category: "23", tag: "7", sort: "date-asc" });
  assert.equal(lastPostsUrl(),
    "https://xiuren.biz/wp-json/wp/v2/posts?page=1&per_page=20&orderby=date&order=asc&categories=23&tags=7",
    "基点形态：原始 disc 的 category/tag 实际拼进列表请求（存量筛选真过滤）");

  await a.list(1, 20, stripDiscTaxonomy({ category: "23", tag: "7", sort: "date-asc" }));
  const strippedUrl = lastPostsUrl();
  assert.equal(strippedUrl,
    "https://xiuren.biz/wp-json/wp/v2/posts?page=1&per_page=20&orderby=date&order=asc",
    "剥后请求只剩排序参数、无 categories/tags（列表回到全量）");

  await a.list(1, 20, { sort: "date-asc" });
  assert.equal(lastPostsUrl(), strippedUrl, "剥后请求与纯 sort disc 逐字一致");
}

/* ── (C) 面门控接线 ── */
{
  const gallery = read("./SourceGallery.tsx");
  assert.ok(gallery.includes("stripDiscTaxonomy("), "SourceGallery 以 stripDiscTaxonomy 派生 disc（读取点失效化）");
  assert.ok(gallery.includes("noTaxonomyRows"), "SourceGallery 向 DiscoveryBar 传图片面门控");

  const bar = read("./DiscoveryBar.tsx");
  assert.ok(bar.includes("noTaxonomyRows"), "DiscoveryBar 声明图片面门控 prop");
  assert.ok(bar.includes("categories: undefined, tagFilter: undefined"), "门控下有效 spec 剥 categories/tagFilter（行渲染与 needsTaxonomy 同吃）");

  assert.ok(!read("./SourceBrowse.tsx").includes("noTaxonomyRows"), "视频面不传门控（行为逐字不动）");
  assert.ok(!read("./SourcePosts.tsx").includes("noTaxonomyRows"), "吃瓜面不传门控（行为逐字不动）");
}

/* ── (D) 登记表不动：门控在面、不在登记 ── */
{
  for (const id of ["hanime-tv", "hentaiplay", "xiuren"]) {
    const spec = discoverySpecFor(def(id));
    assert.equal(spec.categories?.source, "taxonomy", `${id} 登记仍含 taxonomy 分类（门控不在登记表）`);
    assert.equal(spec.tagFilter, true, `${id} 登记仍含 tagFilter（门控不在登记表）`);
  }
}

console.log("fix3311-discovery-rework contract: PASS");
