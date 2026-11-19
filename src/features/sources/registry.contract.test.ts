/**
 * 注册表 + 远程清单契约测试（Muse 2026-11-19 根治包·多源线 条目2/3；
 * 2026-11-19 用户新口径适配：名单由冻结改为「命名源核心 + FC2 +
 * 目录导入」，blocked 改列表保留可见，断言强度不降）：
 * 运行：node src/features/sources/registry.contract.test.ts
 * 覆盖：命名源完整性、目录导入口径、blocked 保留口径、enabled 源
 * 适配器可解析、三段回退（坏清单→last-good、再坏→内置）、
 * minAppVersion 门、远程熔断。
 */
import assert from "node:assert/strict";
import { BUILTIN_SOURCES, NAMED_SOURCES, getBuiltinRegistry } from "./registry.ts";
import { CATALOG_SOURCES } from "./catalog.ts";
import { MANIFEST_CACHE_KEY, applyManifest, getRegistryInfo, resolveRegistry, validateManifest } from "./manifest.ts";
import { TEMPLATE_IDS } from "./adapters/templates.ts";

const CORE_IDS = [
  "huangguo", "rouvideo", "91video", "pornhub", "xvideos", "hanime-tv", "swag", "fyptt",
  "redgifs", "rule34video", "51chigua", "meiridasai", "xiuren", "pornpics", "cosplaytele",
  "danbooru", "jabletv", "missav", "tikporn", "hanime1", "iwara", "myfans",
  /* fix321-F2b：黑料网自目录导入毕业为命名源（契约变化适配） */
  "feedheiliao",
];

/* ── 注册表完整性 ── */
{
  const ids = new Set(BUILTIN_SOURCES.map((s) => s.id));
  assert.equal(ids.size, BUILTIN_SOURCES.length, "id 唯一");
  for (const id of CORE_IDS) assert.ok(ids.has(id), `命名源 ${id} 在册`);
  assert.ok(ids.has("fc2"), "FC2（用户点名）在册");
  assert.equal(NAMED_SOURCES.length, CORE_IDS.length + 1, "命名源 = 核心（含 F2b 毕业的黑料网） + FC2");
  assert.equal(BUILTIN_SOURCES.length, NAMED_SOURCES.length + CATALOG_SOURCES.length, "内置 = 命名 + 目录导入");
  for (const s of CATALOG_SOURCES) {
    assert.equal(s.enabled, false, `目录源 ${s.id} 默认未启用（远程清单可按 id 启用）`);
    assert.equal(s.maturity, "probe", `目录源 ${s.id} 一律 probe`);
    assert.ok(s.note?.includes("目录导入·未实测"), `目录源 ${s.id} 注记诚实标注未实测`);
  }
  /* fix321-F2b：51chigua 换域名 51cg1.com 后解 blocked（契约变化适配） */
  for (const blockedId of ["meiridasai", "xiuren", "danbooru"]) {
    const s = BUILTIN_SOURCES.find((x) => x.id === blockedId)!;
    assert.equal(s.maturity, "blocked");
    assert.equal(s.enabled, true, `${blockedId} blocked 保留口径：列表可见、点开诚实提示`);
  }
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
  assert.equal(r.sources.length, BUILTIN_SOURCES.length);
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
  assert.equal(merged.length, getBuiltinRegistry().length);
}

/* ── D2 远程清单真接通（Muse 2026-11-19 整改）：覆盖结果必须反映到
 * UI 实际消费的来源——UI 三处（SourceSwitcher/Category/Posts）统一经
 * getActiveRegistry().sources 喂给 sourcesForCategory/firstEnabledSource，
 * 不再读 getBuiltinRegistry()；main.tsx 启动调用 resolveRegistry。 ── */
import { readFileSync } from "node:fs";
import { getActiveRegistry } from "./manifest.ts";
import { sourcesForCategory } from "./registry.ts";
{ // fake fetcher 把 pornhub 熔断 → active 表与 UI getter 同步反映
  const st = memStorage();
  const r = await resolveRegistry({
    fetcher: async () => ({ manifestVersion: 11, minAppVersion: "2.0.0", sources: [{ id: "pornhub", enabled: false }] }),
    storage: st, appVersion: "2.2.0",
  });
  assert.equal(r.source, "remote");
  assert.equal(getActiveRegistry().sources.find((s) => s.id === "pornhub")!.enabled, false, "active 表反映远程熔断");
  const uiVideo = sourcesForCategory("video", getActiveRegistry().sources);
  assert.ok(!uiVideo.some((s) => s.id === "pornhub"), "UI 消费 getter（active 表）不再列出被熔断源");
  assert.ok(sourcesForCategory("video").some((s) => s.id === "pornhub"), "对照：内置表口径仍含 pornhub（证明覆盖来自 active 而非内置变更）");
}
{ // 接线文本断言：三处 UI 读 active 表 + 订阅事件；main 启动调用 resolveRegistry
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  assert.ok(read("./SourceSwitcher.tsx").includes("getActiveRegistry"), "SourceSwitcher 读 active 表");
  assert.ok(read("../category/Category.tsx").includes("getActiveRegistry"), "Category 读 active 表");
  assert.ok(read("../posts/Posts.tsx").includes("getActiveRegistry"), "Posts 读 active 表");
  assert.ok(read("../../main.tsx").includes("resolveRegistry"), "main.tsx 启动调用 resolveRegistry");
}

/* ── D4 清单防回滚（Muse 2026-11-19 整改，G5 P2-2）：远程版本低于
 * 本地 last-good 时不生效、不覆盖缓存；相等/更高才接受。 ── */
{ // 远程 v3 < last-good v7 → 用 last-good，缓存不被覆盖
  const st = memStorage();
  st.setItem(MANIFEST_CACHE_KEY, JSON.stringify(goodManifest)); // v7：swag 熔断
  const r = await resolveRegistry({
    fetcher: async () => ({ manifestVersion: 3, minAppVersion: "2.0.0", sources: [{ id: "swag", enabled: true }] }),
    storage: st, appVersion: "2.2.0",
  });
  assert.equal(r.source, "last-good", "低版本远程清单被防回滚拒绝");
  assert.equal(r.manifestVersion, 7);
  assert.equal(r.sources.find((s) => s.id === "swag")!.enabled, false, "仍按 last-good 的熔断位");
  assert.equal(JSON.parse(st.map.get(MANIFEST_CACHE_KEY)!).manifestVersion, 7, "last-good 缓存未被低版本覆盖");
}
{ // 远程 v7 == last-good v7 → 接受远程
  const st = memStorage();
  st.setItem(MANIFEST_CACHE_KEY, JSON.stringify(goodManifest));
  const r = await resolveRegistry({
    fetcher: async () => ({ manifestVersion: 7, minAppVersion: "2.0.0", sources: [{ id: "swag", enabled: true }] }),
    storage: st, appVersion: "2.2.0",
  });
  assert.equal(r.source, "remote", "同版本远程清单可接受");
  assert.equal(r.sources.find((s) => s.id === "swag")!.enabled, true);
}

/* ── D7 明文 http 起点收口（Muse 2026-11-19 整改，G5 P1-4 前半）：
 * 远程/缓存清单的 baseUrls 只许 https；内置注册表不经 validateManifest、
 * 不受影响（已 grep 核实内置 baseUrls 全 https 且校验仅用于清单路径）。 ── */
assert.equal(
  validateManifest({ manifestVersion: 8, minAppVersion: "2.0.0", sources: [{ id: "swag", baseUrls: ["http://swag.live"] }] }),
  null, "清单 baseUrls 含 http → 整份丢弃",
);
assert.ok(
  validateManifest({ manifestVersion: 8, minAppVersion: "2.0.0", sources: [{ id: "swag", baseUrls: ["https://swag.live"] }] }),
  "清单 baseUrls 全 https → 通过",
);

/* ── D3 blocked 文案改实（Muse 2026-11-19 整改，G5 P1-2）：
 * applyManifest 只能改 enabled/baseUrls、改不了 maturity，「远程清单
 * 推送新域名后即可用」是不可兑现承诺，必须删除；改为如实表述。 ── */
{
  const switcher = readFileSync(new URL("./SourceSwitcher.tsx", import.meta.url), "utf8");
  assert.ok(!switcher.includes("远程清单推送新域名后即可用"), "blocked 文案不得承诺远程清单推送即恢复");
  assert.ok(switcher.includes("后续版本将重新评估开放"), "blocked 文案改为不承诺自动恢复的如实表述");
  assert.ok(switcher.includes("实测记录：{note}"), "blocked 文案保留 note 原文呈现");
}

/* ── D5 源切换事件（Muse 2026-11-19 整改，diag-audit #8）：
 * 选中回调发 tracePlayback("source.switch")，只带稳定编号
 * （active 注册表顺序 source-001 式）与分类标识，不带业务名/域名。 ── */
{
  const switcher = readFileSync(new URL("./SourceSwitcher.tsx", import.meta.url), "utf8");
  assert.ok(switcher.includes('tracePlayback("source.switch"'), "选中回调发 source.switch 事件");
  assert.ok(switcher.includes("source-${String(idx + 1).padStart(3"), "事件只带 source-001 式稳定编号");
  const callStart = switcher.indexOf('tracePlayback("source.switch"');
  const callText = switcher.slice(callStart, switcher.indexOf(");", callStart));
  assert.ok(!callText.includes("displayName") && !callText.includes("baseUrls") && !callText.includes("label"), "source.switch 不带业务名/域名");
}

console.log("registry.contract: all assertions passed");
