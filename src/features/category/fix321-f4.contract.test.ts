/**
 * 3.2.1 修复 F4 线契约测试（Muse 2026-11-19，维护者任务书授权新增：
 * 用户实报分类总览《警界之花》同时出现在「短剧」与「视频」两区——
 * 浏览面按频道归类、搜索按内容性质归类，两条路判定分叉）。
 * 运行：node src/features/category/fix321-f4.contract.test.ts
 * 覆盖：性质判定同源（shared/lib/contentKind 为唯一实现、搜索层
 * 只 re-export 同一函数引用）、混合列表按性质分组（多集只入短剧
 * 组、单条仍入视频组）、Category 生产接线文本断言（总览分组＋
 * 视频频道分页过滤）。不访问真实网络。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  kindForHuangguoVideo as sharedKind,
  partitionCardsByKind,
} from "../../shared/lib/contentKind.ts";
import { kindForHuangguoVideo as searchKind } from "../search/multiSourceSearch.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* 条目形态夹具：字段以 VideoCard 实际模型为准（episode_count /
 * total_episodes），《警界之花》形态＝3 集、9.0 分（用户截图实锤）。 */
const jingjie = { id: 101, title: "警界之花", score: 9.0, episode_count: 3, total_episodes: 3 };
const single = { id: 102, title: "单条视频甲", score: 8.1, episode_count: 1, total_episodes: 1 };
const noEpisodes = { id: 103, title: "无分集视频乙", score: 7.5, episode_count: 0, total_episodes: 0 };
const finishedDrama = { id: 104, title: "完结剧集丙", score: 8.8, episode_count: 80, total_episodes: 80 };

/* ── 判定同源：搜索层与浏览面必须是同一个函数引用，不许第二套实现 ── */
{
  assert.equal(searchKind, sharedKind, "搜索 kindForHuangguoVideo 与 shared 判定为同一函数引用（同源）");
  const multi = read("../search/multiSourceSearch.ts");
  assert.ok(multi.includes('from "../../shared/lib/contentKind.ts"'), "multiSourceSearch 从 shared 引入判定");
  assert.ok(!multi.includes('? "drama" : "video"'), "multiSourceSearch 内无第二套判定实现");
}

/* ── 性质判定：有分集/剧集结构（任一集数字段 >1）→ 短剧，其余 → 视频 ── */
{
  assert.equal(sharedKind(jingjie), "drama", "《警界之花》（3 集）→ 短剧");
  assert.equal(sharedKind(single), "video", "单条（1 集）→ 视频");
  assert.equal(sharedKind(noEpisodes), "video", "无分集（0 集）→ 视频");
  assert.equal(sharedKind({ total_episodes: 12 }), "drama", "仅 total_episodes>1 也判短剧");
  assert.equal(sharedKind({ episode_count: 5 }), "drama", "仅 episode_count>1 也判短剧");
  assert.equal(sharedKind({}), "video", "字段缺失 → 视频（无结构信号不臆造）");
}

/* ── 分组（浏览面口径）：多集只在短剧组、绝不进视频组；单条仍在视频组 ── */
{
  const groups = partitionCardsByKind([jingjie, single, finishedDrama, noEpisodes]);
  assert.deepEqual(groups.drama.map((c) => c.title), ["警界之花", "完结剧集丙"], "短剧组含全部多集条目、原序保留");
  assert.deepEqual(groups.video.map((c) => c.title), ["单条视频甲", "无分集视频乙"], "视频组只含单条/无分集条目");
  assert.ok(!groups.video.some((c) => c.title === "警界之花"), "《警界之花》不出现在视频组");
  assert.ok(groups.drama.some((c) => c.title === "警界之花"), "《警界之花》出现在短剧组");
  assert.deepEqual(partitionCardsByKind([]), { video: [], drama: [] }, "空列表分组恒两键空组");
}

/* ── 生产接线（文本断言，与 wiring-manifest fix321-f4-* 互证） ── */
{
  const category = read("./Category.tsx");
  assert.ok(category.includes("partitionCardsByKind"), "Category 浏览面调用共用分组");
  assert.ok(category.includes("originalKindGroups.video"), "分类总览视频区只渲染 video 组");
  assert.ok(category.includes("originalKindGroups.drama"), "分类总览短剧区合并 original 频道中的短剧组");
  assert.ok(category.includes('partitionCardsByKind(rawItems).video'), "视频频道分页 incoming 先按性质过滤再入列表");
}

console.log("fix321-f4.contract: all assertions passed");
