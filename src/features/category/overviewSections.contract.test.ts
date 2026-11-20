/**
 * 分类总览空区隐藏契约（Muse 2026-11-19 fix330/ui-fixes；本批简报
 * 明确要求夹具/契约覆盖，AGENTS 新增测试同意口径以简报为据）。
 * 运行：node src/features/category/overviewSections.contract.test.ts
 * 覆盖：contentSectionVisible 真值表（唯一隐藏组合＝已尝试∧非加载
 * ∧无错误∧条目 0）＋生产接线文本断言（Category 三类分区都经谓词/
 * 回报判定、SourcePosts 已结空态回报口存在）。
 *
 * 断言适配（2026-11-20 fix335/e-category 总览索引化，设计 §6）：
 * 频道/吃瓜预览区随索引化整面退场，谓词按设计保留给源行区——
 * 行区名单为注册表同步派生（无异步加载态），以已结算口径
 * （attempted∧非加载∧无错误）＋派生计数消费同一谓词。原频道区
 * attempted 落痕与吃瓜已结空态回报两条 Category 侧接线断言随面
 * 退场，改钉行区消费形态；真值表与 SourcePosts 回报口断言不变。
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

/* ── 生产接线：源行区经谓词判定（频道行原生恒在、不套谓词） ── */
{
  const category = read("./Category.tsx");
  assert.ok(category.includes("contentSectionVisible"), "Category 总览经 contentSectionVisible 判定分区可见性");
  assert.ok(category.includes("count: imageRowSources.length"), "图片行区以派生名单计数消费谓词（无已启用源整区不渲染）");
  assert.ok(category.includes("count: videoRowSources.length"), "视频行区以派生名单计数消费谓词（同口径）");
  const sourcePosts = read("../sources/SourcePosts.tsx");
  assert.ok(sourcePosts.includes("onSettledEmpty"), "SourcePosts 提供已结空态回报口（可选 prop，Posts 页不传不受影响）");
}

console.log("overviewSections.contract: all assertions passed");
