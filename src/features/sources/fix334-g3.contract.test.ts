/**
 * 结构批 L2／G3 契约（Muse 2026-11-20 fix334/l2-g3；本线任务书即
 * 维护者对新增测试的授权，AGENTS 不变量 11）。运行：
 * node src/features/sources/fix334-g3.contract.test.ts
 *
 * 背景（结构审计 G3）：全仓只有 source-012 的 detail 产多集
 * episodes、resolve 已支持按集取流，但详情消费者为 0——
 * SourceBrowse.openItem 只调 resolve(item.externalId)（012 无后缀
 * 默认第一集）、Search 副本加载同理，用户打开多集条目只能播
 * 第一集。本线补消费者：episodes.ts 纯函数归一＋EpisodePicker
 * 轻量选集＋SourceBrowse/Search 两条路径接线＋copyLoader 按集
 * resolve。适配器与取流零改动。
 *
 * 旧红形态（基线 fix334/l1-surfaces @2f4e457）：episodes.ts 与
 * EpisodePicker.tsx 不存在、copyLoader 无按集参数、两宿主无选集
 * 接线——本文件在基线因模块缺失无法运行（即红）。
 *
 * caps 裁定（本线核对消费面后的结论，报告 §差异）：012 注册表
 * capabilities.episodes **维持 false**——该字段是短剧频道
 * （ai-duanju）的品类映射门（registry.sourcesForChannel 只认
 * 它），翻 true 会让 012（里番分集、非短剧品类）进短剧频道切源
 * 名单、且与 surfaces 声明 e（no-drama-mapping）冲突；集数产出
 * 事实以 templateCapabilities 的 multi 为唯一出处、选集面只读
 * 模板事实不读 caps。§6 把这条分层钉死防再漂移。
 *
 * 不访问真实网络：fetchPage 经接缝注入既有 hentaihaven 夹具；
 * 集页夹具按 episode-2 改写流地址（形态不变），使「按集取流拿
 * 到的是所选集的流」可断言而非只看请求 URL。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry, sourcesForChannel } from "./registry.ts";
import { createHentaihavenAdapter } from "./adapters/templates.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { templateCapabilitiesFor } from "./adapters/templateCapabilities.ts";
import { episodeChoices, episodeOrdinal, episodeChoicesForSurface } from "./episodes.ts";
import { loadSearchCopy } from "../search/copyLoader.ts";
import type { CopyRef } from "../search/multiSourceSearch.ts";
import type { SourceDef, SourceDetail } from "./types.ts";

const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");
const def = (id: string): SourceDef => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};
const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* ── 夹具接缝：记录请求 URL；集页按集号改写流地址 ── */
const fetched: string[] = [];
setFetchPage(async (url) => {
  fetched.push(url);
  if (url.includes("/api/manga/")) return fx("hentaihaven-list.json");
  if (url.includes("/episode-2")) return fx("hentaihaven-episode.html").replaceAll("hh-fixture-001", "hh-fixture-002");
  if (url.includes("/episode-")) return fx("hentaihaven-episode.html");
  if (url.includes("/watch/")) return fx("hentaihaven-watch.html");
  throw new Error(`unexpected fetch ${url}`);
});

const hhDef = def("hentaihaven");
const hhAdapter = createHentaihavenAdapter(hhDef);
const hhDetail = await hhAdapter.detail("fixture-slug-001");

/* ══ §1 episodeChoices／episodeOrdinal 纯函数 ══ */
{
  const choices = episodeChoices(hhDetail);
  assert.equal(choices.length, 2, "012 真站形态 detail 归一出 2 集");
  assert.deepEqual(choices[0], { key: "fixture-slug-001/episode-1", label: "第 1 集", externalId: "fixture-slug-001/episode-1" });
  assert.deepEqual(choices[1], { key: "fixture-slug-001/episode-2", label: "第 2 集", externalId: "fixture-slug-001/episode-2" });
  assert.equal(episodeOrdinal(hhDetail, "fixture-slug-001/episode-1"), 1, "序位 1 起");
  assert.equal(episodeOrdinal(hhDetail, "fixture-slug-001/episode-2"), 2);
  assert.equal(episodeOrdinal(hhDetail, "fixture-slug-001/episode-99"), 0, "不在列表回 0（未知，不冒充第一集）");

  const dup: SourceDetail = {
    ...hhDetail,
    episodes: [
      { label: "第 1 集", externalId: "s/episode-1" },
      { label: "重复", externalId: "s/episode-1" },
      { label: "第 2 集", externalId: "s/episode-2" },
      { label: "空 id", externalId: "" },
    ],
  };
  assert.deepEqual(episodeChoices(dup).map((c) => c.externalId), ["s/episode-1", "s/episode-2"], "按 externalId 去重、空 id 丢弃、原序保留");
  assert.deepEqual(episodeChoices({ ...hhDetail, episodes: [] }), [], "无集数回空");
}

/* ══ §2 选集面适用性经 surfaces 派生消费（单一出处） ══ */
{
  assert.equal(episodeChoicesForSurface("play-external", hhDef, hhDetail).length, 2, "012×play-external（SourceBrowse 宿主）出选集");
  assert.equal(episodeChoicesForSurface("search-external-detail", hhDef, hhDetail).length, 2, "012×search-external-detail（Search 宿主）出选集");

  /* 停用态：active 表里 012 未启用 → 路由落 notice → 无选集。 */
  const activeOff = getBuiltinRegistry().map((d) => (d.id === "hentaihaven" ? { ...d, enabled: false } : d));
  assert.deepEqual(
    episodeChoicesForSurface("play-external", hhDef, hhDetail, { active: activeOff, builtin: getBuiltinRegistry() }),
    [], "012 停用时路由非 browse、不出选集");

  /* 单集模板：detail 只有「正片」一条且模板事实 single → 不出
   * 选集（单集条目行为与现状一致：无选集区）。 */
  const singleDetail: SourceDetail = {
    ...hhDetail, sourceId: "hanime-tv", externalId: "x",
    episodes: [{ label: "正片", externalId: "x" }],
  };
  assert.deepEqual(episodeChoicesForSurface("play-external", def("hanime-tv"), singleDetail), [], "single 模板不出选集");
  assert.deepEqual(episodeChoicesForSurface("search-external-detail", def("hanime-tv"), singleDetail), [], "single 模板搜索面同样不出选集");

  assert.deepEqual(episodeChoicesForSurface("play-external", undefined, hhDetail), [], "无 def 回空");
  assert.deepEqual(episodeChoicesForSurface("play-external", hhDef, undefined), [], "无 detail 回空");
}

/* ══ §3 resolve 按集取流：externalId 传递钉死 ══ */
{
  fetched.length = 0;
  const picked = await hhAdapter.resolve("fixture-slug-001/episode-2");
  assert.ok(
    fetched.some((u) => u === "https://hentaihaven.xxx/watch/fixture-slug-001/episode-2/"),
    "选第 2 集 → resolve 收到带集后缀的 externalId 并取第 2 集页");
  assert.equal(picked.streams[0]?.url, "https://cdn.example.com/hh-fixture-002.m3u8", "拿到的是第 2 集的流（非第一集回落）");

  fetched.length = 0;
  const dflt = await hhAdapter.resolve("fixture-slug-001");
  assert.equal(dflt.streams[0]?.url, "https://cdn.example.com/hh-fixture-001.m3u8", "无后缀默认第一集（既有行为不变）");
}

/* ══ §4 Search 路径：copyLoader 按集 resolve ══ */
{
  const copy: CopyRef = {
    sourceId: "hentaihaven", sourceName: "HentaiHaven", weight: 40, hot: 0, seq: 0,
    item: { sourceId: "hentaihaven", externalId: "fixture-slug-001", title: "fixture", cover: "", href: "https://hentaihaven.xxx/watch/fixture-slug-001/", tags: [] },
  };
  const deps = {
    getDef: (id: string) => getBuiltinRegistry().find((s) => s.id === id),
    makeAdapter: (d: SourceDef) => createHentaihavenAdapter(d),
    detailCache: new Map<string, SourceDetail>(),
  };
  const ep2 = await loadSearchCopy("video", copy, deps, { episodeExternalId: "fixture-slug-001/episode-2" });
  assert.equal(ep2.streamUrl, "https://cdn.example.com/hh-fixture-002.m3u8", "搜索路径按集取到第 2 集流");
  assert.equal(ep2.detail?.episodes.length, 2, "搜索路径 detail 带 2 集（选集数据在）");
  const dflt = await loadSearchCopy("video", copy, deps);
  assert.equal(dflt.streamUrl, "https://cdn.example.com/hh-fixture-001.m3u8", "不带集参数仍默认第一集（既有行为不变）");
}

/* ══ §5 两条路径接线文本断言 ══ */
{
  const browse = src("./SourceBrowse.tsx");
  assert.ok(browse.includes("episodeChoicesForSurface"), "SourceBrowse 消费选集派生");
  assert.ok(browse.includes("\"play-external\""), "SourceBrowse 宿主面＝play-external");
  /* 渲染形断言（fix334 清扫已坏-3 补强）：只查符号子串时改名/
   * 摘除 JSX 渲染仍全绿——须断言 JSX 实际渲染形在场。 */
  assert.ok(browse.includes("<EpisodePicker "), "SourceBrowse 实际渲染 EpisodePicker（JSX 形）");
  assert.ok(browse.includes("adapter.detail(item.externalId)"), "SourceBrowse openItem 并发取 detail（选集数据来源）");
  assert.ok(browse.includes("currentEpExternalId"), "SourceBrowse 持有当前集状态");
  assert.ok(browse.includes("scopeKey={`${def.id}:${detail.currentEpExternalId}`}"), "Player scopeKey 随当前集变更（防串集缓存）");
  assert.ok(browse.includes("adapter.resolve(choice.externalId)"), "SourceBrowse 切集以所选 externalId 重新 resolve");

  const search = src("../search/Search.tsx");
  assert.ok(search.includes("episodeChoicesForSurface"), "Search 消费选集派生");
  assert.ok(search.includes("\"search-external-detail\""), "Search 宿主面＝search-external-detail");
  assert.ok(search.includes("<EpisodePicker "), "Search 详情层实际渲染 EpisodePicker（JSX 形，清扫已坏-3 补强）");
  assert.ok(search.includes("switchEpisode"), "Search 有切集动作");
  /* 副本切换不带选集状态（fix334 清扫已坏-1）：switchCopy 构造新
   * 副本 data 时须显式剔除上一副本的 epExternalId/epError（ExtReady
   * 类型注释口径：不带此字段、回落默认集）。断言作用域限于
   * switchCopy 函数体——同文件 switchEpisode 本就有 epError:
   * undefined，全文子串断言抓不住本处缺失。 */
  const switchCopyBody = search.slice(search.indexOf("const switchCopy"), search.indexOf("const openMerged"));
  assert.ok(switchCopyBody.includes("epExternalId: undefined"), "switchCopy 剔除上一副本 epExternalId（回落默认集）");
  assert.ok(switchCopyBody.includes("epError: undefined"), "switchCopy 剔除上一副本 epError（不在新副本残留）");

  const loader = src("../search/copyLoader.ts");
  assert.ok(loader.includes("episodeExternalId"), "copyLoader 有按集参数");
  assert.ok(loader.includes("opts?.episodeExternalId ?? copy.item.externalId"), "copyLoader resolve 目标＝所选集 externalId（缺省条目 id）");

  const picker = src("./EpisodePicker.tsx");
  assert.ok(picker.includes("grid-cols-5"), "EpisodePicker 网格每行 5（照 Panels 规格）");
  assert.ok(picker.includes("h-11"), "EpisodePicker 热区 44px");
  assert.ok(picker.includes("registerOverlayBack"), "EpisodePicker 展开期间登记返回消费（防手势落穿）");
}

/* ══ §6 caps 分层裁定钉死（见文件头） ══ */
{
  assert.equal(hhDef.capabilities.episodes, false, "012 caps.episodes 维持 false（短剧频道映射门，非集数产出事实）");
  assert.equal(templateCapabilitiesFor(hhDef).episodes, "multi", "集数产出事实唯一出处＝模板能力表 multi");
  const drama = sourcesForChannel("ai-duanju", getBuiltinRegistry()).map((d) => d.id);
  assert.deepEqual(drama, [], "短剧频道外部映射仍属实为空（原生由调用方拼首位、不经此函数；012 不因多集进短剧名单）");
}

console.log("fix334-g3 contract: all assertions passed");
