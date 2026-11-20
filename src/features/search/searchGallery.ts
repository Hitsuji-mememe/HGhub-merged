/**
 * 搜索宿主画廊组装（Muse 2026-11-20 fix337/search-gallery）。
 *
 * 背景（008-detail 同批横扫）：booru 家族单图模型在源内宿主
 * （SourceGallery）已以已加载列表为画廊沿帖前后翻；但从搜索
 * 结果点开走 copyLoader 副本路径、只喂 detail 单图——同一帖在
 * 搜索面仍只有一张图、无从前后翻，同根未修。
 *
 * 搜索面的「列表」不是单源列表，而是跨源合并簇（MergedHit：
 * 同一内容在多源的副本集）。本模块只做搜索面独有的界定与载体
 * 提取，判定与拼装仍走 albumGallery.assembleAlbumGallery 唯一
 * 出处（detail 恰 1 图∧自带大图 ≥2∧点开在列），不另起一套：
 * - 界：点开条目所在 kind 的当前结果列表（展示序）全部合并簇；
 * - 载体：逐簇取「点开副本所属源」的那份副本条目——代表副本
 *   可能属他源，必须按源取副本、不能拿簇的展示条目充数；
 * - 同源同 externalId 只取首现：合并漏网的重复到达不许在画廊
 *   里出现两次；
 * - 跨源条目绝不入集：画廊的源注记、标题与收藏跟随都以单源
 *   为前提，混源即语义错位。
 */
import { assembleAlbumGallery, type AlbumGalleryAssembly } from "../sources/albumGallery.ts";
import type { SourceItem } from "../sources/types.ts";
import type { CopyRef, MergedHit } from "./multiSourceSearch.ts";

export function assembleSearchGallery(
  hits: readonly MergedHit[],
  active: CopyRef,
  detailImages: readonly string[],
): AlbumGalleryAssembly | null {
  const seen = new Set<string>();
  const items: SourceItem[] = [];
  for (const hit of hits) {
    const copy = hit.copies.find((c) => c.sourceId === active.sourceId);
    if (!copy) continue;
    if (seen.has(copy.item.externalId)) continue;
    seen.add(copy.item.externalId);
    items.push(copy.item);
  }
  return assembleAlbumGallery(items, active.item, detailImages);
}
