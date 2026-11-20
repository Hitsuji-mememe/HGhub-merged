/**
 * fix335/f-discovery 契约（Muse 2026-11-20，任务书即维护者对新增
 * 测试的授权，AGENTS 不变量 11）。
 * 运行：node src/features/sources/fix335-f-discovery.contract.test.ts
 *
 * 覆盖（证据：fix335/evidence/f-probes.md 探针＋f-residential-
 * verify.md 住宅终验，2026-11-20）：
 * (A) DiscoverySpec 登记表：逐源断言登记全集与排除项——未实证不
 *     登记（007/native/未启用的 gelbooru/yandere 恒空）；003 栏目
 *     26（公告存档 51hd 与大赛征集栏目 mrds 被推广过滤全覆盖、
 *     不登记）、004 栏目 19（公告存档 ztds 不登记）、005 栏目 30；
 *     009 九值逐字繁体；011 只 monthly/all（weekly/daily 不得出现
 *     在登记任何位置）；008 无 tagFilter（无选项来源）。
 * (B) 适配器行为（setFetchPage 录制 URL＋夹具）：逐源断言 disc
 *     切换后请求形态与返回集变化合登记口径，且缺省路径 URL 与条
 *     件逐字不变（对照 @ea0d431 现行写死值）；未登记/非法 disc 值
 *     一律回落缺省（009 简体 sort 回落＝实现红线、011 weekly 回
 *     落、003 未登记 slug 回落）；吃瓜 cats 来自真实卡词元、WP
 *     cats/tags 由 taxonomy 名映射、002 brand 进 cats。
 * (C) discFingerprint 规范化：空 disc 空串、字段定序、值编码——
 *     滚动 key 隔离的序列化契约。
 * (D) 接线与降级（源码文本断言，照 fix333-selfcheck-trigger 先
 *     例）：三组件渲染 DiscoveryBar＋指纹进 keeper key＋list 传
 *     discArg；SourcePosts compact 不渲染；DiscoveryBar 自检
 *     down 时禁用并明示。
 * 旧代码（@ea0d431）上 discoverySpecFor/ListDiscovery/disc 参数
 * 均不存在，本契约导入即红——新面契约的既定证伪形态。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "./registry.ts";
import { discoverySpecFor, hasDiscovery } from "./adapters/templateCapabilities.ts";
import {
  createChiguaAdapter, createDanbooruAdapter, createHanime1Adapter,
  createHentaihavenAdapter, createIwaraAdapter, createWpRestAdapter,
} from "./adapters/templates.ts";
import { createHanimeApiAdapter } from "./adapters/hanimeApi.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { discFingerprint, type SourceDef } from "./types.ts";

const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const def = (id: string): SourceDef => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};
const recorder = (body: string | ((url: string) => string)) => {
  const urls: string[] = [];
  setFetchPage(async (url) => { urls.push(url); return typeof body === "function" ? body(url) : body; });
  return urls;
};

/* ── (A) 登记表 ── */
{
  const expectDiscovery: Record<string, boolean> = {
    huangguo: false, "hanime-tv": true, "51chigua": true, meiridasai: true,
    feedheiliao: true, xiuren: true, pornpics: false, cosplaytele: true,
    danbooru: true, hanime1: true, iwara: true, hentaihaven: true,
    pixibb: true, nudecosplay: true, yandere: false, gelbooru: false,
  };
  for (const d of getBuiltinRegistry()) {
    if (!(d.id in expectDiscovery)) continue;
    const spec = discoverySpecFor(d);
    assert.equal(hasDiscovery(spec), expectDiscovery[d.id], `${d.id} 登记有无`);
    if (expectDiscovery[d.id]) assert.ok(spec.evidence.length > 0, `${d.id} 登记带证据`);
  }
  const c003 = discoverySpecFor(def("51chigua")).categories;
  assert.equal(c003?.source, "params");
  assert.equal(c003?.options.length, 26, "003 登记 26 栏目（28 导航栏目摘公告存档与大赛征集两类）");
  assert.ok(!c003?.options.some((o) => o.value === "51hd"), "003 公告存档栏目 51hd 不登记");
  assert.ok(!c003?.options.some((o) => o.value === "mrds"), "003 每日大赛（征集帖全覆盖）不登记");
  assert.ok(c003?.options.some((o) => o.value === "whhl" && o.label === "网红黑料"), "003 whhl 在登记");
  const c004 = discoverySpecFor(def("meiridasai")).categories;
  assert.equal(c004?.options.length, 19, "004 登记 19 栏目（20 摘公告存档）");
  assert.ok(!c004?.options.some((o) => o.value === "ztds"), "004 公告存档栏目 ztds 不登记");
  assert.ok(c004?.options.some((o) => o.value === "mrds"), "004 每日大赛无组合判据、照常登记");
  const c005 = discoverySpecFor(def("feedheiliao")).categories;
  assert.equal(c005?.options.length, 30, "005 登记 30 栏目（导航全集）");
  assert.ok(c005?.options.some((o) => o.value === "ysdj" && o.label === "成人短剧"), "005 ysdj 在登记");

  const s009 = discoverySpecFor(def("hanime1"));
  assert.deepEqual(s009.sorts?.map((o) => o.value),
    ["最新上市", "最新上傳", "本日排行", "本週排行", "本月排行", "觀看次數", "讚好比例", "時長最長", "他們在看"],
    "009 九值逐字繁体原值");
  assert.equal(s009.sortDefault, "最新上市");

  const s011 = discoverySpecFor(def("hentaihaven"));
  assert.deepEqual(s011.rankPeriods?.map((o) => o.value), ["monthly", "all"], "011 只登记 monthly/all");
  const s012Values = [...(s011.rankPeriods ?? []), ...(s011.sorts ?? []), ...(s011.categories?.options ?? [])].map((o) => o.value);
  assert.ok(!s012Values.some((v) => ["weekly", "daily", "week", "day"].includes(v)),
    "011 任何维度选项值不得出现 weekly/daily/week/day（evidence 文案提及拒绝原因不在此列）");

  const s008 = discoverySpecFor(def("danbooru"));
  assert.deepEqual(s008.sorts?.map((o) => o.value), ["", "order:rank", "order:score", "order:favcount"], "008 三预设");
  assert.equal(s008.tagFilter, undefined, "008 无 tagFilter（标签走搜索段）");

  for (const id of ["xiuren", "cosplaytele", "pixibb", "nudecosplay"]) {
    const s = discoverySpecFor(def(id));
    assert.equal(s.categories?.source, "taxonomy", `${id} 分类走 taxonomy`);
    assert.equal(s.tagFilter, true, `${id} 标签过滤登记`);
    assert.deepEqual(s.sorts?.map((o) => o.value), ["", "date-asc"], `${id} 排序两值`);
  }
  const s002 = discoverySpecFor(def("hanime-tv"));
  assert.equal(s002.categories?.source, "taxonomy", "002 分类走目录聚合");
  assert.equal(s002.tagFilter, true);
  assert.deepEqual(s002.sorts?.map((o) => o.value), ["", "views"], "002 排序两值");
  const s010 = discoverySpecFor(def("iwara"));
  assert.deepEqual(s010.sorts?.map((o) => o.value), ["views", "date", "likes"], "010 三值");
  assert.equal(s010.sortDefault, "views");
}

/* ── (B) 适配器行为 ── */
{ // 003 栏目归档（夹具＝真站首页实抓卡，卡片形态与栏目页同口径）
  const urls = recorder(fx("real-51cg-home-cards.html"));
  const a = createChiguaAdapter(def("51chigua"));
  const r1 = await a.list(1, 20, { category: "whhl" });
  assert.equal(urls[0], "https://51cg1.com/category/whhl/", "003 栏目第 1 页裸路径");
  assert.ok(r1.items.length > 0, "003 栏目页解析出条目");
  assert.deepEqual(r1.items[0].cats, ["今日吃瓜", "骚男骚女"], "003 cats 来自卡片分类词元");
  await a.list(2, 20, { category: "whhl" });
  assert.equal(urls[1], "https://51cg1.com/category/whhl/2/", "003 栏目第 2 页路径");
  const rd = await a.list(1, 20);
  assert.equal(urls[2], "https://51cg1.com/page/1/", "003 缺省路径逐字不变");
  assert.deepEqual(rd.items.map((i) => i.externalId), r1.items.map((i) => i.externalId), "003 缺省与栏目同夹具返回集一致（机制隔离）");
  const re = await a.list(1, 20, {});
  assert.deepEqual(re.items.map((i) => i.externalId), rd.items.map((i) => i.externalId), "003 空 disc ＝缺省");
  await a.list(1, 20, { category: "mrds" });
  assert.equal(urls[4], "https://51cg1.com/page/1/", "003 未登记 slug（mrds 已摘）回落缺省");
  await a.list(1, 20, { category: "nosuch" });
  assert.equal(urls[5], "https://51cg1.com/page/1/", "003 未知 slug 回落缺省");
}
{ // 005 栏目归档（夹具＝真站栏目页实抓卡）
  const urls = recorder(fx("real-heiliao-category-mrds.html"));
  const a = createChiguaAdapter(def("feedheiliao"));
  const r1 = await a.list(1, 20, { category: "mrds" });
  assert.equal(urls[0], "https://heiliao.com/mrds/", "005 栏目第 1 页裸路径");
  assert.equal(r1.items.length, 3, "005 栏目页解析出 3 条");
  assert.equal(r1.pagination.pages, 25, "005 栏目分页信号读归档导航（25 页）");
  await a.list(2, 20, { category: "mrds" });
  assert.equal(urls[1], "https://heiliao.com/mrds/page/2/", "005 栏目第 2 页 /page/{page}/ 形态");
  await a.list(1, 20);
  assert.equal(urls[2], "https://heiliao.com/page/1/", "005 缺省路径逐字不变");
}
{ // WP taxonomy＋过滤＋排序（构造 JSON 夹具）
  const posts = JSON.stringify([
    { id: 11, link: "https://xiuren.example/p11", title: { rendered: "帖十一" }, excerpt: { rendered: "<img src=\"https://img.example/11.jpg\">" }, categories: [23], tags: [7] },
    { id: 12, link: "https://xiuren.example/p12", title: { rendered: "帖十二" }, excerpt: { rendered: "" }, categories: [24], tags: [] },
  ]);
  const urls = recorder((url) => url.includes("/categories?")
    ? JSON.stringify([{ id: 23, name: "Hot Girl", count: 50 }, { id: 24, name: "Cosplay", count: 30 }])
    : url.includes("/tags?")
      ? JSON.stringify([{ id: 7, name: "长腿", count: 99 }])
      : posts);
  const a = createWpRestAdapter(def("xiuren"));
  const tax = await a.taxonomy!();
  assert.deepEqual(tax.categories.map((c) => c.id), ["23", "24"], "WP taxonomy 分类 id 字符串化");
  assert.deepEqual(tax.tags, [{ id: "7", name: "长腿", count: 99 }], "WP taxonomy 标签带计数");
  const rd = await a.list(1, 20);
  assert.equal(urls.find((u) => u.includes("/posts?")), "https://xiuren.biz/wp-json/wp/v2/posts?page=1&per_page=20", "WP 缺省查询逐字不变");
  assert.deepEqual(rd.items[0].cats, ["Hot Girl"], "WP 分类名进 cats");
  assert.deepEqual(rd.items[0].tags, ["长腿"], "WP 标签名进 tags");
  assert.equal(rd.items[1].cats?.[0], "Cosplay");
  await a.list(1, 20, { category: "23", tag: "7", sort: "date-asc" });
  assert.equal(urls[urls.length - 1], "https://xiuren.biz/wp-json/wp/v2/posts?page=1&per_page=20&orderby=date&order=asc&categories=23&tags=7", "WP disc 参数拼装");
  await a.list(1, 20, { category: "abc" });
  assert.equal(urls[urls.length - 1], "https://xiuren.biz/wp-json/wp/v2/posts?page=1&per_page=20", "WP 非数字分类 id 不拼坏参数、回落缺省");
}
{ // 008 预设
  const urls = recorder(fx("danbooru-list.json"));
  const a = createDanbooruAdapter(def("danbooru"));
  await a.list(1, 20);
  assert.equal(urls[0], "https://danbooru.donmai.us/posts.json?page=1&limit=20", "008 缺省 URL 逐字不变（无 tags 参数）");
  await a.list(1, 20, { sort: "order:score" });
  assert.equal(urls[1], "https://danbooru.donmai.us/posts.json?page=1&limit=20&tags=order%3Ascore", "008 高分预设拼 tags 参数");
  await a.list(1, 20, { sort: "order:bogus" });
  assert.equal(urls[2], urls[0], "008 未登记预设回落缺省");
}
{ // 010 排序
  const urls = recorder(fx("iwara-list.json"));
  const a = createIwaraAdapter(def("iwara"));
  await a.list(1, 20);
  assert.equal(urls[0], "https://api.iwara.tv/videos?sort=views&page=0&limit=20", "011 缺省 sort=views 逐字不变");
  await a.list(1, 20, { sort: "date" });
  assert.equal(urls[1], "https://api.iwara.tv/videos?sort=date&page=0&limit=20", "011 最新");
  await a.list(1, 20, { sort: "bogus" });
  assert.equal(urls[2], urls[0], "010 非法值回落 views");
}
{ // 009 繁体原值（红线）
  const urls = recorder(fx("hanime1-search.html"));
  const a = createHanime1Adapter(def("hanime1"));
  await a.list(1, 20);
  assert.equal(urls[0], `https://hanime1.me/search?sort=${encodeURIComponent("最新上市")}`, "010 缺省最新上市逐字不变");
  for (const v of ["最新上傳", "本日排行", "本週排行", "本月排行", "觀看次數", "讚好比例", "時長最長", "他們在看"]) {
    await a.list(1, 20, { sort: v });
    assert.equal(urls[urls.length - 1], `https://hanime1.me/search?sort=${encodeURIComponent(v)}`, `010 sort=${v} 逐字入参`);
  }
  await a.list(1, 20, { sort: "观看次数" });
  assert.equal(urls[urls.length - 1], urls[0], "009 简体拼法不入参、回落默认序（红线）");
}
{ // 011 周期（只两值）
  const urls = recorder(fx("hentaihaven-list.json"));
  const a = createHentaihavenAdapter(def("hentaihaven"));
  await a.list(1, 20);
  assert.equal(urls[0], "https://hentaihaven.xxx/api/manga/?trending_period=monthly&per_page=20&page=1", "011 缺省 monthly 逐字不变");
  await a.list(1, 20, { period: "all" });
  assert.equal(urls[1], "https://hentaihaven.xxx/api/manga/?trending_period=all&per_page=20&page=1", "011 全部");
  await a.list(1, 20, { period: "weekly" });
  assert.equal(urls[2], urls[0], "011 weekly 不得入参（站方拒绝）、回落 monthly");
}
{ // 002 客户端重排（构造目录：views 序与最新序故意不同）
  const catalog = JSON.stringify({ data: [
    { slug: "row-a", name: "A", brand: "BrandX", views: 10, created_at_unix: 300, tags: ["t1"], cover_url: "" },
    { slug: "row-b", name: "B", brand: "BrandY", views: 99, created_at_unix: 200, tags: ["t2"], cover_url: "" },
    { slug: "row-c", name: "C", brand: "BrandX", views: 50, created_at_unix: 100, tags: ["t1", "t2"], cover_url: "" },
  ] });
  recorder(catalog);
  const a = createHanimeApiAdapter(def("hanime-tv"));
  const rd = await a.list(1, 20);
  assert.deepEqual(rd.items.map((i) => i.externalId), ["row-a", "row-b", "row-c"], "002 缺省＝最新序（created 降序）");
  assert.deepEqual(rd.items[0].cats, ["BrandX"], "002 brand 进 cats");
  const rv = await a.list(1, 20, { sort: "views" });
  assert.deepEqual(rv.items.map((i) => i.externalId), ["row-b", "row-c", "row-a"], "002 views 重排（返回集顺序确实变化）");
  const rb = await a.list(1, 20, { category: "BrandX" });
  assert.deepEqual(rb.items.map((i) => i.externalId), ["row-a", "row-c"], "002 brand 过滤");
  const rt = await a.list(1, 20, { tag: "t2" });
  assert.deepEqual(rt.items.map((i) => i.externalId), ["row-b", "row-c"], "002 tag 过滤");
  const tax = await a.taxonomy!();
  assert.deepEqual(tax.categories, [{ id: "BrandX", name: "BrandX", count: 2 }, { id: "BrandY", name: "BrandY", count: 1 }], "002 taxonomy 由目录聚合计数");
  assert.deepEqual(tax.tags.map((t) => t.id), ["t1", "t2"], "002 taxonomy 标签计数序");
}

/* ── (C) 指纹规范化 ── */
{
  assert.equal(discFingerprint({}), "", "空 disc 指纹为空串（keeper key 与 D 线逐字一致）");
  assert.equal(discFingerprint({ category: "mrds" }), "cat=mrds");
  assert.equal(discFingerprint({ sort: "order:score", category: "x" }), "cat=x&sort=order%3Ascore", "字段定序 cat→sort→period→tag＋值编码");
  assert.equal(discFingerprint({ period: "all", tag: "7" }), "period=all&tag=7");
  assert.notEqual(discFingerprint({ sort: "views" }), discFingerprint({ sort: "date" }), "不同维度指纹不同（位置隔离）");
}

/* ── (D) 接线与降级（源码文本断言） ── */
{
  const bar = read("./DiscoveryBar.tsx");
  assert.ok(bar.includes("classifySelfCheckResult"), "DiscoveryBar 经自检派生判降级");
  assert.ok(bar.includes('status === "down"'), "DiscoveryBar 只在 down（列表段失败）时降级");
  assert.ok(bar.includes("发现维度暂不可用"), "DiscoveryBar 降级明示文案");
  assert.ok(bar.includes("useSourceHealthResults"), "DiscoveryBar 订阅自检结果（恢复自动可用）");
  assert.ok(bar.includes("TAXONOMY_CHIP_LIMIT"), "DiscoveryBar chips Top-N 截断");
  for (const [file, listCall] of [
    ["./SourceBrowse.tsx", "adapter.list(next, 20, discArg)"],
    ["./SourceGallery.tsx", "adapter.list(next, 20, discArg)"],
    ["./SourcePosts.tsx", "adapter.list(next, pageSize, discArg)"],
  ] as const) {
    const src = read(file);
    assert.ok(src.includes("<DiscoveryBar"), `${file} 渲染 DiscoveryBar`);
    assert.ok(src.includes("discFingerprint"), `${file} 指纹进滚动 key`);
    assert.ok(src.includes(listCall), `${file} list 传 disc`);
  }
  assert.ok(read("./SourcePosts.tsx").includes("!compact && <DiscoveryBar"), "SourcePosts compact 形态不渲染维度条");
}

console.log("fix335-f-discovery contract: OK");
