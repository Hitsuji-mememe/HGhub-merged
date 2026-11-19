/**
 * 3.2.1 验收 A（VA）F1 证伪测试（Muse 2026-11-19，验收规矩第 6 条：
 * 验收对象是用户可见不变量；本文件由验收员独立编写、只加测试）。
 * 运行：node src/features/search/fix321-va-f1.accept.test.ts
 *
 * 不变量：「同一条目在任何搜索路径下只出一张卡（跨批到达、跨端点
 * 重复扇出都不例外）。」
 *
 * 与既有 fix321-f1 契约的差距（审计结论）：既有契约的 FanoutHit 是
 * 手捏的——两份命中除 seq 外字段全同，连 publishedAt 都同缺。但生产
 * 两路的真实形态并不全同：原生帖子路（Search.tsx groups useMemo）
 * 给 FanoutHit 带 publishedAt（由 Post.publish_time 解析），扇出路
 * （fanoutSearch）从不设 publishedAt；且两路 item 的构造代码不同源
 * （原生路在 Search.tsx 内联构造、扇出路经 nativeHuangguo.toItem）。
 * 手捏 fixture 与被测聚合代码共用「两份命中应当长得一样」的假设，
 * 绿了也不能证伪「真实两路形态不同仍只出一张卡」。
 *
 * 本测试的数据构造走生产路径的真实形态：
 * - 起点是 api.searchPosts 的返回形态：一份 Paged<Post> 载荷，条目
 *   为用户实报帖子（搜「3p」出两张卡者）。Post 的 id/封面 URL 无实报
 *   原文在案，id 与封面为合成值（证据等级注记见档案 F1.md）；
 * - 原生路：逐行复刻 Search.tsx groups useMemo 中 hgPost 的
 *   FanoutHit 构造（sourceId/externalId/title/cover/href/tags/hot/
 *   weight/seq/publishedAt 字段与取值口径同生产代码）；
 * - 扇出路：不手捏——用真实 fanoutSearch（生产函数）＋真实注册表
 *   黄果 def 驱动，适配器 search 的返回 item 逐行复刻
 *   nativeHuangguo.toItem 的映射（该适配器模块 import 了 Tauri
 *   api 层、顶层读 navigator，node 环境无法直接 import，故以此
 *   最接近的真实接缝替代：fanoutSearch 的 kind/weight/seq 包裹、
 *   searchPolicyFor 的纳入判定均为生产代码原物）；
 * - 最终呈现：两路按 Search.tsx 的合并口径（ext seq +100000 偏移）
 *   汇合后过真实 aggregateHits，断言帖子页签只出一张卡、四页签
 *   合计也只有一张。
 */
import assert from "node:assert/strict";
import type { Post, Paged } from "../../shared/api/types.ts";
import { getBuiltinRegistry } from "../sources/registry.ts";
import type { SourceItem } from "../sources/types.ts";
import { aggregateHits, fanoutSearch, type FanoutHit } from "./multiSourceSearch.ts";

/* ── 起点载荷：api.searchPosts("3p") 的返回形态（Paged<Post>）。
 * 标题为用户实报原文（其帖同封面同标题出两张卡）；id/cover/hot/
 * 时间为合成值（实报未含这些字段），形态与 Post 类型逐字段对齐。 */
const REPORTED_POST: Post = {
  id: 987654,
  title: "原创博主 小女是超人 性爱新作 酒醉晚归被骚妻报复",
  cover: "https://img.example-cdn.com/post/987654/cover.jpg",
  tags: ["原创博主"],
  hot: 12345,
  publish_time: "2026-11-19T08:30:00+08:00",
  created_at: "2026-11-19T08:30:00+08:00",
};
const SEARCH_POSTS_PAGE: Paged<Post> & { keyword: string } = {
  items: [REPORTED_POST],
  pagination: { page: 1, pages: 1, size: 20, total: 1 },
  keyword: "3p",
};

/* ── 原生路：复刻 Search.tsx groups useMemo 对 hgPost 条目的
 * FanoutHit 构造（seq 为原生序、publishedAt 解析 publish_time）。 */
function nativePostHit(p: Post, seq: number): FanoutHit {
  const ts = p.publish_time ?? p.created_at;
  const t = ts ? Date.parse(ts) : NaN;
  return {
    sourceId: "huangguo", sourceName: "黄果", kind: "post",
    item: { sourceId: "huangguo", externalId: String(p.id), title: p.title, cover: p.cover, href: "", tags: p.tags ?? [], hot: p.hot },
    weight: 100, hot: p.hot ?? 0, seq, publishedAt: Number.isFinite(t) ? t : undefined,
  };
}

/* ── 扇出路适配器：search 返回 item 逐行复刻 nativeHuangguo.toItem
 * 对同一 Post 的映射（sourceId/externalId/title/cover/href/tags/hot）。 */
const nativeAdapterSearchItem = (p: Post): SourceItem => ({
  sourceId: "huangguo",
  externalId: String(p.id),
  title: p.title,
  cover: p.cover,
  href: "",
  tags: p.tags ?? [],
  hot: p.hot,
});

/* 扇出路经真实 fanoutSearch 生产函数产出命中（纳入判定、kind 归类、
 * weight、seq 包裹均为生产代码）。 */
const hgDef = getBuiltinRegistry().find((d) => d.id === "huangguo");
assert.ok(hgDef, "注册表含黄果 def");
const fanout = await fanoutSearch("3p", [hgDef], () => ({
  sourceId: "huangguo",
  list: async () => { throw new Error("unused"); },
  detail: async () => { throw new Error("unused"); },
  resolve: async () => ({ streams: [] }),
  search: async () => ({ items: SEARCH_POSTS_PAGE.items.map(nativeAdapterSearchItem), pagination: SEARCH_POSTS_PAGE.pagination }),
}));
assert.equal(fanout.hits.length, 1, "扇出路对同一帖子产出一份命中（前置事实）");
const fanoutHit = fanout.hits[0];
const nativeHit = nativePostHit(REPORTED_POST, 0);

/* 两路真实形态的差异必须如实存在（否则本测试退化为手捏同形态）：
 * item 身份字段全同，但原生路带 publishedAt、扇出路不带。 */
assert.deepEqual(fanoutHit.item, nativeHit.item, "两路 item 身份形态全同（同一条目）");
assert.equal(fanoutHit.kind, "post", "扇出路 kind 经 kindForSourceDef 归帖子");
assert.ok(nativeHit.publishedAt !== undefined && fanoutHit.publishedAt === undefined,
  "真实形态差异在场：原生路带 publishedAt、扇出路不带（手捏 fixture 掩盖的差异）");

/* ── 最终呈现：按 Search.tsx 合并口径（ext 命中 seq +100000）汇合
 * 两路后过 aggregateHits——用户实报场景的证伪断言。 */
{
  const extShifted = { ...fanoutHit, seq: 100_000 + fanoutHit.seq };
  const groups = aggregateHits([nativeHit, extShifted]);
  const total = groups.post.length + groups.video.length + groups.drama.length + groups.image.length;
  assert.equal(groups.post.length, 1, "同一帖子经原生路＋扇出路双路到达：帖子页签只出一张卡");
  assert.equal(total, 1, "四页签合计只出一张卡（不串页签、不留第二张）");
  assert.equal(groups.post[0].copies.length, 1, "同一条目不留假副本（copies 按同源同 ID 去重）");
  assert.equal(groups.post[0].identityConfirmed, true, "同源同 ID 合并身份自明（详情失败可自动顺延的前提不被去重打坏）");
  assert.equal(groups.post[0].title, REPORTED_POST.title, "卡面标题即实报帖子标题");
  assert.equal(groups.post[0].cover, REPORTED_POST.cover, "卡面封面即实报帖子封面");
}

/* ── 跨批到达：渐进呈现两阶段——先只到扇出命中（onPartial 快照），
 * 原生路后到后最终呈现重聚合，仍只出一张卡。 */
{
  const stage1 = aggregateHits([{ ...fanoutHit, seq: 100_000 + fanoutHit.seq }]);
  assert.equal(stage1.post.length, 1, "渐进第一阶段（仅扇出命中）：一张卡");
  const stage2 = aggregateHits([nativeHit, { ...fanoutHit, seq: 100_000 + fanoutHit.seq }]);
  assert.equal(stage2.post.length, 1, "渐进第二阶段（原生路后到汇合）：仍一张卡、跨批不漏合并");
}

/* ── 补充：同源同标题＋同封面、不同 ID（同内容被重复挂载为两个
 * 条目 id）——呈现层仍只出一张卡。
 * 断言适配（3.2.2 集成，2026-11-19）：原「两 ID 副本各留一份」口径
 * 已被用户真机裁定推翻（详情页同源双副本实报，fix322/play 问题 3：
 * 同源 content 重复并卡不留第二副本、alsoOn 不重名），本组改验新
 * 口径；同内容重复挂载的场景本身与「只出一张卡」断言不变。 */
{
  const remounted: FanoutHit = {
    ...nativeHit, seq: 1,
    item: { ...nativeHit.item, externalId: "987655" },
  };
  const groups = aggregateHits([nativeHit, remounted]);
  assert.equal(groups.post.length, 1, "同源同题同封面不同 ID：只出一张卡");
  assert.equal(groups.post[0].copies.length, 1, "同源同内容重复：并卡不留第二副本（用户真机裁定）");
}

console.log("fix321-va-f1.accept: all assertions passed");
