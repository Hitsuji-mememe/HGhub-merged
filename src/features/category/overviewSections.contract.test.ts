/**
 * 分类总览空区隐藏契约（Muse 2026-11-19 fix330/ui-fixes；本批简报
 * 明确要求夹具/契约覆盖，AGENTS 新增测试同意口径以简报为据）。
 * 运行：node src/features/category/overviewSections.contract.test.ts
 * 覆盖：contentSectionVisible 真值表（唯一隐藏组合＝已尝试∧非加载
 * ∧无错误∧条目 0）＋生产接线文本断言（Category 三类分区都经谓词/
 * 回报判定、SourcePosts 已结空态回报口存在）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contentSectionVisible } from "./overviewSections.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* ── 真值表：只有「已结且空」隐藏 ── */
{
  const v = contentSectionVisible;
  assert.equal(v({ attempted: true, loading: false, hasError: false, count: 0 }), false, "已尝试∧非加载∧无错误∧0 条：隐藏（唯一隐藏组合）");
  assert.equal(v({ attempted: false, loading: false, hasError: false, count: 0 }), true, "未尝试：保持可见（首屏不闪空）");
  assert.equal(v({ attempted: true, loading: true, hasError: false, count: 0 }), true, "加载中：保持可见");
  assert.equal(v({ attempted: true, loading: false, hasError: true, count: 0 }), true, "出错：保持可见（错误态＋重试入口不被吞）");
  assert.equal(v({ attempted: true, loading: false, hasError: false, count: 3 }), true, "有条目：保持可见");
  assert.equal(v({ attempted: false, loading: true, hasError: true, count: 0 }), true, "复合非隐藏条件：保持可见");
}

/* ── 生产接线：总览三类分区都接判定 ── */
{
  const category = read("./Category.tsx");
  assert.ok(category.includes("contentSectionVisible"), "Category 总览经 contentSectionVisible 判定分区可见性");
  assert.ok(category.includes("errors[c.cate] !== undefined"), "频道区 attempted 取 errors 落痕（loadPreview 起始即写）");
  assert.ok(category.includes("onSettledEmpty"), "吃瓜外部源模式经 SourcePosts 已结空态回报判定");
  assert.ok(category.includes("imageSources.length > 0"), "图片区无已启用源时整区不渲染");
  const sourcePosts = read("../sources/SourcePosts.tsx");
  assert.ok(sourcePosts.includes("onSettledEmpty"), "SourcePosts 提供已结空态回报口（可选 prop，Posts 页不传不受影响）");
}

console.log("overviewSections.contract: all assertions passed");
