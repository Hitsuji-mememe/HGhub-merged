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
 *
 * 搜索面补判（3.2.1 修复 F4b 线，用户新截图实锤搜「御姐」视频页签
 * 混入同批 AI 短剧）：通用搜索端点 `/api/search?type=video` 的条目
 * 不下发剧集结构信号（字段缺失或恒 0——本地三层审计无丢弃点：
 * Rust api_search/edge 透传、前端类型已声明、消费层直调判定，见
 * fix321/evidence/f4b/root-cause.md），同 ID 条目在频道/详情数据里
 * 却有。此前搜索归类拿缺失信号调 kindForHuangguoVideo 必然落
 * 「视频」——判定实际跟着「结果从哪个端点回来」走、不是按性质。
 * 搜索专用口径（searchKindForHuangguoVideo）：卡自带信号（任一
 * 计数为正）直接判定；信号缺失（两计数皆 0/缺失）必须先以规范
 * 记录（按 ID 的 Detail 信号）补判；补判也无信号 → "unknown"
 * 安全侧：暂不进任何性质页签——绝不默认落视频、也不猜落短剧。
 * 代价：详情不可达的条目在搜索里暂不可见（其详情本身亦打不开），
 * 以可见性换归类正确性。浏览面不走此口径：频道载荷信号齐全，
 * 0 集即真无分集、仍归视频（F4 口径不变）。
 */
export type HuangguoCardKind = "video" | "drama";

/** 剧集结构信号：以条目模型实际字段为准（VideoCard 的两集数字段；
 * Detail 另有 episodes 数组、同为规范信号）。 */
export interface EpisodeStructureSignal {
  total_episodes?: number;
  episode_count?: number;
  episodes?: readonly unknown[];
}

/** 条目已知的最大集数（三路信号取最大；皆缺失/皆 0 时为 0）。 */
export function episodeCountOf(card: EpisodeStructureSignal): number {
  return Math.max(card.total_episodes ?? 0, card.episode_count ?? 0, card.episodes?.length ?? 0);
}

/** 信号在场：任一集数计数为正即已确认结构（1 集＝已确认单条）。 */
export function hasEpisodeStructureSignal(card: EpisodeStructureSignal): boolean {
  return episodeCountOf(card) > 0;
}

/** 黄果条目归类：有分集结构 → 短剧，其余单条 → 视频。 */
export function kindForHuangguoVideo(card: EpisodeStructureSignal): HuangguoCardKind {
  return episodeCountOf(card) > 1 ? "drama" : "video";
}

/** 按性质分组（浏览面与搜索共用同一判定）：两键恒在、组内原序保留。 */
export function partitionCardsByKind<T extends EpisodeStructureSignal>(
  cards: readonly T[],
): Record<HuangguoCardKind, T[]> {
  const groups: Record<HuangguoCardKind, T[]> = { video: [], drama: [] };
  for (const card of cards) groups[kindForHuangguoVideo(card)].push(card);
  return groups;
}

/** 搜索归类结果：性质二类或 unknown（信号缺失且补不到，安全侧暂扣）。 */
export type HuangguoSearchKind = HuangguoCardKind | "unknown";

/**
 * 搜索专用归类（F4b 线，唯一出处仍在本文件）：卡自带信号直接判定；
 * 信号缺失时以规范记录（canonical，按条目 ID 查得的 Detail 信号）
 * 补判；canonical 缺席/失败（null/undefined）或同样无信号 →
 * "unknown"，调用方暂不把该条目放进任何性质页签，补判到达后再归类。
 */
export function searchKindForHuangguoVideo(
  card: EpisodeStructureSignal,
  canonical?: EpisodeStructureSignal | null,
): HuangguoSearchKind {
  if (hasEpisodeStructureSignal(card)) return kindForHuangguoVideo(card);
  if (canonical && hasEpisodeStructureSignal(canonical)) return kindForHuangguoVideo(canonical);
  return "unknown";
}
