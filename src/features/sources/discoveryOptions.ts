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
import type { ListDiscovery, SourceTaxonomy, TaxonEntry } from "./types.ts";

export function normalizeDiscoveryName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 最近用过置顶（Muse 2026-11-21 fix3312/discovery-b，兴趣直达）：
 * recents 的顺序即优先级（最近用过的最靠前），命中项按 recents
 * 序提到队首、其余项相对序不变（稳定划分）。recents 为空或选项
 * 为空时原样返回新数组。比对吃 option.value（筛选真值）——
 * 与 disc 落盘的 recentCategories/recentTags 同口径。
 */
export function pinRecentOptions(
  options: readonly DiscoveryOption[],
  recents: readonly string[],
): DiscoveryOption[] {
  if (recents.length === 0 || options.length === 0) return [...options];
  const rank = new Map(recents.map((v, i) => [v, i] as const));
  const pinned: DiscoveryOption[] = [];
  const rest: DiscoveryOption[] = [];
  for (const o of options) (rank.has(o.value) ? pinned : rest).push(o);
  pinned.sort((a, b) => (rank.get(a.value) ?? 0) - (rank.get(b.value) ?? 0));
  return [...pinned, ...rest];
}

/**
 * taxonomy 条目→选项映射（Muse 2026-11-21 fix3314 阶段二审计
 * D1 抽共用）：id→value、name→label 的唯一口径。原 DiscoveryBar
 * 内分类行／标签池／已选回落三处内联重拼同一映射，池口径变更时
 * 回落链易漏改——收敛为一处，三消费面共用。
 */
export function taxonOptionsOf(
  entries: readonly TaxonEntry[],
): DiscoveryOption[] {
  return entries.map((e) => ({ value: e.id, label: e.name }));
}

/**
 * taxonomy 条目合并（Muse 2026-11-21 fix3313/discovery-tail ②）：
 * 本地已加载名单与服务端补取结果按 id 合并——先到先得（本地项
 * 优先、序不变），补取项按到达序殿后；同 id 重复只留一份。
 */
export function mergeTaxonEntries(
  base: readonly TaxonEntry[],
  extra: readonly TaxonEntry[],
): TaxonEntry[] {
  const seen = new Set(base.map((e) => e.id));
  const out = [...base];
  for (const e of extra) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/**
 * 落盘 disc 的 taxonomy 失效判定（fix3313/discovery-tail ③）：站方
 * 改 taxonomy id 后，落盘的 category/tag 指向已不存在的条目、列表
 * 被静默过滤为空。本函数只判定不清值（清值与留痕由调用方做）：
 * - 值在已加载 taxonomy 名单内 → 保留（探针不参与判定）。
 * - 名单外且适配器有存在性探针 → 探针明确 false（站方 404）才判
 *   失效；true（名单窗口外的真条目，如标签 Top-100 之外）与 null
 *   （网络失败等未知）都保留——未知不是空，不拿探不到冒充失效。
 * - 名单外且无探针 → 该适配器的 taxonomy 即全集（如 002 本地目录
 *   聚合），缺席即失效。
 * sort/period 非 taxonomy 字段，不在本判定范围。scope 限定查哪些
 * 字段（调用方按 DiscoverySpec 传入）：params 型分类（吃瓜栏目
 * slug）的选项来自注册表静态表、不经 taxonomy，不在查验范围。
 */
export async function resolveStaleDiscFields(
  disc: ListDiscovery,
  taxonomy: SourceTaxonomy,
  probe: ((kind: "category" | "tag", id: string) => Promise<boolean | null>) | null,
  scope: { category: boolean; tag: boolean } = { category: true, tag: true },
): Promise<{ next: ListDiscovery; staleFields: ("category" | "tag")[] }> {
  const next: ListDiscovery = { ...disc };
  const staleFields: ("category" | "tag")[] = [];
  const checks: ("category" | "tag")[] = [];
  if (scope.category && disc.category && !taxonomy.categories.some((e) => e.id === disc.category)) checks.push("category");
  if (scope.tag && disc.tag && !taxonomy.tags.some((e) => e.id === disc.tag)) checks.push("tag");
  for (const field of checks) {
    const id = field === "category" ? disc.category! : disc.tag!;
    const stale = probe ? (await probe(field, id)) === false : true;
    if (stale) {
      delete next[field];
      staleFields.push(field);
    }
  }
  return { next, staleFields };
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
