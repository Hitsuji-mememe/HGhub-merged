/**
 * 3.3.3 修复批·promo-filter 线契约测试（Muse 2026-11-20；本批任务书
 * 即维护者对新增测试的授权，AGENTS 不变量 11）。
 * 运行：node src/features/sources/fix333-promo-filter.contract.test.ts
 *
 * 覆盖用户 2026-11-20 亲定口径下的卡内推广帖过滤：混在帖子卡里的
 * 官方公告/活动征集/软文帖，列表层单信号无区分力（普查
 * fix333/evidence/adpost-census.md），本批以站方分类学组合信号判：
 * (A) 卡片分类词元命中源声明的公告类分类（params.announcementCats；
 *     真站分类学里该分类只装公告/活动帖）；
 * (B) 分类＝大赛栏目（params.contestCat）∧ 标题为栏目公告框式
 *     （params.contestTitlePrefix 开头）——栏目分类本身也装参赛
 *     内容帖，必须叠框式才判。
 * 硬线：真正的内容帖误杀必须为 0。判定样本（三源各 6 页、495 卡
 * 人工分类）与真站复测数字见 fix333/evidence/promo-filter.md。
 *
 * 本契约钉四点：
 * (1) 51chigua 夹具 6 卡：公告类分类卡与大赛公告框式卡被剔除，
 *     大赛栏目内容卡/近似词元卡（往期活动回顾）/无元信息旧卡保留；
 * (2) meiridasai 夹具 3 卡：主题大赛公告卡被剔除，内容卡保留；
 * (3) 未声明判据的源（feedheiliao）对同一夹具零剔除（零外溢）；
 * (4) cardCategoryTokens 词元切分：逐词元精确、作者/日期 span
 *     （带 itemprop）不入词元。
 * 夹具为真站结构形态构造（域名/标题合成），不访问真实网络。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "./registry.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { createChiguaAdapter } from "./adapters/templates.ts";
import { cardCategoryTokens } from "./adapters/parse.ts";
import type { SourceDef } from "./types.ts";

const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");
const def = (id: string): SourceDef => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};
const ids = (items: { href: string }[]) => items.map((i) => /archives\/(\d+)\//.exec(i.href)?.[1]);

/* ── (4) 分类词元提取（两主题变体形态） ── */
{
  const inner003 = `<div class="post-card-info post-card-info--hot"><span class="post-card-meta">`
    + `<span itemprop="author" itemscope itemtype="http://schema.org/Person">瓜小哥 • </span>`
    + `<span itemprop="datePublished" content="2026-11-19T18:27:00+00:00">2026 年 11 月 19 日 • </span>`
    + `<span>今日吃瓜, 往期活动</span></span></div>`;
  assert.deepEqual(cardCategoryTokens(inner003), ["今日吃瓜", "往期活动"],
    "003 形态（post-card-meta 包裹层）：分类词元只取裸 span 清单，作者/日期不入词元");
  const inner005 = `<div class="post-card-info">`
    + `<span itemprop="author" itemscope itemtype="http://schema.org/Person">赛利亚 • </span>`
    + `<span itemprop="datePublished" content="2026-11-19T18:27:00+00:00">2026 年 11 月 19 日 • </span>`
    + `<span>每日大赛, 主题大赛</span></div>`;
  assert.deepEqual(cardCategoryTokens(inner005), ["每日大赛", "主题大赛"],
    "005 形态（无包裹层、分类 span 直挂 post-card-info）：词元同样可提取（只认包裹层时此断言红——真站复测实证）");
  assert.deepEqual(cardCategoryTokens(`<div class="post-card">无元信息</div>`), [],
    "无 post-card-info 时返回空集（不判）");
}

/* ── (1)(2)(3) 生产适配器＋注册表真参数跑夹具 ── */
{
  const page003 = fx("chigua-list-promo.html");
  const page005 = fx("chigua-list-promo-mrds.html");
  setFetchPage(async (url: string) => (url.includes("mrds") || url.includes("meiridasai") ? page005 : page003));

  const ad003 = createChiguaAdapter(def("51chigua"));
  assert.ok(ad003);
  const list003 = await ad003.list(1, 60);
  assert.deepEqual(ids(list003.items), ["900003", "900004", "900005", "900006"],
    "51chigua：公告类分类卡（900001）与大赛公告框式卡（900002）须被剔除；"
    + "大赛栏目内容卡（900003）/近似词元卡（900005）/旧卡（900006）须保留（旧码 6 条全出、此断言红）");

  const ad005 = createChiguaAdapter(def("meiridasai"));
  assert.ok(ad005);
  const list005 = await ad005.list(1, 60);
  assert.deepEqual(ids(list005.items), ["800002", "800003"],
    "meiridasai：主题大赛公告卡（800001）须被剔除，内容卡保留（旧码 3 条全出、此断言红）");

  const ad004 = createChiguaAdapter(def("feedheiliao"));
  assert.ok(ad004);
  const list004 = await ad004.list(1, 60);
  assert.deepEqual(ids(list004.items), ["900001", "900002", "900003", "900004", "900005", "900006"],
    "feedheiliao 未声明判据：同一夹具零剔除（过滤不外溢到未声明源）");
}

console.log("fix333-promo-filter contract: OK");
