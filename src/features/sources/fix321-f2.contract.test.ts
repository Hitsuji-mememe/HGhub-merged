/**
 * 3.2.1 修复 F2 线契约测试（Muse 2026-11-19 fix321-F2；本批任务书
 * 即维护者对新增测试的授权，AGENTS 不变量 11）：
 * 运行：node src/features/sources/fix321-f2.contract.test.ts
 * 覆盖：(a) 频道-源映射 sourcesForChannel（按注册表 category/
 * capabilities 字段判定，不按源名）；(b) 浏览面只列已启用源
 * （Category 文本断言：不再渲染未启用源块）；(c) 五个 probe 源以
 * 真站结构夹具（adapters/fixtures/real-*.html，2026-11-19 本机
 * curl 抓取摘录、全文本机出口证据在 evidence/f2/）逐个验解析：
 * 肉视频/Hanime/PornPics 列表真出数据，SWAG/RedGifs 解析为空
 * 必须抛 SourceParseEmptyError（显式失败）而非假成功空列表。
 * 不访问真实网络：经 setFetchPage 注入夹具。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry, sourcesForChannel } from "./registry.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { createHlsSiteAdapter, SourceParseEmptyError } from "./adapters/templates.ts";

const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const def = (id: string) => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};

/* ── (a) 频道-源映射：短剧频道只列有分集能力（capabilities.
 * episodes）的 video 源；无映射的 XVideos/Hanime/SWAG 等不进
 * 短剧切源列表；「视频」频道（original）仍列全部 video 源。 ── */
{
  const drama = sourcesForChannel("ai-duanju", getBuiltinRegistry());
  for (const s of drama) {
    assert.equal(s.category, "video", "短剧频道映射只含 video 分类源");
    assert.equal(s.capabilities.episodes, true, `短剧频道源 ${s.id} 必须有分集能力（真实品类映射）`);
    assert.equal(s.enabled, true, "频道列表只列已启用源");
  }
  for (const id of ["xvideos", "hanime-tv", "swag", "rouvideo", "pornhub", "91video", "redgifs", "fc2"]) {
    assert.ok(!drama.some((s) => s.id === id), `${id} 无短剧品类映射、不进短剧频道切源列表`);
  }
  const original = sourcesForChannel("original", getBuiltinRegistry());
  for (const id of ["xvideos", "hanime-tv", "swag", "rouvideo"]) {
    assert.ok(original.some((s) => s.id === id), `${id} 仍在「视频」频道切源列表（其他频道不受影响）`);
  }
  const category = read("../category/Category.tsx");
  assert.ok(category.includes("sourceOptionsForChannel(cate)"), "ChannelPage 切源片按频道映射取源（非全量 video 源）");
  assert.ok(category.includes("sourcesForChannel(cate"), "ChannelPage 源查找按频道映射（陈旧选择不跨频道生效）");
}

/* ── (b) 浏览面只显示已启用源：分类总览不再渲染未启用源块；
 * 未启用源只在管理/诊断面（registryDiag 全量明细）可见。 ── */
{
  const category = read("../category/Category.tsx");
  assert.ok(!category.includes("未启用"), "Category 浏览面不渲染「未启用」源条目");
  assert.ok(!category.includes("!s.enabled"), "Category 浏览面无未启用源过滤渲染块");
  const diag = read("./registryDiag.ts");
  assert.ok(diag.includes("sourceHealthDetailLinesInApp"), "管理/诊断明细面仍保留全量源（含未启用）");
}

/* ── (c) 肉视频：真站 /home 卡片锚点 /v/<id>（根路径为年龄门） ── */
{
  setFetchPage(async () => fx("real-rouvideo-home.html"));
  const a = createHlsSiteAdapter(def("rouvideo"));
  const list = await a.list(1, 20);
  assert.ok(list.items.length >= 2, `肉视频真站结构解析出条目（实得 ${list.items.length}）`);
  assert.ok(list.items[0].href.includes("/v/"), "肉视频条目 href 为真站 /v/<id> 形态");
  assert.ok(list.items[0].title.length > 4, "肉视频条目标题非空");
  assert.ok(list.items[0].cover.startsWith("http"), "肉视频条目封面为绝对地址");
}

/* ── (c) Hanime.tv：真站首页锚点 /videos/hentai/<slug> 带 title ── */
{
  setFetchPage(async () => fx("real-hanime-home.html"));
  const a = createHlsSiteAdapter(def("hanime-tv"));
  const list = await a.list(1, 20);
  assert.ok(list.items.length >= 2, `Hanime 真站结构解析出条目（实得 ${list.items.length}）`);
  assert.ok(list.items[0].href.includes("/videos/hentai/"), "Hanime 条目 href 形态正确");
  assert.ok(list.items[0].title.length > 4, "Hanime 条目标题非空");
}

/* ── (c) PornPics：真站 /recent/ 图集 tile（单引号属性、
 * /galleries/<slug>-<id>/、img alt 为空靠 slug 还原标题） ── */
{
  setFetchPage(async () => fx("real-pornpics-recent.html"));
  const a = createHlsSiteAdapter(def("pornpics"));
  const list = await a.list(1, 20);
  assert.ok(list.items.length >= 2, `PornPics 真站结构解析出图集（实得 ${list.items.length}）`);
  assert.ok(list.items[0].href.includes("/galleries/"), "PornPics 条目 href 为 /galleries/ 形态");
  assert.ok(list.items[0].title.length > 4, "PornPics 标题由 slug 还原、非空");
  assert.ok(list.items[0].cover.includes("cdni.pornpics.com"), "PornPics 封面取 tile img");
}

/* ── (c) SWAG / RedGifs：真站无 SSR 条目 → 解析为空必须显式
 * 失败（SourceParseEmptyError），不许返回假成功空列表。 ── */
for (const [id, fixture] of [["swag", "real-swag-home.html"], ["redgifs", "real-redgifs-home.html"]] as const) {
  setFetchPage(async () => fx(fixture));
  const a = createHlsSiteAdapter(def(id));
  let caught: unknown = null;
  try { await a.list(1, 20); } catch (e) { caught = e; }
  assert.ok(caught instanceof SourceParseEmptyError, `${id} 解析为空抛 SourceParseEmptyError（显式失败态）`);
  assert.match((caught as Error).message, /解析失败/, `${id} 失败信息明示解析失败`);
}

/* ── (c) 空态语义接线：SourceBrowse/SourceGallery 的真空文案与
 * 失败态分离（失败走 err 通道、真空不再写「已取数但列表为空」
 * 冒充成功口径由解析层抛错保证）。 ── */
{
  for (const rel of ["./SourceBrowse.tsx", "./SourceGallery.tsx"]) {
    const src = read(rel);
    assert.ok(!src.includes("适配器已取数，但列表为空"), `${rel} 删除假成功空页文案`);
    assert.ok(src.includes("列表确为空"), `${rel} 真空文案与解析失败分离`);
  }
}

console.log("fix321-f2.contract: all assertions passed");
