/**
 * fix334 结构批 L1 契约：surfaces.ts 单一派生＋完备性（用户 2026-11-20
 * 拍板 G3/G4 与完备性契约同批——即 AGENTS 不变量 11 要求的维护者同意，
 * 设计依据 ~/workspace/hghub/fix334/design-g3g4-surfaces.md）。
 * 运行：node src/features/sources/fix334-surfaces.contract.test.ts
 *
 * 背景（结构审计 O3/G5/G7）：注册表只派生「源列表」、不派生「面路由」——
 * 21 个展示面里真派生 8、半派生 3、其余靠纪律/组件内手写，G3（012 选集
 * 无消费者）/G4（外部源收藏历史无回访）正是「规则说适用、面不存在」漏接
 * 的形状。本契约遍历「注册表状态 × 面 × 源」组合空间，合法组合由品类 ×
 * 能力事实 × 启用规则生成（不手写 17×21 期望表），断言派生结果与规则
 * 结果一致；不适用必须在 surfaces.ts 声明表里显式声明且与事实不矛盾，
 * 未声明即红、声明腐烂（无格使用）也红。
 *
 * 诚实边界（设计 §2.4）：本契约证明「面接上了/派生自洽」，不证明「源
 * 活着」——源存活由 F7 自检证，两者不许单独读成「全通」。
 *
 * 夹具：三组注册表状态（R1 内置、R2 清单 v3 同形、R3 合成变体：清单
 * 停用 012＋启用 015）＋能力行为夹具（既有 adapters/fixtures）。不访问
 * 真实网络（setFetchPage 注入夹具）、不读 localStorage。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry, sourcesForCategory, sourcesForChannel } from "./registry.ts";
import { applyManifest, validateManifest } from "./manifest.ts";
import { resolveSelectedSource } from "./selectedSource.ts";
import { searchPolicyFor } from "../search/multiSourceSearch.ts";
import { selfCheckEligible } from "./healthCheck.ts";
import { templateHasAdapter, templateHasSearch } from "./adapters/templateSegments.ts";
import { TEMPLATE_IDS } from "./adapters/templates.ts";
import { createHentaihavenAdapter, createHlsSiteAdapter } from "./adapters/templates.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import {
  EPISODES_FORM_BY_TEMPLATE, episodesFormOf, templateCapabilitiesFor,
} from "./adapters/templateCapabilities.ts";
import {
  SURFACE_DECLARATIONS, SURFACES, isNativeSource, routeForSurface, sourcesForSurface,
  validateSurfaceDerivation, type SurfaceContext, type SurfaceId, type SurfaceRoute,
} from "./surfaces.ts";
import type { SourceDef } from "./types.ts";

const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");
const srcText = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* 合成 hls-site def（适配 fix335/g-sources）：pornpics 已退役摘除注册
 * 表、内置表再无 hls-site 源，模板级行为钉（§0 single）与声明 h
 * （search-unusable-hls-site）的触发改由此合成 def 承接——形态即原
 * 注册表条目（模板代码留仓），覆盖不减（先例：§1 ghost/blockedFx）。 */
const hlsSiteFx: SourceDef = {
  id: "pornpics", displayName: "PornPics", kind: "image", category: "image",
  adapter: { template: "hls-site", params: { listPath: "/recent/", itemLinkPattern: "/galleries/", detailPath: "/galleries/{id}/" } },
  baseUrls: ["https://www.pornpics.com"], enabled: true, order: 41, maturity: "probe",
  capabilities: { search: false, episodes: false, hevc: false, comments: false },
  network: { mode: "probe-required" },
};

/* ══ 0. 能力事实表（templateCapabilities.ts） ══ */
{
  /* search/detailPlay 一律探针派生（与 templateSegments 同源），不许手抄：
   * search＝模板真有 search 方法 ∧ 注册表对该 def 声明 capabilities.search
   * （与 multiSourceSearch.missingSearchSegments 的现行生产口径逐字一致）；
   * detailPlay＝适配器存在（detail/resolve 类型必填）。 */
  for (const def of getBuiltinRegistry()) {
    const caps = templateCapabilitiesFor(def);
    assert.equal(caps.search, templateHasSearch(def.adapter.template) && def.capabilities.search,
      `${def.id} search 事实须＝探针∧注册表声明`);
    assert.equal(caps.detailPlay, templateHasAdapter(def.adapter.template),
      `${def.id} detailPlay 事实须＝适配器存在`);
  }
  /* episodes 形态表须显式覆盖每个有适配器的模板（漏登即红，不许靠回落
   * 掩盖）；"none"/未知模板回落 none。 */
  for (const t of TEMPLATE_IDS) {
    if (t === "none") continue;
    assert.ok(t in EPISODES_FORM_BY_TEMPLATE, `模板 ${t} 须显式登记 episodes 形态`);
    assert.equal(templateHasAdapter(t), true, `模板 ${t} 有适配器`);
  }
  assert.equal(episodesFormOf("none"), "none");
  assert.equal(episodesFormOf("unknown-template"), "none");
  /* 行为钉（multi）：012 模板 detail 经既有夹具实产 2 集——形态表写
   * multi 必须有行为证据，不许只凭声明。 */
  setFetchPage(async (url) => {
    if (url.includes("/api/manga/")) return fx("hentaihaven-list.json");
    if (url.includes("/episode-")) return fx("hentaihaven-episode.html");
    if (url.includes("/watch/")) return fx("hentaihaven-watch.html");
    throw new Error(`unexpected fetch ${url}`);
  });
  const hhDef = getBuiltinRegistry().find((s) => s.id === "hentaihaven")!;
  const hhDetail = await createHentaihavenAdapter(hhDef).detail("fixture-slug-001");
  assert.equal(hhDetail.episodes.length, 2, "012 模板 detail 实产 2 集（multi 行为证据）");
  assert.equal(templateCapabilitiesFor(hhDef).episodes, "multi", "012 模板 episodes 形态＝multi");
  /* 行为钉（single）：hls-site detail 的 episodes 至多单条「正片」。 */
  setFetchPage(async () => fx("hls-detail.html"));
  const ppDef = hlsSiteFx;
  const ppDetail = await createHlsSiteAdapter(ppDef).detail("fixture-gallery");
  assert.ok(ppDetail.episodes.length <= 1, "hls-site detail episodes 至多单条（single 行为证据）");
  assert.equal(templateCapabilitiesFor(ppDef).episodes, "single", "hls-site 模板 episodes 形态＝single");
  /* 分层裁定（设计 §1.4 注 e；fix334/L2 已裁）：012 注册表
   * caps.episodes=false 与模板实产 multi 的分层在此钉住——品类
   * 映射（M6 短剧频道）看 caps、选集面看模板事实，两处不许混
   * 用。设计 §3.1 曾要求 L2 翻 caps=true，L2 核对消费面后裁定
   * 不翻：caps 是 sourcesForChannel(ai-duanju) 的唯一映射门，
   * 翻 true 会让 012（里番分集、非短剧品类）进短剧频道切源名
   * 单并使下方 M6「成员仅原生」断言翻红——差异已在 L2 报告
   * 明报，本断言即裁定后的守门（翻 caps 者先改本断言并给频道
   * 名单的处置方案）。 */
  assert.equal(hhDef.capabilities.episodes, false, "012 caps.episodes 维持 false（L2 裁定：与模板 multi 分层、短剧频道映射门）");
}

/* ══ 1. 三组注册表状态 ══ */
const R1 = getBuiltinRegistry();
/* R2：与 remote-manifest v3 同形的内存对象（manifestVersion 3、
 * minAppVersion 3.1.0、17 源 enabled/baseUrls），不读网络不读仓外文件。 */
const V3_FIXTURE = {
  manifestVersion: 3, minAppVersion: "3.1.0",
  sources: [
    { id: "huangguo", enabled: true, baseUrls: ["https://huangguoai.com"] },
    { id: "hanime-tv", enabled: true, baseUrls: ["https://hanime.tv"] },
    { id: "51chigua", enabled: true, baseUrls: ["https://51cg1.com"] },
    { id: "feedheiliao", enabled: true, baseUrls: ["https://heiliao.com", "https://www.heiliao88.com"] },
    { id: "meiridasai", enabled: true, baseUrls: ["https://www.mrds66.com", "https://meiridasai.com"] },
    { id: "xiuren", enabled: true, baseUrls: ["https://xiuren.biz", "https://xiuren.com"] },
    { id: "pornpics", enabled: true, baseUrls: ["https://www.pornpics.com"] },
    { id: "cosplaytele", enabled: true, baseUrls: ["https://cosplaytele.com"] },
    { id: "danbooru", enabled: true, baseUrls: ["https://danbooru.donmai.us"] },
    { id: "hanime1", enabled: true, baseUrls: ["https://hanime1.me"] },
    { id: "iwara", enabled: true, baseUrls: ["https://www.iwara.tv", "https://api.iwara.tv"] },
    { id: "hentaihaven", enabled: true, baseUrls: ["https://hentaihaven.xxx"] },
    { id: "pixibb", enabled: true, baseUrls: ["https://sexy.pixibb.com"] },
    { id: "nudecosplay", enabled: true, baseUrls: ["https://nudecosplay.biz"] },
    { id: "yandere", enabled: false, baseUrls: ["https://yande.re/"] },
    { id: "gelbooru", enabled: false, baseUrls: ["https://gelbooru.com/"] },
    { id: "pixiv", enabled: false, baseUrls: ["https://www.pixiv.net"] },
  ],
};
const v3 = validateManifest(V3_FIXTURE);
assert.ok(v3, "v3 同形夹具须过 schema 校验");
const R2 = applyManifest(R1, v3);
/* R3：合成变体——清单停用 011（hentaihaven）、启用 014（yandere）。
 * 适配（fix335/g-sources）：014 已在内置 R1 启用，本变体对 014 的
 * 「启用」自此为同值重申（形态不变、断言口径随新事实更新见 §5）。 */
const vR3 = validateManifest({
  manifestVersion: 4, minAppVersion: "3.1.0",
  sources: [
    { id: "hentaihaven", enabled: false },
    { id: "yandere", enabled: true },
  ],
});
assert.ok(vR3, "R3 变体夹具须过 schema 校验");
const R3 = applyManifest(R1, vR3);
const STATES: SourceDef[][] = [R1, R2, R3];
const ctxOf = (active: SourceDef[]): SurfaceContext => ({ active, builtin: R1 });

/* 合成形态（只为覆盖状态依存声明，不参与常态遍历口径）：无适配器
 * 模板的启用源（注册表完整性本应挡下、派生须有兜底）＋blocked 启用
 * 源（历史上 003/006 曾是此形态、自检声明 blocked-not-probed 的
 * 唯一触发形态）。 */
const ghost: SourceDef = {
  id: "ghost", displayName: "幽灵", kind: "video", category: "video",
  adapter: { template: "none" }, baseUrls: ["https://example.com"], enabled: true,
  order: 999, maturity: "probe",
  capabilities: { search: true, episodes: false, hevc: false, comments: false },
  network: { mode: "probe-required" },
};
const blockedFx: SourceDef = {
  ...R1.find((s) => s.id === "danbooru")!, id: "blocked-fixture", maturity: "blocked",
};
const SYNTHETIC_STATE: SourceDef[] = [ghost, blockedFx, hlsSiteFx];

/* ══ 2. 完备性校验器：三组状态全遍历不抛（派生自洽＋声明不腐烂） ══ */
validateSurfaceDerivation({ route: routeForSurface, sources: sourcesForSurface }, STATES, [SYNTHETIC_STATE]);

/* ── 2b. 突变自检（证伪层一：校验器不是恒真摆设） ── */
{
  /* 摘一面：detail-gallery 派生缺失 → 必抛。 */
  assert.throws(
    () => validateSurfaceDerivation({
      route: (s, d, c) => (s === "detail-gallery" ? (undefined as unknown as SurfaceRoute) : routeForSurface(s, d, c)),
      sources: sourcesForSurface,
    }, STATES),
    /detail-gallery/, "摘掉 M15 派生须被校验器抓住",
  );
  /* 伪造声明：不适用却引用不存在的声明 → 必抛。 */
  assert.throws(
    () => validateSurfaceDerivation({
      route: (s, d, c) => (s === "discover" && d && !isNativeSource(d)
        ? { kind: "not-applicable", declaration: "bogus-key" }
        : routeForSurface(s, d, c)),
      sources: sourcesForSurface,
    }, STATES),
    /bogus-key/, "引用不存在的声明须被校验器抓住",
  );
  /* 假接通：无适配器模板的源被派成 browse → 必抛（ghost 见 §2 前
   * 合成形态定义）。突变面适配（fix336/ui-fixes）：原突变挂
   * overview-video-rows，该面已随总览源行退场删除，改挂同为
   * browse 派生面的 channel-video，证伪形态不变。 */
  assert.throws(
    () => validateSurfaceDerivation({
      route: (s, d, c) => (s === "channel-video" && d?.id === "ghost"
        ? { kind: "browse", component: "SourceBrowse" }
        : routeForSurface(s, d, c)),
      sources: sourcesForSurface,
    }, [[ghost]]),
    /ghost/, "无适配器源被派 browse 须被校验器抓住",
  );
}

/* ══ 3. 规则交叉对账（契约侧独立规则：品类 × 能力 × 启用 → 期望类） ══ */
type Class = "applicable" | "notice" | "na";
const classOf = (r: SurfaceRoute): Class =>
  r.kind === "notice" ? "notice" : r.kind === "not-applicable" ? "na" : "applicable";
const nativeOf = (def: SourceDef) => def.adapter.template === "native-huangguo";

function expectedClass(surface: SurfaceId, def: SourceDef, active: SourceDef[]): Class {
  const sel = (cat: SourceDef["category"]) => resolveSelectedSource(def.id, sourcesForCategory(cat, active));
  switch (surface) {
    case "diag-export":
      return "applicable";
    case "selfcheck":
      return selfCheckEligible(def) ? "applicable" : "na";
    case "home-feed": case "overview-channels": case "inplace-search": case "discover":
      return nativeOf(def) ? "applicable" : "na";
    case "overview-posts": case "posts-page": {
      if (def.category !== "posts") return "na";
      const s = sel("posts");
      if (s.kind !== "active") return "notice";
      if (nativeOf(def)) return "applicable";
      return def.maturity === "blocked" ? "notice" : "applicable";
    }
    case "deeplink-image": case "deeplink-video": {
      const cat = surface === "deeplink-image" ? "image" : "video";
      if (def.category !== cat) return "na";
      const s = sel(cat);
      if (s.kind !== "active") return "notice";
      return def.maturity === "blocked" ? "notice" : "applicable";
    }
    case "channel-image": {
      /* 适配（fix336/ui-fixes）：总览源行两面删除，图片名单迁图
       * 片频道面——已启用∧非 blocked 走浏览、blocked 落提示、
       * 停用不适用（与 channel-video 同构）。 */
      if (def.category !== "image") return "na";
      if (!def.enabled) return "na";
      return def.maturity === "blocked" ? "notice" : "applicable";
    }
    case "channel-drama": {
      if (nativeOf(def)) return "applicable";
      if (def.category !== "video") return "na";
      return sourcesForChannel("ai-duanju", active).some((d) => d.id === def.id) ? "applicable" : "na";
    }
    case "channel-video": {
      /* 适配（fix336/ui-fixes）：原生空壳 chip 退场，原生×视频
       * 频道改声明出局（native-not-in-video-channel）。 */
      if (nativeOf(def)) return "na";
      if (def.category !== "video") return "na";
      if (!def.enabled) return "na";
      if (!sourcesForChannel("original", active).some((d) => d.id === def.id)) return "na";
      return def.maturity === "blocked" ? "notice" : "applicable";
    }
    case "search-fanout": case "search-external-detail": {
      if (nativeOf(def)) return "na";
      if (!def.enabled) return "na";
      return searchPolicyFor(def).include ? "applicable" : "na";
    }
    case "detail-post": {
      if (nativeOf(def)) return "applicable";
      if (def.category !== "posts") return "na";
      const s = sel("posts");
      if (s.kind !== "active") return "notice";
      return def.maturity === "blocked" ? "notice" : "applicable";
    }
    case "detail-gallery": {
      if (def.category !== "image") return "na";
      const s = sel("image");
      if (s.kind !== "active") return "notice";
      return def.maturity === "blocked" ? "notice" : "applicable";
    }
    case "play-external": {
      if (nativeOf(def)) return "applicable";
      if (def.category !== "posts" && def.category !== "video") return "na";
      const s = sel(def.category);
      if (s.kind !== "active") return "notice";
      if (def.maturity === "blocked") return "notice";
      return templateCapabilitiesFor(def).detailPlay ? "applicable" : "na";
    }
    case "library":
      /* G4 接通后（fix334/L3）：原生＋已启用∧有适配器的外部源适用；
       * 未启用不适用（与 deeplink 的「寻址即提示」分工不同——资料
       * 库是成员面、不是寻址面）。 */
      if (nativeOf(def)) return "applicable";
      if (!def.enabled) return "na";
      return templateHasAdapter(def.adapter.template) ? "applicable" : "na";
  }
}

for (const [si, state] of STATES.entries()) {
  const ctx = ctxOf(state);
  for (const surface of SURFACES) {
    for (const def of state) {
      const route = routeForSurface(surface.id, def, ctx);
      assert.equal(classOf(route), expectedClass(surface.id, def, state),
        `R${si + 1} ${surface.id} × ${def.id}：派生类须＝规则类`);
      /* notice 的 reason 须与 P2 三态交叉一致（停用/下线不许混淆）。 */
      if (route.kind === "notice" && route.reason !== "blocked") {
        const cat = surface.category;
        if (cat === "posts" || cat === "image" || cat === "video") {
          const s = resolveSelectedSource(def.id, sourcesForCategory(cat, state));
          assert.equal(route.reason, s.kind, `R${si + 1} ${surface.id} × ${def.id}：notice reason 须＝P2 三态`);
        }
      }
    }
    /* 出口一致性（设计断言 5）：sourcesForSurface 成员 ⇔ route 非不适用。 */
    const members = new Set(sourcesForSurface(surface.id, state).map((d) => d.id));
    for (const def of state) {
      assert.equal(members.has(def.id), routeForSurface(surface.id, def, ctx).kind !== "not-applicable",
        `R${si + 1} ${surface.id} × ${def.id}：列表成员⇔派生非不适用`);
    }
  }
}

/* ══ 4. 定点断言（用户可见不变量的具名样本） ══ */
{
  const ctx = ctxOf(R1);
  const byId = (id: string) => R1.find((s) => s.id === id)!;
  /* 原生谓词：全表恰一源为真；判据是模板不是 id 字面量（抗改名）。 */
  assert.deepEqual(R1.filter(isNativeSource).map((d) => d.id), ["huangguo"], "原生谓词全表恰一真");
  assert.equal(isNativeSource({ ...byId("hanime-tv"), adapter: { template: "native-huangguo" } }), true,
    "原生谓词认模板不认 id");
  assert.equal(isNativeSource({ ...byId("huangguo"), adapter: { template: "chigua" } }), false,
    "原生谓词认模板不认 id（反向）");
  /* 频道切源名单成员（适配 fix336/ui-fixes：总览源行两面删除，
   * 名单迁频道面——图片走 channel-image、视频走 channel-video；
   * 成员集合与原总览行逐字一致（007 退役、015/Konachan 启用进
   * 集，承 fix335/g-sources 口径），视频名单另摘原生（空壳退
   * 场、声明出局见下条）。 */
  assert.deepEqual(sourcesForSurface("channel-image", R1).map((d) => d.id),
    ["xiuren", "cosplaytele", "danbooru", "pixibb", "nudecosplay", "yandere", "konachan",
      /* 断言适配（fix338/realphoto-add）：everia/xsnvshen 启用入册、
       * 按注册表序居末。 */
      "everia", "xsnvshen"], "channel-image 成员＝已启用图片源");
  assert.deepEqual(sourcesForSurface("channel-video", R1).map((d) => d.id),
    ["hanime-tv", "hanime1", "iwara", "hentaihaven"], "channel-video 成员＝已启用外部视频源（原生不在名单）");
  assert.deepEqual(routeForSurface("channel-video", byId("huangguo"), ctx),
    { kind: "not-applicable", declaration: "native-not-in-video-channel" }, "原生×视频频道＝空壳退场声明出局");
  /* 搜索扇出成员：005（App 编号，feedheiliao）以声明 g 出局、001 以
   * 声明 b 出局；声明 h（hls-site 模板搜索不可用）的触发改由合成
   * hlsSiteFx 承接（适配 fix335/g-sources：007 退役、内置无 hls-site
   * 源）；015/Konachan 启用且有搜索段、新进成员（11→13 源）。
   * 断言适配（fix338/realphoto-add）：everia 启用且有搜索段、新进
   * 成员（13→14 源）；xsnvshen 为内置 hls-site 源且 caps.search=
   * false、以声明 h 出局（合成 hlsSiteFx 的触发与之同口径并存）。 */
  assert.deepEqual(sourcesForSurface("search-fanout", R1).map((d) => d.id),
    ["hanime-tv", "51chigua", "meiridasai", "xiuren", "cosplaytele", "danbooru", "hanime1", "iwara", "hentaihaven", "pixibb", "nudecosplay", "yandere", "konachan", "everia"],
    "M11 成员＝已启用∧有搜索段的外部源（14 源）");
  assert.deepEqual(routeForSurface("search-fanout", byId("huangguo"), ctx),
    { kind: "not-applicable", declaration: "native-dual-path" }, "001×M11 声明 b");
  assert.deepEqual(routeForSurface("search-fanout", byId("feedheiliao"), ctx),
    { kind: "not-applicable", declaration: "no-search-segment-feedheiliao" }, "005×M11 声明 g");
  assert.deepEqual(routeForSurface("search-fanout", hlsSiteFx, ctx),
    { kind: "not-applicable", declaration: "search-unusable-hls-site" }, "hls-site 合成源×M11 声明 h");
  /* 自检：001 在册（设计声明 c 与码上事实矛盾——selfCheckEligible(001)
   * 为真、引擎经 native 适配器实探，见报告设计订正）；R1 合格 15 源
   * （适配 fix335/g-sources：007 退役出集、015/Konachan 启用进集，14→15）。
   * 断言适配（fix338/realphoto-add）：everia/xsnvshen 启用且自检合格
   * 进集，15→17 源。 */
  assert.deepEqual(routeForSurface("selfcheck", byId("huangguo"), ctx), { kind: "listed" }, "001×M21 在册（订正设计声明 c）");
  assert.equal(sourcesForSurface("selfcheck", R1).length, 17, "M21 R1 合格集＝17 源");
  /* 短剧频道：外部 video 源以声明 e 出局（caps 映射属实为空）。 */
  assert.deepEqual(routeForSurface("channel-drama", byId("hanime-tv"), ctx),
    { kind: "not-applicable", declaration: "no-drama-mapping" }, "002×M6 声明 e");
  assert.deepEqual(sourcesForSurface("channel-drama", R1).map((d) => d.id), ["huangguo"], "M6 成员仅原生");
  /* 资料库：G4 已接通（fix334/L3 extRefs 快照侧表）——断言适配：
   * 原「g4-pending 在途声明」随 L3 落地转正，覆盖不减（转正＋未启
   * 用仍不适用两面都钉）。 */
  assert.deepEqual(routeForSurface("library", byId("hanime-tv"), ctx),
    { kind: "browse", component: "ProfileLibrary" }, "002×M17 G4 已接通");
  assert.deepEqual(routeForSurface("library", byId("gelbooru"), ctx),
    { kind: "not-applicable", declaration: "not-enabled" }, "未启用源×M17 不适用（适配 fix335/g-sources：原例 015 已启用、改挂 gelbooru）");
  /* 陈旧 id（def 缺失）在可寻址面落 gone 提示。 */
  assert.deepEqual(routeForSurface("deeplink-image", undefined, ctx), { kind: "notice", reason: "gone" }, "缺失源×M8＝gone");
  assert.deepEqual(routeForSurface("posts-page", undefined, ctx), { kind: "notice", reason: "gone" }, "缺失源×M10＝gone");
  /* 死面处置落账（D-4）：M20（diag-inapp）L1 时在元数据标死，
   * fix334/L4 集成已按清扫口径整面删除（函数/声明/wiring/接线
   * 断言同步移除）——面数 21 → 20、无 diag-inapp、现存面无 dead
   * 标注；dead 机制本身保留（校验器对 dead 面的处理在 §2b 突变
   * 自检的历史口径之外，此处只钉删除后的事实）。
   * 面数再落账（fix336/ui-fixes）：总览源行两面（overview-
   * image-rows/overview-video-rows）随总览改四频道行整面删除、
   * channel-image 新增承接图片频道名单——面数 20 → 19。 */
  assert.equal(SURFACES.length, 19, "面数落账：fix336 删总览源行两面＋增 channel-image 后 19 面");
  assert.ok(!SURFACES.some((s) => (s.id as string) === "diag-inapp"), "diag-inapp 已删除、不许复活");
  assert.ok(!SURFACES.some((s) => (s.id as string) === "overview-image-rows" || (s.id as string) === "overview-video-rows"),
    "总览源行两面已删除、不许复活（fix336）");
  assert.ok(SURFACES.every((s) => !(s as { dead?: string }).dead), "现存 19 面均无 dead 标注");
  /* 声明表每条都有理由文本（声明不许只剩 key）。 */
  for (const [key, decl] of Object.entries(SURFACE_DECLARATIONS)) {
    assert.ok(decl.reason.length > 0, `声明 ${key} 须有理由`);
  }
  /* 触发策略定点（设计 §1.5）：展示面 show-batch、浏览面 view-single、
   * 诊断面 none——与现行钩子落点文本对账（钩子在组件不在派生层，
   * 本批影子落位只声明策略，落点以源码文本钉住防漂移）。 */
  const topUpOf = (id: SurfaceId) => SURFACES.find((s) => s.id === id)?.topUp;
  assert.equal(topUpOf("overview-posts"), "show-batch");
  assert.equal(topUpOf("channel-image"), "show-batch", "图片频道面补探＝show-batch（切换器挂载批量补探）");
  assert.equal(topUpOf("channel-video"), "show-batch");
  assert.equal(topUpOf("detail-post"), "view-single");
  assert.equal(topUpOf("diag-export"), "none");
  assert.ok(srcText("../category/Category.tsx").includes("useSourceSelfCheckOnShow"), "总览行面 OnShow 落点在 Category");
  assert.ok(srcText("./SourceSwitcher.tsx").includes("useSourceSelfCheckOnShow"), "切换器 OnShow 落点（M3/M7/M10 共用）");
  /* Profile 消费断言（fix334 清扫已坏-3 补强）：routeForSurface 的
   * 全仓唯一生产消费者是 Profile 回访路由——此前本契约对该消费
   * 零断言、wiring 只查符号出现（import 行即满足），摘除实际调
   * 用全绿。断言钉实际调用形：摘调用只剩 import 必须变红。 */
  assert.ok(srcText("../account/Profile.tsx").includes("routeForSurface(surface, def, { active, builtin })"),
    "Profile 回访以实际调用形消费 routeForSurface 派生");
  for (const f of ["./SourcePosts.tsx", "./SourceGallery.tsx", "./SourceBrowse.tsx"]) {
    assert.ok(srcText(f).includes("useSourceSelfCheckOnView"), `${f} OnView 落点（view-single 宿主）`);
  }
}

/* ── R3 变体定点：停用 012 全面转提示/退出、015 启用态在各适用面成立 ── */
{
  const ctx = ctxOf(R3);
  const byId = (id: string) => R3.find((s) => s.id === id)!;
  const hh = byId("hentaihaven");
  assert.deepEqual(routeForSurface("deeplink-video", hh, ctx), { kind: "notice", reason: "disabled" }, "R3 012×M9＝停用提示");
  assert.deepEqual(routeForSurface("search-fanout", hh, ctx),
    { kind: "not-applicable", declaration: "not-enabled" }, "R3 011×M11 退出扇出");
  assert.ok(!sourcesForSurface("channel-video", R3).some((d) => d.id === "hentaihaven"), "R3 011 退出视频频道名单（原 M5 行、fix336 迁面）");
  const yd = byId("yandere");
  assert.deepEqual(routeForSurface("detail-gallery", yd, ctx), { kind: "browse", component: "SourceGallery" }, "R3 014×M15 自动接通");
  assert.ok(sourcesForSurface("channel-image", R3).some((d) => d.id === "yandere"), "R3 015 进入图片频道名单（原 M4 行、fix336 迁面）");
  assert.ok(sourcesForSurface("selfcheck", R3).some((d) => d.id === "yandere"), "R3 015 进入 M21 合格集");
  /* 015 进 M11（适配 fix335/g-sources）：moebooru 校准后 caps.search
   * 据实为 true、有搜索段——原「无搜索段出局」断言随事实翻转。 */
  assert.deepEqual(routeForSurface("search-fanout", yd, ctx),
    { kind: "browse", component: "SearchFanout" }, "R3 015×M11 有搜索段进扇出");
  /* R3×M17（fix334/L3）：停用 012 退出资料库成员、启用 015 自动进。 */
  assert.deepEqual(routeForSurface("library", hh, ctx),
    { kind: "not-applicable", declaration: "not-enabled" }, "R3 012×M17 停用退出");
  assert.deepEqual(routeForSurface("library", yd, ctx),
    { kind: "browse", component: "ProfileLibrary" }, "R3 015×M17 启用自动接通");
}

console.log("fix334-surfaces.contract: all assertions passed");
