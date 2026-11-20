/**
 * 吃瓜帖浏览面路由判定（Muse 2026-11-19 3.3.0 接通批·吃瓜线）。
 *
 * 根因存档：最终版 D 线给视频/图片分类接通了 SourceBrowse/
 * SourceGallery（ChannelPage 内按 maturity 分流），唯独吃瓜帖分类
 * 从未接浏览组件——Posts 页与分类总览对一切非黄果源无条件渲染
 * SourcePendingNotice，适配器从未被调用。feedheiliao 自 fix321-F2b
 * 毕业为命名源（enabled=true、chigua 适配器、三段证据齐）后，真机
 * 点开仍是提示页，根因即在此判定缺位、与 maturity/capabilities
 * 无关（probe 源在视频/图片面本就真取数）。
 *
 * 判定（与 ChannelPage 视频/图片分支同口径，全吃瓜面唯一出处）：
 * - 黄果 → "native"（仓内既有 api 通道）；
 * - 源缺失或 maturity=blocked → "blocked"（诚实提示、不拉数据）；
 * - 其余已启用源 → "browse"（经 SourcePosts 走适配器真实渲染）。
 */
import type { SourceDef } from "./types.ts";

export type PostsBrowseRoute = "native" | "blocked" | "browse";

export function resolvePostsBrowse(def: SourceDef | undefined): PostsBrowseRoute {
  if (!def) return "blocked";
  /* 原生判据与 surfaces.isNativeSource 同式（模板判据、抗源改名，
   * 不认 id 字面量）；本模块被 surfaces 反向 import，不回引
   * surfaces.nativeSourceId 以免成环（同 templateSegments 先例）。
   * Muse 2026-11-20 集成收敛（E 线登记项）。 */
  if (def.adapter.template === "native-huangguo") return "native";
  if (def.maturity === "blocked") return "blocked";
  return "browse";
}
