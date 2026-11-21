/**
 * 3.2.1 修复 F2c 线契约测试（Muse 2026-11-19 fix321-F2c；本批任务书
 * 即维护者对新增测试的授权，AGENTS 不变量 11）：
 * 运行：node src/features/sources/fix321-f2c.contract.test.ts
 * 背景（验收 D 缺口 G1）：远程清单对 API 型源的 baseUrls 只写
 * 站点根域，applyManifest 整组替换后 active 注册表丢失其 API
 * origin；旧 main.tsx 白名单只从 active baseUrls 拼 → 清单落定
 * （生产常态）下 Rust source_fetch 拒该源全部 API 取页。F2b 契约
 * 注入 fetchPage 绕过 Rust 白名单，故施工侧未见。原承接源
 * swag/redgifs 已随模板簇退役（fix3311），本文件改由 iwara
 * （iwara-api，baseUrls 含根域＋API origin、声明 origin 另含两
 * 文件 host）承接同一 G1 形态，断言强度不变。
 * 不变量：「已启用源在清单落定与 builtin 落定两种状态下，适配器能
 * 请求的每个 origin 都在生产取页白名单内。」
 * 修法口径：取页 origin 声明跟模板走（adapters/fetchOrigins.ts，
 * 模板实现写死的常数、清单无权改），生产白名单由 allowlist.ts 的
 * sourceFetchAllowlistOrigins 一处派生＝已启用且可取页源的
 * （active baseUrls ∪ 模板声明 origin）；main.tsx 只消费派生结果。
 * 不访问真实网络：经 setFetchPage 注入夹具捕获真实请求 origin。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "./registry.ts";
import { applyManifest, validateManifest } from "./manifest.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { createIwaraAdapter } from "./adapters/templates.ts";
import { TEMPLATE_FETCH_ORIGINS, templateFetchOrigins } from "./adapters/fetchOrigins.ts";
import { sourceFetchAllowlistOrigins } from "./allowlist.ts";
import type { SourceDef } from "./types.ts";

const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const originOf = (u: string): string => { try { return new URL(u).origin; } catch { return ""; } };

/* 可取页口径（测试侧独立复算，不复用生产派生函数的内部判定）：
 * enabled ∧ 非 blocked ∧ 模板经 fetchPage 取页（native/preview/none 不经 source_fetch）。 */
const FETCH_TEMPLATES = ["chigua", "wp-rest", "hls-site", "danbooru-api", "hanime-api", "iwara-api"];
const fetchable = (s: SourceDef): boolean =>
  s.enabled && s.maturity !== "blocked" && FETCH_TEMPLATES.includes(s.adapter.template);

async function requestedOrigins(def: SourceDef, stub: (url: string) => string): Promise<Set<string>> {
  const origins = new Set<string>();
  setFetchPage(async (url) => { origins.add(new URL(url).origin); return stub(url); });
  const a = createIwaraAdapter(def);
  try { await a.list(1, 5); } catch { /* 取数成败不论，只看请求打到哪些 origin */ }
  return origins;
}
const stubs: Record<string, (url: string) => string> = {
  iwara: () => fx("iwara-list.json"),
};

/* 全量枚举断言：给定注册表与白名单，每个可取页源的 baseUrls origin
 * 与模板声明 origin 都必须在白名单内（适配器能请求的 origin 全集
 * ⊆ 白名单的静态全集侧；iwara 的动态请求侧另经适配器实跑）。 */
function assertFetchableCovered(sources: SourceDef[], allow: Set<string>, label: string): void {
  for (const s of sources) {
    if (!fetchable(s)) continue;
    for (const u of s.baseUrls) {
      assert.ok(allow.has(originOf(u)), `[${label}] ${s.id} baseUrl origin ${originOf(u)} 必须在生产白名单内`);
    }
    for (const o of templateFetchOrigins(s.adapter.template)) {
      assert.ok(allow.has(o), `[${label}] ${s.id} 模板声明 origin ${o} 必须在生产白名单内（清单覆盖 baseUrls 不得削掉模板声明）`);
    }
  }
}

const builtin = getBuiltinRegistry();

/* 断言适配（fix3311/registry-cleanup）：原夹具 def 两源（swag/
 * redgifs）随模板簇退役同删，测试注册表只用 builtin——G1 形态
 * 由 builtin 的 iwara 承接（baseUrls 含根域＋API origin、模板
 * 声明另含两文件 host），证伪形态与断言强度不变。 */
const testRegistry = builtin;

/* ── 声明层：跟模板走的写死常数（代码级事实） ── */
assert.deepEqual(TEMPLATE_FETCH_ORIGINS["iwara-api"], ["https://api.iwara.tv", "https://files.iwara.tv", "https://filesq.iwara.tv"], "iwara-api 模板声明取页 origin = api＋files＋filesq");
assert.deepEqual(templateFetchOrigins("hls-site"), [], "hls-site 无 baseUrls 之外的取页 origin");
assert.deepEqual(templateFetchOrigins("none"), [], "none 模板无取页 origin");

/* ── A. builtin 落定：白名单枚举覆盖 + iwara 适配器实跑请求 ⊆ 白名单 ── */
{
  const allow = new Set(sourceFetchAllowlistOrigins(testRegistry));
  assert.ok(allow.has("https://api.iwara.tv"), "[builtin] api.iwara.tv 在白名单内");
  assert.ok(allow.has("https://files.iwara.tv"), "[builtin] files.iwara.tv 在白名单内");
  assertFetchableCovered(testRegistry, allow, "builtin");
  for (const id of ["iwara"] as const) {
    const d = testRegistry.find((s) => s.id === id)!;
    const origins = await requestedOrigins(d, stubs[id]);
    assert.ok(origins.size > 0, `[builtin] ${id} 适配器实跑有请求（非真空断言）`);
    for (const o of origins) assert.ok(allow.has(o), `[builtin] ${id} 适配器请求 origin ${o} 必须在生产白名单内`);
  }
}

/* ── B. 清单落定（v1 形态：iwara baseUrls 仅根域）：active
 * 注册表先证已丢失 API origin（前置事实），白名单仍须含 API 与
 * 文件 origin、且适配器实跑请求全集 ⊆ 白名单（G1 证伪主断言）。
 * 注：清单形态下适配器 apiBase 回落写死常数 IWARA_API_ORIGIN，
 * 实跑仍打 api.iwara.tv——正是模板声明必须入名单的动态证据。 ── */
{
  const m = validateManifest({
    manifestVersion: 1, minAppVersion: "3.0.0",
    sources: [
      { id: "iwara", enabled: true, baseUrls: ["https://www.iwara.tv"] },
    ],
  });
  assert.ok(m, "v1 形态清单 schema 有效");
  const active = applyManifest(testRegistry, m!);
  const iwaraActive = active.find((s) => s.id === "iwara")!;
  assert.deepEqual(iwaraActive.baseUrls, ["https://www.iwara.tv"], "前置事实：清单覆盖后 iwara baseUrls 只剩根域（API origin 已被顶掉）");
  const allow = new Set(sourceFetchAllowlistOrigins(active));
  assert.ok(allow.has("https://api.iwara.tv"), "[清单v1形态] api.iwara.tv 必须在生产白名单内（模板声明不被清单削掉）");
  assert.ok(allow.has("https://files.iwara.tv"), "[清单v1形态] files.iwara.tv 必须在生产白名单内（模板声明不被清单削掉）");
  assertFetchableCovered(active, allow, "清单v1形态");
  for (const id of ["iwara"] as const) {
    const d = active.find((s) => s.id === id)!;
    const origins = await requestedOrigins(d, stubs[id]);
    const apiOrigin = "https://api.iwara.tv";
    assert.ok(origins.has(apiOrigin), `[清单v1形态] ${id} 适配器实跑确实请求 ${apiOrigin}（非真空断言）`);
    for (const o of origins) assert.ok(allow.has(o), `[清单v1形态] ${id} 适配器请求 origin ${o} 必须在生产白名单内`);
  }
}

/* ── C. 防回归参数化：任一已启用源的 baseUrls 被清单削到只剩首个
 * 根域时，其模板声明 origin 仍必须在白名单内；全源同时削同样成立。 ── */
{
  for (const s of testRegistry) {
    if (!fetchable(s) || templateFetchOrigins(s.adapter.template).length === 0) continue;
    const m = validateManifest({
      manifestVersion: 9, minAppVersion: "3.0.0",
      sources: [{ id: s.id, enabled: true, baseUrls: [s.baseUrls[0]] }],
    });
    assert.ok(m, `参数化清单（${s.id}）schema 有效`);
    const allow = new Set(sourceFetchAllowlistOrigins(applyManifest(testRegistry, m!)));
    for (const o of templateFetchOrigins(s.adapter.template)) {
      assert.ok(allow.has(o), `[参数化·${s.id}] 模板声明 origin ${o} 被清单覆盖削掉时测试必红——现仍须在白名单内`);
    }
  }
  const stripAll = validateManifest({
    manifestVersion: 9, minAppVersion: "3.0.0",
    sources: testRegistry.filter(fetchable).map((s) => ({ id: s.id, enabled: true, baseUrls: [s.baseUrls[0]] })),
  });
  assert.ok(stripAll, "全源削根域清单 schema 有效");
  assertFetchableCovered(applyManifest(testRegistry, stripAll!), new Set(sourceFetchAllowlistOrigins(applyManifest(testRegistry, stripAll!))), "全源削根域");
}

/* ── D. 收紧口径：未启用／blocked 源的 origin 不放行 ── */
{
  const allow = new Set(sourceFetchAllowlistOrigins(builtin));
  /* 契约适配（3.3.0 接通批集成，2026-11-19）：pixibb 已实证启用、
   * hanime1 已写适配器启用、meiridasai（mrds66）/xiuren（xiuren.biz）
   * 已解 blocked——四源 origin 按「已启用∧非 blocked」派生口径入
   * 名单，改验新事实；「未启用/blocked 不放行」由下方合成停用/
   * blocked def 断言接棒，覆盖不降。
   * 断言适配（fix338/registry-cut）：danbooru 已摘除，其 origin 改
   * 验负向——不在册源不派生任何 origin（同批 konachan 同口径）。 */
  assert.ok(allow.has("https://sexy.pixibb.com"), "已启用目录源（pixibb）origin 在白名单内");
  assert.ok(allow.has("https://www.mrds66.com"), "meiridasai 已解 blocked：mrds66 origin 入白名单");
  assert.ok(allow.has("https://xiuren.biz"), "xiuren 已解 blocked：xiuren.biz origin 入白名单");
  assert.ok(!allow.has("https://danbooru.donmai.us"), "danbooru 已摘除：origin 不入白名单（fix338）");
  assert.ok(!allow.has("https://konachan.com"), "konachan 已摘除：origin 不入白名单（fix338）");
  assert.ok(!allow.has("https://hentaihaven.xxx"), "hentaihaven 已摘除：origin 不入白名单（fix338）");
  /* 断言适配（fix339/registry-cut-2）：hanime1/iwara/yandere 已摘除，
   * 其 origin 同口径改验负向（原 hanime1 正向断言随源退役）。
   * 断言适配（fix3310/video-add-2）：hanime1/iwara 试装恢复，正向
   * 断言回滚（含 iwara 模板声明的 files/filesq 取流 origin）；yandere
   * 不恢复、负向不变。
   * 断言适配（fix3311/registry-cleanup）：hanime1 试装判删回、改验
   * 负向；iwara 正向不变。 */
  assert.ok(!allow.has("https://hanime1.me"), "hanime1 已摘除：origin 不入白名单（fix3311）");
  assert.ok(allow.has("https://www.iwara.tv"), "iwara 恢复：origin 入白名单（fix3310）");
  assert.ok(allow.has("https://api.iwara.tv"), "iwara 恢复：API origin 入白名单（fix3310）");
  assert.ok(allow.has("https://files.iwara.tv"), "iwara 恢复：files 取流 origin 经模板声明入白名单（fix3310）");
  assert.ok(allow.has("https://filesq.iwara.tv"), "iwara 恢复：filesq 取流 origin 经模板声明入白名单（fix3310）");
  assert.ok(!allow.has("https://yande.re"), "yandere 已摘除：origin 不入白名单（fix339）");
  /* 清单远程下线 iwara（enabled=false）→ 其根域与 API origin 一并退出白名单 */
  const off = validateManifest({
    manifestVersion: 9, minAppVersion: "3.0.0",
    sources: [{ id: "iwara", enabled: false, baseUrls: ["https://www.iwara.tv"] }],
  });
  const allowOff = new Set(sourceFetchAllowlistOrigins(applyManifest(testRegistry, off!)));
  assert.ok(!allowOff.has("https://api.iwara.tv"), "iwara 被清单下线后 api.iwara.tv 不再放行");
  assert.ok(!allowOff.has("https://www.iwara.tv"), "iwara 被清单下线后 www.iwara.tv 不再放行");
  /* 合成 blocked／停用 def 单独派生 → 空名单 */
  const iwaraDef = testRegistry.find((s) => s.id === "iwara")!;
  assert.deepEqual(sourceFetchAllowlistOrigins([{ ...iwaraDef, maturity: "blocked" }]), [], "blocked def 不派生任何 origin");
  assert.deepEqual(sourceFetchAllowlistOrigins([{ ...iwaraDef, enabled: false }]), [], "停用 def 不派生任何 origin");
}

/* ── E. 接线：main.tsx 只消费派生结果；模板实现与声明共用同一常数 ── */
{
  const main = read("../../main.tsx");
  assert.ok(main.includes("sourceFetchAllowlistOrigins(getActiveRegistry().sources)"), "main.tsx 白名单推送只消费派生函数结果");
  assert.ok(!main.includes("flatMap((s) => s.baseUrls)"), "main.tsx 不再内联只从 baseUrls 拼白名单的旧派生");
  const templates = read("./adapters/templates.ts");
  assert.ok(templates.includes("IWARA_API_ORIGIN"), "Iwara 适配器回落 API 基址与模板声明共用 IWARA_API_ORIGIN 常数");
}

console.log("fix321-f2c.contract: all assertions passed");
