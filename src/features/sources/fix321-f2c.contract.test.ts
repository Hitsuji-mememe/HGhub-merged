/**
 * 3.2.1 修复 F2c 线契约测试（Muse 2026-11-19 fix321-F2c；本批任务书
 * 即维护者对新增测试的授权，AGENTS 不变量 11）：
 * 运行：node src/features/sources/fix321-f2c.contract.test.ts
 * 背景（验收 D 缺口 G1）：远程清单对 API 型源的 baseUrls 只写
 * 站点根域，applyManifest 整组替换后 active 注册表丢失其 API
 * origin；旧 main.tsx 白名单只从 active baseUrls 拼 → 清单落定
 * （生产常态）下 Rust source_fetch 拒该源全部 API 取页。F2b 契约
 * 注入 fetchPage 绕过 Rust 白名单，故施工侧未见。
 * 不变量：「已启用源在清单落定与 builtin 落定两种状态下，适配器能
 * 请求的每个 origin 都在生产取页白名单内。」
 * 修法口径：取页 origin 声明跟模板走（adapters/fetchOrigins.ts，
 * 模板实现写死的常数、清单无权改），生产白名单由 allowlist.ts 的
 * sourceFetchAllowlistOrigins 一处派生＝已启用且可取页源的
 * （active baseUrls ∪ 模板声明 origin）；main.tsx 只消费派生结果。
 * 不访问真实网络：经 setFetchPage 注入夹具捕获真实请求 origin。
 *
 * 断言适配（fix3314，2026-11-21）：G1 的动态承接源 iwara（iwara-api
 * 模板声明三 origin）与 hanime-api 已随视频板块整组删除退役——现行
 * 全部模板的声明 origin 均为空集，「声明不被清单削掉」一性在当前
 * 注册表上无活承接面。本文件改口径如下、覆盖不静默降级：
 * ① 声明层改断言「现行每模板声明恰为空集、已删模板无声明残留」；
 * ② 动态实跑改由存活源 51chigua（chigua 模板）承接（请求 origin
 * ⊆ 白名单，真跑非真空）；
 * ③ 清单覆盖节改钉「白名单跟随 active baseUrls」双向事实（覆盖后
 * 被削掉的镜像 origin 退出名单、保留 origin 在名单内）；
 * ④ 参数化节的声明回归循环保留原形——任一未来模板重新声明 origin
 * 时循环自动重新承重（当前全模板声明为空、循环如实空转，stripAll
 * 全量覆盖断言照常承重）；
 * ⑤ iwara 四 origin 改验负向（已删模板/源不派生任何 origin）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "./registry.ts";
import { applyManifest, validateManifest } from "./manifest.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { createChiguaAdapter, TEMPLATE_IDS } from "./adapters/templates.ts";
import { TEMPLATE_FETCH_ORIGINS, templateFetchOrigins } from "./adapters/fetchOrigins.ts";
import { sourceFetchAllowlistOrigins } from "./allowlist.ts";
import type { SourceDef } from "./types.ts";

const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const originOf = (u: string): string => { try { return new URL(u).origin; } catch { return ""; } };

/* 可取页口径（测试侧独立复算，不复用生产派生函数的内部判定）：
 * enabled ∧ 非 blocked ∧ 模板经 fetchPage 取页（native/preview/none 不经 source_fetch）。 */
/* 断言适配（fix3315）：hanime-api 随 hanime-tv 恢复回加；iwara-api 保持删除不回加。 */
const FETCH_TEMPLATES = ["chigua", "wp-rest", "hls-site", "danbooru-api", "hanime-api"];
const fetchable = (s: SourceDef): boolean =>
  s.enabled && s.maturity !== "blocked" && FETCH_TEMPLATES.includes(s.adapter.template);

async function requestedOrigins(def: SourceDef, stub: (url: string) => string): Promise<Set<string>> {
  const origins = new Set<string>();
  setFetchPage(async (url) => { origins.add(new URL(url).origin); return stub(url); });
  const a = createChiguaAdapter(def);
  try { await a.list(1, 5); } catch { /* 取数成败不论，只看请求打到哪些 origin */ }
  return origins;
}

/* 全量枚举断言：给定注册表与白名单，每个可取页源的 baseUrls origin
 * 与模板声明 origin 都必须在白名单内（适配器能请求的 origin 全集
 * ⊆ 白名单的静态全集侧；动态请求侧另经适配器实跑）。 */
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
const testRegistry = builtin;

/* ── 声明层：现行模板声明除 hanime-api 外全集为空、已删模板无残留 ──
 * 断言适配（fix3315）：hanime-api 随 hanime-tv 恢复、声明三 origin 回归；
 * iwara-api 保持删除退役。 */
for (const t of TEMPLATE_IDS) {
  if (t === "hanime-api") continue;
  assert.deepEqual(templateFetchOrigins(t), [], `模板 ${t} 当前无 baseUrls 之外的取页 origin 声明`);
  assert.ok(Object.prototype.hasOwnProperty.call(TEMPLATE_FETCH_ORIGINS, t), `模板 ${t} 在声明表内有条目（空集亦须显式在册）`);
}
assert.deepEqual(TEMPLATE_FETCH_ORIGINS["hanime-api"], ["https://guest.freeanimehentai.net", "https://ct.hanime.tv", "https://auth.hanime.tv"], "hanime-api 模板声明取页 origin = guest 目录＋ct CSRF＋auth 握手（fix3315 恢复）");
assert.equal(TEMPLATE_FETCH_ORIGINS["iwara-api" as keyof typeof TEMPLATE_FETCH_ORIGINS], undefined, "iwara-api 模板声明随模板删除退役");
assert.deepEqual(templateFetchOrigins("unknown-template"), [], "未知模板无取页 origin");

/* ── A. builtin 落定：白名单枚举覆盖 + 存活源适配器实跑请求 ⊆ 白名单 ── */
{
  const allow = new Set(sourceFetchAllowlistOrigins(testRegistry));
  assertFetchableCovered(testRegistry, allow, "builtin");
  const d = testRegistry.find((s) => s.id === "51chigua")!;
  const origins = await requestedOrigins(d, () => fx("chigua-list.html"));
  assert.ok(origins.size > 0, "[builtin] 51chigua 适配器实跑有请求（非真空断言）");
  for (const o of origins) assert.ok(allow.has(o), `[builtin] 51chigua 适配器请求 origin ${o} 必须在生产白名单内`);
}

/* ── B. 清单落定：白名单跟随 active baseUrls（双向） ── */
{
  const m = validateManifest({
    manifestVersion: 1, minAppVersion: "3.0.0",
    sources: [
      { id: "feedheiliao", enabled: true, baseUrls: ["https://heiliao.com"] },
    ],
  });
  assert.ok(m, "清单 schema 有效");
  const active = applyManifest(testRegistry, m!);
  const hlActive = active.find((s) => s.id === "feedheiliao")!;
  assert.deepEqual(hlActive.baseUrls, ["https://heiliao.com"], "前置事实：清单覆盖后 feedheiliao baseUrls 只剩首个域名");
  const allow = new Set(sourceFetchAllowlistOrigins(active));
  assert.ok(allow.has("https://heiliao.com"), "[清单落定] 保留 origin 在白名单内");
  assert.ok(!allow.has("https://www.heiliao88.com"), "[清单落定] 被清单削掉的镜像 origin 退出白名单（白名单跟随 active 表）");
  assertFetchableCovered(active, allow, "清单落定");
}

/* ── C. 防回归参数化：任一已启用源的 baseUrls 被清单削到只剩首个
 * 根域时，其模板声明 origin 仍必须在白名单内；全源同时削同样成立。
 * （fix3314：现行模板声明全为空集，逐源循环如实空转、由 stripAll
 * 全量覆盖断言承重；任一模板将来重新声明 origin 时循环自动承重。） ── */
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

/* ── D. 收紧口径：未启用／blocked／已删源的 origin 不放行 ── */
{
  const allow = new Set(sourceFetchAllowlistOrigins(builtin));
  assert.ok(allow.has("https://sexy.pixibb.com"), "已启用目录源（pixibb）origin 在白名单内");
  assert.ok(allow.has("https://www.mrds66.com"), "meiridasai 已解 blocked：mrds66 origin 入白名单");
  assert.ok(allow.has("https://xiuren.biz"), "xiuren 已解 blocked：xiuren.biz origin 入白名单");
  assert.ok(!allow.has("https://danbooru.donmai.us"), "danbooru 已摘除：origin 不入白名单（fix338）");
  assert.ok(!allow.has("https://konachan.com"), "konachan 已摘除：origin 不入白名单（fix338）");
  assert.ok(!allow.has("https://hentaihaven.xxx"), "hentaihaven 已摘除：origin 不入白名单（fix338）");
  assert.ok(!allow.has("https://hanime1.me"), "hanime1 已摘除：origin 不入白名单（fix3311）");
  assert.ok(!allow.has("https://yande.re"), "yandere 已摘除：origin 不入白名单（fix339）");
  /* fix3314：视频四源整组摘除，其全部 origin（含原模板声明的取流
   * origin）一律不入白名单。
   * 断言适配（fix3315）：hanime-tv/hentaiplay 恢复——其 origin 回正向；
   * iwara/hentaigasm 保持删除、负向不变。 */
  for (const o of ["https://hanime.tv", "https://guest.freeanimehentai.net", "https://ct.hanime.tv", "https://auth.hanime.tv",
    "https://hentaiplay.net"]) {
    assert.ok(allow.has(o), `已恢复源：${o} 在白名单内（fix3315）`);
  }
  for (const o of ["https://www.iwara.tv", "https://api.iwara.tv", "https://files.iwara.tv", "https://filesq.iwara.tv",
    "https://hentaigasm.com"]) {
    assert.ok(!allow.has(o), `保持删除：${o} 不入白名单（fix3314/fix3315）`);
  }
  /* 清单远程下线 xiuren（enabled=false）→ 其 origin 退出白名单 */
  const off = validateManifest({
    manifestVersion: 9, minAppVersion: "3.0.0",
    sources: [{ id: "xiuren", enabled: false, baseUrls: ["https://xiuren.biz"] }],
  });
  const allowOff = new Set(sourceFetchAllowlistOrigins(applyManifest(testRegistry, off!)));
  assert.ok(!allowOff.has("https://xiuren.biz"), "xiuren 被清单下线后 xiuren.biz 不再放行");
  /* 合成 blocked／停用 def 单独派生 → 空名单 */
  const xiurenDef = testRegistry.find((s) => s.id === "xiuren")!;
  assert.deepEqual(sourceFetchAllowlistOrigins([{ ...xiurenDef, maturity: "blocked" }]), [], "blocked def 不派生任何 origin");
  assert.deepEqual(sourceFetchAllowlistOrigins([{ ...xiurenDef, enabled: false }]), [], "停用 def 不派生任何 origin");
}

/* ── E. 接线：main.tsx 只消费派生结果 ── */
{
  const main = read("../../main.tsx");
  assert.ok(main.includes("sourceFetchAllowlistOrigins(getActiveRegistry().sources)"), "main.tsx 白名单推送只消费派生函数结果");
  assert.ok(!main.includes("flatMap((s) => s.baseUrls)"), "main.tsx 不再内联只从 baseUrls 拼白名单的旧派生");
  assert.ok(main.includes("setFetchPost"), "main.tsx 定向 POST 接缝注入在位（fix3315 随 hanime 握手链恢复）");
}

console.log("fix321-f2c.contract: all assertions passed");
