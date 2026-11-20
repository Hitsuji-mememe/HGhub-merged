/**
 * 3.3.0 接通批·吃瓜线契约测试（Muse 2026-11-19，任务书即维护者对
 * 新增测试的授权，AGENTS 不变量 11）。
 * 运行：node src/features/sources/fix330-chigua.contract.test.ts
 *
 * 覆盖：
 * (A) 黑料网浏览面根因证伪——旧路由：Posts 页与分类总览对一切非黄果
 *     吃瓜源无条件 SourcePendingNotice（适配器从未被调用，feedheiliao
 *     的 enabled/probe 与 chigua 适配器形同虚设）；新判定
 *     resolvePostsBrowse（postsRoute.ts）：黄果→native、blocked→
 *     blocked（诚实提示、不拉数据）、其余已启用→browse（经适配器
 *     真实渲染）。旧代码上 postsRoute.ts 不存在、判定无从成立＝红。
 * (B) 注册表三源：meiridasai 解 blocked（mrds66 在前与清单 v3 一致、
 *     listPath 按真站 /page/{page}/ 校准、maturity=probe）；
 *     51chigua/meiridasai 搜索段接线（searchPath=/search/{q}/{page}/、
 *     capabilities.search=true）；feedheiliao 无搜索段属实
 *     （capabilities.search=false 不变——本机出口实证：三种 GET 搜索
 *     形态均返回关键词不变页，见 fix330/evidence/chigua.md）。
 * (C) 适配器数据流（构造夹具、不访问网络）：meiridasai list 请求
 *     URL 形态；51 search 请求 URL=/search/{q}/{page}/ 且解析出条目；
 *     黑料网 detail 正文容器 editormd-preview 被捕获、resolve 出 HLS。
 * (D) 联动：mrds66/heiliao origin 入生产取页白名单；扇出资格随
 *     caps 属实变化（51/meiridasai 进、heiliao 不进）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "./registry.ts";
import { resolvePostsBrowse } from "./postsRoute.ts";
import { createChiguaAdapter } from "./adapters/templates.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { sourceFetchAllowlistOrigins } from "./allowlist.ts";
import { searchPolicyFor } from "../search/multiSourceSearch.ts";
import type { SourceDef } from "./types.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");
const def = (id: string): SourceDef => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};

/* ── (A) 浏览面路由判定：旧恒提示 vs 新三分 ── */
{
  assert.equal(resolvePostsBrowse(def("huangguo")), "native", "黄果走原生通道");
  for (const id of ["51chigua", "feedheiliao", "meiridasai"]) {
    assert.equal(resolvePostsBrowse(def(id)), "browse", `${id} 已启用非 blocked → 经适配器浏览（旧判定恒提示页）`);
  }
  const blockedSynth: SourceDef = { ...def("feedheiliao"), maturity: "blocked" };
  assert.equal(resolvePostsBrowse(blockedSynth), "blocked", "blocked 仍走诚实提示、不拉数据");
  assert.equal(resolvePostsBrowse(undefined), "blocked", "源缺失按 blocked 诚实提示");

  const posts = read("../posts/Posts.tsx");
  assert.ok(posts.includes("resolvePostsBrowse(activeSource)"), "Posts 页按统一判定分流（不再无条件提示）");
  assert.ok(posts.includes("<SourcePosts def={activeSource}"), "Posts 页 browse 分支挂载 SourcePosts");
  /* 断言适配（fix335/e-category 总览索引化）：总览吃瓜预览退场，
   * 总览面对 posts 的关系改经 surfaces 派生表达——派生内部仍以
   * 同一 resolvePostsBrowse 分流（overview-posts 面），判定出处
   * 不变；Category 侧原预览分流断言改钉派生消费点。 */
  const surfaces = read("./surfaces.ts");
  assert.ok(surfaces.includes("resolvePostsBrowse(def)"), "surfaces 的 overview-posts/posts-page 派生同判定分流（总览索引化后经派生消费同一判定）");
  const browse = read("./SourcePosts.tsx");
  assert.ok(browse.includes("createAdapter(def)"), "SourcePosts 生产调用 createAdapter");
}

/* ── (B) 注册表三源 ── */
{
  const cg = def("51chigua");
  assert.equal(cg.capabilities.search, true, "51吃瓜搜索段已接线（/search/{q}/{page}/ 本机出口实证真出条目）");
  assert.equal((cg.adapter.params as Record<string, unknown>).searchPath, "/search/{q}/{page}/", "51吃瓜 searchPath 按真站校准");
  assert.equal((cg.adapter.params as Record<string, unknown>).listPath, "/page/{page}/", "51吃瓜 listPath 与真站一致");

  const hl = def("feedheiliao");
  assert.equal(hl.enabled, true, "黑料网 enabled");
  assert.equal(hl.maturity, "probe", "黑料网 maturity=probe（App 真机未验）");
  assert.equal(hl.capabilities.search, false, "黑料网无搜索段属实：GET 搜索形态返回关键词不变页，不许虚报");

  const md = def("meiridasai");
  assert.equal(md.baseUrls[0], "https://www.mrds66.com", "每日大赛主域换 mrds66（与远程清单 v3 一致）");
  assert.equal(md.maturity, "probe", "每日大赛解 blocked→probe（住宅四级全通＋本机出口四级实证、App 真机未验）");
  assert.equal((md.adapter.params as Record<string, unknown>).listPath, "/page/{page}/", "每日大赛 listPath 按 mrds66 真站校准（旧 /?page= 作废）");
  assert.equal((md.adapter.params as Record<string, unknown>).searchPath, "/search/{q}/{page}/", "每日大赛 searchPath 按真站校准");
  assert.equal(md.capabilities.search, true, "每日大赛搜索段已接线");
}

/* ── (C) 适配器数据流（构造夹具） ── */
{
  /* meiridasai list：请求 URL 必须是新域 + /page/1/ */
  let seenUrl = "";
  setFetchPage(async (url) => { seenUrl = url; return fx("chigua-list.html"); });
  const mdList = await createChiguaAdapter(def("meiridasai")).list(1, 20);
  assert.equal(seenUrl, "https://www.mrds66.com/page/1/", "每日大赛列表请求落 mrds66 /page/1/");
  assert.equal(mdList.items.length, 2, "每日大赛列表夹具解析 2 条（去重后）");

  /* 51 search：URL=/search/{q}/{page}/、解析出条目 */
  seenUrl = "";
  setFetchPage(async (url) => { seenUrl = url; return fx("chigua-search.html"); });
  const cgSearch = await createChiguaAdapter(def("51chigua")).search!("keyword", 2, 20);
  assert.equal(seenUrl, "https://51cg1.com/search/keyword/2/", "51吃瓜搜索请求按真站形态 /search/{q}/{page}/");
  assert.equal(cgSearch.items.length, 2, "51吃瓜搜索夹具解析 2 条");

  /* 黑料网 detail：editormd-preview 正文被捕获（旧正则恒 undefined）、resolve 出 HLS */
  setFetchPage(async () => fx("chigua-heiliao-detail.html"));
  const hl = createChiguaAdapter(def("feedheiliao"));
  const detail = await hl.detail("https://heiliao.com/archives/901/");
  assert.ok(detail.contentHtml?.includes("夹具正文第一段"), "黑料网正文经 editormd-preview 容器捕获");
  assert.ok(!detail.contentHtml?.includes("正文捕获终止标记"), "正文捕获在 detail-blockquote 段前终止");
  const res = await hl.resolve("https://heiliao.com/archives/901/");
  assert.equal(res.streams[0]?.kind, "hls", "黑料网 resolve 出 HLS 流");
}

/* ── (D) 白名单与扇出联动 ── */
{
  const allow = new Set(sourceFetchAllowlistOrigins(getBuiltinRegistry()));
  assert.ok(allow.has("https://www.mrds66.com"), "mrds66 origin 入生产取页白名单（解 blocked 派生）");
  assert.ok(allow.has("https://heiliao.com"), "heiliao origin 在白名单内（浏览面取页前提）");
  assert.equal(searchPolicyFor(def("51chigua")).include, true, "51吃瓜具备搜索段进扇出");
  assert.equal(searchPolicyFor(def("meiridasai")).include, true, "每日大赛具备搜索段进扇出");
  assert.equal(searchPolicyFor(def("feedheiliao")).include, false, "黑料网无搜索段不进扇出（静默出局）");
}

console.log("fix330-chigua.contract: all assertions passed");
