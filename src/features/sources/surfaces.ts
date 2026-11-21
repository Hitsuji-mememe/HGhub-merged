/**
 * 展示面路由单一派生（Muse 2026-11-20 fix334 结构批 L1，设计
 * ~/workspace/hghub/fix334/design-g3g4-surfaces.md §1）。
 *
 * 背景（结构审计 O3）：注册表此前只派生「源列表」、不派生「面路由」——
 * 21 个展示面里真派生 8、半派生 3、其余靠纪律或组件内手写判定，同一
 * 事实（源在不在、能不能搜、停用还是下线）在各面各判一遍，G3（012
 * 选集无消费者）/G4（外部源收藏历史无回访）正是「规则说适用、面不
 * 存在」漏接的形状。本模块把面路由收敛为一处纯函数派生：输入＝
 * active 注册表（清单覆盖后）＋适配器能力事实（templateCapabilities）
 * ＋P2 的选中态三态派生（resolveSelectedSource），输出＝每个面对每个
 * 源的路由裁定。内部复用既有 sourcesForCategory/sourcesForChannel/
 * resolvePostsBrowse/searchPolicyFor/selfCheckEligible，不改它们的
 * 口径，只消灭各面再判一遍的副本。
 *
 * L1 定位＝影子落位：本模块先产出裁定并由完备性契约
 * （fix334-surfaces.contract.test.ts）守住，暂不替换各面现行判定；
 * 逐面换读归 L2/L3 接线。派生与现行裁定的对账见 L1 报告。
 *
 * L4 集成（2026-11-20）：死面 M20（diag-inapp，App 内源明细）已按
 * D-4 清扫口径删除——registryDiag 的 sourceHealthDetailLinesInApp
 * 无任何生产消费者，本表的 diag-inapp 条目、对应 wiring 条目与各
 * 契约的明细接线断言同步移除，面数 21 → 20。现存 20 面均无 dead
 * 标注；dead 机制保留给未来死面先标注后处置。
 *
 * fix336 集成（2026-11-20，用户亲定分类逻辑重定）：总览源行两面
 * （overview-image-rows/overview-video-rows）随总览改「只留频道
 * 行」整面删除（消费者 Category 总览已退场）；新增 channel-image
 * 面承接图片频道页的切源名单（与 channel-video 同构）；视频频道
 * 的原生空壳 chip 同批退场，channel-video × 原生改以声明
 * native-not-in-video-channel 显式出局。面数 20 → 19。
 *
 * fix3314 集成（2026-11-21，用户亲定视频板块整组删除）：视频频
 * 道面（channel-video）与视频深链面（deeplink-video）随板块删
 * 除整面退场，声明 native-not-in-video-channel 同删（无格可
 * 用）；channel-drama 的外部浏览尾巴（SourceBrowse 已删、无外
 * 部承接组件）收敛为声明出局，play-external 品类收敛为帖子。
 * 面数 19 → 17。
 *
 * 语义约定：
 * - route 回答「该面与该源的关系」：native＝走仓内既有 api 通道
 *   （仅 001）；browse＝经外部浏览组件/加载器接通；notice＝诚实提示
 *   （reason 与 SourcePendingNotice 三分支同口径：blocked 站点不可
 *   达、disabled 清单停用、gone 已移除）；listed＝该面以列示/计划
 *   形态包含该源（诊断列示、自检计划）；
 *   not-applicable＝显式不适用，必须引用声明表条目、不许静默缺席。
 * - def=undefined 只对可寻址面（addressed：总览吃瓜/吃瓜页/深链/
 *   详情/播放）有意义，落 notice(gone)（陈旧 id 的诚实提示）；其余
 *   面回 not-applicable(category-mismatch)。
 * - 品类先于选中态：routeForSurface 是逐源派生，跨品类源直接不适
 *   用；「按陈旧 id 寻址到异品类源」的选择时行为仍归 P2 的
 *   resolveSelectedSource（已上线口径：落 disabled 提示），两者
 *   不冲突——接线面以本派生取本品类源表、以 P2 解析原始 id。
 * - sourcesForSurface＝该面有确定行为的源集（route 非 not-applicable
 *   者），与 routeForSurface 由 validateSurfaceDerivation 断言互为
 *   一致，不许两个出口各算一套。
 * - 状态徽标不归本模块：全 App 状态只读 healthCheck 的四态单一
 *   派生；本模块只组合「源在不在」（P2）与「面走哪条路」，不新建
 *   状态派生（设计 §1.5）。
 *
 * 设计订正（以码上事实为准，详见 L1 报告）：①设计声明 c（001×自检
 * 不适用）与事实矛盾——selfCheckEligible(001)=true、引擎经 native
 * 适配器实探，M21 对 001 为 listed，本表不设 c；②设计 §1.3 称搜索
 * 资格根源在 chigua 的 searchPath 参数——现行生产口径是「模板探针
 * ∧ capabilities.search 声明」（M3 收口后），searchPath 只决定 URL
 * 形态，能力表按现行口径派生；③SurfaceRoute 增 listed 一类：诊断
 * 列示/自检计划/总览行列示三面是「在册」语义，设计四类（native/
 * browse/notice/not-applicable）无处安放。
 */
import { getBuiltinRegistry, sourcesForCategory, sourcesForChannel } from "./registry.ts";
import { resolvePostsBrowse } from "./postsRoute.ts";
import { resolveSelectedSource } from "./selectedSource.ts";
import { templateCapabilitiesFor } from "./adapters/templateCapabilities.ts";
import { templateHasAdapter } from "./adapters/templateSegments.ts";
import { searchPolicyFor } from "../search/multiSourceSearch.ts";
import { selfCheckEligible } from "./healthCheck.ts";
import type { SourceCategory, SourceDef } from "./types.ts";

/* ── 面枚举与元数据（17 面，与设计 §1.1 同编号语义；原第 21 面
 * M20 diag-inapp 为死面已于 fix334/L4 删除，总览源行两面已于
 * fix336 删除、channel-image 同批新增，视频两面已于 fix3314
 * 随视频板块删除，见文件头） ── */
export interface SurfaceMeta {
  id: string;
  /** 面的品类口径：具体品类／all＝跨品类／native-only＝原生构成面。 */
  category: SourceCategory | "all" | "native-only";
  /** 自检补探触发策略声明（设计 §1.5）：执行仍归 sourceHealth/
   * healthCheck，本处只声明、契约对账现行钩子落点。 */
  topUp: "view-single" | "show-batch" | "none";
  /** 死面标注（D-4）：生产消费者为 0 的面在此明示，不冒充活面。
   * 机制保留：新死面出现时先标注、再按清扫口径处置（M20 即经
   * 此标注后于 L4 删除）。 */
  dead?: string;
}

export const SURFACES = [
  { id: "home-feed", category: "native-only", topUp: "none" },
  { id: "overview-channels", category: "native-only", topUp: "none" },
  { id: "overview-posts", category: "posts", topUp: "show-batch" },
  { id: "channel-drama", category: "video", topUp: "none" },
  { id: "channel-image", category: "image", topUp: "show-batch" },
  { id: "deeplink-image", category: "image", topUp: "view-single" },
  { id: "posts-page", category: "posts", topUp: "show-batch" },
  { id: "search-fanout", category: "all", topUp: "none" },
  { id: "search-external-detail", category: "all", topUp: "none" },
  { id: "inplace-search", category: "native-only", topUp: "none" },
  { id: "detail-post", category: "posts", topUp: "view-single" },
  { id: "detail-gallery", category: "image", topUp: "view-single" },
  { id: "play-external", category: "all", topUp: "view-single" },
  { id: "library", category: "all", topUp: "none" },
  { id: "discover", category: "native-only", topUp: "none" },
  { id: "diag-export", category: "all", topUp: "none" },
  { id: "selfcheck", category: "all", topUp: "none" },
] as const satisfies readonly SurfaceMeta[];

export type SurfaceId = (typeof SURFACES)[number]["id"];

export type BrowseComponent =
  | "SourcePosts" | "SourceGallery"
  | "SearchFanout" | "SearchExternalDetail" | "ProfileLibrary";

export type SurfaceRoute =
  | { kind: "native" }
  | { kind: "browse"; component: BrowseComponent }
  | { kind: "notice"; reason: "blocked" | "disabled" | "gone" }
  | { kind: "listed" }
  | { kind: "not-applicable"; declaration: string };

export interface SurfaceContext {
  /** 清单覆盖后的生效注册表。 */
  active: SourceDef[];
  /** 全量内置注册表（仅供口径对照；三态判定由 resolveSelectedSource 内部查表）。 */
  builtin: SourceDef[];
}

/* ── 不适用声明表（设计 §1.4；每条带理由，契约校验其与事实一致、
 * 且每条至少被一格实际使用——声明腐烂与未声明缺席同样判红） ── */
export const SURFACE_DECLARATIONS: Record<string, { reason: string }> = {
  "category-mismatch": {
    reason: "品类不符：该面品类与源 category 不匹配，结构性不适用（设计声明 a）",
  },
  "native-dual-path": {
    reason: "001×搜索扇出/搜索详情：原生视频＋帖子双路已完整覆盖，扇出排除由本声明表达（Search.tsx FANOUT_EXCLUDE_NATIVE 的既有口径，设计声明 b）",
  },
  "native-only-surface": {
    reason: "外部源×首页/总览频道/发现面：原生构成面（D-1 默认口径＝有意原生专属；改口径时改本声明一处、契约全表复核，设计声明 d）",
  },
  "no-drama-mapping": {
    reason: "外部 video 源×短剧频道：短剧频道只走原生通道，外部源无承接组件（原 SourceBrowse 已随 fix3314 视频板块删除退场）；sourcesForChannel(ai-duanju) 映射属实为空（设计声明 e 沿革）",
  },
  "no-inplace-search": {
    reason: "外部源×站内搜索：浏览面无站内搜索入口，全局扇出已覆盖外部搜索，面内搜索为原生 api 专用（D-5 默认口径，设计声明 f）",
  },
  "no-search-segment-feedheiliao": {
    reason: "005（feedheiliao）×搜索面：无可用 GET 搜索段——三种 GET 搜索形态实证均返回关键词不变页，注册表 capabilities.search=false（设计声明 g）",
  },
  "search-unusable-hls-site": {
    reason: "hls-site 模板×搜索面：模板搜索不可用——实证（已退役的 pornpics，fix335/g-sources 前为内置唯一 hls-site 源）：/?s= 跳首页无条目、站方搜索 404，capabilities.search=false（设计声明 h）",
  },
  "not-enabled": {
    reason: "未启用（内置未启用或清单停用）：注册保留、启用即自动进入全部适用面（设计声明 i）",
  },
  "no-search-segment": {
    reason: "无搜索段：模板无 search 实现或注册表未声明 capabilities.search（searchPolicyFor 结构门），不进搜索扇出（源保留、频道浏览不受此限）",
  },
  "blocked-not-probed": {
    reason: "blocked/preview 源不自检：点开都不拉数据、自检更不探（healthCheck.selfCheckEligible 现行口径）",
  },
  "no-adapter": {
    reason: "模板无适配器（template=none/未知模板）：无 detail/resolve 段，任何浏览/播放面都无从接通（注册表完整性契约本应挡下 enabled 的此形态，本条只作派生兜底）",
  },
};

/** 全仓唯一原生谓词：以模板为判据（抗源改名），不认 id 字面量。 */
export function isNativeSource(def: SourceDef): boolean {
  return def.adapter.template === "native-huangguo";
}

/** 原生源 id 的单一出处（fix335/e-category 收敛）：由模板判据自
 * 内置注册表派生——需要以 id 形态引用原生源的面（频道页切源片
 * 的原生选项/回落值）一律经此取值，不许再写 id 字面量。 */
export function nativeSourceId(): string {
  const def = getBuiltinRegistry().find(isNativeSource);
  if (!def) throw new Error("surfaces 完备性：内置注册表缺原生源（template=native-huangguo）");
  return def.id;
}

const na = (declaration: string): SurfaceRoute => ({ kind: "not-applicable", declaration });
const notice = (reason: "blocked" | "disabled" | "gone"): SurfaceRoute => ({ kind: "notice", reason });
const browse = (component: BrowseComponent): SurfaceRoute => ({ kind: "browse", component });
const NATIVE: SurfaceRoute = { kind: "native" };
const LISTED: SurfaceRoute = { kind: "listed" };

/** 可寻址面：以陈旧/任意 id 寻址时 def 缺失落 gone 提示的面。 */
const ADDRESSED: ReadonlySet<SurfaceId> = new Set([
  "overview-posts", "posts-page", "deeplink-image",
  "detail-post", "detail-gallery", "play-external",
]);

/** browse 前置守卫：无适配器的 def 在任何面都无从接通（派生兜底）。 */
function browseOrNoAdapter(def: SourceDef, component: BrowseComponent): SurfaceRoute {
  return templateHasAdapter(def.adapter.template) ? browse(component) : na("no-adapter");
}

export function routeForSurface(
  surface: SurfaceId,
  def: SourceDef | undefined,
  ctx: SurfaceContext,
): SurfaceRoute {
  if (!def) return ADDRESSED.has(surface) ? notice("gone") : na("category-mismatch");
  const sel = (cat: SourceCategory) => resolveSelectedSource(def.id, sourcesForCategory(cat, ctx.active));

  switch (surface) {
    /* 原生构成面（D-1）：只有 001，外部源显式不适用。 */
    case "home-feed":
    case "overview-channels":
    case "discover":
      return isNativeSource(def) ? NATIVE : na("native-only-surface");
    case "inplace-search":
      return isNativeSource(def) ? NATIVE : na("no-inplace-search");

    /* 吃瓜总览/全量页：与现行同口径——P2 三态 × resolvePostsBrowse。 */
    case "overview-posts":
    case "posts-page": {
      if (def.category !== "posts") return na("category-mismatch");
      const s = sel("posts");
      if (s.kind === "disabled") return notice("disabled");
      if (s.kind === "gone") return notice("gone");
      const r = resolvePostsBrowse(def);
      if (r === "native") return NATIVE;
      if (r === "blocked") return notice("blocked");
      return browseOrNoAdapter(def, "SourcePosts");
    }

    /* 短剧频道：只走原生通道；外部 video 源以声明 e 出局（频道
     * 映射属实为空、且原承接组件 SourceBrowse 已随视频板块删
     * 除退场，fix3314），外部源不充数。 */
    case "channel-drama": {
      if (isNativeSource(def)) return NATIVE;
      if (def.category !== "video") return na("category-mismatch");
      return na("no-drama-mapping");
    }

    /* 图片频道（fix336 新增，与 channel-video 同构）：切源片＝
     * 已启用图片源（sourcesForCategory("image")），默认落点按
     * 最近打开记忆/首个可用源（selectedSource.defaultSourceId）；
     * blocked 源留在片上挂状态徽标、点开落诚实提示（notice），
     * 停用源不进选项（not-enabled）。 */
    case "channel-image": {
      if (def.category !== "image") return na("category-mismatch");
      if (!def.enabled) return na("not-enabled");
      if (def.maturity === "blocked") return notice("blocked");
      return browseOrNoAdapter(def, "SourceGallery");
    }

    /* 深链：寻址单源——在册走组件、blocked/停用/下线各落其提示。
     * （fix3314：原 deeplink-video 面随视频板块删除退场，视频类
     * 陈旧回访在资料库面直接落不可用告知。） */
    case "deeplink-image": {
      if (def.category !== "image") return na("category-mismatch");
      const s = sel("image");
      if (s.kind === "disabled") return notice("disabled");
      if (s.kind === "gone") return notice("gone");
      if (def.maturity === "blocked") return notice("blocked");
      return browseOrNoAdapter(def, "SourceGallery");
    }

    /* 搜索扇出/外部详情：纳入只从 searchPolicyFor（结构门），001
     * 的排除由声明 b 表达；无搜索段按事实分声明（g/h/通用）。 */
    case "search-fanout":
    case "search-external-detail": {
      if (isNativeSource(def)) return na("native-dual-path");
      if (!def.enabled) return na("not-enabled");
      if (searchPolicyFor(def).include) {
        return browse(surface === "search-fanout" ? "SearchFanout" : "SearchExternalDetail");
      }
      if (def.adapter.template === "chigua") return na("no-search-segment-feedheiliao");
      if (def.adapter.template === "hls-site") return na("search-unusable-hls-site");
      return na("no-search-segment");
    }

    /* 帖子详情：经吃瓜面到达，选中态与 M3/M10 同口径。 */
    case "detail-post": {
      if (isNativeSource(def)) return NATIVE;
      if (def.category !== "posts") return na("category-mismatch");
      const s = sel("posts");
      if (s.kind === "disabled") return notice("disabled");
      if (s.kind === "gone") return notice("gone");
      if (def.maturity === "blocked") return notice("blocked");
      return browseOrNoAdapter(def, "SourcePosts");
    }

    /* 图集详情：001 无图集详情面（品类不符），外部图片源走相册。 */
    case "detail-gallery": {
      if (def.category !== "image") return na("category-mismatch");
      const s = sel("image");
      if (s.kind === "disabled") return notice("disabled");
      if (s.kind === "gone") return notice("gone");
      if (def.maturity === "blocked") return notice("blocked");
      return browseOrNoAdapter(def, "SourceGallery");
    }

    /* 外部播放：resolve 链的可用性——品类（帖子）×在册×非
     * blocked×detail 段在；宿主为 SourcePosts 与搜索详情层，路由
     * 只答可达性、component 记主宿主。（fix3314：视频品类随板块
     * 删除退出本面。） */
    case "play-external": {
      if (isNativeSource(def)) return NATIVE;
      if (def.category !== "posts") return na("category-mismatch");
      const s = sel(def.category);
      if (s.kind === "disabled") return notice("disabled");
      if (s.kind === "gone") return notice("gone");
      if (def.maturity === "blocked") return notice("blocked");
      if (!templateCapabilitiesFor(def).detailPlay) return na("no-adapter");
      return browseOrNoAdapter(def, "SourcePosts");
    }

    /* 资料库：原生已接；外部源自 fix334/L3（G4）起经 extRefs 快照
     * 侧表接通——收藏/历史在 Profile 以快照出卡、点开经 openExternalId
     * 回访对应源面（落点再由该面的派生裁定现状：停用/下线/blocked
     * 落诚实提示，快照不冒充现状）。未启用源不进资料库成员。 */
    case "library": {
      if (isNativeSource(def)) return NATIVE;
      if (!def.enabled) return na("not-enabled");
      return browseOrNoAdapter(def, "ProfileLibrary");
    }

    /* 诊断列示：全注册表在册（含停用源的计数），无逐源导航。 */
    case "diag-export":
      return LISTED;

    /* 自检计划：合格集＝selfCheckEligible（唯一口径）；不合格按
     * 原因分声明（未启用／blocked·preview 不探）。001 经 native
     * 适配器实探、在册（订正设计声明 c，见文件头）。 */
    case "selfcheck": {
      if (selfCheckEligible(def)) return LISTED;
      if (!def.enabled) return na("not-enabled");
      return na("blocked-not-probed");
    }
  }
}

/** 该面有确定行为的源集（route 非 not-applicable 者，注册表序）。 */
export function sourcesForSurface(surface: SurfaceId, active: SourceDef[]): SourceDef[] {
  const ctx: SurfaceContext = { active, builtin: getBuiltinRegistry() };
  return active.filter((def) => {
    const r = routeForSurface(surface, def, ctx);
    if (!r || typeof r.kind !== "string") {
      throw new Error(`surfaces 完备性：${surface} × ${def.id} 派生缺失（面有漏格）`);
    }
    return r.kind !== "not-applicable";
  });
}

export interface SurfaceDerivation {
  route: (surface: SurfaceId, def: SourceDef | undefined, ctx: SurfaceContext) => SurfaceRoute;
  sources: (surface: SurfaceId, active: SourceDef[]) => SourceDef[];
}

/**
 * 完备性校验（设计 §2）：对每组注册表状态 × 全面 × 全源断言——
 * ①派生有定义；②browse 必有适配器且面所需能力与能力事实一致
 * （搜索面须 search、播放面须 detailPlay）；③not-applicable 必引
 * 用声明表内条目；④sources 出口与 route 出口互为一致；⑤声明表
 * 每条至少被一格使用（防声明腐烂成第二个手写名单）。
 * extraStates 为合成注册表状态（如无适配器/ blocked 启用形态），
 * 只为覆盖状态依存声明，不参与常态遍历口径。
 * 任一违反即抛错（契约据此判红）。
 */
export function validateSurfaceDerivation(
  d: SurfaceDerivation,
  states: SourceDef[][],
  extraStates: SourceDef[][] = [],
): void {
  const usedDeclarations = new Set<string>();
  for (const state of [...states, ...extraStates]) {
    const ctx: SurfaceContext = { active: state, builtin: getBuiltinRegistry() };
    for (const meta of SURFACES) {
      const members = new Set(d.sources(meta.id, state).map((s) => s.id));
      for (const def of state) {
        const r = d.route(meta.id, def, ctx);
        if (!r || typeof r !== "object" || typeof (r as SurfaceRoute).kind !== "string") {
          throw new Error(`surfaces 完备性：${meta.id} × ${def.id} 派生缺失（面有漏格）`);
        }
        if (r.kind === "browse") {
          if (!templateHasAdapter(def.adapter.template)) {
            throw new Error(`surfaces 完备性：${meta.id} × ${def.id} 无适配器却派 browse`);
          }
          if ((meta.id === "search-fanout" || meta.id === "search-external-detail")
            && !templateCapabilitiesFor(def).search) {
            throw new Error(`surfaces 完备性：${meta.id} × ${def.id} 无搜索段却派 browse`);
          }
          if (meta.id === "play-external" && !templateCapabilitiesFor(def).detailPlay) {
            throw new Error(`surfaces 完备性：play-external × ${def.id} 无 detail 段却派 browse`);
          }
        }
        if (r.kind === "not-applicable") {
          if (!(r.declaration in SURFACE_DECLARATIONS)) {
            throw new Error(`surfaces 完备性：${meta.id} × ${def.id} 引用不存在的声明 ${r.declaration}`);
          }
          usedDeclarations.add(r.declaration);
        }
        if (members.has(def.id) !== (r.kind !== "not-applicable")) {
          throw new Error(`surfaces 完备性：${meta.id} × ${def.id} 两出口不一致（sources 成员=${members.has(def.id)}、route=${r.kind}）`);
        }
      }
    }
  }
  for (const key of Object.keys(SURFACE_DECLARATIONS)) {
    if (!usedDeclarations.has(key)) {
      throw new Error(`surfaces 完备性：声明 ${key} 无任一格使用（声明腐烂）`);
    }
  }
}
