/**
 * 3.2.1 修复 F4c 线契约测试（Muse 2026-11-19，维护者任务书授权新增：
 * 验收 C 展示面遍历抓到的真违例——频道内站内搜索 InplaceSearch 两面
 * 未接内容性质判定，基线与 F4/F4b 修复树逐字相同、新码仍红，见
 * fix321/evidence/accept/F4.md §三-4）。
 * 运行：node src/features/search/fix321-f4c.contract.test.ts
 *
 * 不变量：「任一条目按内容性质只进一个分区/页签，与来源路径无关；
 * 有分集/剧集结构的只归短剧，绝不进视频。」
 * 违例形态（验收 C 探针场景复用）：面1＝scope="original" 面标「视频」，
 * 旧码仅以 is_original===1 过滤——《警界之花》（3 集、is_original=1）
 * 被放行进「视频」面；面2＝无 scope 面标「短剧」，旧码零过滤走全局
 * api.search——单条视频混入「短剧」面。
 * 修复口径：useSearchResults 的视频结果一律过与全 App 同源的性质门
 * （shared/lib/contentKind 的 filterSearchCardsByKind＋searchKindFor-
 * HuangguoVideo 补判接缝：自带信号直判→按 ID 查 Detail 补判→仍无
 * 信号落 unknown 暂不呈现、补判到达后自动归位）；面1 只留 video、
 * 面2 只留 drama。本测试以完整 VideoCard 形态夹具直接执行生产门
 * 函数，并以源码文本断言绑死 hook 接线（漂移即红）。不访问真实网络。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  filterSearchCardsByKind,
  searchKindForHuangguoVideo,
  type EpisodeStructureSignal,
} from "../../shared/lib/contentKind.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* 完整 VideoCard 形态夹具（字段以 shared/api/types.ts 为准；锚点
 * 《警界之花》3 集/原创来自用户实报＋验收 C 档案）。 */
type Card = EpisodeStructureSignal & { id: number; title: string; is_original: number; cover: string; tags: string[]; hot: number };
const card = (p: Partial<Card> & { id: number; title: string }): Card => ({
  cover: `https://img.example.com/${p.id}.jpg`, tags: [], hot: 0, is_original: 0, ...p,
});
const jingjie = card({ id: 9101, title: "警界之花", episode_count: 3, total_episodes: 3, is_original: 1 });
const singleOriginal = card({ id: 9104, title: "单条视频甲", episode_count: 1, total_episodes: 1, is_original: 1 });
const singleNonOriginal = card({ id: 9106, title: "单条视频丙", episode_count: 1, total_episodes: 1, is_original: 0 });
/* 搜索载荷形态：通用搜索端点不下发剧集结构信号（恒 0/缺失，F4b 根因），
 * 同一条目须经 Detail 规范记录补判。 */
const jingjieSearchForm = card({ id: 9101, title: "警界之花", episode_count: 0, total_episodes: 0, is_original: 1 });
const singleSearchForm = card({ id: 9104, title: "单条视频甲", episode_count: 0, total_episodes: 0, is_original: 1 });
const jingjieCanonical: EpisodeStructureSignal = { episode_count: 3, total_episodes: 3, episodes: [{}, {}, {}] };
const singleCanonical: EpisodeStructureSignal = { episode_count: 1, total_episodes: 1, episodes: [{}] };
const noCanonical = () => undefined;
const canonicalFor = (m: Record<number, EpisodeStructureSignal>) => (c: Card) => m[c.id];

const ids = (cards: Card[]) => cards.map((c) => c.id);

/* ── 面1（「视频」，scope=original）：多集剧绝不进、单条保留 ── */
{
  const shown = filterSearchCardsByKind([jingjie, singleOriginal], "video", noCanonical);
  assert.deepEqual(ids(shown), [9104], "面1： 《警界之花》（3 集）被性质门剔除、单条视频保留");
  assert.equal(searchKindForHuangguoVideo(jingjie), "drama", "面1 判定同源：3 集 → drama");
}

/* ── 面2（「短剧」，无 scope）：单条绝不进、多集保留 ── */
{
  const shown = filterSearchCardsByKind([jingjie, singleOriginal, singleNonOriginal], "drama", noCanonical);
  assert.deepEqual(ids(shown), [9101], "面2：只留多集剧、两条单条视频被性质门剔除");
}

/* ── 补判形态：搜索载荷无信号、Detail 有多集/单集 → 两面归位正确 ── */
{
  const lookup = canonicalFor({ 9101: jingjieCanonical, 9104: singleCanonical });
  assert.deepEqual(ids(filterSearchCardsByKind([jingjieSearchForm, singleSearchForm], "drama", lookup)), [9101],
    "补判：无信号短剧经 Detail 补判（3 集）进短剧面");
  assert.deepEqual(ids(filterSearchCardsByKind([jingjieSearchForm, singleSearchForm], "video", lookup)), [9104],
    "补判：无信号单条经 Detail 补判（1 集）进视频面、不误伤");
}

/* ── 安全侧：无信号且补不到 → unknown，两面都不呈现 ── */
{
  assert.equal(searchKindForHuangguoVideo(jingjieSearchForm), "unknown", "无信号无补判 → unknown");
  assert.deepEqual(ids(filterSearchCardsByKind([jingjieSearchForm], "video", noCanonical)), [], "unknown 不进视频面");
  assert.deepEqual(ids(filterSearchCardsByKind([jingjieSearchForm], "drama", noCanonical)), [], "unknown 不猜进短剧面");
  assert.deepEqual(ids(filterSearchCardsByKind([jingjieSearchForm], "drama", () => ({ episode_count: 0, total_episodes: 0 }))), [],
    "补判记录同样无信号 → 仍 unknown、不进任何面");
}

/* ── 生产接线（文本断言，与 wiring-manifest fix321-f4c-* 互证） ── */
{
  const hook = read("./useSearchResults.ts");
  assert.ok(hook.includes("filterSearchCardsByKind"), "useSearchResults 结果过性质门 filterSearchCardsByKind");
  assert.ok(hook.includes('from "../../shared/lib/contentKind"'), "性质门来自 shared/lib/contentKind 唯一出处、无第三套判定");
  assert.ok(hook.includes('scope === "original" ? "video" : "drama"'), "目标性质与呈现标签同口径：original 面=video、其余面=drama");
  assert.ok(hook.includes("api.video("), "信号缺失条目按 ID 查 Detail 补判（api.video）");
  assert.ok(hook.includes("Math.min(4,"), "补判并发 ≤4（与全局搜索 F4b 同口径）");
  assert.ok(hook.includes("hasEpisodeStructureSignal"), "只查自带信号缺失者（hasEpisodeStructureSignal 门）");
  assert.ok(hook.includes("item.is_original === 1"), "original 面既有 is_original 圈定保留（频道圈定不在本线改动范围）");
  const inplace = read("./InplaceSearch.tsx");
  assert.ok(inplace.includes('scope === "original" ? "视频" : "短剧"'), "呈现标签口径未变：original=视频、其余=短剧");
}

console.log("fix321-f4c.contract: all assertions passed");
