/**
 * 注册表 + 远程清单契约测试（Muse 2026-11-19 根治包·多源线 条目2/3）：
 * 运行：node src/features/sources/registry.contract.test.ts
 * 覆盖：冻结名单完整性、enabled 源适配器可解析、三段回退
 * （坏清单→last-good、再坏→内置）、minAppVersion 门、远程熔断。
 */
import assert from "node:assert/strict";
import { BUILTIN_SOURCES, getBuiltinRegistry } from "./registry.ts";
import { MANIFEST_CACHE_KEY, applyManifest, getRegistryInfo, resolveRegistry, validateManifest } from "./manifest.ts";
import { TEMPLATE_IDS } from "./adapters/templates.ts";

const FROZEN_IDS = [
  "huangguo", "rouvideo", "91video", "pornhub", "xvideos", "hanime-tv", "swag", "fyptt",
  "redgifs", "rule34video", "51chigua", "meiridasai", "xiuren", "pornpics", "cosplaytele",
  "danbooru", "jabletv", "missav", "tikporn", "hanime1", "iwara", "myfans",
];

/* ── 注册表完整性 ── */
{
  assert.deepEqual([...BUILTIN_SOURCES.map((s) => s.id)].sort(), [...FROZEN_IDS].sort(), "冻结名单 22 源不多不少");
  const ids = new Set(BUILTIN_SOURCES.map((s) => s.id));
  assert.equal(ids.size, BUILTIN_SOURCES.length, "id 唯一");
  for (const s of BUILTIN_SOURCES) {
    assert.ok(s.displayName && s.baseUrls.length && /^https?:\/\//.test(s.baseUrls[0]), `${s.id} 基址齐全`);
    assert.ok((TEMPLATE_IDS as readonly string[]).includes(s.adapter.template), `${s.id} 模板 id 已知`);
    if (s.enabled) {
      assert.notEqual(s.adapter.template, "none", `${s.id} enabled 源必须能解析出适配器`);
      if (s.adapter.template === "hls-site" || s.adapter.template === "chigua" || s.adapter.template === "wp-rest" || s.adapter.template === "danbooru-api") {
        assert.ok(s.adapter.params && typeof s.adapter.params.listPath === "string", `${s.id} 模板参数 listPath 齐全`);
      }
    }
  }
  for (const probeId of ["jabletv", "missav", "tikporn", "hanime1", "iwara"]) {
    const s = BUILTIN_SOURCES.find((x) => x.id === probeId)!;
    assert.equal(s.enabled, false, `${probeId} 探测未过 enabled=false`);
    assert.equal(s.maturity, "probe");
  }
  const myfans = BUILTIN_SOURCES.find((x) => x.id === "myfans")!;
  assert.equal(myfans.maturity, "preview");
  assert.equal(myfans.category, "preview");
  assert.equal(getBuiltinRegistry()[0].id, "huangguo", "order 第一顺位为黄果");
}

/* ── schema 校验 ── */
assert.equal(validateManifest(null), null);
assert.equal(validateManifest({ manifestVersion: "x" }), null);
assert.equal(validateManifest({ manifestVersion: 2, minAppVersion: "2.0.0", sources: [{ id: 1 }] }), null);
assert.ok(validateManifest({ manifestVersion: 2, minAppVersion: "2.0.0", sources: [{ id: "swag", enabled: false }] }));

/* ── 三段回退 ── */
const memStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, map: m };
};
const goodManifest = { manifestVersion: 7, minAppVersion: "2.0.0", sources: [{ id: "swag", enabled: false }] };

{ // 远程好清单 → remote 生效 + 写 last-good + 熔断位生效
  const st = memStorage();
  const r = await resolveRegistry({ fetcher: async () => goodManifest, storage: st, appVersion: "2.2.0" });
  assert.equal(r.source, "remote");
  assert.equal(r.manifestVersion, 7);
  assert.equal(r.sources.find((s) => s.id === "swag")!.enabled, false, "远程熔断下线 swag");
  assert.ok(st.map.has(MANIFEST_CACHE_KEY), "好清单写入 last-good");
  const info = getRegistryInfo();
  assert.equal(info.manifestVersion, 7);
  assert.equal(info.sources.find((s) => s.id === "swag")!.origin, "https://swag.live", "getRegistryInfo 生效 origin");
}
{ // 坏清单 → last-good
  const st = memStorage();
  st.setItem(MANIFEST_CACHE_KEY, JSON.stringify(goodManifest));
  const r = await resolveRegistry({ fetcher: async () => ({ broken: true }), storage: st, appVersion: "2.2.0" });
  assert.equal(r.source, "last-good");
  assert.equal(r.manifestVersion, 7);
}
{ // 远程抛错 + 无缓存 → 内置
  const r = await resolveRegistry({ fetcher: async () => { throw new Error("net down"); }, storage: memStorage(), appVersion: "2.2.0" });
  assert.equal(r.source, "builtin");
  assert.equal(r.sources.length, 22);
  assert.equal(r.sources.find((s) => s.id === "swag")!.enabled, true, "内置口径 swag enabled");
}
{ // minAppVersion 高于当前 → 不生效 → 内置
  const r = await resolveRegistry({
    fetcher: async () => ({ manifestVersion: 9, minAppVersion: "9.9.9", sources: [{ id: "swag", enabled: false }] }),
    storage: memStorage(), appVersion: "2.2.0",
  });
  assert.equal(r.source, "builtin");
  assert.equal(r.sources.find((s) => s.id === "swag")!.enabled, true);
}
{ // applyManifest 不增删源
  const merged = applyManifest(getBuiltinRegistry(), validateManifest(goodManifest)!);
  assert.equal(merged.length, 22);
}

console.log("registry.contract: all assertions passed");
