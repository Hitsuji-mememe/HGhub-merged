/**
 * 3.2.1 修复批验收员 D 独立证伪测试（fix321-F2/F2b 验收，2026-11-19）。
 * 与施工方 fix321-f2/f2b 契约的区别：断言不复用其夹具断言组合——
 * (A) 频道映射以注册表真实数据全量枚举＋合成源双向验证（防硬编码名单）；
 * (B) 浏览面输入以 sourcesForCategory/sourcesForChannel 对全注册表＋
 *     合成停用源枚举（Category 实际渲染输入即这两函数的输出）；
 * (C) 假成功空页走工厂分发路径（含 F2 契约未覆盖的 chigua
 *     列表、SWAG 全过滤、RedGifs 空结果三条路径）；
 * (E) 搜索扇出资格门全量枚举（2026-11-19 20:48 裁定后为搜索段结构门，见节内适配注记）；
 * (F) 51吃瓜解 blocked／黑料网毕业的内置面三面一致（诊断/浏览/搜索）；
 * (G) 详情打开路径经工厂逐源走 list→resolve/detail。
 * 已知缺口（清单覆盖层把 API origin 顶掉等）不在本文件断言，见
 * fix321-f2-accept-gaps.contract.test.ts（预期红，独立成文）。
 * 运行：node src/features/sources/fix321-f2-accept.contract.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry, sourcesForCategory, sourcesForChannel } from "./registry.ts";
import { CATALOG_SOURCES } from "./catalog.ts";
import { getRegistryInfo } from "./manifest.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { createChiguaAdapter, createHlsSiteAdapter, createRedgifsAdapter, createSwagAdapter, SourceParseEmptyError } from "./adapters/templates.ts";

/* 工厂分发口径（同 final-d 契约）：adapters/index.ts 的 createAdapter
 * 含无扩展名导入、Node 直跑不可加载，故直测其分发的模板工厂函数，
 * 并逐条断言分发行文本在位——两者合起来等价于经工厂调用。 */
const factoryDispatch = readFileSync(new URL("./adapters/index.ts", import.meta.url), "utf8");
for (const line of [
  'case "chigua": return createChiguaAdapter(def)',
  'case "hls-site": return createHlsSiteAdapter(def)',
  'case "swag-api": return createSwagAdapter(def)',
  'case "redgifs-api": return createRedgifsAdapter(def)',
]) assert.ok(factoryDispatch.includes(line), `createAdapter 分发在位：${line}`);
type AnyAdapter = ReturnType<typeof createHlsSiteAdapter>;
const createAdapter = (d: SourceDef): AnyAdapter | null => {
  switch (d.adapter.template) {
    case "chigua": return createChiguaAdapter(d);
    case "hls-site": return createHlsSiteAdapter(d);
    case "swag-api": return createSwagAdapter(d) as AnyAdapter;
    case "redgifs-api": return createRedgifsAdapter(d) as AnyAdapter;
    default: return null;
  }
};
import { searchPolicyFor } from "../search/multiSourceSearch.ts";
import type { SourceDef } from "./types.ts";

const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");
const reg = getBuiltinRegistry();
/* 断言适配（3.2.2 瘦身）：rouvideo/swag/redgifs/fc2 已摘除注册表、
 * 适配器留仓，四源改用与删除前注册表功能字段逐字一致的夹具 def
 * 守工厂路径覆盖，断言内容不变；保留源仍走注册表 def。 */
const FIXTURE_DEFS: Record<string, unknown> = {
  rouvideo: { id: "rouvideo", displayName: "肉视频", kind: "video", category: "video",
    adapter: { template: "hls-site", params: { listPath: "/home", itemLinkPattern: "/v/", detailPath: "/v/{id}", streamUrlTemplate: "/api/hls/{id}" } },
    baseUrls: ["https://rou.video"], enabled: true, order: 20, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false, comments: false }, note: "历史注册表条目" },
  swag: { id: "swag", displayName: "SWAG", kind: "video", category: "video",
    adapter: { template: "swag-api", params: {} },
    baseUrls: ["https://swag.live", "https://api.swag.live"], enabled: true, order: 25, maturity: "probe",
    capabilities: { search: false, episodes: false, hevc: false, comments: false }, note: "历史注册表条目" },
  redgifs: { id: "redgifs", displayName: "RedGifs", kind: "video", category: "video",
    adapter: { template: "redgifs-api", params: {} },
    baseUrls: ["https://www.redgifs.com", "https://api.redgifs.com"], enabled: true, order: 27, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false, comments: false }, note: "历史注册表条目" },
  fc2: { id: "fc2", displayName: "FC2", kind: "video", category: "video",
    adapter: { template: "hls-site", params: { listPath: "/ranking/article/weekly?page={page}", itemLinkPattern: "/article_search.php?id=", detailPath: "/article/{id}/" } },
    baseUrls: ["https://adult.contents.fc2.com"], enabled: true, order: 29, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false, comments: false }, note: "历史注册表条目" },
};
const def = (id: string) => {
  const d = reg.find((s) => s.id === id) ?? FIXTURE_DEFS[id];
  assert.ok(d, `registry/fixture has ${id}`);
  return d as SourceDef;
};

/* ── (A) 频道映射：全量枚举，成员资格必须恰等于不变量谓词
 * （短剧＝enabled∧category=video∧capabilities.episodes；
 *  视频＝enabled∧category=video），不许名单式特判。 ── */
{
  const drama = sourcesForChannel("ai-duanju", reg);
  const expectDrama = reg.filter((s) => s.enabled && s.category === "video" && s.capabilities.episodes);
  assert.deepEqual(drama.map((s) => s.id), expectDrama.map((s) => s.id), "短剧频道名单＝谓词全量枚举");
  const video = sourcesForChannel("original", reg);
  const expectVideo = reg.filter((s) => s.enabled && s.category === "video");
  assert.deepEqual(video.map((s) => s.id), expectVideo.map((s) => s.id), "视频频道名单＝谓词全量枚举");
  for (const id of ["hanime-tv", "rule34video"]) {
    assert.ok(!drama.some((s) => s.id === id), `用户实报 offender ${id} 不在短剧切源名单`);
  }
  /* 合成双向：停用的 episodes 源不得入、启用的 episodes 源必须入
   * （证明按字段判定而非硬编码排除名单） */
  const mk = (id: string, enabled: boolean, episodes: boolean): SourceDef => ({
    ...def("rule34video"), id, enabled, capabilities: { search: true, episodes, hevc: false, comments: false },
  });
  const synth = [mk("vd-drama-off", false, true), mk("vd-drama-on", true, true), mk("vd-nodrama", true, false)];
  const sd = sourcesForChannel("ai-duanju", synth);
  assert.deepEqual(sd.map((s) => s.id), ["vd-drama-on"], "合成源：仅 enabled∧episodes 入短剧频道");
  assert.deepEqual(sourcesForChannel("unknown-cate", reg), [], "无映射频道返回空（回落原生）");
}

/* ── (B) 未启用源不进任何浏览面输入：全注册表枚举＋合成停用源 ── */
{
  const disabledIds = reg.filter((s) => !s.enabled).map((s) => s.id);
  assert.ok(disabledIds.length >= 5, `注册表确有停用源可枚举（实得 ${disabledIds.length}）`);
  for (const cate of ["posts", "video", "image", "preview"] as const) {
    const listed = sourcesForCategory(cate, reg);
    assert.ok(listed.every((s) => s.enabled), `${cate} 分类输入只含已启用源`);
    for (const id of disabledIds) assert.ok(!listed.some((s) => s.id === id), `停用源 ${id} 不进 ${cate} 浏览面`);
  }
  for (const cate of ["ai-duanju", "original"]) {
    assert.ok(sourcesForChannel(cate, reg).every((s) => s.enabled), `${cate} 频道输入只含已启用源`);
  }
  const synthOff: SourceDef = { ...def("pornpics"), id: "vd-off-image", enabled: false };
  assert.ok(!sourcesForCategory("image", [...reg, synthOff]).some((s) => s.id === "vd-off-image"), "合成停用图片源不进图片分区输入");
}

/* ── (C) 假成功空页：经生产工厂 createAdapter 的空解析路径 ── */
{
  /* C1 chigua 模板（51吃瓜 def）喂 SPA 壳形态页 → 必须显式失败
   * （F2 契约只验过 hls-site 同路径，chigua 与之共用 htmlListAdapter
   * 但未经工厂验过） */
  setFetchPage(async () => fx("real-swag-home.html"));
  const chigua = createAdapter(def("51chigua"));
  assert.ok(chigua, "51吃瓜有适配器");
  await assert.rejects(() => chigua!.list(1, 20), SourceParseEmptyError, "chigua 列表解析为空经工厂抛 SourceParseEmptyError");
  /* C2 零锚点空白页（hls-site 肉视频 def） */
  setFetchPage(async () => "<html><body><p>nothing</p></body></html>");
  const rou = createAdapter(def("rouvideo"));
  await assert.rejects(() => rou!.list(1, 20), SourceParseEmptyError, "零锚点页抛 SourceParseEmptyError、不返回空列表");
  /* C3 SWAG：feed 有行但逐条 messages 全被免费短视频过滤 → 显式失败 */
  const feedRow = JSON.parse(fx("real-swag-feed.json"))[0] as Record<string, unknown>;
  const paidMsg = JSON.stringify({ ...(JSON.parse(fx("real-swag-message.json")) as Record<string, unknown>), unlockPrice: 9 });
  setFetchPage(async (url) => url.includes("/feeds/") ? JSON.stringify([feedRow]) : paidMsg);
  const swag = createAdapter(def("swag"));
  await assert.rejects(() => swag!.list(1, 20), SourceParseEmptyError, "SWAG 全行被过滤后抛 SourceParseEmptyError");
  /* C4 RedGifs：API 空结果集 → 显式失败 */
  setFetchPage(async (url) => url.includes("/v2/auth/temporary")
    ? JSON.stringify({ token: "t" })
    : JSON.stringify({ gifs: [], pages: 0, page: 1 }));
  const rg = createAdapter(def("redgifs"));
  await assert.rejects(() => rg!.list(1, 20), SourceParseEmptyError, "RedGifs 空结果集抛 SourceParseEmptyError");
}

/* ── (E) 扇出交叉（裁定变更适配，用户 2026-11-19 20:48）：扇出门
 * 已由 F5 三段齐全门放宽为搜索段结构门——保留源具备搜索段一律进
 * 扇出（probe/blocked 成熟度不再在搜索入口扣留，可播性后移详情/
 * 起播解析）；无搜索段的源（吃瓜模板/无适配器）仍出局。纳入集恰
 * 为保留集内 enabled∧有搜索段的源（fix330 接通批后 10 源：新增
 * hanime1/iwara/hentaihaven 三源均带 search 段并启用，断言适配）。 ── */
{
  for (const id of ["51chigua", "feedheiliao", "meiridasai"]) {
    const p = searchPolicyFor(def(id));
    assert.equal(p.include, false, `吃瓜源 ${id} 无搜索段、不进扇出（结构门）`);
  }
  for (const id of ["hanime-tv", "pornpics", "xiuren", "danbooru"]) {
    const p = searchPolicyFor(def(id));
    assert.equal(p.include, true, `保留源 ${id} 具备搜索段即进扇出（成熟度 ${def(id).maturity} 不再预扣）`);
  }
  const included = reg.filter((s) => searchPolicyFor(s).include).map((s) => s.id).sort();
  assert.deepEqual(included, ["cosplaytele", "danbooru", "hanime-tv", "hanime1", "hentaihaven", "huangguo", "iwara", "pornpics", "rule34video", "xiuren"],
    "扇出纳入集＝保留集内具备搜索段的 10 源（20:48 裁定口径＋fix330 接通批三源）");
}

/* ── (F) 51吃瓜解 blocked＋黑料网毕业：内置面三面一致 ── */
{
  const cg = def("51chigua");
  assert.equal(cg.baseUrls[0], "https://51cg1.com", "51吃瓜内置域名 51cg1.com");
  assert.notEqual(cg.maturity, "blocked", "51吃瓜内置 maturity 非 blocked");
  assert.ok(sourcesForCategory("posts", reg).some((s) => s.id === "51chigua"), "51吃瓜在吃瓜浏览面切源输入内（enabled）");
  const info = getRegistryInfo();
  const cgInfo = info.sources.find((s) => s.id === "51chigua");
  assert.equal(cgInfo?.origin, "https://51cg1.com", "诊断面（getRegistryInfo）51吃瓜生效 origin 与内置一致");
  assert.equal(cgInfo?.maturity, "probe", "诊断面 51吃瓜 maturity=probe 与注册表一致");
  const hl = def("feedheiliao");
  assert.equal(hl.enabled, true, "黑料网内置 enabled=true");
  assert.deepEqual(hl.baseUrls, ["https://heiliao.com", "https://www.heiliao88.com"], "黑料网双域名与清单 v2 同口径");
  assert.ok(!CATALOG_SOURCES.some((s) => s.id === "feedheiliao"), "黑料网已自 catalog 毕业（注册表单一定义在命名源）");
  assert.ok(sourcesForCategory("posts", reg).some((s) => s.id === "feedheiliao"), "黑料网在吃瓜浏览面切源输入内");
}

/* ── (G) 详情打开路径（工厂→list→resolve/detail，真站夹具） ── */
{
  setFetchPage(async (url) => url.includes("/ranking/") ? fx("real-fc2-ranking.html") : fx("real-fc2-article.html"));
  const fc2 = createAdapter(def("fc2"))!;
  const fc2List = await fc2.list(1, 20);
  assert.ok(fc2List.items.length >= 2, "FC2 列表出条目");
  assert.deepEqual((await fc2.resolve(fc2List.items[0].externalId)).streams, [], "FC2 点开诚实无流（PPV）而非假流");
  setFetchPage(async (url) => url.includes("/archives/") ? fx("real-heiliao-detail.html") : fx("real-heiliao-home.html"));
  const hl = createAdapter(def("feedheiliao"))!;
  const hlList = await hl.list(1, 20);
  assert.ok((await hl.resolve(hlList.items[0].externalId)).streams[0]?.url.includes(".m3u8"), "黑料网点开取到 HLS 流");
  setFetchPage(async (url) => url.includes("/archives/") ? fx("real-51cg-detail.html") : fx("real-51cg-home.html"));
  const cg = createAdapter(def("51chigua"))!;
  const cgList = await cg.list(1, 20);
  assert.ok((await cg.resolve(cgList.items[0].externalId)).streams[0]?.url.includes(".m3u8"), "51吃瓜点开取到 HLS 流");
}

console.log("fix321-f2-accept.contract: all assertions passed");
