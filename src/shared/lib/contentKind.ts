/**
 * 黄果条目内容性质判定（唯一出处，Muse 2026-11-19 3.2.1 修复 F4 线
 * 抽共用；fix322 标记线升级裁决优先级）。全部归类展示面——分类浏览
 * （features/category/Category 总览/频道页）、全局搜索
 * （features/search/multiSourceSearch＋Search）、站内搜索
 * （features/search/useSearchResults）——共用本文件函数，不许第二套。
 *
 * ── 裁决优先级（fix322 定版，用户口径：标记优先、结构只作兜底）──
 * 1. 源头显式品类标记：上游官方分类表（GET /api/site/categories/video，
 *    2026-11-19 实测）id 24=短剧、25=漫剧、26=AI换脸、27=AI魔改。
 *    标记只在规范记录（Detail）里下发，载体为 tracking.drama_type_id
 *    （字符串）；列表/搜索载荷全字段审计（25 键）无任何品类字段——
 *    标记不在列表层，旧链路是「提取点丢弃」：Search/useSearchResults
 *    补判存入 Detail 时只摘集数信号、tracking 被整段丢掉（fix322
 *    以 kindSignalOfDetail 单点提取根治）。实测锚点：《我的怪力母狗》
 *    （id 13765，用户截图视频区「1 集 ★9.1」）列表形态 episode_count
 *    =1，Detail 标记 =24 短剧；《蜜桃臀》（id 13781）标记 =25 漫剧、
 *    且在 ai-manju 分类列表内；17 条 Detail 抽样（集数 1..42）标记
 *    全部 24/25。video_type 恒 1、非品类标记（同批实测，勿再用）。
 * 2. 集数结构兜底（无标记时）：只在决定性方向成立——>1 集必为剧集
 *    （抽样内多集条目标记与结构从未冲突）；≤1 集与普通视频同形、
 *    本身不构成任一侧证据，既不默认落视频、也不猜落短剧 → unknown
 *    暂不呈现（以可见性换归类正确性，承 F4b 安全侧）。旧口径「1 集/
 *    无分集即视频」是本 bug 根因：单集短剧被结构兜底放行进视频面。
 *
 * 补判接缝：卡自带标记（当前载荷无此形态、为未来留）→ 直接定；
 * 否则由各展示面以条目 ID 查 api.video 的 Detail、经
 * kindSignalOfDetail 构造规范信号后传入 resolveHuangguoKind。
 * needsCanonicalKindLookup 是三面共用的补判触发门：未决定者
 * （无自带标记且集数 ≤1）才查，多集结构已定不查（省请求；其标记
 * 与结构一致有抽样支持——若上游将来出现多集的 26/27 条目，本门
 * 会漏检，如实记为已知边界）。
 *
 * 历史沿革（勿回退）：F4（3.2.1）把浏览面从「按频道归类」改到本
 * 文件的结构判定，解决多集剧两区重复；F4b 发现搜索端点不下发集数
 * 信号、立 Detail 补判＋unknown 安全侧；F4c 把站内搜索两面接入同
 * 一性质门。fix322 在此之上把补判信号从「只有结构」升级为「标记
 * 优先」，并把浏览面（总览/频道 feed）一并接入补判——旧结论「浏览
 * 面不走补判（频道载荷信号齐全）」被真机推翻：频道载荷的集数是
 * 真的，但 ≤1 集本身歧义，齐全的是数字、不是性质证据。
 */
export type HuangguoCardKind = "video" | "drama";

/** 归类信号：集数结构＋（规范记录才有的）源头显式品类标记。 */
export interface EpisodeStructureSignal {
  total_episodes?: number;
  episode_count?: number;
  episodes?: readonly unknown[];
  /** 源头显式品类标记：Detail.tracking.drama_type_id（上游分类表 id，
   * 字符串形态，如 "24"）；列表/搜索载荷不下发，仅规范记录携带。 */
  source_type_id?: number | string;
}

/** 条目已知的最大集数（三路信号取最大；皆缺失/皆 0 时为 0）。 */
export function episodeCountOf(card: EpisodeStructureSignal): number {
  return Math.max(card.total_episodes ?? 0, card.episode_count ?? 0, card.episodes?.length ?? 0);
}

/** 信号在场：任一集数计数为正即已确认结构（1 集＝已确认单条）。 */
export function hasEpisodeStructureSignal(card: EpisodeStructureSignal): boolean {
  return episodeCountOf(card) > 0;
}

/* 上游分类表（/api/site/categories/video，2026-11-19 实测）：
 * 24=短剧、25=漫剧 → drama；26=AI换脸、27=AI魔改 → video。
 * 26/27 的分类列表当前返回 410 下线、无在架条目可抽样，其 id 与
 * 名称出自同一官方分类表端点，与 24/25 同源可信。 */
const DRAMA_SOURCE_TYPE_IDS: ReadonlySet<number> = new Set([24, 25]);
const VIDEO_SOURCE_TYPE_IDS: ReadonlySet<number> = new Set([26, 27]);

/** 显式品类标记 → 性质；无标记/未知 id → undefined（不臆造）。 */
export function explicitKindOf(signal: EpisodeStructureSignal): HuangguoCardKind | undefined {
  const raw = signal.source_type_id;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const id = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  if (DRAMA_SOURCE_TYPE_IDS.has(id)) return "drama";
  if (VIDEO_SOURCE_TYPE_IDS.has(id)) return "video";
  return undefined;
}

/**
 * 规范信号构造点（唯一出处）：从 Detail 摘出归类所需的全部信号——
 * 集数结构＋tracking 品类标记。三面（Search/useSearchResults/
 * Category）补判一律经此构造，不许再各自摘字段（fix322 前补判只摘
 * 集数、标记在此被丢，是单集短剧漏检的直接原因）。
 */
export function kindSignalOfDetail(detail: EpisodeStructureSignal & {
  tracking?: { drama_type_id?: number | string } | null;
}): EpisodeStructureSignal {
  return {
    total_episodes: detail.total_episodes,
    episode_count: detail.episode_count,
    episodes: detail.episodes,
    source_type_id: detail.tracking?.drama_type_id,
  };
}

/** 补判触发门（三面共用）：无自带标记且集数 ≤1 者性质未决定、须查
 * 规范记录；多集（>1）结构已决定性判短剧、不查。 */
export function needsCanonicalKindLookup(card: EpisodeStructureSignal): boolean {
  return explicitKindOf(card) === undefined && episodeCountOf(card) <= 1;
}

/**
 * 卡-only 判定（结构兜底原语）：自带标记优先（当前载荷无此形态），
 * 否则 >1 集 → 短剧、其余 → 视频。注意：≤1 集落「视频」只是无规范
 * 记录可查时的最后兜底，归类展示面不许以它作最终裁决——最终裁决
 * 走 resolveHuangguoKind（无标记的单集须暂扣为 unknown）。
 */
export function kindForHuangguoVideo(card: EpisodeStructureSignal): HuangguoCardKind {
  return explicitKindOf(card) ?? (episodeCountOf(card) > 1 ? "drama" : "video");
}

/** 按性质分组（卡-only 结构原语；归类面最终分组用
 * partitionCardsByResolvedKind）。两键恒在、组内原序保留。 */
export function partitionCardsByKind<T extends EpisodeStructureSignal>(
  cards: readonly T[],
): Record<HuangguoCardKind, T[]> {
  const groups: Record<HuangguoCardKind, T[]> = { video: [], drama: [] };
  for (const card of cards) groups[kindForHuangguoVideo(card)].push(card);
  return groups;
}

/** 归类结果：性质二类或 unknown（无标记可取得且结构不决定，安全侧暂扣）。 */
export type HuangguoSearchKind = HuangguoCardKind | "unknown";

/**
 * 统一裁决（全部归类展示面的最终判定，唯一出处）：
 * 1. 显式标记（卡自带 → canonical 补判，先到先定）；
 * 2. 集数结构决定性方向：卡或 canonical 任一 >1 集 → 短剧；
 * 3. 其余（单集/无信号且无标记）→ "unknown"：调用方暂不把该条目
 *    放进任何性质分区/页签，补判到达后重跑本函数自动归位。
 */
export function resolveHuangguoKind(
  card: EpisodeStructureSignal,
  canonical?: EpisodeStructureSignal | null,
): HuangguoSearchKind {
  const marked = explicitKindOf(card) ?? (canonical ? explicitKindOf(canonical) : undefined);
  if (marked) return marked;
  if (episodeCountOf(card) > 1) return "drama";
  if (canonical && episodeCountOf(canonical) > 1) return "drama";
  return "unknown";
}

/** 搜索判定（F4b 既有名称/接缝不变，实现即统一裁决 resolveHuangguoKind）。 */
export const searchKindForHuangguoVideo: typeof resolveHuangguoKind = resolveHuangguoKind;

/**
 * 归类面最终分组（浏览面用）：逐条经统一裁决（canonicalFor 提供按
 * 条目查得的规范信号），三组齐全——video/drama 为呈现组，unknown
 * 为暂扣组（不渲染、等补判到达后由调用方重跑归位）。组内原序保留。
 */
export function partitionCardsByResolvedKind<T extends EpisodeStructureSignal>(
  cards: readonly T[],
  canonicalFor: (card: T) => EpisodeStructureSignal | null | undefined,
): Record<HuangguoSearchKind, T[]> {
  const groups: Record<HuangguoSearchKind, T[]> = { video: [], drama: [], unknown: [] };
  for (const card of cards) groups[resolveHuangguoKind(card, canonicalFor(card))].push(card);
  return groups;
}

/**
 * 搜索面性质门（3.2.1 修复 F4c 线）：逐条经统一裁决（自带信号/
 * 标记直判、缺失以 canonicalFor 提供的规范信号补判），只保留
 * resolved kind 与目标面一致者；unknown 暂不呈现（不进错面、也不
 * 重复进两面），补判到达后由调用方以新 canonical 重跑本函数自动
 * 归位。canonicalFor 的键控/作用域由调用方负责（同 Search.tsx 的
 * envKey:id 口径）。
 */
export function filterSearchCardsByKind<T extends EpisodeStructureSignal>(
  cards: readonly T[],
  target: HuangguoCardKind,
  canonicalFor: (card: T) => EpisodeStructureSignal | null | undefined,
): T[] {
  return cards.filter((card) => resolveHuangguoKind(card, canonicalFor(card)) === target);
}
