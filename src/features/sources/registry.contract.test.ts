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

/* 2026-11-19 瘦身定版（3.2.2 集成批，契约变化适配）：命名源只保留
 * 12（黄果＋吃瓜三源＋图片三源＋里番五源中的命名部分），普通视频
 * 全部、myfans、FC2 与停用杂源已摘除，断言随之收口到保留集。
 * 断言适配（fix330 接通批，2026-11-19）：HentaiHaven 自目录导入
 * 毕业为命名源，命名源 12→13、CORE_IDS 随之加 hentaihaven。
 * 断言适配（fix330/ui-fixes，2026-11-19）：用户 21:51 裁定 Rule34Video
 * 摘除，命名源 13→12、CORE_IDS 移除 rule34video 并入负向名单。
 * 断言适配（fix335/g-sources，2026-11-20）：用户裁定 PornPics 退役
 * 摘除，命名源 12→11、CORE_IDS 移除 pornpics 并入负向名单；目录源
 * yandere moebooru 校准启用、新增 konachan 启用，目录分支随之适配。
 * 断言适配（fix338/registry-cut，2026-11-20）：用户定案摘除三源——
 * danbooru（单图帖不算资源）、hentaihaven（真播放不可达、调查裁
 * 定不修）、konachan（CF JS 验证无解），命名源 11→9、目录源 6→5、
 * CORE_IDS 移除 danbooru/hentaihaven、三源并入负向名单；danbooru
 * 解封事实断言随源退役（模板由 yandere/gelbooru 共用、其行为覆
 * 盖由 adapters/f-discovery 契约以保留源承接）。
 * 断言适配（fix339/registry-cut-2，2026-11-21）：用户定案摘除三源
 * ——hanime1/iwara（3.3.8 一轮修复后真机仍不可播、整组删无第三
 * 轮）、yandere（单图帖与 danbooru 同标准删），命名源 11→9、目录
 * 源 5→4、CORE_IDS 移除 hanime1/iwara、三源并入负向名单；远程熔
 * 断样本由同 category 保留源 xiuren 接替（先例同口径）；danbooru-api
 * 模板由 gelbooru 在册承接、不随 yandere 退役。
 * 断言适配（fix3310/video-add-2，2026-11-21）：009/010 按用户授权
 * 试装恢复（播放腿补齐后试一轮、过关才回归），命名源 9→13、
 * CORE_IDS 回加 hanime1/iwara 并新增 hentaigasm/hentaiplay（视频
 * 候选准入 V1/V2），两源退出负向名单、fix330 启用事实断言恢复；
 * yandere 仍在负向名单（不恢复）。
 * 断言适配（fix3311/registry-cleanup，2026-11-21）：009 试装判删回
 * （真机协议 v4 探针取流网络类失败、按试装规则删回），命名源
 * 13→12、CORE_IDS 移除 hanime1、hanime1 回负向名单；010 不连坐、
 * 其启用事实断言保留。
 * 断言适配（fix3314，2026-11-21）：用户亲定视频板块整组删除——
 * xiuren/iwara/hentaigasm/hentaiplay 四源摘除，命名源 12→8、
 * CORE_IDS 移除四源并入负向名单；清单熔断样本由保留源 xiuren
 * 接替（先例同口径），D2 的 UI getter 断言随之改钉 image 品类。 */
const CORE_IDS = [
  "huangguo", "51chigua", "feedheiliao", "meiridasai",
  "xiuren", "cosplaytele",
  /* 断言适配（fix338/realphoto-add，集成对账 2026-11-20）：真人图片
   * 新源 everia/xsnvshen 以命名源入册（候选准入＋生产取页栈实拉全
   * 通，证据 fix338/evidence/realphoto-add.md）。（fix3314：视频四
   * 源 xiuren/iwara/hentaigasm/hentaiplay 已整组摘除，见文件
   * 头。） */
  "everia", "xsnvshen",
];

/* ── 注册表完整性 ── */
{
  const ids = new Set(BUILTIN_SOURCES.map((s) => s.id));
  assert.equal(ids.size, BUILTIN_SOURCES.length, "id 唯一");
  for (const id of CORE_IDS) assert.ok(ids.has(id), `命名源 ${id} 在册`);
  assert.equal(NAMED_SOURCES.length, CORE_IDS.length, "命名源 = 保留集 8（fix3314 摘视频四源 xiuren/iwara/hentaigasm/hentaiplay；此前 fix3311 摘 hanime1、fix338 摘 danbooru/hentaihaven、加 everia/xsnvshen，更早已摘 rule34video/pornpics）");
  /* 瘦身负向不变量：被删源不得回流注册表（App 内不得出现）。 */
  for (const goneId of ["rouvideo", "91video", "pornhub", "xvideos", "swag", "fyptt", "redgifs", "fc2",
    "jabletv", "missav", "tikporn", "myfans", "av123", "supjav", "fansly", "huangdou", "drama91", "rule34video", "pornpics",
    "danbooru", "hentaihaven", "konachan", "yandere", "hanime1",
    "hanime-tv", "iwara", "hentaigasm", "hentaiplay"]) {
    assert.ok(!ids.has(goneId), `瘦身删除源 ${goneId} 不在册`);
  }
  assert.equal(BUILTIN_SOURCES.length, NAMED_SOURCES.length + CATALOG_SOURCES.length, "内置 = 命名 + 目录导入");
  /* 断言适配（fix330 图片线，2026-11-19）：目录图片 5 源已逐源实抓
   * 定级，原「一律未启用＋未实测注记」口径由逐源实名断言接棒（覆盖
   * 不降：每个目录源恰落一组）；HentaiHaven 属里番线未动、维持原口径。 */
  for (const s of CATALOG_SOURCES) {
    assert.equal(s.maturity, "probe", `目录源 ${s.id} 一律 probe`);
    if (s.id === "pixibb" || s.id === "nudecosplay") {
      assert.equal(s.enabled, true, `目录源 ${s.id} fix330 实证启用（本机四级全通）`);
      assert.ok(s.note?.includes("fix330 图片线定级"), `目录源 ${s.id} 注记已按实证更新`);
    } else {
      assert.equal(s.enabled, false, `目录源 ${s.id} fix330 定级维持未启用`);
      assert.ok(s.note?.includes("fix330 图片线定级"), `目录源 ${s.id} 注记已记定级结论`);
    }
  }
  /* fix321-F2b：51chigua 换域名 51cg1.com 后解 blocked（契约变化适配）。
   * 3.3.0 接通批集成适配（2026-11-19）：吃瓜线解 meiridasai（mrds66）、
   * 图片线解 xiuren（xiuren.biz）后，保留集已无 blocked 源——blocked
   * 保留口径改由派生断言承接（注册表内任一 blocked 源自动受检、现
   * 集为空集），保留源改验解封后新事实。（danbooru 的同批解封断言
   * 已随 fix338 摘除退役。） */
  for (const s of BUILTIN_SOURCES.filter((x) => x.maturity === "blocked")) {
    assert.equal(s.enabled, true, `${s.id} blocked 保留口径：列表可见、点开诚实提示`);
  }
  {
    const x = BUILTIN_SOURCES.find((v) => v.id === "xiuren")!;
    assert.equal(x.maturity, "probe", "xiuren 已解 blocked（3.3.0 图片线）");
    assert.equal(x.baseUrls[0], "https://xiuren.biz", "xiuren 主域为 xiuren.biz（与清单 v3 一致）");
  }  {
    const s = BUILTIN_SOURCES.find((x) => x.id === "meiridasai")!;
    assert.equal(s.maturity, "probe", "meiridasai 已解 blocked（3.3.0 接通批）");
    assert.equal(s.baseUrls[0], "https://www.mrds66.com", "meiridasai 主域为 mrds66（与清单 v3 一致）");
    assert.equal(s.enabled, true, "meiridasai enabled");
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
  assert.equal(getBuiltinRegistry()[0].id, "huangguo", "order 第一顺位为黄果");
}

/* ── schema 校验 ── */
assert.equal(validateManifest(null), null);
assert.equal(validateManifest({ manifestVersion: "x" }), null);
assert.equal(validateManifest({ manifestVersion: 2, minAppVersion: "2.0.0", sources: [{ id: 1 }] }), null);
assert.ok(validateManifest({ manifestVersion: 2, minAppVersion: "2.0.0", sources: [{ id: "xiuren", enabled: false }] }));

/* ── 三段回退 ── */
const memStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, map: m };
};
const goodManifest = { manifestVersion: 7, minAppVersion: "2.0.0", sources: [{ id: "xiuren", enabled: false }] };

{ // 远程好清单 → remote 生效 + 写 last-good + 熔断位生效
  const st = memStorage();
  const r = await resolveRegistry({ fetcher: async () => goodManifest, storage: st, appVersion: "2.2.0" });
  assert.equal(r.source, "remote");
  assert.equal(r.manifestVersion, 7);
  assert.equal(r.sources.find((s) => s.id === "xiuren")!.enabled, false, "远程熔断下线 xiuren");
  assert.ok(st.map.has(MANIFEST_CACHE_KEY), "好清单写入 last-good");
  const info = getRegistryInfo();
  assert.equal(info.manifestVersion, 7);
  assert.equal(info.sources.find((s) => s.id === "xiuren")!.origin, "https://xiuren.biz", "getRegistryInfo 生效 origin");
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
  assert.equal(r.sources.find((s) => s.id === "xiuren")!.enabled, true, "内置口径 xiuren enabled");
}
{ // minAppVersion 高于当前 → 不生效 → 内置
  const r = await resolveRegistry({
    fetcher: async () => ({ manifestVersion: 9, minAppVersion: "9.9.9", sources: [{ id: "xiuren", enabled: false }] }),
    storage: memStorage(), appVersion: "2.2.0",
  });
  assert.equal(r.source, "builtin");
  assert.equal(r.sources.find((s) => s.id === "xiuren")!.enabled, true);
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
{ // fake fetcher 把 xiuren 熔断 → active 表与 UI getter 同步反映
  // （断言适配沿革：熔断样本随源摘除逐次由保留源接替——rule34video
  // →iwara→hanime-tv；fix3314 视频四源整组摘除后由 xiuren 接替，
  // 覆盖不变）
  const st = memStorage();
  const r = await resolveRegistry({
    fetcher: async () => ({ manifestVersion: 11, minAppVersion: "2.0.0", sources: [{ id: "xiuren", enabled: false }] }),
    storage: st, appVersion: "2.2.0",
  });
  assert.equal(r.source, "remote");
  assert.equal(getActiveRegistry().sources.find((s) => s.id === "xiuren")!.enabled, false, "active 表反映远程熔断");
  const uiImage = sourcesForCategory("image", getActiveRegistry().sources);
  assert.ok(!uiImage.some((s) => s.id === "xiuren"), "UI 消费 getter（active 表）不再列出被熔断源");
  assert.ok(sourcesForCategory("image").some((s) => s.id === "xiuren"), "对照：内置表口径仍含 xiuren（证明覆盖来自 active 而非内置变更）");
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
  st.setItem(MANIFEST_CACHE_KEY, JSON.stringify(goodManifest)); // v7：xiuren 熔断
  const r = await resolveRegistry({
    fetcher: async () => ({ manifestVersion: 3, minAppVersion: "2.0.0", sources: [{ id: "xiuren", enabled: true }] }),
    storage: st, appVersion: "2.2.0",
  });
  assert.equal(r.source, "last-good", "低版本远程清单被防回滚拒绝");
  assert.equal(r.manifestVersion, 7);
  assert.equal(r.sources.find((s) => s.id === "xiuren")!.enabled, false, "仍按 last-good 的熔断位");
  assert.equal(JSON.parse(st.map.get(MANIFEST_CACHE_KEY)!).manifestVersion, 7, "last-good 缓存未被低版本覆盖");
}
{ // 远程 v7 == last-good v7 → 接受远程
  const st = memStorage();
  st.setItem(MANIFEST_CACHE_KEY, JSON.stringify(goodManifest));
  const r = await resolveRegistry({
    fetcher: async () => ({ manifestVersion: 7, minAppVersion: "2.0.0", sources: [{ id: "xiuren", enabled: true }] }),
    storage: st, appVersion: "2.2.0",
  });
  assert.equal(r.source, "remote", "同版本远程清单可接受");
  assert.equal(r.sources.find((s) => s.id === "xiuren")!.enabled, true);
}

/* ── D7 明文 http 起点收口（Muse 2026-11-19 整改，G5 P1-4 前半）：
 * 远程/缓存清单的 baseUrls 只许 https；内置注册表不经 validateManifest、
 * 不受影响（已 grep 核实内置 baseUrls 全 https 且校验仅用于清单路径）。 ── */
assert.equal(
  validateManifest({ manifestVersion: 8, minAppVersion: "2.0.0", sources: [{ id: "xiuren", baseUrls: ["http://xiuren.biz"] }] }),
  null, "清单 baseUrls 含 http → 整份丢弃",
);
assert.ok(
  validateManifest({ manifestVersion: 8, minAppVersion: "2.0.0", sources: [{ id: "xiuren", baseUrls: ["https://xiuren.biz"] }] }),
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
