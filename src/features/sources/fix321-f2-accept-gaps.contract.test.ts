/**
 * 验收员 D 已知缺口证伪测试（fix321-F2/F2b 验收，2026-11-19）——
 * 本文件预期红：每条断言都是一条「生产链应成立」的不变量，红即
 * 缺口字面证据。验收纪律：发现真违例只定性回报、不自行改生产代码。
 *
 * 缺口 G1（清单覆盖层顶掉 API origin → Rust 白名单拒取页）：
 * 远程清单（v1 已部署／v2 已备）对 swag/redgifs 的 baseUrls 只写
 * 站点根域；applyManifest 整组替换 baseUrls 后，active 注册表丢失
 * api.swag.live／api.redgifs.com；main.tsx 的 pushSourceAllowlist
 * 只从 active baseUrls 拼白名单 → 生产 source_fetch 对两源全部
 * API 取页（SWAG feeds/messages、RedGifs 令牌/search）以「目标
 * origin 不在源白名单内」拒绝。契约测试经 setFetchPage 注入夹具、
 * 绕过 Rust 白名单，故施工方契约全绿而生产链断裂。适配器内的
 * apiBase 硬编码兜底只保证 URL 正确、过不了白名单。
 * 复现法：按生产顺序 validateManifest→applyManifest 落定 active
 * 表，再以该表 def 经工厂跑 list、捕获真实请求 URL 的 origin，
 * 断言每个请求 origin 都在「按 main.tsx 同算法拼出的白名单」内。
 *
 * 缺口 G2（仅 v1、已部署）：51吃瓜 baseUrls 被 v1 拉回已停放的
 * 51chigua.com、黑料网被 v1 置 enabled=false，与 F2b 解 blocked／
 * 毕业启用的内置口径在 active 面不一致（v2 已修正、未部署）。
 *
 * 运行：node src/features/sources/fix321-f2-accept-gaps.contract.test.ts
 * （仓外清单文件经相对路径读取：~/workspace/hghub/remote-manifest/）
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "./registry.ts";
import { applyManifest, validateManifest } from "./manifest.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { createChiguaAdapter, createHlsSiteAdapter, createRedgifsAdapter, createSwagAdapter } from "./adapters/templates.ts";
const createAdapter = (d: SourceDef) => {
  switch (d.adapter.template) {
    case "chigua": return createChiguaAdapter(d);
    case "hls-site": return createHlsSiteAdapter(d);
    case "swag-api": return createSwagAdapter(d);
    case "redgifs-api": return createRedgifsAdapter(d);
    default: return null;
  }
};
import type { SourceDef } from "./types.ts";

const manifestRaw = (v: string) => JSON.parse(readFileSync(
  new URL(`../../../../../remote-manifest/sources-manifest${v}.json`, import.meta.url), "utf8")) as unknown;
const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");

/* main.tsx pushSourceAllowlist 的同算法复算（生产白名单的唯一来源） */
function allowlistOrigins(sources: SourceDef[]): Set<string> {
  return new Set(sources.flatMap((s) => s.baseUrls)
    .map((u) => { try { return new URL(u).origin; } catch { return ""; } })
    .filter((o) => o !== "" && o !== "null"));
}

async function requestedOrigins(def: SourceDef, stub: (url: string) => string): Promise<Set<string>> {
  const origins = new Set<string>();
  setFetchPage(async (url) => { origins.add(new URL(url).origin); return stub(url); });
  const a = createAdapter(def);
  assert.ok(a, `${def.id} 有适配器`);
  try { await a!.list(1, 5); } catch { /* 取数成败不论，只看请求打到哪些 origin */ }
  return origins;
}

const stubs: Record<string, (url: string) => string> = {
  swag: (url) => url.includes("/feeds/") ? fx("real-swag-feed.json") : fx("real-swag-message.json"),
  redgifs: (url) => url.includes("/v2/auth/temporary") ? JSON.stringify({ token: "t" }) : fx("real-redgifs-search.json"),
};

for (const v of ["", "-v2"] as const) {
  const m = validateManifest(manifestRaw(v));
  assert.ok(m, `清单 ${v || "v1"} schema 有效`);
  const active = applyManifest(getBuiltinRegistry(), m!);
  const allow = allowlistOrigins(active);
  for (const id of ["swag", "redgifs"] as const) {
    const d = active.find((s) => s.id === id)!;
    const origins = await requestedOrigins(d, stubs[id]);
    for (const o of origins) {
      assert.ok(allow.has(o), `[清单${v || "v1"}] ${id} 适配器请求 origin ${o} 必须在生产白名单内（实际白名单源于 active baseUrls，API origin 已被清单覆盖顶掉）`);
    }
  }
  if (v === "") {
    const cg = active.find((s) => s.id === "51chigua")!;
    assert.equal(cg.baseUrls[0], "https://51cg1.com", "[清单v1·已部署] 51吃瓜 active 域名应为 51cg1.com（F2b 解 blocked 口径）");
    const hl = active.find((s) => s.id === "feedheiliao")!;
    assert.equal(hl.enabled, true, "[清单v1·已部署] 黑料网 active 应 enabled=true（F2b 毕业启用口径）");
  }
}

console.log("fix321-f2-accept-gaps.contract: all assertions passed (缺口已修复)");
