/**
 * fix333-M3 契约：守卫与文案小修打包的代码三件。
 * 运行：node src/features/sources/fix333-m3.contract.test.ts
 *
 * ① P3（3.3.2 清扫）：wp-rest/danbooru 对 JSON 响应无形状守卫——[]
 * 静默当真空、非数组抛 TypeError 裸奔。本契约钉：真 [] → 空列表
 * 正常返回（不抛错）；非数组/非 JSON（形状漂移）→ SourceParseEmptyError。
 * ② B1 复验记账：contentImgSrcs 的地标深度扫描可被地标内 script
 * 字符串里的同名闭标签提前截断致空集。本契约钉合成形态：截断时
 * 回落整页、内容图不丢；正常页型限定口径不变（样式图仍排除）。
 * ③ P9（3.3.2 清扫）：模板段事实双口径收口——段事实由
 * adapters/templateSegments.ts 探针派生（工厂实例化按方法存在性），
 * multiSourceSearch 不再持有模板副本集合。本契约钉：逐模板真值表、
 * 与 index.ts 工厂分发的 parity、native-huangguo 例外声明的源码
 * 钉死、注册表 caps.search=true 的源其模板必须真有 search（防静默
 * 出局漂移）。
 * 不访问真实网络（setFetchPage 注入）；夹具为合成形态。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "./registry.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { contentImgSrcs } from "./adapters/parse.ts";
import { createDanbooruAdapter, createWpRestAdapter, SourceParseEmptyError, TEMPLATE_IDS } from "./adapters/templates.ts";
import { templateHasAdapter, templateHasSearch } from "./adapters/templateSegments.ts";
import { missingSearchSegments } from "../search/multiSourceSearch.ts";

const def = (id: string) => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};

/* ── ① P3：wp-rest 空数组真空 / 形状漂移抛解析为空 ── */
{
  const a = createWpRestAdapter(def("xiuren"));
  setFetchPage(async () => "[]");
  const list = await a.list(1, 20);
  assert.deepEqual(list.items, [], "wp-rest [] → 空列表正常返回、不抛错");
  const search = await a.search!("无结果词", 1, 20);
  assert.deepEqual(search.items, [], "wp-rest 搜索 [] → 真空正常返回");
  setFetchPage(async () => JSON.stringify({ posts: [] }));
  await assert.rejects(() => a.list(1, 20), SourceParseEmptyError, "wp-rest 对象包裹（形状漂移）→ 解析为空");
  await assert.rejects(() => a.search!("x", 1, 20), SourceParseEmptyError, "wp-rest 搜索形状漂移 → 解析为空");
  setFetchPage(async () => "<html><body>challenge</body></html>");
  await assert.rejects(() => a.list(1, 20), SourceParseEmptyError, "wp-rest 非 JSON 响应 → 解析为空（非 TypeError 裸奔）");
}

/* ── ① P3：danbooru 同口径 ── */
{
  const a = createDanbooruAdapter(def("danbooru"));
  setFetchPage(async () => "[]");
  const list = await a.list(1, 20);
  assert.deepEqual(list.items, [], "danbooru [] → 空列表正常返回、不抛错");
  const search = await a.search!("nohits", 1, 20);
  assert.deepEqual(search.items, [], "danbooru 搜索 [] → 真空正常返回");
  setFetchPage(async () => JSON.stringify({ error: "shape changed" }));
  await assert.rejects(() => a.list(1, 20), SourceParseEmptyError, "danbooru 非数组响应 → 解析为空");
  await assert.rejects(() => a.search!("x", 1, 20), SourceParseEmptyError, "danbooru 搜索非数组 → 解析为空");
}

/* ── ② B1 守卫：script 字符串同名闭标签截断地标 → 回落整页不丢图 ── */
{
  const html = [
    '<img src="https://img.example.com/style-logo.svg">',
    "<main>",
    '<script>var closer = "</main>";</script>',
    '<img src="https://img.example.com/c1.jpg">',
    '<img src="https://img.example.com/c2.jpg">',
    "</main>",
  ].join("\n");
  const got = contentImgSrcs(html);
  assert.ok(got.includes("https://img.example.com/c1.jpg"), "截断形态：内容图 c1 不丢（旧码返回空集）");
  assert.ok(got.includes("https://img.example.com/c2.jpg"), "截断形态：内容图 c2 不丢");
  /* 正常页型（无脚本截断）：限定口径不变、地标外样式图仍排除。 */
  const clean = [
    '<img src="https://img.example.com/style-logo.svg">',
    "<main>",
    '<img src="https://img.example.com/c1.jpg">',
    '<img src="https://img.example.com/c2.jpg">',
    "</main>",
  ].join("\n");
  assert.deepEqual(contentImgSrcs(clean), ["https://img.example.com/c1.jpg", "https://img.example.com/c2.jpg"], "正常页型：仍只取地标内、样式图排除");
}

/* ── ③ P9：逐模板段事实真值表（探针派生须与工厂现状逐项一致） ── */
const EXPECT: Record<string, { adapter: boolean; search: boolean; missing: string[] }> = {
  "native-huangguo": { adapter: true, search: true, missing: [] },
  chigua: { adapter: true, search: true, missing: [] },
  "wp-rest": { adapter: true, search: true, missing: [] },
  "hls-site": { adapter: true, search: true, missing: [] },
  "danbooru-api": { adapter: true, search: true, missing: [] },
  "swag-api": { adapter: true, search: false, missing: ["search"] },
  "redgifs-api": { adapter: true, search: true, missing: [] },
  "hanime-api": { adapter: true, search: true, missing: [] },
  "iwara-api": { adapter: true, search: true, missing: [] },
  hanime1: { adapter: true, search: true, missing: [] },
  "hentaihaven-api": { adapter: true, search: true, missing: [] },
  "preview-only": { adapter: true, search: false, missing: ["search", "play"] },
  none: { adapter: false, search: false, missing: ["search", "detail", "play"] },
};
{
  const mk = (template: string, capsSearch = true) => ({
    id: "probe", displayName: "probe", kind: "video", category: "video",
    adapter: { template, params: {} }, baseUrls: ["https://example.com"],
    enabled: true, order: 0, maturity: "probe",
    capabilities: { search: capsSearch, episodes: false, hevc: false, comments: false },
    network: { mode: "probe-required" }, note: "",
  }) as Parameters<typeof missingSearchSegments>[0];
  for (const t of [...TEMPLATE_IDS, "unknown-x"]) {
    const exp = EXPECT[t] ?? { adapter: false, search: false, missing: ["search", "detail", "play"] };
    assert.equal(templateHasAdapter(t), exp.adapter, `${t} templateHasAdapter`);
    assert.equal(templateHasSearch(t), exp.search, `${t} templateHasSearch`);
    assert.deepEqual(missingSearchSegments(mk(t)), exp.missing, `${t} missingSearchSegments（caps.search=true）`);
  }
  /* 注册表声明腿仍在：模板有 search 但 caps.search=false → 仍判缺 search。 */
  assert.deepEqual(missingSearchSegments(mk("chigua", false)), ["search"], "caps.search=false 时声明腿照旧生效");
}

/* ── ③ P9：探针与 index.ts 工厂分发 parity（分发有的模板探针必覆盖） ── */
{
  const factorySrc = readFileSync(new URL("./adapters/index.ts", import.meta.url), "utf8");
  const cases = new Set([...factorySrc.matchAll(/case "([^"]+)":/g)].map((m) => m[1]));
  const ids = new Set<string>(TEMPLATE_IDS);
  for (const c of cases) assert.ok(ids.has(c), `分发模板 ${c} 在 TEMPLATE_IDS 内`);
  for (const id of ids) {
    if (id === "none") assert.ok(!cases.has(id), "none 不进工厂分发（返回 null）");
    else assert.ok(cases.has(id), `模板 ${id} 在工厂分发内`);
  }
  /* 搜索层不再持有模板副本集合（双口径的回归防线）。 */
  const ms = readFileSync(new URL("../search/multiSourceSearch.ts", import.meta.url), "utf8");
  assert.ok(!ms.includes("const SEARCH_TEMPLATES"), "multiSourceSearch 不再定义 SEARCH_TEMPLATES 副本集合");
  assert.ok(!ms.includes("const DETAIL_PLAY_TEMPLATES"), "multiSourceSearch 不再定义 DETAIL_PLAY_TEMPLATES 副本集合");
  assert.ok(ms.includes("templateHasSearch"), "multiSourceSearch 消费探针派生");
}

/* ── ③ P9：native-huangguo 例外声明的源码钉死（工厂删 search 即红） ── */
{
  const native = readFileSync(new URL("./adapters/nativeHuangguo.ts", import.meta.url), "utf8");
  assert.ok(native.includes("async search("), "native 工厂对象字面含 search 方法（templateSegments 例外声明的事实锚）");
  assert.ok(native.includes("api.searchPosts"), "native search 走 api.searchPosts");
}

/* ── ③ P9：注册表一致性——声明可搜索的源，其模板必须真有 search ── */
{
  for (const s of getBuiltinRegistry()) {
    if (s.capabilities.search) {
      assert.ok(templateHasSearch(s.adapter.template), `${s.id} 声明 caps.search=true，其模板 ${s.adapter.template} 必须真有 search（否则静默出局）`);
      assert.ok(!missingSearchSegments(s).includes("search"), `${s.id} 不得被结构门判缺 search`);
    }
  }
}

console.log("fix333-m3 contract: all assertions passed");
