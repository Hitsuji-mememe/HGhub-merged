/**
 * 外部源选集纯函数（Muse 2026-11-20 fix334 结构批 L2／G3，设计
 * ~/workspace/hghub/fix334/design-g3g4-surfaces.md §3）。
 *
 * 背景（结构审计 G3）：全仓只有 source-011（hentaihaven）的 detail 产多集
 * episodes、resolve 已支持按集取流，但详情消费者为 0——用户打开
 * 多集条目只能播第一集。本模块把「集数归一」与「选集面适用性」
 * 收敛为纯函数，供 SourceBrowse（宿主面 play-external）与 Search
 * 外部详情（宿主面 search-external-detail）两条路径共用，只接一条
 * 等于没根治（审计 G5 教训）。
 *
 * 口径：
 * - episodeChoices/episodeOrdinal 只读 detail 数据：外部集数是
 *   字符串 externalId＋自由文本 label，不套原生 EpisodesPanel 的
 *   数字 ep_num 形状（把「集号可解析」写进通用接线等于给下一个
 *   非数字集号源埋雷）。
 * - episodeChoicesForSurface 是选集面适用性的单一出处：宿主面
 *   路由经 surfaces.routeForSurface 派生（browse 才算接通）∧
 *   模板能力事实 episodes="multi"（templateCapabilitiesFor），
 *   组件内不再本地另判。不认注册表 capabilities.episodes：那是
 *   短剧频道（ai-duanju）的品类映射门、与集数产出事实分层
 *   （L2 裁定见 registry hentaihaven 条目 note 与本线报告）。
 */
import { getBuiltinRegistry } from "./registry.ts";
import { getActiveRegistry } from "./manifest.ts";
import { routeForSurface, type SurfaceContext, type SurfaceId } from "./surfaces.ts";
import { templateCapabilitiesFor } from "./adapters/templateCapabilities.ts";
import type { SourceDef, SourceDetail } from "./types.ts";

export interface EpisodeChoice {
  key: string;
  label: string;
  externalId: string;
}

/** 集数归一：detail.episodes 原序、按 externalId 去重、空 id 丢弃。 */
export function episodeChoices(detail: SourceDetail): EpisodeChoice[] {
  const seen = new Set<string>();
  const out: EpisodeChoice[] = [];
  for (const ep of detail.episodes ?? []) {
    if (!ep.externalId || seen.has(ep.externalId)) continue;
    seen.add(ep.externalId);
    out.push({ key: ep.externalId, label: ep.label || ep.externalId, externalId: ep.externalId });
  }
  return out;
}

/**
 * 集序位（1 起，供 G4 历史 ep 与当前集标注）；externalId 不在
 * choices 内回 0（未知，不冒充第一集）。
 */
export function episodeOrdinal(detail: SourceDetail, externalId: string): number {
  const idx = episodeChoices(detail).findIndex((c) => c.externalId === externalId);
  return idx >= 0 ? idx + 1 : 0;
}

/** 可挂选集的宿主面：外部播放面（SourceBrowse）与搜索外部详情面。 */
export type EpisodePickerSurface = Extract<SurfaceId, "play-external" | "search-external-detail">;

/**
 * 某源在某宿主面的选集列表：路由非 browse（未接通/诚实提示/
 * 不适用）或模板非 multi 时回空——调用方以 choices.length > 1
 * 决定是否渲染选集区，单集与不适用同为「无选集区」，与现状观感
 * 一致。ctx 缺省现查 active/内置注册表（生产口径）；契约以注入
 * ctx 钉停用等变体状态。
 */
export function episodeChoicesForSurface(
  surface: EpisodePickerSurface,
  def: SourceDef | undefined,
  detail: SourceDetail | undefined,
  ctx?: SurfaceContext,
): EpisodeChoice[] {
  if (!def || !detail) return [];
  const route = routeForSurface(surface, def, ctx ?? {
    active: getActiveRegistry().sources,
    builtin: getBuiltinRegistry(),
  });
  if (route.kind !== "browse") return [];
  if (templateCapabilitiesFor(def).episodes !== "multi") return [];
  return episodeChoices(detail);
}
