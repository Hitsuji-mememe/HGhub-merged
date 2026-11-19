/**
 * fix322/play 契约测试（Muse 2026-11-19）：手势按起点归属隔离——
 * 播放器手势面内的横拖 seek 全程不得触发全局链（pop/切页签），
 * 与 AlbumViewer 缩略图条同类病、同口径。用户真机实报（3.2.1）：
 * 播放器里往右划调进度，整个画面被划出去（栈页 pop）。
 * 用例 = 真实手势序列（起点祖先链＋上下文 → 起点分类 → 位移 →
 * 链裁决）：seek 三例为缺陷回归（旧实现分别裁出 pop/切页签/pop）；
 * 其余为既有链行为防回归（普通栈页 pop、fs/输入框/横滚区/左缘
 * 让行、详情信息区左划下一条、页签链序、方向锁定）。
 * 运行：node src/app/gestureChain.contract.test.ts
 */
import assert from "node:assert/strict";
import { classifyChainStart, decideChainSwipe, type ChainAncestor, type ChainStartContext } from "./gestureChain.ts";

function swipe(ancestors: ChainAncestor[], ctx: Partial<ChainStartContext> & { clientX?: number }, dx: number, dy: number) {
  const full: ChainStartContext = {
    fs: false, loginOpen: false, tab: "home", stackDepth: 0, topKind: undefined, clientX: 200, ...ctx,
  };
  const start = classifyChainStart(ancestors, full);
  return decideChainSwipe(start, dx, dy, { tab: full.tab, topKind: full.topKind });
}

const PLAIN: ChainAncestor[] = [{ tagName: "DIV" }, { tagName: "SECTION" }, { tagName: "MAIN" }];
const STAGE: ChainAncestor[] = [{ tagName: "DIV", playerSurface: true }, { tagName: "SECTION" }, { tagName: "MAIN" }];
const SCRUB: ChainAncestor[] = [{ tagName: "DIV", feedScrubZone: true }, { tagName: "DIV", feedInfoZone: true }, { tagName: "SECTION" }];
const INFO: ChainAncestor[] = [{ tagName: "DIV", feedInfoZone: true }, { tagName: "SECTION" }, { tagName: "MAIN" }];

/* ── 缺陷回归：seek 横拖不得被外层链抢走 ── */
assert.equal(
  swipe(STAGE, { tab: "home", stackDepth: 1, topKind: "feed" }, 120, 10), null,
  "栈内 Feed 页播放面起手右划 seek（dx=120）：链不得 pop（旧实现把整个画面划出去）",
);
assert.equal(
  swipe(STAGE, { tab: "home", stackDepth: 0 }, -120, 8), null,
  "首页播放面起手左划 seek（dx=-120）：链不得切去搜索页签",
);
assert.equal(
  swipe(SCRUB, { tab: "home", stackDepth: 1, topKind: "settings" }, 120, 6), null,
  "栈页进度条区起手右划拖进度（dx=120）：链不得 pop",
);

/* ── 既有链行为防回归 ── */
assert.deepEqual(
  swipe(PLAIN, { tab: "home", stackDepth: 1, topKind: "settings" }, 120, 10), { type: "pop" },
  "普通栈页面起手右划：仍 pop 返回",
);
assert.equal(swipe(PLAIN, { tab: "home", stackDepth: 1, topKind: "settings", fs: true }, 120, 10), null, "全屏起手：链不触发");
assert.equal(
  swipe([{ tagName: "INPUT" }, { tagName: "DIV" }], { tab: "search", stackDepth: 0 }, -120, 5), null,
  "输入框起手：链不触发",
);
assert.equal(
  swipe([{ tagName: "DIV", hScrollable: true }, { tagName: "DIV" }], { tab: "search", stackDepth: 0 }, -120, 5), null,
  "横滚区起手：链不触发",
);
assert.equal(
  swipe(PLAIN, { tab: "home", stackDepth: 1, topKind: "feed", clientX: 10 }, 120, 5), null,
  "栈内 Feed 左缘起手：归 Feed 边缘返回，链不 pop（既有让行）",
);
assert.deepEqual(
  swipe(INFO, { tab: "home", stackDepth: 1, topKind: "feed" }, -120, 10), { type: "detailNext" },
  "栈顶 Feed 详情信息区左划：仍切下一条",
);
assert.equal(
  swipe(PLAIN, { tab: "home", stackDepth: 1, topKind: "settings" }, 100, 80), null,
  "纵向占优位移（dx=100,dy=80 未过 1.8 方向锁）：链不触发",
);
assert.deepEqual(swipe(PLAIN, { tab: "search", stackDepth: 0 }, 120, 5), { type: "tab", tab: "home" }, "搜索页右划回首页（链序不变）");
assert.deepEqual(swipe(PLAIN, { tab: "profile", stackDepth: 0 }, -120, 5), { type: "pushSettings" }, "我的页左划进设置（链序不变）");
assert.equal(swipe(PLAIN, { tab: "home", stackDepth: 0 }, 120, 5), null, "链首（播放器页）右划无动作");

console.log("gestureChain.contract: all assertions passed");
