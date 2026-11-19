/**
 * 3.2.1 修复 F2c 线契约测试（Muse 2026-11-19 fix321-F2c；本批任务书
 * 即维护者对新增测试的授权，AGENTS 不变量 11）：
 * 运行：node src/features/sources/fix321-f2c.contract.test.ts
 * 背景（验收 D 缺口 G1）：远程清单对 swag/redgifs 的 baseUrls 只写
 * 站点根域，applyManifest 整组替换后 active 注册表丢失
 * api.swag.live／api.redgifs.com；旧 main.tsx 白名单只从 active
 * baseUrls 拼 → 清单落定（生产常态）下 Rust source_fetch 拒两源全部
 * API 取页。F2b 契约注入 fetchPage 绕过 Rust 白名单，故施工侧未见。
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
import { createRedgifsAdapter, createSwagAdapter } from "./adapters/templates.ts";
import { TEMPLATE_FETCH_ORIGINS, templateFetchOrigins } from "./adapters/fetchOrigins.ts";
import { sourceFetchAllowlistOrigins } from "./allowlist.ts";
import type { SourceDef } from "./types.ts";

const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const originOf = (u: string): string => { try { return new URL(u).origin; } catch { return ""; } };

/* 可取页口径（测试侧独立复算，不复用生产派生函数的内部判定）：
 * enabled ∧ 非 blocked ∧ 模板经 fetchPage 取页（native/preview/none 不经 source_fetch）。 */
const FETCH_TEMPLATES = ["chigua", "wp-rest", "hls-site", "danbooru-api", "swag-api", "redgifs-api"];
const fetchable = (s: SourceDef): boolean =>
  s.enabled && s.maturity !== "blocked" && FETCH_TEMPLATES.includes(s.adapter.template);

async function requestedOrigins(def: SourceDef, stub: (url: string) => string): Promise<Set<string>> {
  const origins = new Set<string>();
  setFetchPage(async (url) => { origins.add(new URL(url).origin); return stub(url); });
  const a = def.adapter.template === "swag-api" ? createSwagAdapter(def) : createRedgifsAdapter(def);
  try { await a.list(1, 5); } catch { /* 取数成败不论，只看请求打到哪些 origin */ }
  return origins;
}
const stubs: Record<string, (url: string) => string> = {
  swag: (url) => (url.includes("/feeds/") ? fx("real-swag-feed.json") : fx("real-swag-message.json")),
  redgifs: (url) => (url.includes("/v2/auth/temporary") ? JSON.stringify({ token: "t" }) : fx("real-redgifs-search.json")),
};

/* 全量枚举断言：给定注册表与白名单，每个可取页源的 baseUrls origin
 * 与模板声明 origin 都必须在白名单内（适配器能请求的 origin 全集
 * ⊆ 白名单的静态全集侧；swag/redgifs 的动态请求侧另经适配器实跑）。 */
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

/* 断言适配（3.2.2 瘦身）：swag/redgifs 已摘除注册表，但 swag-api/
 * redgifs-api 模板与 G1 白名单派生机制留仓在用——两源改用与删除
 * 前注册表功能字段逐字一致的夹具 def 组成测试注册表，G1 证伪形
 * 态与断言强度不变；保留源仍走 builtin 注册表。 */
const FIXTURE_DEFS = [
  {
    id: "swag", displayName: "SWAG", kind: "video", category: "video",
    adapter: { template: "swag-api", params: {} },
    baseUrls: ["https://swag.live", "https://api.swag.live"], enabled: true, order: 25, maturity: "probe",
    capabilities: { search: false, episodes: false, hevc: false, comments: false },
    network: { mode: "probe-required" }, note: "历史注册表条目（3.2.2 瘦身摘除）",
  },
  {
    id: "redgifs", displayName: "RedGifs", kind: "video", category: "video",
    adapter: { template: "redgifs-api", params: {} },
    baseUrls: ["https://www.redgifs.com", "https://api.redgifs.com"], enabled: true, order: 27, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false, comments: false },
    network: { mode: "probe-required" }, note: "历史注册表条目（3.2.2 瘦身摘除）",
  },
] as unknown as SourceDef[];
const testRegistry = [...builtin, ...FIXTURE_DEFS];

/* ── 声明层：跟模板走的写死常数（代码级事实） ── */
assert.deepEqual(TEMPLATE_FETCH_ORIGINS["swag-api"], ["https://api.swag.live"], "swag-api 模板声明取页 origin = api.swag.live");
assert.deepEqual(TEMPLATE_FETCH_ORIGINS["redgifs-api"], ["https://api.redgifs.com"], "redgifs-api 模板声明取页 origin = api.redgifs.com");
assert.deepEqual(templateFetchOrigins("hls-site"), [], "hls-site 无 baseUrls 之外的取页 origin");
assert.deepEqual(templateFetchOrigins("none"), [], "none 模板无取页 origin");

/* ── A. builtin 落定：白名单枚举覆盖 + 两源适配器实跑请求 ⊆ 白名单 ── */
{
  const allow = new Set(sourceFetchAllowlistOrigins(testRegistry));
  assert.ok(allow.has("https://api.swag.live"), "[builtin] api.swag.live 在白名单内");
  assert.ok(allow.has("https://api.redgifs.com"), "[builtin] api.redgifs.com 在白名单内");
  assertFetchableCovered(testRegistry, allow, "builtin");
  for (const id of ["swag", "redgifs"] as const) {
    const d = testRegistry.find((s) => s.id === id)!;
    const origins = await requestedOrigins(d, stubs[id]);
    assert.ok(origins.size > 0, `[builtin] ${id} 适配器实跑有请求（非真空断言）`);
    for (const o of origins) assert.ok(allow.has(o), `[builtin] ${id} 适配器请求 origin ${o} 必须在生产白名单内`);
  }
}

/* ── B. 清单落定（v1 形态：swag/redgifs baseUrls 仅根域）：active
 * 注册表先证已丢失 API origin（前置事实），白名单仍须含两 API
 * origin、且两源适配器实跑请求全集 ⊆ 白名单（G1 证伪主断言）。 ── */
{
  const m = validateManifest({
    manifestVersion: 1, minAppVersion: "3.0.0",
    sources: [
      { id: "swag", enabled: true, baseUrls: ["https://swag.live"] },
      { id: "redgifs", enabled: true, baseUrls: ["https://www.redgifs.com"] },
    ],
  });
  assert.ok(m, "v1 形态清单 schema 有效");
  const active = applyManifest(testRegistry, m!);
  const swagActive = active.find((s) => s.id === "swag")!;
  assert.deepEqual(swagActive.baseUrls, ["https://swag.live"], "前置事实：清单覆盖后 swag baseUrls 只剩根域（API origin 已被顶掉）");
  const allow = new Set(sourceFetchAllowlistOrigins(active));
  assert.ok(allow.has("https://api.swag.live"), "[清单v1形态] api.swag.live 必须在生产白名单内（模板声明不被清单削掉）");
  assert.ok(allow.has("https://api.redgifs.com"), "[清单v1形态] api.redgifs.com 必须在生产白名单内（模板声明不被清单削掉）");
  assertFetchableCovered(active, allow, "清单v1形态");
  for (const id of ["swag", "redgifs"] as const) {
    const d = active.find((s) => s.id === id)!;
    const origins = await requestedOrigins(d, stubs[id]);
    const apiOrigin = id === "swag" ? "https://api.swag.live" : "https://api.redgifs.com";
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
   * hanime1 已写适配器启用、meiridasai（mrds66）/xiuren（xiuren.biz）/
   * danbooru 三源已解 blocked——五源 origin 按「已启用∧非 blocked」
   * 派生口径入名单，改验新事实；「未启用/blocked 不放行」由下方合成
   * 停用/blocked def 断言接棒，覆盖不降。 */
  assert.ok(allow.has("https://sexy.pixibb.com"), "已启用目录源（pixibb）origin 在白名单内");
  assert.ok(allow.has("https://hanime1.me"), "已启用源（hanime1）origin 在白名单内");
  assert.ok(allow.has("https://www.mrds66.com"), "meiridasai 已解 blocked：mrds66 origin 入白名单");
  assert.ok(allow.has("https://xiuren.biz"), "xiuren 已解 blocked：xiuren.biz origin 入白名单");
  assert.ok(allow.has("https://danbooru.donmai.us"), "danbooru 已翻案：origin 入白名单");
  /* 清单远程下线 swag（enabled=false）→ 其根域与 API origin 一并退出白名单 */  const off = validateManifest({
    manifestVersion: 9, minAppVersion: "3.0.0",
    sources: [{ id: "swag", enabled: false, baseUrls: ["https://swag.live"] }],
  });
  const allowOff = new Set(sourceFetchAllowlistOrigins(applyManifest(testRegistry, off!)));
  assert.ok(!allowOff.has("https://api.swag.live"), "swag 被清单下线后 api.swag.live 不再放行");
  assert.ok(!allowOff.has("https://swag.live"), "swag 被清单下线后 swag.live 不再放行");
  /* 合成 blocked／停用 def 单独派生 → 空名单 */
  const redgifs = testRegistry.find((s) => s.id === "redgifs")!;
  assert.deepEqual(sourceFetchAllowlistOrigins([{ ...redgifs, maturity: "blocked" }]), [], "blocked def 不派生任何 origin");
  assert.deepEqual(sourceFetchAllowlistOrigins([{ ...redgifs, enabled: false }]), [], "停用 def 不派生任何 origin");
}

/* ── E. 接线：main.tsx 只消费派生结果；模板实现与声明共用同一常数 ── */
{
  const main = read("../../main.tsx");
  assert.ok(main.includes("sourceFetchAllowlistOrigins(getActiveRegistry().sources)"), "main.tsx 白名单推送只消费派生函数结果");
  assert.ok(!main.includes("flatMap((s) => s.baseUrls)"), "main.tsx 不再内联只从 baseUrls 拼白名单的旧派生");
  const templates = read("./adapters/templates.ts");
  assert.ok(templates.includes("SWAG_API_ORIGIN"), "SWAG 适配器回落 API 基址与模板声明共用 SWAG_API_ORIGIN 常数");
  assert.ok(templates.includes("REDGIFS_API_ORIGIN"), "RedGifs 适配器回落 API 基址与模板声明共用 REDGIFS_API_ORIGIN 常数");
}

console.log("fix321-f2c.contract: all assertions passed");
