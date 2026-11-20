/**
 * 3.3.5 修复批·b-purify 线契约测试（Muse 2026-11-20；本批任务书
 * 即维护者对新增测试的授权，AGENTS 不变量 11）。
 * 运行：node src/features/sources/fix335-b-purify.contract.test.ts
 *
 * 覆盖两件：
 * (1) stripTags 根治（parse.ts）：剥标签前整棵剔除 script/style/
 *     noscript/template 元素内容。旧码只删标签、四类元素内容压平
 *     成文本存活——004 列表卡内封面脚本 loadBannerDirect 在卡标
 *     题回退链（titleAttr→headingText→imgAlt→stripTags）落空时整
 *     段漏成标题并端上详情页头栏（用户真机实报；审计
 *     fix335/audit-004-leaks.md 第一节）。旧红证据：夹具
 *     chigua-list-banner-script.html 删 h2 变体经生产 list() 的
 *     标题逐字＝脚本字面（fix335/evidence/b-purify.md 存档）。
 * (2) 三源站务验杀按源校准（registry params.staffVerify）：
 *     feedheiliao 现行 {890,3} 不动（fix333-promo-004 契约钉）；
 *     51chigua {100000,26} 与 meiridasai {100000,18} 为本批实拉
 *     量测校准——两源站务帖字数与内容重叠（字数阈值置 100000 不
 *     承重），分离面＝episodes=0 ∧ 正文图数（003 站务图 3–23 vs
 *     内容 ≥30；004 公告图 15–16 vs 内容 ≥21；量测 n=14/22，
 *     证据 fix335/evidence/b-purify.md）。审计预估（003 图≤6、
 *     004 {≈900,≈6}）被实测证伪：003 截图招募卡本人 274838 为
 *     3558 字/图 23，004 网址公告 47559 为 1335 字/图 15——按预
 *     估参数两帖都杀不掉，校准后按判据撤下，本契约以其实测三
 *     元组钉死。内容反例（两源内容分布实测极值）必须全 clean；
 *     003 的 283335（游戏推广，2074 字/图 30/eps1）与 283328
 *     （求瓜合集，2892 字/图 31/eps0）详情信号与内容同形、按构
 *     造 clean——详情层与内容不可分，钉死现状待主线裁定，不许
 *     靠收紧判据硬杀（会先伤内容反例）。
 * 夹具为仓库既有真实形态夹具＋合成三元组，不访问真实网络；真实
 * 样本全链实跑（corpus 详情经生产 detail()＋classify）在
 * fix335/scratch-b 量测存档、非 CI 契约面。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTags } from "./adapters/parse.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { createChiguaAdapter } from "./adapters/templates.ts";
import { getBuiltinRegistry } from "./registry.ts";
import { classifyStaffPost, staffVerifyConfig } from "./promoVerify.ts";
import type { SourceDef } from "./types.ts";

const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");
const def = (id: string): SourceDef => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};
const cfgOf = (id: string) => {
  const cfg = staffVerifyConfig(def(id));
  assert.ok(cfg, `${id} declares staffVerify`);
  return cfg;
};
/** 合成详情：正文 n 字符、eps 个流、imgs 张正文图（量法口径同 promo-004 契约）。 */
const detailOf = (chars: number, eps: number, imgs: number): { contentHtml?: string; episodes: unknown[] } => ({
  contentHtml: `<div class="editormd-preview"><p>${"x".repeat(chars)}</p>${'<img src="i">'.repeat(imgs)}</div>`,
  episodes: Array.from({ length: eps }, (_, i) => ({ label: `ep${i}`, externalId: "e" })),
});

/* ── (1a) stripTags：四类元素内容整棵剔除、正常文本逐字保留 ── */
{
  const probe = `<div>前文 <script>var x='SCRIPTLIT';</script> 中段 <style>.a{content:'STYLELIT'}</style> 后段 <noscript>NOSCRIPTLIT</noscript> 尾 <template><span>TEMPLATELIT</span></template> 终</div>`;
  assert.equal(stripTags(probe), "前文 中段 后段 尾 终", "script/style/noscript/template 内容不压平成文本");
  assert.equal(stripTags(`<p>甲</p><script src="x.js"></script><p>乙</p>`), "甲 乙", "空脚本元素不留痕");
  assert.equal(stripTags(`<p>甲</p><script>UNCLOSEDLIT`), "甲", "未闭合脚本开标签吞到串尾、不漏内容");
  assert.equal(stripTags(`<h2 class="t">普通标题 &amp; 副题</h2><p>第二行</p>`), "普通标题 & 副题 第二行",
    "正常标题/实体解码逐字不变（无脚本族元素时与旧行为同）");
}

/* ── (1b) stripTags：生产标题链——删 h2 变体标题回落 slug、不再是脚本字面 ── */
{
  const html = fx("chigua-list-banner-script.html");
  const noH2 = html.replace(/<h2[\s\S]*?<\/h2>/g, "");
  const ad = createChiguaAdapter(def("meiridasai"));
  setFetchPage(async () => noH2);
  const res = await ad.list(1, 60);
  assert.ok(res.items.length >= 3, "夹具卡数 ≥3");
  for (const it of res.items) {
    assert.ok(!/loadBannerDirect|querySelector/.test(it.title), `标题不含脚本字面：${it.title.slice(0, 30)}`);
    assert.match(it.title, /^\d+$/, `标题落空回落 slug（数字 id）：${it.title}`);
  }
  /* 原夹具（h2 在场）标题逐字不变：修复不扰正常路径 */
  setFetchPage(async () => html);
  const res2 = await ad.list(1, 60);
  assert.equal(res2.items[0]?.title, "合成帖甲", "h2 正常卡标题逐字不变");
}

/* ── (2a) 51chigua 验杀：实测三元组——招募/站务 staff、内容与同形 borderline clean ── */
{
  const cfg = cfgOf("51chigua");
  assert.deepEqual(cfg, { maxBodyChars: 100000, maxBodyImages: 26 }, "003 参数＝校准值（字数不承重/图 26）");
  /* 站务/招募实测（corpus＋实拉量测）：pin1/pin2/截图招募卡 274838 */
  assert.equal(classifyStaffPost(detailOf(2432, 0, 4), cfg), "staff", "003 pin1 招募帖（2432/0/4）判 staff");
  assert.equal(classifyStaffPost(detailOf(2132, 0, 3), cfg), "staff", "003 pin2 招募帖（2132/0/3）判 staff");
  assert.equal(classifyStaffPost(detailOf(3558, 0, 23), cfg), "staff", "003 截图招募卡 274838（3558/0/23）判 staff——审计预估图≤6 杀不掉它、校准图≤26 才撤下");
  /* 内容实测极值：字数两端、图数下限、eps 恒 1 */
  assert.equal(classifyStaffPost(detailOf(2209, 1, 40), cfg), "clean", "003 内容（2209/1/40）存活");
  assert.equal(classifyStaffPost(detailOf(1941, 1, 30), cfg), "clean", "003 内容图数下限（1941/1/30）存活");
  assert.equal(classifyStaffPost(detailOf(2323, 1, 44), cfg), "clean", "003 内容（2323/1/44）存活");
  /* 内容同形 borderline：详情信号与内容不可分、按构造存活（钉死现状） */
  assert.equal(classifyStaffPost(detailOf(2074, 1, 30), cfg), "clean", "003 游戏推广卡 283335（2074/1/30）与内容同形、存活");
  assert.equal(classifyStaffPost(detailOf(2892, 0, 31), cfg), "clean", "003 求瓜合集 283328（2892/0/31）图数在内容带、存活");
  /* 图数分界：26 staff / 27 clean（eps=0 前提下） */
  assert.equal(classifyStaffPost(detailOf(5000, 0, 26), cfg), "staff", "003 图数边界 26 → staff");
  assert.equal(classifyStaffPost(detailOf(5000, 0, 27), cfg), "clean", "003 图数边界 27 → clean");
}

/* ── (2b) meiridasai 验杀：实测三元组——置顶公告三帖 staff、内容 clean ── */
{
  const cfg = cfgOf("meiridasai");
  assert.deepEqual(cfg, { maxBodyChars: 100000, maxBodyImages: 18 }, "004 参数＝校准值（字数不承重/图 18）");
  /* 公告实测：网址说明型 47559/招募 193721/合作计划 161308 */
  assert.equal(classifyStaffPost(detailOf(1335, 0, 15), cfg), "staff", "004 网址公告 47559（1335/0/15）判 staff——审计预估字≤900 与图≤6 都杀不掉、校准后撤下");
  assert.equal(classifyStaffPost(detailOf(3566, 0, 16), cfg), "staff", "004 招募帖 193721（3566/0/16）判 staff");
  assert.equal(classifyStaffPost(detailOf(1637, 0, 15), cfg), "staff", "004 合作计划 161308（1637/0/15）判 staff");
  /* 内容实测极值：字数两端、图数下限 21、eps 恒 1 */
  assert.equal(classifyStaffPost(detailOf(1000, 1, 27), cfg), "clean", "004 内容字数下限（1000/1/27）存活");
  assert.equal(classifyStaffPost(detailOf(1398, 1, 21), cfg), "clean", "004 内容图数下限（1398/1/21）存活");
  assert.equal(classifyStaffPost(detailOf(1206, 1, 42), cfg), "clean", "004 内容（1206/1/42）存活");
  /* 图数分界：18 staff / 19 clean（eps=0 前提下） */
  assert.equal(classifyStaffPost(detailOf(3000, 0, 18), cfg), "staff", "004 图数边界 18 → staff");
  assert.equal(classifyStaffPost(detailOf(3000, 0, 19), cfg), "clean", "004 图数边界 19 → clean");
  /* 字数不承重钉死：超长正文不因字数出档（只 eps∧图数判） */
  assert.equal(classifyStaffPost(detailOf(99999, 0, 10), cfg), "staff", "004 字数阈值 100000 不承重：99999 字仍按 eps∧图数判 staff");
}

console.log("fix335-b-purify contract: all assertions passed");
