/**
 * 黄果条目内容性质判定（唯一出处，Muse 2026-11-19 3.2.1 修复 F4 线）：
 * 全局搜索（features/search/multiSourceSearch）与分类浏览
 * （features/category/Category 总览/频道页）共用同一函数——此前
 * 搜索已按性质归类、浏览面仍按频道归类，黄果「原创（视频）」频道
 * 里混排的多集剧集（如《警界之花》3 集）同时出现在短剧区与视频
 * 区（用户实报＋截图）。判定口径（用户 2026-11-19 定版）：
 * 有分集/剧集结构信号（total_episodes/episode_count 任一 >1）
 * 只归短剧、绝不进视频；其余（1 集/无分集/字段缺失）归视频。
 * 边界：单集短剧在原生侧无结构信号可辨，归视频（如实限制，
 * 不臆造判据），与搜索 D3 口径一致。
 */
export type HuangguoCardKind = "video" | "drama";

/** 剧集结构信号：以条目模型实际字段为准（VideoCard 的两集数字段）。 */
export interface EpisodeStructureSignal {
  total_episodes?: number;
  episode_count?: number;
}

/** 黄果条目归类：有分集结构 → 短剧，其余单条 → 视频。 */
export function kindForHuangguoVideo(card: EpisodeStructureSignal): HuangguoCardKind {
  return (card.total_episodes ?? 0) > 1 || (card.episode_count ?? 0) > 1 ? "drama" : "video";
}

/** 按性质分组（浏览面与搜索共用同一判定）：两键恒在、组内原序保留。 */
export function partitionCardsByKind<T extends EpisodeStructureSignal>(
  cards: readonly T[],
): Record<HuangguoCardKind, T[]> {
  const groups: Record<HuangguoCardKind, T[]> = { video: [], drama: [] };
  for (const card of cards) groups[kindForHuangguoVideo(card)].push(card);
  return groups;
}
