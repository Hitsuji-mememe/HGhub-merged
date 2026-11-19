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
  comments: boolean;
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
  hot?: number;
  duration?: string;
  previewOnly?: boolean;
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
  list: (page: number, size: number) => Promise<Paged<SourceItem>>;
  detail: (externalId: string) => Promise<SourceDetail>;
  resolve: (externalId: string) => Promise<{ streams: SourceStream[] }>;
  search?: (q: string, page: number, size: number) => Promise<Paged<SourceItem>>;
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
