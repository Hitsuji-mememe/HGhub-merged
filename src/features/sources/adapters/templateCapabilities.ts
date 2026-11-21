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
 *   在 SourceAdapter 类型上必填，有适配器即两段皆在；播放可达性
 *   另由 surfaces 的品类/启用规则表达，不许只读本字段判可播。
 * - episodes＝逐模板代码事实声明（detail 的 episodes 产出形态，
 *   无法靠构造探针得出——须取页才知）：现行无 multi 登记——唯一
 *   multi 模板 hentaihaven-api（detail 扫 episode-<n> 链接产多
 *   集）已于 fix338/registry-cut 随 011 摘除同删，其余模板至多
 *   单条「正片」或空数组。声明在此一处登记，完备性契约以行为
 *   夹具钉住 single 端（hls-site 至多 1 条），且断言本表显式覆
 *   盖每个有适配器的模板——新模板漏登即契约红。选集面
 *   （episodes.ts）machinery 保留：现行无源触发、未来新 multi
 *   模板在此登记即复活，不另起接线。
 *   注意与注册表 capabilities.episodes 分层：caps 是品类映射
 *   事实（短剧频道归类门），本表是模板产出事实（选集面用）；
 *   选集面只读本表 multi、不读 caps，不许在本表迁就 caps 改
 *   判、也不许选集面改读 caps（fix334/L2 裁定）。
 * - 发现维度（fix335/f-discovery）：discoverySpecFor 在本文件尾
 *   段登记各源可切换的分类/排序/榜单维度，口径同上——只许在此
 *   一处声明、未实证不登记，证据与日期随登记同行。
 */
import type { SourceDef } from "../types.ts";
import { templateHasAdapter, templateHasSearch } from "./templateSegments.ts";
import { readDiscoveryRanks } from "./templates.ts";

export type EpisodesForm = "none" | "single" | "multi";

export interface TemplateCapabilities {
  /** 该 def 可用搜索段（模板有 search ∧ 注册表声明）。 */
  search: boolean;
  /** detail 段在（适配器存在）；播放可达性见文件头注。 */
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
  "hanime-api": "single", // hanimeApi detail 单条「正片」
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
 * 宁可不出现，也不许拿推测拼参数（009 hanime1 的 sort 须繁体原值、011 的
 * weekly 被站方拒绝，都是「猜参数会静默错位」的实证教训）。
 * 证据统一出处：fix335/evidence/f-probes.md（机房探针）＋
 * fix335/evidence/f-residential-verify.md（住宅终验），2026-11-20。
 * 协议值表在 templates.ts 与适配器同文件定义、本表引用同一
 * 常量，不另抄（009 九值表于 fix3311/registry-cleanup 随 009 试装
 * 判删同删；010 三值表在册保留）。 */

export interface DiscoveryOption {
  value: string;
  label: string;
}

export interface DiscoverySpec {
  /** 分类维度：taxonomy＝运行时经适配器 taxonomy() 取 categories
   * （WP/002，options 恒空、由 DiscoveryBar 填充）；params 形态随
   * fix337 吃瓜面分类轴下线已无登記者（类型保留）。 */
  categories?: { source: "params" | "taxonomy"; options: DiscoveryOption[] };
  /** 标签过滤维度（选项经 taxonomy() 的 tags，Top-N 呈现）。 */
  tagFilter?: boolean;
  /** 排序维度：options 含默认值项，点选默认值＝清除该维度。 */
  sorts?: DiscoveryOption[];
  sortDefault?: string;
  /** 榜单周期维度（012 的 trending 周期＋吃瓜三源的站方榜单，
   * fix337 起）：同 sorts 的默认值口径。 */
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
      /* 吃瓜面发现口径（Muse 2026-11-20 fix337/chigua-surface 改版，
       * 用户裁定＋调查 fix337/evidence/chigua-surface-investigation.md；
       * 标签口径 fix338/chigua-pill 修订，证据见
       * fix338/evidence/chigua-pill.md）：
       * 发现只走热点榜单/时间排序/查找——分类轴整体下线（26/19/30
       * 个栏目 chips 平铺把真榜单埋进栏目表、用户从不按栏目找）；
       * 栏目表保留在注册表 params，只作 categoryPath 路径校验全集，
       * 不再作发现入口。登记只一件——榜单：栏目表中标 rank 的子集
       * （readDiscoveryRanks 为唯一出处）进 rankPeriods、由
       * disc.period 承载、复用 categoryPath 归档取页；首项空值＝
       * 缺省流（兼退出榜单的路径）。
       * 「最热」pill（用户 2026-11-20 追加，与 001 的最新/最热同
       * 形态）：栏目表中标 hot 的站方热门栏目（每源一个）标
       * 「最热」、其余榜单保留站方名。机制走 disc.period 而非
       * sorts：站方无排序参数面、最热的真身是归档栏目，伪造
       * sort 值只会让登记与上游脱节；001 用 sorts 是因其上游有
       * 真 sort 参数，两源各按上游真相登记。
       * 缺省流只标「全部」、不标「最新」：fix338 生产路径实测
       * 三源缺省流均非时间序——适配器条目 id 序三页内 003
       * 38/72、004 36/89、005 32/75 处非单调，003/004 卡片日期
       * 序第一页各 7/9 处逆序、005 列表无日期字段（站方编辑
       * 混排、置顶/推荐混入）；fix337 调查「缺省流即最新流」是
       * 凭站点类型的未实测断言、已被实测推翻。无时间序实证即
       * 不贴「最新」假标签（与分类/标签行的「全部」清选口径
       * 同词）；日后某源拿到 id/时间单调实证再单独改标。
       * 003/004 的榜单是站方编辑栏目形态、005 是站方真周期榜
       * （日/周/月/热门），均经生产路径实拉真出条目。
       * 公告存档栏目（003 51hd/004 ztds）与 003 大赛征集栏目本就不
       * 在栏目表内（被推广过滤全覆盖、登记只会恒解析为空），口径
       * 不变；非榜单栏目（含 004/005 的每日大赛栏目）不标 rank、
       * 不进发现面。categoryPath 缺失即榜单机制不可用、不登记。 */
      const params = (def.adapter.params ?? {}) as Record<string, unknown>;
      const ranks = readDiscoveryRanks(def);
      const hasRankPath = typeof params.categoryPath === "string" && params.categoryPath.length > 0;
      if (ranks.length === 0 || !hasRankPath) return EMPTY_DISCOVERY_SPEC;
      return {
        rankPeriods: [{ value: "", label: "全部" }, ...ranks.map((c) => ({ value: c.slug, label: c.hot ? "最热" : c.name }))],
        periodDefault: "",
        evidence: "fix338/chigua-pill 实拉 2026-11-20（fix338/evidence/chigua-pill.md）：三源缺省流 id/日期序非单调、无时间序实证，缺省档标「全部」；最热＝站方热门栏目（003 热门 61 页/004 热搜 122 页/005 热门 101 页，生产路径复核）；榜单栏目/周期榜生产路径实拉真出条目（fix337/evidence/chigua-surface-investigation.md）",
      };
    }
    case "native-huangguo":
      /* 001 排序登记（fix337/chigua-surface）：上游 postCategory 的
       * sort 参数实证——hot 按热度值严格降序、缺省 latest 为时间序
       * （调查报告 §三）。原生 Posts 页不经 DiscoveryBar（该组件只
       * 挂外部源三面），切换在 Posts 页内自理；本登记是维度事实的
       * 单一出处与契约钉。 */
      return {
        sorts: [
          { value: "", label: "最新" },
          { value: "hot", label: "最热" },
        ],
        sortDefault: "",
        evidence: "吃瓜面调查 2026-11-20（fix337/evidence/chigua-surface-investigation.md）：上游 sort=hot 热度值严格降序实拉",
      };
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
       * views 重排全在内存（服务端无对应参数）。danbooru-api 模
       * 板不在此列——无选项来源、标签走既有搜索段。 */
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
    default:
      /* hls-site/native 及未实证模板：一律
       * 不登记（未实证不登记）。 */
      return EMPTY_DISCOVERY_SPEC;
  }
}
