/**
 * 3.2.1 修复 F1 线契约测试（Muse 2026-11-19，任务书即维护者对
 * 新增契约测试的授权——AGENTS 不变量 11；一契约一回归、最精简）。
 * 运行：node src/features/search/fix321-f1.contract.test.ts
 * 契约：全局搜索同源重复必合并——同源同 ID 必合并且 copies 按
 * (sourceId, externalId) 去重、identityConfirmed=true；同源同标题
 * ＋同封面（不同 ID）必合并；跨批累计呈现（onPartial 累计快照经
 * aggregateHits 全量重聚合）不漏合并；跨源低置信仍不合并（既有
 * 置信门回归防线，不削弱）。
 * 2026-11-19 fix322/play 修订（用户真机裁定，3.2.1 首验）：详情页
 * 「来源副本」出现同名双副本是缺陷——副本层与卡片层共用同一去重
 * 判定：同源 content 重复（同标题＋同封面、不同 ID）并卡后不再
 * 保留第二副本（原「两 ID 副本各留一份、不误删」条款作废）；同源
 * 判定优先于跨源置信合并（先全簇扫同源、再走置信），到达顺序与
 * publishedAt 完整度差异不得把同一条目劈进两张卡各留一份副本。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SourceItem } from "../sources/types.ts";
import {
  aggregateHits, mergeConfidence, mergeHits, type FanoutHit,
} from "./multiSourceSearch.ts";

const item = (sourceId: string, externalId: string, title: string, cover: string, hot?: number): SourceItem => ({
  sourceId, externalId, title, cover, href: "", tags: [], hot,
});
const hit = (sourceId: string, sourceName: string, kind: FanoutHit["kind"], externalId: string, title: string, cover: string, weight = 100, hot = 0, seq = 0): FanoutHit => ({
  sourceId, sourceName, kind, item: item(sourceId, externalId, title, cover, hot || undefined), weight, hot, seq,
});

const COVER = "https://cdn.example.com/3p/shared-cover.jpg";
const TITLE = "3p 同一条帖子标题";

/* ── 用户场景：黄果同帖两条命中（同源同 ID、同标题同封面，
 * 模拟原生通道 seq=0 与扇出通道 seq=100000 各来一份）→ 一张卡 ── */
{
  const nativeHit = hit("huangguo", "黄果", "post", "12345", TITLE, COVER, 100, 7, 0);
  const fanoutHit = hit("huangguo", "黄果", "post", "12345", TITLE, COVER, 100, 7, 100000);
  const merged = mergeHits([nativeHit, fanoutHit]);
  assert.equal(merged.length, 1, "同源同 ID 同帖：mergeHits 后只剩一张卡");
  assert.equal(merged[0].copies.length, 1, "copies 按 (sourceId, externalId) 去重：同一条目不留假副本");
  assert.equal(merged[0].identityConfirmed, true, "同源同 ID 合并：identityConfirmed=true（同一条目自明）");
  const groups = aggregateHits([nativeHit, fanoutHit]);
  assert.equal(groups.post.length, 1, "同源同 ID 同帖：aggregateHits 后帖子组只剩一张卡");
  assert.equal(groups.video.length + groups.drama.length + groups.image.length, 0, "不串到其他页签");
}

/* ── 同源同标题＋同封面、不同 ID → 一张卡、副本只留一份
 * （fix322/play 修订：副本层与卡片层共用同一去重判定——同内容
 * 重复挂载在详情里不是两个可切换副本，只留高优先的第一份） ── */
{
  const a = hit("huangguo", "黄果", "post", "12345", TITLE, COVER, 100, 7, 0);
  const b = hit("huangguo", "黄果", "post", "67890", TITLE, COVER, 100, 5, 1);
  const merged = mergeHits([a, b]);
  assert.equal(merged.length, 1, "同源同标题同封面不同 ID：只剩一张卡");
  assert.equal(merged[0].copies.length, 1, "同源 content 重复：副本只留一份（详情不出现同名双副本）");
  assert.equal(merged[0].copies[0].item.externalId, "12345", "保留高优先（热度高）的第一份");
  assert.equal(merged[0].identityConfirmed, true, "同源 content 合并：身份确认口径不变");
}

/* ── 跨源簇内的同源 content 重复：副本不重复、alsoOn 不重名 ── */
{
  const q = hit("51chigua", "51吃瓜网", "post", "q1", TITLE, COVER, 100, 0, 0);
  const p1 = hit("meiridasai", "每日大赛", "post", "p1", TITLE, COVER, 50, 0, 1);
  const p2 = hit("meiridasai", "每日大赛", "post", "p2", TITLE, COVER, 50, 0, 2);
  const merged = mergeHits([q, p1, p2]);
  assert.equal(merged.length, 1, "跨源同题同封面先并成一簇");
  assert.equal(merged[0].copies.filter((c) => c.sourceId === "meiridasai").length, 1, "簇内同一来源只留一个副本");
  assert.equal(merged[0].copies.length, 2, "簇内副本总数 = 跨源两源各一份");
  assert.deepEqual(merged[0].alsoOn, ["每日大赛"], "alsoOn 只记跨源来源名、不因同源重复重名");
}

/* ── 同源判定优先于置信合并：双路到达的 publishedAt 完整度不同，
 * 后到一份不得被先建簇的置信匹配截走、在两张卡各留一份副本 ── */
{
  const DAY = 24 * 3600_000;
  const t0 = 1_700_000_000_000;
  const q = hit("51chigua", "51吃瓜网", "post", "q1", TITLE, "https://cdn-a.example.com/x/shared-name.jpg", 100, 0, 0);
  q.publishedAt = t0;
  const p1 = hit("meiridasai", "每日大赛", "post", "p1", TITLE, "https://cdn-b.example.com/y/shared-name.jpg", 50, 0, 1);
  p1.publishedAt = t0 + 40 * DAY; // 与 q 时间远：置信 3+1-2=2 <3，自成一簇
  const p2 = hit("meiridasai", "每日大赛", "post", "p1-dup", TITLE, "https://cdn-b.example.com/y/shared-name.jpg", 50, 0, 2);
  p2.publishedAt = t0 + 3600_000; // 与 q 时间近：对 q 簇置信 3+1+1=5 ≥3（旧实现会先截入 q 簇）
  const merged = mergeHits([q, p1, p2]);
  const pCopies = merged.flatMap((m) => m.copies).filter((c) => c.sourceId === "meiridasai");
  assert.equal(pCopies.length, 1, "同一条目（同源同内容）在全部卡片中只留一份副本");
  assert.equal(pCopies[0].item.externalId, "p1", "副本归同源簇（与 p1 同簇），不被置信截胡");
}

/* ── 跨批到达：onPartial 累计快照在呈现层经 aggregateHits 全量
 * 重聚合，后到批次的同源重复不漏网（钉住既有累积方式） ── */
{
  const first = hit("huangguo", "黄果", "post", "12345", TITLE, COVER, 100, 7, 0);
  const dup = hit("huangguo", "黄果", "post", "12345", TITLE, COVER, 100, 7, 100000);
  const batch1 = aggregateHits([first]);
  assert.equal(batch1.post.length, 1, "首批一张卡");
  const batch2 = aggregateHits([first, dup]);
  assert.equal(batch2.post.length, 1, "跨批累计重聚合后仍一张卡：跨批重复在最终呈现层合并");
}

/* ── 回归防线：跨源同名低置信（同题异封面）仍不合并 ── */
{
  const a = hit("51chigua", "51吃瓜网", "post", "x1", "同题不同内容判例", "https://a.example.com/x/aaa-111.jpg", 100, 5, 0);
  const b = hit("feedheiliao", "黑料网", "post", "y1", "同题不同内容判例", "https://b.example.com/y/zzz-999.jpg", 60, 4, 1);
  assert.ok(mergeConfidence(a, b) < 3, "跨源同题异封面置信仍低于合并门");
  assert.equal(mergeHits([a, b]).length, 2, "跨源低置信不合并：宁漏勿误口径不削弱");
}

/* ── 生产接线：Search 扇出排除已由原生通道覆盖的黄果（防重复扇出） ── */
{
  const search = readFileSync(new URL("./Search.tsx", import.meta.url), "utf8");
  assert.ok(search.includes("FANOUT_EXCLUDE_NATIVE"), "Search 扇出排除原生已覆盖源（黄果双路重复扇出已断）");
}

console.log("fix321-f1.contract: all assertions passed");
