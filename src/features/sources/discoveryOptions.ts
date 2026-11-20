/**
 * 发现维度选项整理（Muse 2026-11-20 fix336/ui-fixes）：纯函数，
 * 供 DiscoveryBar 消费与契约直驱。
 *
 * 背景（用户 2026-11-20 真机实报）：WP 类源的 taxonomy 里标签与
 * 分类大量同名（如分类「XiuRen」与标签「Xiuren」只差大小写），
 * 两行 chips 并排平铺成墙、且同名项重复出现，阅读与点选都受扰。
 * 口径：标签维度剔除与分类同名的条目——比对走规范化（去首尾空
 * 白＋不分大小写），label 与 value 任一撞名即算同名（label 是
 * 用户看见的名、value 是站方 slug，两处都可能撞）。
 *
 * 例外：当前已选中的标签即使同名也保留——剔掉它会让生效中的
 * 筛选在界面上凭空消失、用户无从取消；它以选中态留在行内，用
 * 户点掉后不再回来（下次渲染时 disc.tag 已清、照常剔除）。
 */
import type { DiscoveryOption } from "./adapters/templateCapabilities.ts";

export function normalizeDiscoveryName(name: string): string {
  return name.trim().toLowerCase();
}

export function dedupeTagOptions(
  categoryOptions: readonly DiscoveryOption[],
  tagOptions: readonly DiscoveryOption[],
  selectedTagValue?: string,
): DiscoveryOption[] {
  if (categoryOptions.length === 0) return [...tagOptions];
  const categoryNames = new Set<string>();
  for (const o of categoryOptions) {
    categoryNames.add(normalizeDiscoveryName(o.label));
    categoryNames.add(normalizeDiscoveryName(o.value));
  }
  return tagOptions.filter((o) => {
    if (selectedTagValue !== undefined && o.value === selectedTagValue) return true;
    return !categoryNames.has(normalizeDiscoveryName(o.label))
      && !categoryNames.has(normalizeDiscoveryName(o.value));
  });
}
