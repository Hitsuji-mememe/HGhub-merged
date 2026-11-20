/**
 * 模板能力事实（Muse 2026-11-20 fix334 结构批 L1，设计 §1.3）。
 *
 * 单一出处口径：能力事实只许从工厂本身派生或在此一处声明，不许各
 * 消费面再抄一份模板名单（3.3.3 M3 已把 search 段事实收敛到
 * templateSegments 的探针派生，本模块在其上补 detailPlay 与
 * episodes 形态，供 surfaces.ts 派生与完备性契约消费）：
 * - search＝探针派生（templateHasSearch：工厂真有 search 方法）
 *   ∧ 注册表对该 def 的 capabilities.search 声明——与
 *   multiSourceSearch.missingSearchSegments 的现行生产口径逐字
 *   一致（chigua 的 searchPath 参数决定 URL 形态、不是资格门；
 *   005 无搜索段的事实由其 caps.search=false 表达，证据在注册表
 *   note）。签名吃 def 正因资格是「模板 × 该源声明」的合取。
 * - detailPlay＝适配器存在（templateHasAdapter）：detail/resolve
 *   在 SourceAdapter 类型上必填，有适配器即两段皆在。例外
 *   preview-only：适配器存在、detail 是预览桩、resolve 按产品
 *   口径拒绝——detailPlay 对其为 true 只表示 detail 段在，播放
 *   可达性另由 surfaces 的品类/启用规则与 missingSearchSegments
 *   的 preview-only 分叉表达，不许只读本字段判可播。
 * - episodes＝逐模板代码事实声明（detail 的 episodes 产出形态，
 *   无法靠构造探针得出——须取页才知）：multi 只有 hentaihaven-api
 *   （detail 扫 episode-<n> 链接产多集，其余模板至多单条「正片」
 *   或空数组）。声明在此一处登记，完备性契约以行为夹具钉住
 *   multi/single 两端（012 实产 2 集、hls-site 至多 1 条），且断言
 *   本表显式覆盖每个有适配器的模板——新模板漏登即契约红。
 *   注意与注册表 capabilities.episodes 分层：caps 是品类映射
 *   事实（短剧频道归类门），本表是模板产出事实（选集面用）。
 *   012 两者不一致（caps=false、模板 multi）经 fix334/L2 裁定
 *   保留分层：caps 翻 true 会让里番源进短剧频道切源名单（消费
 *   面核对见 L2 报告），故不翻；选集面只读本表 multi、不读
 *   caps，不许在本表迁就 caps 改判、也不许选集面改读 caps。
 * - 发现维度（fix335/f-discovery）：discoverySpecFor 在本文件尾
 *   段登记各源可切换的分类/排序/榜单维度，口径同上——只许在此
 *   一处声明、未实证不登记，证据与日期随登记同行。
 */
import type { SourceDef } from "../types.ts";
import { templateHasAdapter, templateHasSearch } from "./templateSegments.ts";
import {
  DANBOORU_ORDER_PRESETS,
  HANIME1_SORT_VALUES,
  HENTAIHAVEN_PERIOD_OPTIONS,
  IWARA_SORT_OPTIONS,
  readDiscoveryCategories,
} from "./templates.ts";

export type EpisodesForm = "none" | "single" | "multi";

export interface TemplateCapabilities {
  /** 该 def 可用搜索段（模板有 search ∧ 注册表声明）。 */
  search: boolean;
  /** detail 段在（适配器存在）；播放可达性见文件头 preview-only 注。 */
  detailPlay: boolean;
  /** detail 的 episodes 产出形态。 */
  episodes: EpisodesForm;
}

/** episodes 形态逐模板登记（代码事实，证据见文件头与契约行为钉）。 */
export const EPISODES_FORM_BY_TEMPLATE: Record<string, EpisodesForm> = {
  "native-huangguo": "none", // nativeHuangguo.ts detail 恒 episodes: []（原生选集走仓内 api）
  chigua: "single", // htmlDetail：有流时单条「正片」
  "hls-site": "single", // htmlDetail 同上
  "wp-rest": "none", // detail episodes: []
  "danbooru-api": "none", // detail episodes: []
  "swag-api": "none", // detail episodes: []
  "redgifs-api": "single", // detail 单条「正片」
  "hanime-api": "single", // hanimeApi detail 单条「正片」
  "iwara-api": "single", // detail 单条「正片」
  hanime1: "single", // detail 有源时单条「正片」
  "hentaihaven-api": "multi", // detail 扫 episode-<n> 链接产多集（全仓唯一 multi）
  "preview-only": "none", // 预览桩 detail episodes: []
};

/** 模板的 episodes 产出形态；未登记/未知模板回落 none（不冒充有集数）。 */
export function episodesFormOf(template: string): EpisodesForm {
  return EPISODES_FORM_BY_TEMPLATE[template] ?? "none";
}

/** 该 def 的模板能力事实（唯一出处，surfaces 派生与契约只读这里）。 */
export function templateCapabilitiesFor(def: SourceDef): TemplateCapabilities {
  const t = def.adapter.template;
  return {
    search: templateHasSearch(t) && def.capabilities.search,
    detailPlay: templateHasAdapter(t),
    episodes: episodesFormOf(t),
  };
}

/* ── 发现维度登记（Muse 2026-11-20 fix335/f-discovery）──
 * 各源列表可切换的分类/排序/榜单维度只在此一处登记（DiscoverySpec），
 * DiscoveryBar 与契约只读这里；未实证不登记——没有实测证据的维度
 * 宁可不出现，也不许拿推测拼参数（010 的 sort 须繁体原值、012 的
 * weekly 被站方拒绝，都是「猜参数会静默错位」的实证教训）。
 * 证据统一出处：fix335/evidence/f-probes.md（机房探针）＋
 * fix335/evidence/f-residential-verify.md（住宅终验），2026-11-20。
 * 协议值表（009 预设/010 九值/011 三值/012 两值）在 templates.ts
 * 与适配器同文件定义、本表引用同一常量，不另抄。 */

export interface DiscoveryOption {
  value: string;
  label: string;
}

export interface DiscoverySpec {
  /** 分类维度：params＝注册表栏目表（吃瓜三源，options 已填）；
   * taxonomy＝运行时经适配器 taxonomy() 取 categories（WP/002，
   * options 恒空、由 DiscoveryBar 填充）。 */
  categories?: { source: "params" | "taxonomy"; options: DiscoveryOption[] };
  /** 标签过滤维度（选项经 taxonomy() 的 tags，Top-N 呈现）。 */
  tagFilter?: boolean;
  /** 排序维度：options 含默认值项，点选默认值＝清除该维度。 */
  sorts?: DiscoveryOption[];
  sortDefault?: string;
  /** 榜单周期维度（仅 012）：同 sorts 的默认值口径。 */
  rankPeriods?: DiscoveryOption[];
  periodDefault?: string;
  /** 登记证据与日期（空 spec 为空串）。 */
  evidence: string;
}

export const EMPTY_DISCOVERY_SPEC: DiscoverySpec = { evidence: "" };

/** spec 是否登记了任一维度。 */
export function hasDiscovery(spec: DiscoverySpec): boolean {
  return Boolean(spec.categories || spec.tagFilter || spec.sorts?.length || spec.rankPeriods?.length);
}

const F_EVIDENCE = "fix335 探针＋住宅终验 2026-11-20（f-probes.md／f-residential-verify.md）";

/** 该 def 的发现维度登记（唯一出处）。未登记的源返回空 spec。 */
export function discoverySpecFor(def: SourceDef): DiscoverySpec {
  const t = def.adapter.template;
  switch (t) {
    case "chigua": {
      /* 栏目归档：栏目表与 categoryPath 模板都在注册表 params
       * （唯一出处）；缺任一即不登记。两类栏目未入栏目表（登记只
       * 会得到恒解析为空的错误页）：①公告存档栏目（003 往期活动/
       * 004 主题大赛，内容被推广过滤 announcementCats 全覆盖）；
       * ②003 每日大赛——该栏目全数是「每日大赛之【…】」征集帖、
       * 被推广过滤的大赛组合判据全覆盖（2026-11-20 实抓分类页
       * 25/25 卡命中，量测见 F 线报告）。004 的每日大赛无此组合
       * 判据（未声明 contestCat），照常登记。 */
      const params = (def.adapter.params ?? {}) as Record<string, unknown>;
      const cats = readDiscoveryCategories(def);
      if (typeof params.categoryPath !== "string" || !params.categoryPath || cats.length === 0) return EMPTY_DISCOVERY_SPEC;
      return {
        categories: { source: "params", options: cats.map((c) => ({ value: c.slug, label: c.name })) },
        evidence: `栏目归档模板与栏目表经首页导航实证（${F_EVIDENCE}）`,
      };
    }
    case "wp-rest":
      /* taxonomy 端点（categories 20/tags 1198 为 006 实测规模）与
       * orderby/categories/tags 过滤参数经探针实证；chips 只许
       * Top-N（DiscoveryBar 截断），不许全量平铺。 */
      return {
        categories: { source: "taxonomy", options: [] },
        tagFilter: true,
        sorts: [
          { value: "", label: "最新" },
          { value: "date-asc", label: "最早" },
        ],
        sortDefault: "",
        evidence: `taxonomy 端点与 orderby/过滤参数经探针实证（${F_EVIDENCE}）`,
      };
    case "hanime-api":
      /* 002 客户端维度：目录全量在本地缓存，brand 过滤/tag 过滤/
       * views 重排全在内存（服务端无对应参数）。009 的 tagFilter
       * 不在此列——danbooru 无选项来源、标签走既有搜索段。 */
      return {
        categories: { source: "taxonomy", options: [] },
        tagFilter: true,
        sorts: [
          { value: "", label: "最新" },
          { value: "views", label: "最热" },
        ],
        sortDefault: "",
        evidence: `目录行 brand/tags/views 字段与客户端重排经探针实证（${F_EVIDENCE}）`,
      };
    case "danbooru-api":
      /* 只登记 009 本尊：三预设只在 danbooru 站实证，同模板的
       * gelbooru/yandere 未验——未实证不登记（yandere 随启用批
       * 另行复测，见 G 线登记）。 */
      if (def.id !== "danbooru") return EMPTY_DISCOVERY_SPEC;
      return {
        sorts: [{ value: "", label: "最新" }, ...DANBOORU_ORDER_PRESETS],
        sortDefault: "",
        evidence: `order:rank/score/favcount 三预设经住宅终验严格降序（${F_EVIDENCE}）`,
      };
    case "hanime1":
      /* 九值逐字繁体原值（HANIME1_SORT_VALUES），label 即原值；
       * 简体拼法被站方静默回落默认序——实现红线。 */
      return {
        sorts: HANIME1_SORT_VALUES.map((v) => ({ value: v, label: v })),
        sortDefault: "最新上市",
        evidence: `九个 sort 繁体原值逐值实证（${F_EVIDENCE}）`,
      };
    case "iwara-api":
      return {
        sorts: IWARA_SORT_OPTIONS,
        sortDefault: "views",
        evidence: `sort=views/likes/date 三值返回集各异经探针实证（${F_EVIDENCE}）`,
      };
    case "hentaihaven-api":
      /* 只登记 monthly/all：weekly/daily 被站方应用层拒绝
       * （Unsupported trending period），不得登记。 */
      return {
        rankPeriods: HENTAIHAVEN_PERIOD_OPTIONS,
        periodDefault: "monthly",
        evidence: `trending_period 两值可用、weekly/daily 被应用层拒绝经探针实证（${F_EVIDENCE}）`,
      };
    default:
      /* hls-site/swag/redgifs/preview/native 及未实证模板：一律
       * 不登记（未实证不登记）。 */
      return EMPTY_DISCOVERY_SPEC;
  }
}
