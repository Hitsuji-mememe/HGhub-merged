/**
 * 发现维度条（Muse 2026-11-20 fix335/f-discovery）：三浏览组件
 * （SourceBrowse/SourceGallery/SourcePosts）列表态顶部共用——只渲染
 * DiscoverySpec 已登记维度（未实证不登记、空 spec 整条不渲染，不
 * 新增页面/路由/surface）。选项来源三路：注册表栏目表（吃瓜三源）、
 * 适配器 taxonomy()（WP 分类/标签、002 brand/标签——chips 只取
 * Top-N 不全量平铺，WP tags 实测 1198 条）。
 *
 * disc 规范化：只存非默认选择——点选默认值（排序默认项/分类与标签
 * 的「全部」）即删对应字段，父级滚动指纹（discFingerprint）据此
 * 保持规范、切换维度后滚动位置按新指纹隔离。
 *
 * 自检降级：该源自检派生为 down（列表段失败）时整条维度禁用并
 * 明示，随健康恢复自动可用（useSourceHealthResults 订阅新结果即
 * 重渲染）；partial/unchecked/stale 不禁用——维度全骑列表段，深段
 * 失败不影响列表维度，过期结论也不冒充现行失败。
 *
 * 收敛（Muse 2026-11-20 fix336/ui-fixes，用户真机实报「标签分类
 * 反而导致阅读不便」）：①各维度行默认单行横滑（flex-nowrap＋
 * overflow-x-auto），整条末尾「展开」入口点开才 flex-wrap 全量
 * 平铺、「收起」回单行——Top-N 上限口径不变，变的只是默认呈现
 * 高度；②标签维度剔除与分类同名的条目（discoveryOptions.
 * dedupeTagOptions，规范化比对，已选中的标签保留防筛选悬空）。
 *
 * 回滚注记（Muse 2026-11-21 fix3312/discovery-b）：fix3311 曾给
 * 本组件加图片面门控 prop（门控下剥分类/标签两行），用户真机
 * 实报聚合源没分类即不可用、当日改令整体回滚——三面一律按登记
 * spec 渲染，本组件无面门控。后续汉化/兴趣直达见 fix3312 契约。
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "../../shared/ui/ios/controls";
import { createAdapter } from "./adapters/index.ts";
import { discoverySpecFor, hasDiscovery, type DiscoveryOption } from "./adapters/templateCapabilities.ts";
import { classifySelfCheckResult } from "./healthCheck.ts";
import { dedupeTagOptions } from "./discoveryOptions.ts";
import { useSourceHealthResults } from "./sourceHealth.ts";
import type { ListDiscovery, SourceDef, SourceTaxonomy } from "./types.ts";

/* taxonomy 型 chips 上限：只呈现 Top-N（按端点/聚合的计数序），
 * 不许把上千标签全量平铺。params 型栏目表全集有限（≤30），不截断。 */
const TAXONOMY_CHIP_LIMIT = 24;

export default function DiscoveryBar({ def, disc, onDiscChange }: {
  def: SourceDef;
  disc: ListDiscovery;
  onDiscChange: (next: ListDiscovery) => void;
}) {
  const spec = useMemo(() => discoverySpecFor(def), [def]);
  const healthResults = useSourceHealthResults();
  const health = classifySelfCheckResult(healthResults[def.id], def, Date.now());
  const down = health.status === "down";
  const needsTaxonomy = spec.categories?.source === "taxonomy" || spec.tagFilter === true;
  /* 展开态（fix336/ui-fixes）：默认收敛单行，展开才全量平铺；
   * 只管呈现、不进 disc——指纹与滚动 key 口径不受影响。 */
  const [expanded, setExpanded] = useState(false);
  const [taxonomy, setTaxonomy] = useState<SourceTaxonomy | null>(null);
  useEffect(() => {
    setTaxonomy(null);
    if (!needsTaxonomy || !hasDiscovery(spec)) return undefined;
    let live = true;
    const adapter = createAdapter(def);
    adapter?.taxonomy?.()
      .then((t) => { if (live) setTaxonomy(t); })
      .catch(() => { /* 选项取不到：对应行不渲染，不拿空冒充无分类 */ });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def.id, needsTaxonomy]);

  if (!hasDiscovery(spec)) return null;

  const setSort = (value: string) => {
    const next = { ...disc };
    if (value === (spec.sortDefault ?? "")) delete next.sort;
    else next.sort = value;
    onDiscChange(next);
  };
  const setPeriod = (value: string) => {
    const next = { ...disc };
    if (value === (spec.periodDefault ?? "")) delete next.period;
    else next.period = value;
    onDiscChange(next);
  };
  const setCategory = (value: string | undefined) => {
    const next = { ...disc };
    if (!value) delete next.category;
    else next.category = value;
    onDiscChange(next);
  };
  const setTag = (value: string | undefined) => {
    const next = { ...disc };
    if (!value) delete next.tag;
    else next.tag = value;
    onDiscChange(next);
  };

  const categoryOptions: DiscoveryOption[] = !spec.categories
    ? []
    : spec.categories.source === "params"
      ? spec.categories.options
      : (taxonomy?.categories ?? []).slice(0, TAXONOMY_CHIP_LIMIT).map((e) => ({ value: e.id, label: e.name }));
  /* 标签先与分类同名剔除再取 Top-N（fix336/ui-fixes）：剔除在
   * 截断之前，被同名项占掉的名额由后续不同名标签补回；比对的
   * 分类集＝本条实际呈现的分类选项（categoryOptions）。已选中
   * 标签若被 Top-N 截断挤出，补回行尾——选中态必须可见可取消。 */
  const tagOptions: DiscoveryOption[] = (() => {
    if (!spec.tagFilter) return [];
    const all = (taxonomy?.tags ?? []).map((e) => ({ value: e.id, label: e.name }));
    const deduped = dedupeTagOptions(categoryOptions, all, disc.tag);
    const top = deduped.slice(0, TAXONOMY_CHIP_LIMIT);
    if (disc.tag && !top.some((o) => o.value === disc.tag)) {
      const sel = deduped.find((o) => o.value === disc.tag);
      if (sel) top.push(sel);
    }
    return top;
  })();

  const pill = (key: string, label: string, pressed: boolean, onClick: () => void) => (
    <Button key={key} aria-pressed={pressed} disabled={down} onClick={onClick} className="ios-filter-pill shrink-0">{label}</Button>
  );
  const row = (label: string, children: React.ReactNode) => (
    <div className="flex items-start gap-2 py-1">
      <span className="w-8 shrink-0 pt-1.5 text-[12px] text-mut">{label}</span>
      <div className={expanded
        ? "flex flex-1 min-w-0 flex-wrap gap-1.5"
        : "flex flex-1 min-w-0 flex-nowrap gap-1.5 overflow-x-auto"}>{children}</div>
    </div>
  );

  return (
    <div className="mb-2" aria-label="发现维度">
      {spec.sorts && row("排序", spec.sorts.map((o) =>
        pill(`sort:${o.value}`, o.label, (disc.sort ?? spec.sortDefault ?? "") === o.value, () => setSort(o.value))))}
      {spec.rankPeriods && row("榜单", spec.rankPeriods.map((o) =>
        pill(`period:${o.value}`, o.label, (disc.period ?? spec.periodDefault ?? "") === o.value, () => setPeriod(o.value))))}
      {spec.categories && categoryOptions.length > 0 && row("分类", [
        pill("cat:__all", "全部", !disc.category, () => setCategory(undefined)),
        ...categoryOptions.map((o) =>
          pill(`cat:${o.value}`, o.label, disc.category === o.value, () => setCategory(disc.category === o.value ? undefined : o.value))),
      ])}
      {spec.tagFilter && tagOptions.length > 0 && row("标签", [
        pill("tag:__all", "全部", !disc.tag, () => setTag(undefined)),
        ...tagOptions.map((o) =>
          pill(`tag:${o.value}`, o.label, disc.tag === o.value, () => setTag(disc.tag === o.value ? undefined : o.value))),
      ])}
      {(categoryOptions.length > 0 || tagOptions.length > 0) && (
        <div className="flex justify-end">
          <Button aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}
            className="px-1 py-0.5 text-[12px] text-primary">{expanded ? "收起" : "展开"}</Button>
        </div>
      )}
      {down && (
        <p role="status" className="py-1 text-[12px] text-danger">
          自检显示该源列表不可用（{health.failure ?? "列表失败"}），发现维度暂不可用，恢复后自动可用
        </p>
      )}
    </div>
  );
}
