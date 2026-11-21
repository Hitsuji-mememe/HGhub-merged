/**
 * 源系统类型（Muse 2026-11-19 根治包·多源线）。
 * 内容模型映射目标 = 仓内既有模型（src/shared/api/types.ts 的
 * VideoCard / Post / Paged）：适配器先产出 SourceItem，再由
 * mapToVideoCard / mapToPost 落到既有模型，UI 层不感知外部站形状。
 */
import type { Paged, Post, VideoCard } from "../../shared/api/types";

export type SourceKind = "video" | "post" | "image" | "mixed";
/** stable=真站实测三段全通；probe=已注册、部分未证；blocked=站点不可达/被墙（证据入注册表 note；列表保留可见、点开诚实提示、不拉数据）；preview=仅预览专区 */
export type SourceMaturity = "stable" | "probe" | "blocked" | "preview";
/** App 内的分区：posts=吃瓜帖、video=视频、image=图集、preview=预览专区 */
export type SourceCategory = "posts" | "video" | "image" | "preview";

export interface SourceCapabilities {
  search: boolean;
  episodes: boolean;
  hevc: boolean;
}

export interface SourceNetwork {
  /** native=仓内既有通道（黄果）；probe-required=须先经探测/受控取页通道 */
  mode: "native" | "probe-required";
  needsNonJpExit?: boolean;
}

export interface SourceDef {
  id: string;
  displayName: string;
  kind: SourceKind;
  category: SourceCategory;
  /** template=模板 id（见 adapters），params=模板参数区 */
  adapter: { template: string; params?: Record<string, unknown> };
  /** 候选基址（首个为生效 origin）；discoveryUrl=发布页发现地址 */
  baseUrls: string[];
  discoveryUrl?: string;
  enabled: boolean;
  order: number;
  maturity: SourceMaturity;
  capabilities: SourceCapabilities;
  network: SourceNetwork;
  note?: string;
}

/** 适配器统一条目：externalId 为源站侧 id（字符串），href 为详情页地址。 */
export interface SourceItem {
  sourceId: string;
  externalId: string;
  title: string;
  cover: string;
  href: string;
  tags: string[];
  /* 源内分类/栏目名（Muse 2026-11-20 fix335/f-discovery）：站方分类
   * 体系给出的归属，与 tags（真标签）分开——分类进 cats、真标签才
   * 进 tags，互不冒充。 */
  cats?: string[];
  /* 条目自带大图地址（Muse 2026-11-20 fix337/008-detail）：单帖单图
   * 模型源（booru 家族）的列表载荷逐帖自带大图（与 detail 的唯一图
   * 同口径），与 cover（预览图）分开——宿主据此以已加载列表组装
   * 画廊（albumGallery.ts）；图集型源不填（其画廊在 detail 内）。 */
  largeImage?: string;
  hot?: number;
  duration?: string;
  previewOnly?: boolean;
}

/* 发现维度选择（Muse 2026-11-20 fix335/f-discovery）：list() 的可选
 * 参数，缺省＝各适配器现行写死行为逐字不变。字段只存非默认选择
 * （DiscoveryBar 点选默认值即删字段），保证滚动指纹规范。
 * category/tag 的取值形态由各源 DiscoverySpec 登记决定（栏目 slug
 * 或 taxonomy id 字符串）。 */
export interface ListDiscovery {
  category?: string;
  sort?: string;
  period?: string;
  tag?: string;
}

/** 空 disc 的共享缺省（只读使用：变更一律经新对象，不许原地改）。 */
export const EMPTY_LIST_DISCOVERY: ListDiscovery = {};

/* 滚动恢复指纹（fix335/f-discovery）：disc 非空字段按固定序序列化，
 * 与 useScrollKeeper 的 key 组合成「面:源:指纹」——切换发现维度后
 * 位置按新指纹隔离，不串位。空 disc 返回空串（key 与 D 线逐字一致）。 */
export function discFingerprint(disc: ListDiscovery): string {
  const parts: string[] = [];
  if (disc.category) parts.push(`cat=${encodeURIComponent(disc.category)}`);
  if (disc.sort) parts.push(`sort=${encodeURIComponent(disc.sort)}`);
  if (disc.period) parts.push(`period=${encodeURIComponent(disc.period)}`);
  if (disc.tag) parts.push(`tag=${encodeURIComponent(disc.tag)}`);
  return parts.join("&");
}

/* 图片面 disc 失效化（Muse 2026-11-21 fix3311/discovery-rework，
 * 用户发现轴裁定＋整体打磨审计 §8.2）：图片面发现只走排序＋查找，
 * category/tag 不再是图片面发现维度。disc 只存浏览组件的会话内
 * 状态、无落盘键（STORAGE_KEYS 无 disc 条目），存量清理的落点
 * 是读取点：图片面（SourceGallery）派生 disc 时一律剥两字段——
 * 任何残存值都到不了 list 参数与滚动指纹，不形成「看不见的筛
 * 选」；收藏/历史/屏蔽/续播等落盘数据不经此路、逐字不动。无两
 * 字段时同引用返回：disc 身份喂列表 load 的依赖，干净时不许换
 * 新对象引发无谓重拉。视频/吃瓜面不经此函数、行为不变。 */
export function stripDiscTaxonomy(disc: ListDiscovery): ListDiscovery {
  if (!disc.category && !disc.tag) return disc;
  const next = { ...disc };
  delete next.category;
  delete next.tag;
  return next;
}

/* taxonomy 选项（fix335/f-discovery）：分类/标签的可选项与计数；
 * id 为适配器过滤参数的实际取值（WP 为数字 id 字符串，002 为原值）。 */
export interface TaxonEntry {
  id: string;
  name: string;
  count?: number;
}
export interface SourceTaxonomy {
  categories: TaxonEntry[];
  tags: TaxonEntry[];
}

export interface SourceDetail extends SourceItem {
  description?: string;
  contentHtml?: string;
  images: string[];
  episodes: { label: string; externalId: string }[];
}

export interface SourceStream {
  url: string;
  kind: "hls" | "file";
  hevc?: boolean;
}

export interface SourceAdapter {
  sourceId: string;
  /* disc 缺省＝现行写死行为（fix335/f-discovery）；只有 DiscoverySpec
   * 已登记维度的源消费对应字段，未登记字段一律忽略。 */
  list: (page: number, size: number, disc?: ListDiscovery) => Promise<Paged<SourceItem>>;
  detail: (externalId: string) => Promise<SourceDetail>;
  resolve: (externalId: string) => Promise<{ streams: SourceStream[] }>;
  search?: (q: string, page: number, size: number) => Promise<Paged<SourceItem>>;
  /* 发现维度的选项来源（fix335/f-discovery）：仅登记了 taxonomy 型
   * 维度（WP 四源）或客户端型维度（002）的适配器实现。 */
  taxonomy?: () => Promise<SourceTaxonomy>;
}

/** 稳定数值 id：外部字符串 id → 既有模型要求的 number（FNV-1a，稳定可复现）。 */
export function hashExternalId(externalId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < externalId.length; i++) {
    h ^= externalId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h | 0) || 1;
}

export function mapToVideoCard(item: SourceItem): VideoCard {
  return {
    id: hashExternalId(`${item.sourceId}:${item.externalId}`),
    title: item.title,
    cover: item.cover,
    tags: item.tags,
    score: 0,
    episode_count: 1,
    total_episodes: 1,
    duration: item.duration,
    hot: item.hot ?? 0,
    like_count: 0,
    collect_count: 0,
    comment_count: 0,
    is_finished: true,
    is_original: 0,
  };
}

export function mapToPost(item: SourceItem): Post {
  return {
    id: hashExternalId(`${item.sourceId}:${item.externalId}`),
    title: item.title,
    cover: item.cover,
    tags: item.tags,
    hot: item.hot ?? 0,
  };
}
