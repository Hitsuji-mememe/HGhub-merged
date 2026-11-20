/**
 * 3.3.3 残余清剿·M1 线契约测试（Muse 2026-11-20；本批任务书即
 * 维护者对新增测试的授权，AGENTS 不变量 11）。
 * 运行：node src/features/sources/fix333-m1-title-fallback.contract.test.ts
 *
 * 覆盖空壳卡标题兜底（titleFallback.ts）：source-003 列表存在封
 * 面-only 卡（卡内无标题载体），parseAnchorList 标题链落
 * titleFromHref 兜底、对 /archives/<纯数字 id>/ 型 href 产出裸
 * 数字 id 充标题。list-noise 普查实证 4 例（003 样本 p1×2、
 * p2×2），detail() 抽查证实全是真帖（标题长 40/4/27、正文最长
 * 3557 字、图最多 123 张，证据 fix333/evidence/list-noise.md §4
 * 与 fix333/evidence/m1-title-fallback.md）——不许杀、要补真标题。
 *
 * 本契约钉五点：
 * (1) 识别 isBareIdTitle：标题为纯数字 ∧ 恰等于自身 href 末段
 *     id 才触发；正常标题、数字标题但不等于自身 id、slug 还原
 *     标题一律不触发（正常卡零请求零变化的依据）。
 * (2) 作用域 titleFallbackScope：含源 id＋兜底版本＋适配器模
 *     板，任一变化即换域。
 * (3) 标题缓存：落盘后重绑存储（模拟重启）仍可读；旧版本作用
 *     域在新标题落盘时被清掉（自动失效，先写新再清旧）。
 * (4) 补题会话：并发 ≤3；在飞去重；只抓裸 id 卡（正常卡不
 *     抓）；抓取失败不落缓存不回放（保留裸 id、下次挂载再
 *     试）；detail 标题为空不落缓存；detail 标题与裸 id 相同
 *     照样落缓存（免重复抓）；已落盘标题经 enqueue 直接回
 *     放、不再抓 detail（每帖只补一次、缓存命中零重复抓取）。
 * (5) SourcePosts 接线文本断言（hook 真接入、与验杀叠加）。
 * 夹具为合成形态，不访问真实网络。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "./registry.ts";
import {
  TITLE_FALLBACK_VERSION,
  bindTitleFallbackStorage,
  createTitleFallbackSession,
  getTitleFallbacks,
  isBareIdTitle,
  recordTitleFallback,
  titleFallbackScope,
  type TitleFallbackStorageLike,
} from "./titleFallback.ts";
import type { SourceDef, SourceDetail, SourceItem } from "./types.ts";

const def = (id: string): SourceDef => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};
const item = (externalId: string, title: string, href = externalId): SourceItem => ({
  sourceId: "51chigua", externalId, title, cover: "", href, tags: [],
});
const bareItem = (digits: string): SourceItem =>
  item(`https://51cg1.com/archives/${digits}/`, digits);
const detailWithTitle = (title: string): SourceDetail => ({
  sourceId: "51chigua", externalId: "", title, cover: "", href: "", tags: [], images: [], episodes: [],
});
const flush = async (rounds = 60) => {
  /* 会话内假详情带 5ms 定时器，须按真实时间等待其触发与回落。 */
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 2));
};

/* ── (1) 裸 id 标题识别 ── */
{
  assert.equal(isBareIdTitle(bareItem("274838")), true,
    "标题为纯数字 ∧ 等于 href 末段 id → 兜底签名命中");
  assert.equal(isBareIdTitle(item("https://51cg1.com/archives/274838.html", "274838")), true,
    "末段带扩展名时剥扩展名后相等 → 命中");
  assert.equal(isBareIdTitle(item("https://51cg1.com/archives/274838/", "274838", "")), true,
    "href 为空时以 externalId 为准 → 命中");
  assert.equal(isBareIdTitle(item("https://51cg1.com/archives/274838/", "某条正常标题")), false,
    "正常标题不触发");
  assert.equal(isBareIdTitle(item("https://51cg1.com/archives/274838/", "12345")), false,
    "标题是数字但不等于自身 id（题文不符）不触发");
  assert.equal(isBareIdTitle(item("https://51cg1.com/archives/some-post-274838/", "some post")), false,
    "slug 还原标题（titleFromHref 文本产出）不触发");
  assert.equal(isBareIdTitle(item("https://51cg1.com/archives/274838/", "")), false,
    "空标题不触发（解析层已丢弃、不入列）");
}

/* ── (2) 作用域：源＋版本＋适配器模板 ── */
{
  assert.match(titleFallbackScope(def("51chigua")),
    new RegExp(`^51chigua/title-fallback/v${TITLE_FALLBACK_VERSION}/chigua$`),
    "作用域串含源 id＋兜底版本＋适配器模板（chigua）");
  const other = { ...def("51chigua"), adapter: { template: "wp-rest" } };
  assert.notEqual(titleFallbackScope(other), titleFallbackScope(def("51chigua")),
    "适配器模板变化即换域（旧缓存自动失效）");
}

/* ── (3) 标题缓存：落盘/重绑/版本失效 ── */
{
  const backing = new Map<string, string>();
  const storage: TitleFallbackStorageLike = {
    getItem: (k) => backing.get(k) ?? null,
    setItem: (k, v) => { backing.set(k, v); },
  };
  bindTitleFallbackStorage(storage);
  const scope = titleFallbackScope(def("51chigua"));
  recordTitleFallback(scope, "https://51cg1.com/archives/274838/", "真标题甲");
  bindTitleFallbackStorage(null);
  bindTitleFallbackStorage(storage); /* 重绑同一存储 = 模拟进程重启后读盘 */
  assert.deepEqual(getTitleFallbacks(scope), { "https://51cg1.com/archives/274838/": "真标题甲" },
    "标题落盘后重启可读（每帖只补一次的依据）");
  const staleScope = `51chigua/title-fallback/v${TITLE_FALLBACK_VERSION - 1}/chigua`;
  recordTitleFallback(staleScope, "https://51cg1.com/archives/1/", "旧标题");
  recordTitleFallback(scope, "https://51cg1.com/archives/280535/", "真标题乙"); /* 新落盘触发旧域清理 */
  assert.deepEqual(getTitleFallbacks(staleScope), {}, "旧兜底版本作用域在落盘时被清掉（自动失效）");
  assert.equal(getTitleFallbacks(scope)["https://51cg1.com/archives/280535/"], "真标题乙",
    "现行作用域标题不受清旧影响");
  bindTitleFallbackStorage(null);
}

/* ── (4) 补题会话：并发/去重/只抓裸 id/失败与空标题不落缓存/缓存回放 ── */
{
  const backing = new Map<string, string>();
  bindTitleFallbackStorage({
    getItem: (k) => backing.get(k) ?? null,
    setItem: (k, v) => { backing.set(k, v); },
  });
  const d = def("51chigua");
  const scope = titleFallbackScope(d);
  const TITLES: Record<string, string> = {
    "111111": "真标题一", "222222": "真标题二", "333333": "333333", /* detail 标题与裸 id 相同 */
  };
  let active = 0;
  let maxActive = 0;
  const fetchCalls: string[] = [];
  const played: [string, string][] = [];
  const session = createTitleFallbackSession({
    def: d,
    fetchDetail: async (id) => {
      fetchCalls.push(id);
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      const digits = /archives\/(\d+)\//.exec(id)?.[1] ?? "";
      if (digits === "999999") throw new Error("network down");
      if (digits === "888888") return detailWithTitle(""); /* 标题提取不到 */
      return detailWithTitle(TITLES[digits] ?? "真标题");
    },
    onTitle: (id, t) => { played.push([id, t]); },
  });
  const batch = [
    bareItem("111111"), bareItem("222222"), bareItem("333333"),
    bareItem("999999"), bareItem("888888"),
    item("https://51cg1.com/archives/555555/", "正常标题卡"), /* 非裸 id：不许抓 */
    item("https://51cg1.com/archives/666666/", "777777"), /* 数字标题但非自身 id：不许抓 */
  ];
  session.enqueue(batch);
  session.enqueue(batch); /* 重复入队：在飞/已处理去重，不许重复抓 */
  await flush();
  assert.ok(maxActive <= 3, `并发峰值 ${maxActive} ≤ 3`);
  assert.equal(new Set(fetchCalls).size, fetchCalls.length, "同一帖在会话内只抓一次");
  assert.deepEqual(fetchCalls.map((u) => /archives\/(\d+)\//.exec(u)?.[1]).sort(),
    ["111111", "222222", "333333", "888888", "999999"],
    "只抓裸 id 标题卡（正常卡与题文不符卡零请求）");
  assert.deepEqual(played.map(([id, t]) => [/archives\/(\d+)\//.exec(id)?.[1], t]).sort(),
    [["111111", "真标题一"], ["222222", "真标题二"], ["333333", "333333"]],
    "补到的真标题回放给列表面回填（含与裸 id 相同者）");
  const cached = getTitleFallbacks(scope);
  assert.equal(cached["https://51cg1.com/archives/111111/"], "真标题一", "真标题落盘");
  assert.equal(cached["https://51cg1.com/archives/333333/"], "333333",
    "detail 标题与裸 id 相同照样落缓存（免每次挂载重复抓）");
  assert.ok(!("https://51cg1.com/archives/999999/" in cached), "抓取失败不落缓存（保留裸 id、下次挂载再试）");
  assert.ok(!("https://51cg1.com/archives/888888/" in cached), "detail 标题为空不落缓存（提取不到不等于已补）");
  assert.ok(!played.some(([id]) => id.includes("999999") || id.includes("888888")),
    "失败/空标题不产生回放（显示保留裸 id、不撤卡）");
  session.dispose();

  /* 新会话（模拟下次挂载）：已落盘标题直接回放、零抓取（缓存命
   * 中零重复抓取的计数断言）；上次失败的帖子则重新抓。 */
  const fetch2: string[] = [];
  const played2: [string, string][] = [];
  const session2 = createTitleFallbackSession({
    def: d,
    fetchDetail: async (id) => {
      fetch2.push(id);
      return detailWithTitle("失败后补上的标题");
    },
    onTitle: (id, t) => { played2.push([id, t]); },
  });
  session2.enqueue([bareItem("111111"), bareItem("999999")]);
  await flush();
  assert.deepEqual(fetch2.map((u) => /archives\/(\d+)\//.exec(u)?.[1]), ["999999"],
    "已落盘的 111111 零重复抓取；上次失败的 999999 重新抓");
  assert.ok(played2.some(([id, t]) => id.includes("111111") && t === "真标题一"),
    "缓存真标题经 enqueue 直接回放（挂载即回填、无闪烁窗口）");
  session2.dispose();
  bindTitleFallbackStorage(null);
}

/* ── (5) SourcePosts 接线文本断言 ── */
{
  const src = readFileSync(new URL("./SourcePosts.tsx", import.meta.url), "utf8");
  assert.ok(src.includes("useTitleFallback(def, items, fetchDetailForVerify)"),
    "SourcePosts 接入标题兜底 hook（与验杀共用 detail 注入接缝）");
  assert.ok(src.includes("titleOverrides"), "SourcePosts 呈现按回填后的标题叠加 visibleItems");
  assert.ok(src.includes("useStaffPromoVerify(def, items, fetchDetailForVerify)"),
    "验杀接线未被本线改动（两 hook 共存）");
}

console.log("fix333-m1-title-fallback contract: OK");
