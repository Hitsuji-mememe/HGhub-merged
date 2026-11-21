/**
 * 3.3.0 接通批·新适配器线契约测试（Muse 2026-11-19 fix330；本批
 * 任务书即维护者对新增测试的授权，AGENTS 不变量 11）：
 * 运行：node src/features/sources/fix330-new-adapters.contract.test.ts
 * 背景：保留源接通批——Iwara/Hanime1 自探路保留转专用适配器启用
 * （同批的 HentaiHaven 已于 fix338/registry-cut 摘除、其断言块与
 * 夹具随适配器同删，本文件头保留其历史出处；Hanime1 已于
 * fix3311/registry-cleanup 试装判删回、其断言块与夹具同删）。
 * 结构依据为
 * Hentai-Park 公开插件（iwara.js/hanime1.js）的协议事实（只借
 * 协议/结构、代码原创）；夹具为按声明形态构造的合成样本（占位
 * 标题/编号、非真站内容），本机机房出口两源均 CF 403、无真站抓取
 * （出口形态与住宅验收分开记录，见 fix330/evidence/new-adapters.md）。
 * 覆盖：两源注册表启用口径、工厂分发、list/search/detail/resolve
 * 四段夹具实证、Iwara X-Version 签名值对照（Node createHash）、
 * 取页白名单含两源所需 origin、搜索扇出纳入。不访问真实网络。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "./registry.ts";
import { createIwaraAdapter } from "./adapters/templates.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { templateFetchOrigins } from "./adapters/fetchOrigins.ts";
import { sourceFetchAllowlistOrigins } from "./allowlist.ts";
import { searchPolicyFor } from "../search/multiSourceSearch.ts";

const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");
const def = (id: string) => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};

/* ── 注册表启用口径：Iwara enabled=true、专用模板、search 声明、
 * maturity=probe（App 未真机验不上调）。 ── */
{
  const iwara = def("iwara");
  assert.equal(iwara.adapter.template, "iwara-api", "Iwara 专用 API 模板");
  assert.equal(iwara.enabled, true, "Iwara 启用");
  assert.equal(iwara.capabilities.search, true, "Iwara 声明搜索段（站点有 /search 接口）");
  assert.equal(iwara.maturity, "probe", "Iwara probe（未真机验）");
  assert.ok(iwara.baseUrls.includes("https://api.iwara.tv"), "Iwara API origin 入 baseUrls");

  /* 工厂分发以文本断言守（adapters/index.ts 为无扩展名导入、契约
   * 环境不直引；与 final-d 的 hls-site 分发断言同口径），适配器
   * 本体经 templates.ts 直引实跑（下方四段）。 */
  const factory = readFileSync(new URL("./adapters/index.ts", import.meta.url), "utf8");
  for (const [id, factoryFn] of [["iwara", "createIwaraAdapter"]] as const) {
    assert.ok(factory.includes(`return ${factoryFn}(def)`), `${id} 工厂分发 → ${factoryFn}`);
    assert.equal(searchPolicyFor(def(id)).include, true, `${id} 进搜索扇出（已启用∧具备搜索段）`);
  }
  for (const [id, a] of [["iwara", createIwaraAdapter(def("iwara"))]] as const) {
    assert.equal(typeof a.search, "function", `${id} 适配器真有 search 方法`);
  }
}

/* ── 取页白名单：Iwara 经生产派生在名单内；iwara-api 模板声明
 * 含 API 与两文件 host（清单覆盖 baseUrls 削不掉）。 ── */
{
  const allow = new Set(sourceFetchAllowlistOrigins(getBuiltinRegistry()));
  for (const o of ["https://www.iwara.tv", "https://api.iwara.tv", "https://files.iwara.tv", "https://filesq.iwara.tv"]) {
    assert.ok(allow.has(o), `生产白名单含 ${o}`);
  }
  assert.deepEqual(templateFetchOrigins("iwara-api"), ["https://api.iwara.tv", "https://files.iwara.tv", "https://filesq.iwara.tv"], "iwara-api 模板声明 = API＋两文件 host");
}

/* ── Iwara：四段夹具实证（列表/搜索/详情/取流签名链） ── */
{
  const seen: { url: string; xVersion?: string }[] = [];
  setFetchPage(async (url, headers) => {
    seen.push({ url, xVersion: headers?.["X-Version"] });
    if (url.includes("files.iwara.tv")) return fx("iwara-sources.json");
    if (url.includes("/video/")) return fx("iwara-video.json");
    if (url.includes("/videos?") || url.includes("/search?")) return fx("iwara-list.json");
    throw new Error(`unexpected fetch ${url}`);
  });
  const a = createIwaraAdapter(def("iwara"));
  const list = await a.list(1, 20);
  assert.equal(list.items.length, 2, "Iwara 列表经公开 API 出条目");
  assert.equal(list.items[0].externalId, "Ab12Cd34Ef56", "Iwara 条目 id 为 API 视频 id");
  assert.ok(list.items[0].cover.startsWith("https://files.iwara.tv/image/thumbnail/"), "Iwara 封面由 file.id 拼 thumbnail 路径");
  const listCall = seen.find((s) => s.url.includes("/videos?"));
  assert.ok(listCall?.url.includes("page=0"), "Iwara 列表 API 分页为 0 基（App 第 1 页 → page=0）");

  const search = await a.search!("夹具", 1, 20);
  assert.equal(search.items.length, 2, "Iwara 搜索段经 /search 接口出条目");
  const searchCall = seen.find((s) => s.url.includes("/search?"));
  assert.ok(searchCall?.url.includes("type=videos"), "Iwara 搜索带 type=videos");

  const detail = await a.detail("Ab12Cd34Ef56");
  assert.equal(detail.title, "夹具条目一", "Iwara 详情按 /video/<id> 取数");

  const r = await a.resolve("Ab12Cd34Ef56");
  assert.equal(r.streams[0]?.kind, "file", "Iwara 流为 mp4 文件");
  assert.ok(r.streams[0]?.url.endsWith("-720.mp4"), "Iwara resolve 取最高档（720 > 360）");
  const fileCall = seen.find((s) => s.url.includes("files.iwara.tv/video/"));
  const expected = createHash("sha1").update("fixturefile001_1893456000_mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN").digest("hex");
  assert.equal(fileCall?.xVersion, expected, "Iwara 取流带 X-Version = sha1(末段_expires_盐)（纯 TS SHA-1 与 Node 对照一致）");
}

console.log("fix330-new-adapters.contract: all assertions passed");
