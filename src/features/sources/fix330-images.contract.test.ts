/**
 * 3.3.0 接通批·图片线契约测试（Muse 2026-11-19；本批任务书即维护者
 * 对新增测试的授权，AGENTS 不变量 11）。
 * 运行：node src/features/sources/fix330-images.contract.test.ts
 * 覆盖：
 * (1) HTML 实体解码单点（parse.decodeEntities）：数字实体（含前导零
 *     &#039;、十六进制 &#x27;、多位 &#8217;）与常用命名实体必须解码——
 *     旧实现只认 &#39;，详情简介/标题里的 &#039; 原样进界面（用户实报）；
 *     单遍解码不许二次解码（&amp;#039; 只解到 &#039; 字面）。
 * (2) 全部模板的文本入界面路径都经该单点：wp-rest 列表标题/详情简介、
 *     hls-site 锚点标题（title 属性与 h3 两路）与详情 og:title/简介。
 *     夹具为真站响应形态（WP REST 字段结构/OG meta 形态）、内容合成。
 * (3) 图片线逐源定级（证据 ~/workspace/hghub/fix330/evidence/images.md）：
 *     xiuren 解 blocked（xiuren.biz 在前、本机四级全通）、danbooru 翻案
 *     probe（住宅四级全通、本机 CF）、pixibb/nudecosplay 启用 probe
 *     （本机四级全通＋搜索实证）、pornpics 维持 probe 且 search 改 false
 *     （模板搜索两形态均不成立）、gelbooru/yandere/pixiv 维持未启用。
 *     断言适配（fix335/g-sources，2026-11-20）：pornpics 已退役摘除、
 *     yandere moebooru 校准启用、konachan 新增启用——(3) 随之改判，
 *     证据 fix335/evidence/g-sources.md。
 * 不访问真实网络：适配器经 setFetchPage 注入夹具。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "./registry.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { decodeEntities, stripTags } from "./adapters/parse.ts";
import { createHlsSiteAdapter, createWpRestAdapter } from "./adapters/templates.ts";
import type { SourceDef } from "./types.ts";

const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");
const def = (id: string): SourceDef => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};

/* ── (1) 实体解码单点 ── */
{
  assert.equal(decodeEntities("Tom&#039;s"), "Tom's", "前导零数字实体 &#039; 必须解码（旧码原样漏过）");
  assert.equal(decodeEntities("a&#8217;b"), "a’b", "多位数字实体 &#8217; 必须解码");
  assert.equal(decodeEntities("a&#x27;b"), "a'b", "十六进制实体 &#x27; 必须解码");
  assert.equal(decodeEntities("Set &#038; More"), "Set & More", "&#038;（& 的数字形态）必须解码");
  assert.equal(decodeEntities("wait &hellip;"), "wait …", "命名实体 &hellip; 必须解码");
  assert.equal(decodeEntities("a &rsquo; b"), "a ’ b", "命名实体 &rsquo; 必须解码");
  assert.equal(decodeEntities("&amp;#039;"), "&#039;", "单遍解码：&amp;#039; 只解一层、不二次解码");
  assert.equal(decodeEntities("&nosuchentity;"), "&nosuchentity;", "未知实体原样保留");
  assert.equal(decodeEntities("plain & simple"), "plain & simple", "无分号裸 & 不动");
  assert.equal(stripTags("<p>Intro &#039;quoted&#039;</p>"), "Intro 'quoted'", "stripTags 文本路径同样解码");
}

/* ── (2a) wp-rest：列表标题＋详情简介经解码（xiuren def 即该模板） ── */
{
  setFetchPage(async (url) => (url.includes("/posts/601") ? fx("wp-rest-entity-detail.json") : fx("wp-rest-entity-list.json")));
  const a = createWpRestAdapter(def("xiuren"));
  const list = await a.list(1, 20);
  assert.equal(list.items[0].title, "Alpha's Album – Set & More", "wp-rest 列表标题实体解码");
  assert.equal(list.items[1].title, "Beta 'quoted' Title", "wp-rest 列表标题十六进制实体解码");
  const detail = await a.detail("601");
  assert.equal(detail.description, "Intro 'quoted' text … end", "wp-rest 详情简介实体解码");
  assert.equal(detail.images.length, 2, "wp-rest 详情图集不受解码改动影响");
}

/* ── (2b) hls-site：锚点标题两路＋详情 og 字段经解码 ── */
{
  const SYNTH = {
    id: "synth-entity", displayName: "合成", kind: "video", category: "video",
    adapter: { template: "hls-site", params: { listPath: "/", itemLinkPattern: "/video/", detailPath: "/video/{id}" } },
    baseUrls: ["https://example.com"], enabled: true, order: 999, maturity: "probe",
    capabilities: { search: false, episodes: false, hevc: false, comments: false },
    network: { mode: "probe-required" }, note: "合成夹具 def",
  } as unknown as SourceDef;
  setFetchPage(async (url) => (url.includes("/video/") ? fx("hls-detail-entity.html") : fx("hls-list-entity.html")));
  const a = createHlsSiteAdapter(SYNTH);
  const list = await a.list(1, 20);
  assert.equal(list.items.length, 2, "hls 列表夹具 2 条");
  assert.equal(list.items[0].title, "Rock 'n' Roll", "锚点 title 属性实体解码");
  assert.equal(list.items[1].title, "Second ’s Heading", "锚点 h3 标题实体解码");
  const detail = await a.detail(list.items[0].externalId);
  assert.equal(detail.title, "Tom's Video – HD", "详情 og:title 实体解码");
  assert.equal(detail.description, "It's a test & demo …", "详情 meta description 实体解码");
}

/* ── (3) 图片线逐源定级 ── */
{
  const xr = def("xiuren");
  assert.equal(xr.baseUrls[0], "https://xiuren.biz", "xiuren 生效域名为 xiuren.biz（住宅/本机均不可达的 .com 退为其后）");
  assert.equal(xr.maturity, "probe", "xiuren 解 blocked → probe（本机四级全通、App 未真机验）");
  assert.equal(xr.enabled, true, "xiuren 保持启用");
  assert.equal(xr.capabilities.search, true, "xiuren wp-rest 搜索端点实证可用、search 属实 true");

  /* 断言适配（fix338/registry-cut）：danbooru 已按用户裁定摘除注册
   * 表（单图帖不算资源），原翻案定级断言改为不在册断言；同批
   * konachan（CF JS 验证无解）同口径。 */
  assert.ok(!getBuiltinRegistry().some((s) => s.id === "danbooru"), "danbooru 已摘除注册表（fix338）");
  assert.ok(!getBuiltinRegistry().some((s) => s.id === "konachan"), "konachan 已摘除注册表（fix338）");

  /* 断言适配（fix335/g-sources）：pornpics 已按用户裁定退役摘除注册
   * 表，原定级断言（维持 probe/search 属实 false）改为不在册断言。 */
  assert.ok(!getBuiltinRegistry().some((s) => s.id === "pornpics"), "pornpics 已摘除注册表（fix335/g-sources）");

  for (const id of ["pixibb", "nudecosplay"]) {
    const s = def(id);
    assert.equal(s.enabled, true, `${id} 本机四级全通＋住宅两级正常存档 → 启用`);
    assert.equal(s.maturity, "probe", `${id} 定级 probe（App 未真机验）`);
    assert.equal(s.capabilities.search, true, `${id} wp-rest 搜索端点实证可用、search 属实 true`);
    assert.ok(!s.note?.includes("未实测"), `${id} note 已按实证更新、不再写未实测`);
  }
  /* yandere 原定级断言（fix335/g-sources moebooru 校准启用）随
   * fix339/registry-cut-2 摘除改为不在册断言（单图帖与 danbooru 同
   * 标准删、用户 2026-11-21 确认）；其模板校准形态覆盖由 adapters
   * 契约合成 def 承接。（同批的 konachan 已于 fix338 摘除。） */
  assert.ok(!getBuiltinRegistry().some((s) => s.id === "yandere"), "yandere 已摘除注册表（fix339）");
  for (const id of ["gelbooru", "pixiv"]) {
    const s = def(id);
    assert.equal(s.enabled, false, `${id} 无模板级真列表证据/按排除口径 → 维持未启用`);
  }
  assert.ok(def("gelbooru").note?.includes("401"), "gelbooru note 记 dapi 匿名 401（需凭证）");
  assert.ok(def("pixiv").note?.includes("登录"), "pixiv note 记需登录排除理由");
}

console.log("fix330-images.contract: all assertions passed");
