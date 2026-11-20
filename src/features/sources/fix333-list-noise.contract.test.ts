/**
 * 3.3.3 修复批·list-noise 线契约测试（Muse 2026-11-20；本批任务书
 * 即维护者对新增测试的授权，AGENTS 不变量 11）。
 * 运行：node src/features/sources/fix333-list-noise.contract.test.ts
 *
 * 覆盖用户裁定「列表层非帖锚点稳杀」（普查证据
 * fix333/evidence/adpost-census.md，9 页真实样本）：整页锚点扫描把
 * 页眉导航下拉（003 每页 2 条恒居清单首）与页脚站务/招募组（004
 * 每页 12 条、占 p1 的 44%）误收为帖子条目。定版杀法＝列表解析层
 * 只认卡片容器内锚点（注册表 cardContainer 按主题声明：article /
 * video-item），页面层广告卡三标记（ad-item 类、rel="sponsored"、
 * ssp-placement＋template 假卡）显式排除、不再靠 href 模式偶然挡住。
 *
 * 本契约钉四点：
 * (1) 容器外锚点（导航/页脚）不进条目；容器内正常卡全数保留、
 *     顺序与标题/封面不変（与整页扫描的保留集逐字一致）；
 * (2) 广告标记各有一道显式防线：ad-item 容器整块排除、卡内
 *     sponsored 锚点单独排除、ssp 模板内 pgx-card 仿卡按标记排除
 *     （模板内的真卡克隆走回填＋去重，不重复计入也不误杀）；
 * (3) 封面-only 真帖卡（卡内无标题区、标题落裸数字 id 兜底）保留
 *     ——detail 抽查证实其为真帖（真标题＋正文/图片量级正常），
 *     杀之即丢真内容，不在本线清扫范围（证据报告残余项）；
 * (4) cardContainer 只声明在吃瓜三源上；未声明源与「页面无容器」
 *     的回落口径不变（整页扫描旧行为）。
 * 夹具为真站结构形态构造（域名/标题合成），不访问真实网络；
 * 真实页新旧逐条 diff 证据在 fix333/evidence/list-noise/。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "./registry.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { findAnchors, findCardAnchors } from "./adapters/parse.ts";
import { createChiguaAdapter } from "./adapters/templates.ts";
import type { SourceDef } from "./types.ts";

const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");
const def = (id: string): SourceDef => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};
const listHrefs = async (id: string, html: string): Promise<{ href: string; title: string; cover: string }[]> => {
  setFetchPage(async () => html);
  const res = await createChiguaAdapter(def(id)).list(1, 60);
  return res.items.map((it) => ({ href: it.href, title: it.title, cover: it.cover }));
};

/* ── (0) 注册表口径：cardContainer 只声明在吃瓜三源、形态按主题 ── */
{
  const params = (id: string) => (def(id).adapter.params ?? {}) as Record<string, unknown>;
  assert.equal(params("51chigua").cardContainer, "article", "source-003 主题容器=article");
  assert.equal(params("feedheiliao").cardContainer, "video-item", "source-004 主题容器=video-item");
  assert.equal(params("meiridasai").cardContainer, "article", "source-005 主题容器=article");
  assert.equal(params("gelbooru").cardContainer, undefined, "未普查源不许声明容器限定（适配 fix335/g-sources：原例 pornpics 已退役、改挂 danbooru；fix338：danbooru 已摘除、改挂 yandere；fix339：yandere 已摘除、改挂 gelbooru）");
}

/* ── (1)+(2)+(3) article 主题：导航/页脚/sponsored 全灭，正常卡与
 *      封面-only 真帖卡保留 ── */
{
  const html = fx("chigua-list-nav-footer.html");
  const items = await listHrefs("51chigua", html);
  const hrefs = items.map((it) => it.href);
  assert.ok(hrefs.every((h) => h.includes("/archives/101/") || h.includes("/archives/102/") || h.includes("/archives/103/")),
    `条目只许是三张真卡，实际：${hrefs.join(",")}`);
  assert.equal(items.length, 3, "正常卡 2＋封面-only 卡 1");
  assert.ok(!hrefs.some((h) => h.includes("/archives/901/") || h.includes("/archives/902/")), "页眉导航锚点必须被容器判据杀掉（旧码恒居清单第 1/2 位）");
  assert.ok(!hrefs.some((h) => h.includes("/archives/905/")), "页脚站务锚点必须被杀掉");
  assert.ok(!hrefs.some((h) => h.includes("/archives/904/")), "卡内 rel=sponsored 锚点必须被显式排除（不许靠容器判据顺带）");
  const byId = (id: string) => items.find((it) => it.href.includes(`/archives/${id}/`));
  assert.equal(byId("101")?.title, "正常帖甲");
  assert.ok(byId("101")?.cover.endsWith("101.jpg"), "正常卡封面保持锚点内载体口径");
  assert.equal(byId("102")?.title, "正常帖乙");
  assert.equal(byId("103")?.title, "103", "封面-only 真帖卡保留（裸数字 id 标题是其既有形态，杀之丢真内容）");
  /* 解析层直证：ad-item 容器内的锚点不出现在卡片锚点集里 */
  const cardAnchors = findCardAnchors(html, "article");
  assert.ok(!cardAnchors.some((a) => a.href.includes("ad.fixture.invalid")), "ad-item 广告卡必须整块排除");
}

/* ── (1)+(2) video-item 主题：页脚组全灭；ssp 模板的真卡克隆不
 *      重复计入、pgx 仿卡（同形 href、无渲染副本）被标记排除 ── */
{
  const html = fx("heiliao-list-footer-ssp.html");
  const items = await listHrefs("feedheiliao", html);
  const hrefs = items.map((it) => it.href);
  assert.equal(items.length, 2, `只许两张真卡，实际：${hrefs.join(",")}`);
  assert.ok(hrefs.some((h) => h.includes("/archives/201/")) && hrefs.some((h) => h.includes("/archives/202/")), "正常卡保留");
  assert.ok(!hrefs.some((h) => h.includes("/archives/801/") || h.includes("/archives/802/") || h.includes("/archives/803/")), "页脚站务/招募组必须全灭（旧码每页 12 条）");
  assert.ok(!hrefs.some((h) => h.includes("/archives/996/")), "template 内 pgx-card 仿卡（href 与条目模式同形）必须被 pgx 标记显式排除");
  assert.ok(!hrefs.some((h) => h.includes("ad.fixture.invalid")), "pgx 广告锚不进条目");
  assert.equal(items.filter((it) => it.href.includes("/archives/201/")).length, 1, "模板里的真卡克隆不许重复计入");
  assert.equal(items[0].title, "正常帖甲");
  assert.ok(items[0].cover.endsWith("201.jpg"));
  /* 真站夹具（real-heiliao-home.html）：渲染副本被摘录裁掉、真卡只剩
   * ssp 模板克隆时，回填遍必须保住它（f2b 契约同口径、两边不许打架） */
  const real = await listHrefs("feedheiliao", fx("real-heiliao-home.html"));
  assert.ok(real.length >= 2, `真站首页形态须出 ≥2 条（实得 ${real.length}）`);
}

/* ── (4) 回落口径：声明源的页面无卡片容器时回落整页扫描（旧行为），
 *      不把形态漂移误报成空列表 ── */
{
  const bare = `<html><body><div class="plain-list"><a href="/archives/301/">裸列表帖</a></div></body></html>`;
  const items = await listHrefs("51chigua", bare);
  assert.equal(items.length, 1, "无容器页面回落整页扫描、条目不丢");
  assert.equal(items[0].title, "裸列表帖");
  /* 未声明源：findAnchors 整页口径逐字不变（对照基线行为） */
  const all = findAnchors(fx("chigua-list-nav-footer.html"));
  assert.ok(all.some((a) => a.href.includes("/archives/901/")), "整页扫描函数本身不设限，限定只发生在声明源的列表解析层");
}

console.log("fix333-list-noise contract: all assertions passed");
