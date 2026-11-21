/**
 * 发现维度条（Muse 2026-11-20 fix335/f-discovery）：两浏览组件
 * （SourceGallery/SourcePosts）列表态顶部共用——只渲染
 * DiscoverySpec 已登记维度（未实证不登记、空 spec 整条不渲染，不
 * 新增页面/路由/surface）。选项来源三路：注册表栏目表（吃瓜三源）、
 * 适配器 taxonomy()（WP 分类/标签）。
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
 * 瘦身＋标签弹层（Muse 2026-11-21 fix3314/header-slim，用户真机
 * 实报筛选头约占 45% 屏高、20:14 亲定最终口径）：主界面顶部只剩
 * 一条瘦筛选栏——排序＝小号分段开关（SegmentedControl）、分类＝
 * 一行横滑 chips（Top-N＋最近置顶口径不变）、榜单（吃瓜）占分类
 * 槽位同形态横滑；标签退出主界面、改底部弹层（Sheet）选择器：
 * 「筛选」按钮带已选标签数徽标开弹层，弹层内搜索框固定顶部（搜
 * 标签本身、中英文＋服务端长尾补取口径不变）、标签多行平铺网
 * 格全量呈现（不再吃 Top-N 截断）、可清除全部；已选标签以小
 * chip 回显筛选栏（点 × 移除）。fix336 的行内「展开/收起」与行
 * 内「找标签」输入框随之退场——分类与标签仍可叠加生效、disc 语
 * 义与每源持久化逐字不变，只换呈现与入口。
 *
 * 回滚注记（Muse 2026-11-21 fix3312/discovery-b）：fix3311 曾给
 * 本组件加图片面门控 prop（门控下剥分类/标签两行），用户真机
 * 实报聚合源没分类即不可用、当日改令整体回滚——各面一律按登记
 * spec 渲染，本组件无面门控。后续汉化/兴趣直达见 fix3312 契约。
 *
 * 收尾（Muse 2026-11-21 fix3313/discovery-tail）：标签搜索补
 * 服务端长尾（searchTags 补取并池、口径不变）；落盘 disc 的
 * taxonomy 值加失效自检（站方改 id 后回落为空＋诊断账本留痕，
 * 不再静默过滤为空列表）。见 fix3313 契约。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, SegmentedControl } from "../../shared/ui/ios/controls";
import { Sheet } from "../../shared/ui/ios/overlays";
import { record } from "../../shared/diagnostics/eventLedger.ts";
import { createAdapter } from "./adapters/index.ts";
import { discoverySpecFor, hasDiscovery, type DiscoveryOption } from "./adapters/templateCapabilities.ts";
import { classifySelfCheckResult } from "./healthCheck.ts";
import { dedupeTagOptions, mergeTaxonEntries, pinRecentOptions, resolveStaleDiscFields } from "./discoveryOptions.ts";
import { serverTagSearchTerms, tagOptionMatchesQuery, taxonKeysForChineseQuery, taxonZhLabel } from "./taxonLabels.ts";
import { useSourceHealthResults } from "./sourceHealth.ts";
import type { ListDiscovery, SourceDef, SourceTaxonomy, TaxonEntry } from "./types.ts";

/* taxonomy 型分类 chips 上限：分类行只呈现 Top-N（按端点/聚合的
 * 计数序）。标签已移入弹层平铺全量、不再受此限。params 型栏目表
 * 全集有限（≤30），不截断。 */
const TAXONOMY_CHIP_LIMIT = 24;
/* 弹层内标签搜索命中上限：搜索态已是定向查找，给足长尾覆盖
 * 即可，不许一次把上千命中全量平铺成墙。 */
const TAG_SEARCH_LIMIT = 60;

export default function DiscoveryBar({ def, disc, onDiscChange, recentCategories, recentTags }: {
  def: SourceDef;
  disc: ListDiscovery;
  onDiscChange: (next: ListDiscovery) => void;
  /** 最近用过的分类/标签 value（fix3312/discovery-b 兴趣直达）：
   * 宿主从落盘 disc 状态（discState）下传，行内按此置顶；缺省
   * 不置顶、呈现与旧行为一致。 */
  recentCategories?: string[];
  recentTags?: string[];
}) {
  const spec = useMemo(() => discoverySpecFor(def), [def]);
  const healthResults = useSourceHealthResults();
  const health = classifySelfCheckResult(healthResults[def.id], def, Date.now());
  const down = health.status === "down";
  const needsTaxonomy = spec.categories?.source === "taxonomy" || spec.tagFilter === true;
  /* 标签弹层开关（fix3314/header-slim）：只管呈现、不进 disc。 */
  const [tagSheetOpen, setTagSheetOpen] = useState(false);
  /* 标签弹层内搜索（fix3312/discovery-b 迁入弹层，fix3314）：长
   * 名单的定向查找——只管呈现、不进 disc；切源即清，免跨源串
   * 词。匹配含中文反查（taxonLabels：输中文译名命中英文原标签）。 */
  const [tagQuery, setTagQuery] = useState("");
  /* 服务端补取的长尾标签（fix3313/discovery-tail）：搜索态经
   * searchTags 按词补取、与本地名单合并成池；切源清空，查询清
   * 空不清——已选中/最近用过的长尾标签靠它在弹层内保持可见可取消。 */
  const [remoteTags, setRemoteTags] = useState<TaxonEntry[]>([]);
  useEffect(() => { setTagQuery(""); setRemoteTags([]); setTagSheetOpen(false); }, [def.id]);
  const searching = tagQuery.trim().length > 0;
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

  /* 标签长尾补取（fix3313/discovery-tail）：搜索词非空且适配器有
   * searchTags 时，按派生词（英文原词/中文反查键）防抖补取、结果
   * 并入 remoteTags 池。补取失败静默——本地名单搜索照常，未知不
   * 冒充无此标签。 */
  useEffect(() => {
    if (!searching || !spec.tagFilter) return undefined;
    const adapter = createAdapter(def);
    if (!adapter?.searchTags) return undefined;
    const terms = serverTagSearchTerms(tagQuery);
    if (terms.length === 0) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      Promise.all(terms.map((t) => adapter.searchTags!(t).catch(() => [] as TaxonEntry[])))
        .then((lists) => { if (live) setRemoteTags((prev) => mergeTaxonEntries(prev, lists.flat())); })
        .catch(() => { /* 补取失败：只用本地名单 */ });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagQuery, searching, def.id, spec.tagFilter]);

  /* 落盘 disc 的 taxonomy 失效自检（fix3313/discovery-tail）：站方
   * 改 taxonomy id 后旧值静默过滤为空列表——taxonomy 到手后核对
   * 一次：名单外的值经 resolveStaleDiscFields 判定（wp-rest 走
   * taxonExists 探针、404 才清；无探针的适配器 taxonomy 即全集、
   * 缺席即清），失效字段回落为空（经 onDiscChange 落盘）并记一
   * 条诊断账本事件（disc.taxon_stale_*，导出尾段可判读）。同一
   * 「源＋disc 值」组合只查一次，探针未知时保留原值不重复打扰。 */
  const staleCheckKeyRef = useRef("");
  useEffect(() => {
    if (!taxonomy || !needsTaxonomy) return undefined;
    const key = `${def.id}|${disc.category ?? ""}|${disc.tag ?? ""}`;
    if (staleCheckKeyRef.current === key) return undefined;
    staleCheckKeyRef.current = key;
    let live = true;
    const adapter = createAdapter(def);
    resolveStaleDiscFields(disc, taxonomy, adapter?.taxonExists ?? null, {
      category: spec.categories?.source === "taxonomy",
      tag: spec.tagFilter === true,
    }).then(({ next, staleFields }) => {
      if (!live || staleFields.length === 0) return;
      for (const field of staleFields) {
        record(`disc.taxon_stale_${field}`, { source: def.id, field, value: disc[field] });
      }
      onDiscChange(next);
    }).catch(() => { /* 判定异常：保留原值（未知不是空） */ });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taxonomy, def.id, needsTaxonomy]);

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

  /* 分类：最近用过先置顶再取 Top-N（fix3312/discovery-b）——置顶
   * 在截断之前，上次用过的分类重开即在队首、不被 Top-N 挤出；
   * 已选中分类若仍被挤出（002 厂牌 174 个），同标签口径补回行
   * 尾——选中态必须可见可取消。params 型栏目表全集有限、不截
   * 断不置顶（吃瓜榜单序即站方序）。 */
  const categoryOptions: DiscoveryOption[] = (() => {
    if (!spec.categories) return [];
    if (spec.categories.source === "params") return spec.categories.options;
    const all = (taxonomy?.categories ?? []).map((e) => ({ value: e.id, label: e.name }));
    const pinned = pinRecentOptions(all, recentCategories ?? []);
    const top = pinned.slice(0, TAXONOMY_CHIP_LIMIT);
    if (disc.category && !top.some((o) => o.value === disc.category)) {
      const sel = pinned.find((o) => o.value === disc.category);
      if (sel) top.push(sel);
    }
    return top;
  })();
  /* 弹层标签池：先与分类同名剔除（fix336/ui-fixes，比对集＝本条
   * 实际呈现的分类选项 categoryOptions；已选中标签保留防悬空），
   * 再并服务端补取长尾、最近用过置顶（fix3312/discovery-b）。
   * 非搜索态＝全量平铺（fix3314 弹层口径，不再吃 Top-N 截断）；
   * 搜索态走全量匹配、命中上限 TAG_SEARCH_LIMIT——长尾标签靠
   * 搜索直达。 */
  const tagOptions: DiscoveryOption[] = (() => {
    if (!spec.tagFilter) return [];
    const all = mergeTaxonEntries(taxonomy?.tags ?? [], remoteTags)
      .map((e) => ({ value: e.id, label: e.name }));
    const deduped = dedupeTagOptions(categoryOptions, all, disc.tag);
    const pinned = pinRecentOptions(deduped, recentTags ?? []);
    if (searching) {
      const zhKeys = taxonKeysForChineseQuery(tagQuery);
      return pinned
        .filter((o) => tagOptionMatchesQuery(o, tagQuery, zhKeys))
        .slice(0, TAG_SEARCH_LIMIT);
    }
    return pinned;
  })();
  /* 已选标签的回显选项（筛选栏 chip）：从全池按 value 找回——
   * 池未到手（taxonomy 未回）时回落 value 本身作显示，不冒充无选。 */
  const selectedTagOption: DiscoveryOption | undefined = disc.tag
    ? tagOptions.find((o) => o.value === disc.tag)
      ?? (taxonomy?.tags ?? []).map((e) => ({ value: e.id, label: e.name })).find((o) => o.value === disc.tag)
      ?? { value: disc.tag, label: disc.tag }
    : undefined;
  const selectedTagCount = disc.tag ? 1 : 0;

  const pill = (key: string, label: string, pressed: boolean, onClick: () => void, originalName?: string) => (
    <Button key={key} aria-pressed={pressed} disabled={down} onClick={onClick}
      title={originalName} aria-label={originalName ? `${label}（原名 ${originalName}）` : undefined}
      className="ios-filter-pill shrink-0">{label}</Button>
  );
  /* 分类/标签 chip 的汉化显示（fix3312/discovery-b 第 3 段）：只换
   * 显示文案——有译名显中文、原名退到 title/aria-label 供查对；
   * value 与点选回传逐字不变，筛选行为与未汉化时一致。未收录
   * （专名/歧义词）回落原名。排序/榜单是登记表中文原名，不经此。 */
  const taxonPill = (prefix: string, o: DiscoveryOption, pressed: boolean, onClick: () => void) => {
    const zh = taxonZhLabel(def.id, o.label);
    return pill(`${prefix}:${o.value}`, zh ?? o.label, pressed, onClick, zh ? o.label : undefined);
  };
  const chipRow = (children: React.ReactNode) => (
    <div className="flex flex-1 min-w-0 flex-nowrap gap-1.5 overflow-x-auto">{children}</div>
  );

  const sortValue = disc.sort ?? spec.sortDefault ?? "";
  const sortIndex = Math.max(0, (spec.sorts ?? []).findIndex((o) => o.value === sortValue));

  return (
    <div className="mb-2" aria-label="发现维度">
      {/* 瘦筛选栏（fix3314）：一行——排序分段开关＋分类/榜单横滑
       * chips＋已选标签 chip＋「筛选」按钮（徽标＝已选标签数）。 */}
      <div className="flex items-center gap-2 py-1">
        {spec.sorts && (
          <SegmentedControl aria-label="排序" activeIndex={sortIndex} className="shrink-0">
            {spec.sorts.map((o) => (
              <Button key={`sort:${o.value}`} aria-pressed={sortValue === o.value} disabled={down}
                onClick={() => setSort(o.value)}>{o.label}</Button>
            ))}
          </SegmentedControl>
        )}
        {spec.rankPeriods && chipRow(spec.rankPeriods.map((o) =>
          pill(`period:${o.value}`, o.label, (disc.period ?? spec.periodDefault ?? "") === o.value, () => setPeriod(o.value))))}
        {spec.categories && categoryOptions.length > 0 && chipRow([
          pill("cat:__all", "全部", !disc.category, () => setCategory(undefined)),
          ...categoryOptions.map((o) =>
            taxonPill("cat", o, disc.category === o.value, () => setCategory(disc.category === o.value ? undefined : o.value))),
        ])}
        {spec.tagFilter && selectedTagOption && (
          <span className="ios-filter-pill shrink-0" aria-label={`已选标签：${taxonZhLabel(def.id, selectedTagOption.label) ?? selectedTagOption.label}`}>
            {taxonZhLabel(def.id, selectedTagOption.label) ?? selectedTagOption.label}
            <Button aria-label="移除已选标签" disabled={down} onClick={() => setTag(undefined)}
              className="ml-1 px-0.5 text-[13px] leading-none">×</Button>
          </span>
        )}
        {spec.tagFilter && (
          <Button aria-label={selectedTagCount > 0 ? `筛选标签，已选 ${selectedTagCount} 个` : "筛选标签"}
            disabled={down} onClick={() => setTagSheetOpen(true)}
            className="ios-filter-pill shrink-0">
            筛选{selectedTagCount > 0 && <span aria-hidden="true" className="ml-1">({selectedTagCount})</span>}
          </Button>
        )}
      </div>
      {down && (
        <p role="status" className="py-1 text-[12px] text-danger">
          自检显示该源列表不可用（{health.failure ?? "列表失败"}），发现维度暂不可用，恢复后自动可用
        </p>
      )}
      {/* 标签底部弹层（fix3314）：搜索固定顶部、标签多行平铺网格
       * 全量呈现、点选即生效并关层；清除全部留在层内继续选。 */}
      {spec.tagFilter && (
        <Sheet open={tagSheetOpen} onClose={() => setTagSheetOpen(false)} label="标签筛选">
          <div className="flex max-h-[70vh] flex-col px-4 pb-4">
            <div className="flex items-center gap-2 pb-2">
              <span className="text-[15px] font-semibold">标签</span>
              {disc.tag && (
                <Button onClick={() => setTag(undefined)} className="px-1 py-0.5 text-[12px] text-primary">清除全部</Button>
              )}
            </div>
            <Input value={tagQuery} onChange={(e) => setTagQuery(e.target.value)}
              placeholder="输入中文或英文找标签" aria-label="找标签"
              style={{ minHeight: 36 }} className="w-full shrink-0 px-3 py-1 text-[13px]" />
            <div className="mt-3 flex flex-wrap gap-1.5 overflow-y-auto">
              {tagOptions.map((o) =>
                taxonPill("tag", o, disc.tag === o.value, () => {
                  setTag(disc.tag === o.value ? undefined : o.value);
                  setTagSheetOpen(false);
                }))}
              {tagOptions.length === 0 && taxonomy === null && (
                <p role="status" className="py-1 text-[12px] text-mut">标签加载中…</p>
              )}
              {searching && tagOptions.length === 0 && taxonomy !== null && (
                <p role="status" className="py-1 text-[12px] text-mut">未找到匹配的标签</p>
              )}
              {!searching && tagOptions.length === 0 && taxonomy !== null && (
                <p role="status" className="py-1 text-[12px] text-mut">该源暂无标签</p>
              )}
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}
