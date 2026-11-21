/**
 * fix335/f-discovery 契约（Muse 2026-11-20，任务书即维护者对新增
 * 测试的授权，AGENTS 不变量 11）。
 * 运行：node src/features/sources/fix335-f-discovery.contract.test.ts
 *
 * 覆盖（证据：fix335/evidence/f-probes.md 探针＋f-residential-
 * verify.md 住宅终验，2026-11-20）：
 * (A) DiscoverySpec 登记表：逐源断言登记全集与排除项——未实证不
 *     登记（007/未启用的 gelbooru 恒空）；009 九值逐字繁体（该
 *     断言已随 fix339/registry-cut-2 源摘除退役，见 (A) 内注记）。
 *     断言适配（fix338/registry-cut）：008/011 已摘除、其发现登记
 *     （danbooru-api 三预设、hentaihaven-api monthly/all）随源退
 *     役——(A) 改钉「danbooru-api 家族（014/015）无发现登记」、
 *     (B) 008 块改合成 def 钉新行为（预设拼参退役、任意 sort 回
 *     落缺省）、011 块随适配器删码退役。
 *     fix337/chigua-surface 改版（用户裁定＋调查
 *     fix337/evidence/chigua-surface-investigation.md，2026-11-20）：
 *     吃瓜三源分类轴整体下线（栏目表保留在注册表 params 作
 *     categoryPath 路径校验全集、不再作发现入口），发现只剩榜单
 *     （period 承载榜单 slug、复用 categoryPath 机制；子集以栏目
 *     表 rank 标记为唯一出处）＋缺省默认档；001 登记最新/最热
 *     （上游 sort=hot 热度序实证）。
 *     fix338/chigua-pill 标签修订（实证
 *     fix338/evidence/chigua-pill.md，2026-11-20）：三源缺省流
 *     经生产路径实测非时间序（id/日期序非单调），缺省档标
 *     「全部」不标「最新」；栏目表 hot 标记的站方热门栏目
 *     （003 rdsj/004 rstt/005 jqrm，每源至多一个）标「最热」，
 *     其余榜单保留站方名。
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
  createChiguaAdapter, createDanbooruAdapter, createWpRestAdapter,
  readDiscoveryCategories, readDiscoveryRanks,
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
    huangguo: true, "51chigua": true, meiridasai: true,
    feedheiliao: true, xiuren: true, pornpics: false, cosplaytele: true,
    pixibb: true, nudecosplay: true, gelbooru: false,
  };
  for (const d of getBuiltinRegistry()) {
    if (!(d.id in expectDiscovery)) continue;
    const spec = discoverySpecFor(d);
    assert.equal(hasDiscovery(spec), expectDiscovery[d.id], `${d.id} 登记有无`);
    if (expectDiscovery[d.id]) assert.ok(spec.evidence.length > 0, `${d.id} 登记带证据`);
  }
  /* fix337/chigua-surface：吃瓜三源分类轴下线、榜单登场
   * （口径见文件头）。栏目表全集保留在注册表 params（路径校验
   * 出处），公告存档（51hd/ztds 本就不在表内）与非榜单栏目一律
   * 不进发现登记。
   * fix338/chigua-pill：缺省档标「全部」（缺省流非时间序、
   * 不贴「最新」假标签）；hot 标记栏目（每源一个）标「最热」。 */
  for (const id of ["51chigua", "meiridasai", "feedheiliao"]) {
    const s = discoverySpecFor(def(id));
    assert.equal(s.categories, undefined, `${id} 分类轴下线、不登记 categories`);
    assert.equal(s.sorts, undefined, `${id} 不登记 sorts（站方无排序参数面；最热走 disc.period 榜单机制、不伪造 sort 值）`);
    assert.equal(s.periodDefault, "", `${id} periodDefault 为缺省流`);
    assert.equal(s.rankPeriods?.[0]?.value, "", `${id} 榜单行首项＝缺省流（退出榜单的路径）`);
    assert.equal(s.rankPeriods?.[0]?.label, "全部", `${id} 缺省档标「全部」（fix338 实测缺省流非时间序、不标「最新」）`);
  }
  assert.deepEqual(discoverySpecFor(def("51chigua")).rankPeriods?.map((o) => o.value),
    ["", "mrdg", "rdsj"], "003 榜单＝吃瓜榜单＋热门大瓜（站方编辑栏目形态）");
  assert.deepEqual(discoverySpecFor(def("51chigua")).rankPeriods?.map((o) => o.label),
    ["全部", "吃瓜榜单", "最热"], "003 标签＝全部＋吃瓜榜单＋最热（rdsj）");
  assert.deepEqual(discoverySpecFor(def("meiridasai")).rankPeriods?.map((o) => o.value),
    ["", "rstt"], "004 榜单＝热搜吃瓜（站方编辑栏目形态）");
  assert.deepEqual(discoverySpecFor(def("meiridasai")).rankPeriods?.map((o) => o.label),
    ["全部", "最热"], "004 标签＝全部＋最热（rstt）");
  assert.deepEqual(discoverySpecFor(def("feedheiliao")).rankPeriods?.map((o) => o.value),
    ["", "mrrb", "zbjx", "ybrg", "jqrm"], "005 榜单＝日/周/月/热门四周期榜（站方真周期榜）");
  assert.deepEqual(discoverySpecFor(def("feedheiliao")).rankPeriods?.map((o) => o.label),
    ["全部", "日榜黑料", "周榜精选", "月榜热瓜", "最热"], "005 标签＝全部＋日/周/月榜站方名＋最热（jqrm）");
  assert.deepEqual(readDiscoveryRanks(def("51chigua")).filter((c) => c.hot).map((c) => c.slug),
    ["rdsj"], "003 hot 标记唯一＝rdsj");
  assert.deepEqual(readDiscoveryRanks(def("meiridasai")).filter((c) => c.hot).map((c) => c.slug),
    ["rstt"], "004 hot 标记唯一＝rstt");
  assert.deepEqual(readDiscoveryRanks(def("feedheiliao")).filter((c) => c.hot).map((c) => c.slug),
    ["jqrm"], "005 hot 标记唯一＝jqrm");
  const chiguaRankValues = ["51chigua", "meiridasai", "feedheiliao"]
    .flatMap((id) => discoverySpecFor(def(id)).rankPeriods?.map((o) => o.value) ?? []);
  for (const banned of ["51hd", "ztds", "whhl", "ysdj", "mrds"]) {
    assert.ok(!chiguaRankValues.includes(banned), `非榜单栏目 ${banned} 不进榜单登记`);
  }
  assert.equal(readDiscoveryCategories(def("51chigua")).length, 26, "003 栏目表保留 26（路径校验全集）");
  assert.equal(readDiscoveryCategories(def("meiridasai")).length, 19, "004 栏目表保留 19（路径校验全集）");
  assert.equal(readDiscoveryCategories(def("feedheiliao")).length, 30, "005 栏目表保留 30（路径校验全集）");
  assert.deepEqual(readDiscoveryRanks(def("51chigua")).map((c) => c.slug), ["mrdg", "rdsj"], "003 rank 标记子集");
  assert.deepEqual(readDiscoveryRanks(def("meiridasai")).map((c) => c.slug), ["rstt"], "004 rank 标记子集");
  assert.deepEqual(readDiscoveryRanks(def("feedheiliao")).map((c) => c.slug),
    ["mrrb", "zbjx", "ybrg", "jqrm"], "005 rank 标记子集（日/周/月/热门序）");
  const s001 = discoverySpecFor(def("huangguo"));
  assert.deepEqual(s001.sorts?.map((o) => o.value), ["", "hot"], "001 登记最新/最热（上游 sort=hot 实证）");
  assert.equal(s001.sortDefault, "");

  /* 009 九值登记断言随 fix339/registry-cut-2 源摘除退役（登记表条目
   * 已随 templateCapabilities 删码）；010 三值登记断言同批退役。 */

  /* fix338：danbooru-api 家族发现登记退役——在册源与合成
   * danbooru-api def 均无登记（008 三预设随源摘除、家族无其他消
   * 费者）；fix339 适配：014 已摘除，家族在册承接者为 015
   * gelbooru，本断言改钉 gelbooru def。 */
  const s015 = discoverySpecFor(def("gelbooru"));
  assert.equal(hasDiscovery(s015), false, "015 无发现登记（danbooru-api 家族登记退役、fix338）");
  assert.equal(s015.sorts, undefined, "015 无 sorts 登记（008 预设不许以家族名义残留）");

  for (const id of ["xiuren", "cosplaytele", "pixibb", "nudecosplay"]) {
    const s = discoverySpecFor(def(id));
    assert.equal(s.categories?.source, "taxonomy", `${id} 分类走 taxonomy`);
    assert.equal(s.tagFilter, true, `${id} 标签过滤登记`);
    assert.deepEqual(s.sorts?.map((o) => o.value), ["", "date-asc"], `${id} 排序两值`);
  }
  /* 断言适配（fix3315）：002（hanime-tv）随恢复回归——登记断言回
   * 原形（分类走目录聚合、标签过滤、排序两值）。 */
  const s002 = discoverySpecFor(def("hanime-tv"));
  assert.equal(s002.categories?.source, "taxonomy", "002 分类走目录聚合");
  assert.equal(s002.tagFilter, true);
  assert.deepEqual(s002.sorts?.map((o) => o.value), ["", "views"], "002 排序两值");
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
{ // 003 榜单（fix337：period 承载榜单 slug、复用 categoryPath 机制；
  // 非榜单栏目与未知值回落缺省流——榜单子集以 rank 标记为准）
  const urls = recorder(fx("real-51cg-home-cards.html"));
  const a = createChiguaAdapter(def("51chigua"));
  await a.list(1, 20, { period: "mrdg" });
  assert.equal(urls[0], "https://51cg1.com/category/mrdg/", "003 榜单走栏目归档路径");
  await a.list(1, 20, { period: "whhl" });
  assert.equal(urls[1], "https://51cg1.com/page/1/", "003 非榜单栏目不入 period、回落缺省流");
  await a.list(1, 20, { period: "bogus" });
  assert.equal(urls[2], "https://51cg1.com/page/1/", "003 未知 period 回落缺省流");
}
{ // 005 榜单（fix337：周期榜同 categoryPath 形态）
  const urls = recorder(fx("real-heiliao-category-mrds.html"));
  const a = createChiguaAdapter(def("feedheiliao"));
  await a.list(1, 20, { period: "mrrb" });
  assert.equal(urls[0], "https://heiliao.com/mrrb/", "005 日榜第 1 页裸路径");
  await a.list(2, 20, { period: "mrrb" });
  assert.equal(urls[1], "https://heiliao.com/mrrb/page/2/", "005 日榜第 2 页路径");
}
{ // 005 搜索拆雷（fix337）：未声明 searchPath 不得回退模板默认形把
  // 首页流冒充搜索结果（违反「未知不是空」）——显式抛错且抛错前不
  // 发任何请求；005 caps.search 本就 false、无 UI 入口。
  const urls = recorder(fx("real-heiliao-category-mrds.html"));
  const a = createChiguaAdapter(def("feedheiliao"));
  await assert.rejects(() => a.search!("不存在的词", 1, 20), /无搜索段/, "005 search 显式抛无搜索段");
  assert.equal(urls.length, 0, "005 search 抛错前不发任何请求");
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
{ // danbooru-api 家族缺省形态（fix338 适配：008 已摘除，改合成
  // def 承接模板级缺省钉；排序预设拼参已随 008 发现登记退役——
  // 任意 sort 值回落缺省形态，014/015 列表行为逐字不变）
  const synthDb: SourceDef = {
    id: "danbooru-synthetic", displayName: "Danbooru 合成", kind: "image", category: "image",
    adapter: { template: "danbooru-api", params: {} }, baseUrls: ["https://danbooru.donmai.us"],
    enabled: true, order: 999, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false },
    network: { mode: "probe-required" }, note: "fix338 契约合成 def",
  };
  const urls = recorder(fx("danbooru-list.json"));
  const a = createDanbooruAdapter(synthDb);
  await a.list(1, 20);
  assert.equal(urls[0], "https://danbooru.donmai.us/posts.json?page=1&limit=20", "danbooru-api 缺省 URL 逐字不变（无 tags 参数）");
  await a.list(1, 20, { sort: "order:score" });
  assert.equal(urls[1], urls[0], "预设拼参已退役：order:score 不再入参、回落缺省形态（fix338）");
  await a.list(1, 20, { sort: "order:bogus" });
  assert.equal(urls[2], urls[0], "未登记值回落缺省");
}
{ // 002 客户端重排（构造目录：views 序与最新序故意不同）
  // 恢复注记（fix3315）：本块于 fix3314 随 hanimeApi 整删退役，现随
  // 适配器恢复原样捡回（与 3.3.13 逐字一致）。
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
  assert.equal(discFingerprint({ period: "mrrb" }), "period=mrrb", "榜单 period 进指纹（滚动恢复 key 隔离榜单面）");
  assert.notEqual(discFingerprint({ sort: "views" }), discFingerprint({ sort: "date" }), "不同维度指纹不同（位置隔离）");
}

/* ── (D) 接线与降级（源码文本断言） ── */
{
  const bar = read("./DiscoveryBar.tsx");
  assert.ok(bar.includes("classifySelfCheckResult"), "DiscoveryBar 经自检派生判降级");
  assert.ok(bar.includes('status === "down"'), "DiscoveryBar 只在 down（列表段失败）时降级");
  assert.ok(bar.includes("发现维度暂不可用"), "DiscoveryBar 降级明示文案");
  assert.ok(bar.includes("useSourceHealthResults"), "DiscoveryBar 订阅自检结果（恢复自动可用）");
  assert.ok(bar.includes("TAXONOMY_CHIP_LIMIT"), "DiscoveryBar 分类 chips Top-N 截断");
  /* fix3314/header-slim 呈现口径：排序分段开关＋标签底部弹层。 */
  assert.ok(bar.includes("SegmentedControl"), "排序改分段开关（fix3314）");
  assert.ok(bar.includes("<Sheet open={tagSheetOpen}"), "标签改底部弹层（fix3314）");
  assert.ok(bar.includes("selectedTagCount"), "筛选按钮带已选标签数徽标（fix3314）");
  /* fix3314 阶段二审计处置（A1 之外四项，任务书定版口径）：
   * D1 标签池映射抽共用 taxonOptionsOf（discoveryOptions 单一出处、
   * DiscoveryBar 消费）；C1 taxonomy 加载失败明示＋重试（不再恒显
   * 加载中）；B1 弹层标签分段渲染（TAG_SHEET_PAGE 首段＋滚动增
   * 量）；C2 已选 chip 在 taxonomy 到达前暂缓渲染（不以原始 id
   * 回显——无条件原始 id 回落字面退场）。 */
  assert.ok(read("./discoveryOptions.ts").includes("export function taxonOptionsOf"), "taxonOptionsOf 单一出处在 discoveryOptions（fix3314 D1）");
  assert.ok(bar.includes("taxonOptionsOf("), "DiscoveryBar 消费共用 taxon 映射（fix3314 D1）");
  assert.ok(bar.includes("taxonomyFailed"), "DiscoveryBar 带 taxonomy 失败态（fix3314 C1）");
  assert.ok(bar.includes("标签加载失败"), "弹层加载失败明示文案（fix3314 C1）");
  assert.ok(bar.includes("TAG_SHEET_PAGE"), "弹层标签分段渲染页大小（fix3314 B1）");
  assert.ok(!bar.includes("?? { value: disc.tag, label: disc.tag }"), "已选 chip 无条件原始 id 回落退场（fix3314 C2）");
  /* fix3316 真机两修：①分类行退出筛选栏——渲染经保留名单门控
   * （名单为空集＝全源不渲染）、存量 category 经清场 effect 退
   * 场；②弹层首开不能滑——滚动区补 flex-1/min-h-0 成有界真滚
   * 动区（B1 续段 onScroll 同元素），不再靠 .ios-dialog 兜底
   * 滚动几何。旧码两断言皆红（无门控字面、无 min-h-0）。 */
  assert.ok(bar.includes("CATEGORY_BAR_KEPT_SOURCE_IDS"), "分类行渲染经保留名单门控（fix3316）");
  assert.ok(bar.includes("categoryBarKept && spec.categories"), "分类行仅保留名单内的源渲染（fix3316）");
  assert.ok(bar.includes("disc.category_axis_retired"), "存量 category 清场留痕（fix3316）");
  assert.ok(bar.includes("min-h-0 flex-1 flex-wrap"), "弹层滚动区＝有界真滚动区（fix3316 首开可滑）");
  for (const [file, listCall] of [
    ["./SourceGallery.tsx", "adapter.list(next, 20, discArg)"],
    ["./SourcePosts.tsx", "adapter.list(next, pageSize, discArg)"],
  ] as const) {
    const src = read(file);
    assert.ok(src.includes("<DiscoveryBar"), `${file} 渲染 DiscoveryBar`);
    assert.ok(src.includes("discFingerprint"), `${file} 指纹进滚动 key`);
    assert.ok(src.includes(listCall), `${file} list 传 disc`);
  }
  /* 断言适配（fix3317）：compact 形态整组删除，DiscoveryBar 改无条件
   * 渲染（上方同文件断言已守 <DiscoveryBar 存在，本条守门控残留清零）。 */
  assert.ok(!read("./SourcePosts.tsx").includes("!compact"), "SourcePosts 无 compact 门控残留");
  /* fix337：001 最热接线——原生适配器 list 消费 disc.sort（缺省与
   * 非 hot 值回落 latest），原生 Posts 页带最新/最热切换且排序经
   * 页内状态进 request 与 resetKey（切换整表重置、不混排）。 */
  const native001 = read("./adapters/nativeHuangguo.ts");
  assert.ok(native001.includes("disc?.sort"), "001 适配器 list 消费 disc.sort");
  assert.ok(native001.includes('"hot"'), "001 hot 档入参在适配器");
  const postsPage = read("../posts/Posts.tsx");
  assert.ok(postsPage.includes("最热"), "原生 Posts 页带最热切换");
  assert.ok(postsPage.includes("postSort"), "原生 Posts 页排序经页内状态 postSort 驱动");
}

console.log("fix335-f-discovery contract: OK");
