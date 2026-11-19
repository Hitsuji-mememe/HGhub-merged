/**
 * 3.2.1 修复 F4b 线契约测试（Muse 2026-11-19，维护者任务书授权新增：
 * 用户新截图实锤——搜「御姐」，视频页签混入同批 AI 短剧；搜索的 kind
 * 判定跟着「结果从哪个端点回来」走：通用搜索端点载荷缺剧集结构信号
 * （total_episodes/episode_count 缺失或恒 0），同 ID 条目在频道/详情
 * 数据里却有，判定函数在场也无信号可用）。
 * 运行：node src/features/search/fix321-f4b.contract.test.ts
 * 覆盖：同一 AI 短剧条目以「通用搜索端点形态」（信号缺失）与「短剧
 * 频道端点形态」（信号齐全）两种载荷进入搜索归类、经规范记录补判后
 * 最终都只进短剧页签不进视频页签；信号缺失且补不到 → unknown 安全
 * 侧（不进视频、也不猜进短剧）；单条视频仍进视频页签；判定同源
 * （shared/lib/contentKind 唯一出处、搜索层只 re-export）；Search
 * 生产接线文本断言。不访问真实网络。
 * fix322 适配注记（契约变化、非削弱）：裁决升级为标记优先——裸
 * 1 集卡（无标记、无补判）不再直判视频、落 unknown 暂扣待补判；
 * 真单条的 Detail 规范记录带 tracking 品类标记（26/27），本文件
 * singleCanonical 夹具据此补 source_type_id: 26（Detail 实际形
 * 态，映射出自上游官方分类表），「单条不误伤」改由标记补判路径
 * 验证、覆盖不减。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  hasEpisodeStructureSignal as sharedHasSignal,
  kindForHuangguoVideo as sharedKind,
  searchKindForHuangguoVideo as sharedSearchKind,
  type EpisodeStructureSignal,
} from "../../shared/lib/contentKind.ts";
import {
  aggregateHits,
  searchKindForHuangguoVideo as searchSearchKind,
  type FanoutHit,
} from "./multiSourceSearch.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* 条目形态夹具（字段以 VideoCard / Detail 实际模型为准）：
 * 同一 AI 短剧《巨乳姐姐》（用户截图条目）——频道形态集数齐全、
 * 通用搜索形态信号缺失（恒 0 与字段缺失两变体前端不可区分、同处理）、
 * 规范记录（Detail）形态集数＋episodes 数组齐全。 */
const dramaChannelForm = { id: 201, title: "巨乳姐姐", episode_count: 24, total_episodes: 24 };
const dramaSearchFormZero = { id: 201, title: "巨乳姐姐", episode_count: 0, total_episodes: 0 };
const dramaSearchFormMissing = { id: 201, title: "巨乳姐姐" } as EpisodeStructureSignal & { id: number; title: string };
const dramaCanonical = { episode_count: 24, total_episodes: 24, episodes: Array.from({ length: 24 }, (_, i) => ({ ep_num: i + 1 })) };
const singleSearchForm = { id: 202, title: "单条视频甲", episode_count: 1, total_episodes: 1 };
const singleSearchFormNoSignal = { id: 202, title: "单条视频甲", episode_count: 0, total_episodes: 0 };
/* fix322：Detail 实际形态带 tracking 品类标记，真单条为 26/27 类 */
const singleCanonical = { episode_count: 1, total_episodes: 1, episodes: [{ ep_num: 1 }], source_type_id: 26 };

/* 搜索页签归类复刻（与 Search.tsx groups 同口径）：resolved kind 为
 * unknown 的条目不生成任何页签命中（安全侧暂扣），其余经
 * aggregateHits 按 kind 分页签。 */
const tabGroupsFor = (entries: { card: EpisodeStructureSignal & { id: number; title: string }; canonical?: EpisodeStructureSignal }[]) => {
  const hits: FanoutHit[] = [];
  entries.forEach(({ card, canonical }, i) => {
    const kind = sharedSearchKind(card, canonical);
    if (kind === "unknown") return;
    hits.push({
      sourceId: "huangguo", sourceName: "黄果", kind,
      item: { sourceId: "huangguo", externalId: String(card.id), title: card.title, cover: `https://img.example.com/${card.id}.jpg`, href: "", tags: [] },
      weight: 100, hot: 0, seq: i,
    });
  });
  return aggregateHits(hits);
};

/* ── 判定同源：搜索层与 shared 必须是同一个函数引用，不许第二套 ── */
{
  assert.equal(searchSearchKind, sharedSearchKind, "搜索 searchKindForHuangguoVideo 与 shared 判定为同一函数引用（同源）");
  const multi = read("./multiSourceSearch.ts");
  assert.ok(multi.includes("searchKindForHuangguoVideo"), "multiSourceSearch re-export 搜索判定");
}

/* ── 信号在场性：频道形态有信号、搜索缺失形态无信号、单条 1 集有信号 ── */
{
  assert.equal(sharedHasSignal(dramaChannelForm), true, "频道形态（24 集）有剧集结构信号");
  assert.equal(sharedHasSignal(dramaSearchFormZero), false, "搜索形态（恒 0）无可用信号");
  assert.equal(sharedHasSignal(dramaSearchFormMissing), false, "搜索形态（字段缺失）无可用信号");
  assert.equal(sharedHasSignal(singleSearchForm), true, "单条（1 集）有信号（计数为正即已确认）");
  assert.equal(sharedHasSignal(dramaCanonical), true, "规范记录（Detail）有信号");
}

/* ── 搜索归类（核心场景）：同一 AI 短剧两种载荷最终同归短剧 ── */
{
  assert.equal(sharedKind(dramaChannelForm), "drama", "频道形态经既有判定 → 短剧");
  assert.equal(sharedSearchKind(dramaChannelForm), "drama", "频道形态进搜索归类 → 短剧（无需补判）");
  assert.equal(sharedSearchKind(dramaSearchFormZero, dramaCanonical), "drama", "搜索形态（恒 0）＋规范记录补判 → 短剧");
  assert.equal(sharedSearchKind(dramaSearchFormMissing, dramaCanonical), "drama", "搜索形态（字段缺失）＋规范记录补判 → 短剧");

  const fromChannel = tabGroupsFor([{ card: dramaChannelForm }]);
  assert.equal(fromChannel.drama.length, 1, "频道形态：进短剧页签");
  assert.equal(fromChannel.video.length, 0, "频道形态：不进视频页签");
  const fromSearch = tabGroupsFor([{ card: dramaSearchFormZero, canonical: dramaCanonical }]);
  assert.equal(fromSearch.drama.length, 1, "搜索形态＋补判：进短剧页签");
  assert.equal(fromSearch.video.length, 0, "搜索形态＋补判：不进视频页签");
  assert.equal(fromSearch.drama[0].item.externalId, fromChannel.drama[0].item.externalId, "两种载荷归到同一条目同一页签");
}

/* ── 安全侧：信号缺失且补不到 → unknown，绝不默认落视频、也不猜短剧 ── */
{
  assert.equal(sharedSearchKind(dramaSearchFormZero), "unknown", "无补判 → unknown（不默认落视频）");
  assert.equal(sharedSearchKind(dramaSearchFormMissing), "unknown", "字段缺失无补判 → unknown");
  assert.equal(sharedSearchKind(dramaSearchFormZero, { episode_count: 0, total_episodes: 0 }), "unknown", "规范记录同样无信号 → unknown");
  assert.equal(sharedSearchKind(dramaSearchFormZero, null), "unknown", "补判失败（null）→ unknown");
  const held = tabGroupsFor([{ card: dramaSearchFormZero }]);
  assert.equal(held.video.length + held.drama.length + held.post.length + held.image.length, 0, "unknown 条目暂不进任何页签");
}

/* ── 单条视频不误伤：经标记补判进视频；补判未到先暂扣（fix322） ── */
{
  assert.equal(sharedSearchKind(singleSearchForm), "unknown", "单条（1 集）无标记无补判 → unknown 暂扣（fix322：单集不直判、与单集短剧同形）");
  assert.equal(sharedSearchKind(singleSearchFormNoSignal, singleCanonical), "video", "单条无信号＋规范记录（1 集、标记 26）→ 视频");
  assert.equal(sharedSearchKind(singleSearchForm, singleCanonical), "video", "单条（1 集）＋标记补判 → 视频");
  const groups = tabGroupsFor([{ card: singleSearchFormNoSignal, canonical: singleCanonical }]);
  assert.equal(groups.video.length, 1, "单条经补判进视频页签");
  assert.equal(groups.drama.length, 0, "单条不进短剧页签");
  const held = tabGroupsFor([{ card: singleSearchForm }]);
  assert.equal(held.video.length + held.drama.length, 0, "单条补判未到时暂不进任何页签（不误入视频）");
}

/* ── 生产接线（文本断言，与 wiring-manifest fix321-f4b-* 互证） ── */
{
  const search = read("./Search.tsx");
  assert.ok(search.includes("searchKindForHuangguoVideo"), "Search 搜索归类调用共用搜索判定");
  assert.ok(search.includes("hgCanonicalSignals"), "Search 以规范记录信号补判（hgCanonicalSignals）");
  assert.ok(search.includes('resolvedKind === "unknown"'), "Search 对 unknown 条目暂扣、不入页签");
}

console.log("fix321-f4b.contract: all assertions passed");
