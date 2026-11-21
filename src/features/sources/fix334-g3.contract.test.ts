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
 * caps 裁定（本线核对消费面后的结论，报告 §差异）：hentaihaven 注册表
 * capabilities.episodes **维持 false**——该字段是短剧频道
 * （ai-duanju）的品类映射门（registry.sourcesForChannel 只认
 * 它），翻 true 会让多集里番源（里番分集、非短剧品类）进短剧频道切源
 * 名单、且与 surfaces 声明 e（no-drama-mapping）冲突；集数产出
 * 事实以 templateCapabilities 的 multi 为唯一出处、选集面只读
 * 模板事实不读 caps。§6 把这条分层钉死防再漂移。
 *
 * 不访问真实网络：fetchPage 经接缝注入既有 hentaihaven 夹具；
 * 集页夹具按 episode-2 改写流地址（形态不变），使「按集取流拿
 * 到的是所选集的流」可断言而非只看请求 URL。
 *
 * 断言适配（fix338/registry-cut，2026-11-20）：012 源与
 * hentaihaven-api 模板已同批摘除/删码，本契约所钉的选集
 * machinery（episodes.ts 纯函数、copyLoader 按集分发、两宿主接
 * 线）仍在仓——适配如下：§1 改以同形态合成 detail 直驱纯函数；
 * §2 改钉新现状（现行注册表无 multi 登记、任一在册源配多集
 * detail 也不出选集，machinery 休眠待新 multi 模板）；§3（已删
 * 适配器的按集 resolve 本体）退役，其「按集拿到所选集的流」覆
 * 盖由 §4 copyLoader 合成适配器接棒；§4 适配器改注入合成实现
 * （detail/resolve 形态与原夹具等值）；§5 接线文本断言不变；
 * §6 改钉「全注册表无 multi 登记∧短剧频道映射仍空」。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry, sourcesForChannel } from "./registry.ts";
import { templateCapabilitiesFor } from "./adapters/templateCapabilities.ts";
import { episodeChoices, episodeOrdinal, episodeChoicesForSurface } from "./episodes.ts";
import { loadSearchCopy } from "../search/copyLoader.ts";
import type { CopyRef } from "../search/multiSourceSearch.ts";
import type { SourceDef, SourceDetail } from "./types.ts";

const def = (id: string): SourceDef => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};
const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* ── 合成多集形态（fix338 适配）：与原 hentaihaven 夹具 detail
 * 等值（2 集、集 externalId 形态 <slug>/episode-<n>、流按集号区
 * 分），直驱纯函数与 copyLoader 注入面。 ── */
const hhDetail: SourceDetail = {
  sourceId: "multi-synthetic", externalId: "fixture-slug-001",
  title: "夹具条目一", cover: "", href: "https://example.com/watch/fixture-slug-001/", tags: [],
  images: [],
  episodes: [
    { label: "第 1 集", externalId: "fixture-slug-001/episode-1" },
    { label: "第 2 集", externalId: "fixture-slug-001/episode-2" },
  ],
};
const synthDef: SourceDef = {
  id: "multi-synthetic", displayName: "多集合成源", kind: "video", category: "video",
  adapter: { template: "hls-site", params: {} }, baseUrls: ["https://example.com"],
  enabled: true, order: 999, maturity: "probe",
  capabilities: { search: true, episodes: false, hevc: false },
  network: { mode: "probe-required" }, note: "选集 machinery 契约合成 def（fix338）",
};
const synthAdapter = {
  sourceId: "multi-synthetic",
  async list() { return { items: [], pagination: { page: 1, size: 20, hasMore: false } }; },
  async detail() { return hhDetail; },
  async resolve(id: string) {
    return { streams: [{ url: `https://cdn.example.com/hh-fixture-00${id.endsWith("episode-2") ? "2" : "1"}.m3u8`, kind: "hls" as const }] };
  },
};

/* ══ §1 episodeChoices／episodeOrdinal 纯函数 ══ */
{
  const choices = episodeChoices(hhDetail);
  assert.equal(choices.length, 2, "多集形态 detail 归一出 2 集");
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
  /* fix338 后现状：模板能力表无 multi 登记——任一在册源即使配多
   * 集 detail 也不出选集（machinery 休眠）；新 multi 模板在此表
   * 登记后本段须同步改回出选集断言。 */
  for (const d of getBuiltinRegistry()) {
    assert.deepEqual(episodeChoicesForSurface("play-external", d, hhDetail), [], `${d.id}×play-external 无 multi 登记、不出选集`);
    assert.deepEqual(episodeChoicesForSurface("search-external-detail", d, hhDetail), [], `${d.id}×search-external-detail 无 multi 登记、不出选集`);
  }

  /* 单集模板：detail 只有「正片」一条且模板事实 single → 不出
   * 选集（单集条目行为与现状一致：无选集区）。 */
  const singleDetail: SourceDetail = {
    ...hhDetail, sourceId: "51chigua", externalId: "x",
    episodes: [{ label: "正片", externalId: "x" }],
  };
  /* 断言适配（fix3314）：single 模板样本原用 hanime-tv（hanime-api），
   * 该模板已随视频板块删除退役，样本改存活 single 模板源 51chigua
   * （chigua），覆盖不变。 */
  assert.deepEqual(episodeChoicesForSurface("play-external", def("51chigua"), singleDetail), [], "single 模板不出选集");
  assert.deepEqual(episodeChoicesForSurface("search-external-detail", def("51chigua"), singleDetail), [], "single 模板搜索面同样不出选集");

  assert.deepEqual(episodeChoicesForSurface("play-external", undefined, hhDetail), [], "无 def 回空");
  assert.deepEqual(episodeChoicesForSurface("play-external", def("51chigua"), undefined), [], "无 detail 回空");
}


/* ══ §4 Search 路径：copyLoader 按集 resolve ══ */
{
  const copy: CopyRef = {
    sourceId: "multi-synthetic", sourceName: "多集合成源", weight: 40, hot: 0, seq: 0,
    item: { sourceId: "multi-synthetic", externalId: "fixture-slug-001", title: "fixture", cover: "", href: "https://example.com/watch/fixture-slug-001/", tags: [] },
  };
  const deps = {
    getDef: (id: string) => (id === "multi-synthetic" ? synthDef : getBuiltinRegistry().find((s) => s.id === id)),
    makeAdapter: (d: SourceDef) => (d.id === "multi-synthetic" ? synthAdapter : null),
    detailCache: new Map<string, SourceDetail>(),
  };
  const ep2 = await loadSearchCopy("video", copy, deps as never, { episodeExternalId: "fixture-slug-001/episode-2" });
  assert.equal(ep2.streamUrl, "https://cdn.example.com/hh-fixture-002.m3u8", "搜索路径按集取到第 2 集流");
  assert.equal(ep2.detail?.episodes.length, 2, "搜索路径 detail 带 2 集（选集数据在）");
  const dflt = await loadSearchCopy("video", copy, deps as never);
  assert.equal(dflt.streamUrl, "https://cdn.example.com/hh-fixture-001.m3u8", "不带集参数仍默认第一集（既有行为不变）");
}

/* ══ §5 路径接线文本断言 ══ */
{
  /* 断言适配（fix3314）：原 SourceBrowse 宿主已随视频板块删除退
   * 场，选集派生的生产宿主只剩 Search 外部详情一处——其接线断言
   * 保留在下，强度不变。 */
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

/* ══ §6 caps 分层与 multi 登记现状钉死（见文件头） ══ */
{
  /* 集数产出事实唯一出处＝模板能力表：现行全注册表无 multi 登记
   * （唯一 multi 模板已随 012 摘除删码）；任一源 caps.episodes
   * 与模板事实分层不变（caps 是短剧频道映射门、选集面不读 caps）。 */
  for (const d of getBuiltinRegistry()) {
    assert.notEqual(templateCapabilitiesFor(d).episodes, "multi", `${d.id} 模板事实非 multi（现行无 multi 登记）`);
  }
  const drama = sourcesForChannel("ai-duanju", getBuiltinRegistry()).map((d) => d.id);
  assert.deepEqual(drama, [], "短剧频道外部映射仍属实为空（原生由调用方拼首位、不经此函数）");
}

console.log("fix334-g3 contract: all assertions passed");
