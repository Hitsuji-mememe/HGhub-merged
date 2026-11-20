/* fix338/realphoto-add 契约：真人图片新源 018 everia（wp-rest 模板
 * 实例化）与 019 xsnvshen（hls-site 骨架＋校准参数）的注册与解析
 * 行为。不访问真实网络：取页经 setFetchPage 注入夹具（形态据
 * 2026-11-20 本机出口实拉真站页裁剪，见 adapters/fixtures/
 * realphoto-*）。实拉验收（列表条数/图集字节/自检真机口径）在
 * fix338/evidence/realphoto-add.md、不用夹具冒充。
 *
 * 本文件的新增用例由 fix338/realphoto-add 线任务书授权（任务书点名
 * 要求：新参数须有旧码先红的回归、自检切片接入须可验）——
 * itemLinkRegex/detailPageParam/detailImagePattern 三参数与 /img
 * 页面 Referer 候选均为本批新行为，仓库既有契约无覆盖。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "./registry.ts";
import { selfCheckEligible, selfCheckTailKindFor, runSourceSelfCheck } from "./healthCheck.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { createHlsSiteAdapter, createWpRestAdapter } from "./adapters/templates.ts";
import type { SourceDef } from "./types.ts";

const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");
const registry = getBuiltinRegistry();
const byId = (id: string): SourceDef => {
  const def = registry.find((s) => s.id === id);
  assert.ok(def, `注册表含 ${id}`);
  return def;
};

/* ── 注册形态：编号顺延 018/019（order 置注册表末尾、不复用已删
 * 编号）、品类/能力如实声明 ── */
{
  const everia = byId("everia");
  const xsnvshen = byId("xsnvshen");
  assert.equal(registry.indexOf(everia), 17, "everia 为注册表第 18 位（编号 018）");
  assert.equal(registry.indexOf(xsnvshen), 18, "xsnvshen 为注册表第 19 位（编号 019）");
  assert.equal(everia.adapter.template, "wp-rest", "everia 走 wp-rest 模板实例化");
  assert.equal(everia.kind, "image");
  assert.equal(everia.enabled, true);
  assert.equal(everia.maturity, "probe", "App 侧未真机验 → probe");
  assert.equal(everia.capabilities.search, true, "everia 搜索经候选调查实证、接线复核后据实 true");
  assert.equal(xsnvshen.adapter.template, "hls-site", "xsnvshen 复用 hls-site 锚点骨架");
  assert.equal(xsnvshen.kind, "image");
  assert.equal(xsnvshen.enabled, true);
  assert.equal(xsnvshen.maturity, "probe");
  assert.equal(xsnvshen.capabilities.search, false, "xsnvshen 搜索未验 → caps.search 维持 false、不许开");
  assert.equal(selfCheckEligible(everia), true, "everia 进自检切片");
  assert.equal(selfCheckEligible(xsnvshen), true, "xsnvshen 进自检切片");
  assert.equal(selfCheckTailKindFor(everia), "gallery");
  assert.equal(selfCheckTailKindFor(xsnvshen), "gallery");
}

/* ── 018 everia：wp-rest 模板实例化（与 006 同形）——列表条目与
 * taxonomy 名称映射、详情图集、搜索 ── */
{
  const post1 = {
    id: 286678, link: "https://everia.club/286678",
    title: { rendered: "夹具图集一" },
    content: { rendered: '<p><img src="https://cdn.everia.example/a1.jpg"></p><p><img src="https://cdn.everia.example/a2.jpg"></p>' },
    excerpt: { rendered: '<p><img src="https://cdn.everia.example/a1.jpg"></p>' },
    categories: [11], tags: [21],
  };
  const post2 = {
    id: 286652, link: "https://everia.club/286652",
    title: { rendered: "夹具图集二" },
    content: { rendered: '<p><img src="https://cdn.everia.example/b1.jpg"></p>' },
    excerpt: { rendered: "" }, categories: [11], tags: [],
  };
  setFetchPage(async (url) => {
    if (url.includes("/categories")) return JSON.stringify([{ id: 11, name: "夹具分类", count: 5 }]);
    if (url.includes("/tags")) return JSON.stringify([{ id: 21, name: "夹具标签", count: 3 }]);
    if (url.includes("/posts/286678")) return JSON.stringify(post1);
    if (url.includes("search=")) return JSON.stringify([post2]);
    if (url.includes("/posts")) return JSON.stringify([post1, post2]);
    throw new Error(`未预期取页 ${url}`);
  });
  const def = byId("everia");
  const a = createWpRestAdapter(def);
  const list = await a.list(1, 20);
  assert.equal(list.items.length, 2, "everia list 2 条");
  assert.equal(list.items[0].externalId, "286678");
  assert.equal(list.items[0].title, "夹具图集一");
  assert.ok(list.items[0].cover.endsWith("a1.jpg"), "everia cover 取摘要首图（与 006 同口径）");
  assert.deepEqual(list.items[0].cats, ["夹具分类"], "everia 分类名经 taxonomy 映射进 cats");
  assert.deepEqual(list.items[0].tags, ["夹具标签"], "everia 标签名经 taxonomy 映射进 tags");
  const detail = await a.detail("286678");
  assert.deepEqual(detail.images, ["https://cdn.everia.example/a1.jpg", "https://cdn.everia.example/a2.jpg"], "everia detail 图集取正文图");
  const searchFn = a.search;
  assert.ok(searchFn, "everia 适配器带 search 方法");
  const search = await searchFn("夹具", 1, 20);
  assert.equal(search.items.length, 1, "everia search 出条目");
  const check = await runSourceSelfCheck(def, { createAdapterFor: () => createWpRestAdapter(def), now: () => 1 });
  assert.equal(check.listOk, true, "everia 自检列表 ok");
  assert.equal(check.detail, "ok", "everia 自检详情 ok");
  assert.equal(check.tail, "ok", "everia 自检图集末段 ok");
}

/* ── 019 xsnvshen：itemLinkRegex 收紧条目形态——同夹具下未声明
 * 正则的旧口径会把分类页/隐藏空锚/分页锚误收（旧码先红的对照） ── */
{
  /* 详情夹具的图集地址以请求册 id 回填（detailImagePattern 的 {id}
   * 按请求条目校验、夹具须同口径）。 */
  const detailFor = (html: string, url: string) => html.replaceAll("/13080/", `/${/\/album\/(\d+)/.exec(url)?.[1] ?? "13080"}/`);
  setFetchPage(async (url) => {
    if (/\/album\/\d+\?p=/.test(url)) return detailFor(fx("realphoto-xsnvshen-detail-p2.html"), url);
    if (/\/album\/\d+$/.test(url)) return detailFor(fx("realphoto-xsnvshen-detail.html"), url);
    if (url.includes("/album/?p=2")) return fx("realphoto-xsnvshen-list.html").replaceAll("23860", "23870").replaceAll("23841", "23851").replaceAll("23831", "23821");
    if (url.includes("/album/?p=")) return fx("realphoto-xsnvshen-list.html");
    throw new Error(`未预期取页 ${url}`);
  });
  const def = byId("xsnvshen");
  const a = createHlsSiteAdapter(def);
  const list = await a.list(1, 20);
  assert.deepEqual(
    list.items.map((i) => i.externalId),
    ["https://www.xsnvshen.com/album/23860", "https://www.xsnvshen.com/album/23841", "https://www.xsnvshen.com/album/23831"],
    "xsnvshen list 只收真卡：分类页/隐藏空锚/分页锚全剔",
  );
  assert.equal(list.items[0].title, "夹具图集一");
  assert.ok(list.items[0].cover.includes("thumb_205x308"), "xsnvshen cover 为卡片缩略图");
  assert.equal(list.pagination.pages, 1800, "xsnvshen 分页信号取导航末页 1800");
  const legacyDef: SourceDef = {
    ...def,
    adapter: { template: "hls-site", params: { ...(def.adapter.params ?? {}), itemLinkRegex: "" } },
  };
  const legacyList = await createHlsSiteAdapter(legacyDef).list(1, 20);
  assert.ok(legacyList.items.length > list.items.length, "对照：无正则旧口径同夹具误收污染锚（正则参数承重）");

  /* 详情分页组装：首段 3 张＋次页 2 张按序合并，他人图集缩略图与
   * 站点图形被 detailImagePattern 滤除；og 封面缺失以本册首图兜底 */
  const detail = await a.detail("https://www.xsnvshen.com/album/13080");
  assert.deepEqual(
    detail.images,
    [0, 1, 2, 3, 4].map((n) => `https://img.xsnvshen.com/album/17198/13080/00${n}.jpg`),
    "xsnvshen detail 组装整册 5 张、本册外图片零混入",
  );
  assert.equal(detail.cover, detail.images[0], "xsnvshen 无 og:image 时封面以本册首图兜底");
  assert.equal(detail.title, "夹具图集详情页标题_秀色女神", "xsnvshen 标题走 <title> 回落");

  const check = await runSourceSelfCheck(def, { createAdapterFor: () => createHlsSiteAdapter(def), now: () => 1 });
  assert.equal(check.listOk, true, "xsnvshen 自检列表 ok");
  assert.equal(check.paging, "ok", "xsnvshen 自检分页抽查 ok（第 2 页条目集不同）");
  assert.equal(check.detail, "ok", "xsnvshen 自检详情 ok");
  assert.equal(check.tail, "ok", "xsnvshen 自检图集末段 ok");
}

console.log("fix338-realphoto contract ok");
