/**
 * 3.2.1 修复 F1 线契约测试（Muse 2026-11-19，任务书即维护者对
 * 新增契约测试的授权——AGENTS 不变量 11；一契约一回归、最精简）。
 * 运行：node src/features/search/fix321-f1.contract.test.ts
 * 契约：全局搜索同源重复必合并——同源同 ID 必合并且 copies 按
 * (sourceId, externalId) 去重、identityConfirmed=true；同源同标题
 * ＋同封面（不同 ID）必合并；跨批累计呈现（onPartial 累计快照经
 * aggregateHits 全量重聚合）不漏合并；跨源低置信仍不合并（既有
 * 置信门回归防线，不削弱）。
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

/* ── 同源同标题＋同封面、不同 ID → 一张卡（两 ID 副本各留一份） ── */
{
  const a = hit("huangguo", "黄果", "post", "12345", TITLE, COVER, 100, 7, 0);
  const b = hit("huangguo", "黄果", "post", "67890", TITLE, COVER, 100, 5, 1);
  const merged = mergeHits([a, b]);
  assert.equal(merged.length, 1, "同源同标题同封面不同 ID：只剩一张卡");
  assert.equal(merged[0].copies.length, 2, "不同 ID 是两个不同键：副本各留一份、不误删");
  assert.deepEqual(merged[0].copies.map((c) => c.item.externalId).sort(), ["12345", "67890"], "两 ID 均保留");
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
