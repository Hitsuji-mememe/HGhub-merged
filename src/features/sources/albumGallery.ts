/**
 * 单图模型画廊组装（Muse 2026-11-20 fix337/008-detail）。
 *
 * 背景（3.3.6 真机实报，008/014/016 同报）：booru 家族是单帖单图
 * 模型——一帖恰一图，detail 恒返 1 图是模型事实、不是聚合丢图
 * （生产路径实拉对照：图集型源 detail 50–103 图，booru 三源恒
 * 1）。旧宿主把 detail.images 原样当整个相册，点开任何一帖就只
 * 见 1 张、无从前后翻——与图集源的浏览形态断裂。
 *
 * 正确形态：查看器以「已加载列表」为画廊沿帖前后翻。本模块是
 * 组装判定与拼装的唯一出处（纯函数，宿主 SourceGallery 消费）：
 * - 成立条件：detail 恰 1 图（单图模型签名）∧ 已加载条目中自带
 *   大图（SourceItem.largeImage）者 ≥2 ∧ 点开条目在入选集内；
 * - 拼装：入选条目按列表序成画廊，图片与条目一一对应；点开条目
 *   本位以 detail 图为准（刚经详情链实取、最权威），其余以条目
 *   自带大图；index＝点开条目在入选集中的位置；
 * - 不成立回 null：宿主维持现行单册形态——图集源（detail 多图）
 *   永不触发、无大图条目不以 preview 充数（不降质）、点开条目
 *   不在已加载列表（深链直达未命中）时不猜邻帖。
 */
import type { SourceItem } from "./types.ts";

export interface AlbumGalleryAssembly {
  /** 入选条目（与 images 一一对应，标题/收藏随当前条目跟随）。 */
  items: SourceItem[];
  /** 画廊图片（列表序；点开位为 detail 图）。 */
  images: string[];
  /** 起始位置＝点开条目在入选集中的下标。 */
  index: number;
}

export function assembleAlbumGallery(
  items: readonly SourceItem[],
  opened: SourceItem,
  detailImages: readonly string[],
): AlbumGalleryAssembly | null {
  if (detailImages.length !== 1) return null;
  const carriers = items.filter((i) => typeof i.largeImage === "string" && i.largeImage !== "");
  if (carriers.length < 2) return null;
  const index = carriers.findIndex((i) => i.externalId === opened.externalId);
  if (index < 0) return null;
  const images = carriers.map((i, k) => (k === index ? detailImages[0] : (i.largeImage as string)));
  return { items: carriers, images, index };
}
