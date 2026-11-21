/**
 * 搜索历史长按批量删契约测试（Muse 2026-11-21 fix3311/small-features；
 * 新增测试经维护者在本批任务书中授权，AGENTS 不变量 11）。
 * 运行：node src/features/search/fix3311-search-history.contract.test.ts
 *
 * 背景（上游 v2.2.4 #184 拣选，upstream-picks-20261121 定案）：我方
 * 搜索历史此前只有「清空」全量清除，想删单条只能全清——真实缺口。
 * 定版形态：长按一条历史进入多选态、勾选后批量删除、退出多选恢复
 * 常规点按打开；「清空」保留。存储口径不变（同一 Persist 键、
 * setP 即时落盘），删除走 store 的 removeSearchHist 按选集过滤。
 *
 * 本测试钉三件事：
 * ① 选集纯函数（searchHistoryState）：勾选切换不改入参、有效选集
 *    只认当前历史里仍存在的条目（陈旧选集不计数不删除）。
 * ② store 接线（源码断言）：Store 类型含 removeSearchHist、实现按
 *    选集 Set 过滤 searchHist、value 暴露给消费方。
 * ③ 两面共用组件（源码断言）：Search 与 InplaceSearch 都渲染
 *    SearchHistory 且不再自绘历史 chips；组件含长按计时进入多选、
 *    aria-pressed 勾选态、批量删除与清空双入口。基点无此文件与
 *    符号 → 全红。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HISTORY_LONG_PRESS_MS, toggleHistorySelection, validHistorySelection } from "./searchHistoryState.ts";

/* ── ① 选集纯函数 ── */
{
  const base = ["甲"];
  const added = toggleHistorySelection(base, "乙");
  assert.deepEqual(added, ["甲", "乙"], "未选条目勾选后入选集");
  assert.deepEqual(base, ["甲"], "勾选切换不改入参");
  assert.deepEqual(toggleHistorySelection(added, "甲"), ["乙"], "已选条目再点取消勾选");
  assert.deepEqual(toggleHistorySelection([], "甲"), ["甲"], "空选集勾选首条");

  assert.deepEqual(validHistorySelection(["甲", "乙", "丙"], ["丙", "甲"]), ["甲", "丙"], "有效选集剔除已不在历史里的条目");
  assert.deepEqual(validHistorySelection(["甲"], []), [], "历史清空后选集全失效");
  assert.equal(HISTORY_LONG_PRESS_MS, 500, "长按判定 500ms（点按打开不被误吞）");
}

/* ── ② store 接线 ── */
{
  const store = readFileSync(new URL("../../shared/model/store.tsx", import.meta.url), "utf8");
  assert.ok(store.includes("removeSearchHist: (items: readonly string[]) => void"), "Store 类型声明 removeSearchHist");
  assert.ok(/searchHist: s\.searchHist\.filter\(\(x\) => !drop\.has\(x\)\)/.test(store), "removeSearchHist 按选集过滤 searchHist（其余条目逐字保留）");
  assert.ok(store.includes("searchHist: p.searchHist, addSearch, clearSearchHist, removeSearchHist"), "store value 暴露 removeSearchHist");
  assert.ok(store.includes("clearSearchHist"), "全量清空 clearSearchHist 保留不删");
}

/* ── ③ 两面共用组件 ── */
{
  const comp = readFileSync(new URL("./SearchHistory.tsx", import.meta.url), "utf8");
  assert.ok(comp.includes("HISTORY_LONG_PRESS_MS"), "长按计时走共享常量（不在两面各写一份）");
  assert.ok(comp.includes("onPointerDown"), "长按经 pointerdown 计时进入多选");
  assert.ok(comp.includes("aria-pressed"), "多选态条目以 aria-pressed 呈勾选（复用 pill 既有选中样式）");
  assert.ok(comp.includes("removeSearchHist(validSelected)"), "批量删除只删有效选集");
  assert.ok(comp.includes("clearSearchHist"), "组件保留「清空」全量入口");
  assert.ok(comp.includes("toggleHistorySelection") && comp.includes("validHistorySelection"), "选集增删/裁剪走纯函数唯一口径");

  const search = readFileSync(new URL("./Search.tsx", import.meta.url), "utf8");
  const inplace = readFileSync(new URL("./InplaceSearch.tsx", import.meta.url), "utf8");
  assert.ok(search.includes("<SearchHistory"), "全局搜索页消费 SearchHistory");
  assert.ok(inplace.includes("<SearchHistory"), "就地搜索消费 SearchHistory");
  assert.ok(!search.includes("searchHist.map("), "全局搜索页不再自绘历史 chips");
  assert.ok(!inplace.includes("searchHist.map("), "就地搜索不再自绘历史 chips");
}

console.log("fix3311-search-history.contract: all assertions passed");
