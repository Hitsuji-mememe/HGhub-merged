/**
 * 最终版 D3 线契约测试（Muse 2026-11-19，(1)用户亲点：全局搜索多源
 * 扇出；任务 brief 与后续用户拍板＋GPT 设计审查裁定明确要求正向
 * 测试，故新增本文件——AGENTS 新增测试须经同意口径以 brief 的
 * 明确要求为据）。
 * 运行：node src/features/search/final-d3.contract.test.ts
 * 注：扇出纳入断言已按 3.2.1 F5 三段齐全门适配（契约变更适配、
 * 权重断言不削弱；全量名单断言在 fix321-f5.contract.test.ts）。
 * 覆盖：四页签封顶、内容性质归类、权重分层口径（总表＋每日大赛
 * 改判）、扇出聚合混排＋源名标注、单源失败/超时静默隔离、每源
 * 上限、首屏贡献上限、跨源合并置信门（多信号、宁漏勿误）＋保
 * 留全部副本、默认副本选择链（可用性→结构完整度→历史可靠性→
 * 分层 tiebreak）、身份未确认禁止自动切副本、真实模板 search
 * 数据流、Search.tsx 生产接线文本断言。不访问真实网络。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "../sources/registry.ts";
import type { SourceAdapter, SourceDef, SourceDetail, SourceItem } from "../sources/types.ts";
import { setFetchPage } from "../sources/adapters/fetchPage.ts";
import { createHlsSiteAdapter, createWpRestAdapter } from "../sources/adapters/templates.ts";
import {
GLOBAL_SEARCH_TABS, aggregateHits, applySourceContributionCap, areTitlesDuplicate,
fanoutSearch, kindForHuangguoVideo, kindForSourceDef, loadWithFallback, mergeConfidence,
mergeHits, normalizeTitle, orderCopiesForDisplay, rankMerged, searchPolicyFor,
selectDefaultCopy, structuralCompletenessOf,
type CopyAssessment, type CopyRef, type FanoutHit,
} from "./multiSourceSearch.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const fx = (name: string) => readFileSync(new URL(`../sources/adapters/fixtures/${name}`, import.meta.url), "utf8");
/* 断言适配（fix3314）：视频侧样本源 hanime-tv 已随视频板块整组摘
 * 除，其 hanime-api 模板同删——本文件的扇出/归类断言需要「已启用
 * video 品类∧具备搜索段」的源形态，注册表已无此形态，改由夹具
 * def 承接（功能字段与删除前注册表条目一致、模板改挂存活且具搜
 * 索段的 chigua 仅作搜索段事实载体——扇出门与归类只读品类/能力
 * 字段与模板搜索段存在性，不读模板身份）。 */
const FIXTURE_DEFS: Record<string, SourceDef> = {
  "hanime-tv": {
    id: "hanime-tv", displayName: "Hanime.tv", kind: "video", category: "video",
    adapter: { template: "chigua", params: {} },
    baseUrls: ["https://hanime.tv"], enabled: true, order: 24, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false },
    network: { mode: "probe-required" }, note: "历史注册表条目（fix3314 夹具）",
  } as SourceDef,
};
const def = (id: string): SourceDef => {
  const d = getBuiltinRegistry().find((s) => s.id === id) ?? FIXTURE_DEFS[id];
  assert.ok(d, `registry has ${id}`);
  return d;
};
const item = (sourceId: string, externalId: string, title: string, hot?: number, cover?: string): SourceItem => ({
  sourceId, externalId, title, cover: cover ?? `https://img.example.com/${externalId}.jpg`, href: "", tags: [], hot,
});
const hit = (sourceId: string, sourceName: string, kind: FanoutHit["kind"], title: string, weight: number, hot = 0, seq = 0, cover?: string, publishedAt?: number): FanoutHit => ({
  sourceId, sourceName, kind, item: item(sourceId, `${sourceId}-${seq}`, title, hot || undefined, cover), weight, hot, seq, publishedAt,
});
const SHARED_COVER = "https://cdn.example.com/gua/shared-123.jpg";

/* ── 四页签封顶：种类恒为四类，与注册表源数无关、永不按源分段 ── */
{
  assert.deepEqual(GLOBAL_SEARCH_TABS.map((t) => t.kind), ["video", "drama", "post", "image"], "页签 kind 恒四类");
  assert.deepEqual(GLOBAL_SEARCH_TABS.map((t) => t.label), ["视频", "短剧", "帖子", "图片"], "页签标签恒四类");
  /* 断言适配（fix330/ui-fixes，2026-11-19）：用户裁定 Rule34Video 摘除
   * 注册表（18→17 源），本文件原以其为「中性权重已启用视频源」样本的
   * 断言改由 iwara 接替（同为总表未覆盖、已启用、具备搜索段的 video
   * 源，覆盖口径不变）；源数断言随之 18→17。 */
  /* 断言适配（fix338 集成对账，2026-11-20）：registry-cut 摘
   * 008/011/016、realphoto-add 加 everia/xsnvshen，注册表 17→16 源；
   * 页签封顶四类的口径不变。 */
  /* 断言适配（fix339/registry-cut-2，2026-11-21）：摘 hanime1/iwara/
   * yandere，注册表 16→13 源；中性权重样本改由 everia 接替（同为
   * 总表未覆盖、已启用、具备搜索段，覆盖口径不变）；页签封顶四
   * 类的口径不变。 */
  /* 断言适配（fix3310/video-add-2，2026-11-21）：恢复 hanime1/iwara
   * ＋新增 hentaigasm/hentaiplay，注册表 13→17 源；页签封顶四类
   * 的口径不变。 */
  /* 断言适配（fix3311/registry-cleanup，2026-11-21）：009 试装判删
   * 回，注册表 17→16 源；页签封顶四类的口径不变。 */
  /* 断言适配（fix3314，2026-11-21）：视频四源整组摘除，注册表
   * 16→12 源；页签封顶四类的口径不变。 */
  assert.equal(getBuiltinRegistry().length, 12, "注册表 12 源（fix3314：摘视频四源）下页签仍封顶四类（上一断言即证据）");
  const groups = aggregateHits([]);
  assert.deepEqual(Object.keys(groups).sort(), ["drama", "image", "post", "video"], "聚合分组恒四键");
}

/* ── 归类：按内容性质、不按媒体格式（每条只归一个主类） ── */
{
  assert.equal(kindForHuangguoVideo({ total_episodes: 80, episode_count: 80 }), "drama", "分集视频→短剧");
  assert.equal(kindForHuangguoVideo({ total_episodes: 1, episode_count: 1 }), "video", "单条视频→视频");
  assert.equal(kindForSourceDef(def("feedheiliao")), "post", "文字主体→帖子（带视频也归帖子：post 类不因内容带视频改类）");
  assert.equal(kindForSourceDef(def("cosplaytele")), "image", "图集→图片");
  assert.equal(kindForSourceDef(def("gelbooru")), "image", "图片主体→图片（适配 fix338：原例 konachan 已摘除、改挂同族 yandere；适配 fix339：yandere 已摘除、改挂同族 gelbooru）");
  /* 断言适配（3.2.2 瘦身）：专用短剧源已全删，短剧只来自黄果分集结构判定（上两断言）与 fix322 标记线；源级 video 判定由保留源承接。 */
  assert.equal(kindForSourceDef(def("hanime-tv")), "video", "独立单条视频源→视频");
  assert.equal(kindForSourceDef(def("51chigua")), "post", "吃瓜图文→帖子");
}

/* ── 权重分层口径（分层总表＋每日大赛 2026-11-19 改判；纳入与否
 * 按 2026-11-19 20:48 裁定的搜索段结构门：权重照落表、无搜索段
 * 不进扇出、具备搜索段不因成熟度被扣，见 fix321-f5.contract
 * .test.ts 的全量扇出名单断言。断言适配（3.2.2 瘦身＋裁定变更）：
 * 被删源的权重断言随源退场，保留源按新门改判纳入值。 ── */
{
  const p = (id: string) => searchPolicyFor(def(id));
  /* 断言适配（3.3.0 接通批·吃瓜线，2026-11-19）：51chigua/meiridasai
   * 已按真站形态接线搜索段（caps.search=true），纳入值 false→true；
   * 权重落表不变（100/50 与三层递减关系不动）；feedheiliao 经实证
   * 无 GET 搜索段，维持不纳入。 */
  assert.deepEqual([p("51chigua").include, p("51chigua").weight], [true, 100], "51吃瓜主力：权重最高落表，搜索段已接线纳入（3.3.0）");
  assert.deepEqual([p("feedheiliao").include, p("feedheiliao").weight], [false, 60], "黑料网补充：权重仍落表，无搜索段不纳入");
  assert.deepEqual([p("meiridasai").include, p("meiridasai").weight], [true, 50], "每日大赛：权重在黑料网之下落表，搜索段已接线纳入（3.3.0）");
  assert.ok(p("51chigua").weight > p("feedheiliao").weight && p("feedheiliao").weight > p("meiridasai").weight, "吃瓜三层权重严格递减");
  /* 断言适配（fix335/g-sources，2026-11-20）：PornPics 已退役摘除、
   * 其 PRIMARY 权重条目随源删除（权重表只含在册源）；yandere
   * moebooru 校准有搜索段、中性权重纳入。
   * 适配（fix338/registry-cut）：konachan/danbooru 已摘除，两行随
   * 源退役（中性权重纳入由 yandere 与下方 iwara 通则行承接）。
   * 适配（fix339/registry-cut-2）：yandere/iwara/hanime1 三行随源
   * 退役，中性权重纳入通则改由 everia 承接（总表未覆盖、已启用、
   * 具备搜索段，口径不变）。 */
  assert.deepEqual([p("everia").include, p("everia").weight], [true, 40], "总表未覆盖的已启用源：中性 40 纳入（everia 承接通则）");
  assert.deepEqual([p("xiuren").include, p("xiuren").weight], [true, 40], "秀人网：中性权重，具备搜索段纳入（旧 OFF 表已退役）");
  assert.deepEqual([p("cosplaytele").include, p("cosplaytele").weight], [true, 40], "CosplayTele 维持现状：中性纳入");
}

/* ── 扇出聚合：多源夹具结果都在、按种类分键、源名标注、混排 ── */
{
  const stub = (items: SourceItem[]): SourceAdapter => ({
    sourceId: "stub",
    list: async () => ({ items, pagination: { page: 1, pages: 1, size: 20, total: items.length } }),
    detail: async () => { throw new Error("unused"); },
    resolve: async () => ({ streams: [] }),
    search: async () => ({ items, pagination: { page: 1, pages: 1, size: 20, total: items.length } }),
  });
  /* 帖子侧样本源原用黑料网（feedheiliao）；F5 三段门后该源已出局，
   * 换三段齐全的帖子侧源黄果承接同一覆盖（适配理由同上段）。 */
  /* 断言适配（fix339/registry-cut-2）：视频侧样本源 iwara 已摘除，
   * 改由保留视频源 hanime-tv 承接（同为已启用 video 源、口径不变）。
   * 断言适配（fix3314）：hanime-tv 亦已摘除，改由本文件夹具 def
   * 承接同一形态（见文件头 def 定义处），口径不变。 */
  const defs = [def("hanime-tv"), def("cosplaytele"), def("huangguo")];
  const adapters = new Map<string, SourceAdapter>([
    ["hanime-tv", stub([item("hanime-tv", "v1", "扇出视频一", 5), item("hanime-tv", "v2", "扇出视频二", 9)])],
    ["cosplaytele", stub([item("cosplaytele", "g1", "扇出图集一", 3)])],
    ["huangguo", stub([item("huangguo", "p1", "扇出帖子一", 7)])],
  ]);
  const out = await fanoutSearch("扇出", defs, (d) => adapters.get(d.id) ?? null);
  assert.deepEqual(out.failures, [], "全成功无失败记录");
  assert.deepEqual(out.searched.sort(), ["cosplaytele", "hanime-tv", "huangguo"], "三源都真被搜");
  const groups = aggregateHits(out.hits);
  assert.equal(groups.video.length, 2, "视频组 2 条");
  assert.equal(groups.image.length, 1, "图片组 1 条");
  assert.equal(groups.post.length, 1, "帖子组 1 条");
  assert.equal(groups.video[0].item.title, "扇出视频二", "同类混排按相关性（热度）：hot 9 在前");
  assert.equal(groups.video[0].sourceName, "Hanime.tv", "源名标注正确（video）");
  assert.equal(groups.image[0].sourceName, "CosplayTele", "源名标注正确（image）");
  assert.equal(groups.post[0].sourceName, "黄果", "源名标注正确（post）");
}

/* ── 单源失败静默隔离＋单源超时不阻塞＋每源上限 ── */
{
  const good: SourceAdapter = {
    sourceId: "hanime-tv",
    list: async () => ({ items: [], pagination: { page: 1, pages: 1, size: 20, total: 0 } }),
    detail: async () => { throw new Error("unused"); },
    resolve: async () => ({ streams: [] }),
    search: async () => ({ items: [item("hanime-tv", "ok1", "幸存结果", 1)], pagination: { page: 1, pages: 1, size: 20, total: 1 } }),
  };
  /* 断言适配（fix339/registry-cut-2）：失败/超时/批量样本源 iwara 已
   * 摘除，改由保留源 cosplaytele 承接同一隔离覆盖（口径不变）。 */
  const bad: SourceAdapter = {
    ...good, sourceId: "cosplaytele",
    search: async () => { throw new Error("fixture boom"); },
  };
  const traced: string[] = [];
  const out = await fanoutSearch("隔离", [def("cosplaytele"), def("hanime-tv")],
    (d) => (d.id === "cosplaytele" ? bad : good),
    { onFailure: (sourceId) => { traced.push(sourceId); } });
  assert.equal(out.hits.length, 1, "失败源不阻塞：幸存源结果在");
  assert.equal(out.hits[0].item.title, "幸存结果");
  assert.deepEqual(out.failures.map((f) => f.sourceId), ["cosplaytele"], "失败留痕（源 id＋信息）");
  assert.deepEqual(traced, ["cosplaytele"], "失败回调被调用（生产接 tracePlayback 留痕）");

  const slow: SourceAdapter = {
    ...good, sourceId: "cosplaytele",
    search: async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { items: [item("cosplaytele", "slow1", "慢源结果", 1)], pagination: { page: 1, pages: 1, size: 20, total: 1 } };
    },
  };
  const timed = await fanoutSearch("超时", [def("cosplaytele"), def("hanime-tv")],
    (d) => (d.id === "cosplaytele" ? slow : good), { timeoutMs: 10 });
  assert.equal(timed.hits.length, 1, "单源超时不阻塞：快源结果在");
  assert.equal(timed.hits[0].sourceId, "hanime-tv");
  assert.deepEqual(timed.failures.map((f) => f.sourceId), ["cosplaytele"], "超时源按失败留痕");
  assert.ok(timed.failures[0].message.includes("超时"), "失败信息标明超时");

  const many: SourceAdapter = {
    ...good, sourceId: "cosplaytele",
    search: async () => ({
      items: Array.from({ length: 25 }, (_, i) => item("cosplaytele", `m${i}`, `批量结果${i}`)),
      pagination: { page: 1, pages: 2, size: 25, total: 25 },
    }),
  };
  const capped = await fanoutSearch("上限", [def("cosplaytele")], () => many, { perSourceLimit: 5 });
  assert.equal(capped.hits.length, 5, "每源结果上限生效（25→5）");
}

/* ── 首屏贡献上限：单一源不淹没首屏 ── */
{
  const hits: FanoutHit[] = [];
  /* 样本源为构造标签（本段只验上限机制、与具体源无关；原甲源标签
   * iwara 已随 fix339 摘除退役，改用中性标签 src-a/src-b）。 */
  for (let i = 0; i < 10; i++) hits.push(hit("src-a", "甲源", "video", `甲源视频${i}`, 40, 100 - i, i));
  for (let i = 0; i < 10; i++) hits.push(hit("src-b", "乙源", "video", `乙源视频${i}`, 40, 50 - i, 100 + i));
  const capped = applySourceContributionCap(rankMerged(mergeHits(hits)), 12, 6);
  assert.equal(capped.length, 20, "条目不丢、只顺延");
  const firstScreen = capped.slice(0, 12);
  assert.ok(firstScreen.filter((m) => m.sourceId === "src-a").length <= 6, "首屏内甲源至多 6 条");
  assert.equal(firstScreen.filter((m) => m.sourceId === "src-b").length, 6, "乙源填入首屏空出的 6 位（低热度不被单一源淹没）");
}

/* ── 标题归一化与相似判据 ── */
{
  assert.equal(normalizeTitle("独家！某网红 翻车［现场］"), normalizeTitle("独家 某网红翻车现场"), "标点/空白差异归一后相等");
  assert.equal(areTitlesDuplicate("超长标题的完整版视频回放", "超长标题的完整版"), true, "包含关系（短方≥8）判同条");
  assert.equal(areTitlesDuplicate("完全不同的两个标题内容", "另一条毫不相干的视频"), false, "不相干标题不误判");
  assert.equal(areTitlesDuplicate("短题甲", "短题乙"), false, "短标题不靠模糊判据误杀");
}

/* ── 跨源合并置信门：高置信合并保留全部副本；低置信不合并（宁漏勿误） ── */
{
  const t0 = Date.parse("2026-11-18T10:00:00Z");
  const hits: FanoutHit[] = [
    hit("feedheiliao", "黑料网", "post", "独家 某网红翻车现场", 60, 10, 0, SHARED_COVER, t0),
    hit("51chigua", "51吃瓜网", "post", "独家！某网红翻车现场", 100, 2, 1, SHARED_COVER, t0 + 3600_000),
    hit("meiridasai", "每日大赛", "post", "独家：某网红翻车现场！", 50, 1, 2, SHARED_COVER, t0 + 7200_000),
    hit("51chigua", "51吃瓜网", "post", "另一条独立帖子", 100, 3, 3),
    hit("src-v", "视频样本源", "video", "独家！某网红翻车现场", 40, 99, 4),
  ];
  assert.ok(mergeConfidence(hits[1], hits[0]) >= 4, "同题＋同封面＋时间近：置信达身份确认门");
  const merged = mergeHits(hits);
  const posts = merged.filter((m) => m.kind === "post");
  assert.equal(posts.length, 2, "帖子同题三源合并为一条＋独立一条");
  const cluster = posts.find((m) => m.copies.length === 3)!;
  assert.ok(cluster, "合并条目存在且副本数=3（索引层合并、不删副本）");
  assert.deepEqual(cluster.copies.map((c) => c.sourceId), ["51chigua", "feedheiliao", "meiridasai"], "副本按优先级序保留全量");
  assert.deepEqual(cluster.alsoOn, ["黑料网", "每日大赛"], "alsoOn 记其余来源名（供「多源都有」呈现）");
  assert.equal(cluster.title, "独家！某网红翻车现场", "展示标题取最高优先级副本");
  assert.equal(cluster.identityConfirmed, true, "高置信合并：身份已确认（可自动切副本）");
  assert.equal(merged.filter((m) => m.kind === "video").length, 1, "跨 kind 同名不互吞：视频条独立");

  /* 低置信：同题但封面完全不同 → 置信 3−2=1 ＜门 → 不合并、留重复 */
  const lowConf: FanoutHit[] = [
    hit("51chigua", "51吃瓜网", "post", "同题不同内容判例", 100, 5, 0, "https://a.example.com/x/aaa-111.jpg"),
    hit("feedheiliao", "黑料网", "post", "同题不同内容判例", 60, 4, 1, "https://b.example.com/y/zzz-999.jpg"),
  ];
  assert.ok(mergeConfidence(lowConf[0], lowConf[1]) < 3, "同题异封面置信低于合并门");
  assert.equal(mergeHits(lowConf).length, 2, "低置信不合并：两条独立保留");

  /* 中置信：标题相似（包含）＋同封面 → 置信 3 达合并门但未达确认门 */
  const midConf: FanoutHit[] = [
    hit("51chigua", "51吃瓜网", "post", "某事件完整版后续报道来了", 100, 5, 0, SHARED_COVER),
    hit("feedheiliao", "黑料网", "post", "某事件完整版后续", 60, 4, 1, SHARED_COVER),
  ];
  const midMerged = mergeHits(midConf);
  assert.equal(midMerged.length, 1, "中置信（相似题＋同封面）合并为一条");
  assert.equal(midMerged[0].identityConfirmed, false, "中置信合并：身份未确认（禁止自动切副本）");
  assert.equal(midMerged[0].copies.length, 2, "未确认条目副本仍全量保留（手动可切）");
}

/* ── 默认副本选择链：可用性→结构完整度→历史可靠性→分层 tiebreak ── */
{
  const detail = (over: Partial<SourceDetail>): SourceDetail => ({
    sourceId: "x", externalId: "e", title: "t", cover: "", href: "", tags: [], images: [], episodes: [], ...over,
  });
  assert.equal(structuralCompletenessOf(detail({ episodes: [{ label: "正片", externalId: "e" }] })).hasVideo, true, "结构完整度：episodes 非空=带视频（结构信号、非质量判优）");
  const copies: CopyRef[] = [
    { sourceId: "a", sourceName: "源A", weight: 100, hot: 5, seq: 0, item: item("a", "a1", "同题") },
    { sourceId: "b", sourceName: "源B", weight: 40, hot: 5, seq: 1, item: item("b", "b1", "同题") },
  ];
  const assess = (over: Partial<CopyAssessment>): CopyAssessment => ({ available: true, structural: null, reliability: null, ...over });
  const rich = structuralCompletenessOf(detail({ episodes: [{ label: "正片", externalId: "e" }], images: ["1", "2", "3"], description: "正文很长的描述文本" }));
  const poor = structuralCompletenessOf(detail({ images: [] }));

  const m1 = new Map<string, CopyAssessment>([["a", assess({ structural: rich })], ["b", assess({ structural: rich })]]);
  assert.equal(selectDefaultCopy(copies, m1)?.sourceId, "a", "全同分时分层权重决胜（tiebreak 在最后）");
  const m2 = new Map<string, CopyAssessment>([["a", assess({ structural: poor })], ["b", assess({ structural: rich })]]);
  assert.equal(selectDefaultCopy(copies, m2)?.sourceId, "b", "结构完整度优先于分层：低权重但结构更全者胜");
  const m3 = new Map<string, CopyAssessment>([["a", assess({ available: false, structural: rich })], ["b", assess({ structural: poor })]]);
  assert.equal(selectDefaultCopy(copies, m3)?.sourceId, "b", "可用性优先于结构完整度：实测失败者出局");
  const m4 = new Map<string, CopyAssessment>([["a", assess({ structural: rich, reliability: 0.2 })], ["b", assess({ structural: rich, reliability: 0.9 })]]);
  assert.equal(selectDefaultCopy(copies, m4)?.sourceId, "b", "历史可靠性优先于分层：成功率高者胜");
  const ordered = orderCopiesForDisplay(copies, m2);
  assert.equal(ordered[0].sourceId, "b", "展示序首位=选择链定出的默认副本");
  const mAllFail = new Map<string, CopyAssessment>([["a", assess({ available: false })], ["b", assess({ available: false })]]);
  assert.equal(selectDefaultCopy(copies, mAllFail), null, "全部副本实测失败→无默认副本");
}

/* ── 副本顺延：已确认可自动切；身份未确认禁止自动切 ── */
{
  const copies: CopyRef[] = [
    { sourceId: "51chigua", sourceName: "51吃瓜网", weight: 100, hot: 0, seq: 0, item: item("51chigua", "x", "同题") },
    { sourceId: "feedheiliao", sourceName: "黑料网", weight: 60, hot: 0, seq: 1, item: item("feedheiliao", "x", "同题") },
  ];
  const failed: string[] = [];
  const got = await loadWithFallback(copies, async (c) => {
    if (c.sourceId === "51chigua") throw new Error("fixture primary down");
    return `stream-from-${c.sourceId}`;
  }, (c) => { failed.push(c.sourceId); });
  assert.ok(got, "主副本失败仍有结果（不中断）");
  assert.equal(got!.copy.sourceId, "feedheiliao", "自动落到下一副本");
  assert.equal(got!.value, "stream-from-feedheiliao");
  assert.deepEqual(failed, ["51chigua"], "失败副本留痕、顺延发生");
  const none = await loadWithFallback(copies, async () => { throw new Error("all down"); });
  assert.equal(none, null, "全部副本失败才返回 null（调用方此时才呈现错误态）");

  let calls = 0;
  const gated = await loadWithFallback(copies, async (c) => {
    calls++;
    if (c.sourceId === "51chigua") throw new Error("fixture primary down");
    return "should-not-be-reached";
  }, { allowAutoSwitch: false });
  assert.equal(gated, null, "身份未确认：默认副本失败不自动切、返回 null 交用户手动选");
  assert.equal(calls, 1, "身份未确认：只试了首个副本（第二副本未被自动尝试）");
}

/* ── 真实模板 search 数据流（夹具）：hls-site 与 wp-rest 的 search 非占位 ── */
{
  setFetchPage(async () => fx("hls-list.html"));
  /* 断言适配（Muse 2026-11-19 fix321-F2）：肉视频参数已按真站校准
   * 为 /v/<id>，通用骨架 search 数据流改用参数同形态的 FC2 def。
   * 再适配（fix321-F2b）：FC2 已按真站销量榜校准，通用骨架 search
   * 数据流再移交参数同形态的目录源 hentaihaven def，断言内容不变。
   * 再适配（fix330 接通批）：hentaihaven 已改专用模板，通用骨架
   * search 数据流改用与原目录条目功能字段逐字一致的合成 def
   * （id 仍 hentaihaven），断言内容不变。 */
  const a = createHlsSiteAdapter({
    id: "hentaihaven", displayName: "HentaiHaven", kind: "video", category: "video",
    adapter: { template: "hls-site", params: { listPath: "/?page={page}", itemLinkPattern: "/video/", detailPath: "/video/{id}" } },
    baseUrls: ["https://hentaihaven.xxx/"], enabled: false, order: 105, maturity: "probe",
    capabilities: { search: false, episodes: false, hevc: false },
    network: { mode: "probe-required" }, note: "历史目录条目参数（fix330 适配合成 def）",
  } as unknown as SourceDef);
  assert.ok(a.search, "hls-site 适配器有 search");
  const r = await a.search!("夹具", 1, 20);
  assert.equal(r.items.length, 2, "hls search 解析出夹具条目");
  assert.equal(r.items[0].sourceId, "hentaihaven", "search 条目带源 id");
}
{
  setFetchPage(async () => fx("wp-rest-list.json"));
  const a = createWpRestAdapter(def("cosplaytele"));
  const r = await a.search!("夹具", 1, 20);
  assert.equal(r.items.length, 2, "wp-rest search 解析出夹具条目");
}

/* ── 生产接线（文本断言，与 wiring-manifest fin-d3-* 互证） ── */
{
  const search = read("./Search.tsx");
  assert.ok(search.includes("fanoutSearch"), "Search 生产调用 fanoutSearch");
  assert.ok(search.includes("createAdapter"), "Search 生产调用 createAdapter（适配器工厂）");
  assert.ok(search.includes("getActiveRegistry"), "Search 读 active 注册表");
  assert.ok(search.includes("GLOBAL_SEARCH_TABS"), "Search 页签走四类常量");
  assert.ok(search.includes("aggregateHits"), "Search 经 aggregateHits 聚合");
  assert.ok(search.includes("loadWithFallback"), "Search 详情走副本顺延");
  assert.ok(search.includes("allowAutoSwitch: merged.identityConfirmed"), "自动切副本受身份确认门约束");
  assert.ok(search.includes("structuralCompletenessOf"), "Search 实测结构完整度（选择链）");
  assert.ok(search.includes("fetchHealthSnapshot"), "Search 历史可靠性取取页健康快照");
  assert.ok(search.includes("onPartial"), "Search 渐进呈现（先到先显）");
  assert.ok(search.includes("多源都有"), "Search 呈现「多源都有」标注");
  assert.ok(search.includes('tracePlayback("search.source_fail"'), "单源失败经 tracePlayback 留痕");
  assert.ok(search.includes('tracePlayback("search.copy_fail"'), "副本失败经 tracePlayback 留痕");
}

console.log("final-d3.contract: all assertions passed");
