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
 *   事实（频道归类用），本表是模板产出事实（选集面用），012
 *   两者现行不一致（caps=false、模板 multi）是已知分层、归
 *   G3（L2）修正 caps，不许在本表迁就 caps 改判。
 */
import type { SourceDef } from "../types.ts";
import { templateHasAdapter, templateHasSearch } from "./templateSegments.ts";

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
