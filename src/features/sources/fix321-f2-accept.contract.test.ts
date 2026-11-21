/**
 * 3.2.1 修复批验收员 D 独立证伪测试（fix321-F2/F2b 验收，2026-11-19）。
 * 与施工方 fix321-f2/f2b 契约的区别：断言不复用其夹具断言组合——
 * (A) 频道映射以注册表真实数据全量枚举＋合成源双向验证（防硬编码名单）；
 * (B) 浏览面输入以 sourcesForCategory/sourcesForChannel 对全注册表＋
 *     合成停用源枚举（Category 实际渲染输入即这两函数的输出）；
 * (C) 假成功空页走工厂分发路径（含 F2 契约未覆盖的 chigua
 *     列表路径；原 SWAG 全过滤／RedGifs 空结果两路随其模板簇
 *     退役同删，fix3311/registry-cleanup）；
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
import { createChiguaAdapter, createHlsSiteAdapter, SourceParseEmptyError } from "./adapters/templates.ts";

/* 工厂分发口径（同 final-d 契约）：adapters/index.ts 的 createAdapter
 * 含无扩展名导入、Node 直跑不可加载，故直测其分发的模板工厂函数，
 * 并逐条断言分发行文本在位——两者合起来等价于经工厂调用。 */
const factoryDispatch = readFileSync(new URL("./adapters/index.ts", import.meta.url), "utf8");
for (const line of [
  'case "chigua": return createChiguaAdapter(def)',
  'case "hls-site": return createHlsSiteAdapter(def)',
]) assert.ok(factoryDispatch.includes(line), `createAdapter 分发在位：${line}`);
type AnyAdapter = ReturnType<typeof createHlsSiteAdapter>;
const createAdapter = (d: SourceDef): AnyAdapter | null => {
  switch (d.adapter.template) {
    case "chigua": return createChiguaAdapter(d);
    case "hls-site": return createHlsSiteAdapter(d);
    default: return null;
  }
};
import { searchPolicyFor } from "../search/multiSourceSearch.ts";
import type { SourceDef } from "./types.ts";

const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");
const reg = getBuiltinRegistry();
/* 断言适配（3.2.2 瘦身）：rouvideo/fc2 已摘除注册表、
 * 适配器留仓，两源改用与删除前注册表功能字段逐字一致的夹具 def
 * 守工厂路径覆盖，断言内容不变；保留源仍走注册表 def。
 * 断言适配（fix3311/registry-cleanup）：swag/redgifs 夹具 def 随
 * 其模板簇整体退役同删。 */
const FIXTURE_DEFS: Record<string, unknown> = {
  rouvideo: { id: "rouvideo", displayName: "肉视频", kind: "video", category: "video",
    adapter: { template: "hls-site", params: { listPath: "/home", itemLinkPattern: "/v/", detailPath: "/v/{id}", streamUrlTemplate: "/api/hls/{id}" } },
    baseUrls: ["https://rou.video"], enabled: true, order: 20, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false }, note: "历史注册表条目" },
  fc2: { id: "fc2", displayName: "FC2", kind: "video", category: "video",
    adapter: { template: "hls-site", params: { listPath: "/ranking/article/weekly?page={page}", itemLinkPattern: "/article_search.php?id=", detailPath: "/article/{id}/" } },
    baseUrls: ["https://adult.contents.fc2.com"], enabled: true, order: 29, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false }, note: "历史注册表条目" },
  /* 断言适配（fix335/g-sources）：pornpics 已退役摘除注册表，按删除前
   * 注册表条目功能字段入夹具表（同上方两源先例），守合成停用源与
   * 搜索属实 false 两处覆盖，断言内容不变。 */
  pornpics: { id: "pornpics", displayName: "PornPics", kind: "image", category: "image",
    adapter: { template: "hls-site", params: { listPath: "/recent/", itemLinkPattern: "/galleries/", detailPath: "/galleries/{id}/" } },
    baseUrls: ["https://www.pornpics.com"], enabled: true, order: 41, maturity: "probe",
    capabilities: { search: false, episodes: false, hevc: false }, note: "历史注册表条目" },
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
  for (const id of ["hanime-tv"]) {
    assert.ok(!drama.some((s) => s.id === id), `用户实报 offender ${id} 不在短剧切源名单`);
  }
  /* 合成双向：停用的 episodes 源不得入、启用的 episodes 源必须入
   * （证明按字段判定而非硬编码排除名单）。合成基底原用 rule34video，
   * 已摘除后改 iwara（同为 video 分类保留源，fix330/ui-fixes 适配）；
   * iwara 已摘除（fix339/registry-cut-2），基底改唯一保留 video 源
   * hanime-tv，合成覆盖不变。 */
  const mk = (id: string, enabled: boolean, episodes: boolean): SourceDef => ({
    ...def("hanime-tv"), id, enabled, capabilities: { search: true, episodes, hevc: false },
  });
  const synth = [mk("vd-drama-off", false, true), mk("vd-drama-on", true, true), mk("vd-nodrama", true, false)];
  const sd = sourcesForChannel("ai-duanju", synth);
  assert.deepEqual(sd.map((s) => s.id), ["vd-drama-on"], "合成源：仅 enabled∧episodes 入短剧频道");
  assert.deepEqual(sourcesForChannel("unknown-cate", reg), [], "无映射频道返回空（回落原生）");
}

/* ── (B) 未启用源不进任何浏览面输入：全注册表枚举＋合成停用源 ── */
{
  const disabledIds = reg.filter((s) => !s.enabled).map((s) => s.id);
  /* 断言适配（3.3.0 集成）：hanime1/iwara 已启用，停用源由 5 减为 3（yandere/gelbooru/pixiv），枚举下限随之改 3，逐源排除断言不变。 */
  /* 断言适配（fix335/g-sources）：yandere 已启用，停用源减为 2（gelbooru/pixiv），枚举下限随之改 2，逐源排除断言不变。 */
  /* 断言适配（fix339/registry-cut-2）：yandere 已摘除不在册，停用源仍为 2（gelbooru/pixiv），枚举下限不变。 */
  assert.ok(disabledIds.length >= 2, `注册表确有停用源可枚举（实得 ${disabledIds.length}）`);
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
   * 但未经工厂验过）
   * 断言适配（fix3311/registry-cleanup）：样本原用真站壳页夹具、
   * 随 B2 模板簇退役同删，改内联同形态壳页（仅导航锚点），断言不变。 */
  setFetchPage(async () => `<!DOCTYPE html><html><head><title>SPA</title></head><body>
<a class="nav-item" href="/">home</a><div id="app"></div><script src="/assets/index.js"></script></body></html>`);
  const chigua = createAdapter(def("51chigua"));
  assert.ok(chigua, "51吃瓜有适配器");
  await assert.rejects(() => chigua!.list(1, 20), SourceParseEmptyError, "chigua 列表解析为空经工厂抛 SourceParseEmptyError");
  /* C2 零锚点空白页（hls-site 肉视频 def） */
  setFetchPage(async () => "<html><body><p>nothing</p></body></html>");
  const rou = createAdapter(def("rouvideo"));
  await assert.rejects(() => rou!.list(1, 20), SourceParseEmptyError, "零锚点页抛 SourceParseEmptyError、不返回空列表");
  /* C3/C4（原 SWAG 全过滤／RedGifs 空结果两路）随模板簇退役同删
   * （fix3311/registry-cleanup）：两路守的是已删模板自身的过滤
   * 语义，无活承接面。 */
}

/* ── (E) 扇出交叉（裁定变更适配，用户 2026-11-19 20:48）：扇出门
 * 已由 F5 三段齐全门放宽为搜索段结构门——保留源具备搜索段一律进
 * 扇出（probe/blocked 成熟度不再在搜索入口扣留，可播性后移详情/
 * 起播解析）；无搜索段的源仍出局。
 * 3.3.0 接通批集成续适配（2026-11-19）：吃瓜线 51chigua/meiridasai 接线
 * 搜索段、图片线 pixibb/nudecosplay 启用且搜索属实、pornpics 搜索属实
 * 改 false 出局、新适配器线 hanime1/iwara/hentaihaven 带 search 段启用
 * ——纳入集 7→13 源；feedheiliao 经实证无 GET 搜索段，维持出局。
 * 断言适配（fix338/registry-cut）：danbooru/hentaihaven/konachan 三源
 * 已摘除，纳入集 14→11 源，逐源断言同步收口。 ── */
{
  {
    const p = searchPolicyFor(def("feedheiliao"));
    assert.equal(p.include, false, "吃瓜源 feedheiliao 无搜索段、不进扇出（结构门）");  }
  for (const id of ["51chigua", "meiridasai"]) {
    const p = searchPolicyFor(def(id));
    assert.equal(p.include, true, `吃瓜源 ${id} 搜索段已接线（3.3.0）、进扇出`);
  }
  for (const id of ["hanime-tv", "xiuren"]) {
    const p = searchPolicyFor(def(id));
    assert.equal(p.include, true, `保留源 ${id} 具备搜索段即进扇出（成熟度 ${def(id).maturity} 不再预扣）`);
  }
  /* 断言适配（fix330 图片线，2026-11-19）：pornpics 模板搜索实证不可
   * 用、capabilities.search 属实改 false → 无搜索段出局；pixibb/
   * nudecosplay 实证启用且搜索属实 true → 新进扇出。纳入集 7→8 源，
   * 结构门口径不变（与 fix321-f5 契约同口径）。 */
  assert.equal(searchPolicyFor(def("pornpics")).include, false, "pornpics 搜索属实 false、无搜索段出局（fix330；fix335/g-sources 后 def 走历史夹具表）");
  /* 断言适配（fix335/g-sources）：yandere 启用且搜索属实进扇出——该
   * 断言已随 fix339/registry-cut-2 源摘除退役。 */
  /* 断言适配（fix338/realphoto-add）：everia 启用且搜索属实进扇出，
   * 纳入集 14→15 源；xsnvshen 搜索未验 caps.search=false 维持出局。 */
  assert.equal(searchPolicyFor(def("everia")).include, true, "everia 搜索属实、进扇出（fix338/realphoto-add）");
  assert.equal(searchPolicyFor(def("xsnvshen")).include, false, "xsnvshen 搜索未验、无搜索段出局（fix338/realphoto-add）");
  /* 断言适配（fix3310/video-add-2）：hanime1/iwara 恢复带 search 段
   * 进扇出、hentaiplay 搜索实证新进、hentaigasm 搜索未验出局。
   * 断言适配（fix3311/registry-cleanup）：hanime1 试装判删回、其
   * 扇出断言随源退役；iwara 保留。 */
  /* 断言适配（fix3315）：iwara/hentaigasm 保持删除、其 def 断言退役；
   * hentaiplay 恢复、进扇出断言保留。 */
  assert.equal(searchPolicyFor(def("hentaiplay")).include, true, "hentaiplay 搜索属实、进扇出（fix3310/fix3315）");
  const included = reg.filter((s) => searchPolicyFor(s).include).map((s) => s.id).sort();
  assert.deepEqual(included, ["51chigua", "cosplaytele", "everia", "hanime-tv", "hentaiplay", "huangguo", "meiridasai", "nudecosplay", "pixibb", "xiuren"],
    "扇出纳入集＝保留集内具备搜索段的 10 源（20:48 裁定口径＋3.3.0 集成；fix338 集成后 12、fix339 摘 009/010/014 后 9、fix3310 恢复＋新进后 12、fix3311 摘 009 后 11、fix3315 摘 iwara 后 10）");
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
