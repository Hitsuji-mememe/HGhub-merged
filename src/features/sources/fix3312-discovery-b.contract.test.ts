/**
 * fix3312/discovery-b 契约（Muse 2026-11-21，任务书即维护者对新
 * 增测试的授权，不变量 11）。运行：
 *   node src/features/sources/fix3312-discovery-b.contract.test.ts
 *
 * 背景（用户 2026-11-21 15:46/15:50 改令＋调查
 * fix3312/evidence/discovery-design-research.md 选项 B）：3.3.11
 * 图片面砍分类/标签行被真机实报「聚合源不可用」，发现设计整体
 * 改走选项 B——①恢复三行；②兴趣直达（disc 按源落盘、最近用过
 * 置顶、标签行内搜索中文反查）；③有限集汉化（只改显示层）。
 * 本契约按三段钉：一段一段追加，段内断言先在旧码上证伪再转绿。
 *
 * (A) 恢复三行·接线（源码文本断言，照 fix335 (D) 先例）：
 *     DiscoveryBar 无 noTaxonomyRows 门控、SourceGallery 不经
 *     stripDiscTaxonomy 派生 disc、types 无 stripDiscTaxonomy
 *     导出。证伪形态：3.3.11 码上三处皆在、断言全红。
 * (B) 恢复三行·适配器级实证（setFetchPage 录制 URL，照
 *     fix3311 (B) 先例）：图片源（006，wp-rest）的 disc
 *     category/tag 实际拼进列表请求——分类/标签筛选对图片面
 *     重新生效（与 (A) 的读取点直读合起来构成端到端恢复）。
 * (C) 登记与去重不回退：discoverySpecFor 对图片 WP 源仍登记
 *     categories＋tagFilter（回滚靠摘门控、不靠剥登记）；fix336
 *     同名标签去重 dedupeTagOptions 保留且 DiscoveryBar 仍消费。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "./registry.ts";
import { discoverySpecFor } from "./adapters/templateCapabilities.ts";
import { createWpRestAdapter } from "./adapters/templates.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { dedupeTagOptions, pinRecentOptions } from "./discoveryOptions.ts";
import {
  applyDiscSelection, loadDiscStateMap, normalizeDiscStateMap, saveDiscStateMap,
  DISC_RECENT_LIMIT, DISC_STATE_KEY, type DiscStateMap,
} from "./discState.ts";
import {
  tagOptionMatchesQuery, taxonKeysForChineseQuery, taxonZhLabel, taxonDisplayLabel,
  SHARED_TAXON_LABELS_ZH, SOURCE_TAXON_LABELS_ZH,
} from "./taxonLabels.ts";
import type { SourceDef } from "./types.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const def = (id: string): SourceDef => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};

/* ── (A) 门控与失效化已撤（3.3.11 码上全红） ── */
{
  const bar = read("./DiscoveryBar.tsx");
  assert.ok(!bar.includes("noTaxonomyRows"), "DiscoveryBar 无图片面门控 prop（fix3311 门控已撤）");
  assert.ok(bar.includes("discoverySpecFor(def)"), "DiscoveryBar 有效 spec 即登记 spec、无门控改写");

  const gallery = read("./SourceGallery.tsx");
  assert.ok(!gallery.includes("stripDiscTaxonomy"), "SourceGallery 不经 stripDiscTaxonomy 派生 disc（读取点直读）");
  assert.ok(!gallery.includes("noTaxonomyRows"), "SourceGallery 不传图片面门控");

  const types = read("./types.ts");
  assert.ok(!types.includes("stripDiscTaxonomy"), "types 无 stripDiscTaxonomy（失效化函数已删）");
}

/* ── (B) 图片源 disc 的 category/tag 实际过滤列表 ── */
{
  const posts = JSON.stringify([
    { id: 11, link: "https://xiuren.example/p11", title: { rendered: "帖十一" }, excerpt: { rendered: "" }, categories: [23], tags: [7] },
  ]);
  const urls: string[] = [];
  setFetchPage(async (url) => {
    urls.push(url);
    return url.includes("/categories?")
      ? JSON.stringify([{ id: 23, name: "Hot Girl", count: 50 }])
      : url.includes("/tags?")
        ? JSON.stringify([{ id: 7, name: "长腿", count: 99 }])
        : posts;
  });
  const a = createWpRestAdapter(def("xiuren"));
  await a.list(1, 20, { category: "23", tag: "7", sort: "date-asc" });
  const lastPostsUrl = urls.filter((u) => u.includes("/posts?")).pop();
  assert.equal(lastPostsUrl,
    "https://xiuren.biz/wp-json/wp/v2/posts?page=1&per_page=20&orderby=date&order=asc&categories=23&tags=7",
    "图片源 disc 的 category/tag 拼进列表请求（筛选恢复生效）");
}

/* ── (C) 登记表与 fix336 去重不回退 ── */
{
  for (const id of ["xiuren", "everia", "hentaiplay", "hanime-tv"]) {
    const spec = discoverySpecFor(def(id));
    assert.equal(spec.categories?.source, "taxonomy", `${id} 登记仍含 taxonomy 分类`);
    assert.equal(spec.tagFilter, true, `${id} 登记仍含 tagFilter`);
  }
  assert.equal(typeof dedupeTagOptions, "function", "fix336 dedupeTagOptions 保留");
  assert.ok(read("./DiscoveryBar.tsx").includes("dedupeTagOptions"), "DiscoveryBar 仍消费同名去重");
  const deduped = dedupeTagOptions(
    [{ value: "23", label: "XiuRen" }],
    [{ value: "7", label: "xiuren" }, { value: "9", label: "长腿" }],
    undefined,
  );
  assert.deepEqual(deduped.map((o) => o.value), ["9"], "同名标签仍被剔除（fix336 行为不变）");
}

/* ── (D) disc 落盘：往返、归一化、最近用过规则 ── */
{
  /* localStorage 替身（node 无此全局；只测本模块的读写口径）。 */
  const backing = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => { backing.set(k, v); },
    removeItem: (k: string) => { backing.delete(k); },
  };

  let m: DiscStateMap = {};
  m = applyDiscSelection(m, "xiuren", { category: "23", tag: "7" });
  assert.deepEqual(m.xiuren.disc, { category: "23", tag: "7" }, "disc 按源落记录");
  assert.deepEqual(m.xiuren.recentCategories, ["23"], "首次选分类进最近用过");
  assert.deepEqual(m.xiuren.recentTags, ["7"], "首次选标签进最近用过");

  m = applyDiscSelection(m, "xiuren", { category: "45", tag: "7" });
  assert.deepEqual(m.xiuren.recentCategories, ["45", "23"], "换分类新值置顶、旧值留位");
  assert.deepEqual(m.xiuren.recentTags, ["7"], "标签同值重选不重排");

  m = applyDiscSelection(m, "xiuren", { tag: "7" });
  assert.deepEqual(m.xiuren.disc, { tag: "7" }, "disc 整体替换（清分类即删字段）");
  assert.deepEqual(m.xiuren.recentCategories, ["45", "23"], "清除分类不动最近用过（清除不是用过）");

  m = applyDiscSelection(m, "everia", { sort: "date-asc" });
  assert.deepEqual(m.everia.recentCategories, [], "只改排序不产生最近分类");

  saveDiscStateMap(m);
  assert.ok(backing.has(DISC_STATE_KEY), "状态写入自有键");
  assert.deepEqual(loadDiscStateMap(), m, "存→读往返逐字一致（重开直达上次筛选的数据基础）");

  const dirty = normalizeDiscStateMap({
    good: { disc: { category: "1", sort: 5, tag: "" }, recentCategories: ["1", "1", 2, "3"], recentTags: "x" },
    bad: 42, worse: { disc: null },
  });
  assert.deepEqual(dirty.good.disc, { category: "1" }, "归一化：非字符串/空串字段丢弃");
  assert.deepEqual(dirty.good.recentCategories, ["1", "3"], "归一化：最近列表去重去坏值");
  assert.deepEqual(dirty.good.recentTags, [], "归一化：非数组最近列表归零");
  assert.ok(!("bad" in dirty), "归一化：非对象条目整条丢弃");
  assert.deepEqual(normalizeDiscStateMap("nope"), {}, "归一化：顶层非对象归零");
  assert.deepEqual(normalizeDiscStateMap(null), {}, "归一化：空值归零");

  let cap: DiscStateMap = {};
  for (let i = 0; i < DISC_RECENT_LIMIT + 3; i++) {
    cap = applyDiscSelection(cap, "s", { tag: `t${i}` });
  }
  assert.equal(cap.s.recentTags.length, DISC_RECENT_LIMIT, "最近用过有上限、不无界生长");
  assert.equal(cap.s.recentTags[0], `t${DISC_RECENT_LIMIT + 2}`, "上限内保留最近的");
}

/* ── (E) 最近用过置顶：recents 序即优先级、其余稳定 ── */
{
  const opts = [
    { value: "a", label: "A" }, { value: "b", label: "B" },
    { value: "c", label: "C" }, { value: "d", label: "D" },
  ];
  assert.deepEqual(pinRecentOptions(opts, ["c", "a"]).map((o) => o.value),
    ["c", "a", "b", "d"], "命中项按 recents 序置顶、其余相对序不变");
  assert.deepEqual(pinRecentOptions(opts, []).map((o) => o.value),
    ["a", "b", "c", "d"], "无 recents 时原序");
  assert.deepEqual(pinRecentOptions(opts, ["x"]).map((o) => o.value),
    ["a", "b", "c", "d"], "recents 含已下架值时不报错不乱序");
}

/* ── (F) 标签搜索中文反查：输中文命中英文原标签 ── */
{
  const maid = { value: "56", label: "Maid" };
  const keys = taxonKeysForChineseQuery("女仆");
  assert.ok(keys.has("maid"), "反查索引：女仆 → maid");
  assert.equal(tagOptionMatchesQuery(maid, "女仆", keys), true, "输中文命中英文标签（WP 数字 id 形态）");
  assert.equal(tagOptionMatchesQuery({ value: "maid", label: "maid" }, "女仆", keys), true, "输中文命中英文标签（002 原名 value 形态）");
  assert.equal(tagOptionMatchesQuery(maid, "mai", taxonKeysForChineseQuery("mai")), true, "英文子串仍按原名匹配");
  assert.equal(tagOptionMatchesQuery(maid, "护士", taxonKeysForChineseQuery("护士")), false, "不相关中文不误命中");
  assert.equal(tagOptionMatchesQuery({ value: "999", label: "Some Proper Name" }, "女仆", keys), false, "未收录专名不被中文误命中");
  assert.equal(tagOptionMatchesQuery(maid, "", new Set()), true, "空查询恒匹配（不滤）");
}

/* ── (G) 兴趣直达接线（源码文本断言） ── */
{
  for (const f of ["./SourceBrowse.tsx", "./SourceGallery.tsx", "./SourcePosts.tsx"]) {
    assert.ok(read(f).includes("useDiscState"), `${f} 接 disc 落盘 hook`);
    assert.ok(read(f).includes("recentCategories"), `${f} 向 DiscoveryBar 下传最近分类`);
  }
  const posts = read("./SourcePosts.tsx");
  assert.ok(posts.includes("compact ? EMPTY_LIST_DISCOVERY"), "SourcePosts compact 形态钉死空 disc（存量筛选不漏进总览预览）");
  const bar = read("./DiscoveryBar.tsx");
  assert.ok(bar.includes("pinRecentOptions"), "DiscoveryBar 消费最近用过置顶");
  assert.ok(bar.includes("taxonKeysForChineseQuery"), "DiscoveryBar 标签搜索接中文反查");
  assert.ok(bar.includes("tagOptionMatchesQuery"), "DiscoveryBar 标签搜索接匹配函数");
}

/* ── (H) 汉化映射：覆盖、回落、只改显示不改 value ── */
{
  /* 覆盖钉（名单＝2026-11-21 生产同路实拉原表）：002 题材词全集
   * 61 中 57 可译、020 全集 35 中 32 可译——下列即全集逐字。 */
  const tags002 = ["blow job", "hd", "big boobs", "creampie", "censored", "plot", "school girl",
    "uncensored", "facial", "anal", "harem", "bondage", "boob job", "virgin", "toys", "fantasy",
    "gangbang", "hand job", "public sex", "yuri", "glasses", "monster", "x-ray", "incest",
    "teacher", "vanilla", "ahegao", "tentacle", "masturbation", "cosplay", "maid", "ntr",
    "swimsuit", "milf", "watersports", "comedy", "orgy", "threesome", "horror", "ugly bastard",
    "dark skin", "pov", "mind break", "lactation", "mind control", "nurse", "futanari",
    "foot job", "inflation", "rimjob", "scat", "pregnant", "tsundere", "nekomimi", "softcore", "trap", "yaoi"];
  for (const n of tags002) assert.ok(taxonZhLabel("hanime-tv", n) !== null, `002 题材词有译名：${n}`);
  const tags020 = ["Blowjob", "Creampie", "Vanilla", "Rape", "Boobjob", "Gangbang", "Uncensored",
    "Harem", "Virgin", "Exhibition", "Series", "Anal", "Exclusive", "Sex Toy", "Motion Anime",
    "Bondage", "Masturbation", "Incest", "Cheating", "Yuri", "School", "Fantasy", "Swimsuit",
    "X-Ray", "Maid", "Monster", "Tentacle", "Demon", "Footjob", "Futanari", "Nurse", "Preview"];
  for (const n of tags020) assert.ok(taxonZhLabel("hentaigasm", n) !== null, `020 题材词有译名：${n}`);

  /* 不收录钉：歧义/专名/同形——回落原名是设计、不是缺漏。 */
  for (const [id, n] of [
    ["hanime-tv", "filmed"], ["hanime-tv", "bdsm"], ["hanime-tv", "2000-year-old dragon girl"],
    ["hentaigasm", "Season"], ["pixibb", "Almost Real"], ["pixibb", "Hot Games"],
    ["nudecosplay", "Waifu AI"], ["xiuren", "Hot Girl"], ["xiuren", "DJAWA"],
    ["hentaiplay", "Pink Pineapple"], ["cosplaytele", "Genshin Impact"], ["everia", "Graphis"],
  ] as const) {
    assert.equal(taxonZhLabel(id, n), null, `不译（歧义/专名）：${id}/${n}`);
  }

  /* 逐源分类：源表优先、共享兜底。 */
  assert.equal(taxonZhLabel("everia", "Japan"), "日本", "018 地域桶走源表");
  assert.equal(taxonZhLabel("everia", "Cosplay"), "角色扮演", "018 分类共享词走共享表");
  assert.equal(taxonZhLabel("hentaiplay", "RAW"), "生肉", "021 属性桶走源表");
  assert.equal(taxonZhLabel("xiuren", "XiuRen"), "秀人网", "006 厂牌中文名走源表");
  assert.equal(taxonZhLabel("xiuren", "Maid"), "女仆", "006 标签题材词走共享表");
  assert.equal(taxonZhLabel("pixibb", "Uncategorized"), "未分类", "通用桶走共享表");

  /* 显示层：有译名显中文、无译名原样；option 本体不被改写。 */
  const opt = { value: "56", label: "Maid" };
  assert.equal(taxonDisplayLabel("xiuren", opt), "女仆", "显示文案＝译名");
  assert.deepEqual(opt, { value: "56", label: "Maid" }, "option 不被改写（value 即筛选真值）");
  assert.equal(taxonDisplayLabel("xiuren", { value: "999", label: "Unknown Tag" }), "Unknown Tag", "未收录回落原名");

  /* 表规模（防整表误删）：共享＋源表合计与逐源条数下限。 */
  const sharedCount = Object.keys(SHARED_TAXON_LABELS_ZH).length;
  assert.ok(sharedCount >= 170, `共享题材词表规模（实际 ${sharedCount}）`);
  for (const [id, min] of [["everia", 4], ["hentaiplay", 6], ["pixibb", 3], ["nudecosplay", 3], ["xiuren", 14]] as const) {
    assert.ok(Object.keys(SOURCE_TAXON_LABELS_ZH[id]).length >= min, `${id} 源表条数`);
  }

  /* 接线：分类/标签 chip 经 taxonPill 显示、排序行不经汉化。 */
  const bar = read("./DiscoveryBar.tsx");
  assert.ok(bar.includes("taxonPill"), "DiscoveryBar 分类/标签 chip 经汉化显示");
  assert.ok(bar.includes("pill(`sort:${o.value}`, o.label"), "排序行保持登记原名、不经汉化改写");
}

console.log("fix3312-discovery-b contract (segments 1-3): PASS");
