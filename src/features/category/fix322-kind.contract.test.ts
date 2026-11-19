/**
 * fix322 归类标记线契约测试（Muse 2026-11-19，维护者任务书授权新增：
 * 3.2.1 真机实锤——带「1 集」徽标的短剧条目仍出现在「视频」频道/分区）。
 *
 * 运行：node src/features/category/fix322-kind.contract.test.ts
 *
 * 用户可见不变量：
 * 1. 源头显式品类标记（Detail.tracking.drama_type_id，上游官方分类表
 *    /api/site/categories/video：24=短剧、25=漫剧 → 短剧；26=AI换脸、
 *    27=AI魔改 → 视频）只要可取得，归类以标记为准，集数结构不得推翻。
 * 2. 无标记时集数结构只在决定性方向兜底（>1 集 → 短剧）；单集（≤1）
 *    在结构上与普通视频同形、本身不构成任一侧证据，无标记可取得时
 *    归 unknown 暂不呈现，绝不默认落视频。
 * 3. 全部归类展示面（分类总览分区／视频频道 feed／全局搜索页签／
 *    站内搜索两面）同一口径、同一出处（shared/lib/contentKind）。
 *
 * 夹具形态（2026-11-19 本机直连上游实测，非构造臆测）：
 * - 列表/搜索载荷全字段审计（25 键）无任何品类标记字段——标记不在
 *   列表层；Detail 才有 tracking.drama_type_id（实测 17 条 Detail：
 *   集数 1..42 全部 24/25；video_type 恒 1，非品类标记）。
 * - 单集短剧锚点：《我的怪力母狗》id 13765（用户截图视频区「1 集
 *   ★9.1」同条）——列表形态 episode_count=1/total_episodes=0，
 *   Detail tracking.drama_type_id="24"（AI成人短剧）。
 * - 单集漫剧锚点：《蜜桃臀》id 13781——列表形态同上，Detail
 *   tracking.drama_type_id="25"（AI成人漫剧），且实测在 ai-manju
 *   分类列表内。
 * - 26/27 映射出自上游官方分类表；该两类分类列表当前返回 410
 *   下线、无在架条目可采样，故其 Detail 形态按同表构造（tracking
 *   结构与 24/25 实测形态一致、仅 id/name 不同），此点如实标注。
 * 不访问真实网络。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  explicitKindOf,
  filterSearchCardsByKind,
  kindForHuangguoVideo,
  kindSignalOfDetail,
  needsCanonicalKindLookup,
  partitionCardsByKind,
  partitionCardsByResolvedKind,
  resolveHuangguoKind,
  searchKindForHuangguoVideo,
  type EpisodeStructureSignal,
} from "../../shared/lib/contentKind.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* ── 真实形态夹具 ── */
/* 列表形态（/api/videos 与 /api/search 同形态子集）：无品类标记字段。 */
const cardSingleDrama = {
  id: 13765, title: "我的怪力母狗", score: 9.1, tags: ["都市", "后宫", "sm"],
  episode_count: 1, total_episodes: 0, is_original: 1, is_finished: false,
};
const cardSingleManju = {
  id: 13781, title: "蜜桃臀", score: 9.1, tags: ["都市", "ntr", "绿帽"],
  episode_count: 1, total_episodes: 0, is_original: 1, is_finished: false,
};
const cardSingleVideo = {
  id: 77001, title: "单条视频甲", score: 8.0, tags: [],
  episode_count: 1, total_episodes: 0, is_original: 1, is_finished: false,
};
const cardUnknownSingle = {
  id: 77002, title: "未定条目乙", score: 7.0, tags: [],
  episode_count: 1, total_episodes: 0, is_original: 1, is_finished: false,
};
const cardMultiDrama = {
  id: 9101, title: "警界之花", score: 9.0, tags: [],
  episode_count: 3, total_episodes: 3, is_original: 1, is_finished: false,
};
/* Detail 形态（规范记录）：集数信号＋tracking 品类标记齐全。 */
const detailSingleDrama = {
  id: 13765, episode_count: 1, total_episodes: 0,
  episodes: [{ ep_num: 1, title: "", duration: 512, status: 1 }],
  tracking: { drama_type_id: "24", drama_type_name: "AI成人短剧", drama_content_type: "short_drama" },
};
const detailSingleManju = {
  id: 13781, episode_count: 1, total_episodes: 0,
  episodes: [{ ep_num: 1, title: "", duration: 939, status: 1 }],
  tracking: { drama_type_id: "25", drama_type_name: "AI成人漫剧", drama_content_type: "short_drama" },
};
const detailSingleVideo26 = {
  id: 77001, episode_count: 1, total_episodes: 0,
  episodes: [{ ep_num: 1, title: "", duration: 300, status: 1 }],
  tracking: { drama_type_id: "26", drama_type_name: "AI换脸", drama_content_type: "short_drama" },
};
const detailSingleVideo27 = {
  id: 77001, episode_count: 1, total_episodes: 0,
  episodes: [{ ep_num: 1, title: "", duration: 300, status: 1 }],
  tracking: { drama_type_id: "27", drama_type_name: "AI魔改", drama_content_type: "short_drama" },
};
/* 无 tracking 的 Detail（标记缺席）：只有结构信号、且仅 1 集。 */
const detailNoTracking = { id: 77002, episode_count: 1, total_episodes: 0, episodes: [{ ep_num: 1, title: "", duration: 100, status: 1 }] };

/* ── 标记提取（规范信号构造点）：Detail 的 tracking 必须被提取，不许再丢 ── */
{
  const sig = kindSignalOfDetail(detailSingleDrama);
  assert.equal(sig.source_type_id, "24", "Detail.tracking.drama_type_id 被提取进规范信号");
  assert.equal(sig.episode_count, 1, "规范信号保留 episode_count");
  assert.equal(sig.episodes?.length, 1, "规范信号保留 episodes 数组");
  assert.equal(kindSignalOfDetail(detailNoTracking).source_type_id, undefined, "Detail 无 tracking → 标记缺席（不臆造）");
}

/* ── 显式标记判定：分类表 id → 性质 ── */
{
  assert.equal(explicitKindOf({ source_type_id: "24" }), "drama", "24 短剧 → drama");
  assert.equal(explicitKindOf({ source_type_id: 25 }), "drama", "25 漫剧 → drama");
  assert.equal(explicitKindOf({ source_type_id: "26" }), "video", "26 AI换脸 → video");
  assert.equal(explicitKindOf({ source_type_id: 27 }), "video", "27 AI魔改 → video");
  assert.equal(explicitKindOf({ source_type_id: "999" }), undefined, "未知 id → 无标记结论");
  assert.equal(explicitKindOf({}), undefined, "无字段 → 无标记结论");
  assert.equal(explicitKindOf({ episode_count: 5 }), undefined, "集数不是标记");
}

/* ── 统一裁决（标记优先、结构只在决定性方向兜底、无标记单集暂扣） ── */
{
  assert.equal(searchKindForHuangguoVideo, resolveHuangguoKind, "搜索判定与统一裁决同一函数引用（同源）");
  /* 核心场景：单集短剧/漫剧经规范记录标记 → 短剧，绝不进视频 */
  assert.equal(resolveHuangguoKind(cardSingleDrama, kindSignalOfDetail(detailSingleDrama)), "drama",
    "《我的怪力母狗》（1 集、标记 24）→ 短剧");
  assert.equal(resolveHuangguoKind(cardSingleManju, kindSignalOfDetail(detailSingleManju)), "drama",
    "《蜜桃臀》（1 集、标记 25）→ 短剧");
  /* 真单条：标记 26/27 → 视频，不误伤 */
  assert.equal(resolveHuangguoKind(cardSingleVideo, kindSignalOfDetail(detailSingleVideo26)), "video",
    "单条（1 集、标记 26）→ 视频");
  assert.equal(resolveHuangguoKind(cardSingleVideo, kindSignalOfDetail(detailSingleVideo27)), "video",
    "单条（1 集、标记 27）→ 视频");
  /* 无标记不默认落视频：补判缺席/Detail 无标记/结构仅 1 集 → unknown */
  assert.equal(resolveHuangguoKind(cardSingleDrama), "unknown", "单集无补判 → unknown（不默认落视频）");
  assert.equal(resolveHuangguoKind(cardSingleDrama, kindSignalOfDetail(detailNoTracking)), "unknown",
    "Detail 无标记且结构仅 1 集 → unknown（结构 ≤1 不构成视频证据）");
  assert.equal(resolveHuangguoKind(cardSingleDrama, null), "unknown", "补判失败（null）→ unknown");
  /* 结构决定性方向保留：多集无需标记即短剧 */
  assert.equal(resolveHuangguoKind(cardMultiDrama), "drama", "3 集无补判 → 短剧（结构决定性）");
  assert.equal(resolveHuangguoKind(cardMultiDrama, kindSignalOfDetail(detailSingleDrama)), "drama",
    "3 集＋任意规范记录 → 短剧");
  /* 标记优先于结构：多集条目若标记为视频品类 → 视频（口径断言） */
  assert.equal(resolveHuangguoKind(
    { ...cardMultiDrama, episode_count: 24, total_episodes: 24 },
    kindSignalOfDetail(detailSingleVideo26)), "video", "标记 26 推翻 24 集结构 → 视频（标记优先）");
  /* 搜索缺失形态（两计数恒 0）＋标记补判 → 短剧（F4b 场景在新口径下仍成立） */
  assert.equal(resolveHuangguoKind(
    { episode_count: 0, total_episodes: 0 },
    kindSignalOfDetail(detailSingleDrama)), "drama", "搜索 0 信号形态＋标记补判 → 短剧");
}

/* ── 浏览面分组（总览/频道 feed 共用）：三组齐全、unknown 不混入任一呈现组 ── */
{
  const canonicalFor = (c: { id: number }): EpisodeStructureSignal | undefined => ({
    13765: kindSignalOfDetail(detailSingleDrama),
    77001: kindSignalOfDetail(detailSingleVideo26),
  } as Record<number, EpisodeStructureSignal>)[c.id];
  const groups = partitionCardsByResolvedKind(
    [cardMultiDrama, cardSingleDrama, cardSingleVideo, cardUnknownSingle], canonicalFor);
  assert.deepEqual(groups.drama.map((c) => c.id), [9101, 13765], "短剧组：多集剧＋单集短剧（标记）");
  assert.deepEqual(groups.video.map((c) => c.id), [77001], "视频组：只有标记为视频品类的单条");
  assert.deepEqual(groups.unknown.map((c) => c.id), [77002], "未定组：无标记单集暂扣、不进呈现组");
  assert.ok(!groups.video.some((c) => c.id === 13765), "《我的怪力母狗》绝不出现在视频组");
}

/* ── 站内搜索性质门：同一裁决两面互斥 ── */
{
  const canonicalFor = (c: { id: number }): EpisodeStructureSignal | undefined => ({
    13765: kindSignalOfDetail(detailSingleDrama),
    77001: kindSignalOfDetail(detailSingleVideo26),
  } as Record<number, EpisodeStructureSignal>)[c.id];
  const cards = [cardSingleDrama, cardSingleVideo, cardUnknownSingle];
  assert.deepEqual(filterSearchCardsByKind(cards, "drama", canonicalFor).map((c) => c.id), [13765],
    "短剧面：只留单集短剧（标记 24）");
  assert.deepEqual(filterSearchCardsByKind(cards, "video", canonicalFor).map((c) => c.id), [77001],
    "视频面：只留单条视频（标记 26）、单集短剧不漏入");
}

/* ── 补判触发门：只有未决定者才查 Detail（多集已定不查、带标记不查） ── */
{
  assert.equal(needsCanonicalKindLookup(cardSingleDrama), true, "单集无标记 → 需补判");
  assert.equal(needsCanonicalKindLookup(cardMultiDrama), false, "3 集结构已定 → 不查");
  assert.equal(needsCanonicalKindLookup({ ...cardSingleDrama, source_type_id: "24" }), false, "自带标记 → 不查");
  assert.equal(needsCanonicalKindLookup({ episode_count: 0, total_episodes: 0 }), true, "无信号 → 需补判（F4b 既有场景）");
}

/* ── 卡-only 结构原语义保留（兜底原语，不再作归类面最终裁决） ── */
{
  assert.equal(kindForHuangguoVideo(cardMultiDrama), "drama", "卡-only：3 集 → 短剧");
  assert.equal(kindForHuangguoVideo(cardSingleDrama), "video", "卡-only：1 集 → 视频（结构兜底原语义、仅此层）");
  assert.deepEqual(partitionCardsByKind([cardMultiDrama]).drama.map((c) => c.id), [9101], "卡-only 分组原语义不变");
}

/* ── 生产接线（文本断言） ── */
{
  const category = read("../category/Category.tsx");
  assert.ok(category.includes("partitionCardsByResolvedKind"), "Category 归类面走统一裁决分组");
  assert.ok(category.includes("kindSignalOfDetail"), "Category 补判经共用提取点构造规范信号");
  assert.ok(category.includes("needsCanonicalKindLookup"), "Category 补判触发走共用门");
  const search = read("../search/Search.tsx");
  assert.ok(search.includes("kindSignalOfDetail(d)"), "Search 补判经共用提取点（标记不丢）");
  assert.ok(search.includes("needsCanonicalKindLookup"), "Search 补判触发走共用门（单集也查标记）");
  const hook = read("../search/useSearchResults.ts");
  assert.ok(hook.includes("kindSignalOfDetail(d)"), "useSearchResults 补判经共用提取点（标记不丢）");
  assert.ok(hook.includes("needsCanonicalKindLookup"), "useSearchResults 补判触发走共用门（单集也查标记）");
  const types = read("../../shared/api/types.ts");
  assert.ok(types.includes("drama_type_id"), "Detail 类型声明 tracking.drama_type_id（契约同步）");
  const multi = read("../search/multiSourceSearch.ts");
  assert.ok(multi.includes("resolveHuangguoKind"), "multiSourceSearch re-export 统一裁决（同源）");
}

console.log("fix322-kind.contract: all assertions passed");
