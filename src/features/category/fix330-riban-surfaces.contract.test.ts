/**
 * 3.3.1 里番面接线修复·分类面契约（Muse 2026-11-19
 * fix330-riban-surfaces；本线任务书即维护者对新增测试的授权，
 * AGENTS 不变量 11）。运行：
 * node src/features/category/fix330-riban-surfaces.contract.test.ts
 *
 * 沿革：本文件原守「视频品类源在分类面的列示与到达」（总览区段
 * →fix336 改钉视频频道切源片＋video:<id> 深链分支）。
 *
 * 断言适配（fix3314，2026-11-21，用户亲定视频板块整组删除）：
 * 视频四源、视频频道与 SourceBrowse 浏览面全部退场，本文件整
 * 体改钉「退场不复活」口径——选择器对 video 品类恒空、Category
 * 无视频列示/挂载、陈旧 video: 深链只落下线提示分支。原列示集
 * 合断言的防错目标（注册表已启用 ≠ 浏览面已接通）在新形态下由
 * 「源与面同删」构造性满足，本文件守其不回潮。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry, sourcesForCategory, sourcesForChannel } from "../sources/registry.ts";

const REMOVED_IDS = ["hanime-tv", "iwara", "hentaigasm", "hentaiplay"];

/* ── 选择器口径：video 品类恒空、四源不在册 ── */
{
  const builtin = getBuiltinRegistry();
  assert.deepEqual(sourcesForCategory("video", builtin), [], "video 品类列示恒空（视频板块已删，fix3314）");
  assert.deepEqual(sourcesForChannel("original", builtin), [], "原视频频道切源片恒空（fix3314）");
  assert.deepEqual(sourcesForChannel("ai-duanju", builtin), [], "短剧频道外部映射恒空（原生唯一映射，fix3314）");
  for (const id of REMOVED_IDS) {
    assert.ok(!builtin.some((s) => s.id === id), `${id} 已摘除注册表（fix3314）`);
  }
  assert.ok(builtin.every((s) => s.category !== "video"), "注册表无 video 品类源（fix3314）");
}

/* ── 生产调用点（Category.tsx 源码文本断言）：退场不复活 ── */
{
  const src = readFileSync(new URL("./Category.tsx", import.meta.url), "utf8");
  assert.ok(!src.includes('aria-label="视频源"'), "总览无「视频源」区段（fix336 退场、fix3314 不复活）");
  assert.ok(!src.includes("overview-video-rows"), "总览不消费 overview-video-rows（面已删）");
  assert.ok(!src.includes('{ cate: "original", name: "视频"'), "CHANNELS 无视频频道行（fix3314）");
  assert.ok(!src.includes("<SourceBrowse"), "ChannelPage 不挂载 SourceBrowse（组件已删，fix3314）");
  assert.ok(!src.includes("sources/SourceBrowse"), "Category 不导入 SourceBrowse（fix3314）");
  assert.ok(src.includes('cate === "original" || cate.startsWith("video:")'), "陈旧视频频道/深链落下线提示分支（fix3314）");
  assert.ok(src.includes("视频板块已下线"), "下线提示文案在位（fix3314）");
  assert.ok(src.includes("sourceOptionsForChannel(cate)"), "存活频道切源片仍消费频道-源映射派生（短剧频道不受影响）");
}

console.log("fix330-riban-surfaces (category) contract: ok");
