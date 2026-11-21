/**
 * 3.2.1 验收 C 线证伪测试（F4＋F4b 合并验收，维护者任务书授权新增；
 * 验收规矩第 6 条：对象是用户可见不变量，不是机制存在性）。
 *
 * 不变量：「任一条目按内容性质只进一个分区/页签，与它从哪条路径
 * （频道端点／通用搜索端点／频道列表）来无关；有分集/剧集结构的
 * 只归短剧，绝不进视频。」
 *
 * 运行：node src/features/search/fix321-accept-f4.contract.test.ts
 *
 * 与既有 fix321-f4/f4b 契约的区别（防同假设）：本测试不孤立断言判定
 * 函数，而是复刻三条生产派生链（分类总览分区合并／频道页 incoming
 * 过滤／全局搜索 groups 归类），且每条复刻都以生产源码文本断言绑死
 * （派生表达式必须在 Category.tsx / Search.tsx 中字面存在，复刻与
 * 生产漂移即红）。同一测试文件在旧基线 a3b122f 上按旧生产派生
 * （浏览面无判定直渲染／搜索拿缺失信号直接判定）分支运行，浏览面
 * 与搜索面各至少一红（行为红，非仅模块缺失）；在新码上全绿。
 *
 * 夹具形态：完整 VideoCard 形态（字段以 shared/api/types.ts 为准，
 * 非既有契约的残缺对象）。锚点： 《警界之花》3 集／9.0 分（用户
 * 实报＋F4 线截图）、《巨乳姐姐》《大小姐的日常》标题（搜「御姐」
 * 截图，见 f4b root-cause）；两短剧的集数具体值（24/18）为构造值，
 * 只取 >1 语义；条目 id 为构造值（真实 id 无记录）。频道形态带
 * episode_count/total_episodes 且 is_original=1（original 端点本身
 * 即 /api/videos?is_original=1，见 Rust api_original_videos）；
 * 搜索形态两集数字段恒 0 与字段缺失两变体（f4b 根因：上游搜索
 * 响应不下发剧集信号）；规范记录为 Detail 形态（episodes 数组
 * ＋两计数，Search.tsx 补判实际存入的子集）。
 * 不访问真实网络。
 *
 * fix322 适配注记（契约变化、非削弱）：3.2.1 真机实锤单集短剧仍
 * 漏进视频面——裁决升级为标记优先（Detail.tracking.drama_type_id，
 * 上游分类表 24/25=短剧、26/27=视频），浏览面（总览/频道 feed）
 * 一并接入补判。本文件三条生产派生复刻随之改绑新派生（总览/
 * 频道＝partitionCardsByResolvedKind＋canonicalFor 注入、搜索＝
 * kindSignalOfDetail 提取），规范记录夹具升级为 fix322 实测
 * Detail 形态（＋tracking 标记：多集=24、真单条=26）；不变量与
 * 各面期望归属不变，另在既有对照场景内补「补判未到→暂扣」相位
 * 断言（生产两相行为），覆盖不减。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

let failures = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}: ${(e as Error).message}`); }
};

/* 生产模块动态装载：旧基线无 shared/lib/contentKind、无
 * searchKindForHuangguoVideo 导出——装载结果本身即新旧分界，
 * 下方各面按「生产源码实际形态」分支到对应派生。 */
const multi = await import("./multiSourceSearch.ts");
const aggregateHits = multi.aggregateHits as typeof import("./multiSourceSearch.ts").aggregateHits;
const kindOld = multi.kindForHuangguoVideo as (c: never) => string;
const searchKind = (multi as Record<string, unknown>).searchKindForHuangguoVideo as
  | ((card: never, canonical?: never) => string)
  | undefined;
let partitionCardsByKind: ((cards: readonly never[]) => Record<string, never[]>) | undefined;
let partitionCardsByResolvedKind: ((
  cards: readonly never[],
  canonicalFor: (card: never) => unknown,
) => Record<string, never[]>) | undefined;
try {
  const ck = await import("../../shared/lib/contentKind.ts");
  partitionCardsByKind = (ck as Record<string, unknown>).partitionCardsByKind as typeof partitionCardsByKind;
  partitionCardsByResolvedKind = (ck as Record<string, unknown>).partitionCardsByResolvedKind as typeof partitionCardsByResolvedKind;
} catch { partitionCardsByKind = undefined; partitionCardsByResolvedKind = undefined; }

const categorySrc = read("../category/Category.tsx");
const searchSrc = read("./Search.tsx");

/* ── 完整 VideoCard 形态夹具 ── */
type Card = {
  id: number; title: string; cover: string; tags: string[]; score: number;
  episode_count: number; total_episodes: number; hot: number;
  like_count: number; collect_count: number; comment_count: number;
  is_finished: boolean; is_original: number; created_at: string;
};
const card = (p: Partial<Card> & { id: number; title: string }): Card => ({
  cover: `https://img.example.com/${p.id}.jpg`, tags: [], score: 0,
  episode_count: 0, total_episodes: 0, hot: 100, like_count: 0,
  collect_count: 0, comment_count: 0, is_finished: false, is_original: 1,
  created_at: "2026-11-01T00:00:00Z", ...p,
});
/* 场景①《警界之花》：频道形态（original 与 ai-duanju 两端点都返回它） */
const jingjieChannel = card({ id: 9101, title: "警界之花", score: 9.0, episode_count: 3, total_episodes: 3 });
/* 场景②「御姐」批 AI 短剧：频道形态／搜索形态（恒 0）／搜索形态（缺失） */
const juruChannel = card({ id: 9102, title: "巨乳姐姐", episode_count: 24, total_episodes: 24 });
const juruSearchZero = card({ id: 9102, title: "巨乳姐姐", episode_count: 0, total_episodes: 0 });
const daxiaojieChannel = card({ id: 9103, title: "大小姐的日常", episode_count: 18, total_episodes: 18 });
const daxiaojieSearchMissing = { id: 9103, title: "大小姐的日常" } as unknown as Card;
/* 真单条对照：频道形态 1 集；搜索形态信号缺失、规范记录 1 集 */
const singleChannel = card({ id: 9104, title: "单条视频甲", episode_count: 1, total_episodes: 1 });
const singleSearchZero = card({ id: 9104, title: "单条视频甲", episode_count: 0, total_episodes: 0 });
/* 无分集对照（浏览面 0 集＝真无分集） */
const noEpChannel = card({ id: 9105, title: "无分集视频乙", episode_count: 0, total_episodes: 0 });

/* Detail 规范记录（fix322 实测形态：两计数＋episodes 数组＋
 * tracking 品类标记；多集剧标记 24 短剧、真单条标记 26 视频类） */
const detailOf = (n: number) => ({
  total_episodes: n, episode_count: n,
  episodes: Array.from({ length: n }, (_, i) => ({ ep_num: i + 1, title: `第${i + 1}集`, duration: 60, status: 1 })),
  source_type_id: n > 1 ? "24" : "26",
});
const canonicalById: Record<number, ReturnType<typeof detailOf>> = {
  9101: detailOf(3), 9102: detailOf(24), 9103: detailOf(18), 9104: detailOf(1),
  /* 无分集条目（卡面两计数 0）的 Detail 实有 1 个 episode 且带标记
   * （实测锚点：列表 total_episodes=0 的条目 Detail episodes 长 1） */
  9105: detailOf(1),
};

/* ══ 面 1：分类总览（Category.tsx 总览段） ══
 * 断言适配（fix335/e-category 总览索引化，设计 design-category-hub
 * 方案②）：总览预览整面退场——总览不再渲染任何内容条目，只剩
 * 索引行（频道行→ChannelPage、吃瓜行→PostsPage、源行→深链页）。
 * 本不变量（一条目只进一个分区）在总览面由构造满足：渲染条目
 * 数恒 0，任何条目都不可能在总览重复或错区出现。原面 1 的分组
 * 复刻（总览派生）随面退场删除；分组行为的活面＝搜索（面 3），
 * 其行为检查在本文件内原样保留、覆盖不减（面 2 的原生频道列
 * 表亦已于 fix336 退场，见面 2 段适配注记）。
 * 下方检查改钉新生产绑定：总览段无分组派生、无卡片渲染、频道
 * 入口只剩索引行 push。 */
const overviewSeg = categorySrc.split("频道详情页")[0];
check("面1-生产绑定：总览索引化与 Category.tsx 字面对齐", () => {
  assert.ok(!overviewSeg.includes("originalKindGroups"), "总览无预览分组派生（索引化退场）");
  assert.ok(!overviewSeg.includes("RowCard") && !overviewSeg.includes("MediaCard"), "总览不渲染任何内容卡片（预览归内页）");
  assert.ok(overviewSeg.includes('push({ kind: "channel", cate: c.cate, name: c.name })'), "频道行点按进 ChannelPage（归类在内页发生）");
  assert.ok(overviewSeg.includes('push({ kind: "posts" })'), "吃瓜行点按进 PostsPage");
});
check("面1-场景①：《警界之花》在总览不出现（构造性满足只进一区）", () => {
  /* 总览渲染条目恒为空集：9101 在总览的出现次数为 0 ≤ 1，且不
   * 可能同时进两区——不变量由构造满足；其归类正确性由面 2
   * （频道页 incoming 过滤）行为检查守护。 */
  assert.ok(!overviewSeg.includes("loadPreview"), "总览无预览取数链（条目无从进入总览）");
});

/* ══ 面 2：频道页列表（Category.tsx ChannelPage） ══
 * fix336/ui-fixes 适配（契约变化、非削弱）：原生视频空壳 chip
 * 退场后，cate=original 不再有原生列表——频道内容改由外部源
 * SourceBrowse 承载（各源自有列表、不经原生 feed 混合分页，
 * 无从套用本面的 incoming 复刻）。
 * fix3314 再适配（契约变化、非削弱）：视频板块整组删除后
 * SourceBrowse 与外部源分支同删，cate=original 落下线提示分支、
 * 不取数。本面自此钉两件事：①生产绑
 * 定改钉退场事实＋视频频道落下线提示分支（旧码上必红）；
 * ②行为复刻改钉「原生呈现集恒空」——任何原生条目都不可能以
 * 原生列表形态出现在视频频道（原检查的防错目标＝多集条目混
 * 进视频频道，在新形态下由构造满足且更强）。短剧频道（面 2
 * 第三检）与搜索（面 3）的行为检查原样保留。
 * 历史形态（fix322→fix330）：original 曾先对未决条目批量补判、
 * incoming 经统一裁决只入 video 组、耗尽落「暂无已确认条目」
 * 诚实终态——该整链已随空壳退场删除（见 Category.tsx 落账）。 */
const channelIncoming = (cate: string, raw: Card[]): Card[] => {
  if (cate === "original") return [];
  return raw;
};
check("面2-生产绑定：原生视频列表退场与 Category.tsx 字面对齐（fix336）", () => {
  assert.ok(!categorySrc.includes("partitionCardsByResolvedKind(rawItems"), "原生视频分组调用已退场");
  assert.ok(!categorySrc.includes("暂无已确认条目"), "确认门诚实终态已随空壳退场");
  assert.ok(!categorySrc.includes("api.originalVideos"), "原生视频取数臂已退场");
  assert.ok(categorySrc.includes('cate === "original" || cate.startsWith("video:")'), "视频频道与视频深链落下线提示分支（fix3314）");
  assert.ok(!categorySrc.includes("<SourceBrowse"), "外部视频浏览组件已随视频板块删除退场（fix3314）");
  assert.ok(!categorySrc.includes("sources/SourceBrowse"), "Category 不再导入 SourceBrowse（fix3314）");
});
check("面2-original 频道列表：原生呈现集恒空（fix336 构造性满足）", () => {
  const list = channelIncoming("original", [jingjieChannel, singleChannel, juruChannel, noEpChannel]);
  assert.ok(!list.some((c) => c.id === 9101), "《警界之花》不以原生形态进视频频道");
  assert.ok(!list.some((c) => c.id === 9102), "《巨乳姐姐》不以原生形态进视频频道");
  /* deepEqual 放最后：其类型断言会把 list 收窄为 never[]。 */
  assert.deepEqual(list, [], "视频频道无原生列表呈现集（内容由外部源承载）");
});
check("面2-ai-duanju 频道列表：短剧条目在短剧频道列表在场", () => {
  const list = channelIncoming("ai-duanju", [jingjieChannel, juruChannel]);
  assert.deepEqual(list.map((c) => c.id), [9101, 9102], "短剧频道列表含全部短剧条目");
});

/* ══ 面 3：全局搜索归类（Search.tsx groups 派生） ══
 * 新码：原生命中先 searchKindForHuangguoVideo（标记优先／结构决
 * 定性兜底／未决以 hgCanonicalSignals 补判／unknown 暂扣），再
 * aggregateHits 分页签。
 * 旧码：kindForHuangguoVideo(搜索载荷) 直判——信号缺失恒落视频。
 * 补判接缝注入：canonicalById 即 Search.tsx useEffect 以 api.video(id)
 * 查 Detail 后经 kindSignalOfDetail 存入 hgCanonicalSignals 的规范
 * 信号（文本绑定见下）。 */
const searchTabs = (cardsIn: Card[], canonical: Record<number, ReturnType<typeof detailOf>>) => {
  const hits: never[] = [];
  cardsIn.forEach((v, i) => {
    const kind = searchKind
      ? searchKind(v as never, canonical[v.id] as never)
      : kindOld(v as never);
    if (kind === "unknown") return;
    hits.push({
      sourceId: "huangguo", sourceName: "黄果", kind,
      item: { sourceId: "huangguo", externalId: String(v.id), title: v.title, cover: v.cover, href: "", tags: [] },
      weight: 100, hot: v.hot ?? 0, seq: i,
    } as never);
  });
  return aggregateHits(hits) as Record<string, { item: { externalId: string } }[]>;
};
check("面3-生产绑定：搜索归类与补判接缝与 Search.tsx 字面对齐", () => {
  if (searchKind) {
    assert.ok(searchSrc.includes("searchKindForHuangguoVideo(v, hgCanonicalSignals"), "Search groups 以补判信号归类");
    assert.ok(searchSrc.includes("api.video(v.id)"), "补判接缝：按 ID 查 Detail");
    assert.ok(searchSrc.includes("kindSignalOfDetail(d)"), "补判经共用提取点构造规范信号（集数＋品类标记，fix322 改绑）");
    assert.ok(searchSrc.includes('resolvedKind === "unknown"'), "unknown 条目暂扣不入页签");
  } else {
    assert.ok(searchSrc.includes("kind: kindForHuangguoVideo(v)"), "旧码搜索直判载荷（无补判）");
    assert.ok(!searchSrc.includes("hgCanonicalSignals"), "旧码无补判状态");
  }
});
check("面3-场景②：同一短剧频道形态与搜索形态（＋补判）同归短剧、绝不进视频", () => {
  const fromChannel = searchTabs([juruChannel, daxiaojieChannel], {});
  const fromSearch = searchTabs([juruSearchZero, daxiaojieSearchMissing], canonicalById);
  for (const [label, tabs] of [["频道形态", fromChannel], ["搜索形态+补判", fromSearch]] as const) {
    assert.deepEqual(tabs.drama.map((m) => m.item.externalId).sort(), ["9102", "9103"], `${label}：两短剧全进短剧页签`);
    assert.equal(tabs.video.length, 0, `${label}：视频页签零混入`);
  }
  assert.deepEqual(
    fromSearch.drama.map((m) => m.item.externalId).sort(),
    fromChannel.drama.map((m) => m.item.externalId).sort(),
    "两种形态归到同一页签同一条目集合（与路径无关）",
  );
});
check("面3-场景①搜索面：《警界之花》搜索形态（信号缺失）＋补判只进短剧", () => {
  const searchForm = card({ id: 9101, title: "警界之花", score: 9.0, episode_count: 0, total_episodes: 0 });
  const tabs = searchTabs([searchForm], canonicalById);
  assert.equal(tabs.drama.length, 1, "补判后进短剧页签");
  assert.equal(tabs.video.length, 0, "绝不进视频页签");
});
check("面3-安全侧：信号缺失且补不到 → 暂不进任何页签（不默认落视频）", () => {
  const tabs = searchTabs([juruSearchZero], {});
  assert.equal(tabs.video.length + tabs.drama.length + tabs.post.length + tabs.image.length, 0, "unknown 暂扣、四页签皆无");
});
check("面3-对照：真单条搜索形态经补判仍进视频、不误伤", () => {
  const tabs = searchTabs([singleSearchZero], canonicalById);
  assert.equal(tabs.video.length, 1, "单条（规范记录 1 集、标记 26）进视频页签");
  assert.equal(tabs.drama.length, 0, "单条不进短剧页签");
  const direct = searchTabs([singleChannel], canonicalById);
  assert.equal(direct.video.length, 1, "单条频道形态经标记补判进视频页签");
  const bare = searchTabs([singleChannel], {});
  assert.equal(bare.video.length + bare.drama.length, 0, "单条补判未到时暂扣（fix322：1 集不直判）");
});

if (failures > 0) {
  console.log(`fix321-accept-f4.contract: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("fix321-accept-f4.contract: all assertions passed");
