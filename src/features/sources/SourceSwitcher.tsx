/**
 * 源切换器（Muse 2026-11-19 根治包·多源线 条目5）：
 * 同一分类内切换数据源，切换即整页换源重拉、源间不混排。
 * badge 口径（2026-11-20 fix331/source-reliability 改读单一派生）：
 * 一律走 healthCheck.sourceHealthBadgeText——探过的源按实测四态
 * （可用不挂标/部分可用/不可用/已过期），从未探过才回落静态
 * maturity 作底（preview→「仅预览」；probe→「未实测」；blocked→
 * 「暂不可用」，用户保留口径：列表可见、点开诚实提示，不删不假
 * 数据）。旧口径对 probe 一律挂「未实测」，与自检结果双轨并存、
 * 探过了也永不摘标，已废。
 */
import { Button } from "../../shared/ui/ios/controls";
import { tracePlayback } from "../../shared/diagnostics/playbackDiagnostics";
import { sourcesForCategory, sourcesForChannel } from "./registry.ts";
import { getActiveRegistry, getRegistryInfo } from "./manifest.ts";
import { getSelfCheckResults, sourceHealthBadgeText } from "./healthCheck.ts";
import { useSourceHealthResults } from "./sourceHealth.ts";
import type { SourceCategory, SourceDef, SourceMaturity } from "./types.ts";

export interface SourceOption { id: string; label: string; badge?: string }

const toOption = (s: SourceDef): SourceOption => ({
  id: s.id,
  label: s.displayName,
  badge: sourceHealthBadgeText(s, getSelfCheckResults()[s.id], Date.now(), getActiveRegistry().manifestVersion, getRegistryInfo().appVersion),
});

/* UI 消费口径（Muse 2026-11-19 整改 D2）：一律读 active 注册表
 * （远程清单覆盖后即时生效），不再读内置表。 */
export function sourceOptionsForCategory(category: SourceCategory): SourceOption[] {
  return sourcesForCategory(category, getActiveRegistry().sources).map(toOption);
}

/* 频道切源片口径（Muse 2026-11-19 fix321-F2）：按频道-源映射
 * （registry.sourcesForChannel）取源，无该频道真实品类映射的源
 * 不进该频道切源列表；sourcesForChannel 只返回已启用源。 */
export function sourceOptionsForChannel(cate: string): SourceOption[] {
  return sourcesForChannel(cate, getActiveRegistry().sources).map(toOption);
}

export function SourceSwitcher({ options, value, onChange, ariaLabel }: {
  options: SourceOption[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
}) {
  /* 订阅自检结果：补探/整轮落盘即重渲染，徽标按最新派生重算
   * （options 构建时的 badge 只作注册表外 id 的回落）。 */
  const healthResults = useSourceHealthResults();
  if (options.length <= 1) return null;
  const badgeFor = (o: SourceOption): string | undefined => {
    const def = getActiveRegistry().sources.find((s) => s.id === o.id);
    return def
      ? sourceHealthBadgeText(def, healthResults[o.id], Date.now(), getActiveRegistry().manifestVersion, getRegistryInfo().appVersion)
      : o.badge;
  };
  /* 源切换事件（Muse 2026-11-19 整改 D5，diag-audit #8）：只带稳定
   * 编号（active 注册表顺序 source-001 式）与分类标识，不带业务名/域名
   * （报告风控口径，AGENTS 不变量 10）。 */
  const handleSelect = (id: string) => {
    const list = getActiveRegistry().sources;
    const idx = list.findIndex((s) => s.id === id);
    tracePlayback("source.switch", {
      source: `source-${String(idx + 1).padStart(3, "0")}`,
      category: idx >= 0 ? list[idx].category : "unknown",
    });
    onChange(id);
  };
  return (
    <div role="group" aria-label={ariaLabel} className="flex gap-2 overflow-x-auto pb-1">
      {options.map((o) => {
        const badge = badgeFor(o);
        return (
          <Button key={o.id} aria-pressed={value === o.id} onClick={() => handleSelect(o.id)}
            className="ios-filter-pill shrink-0">
            <span>{o.label}</span>
            {badge && <span className="ml-1 text-[11px] text-mut">{badge}</span>}
          </Button>
        );
      })}
    </div>
  );
}

/** 非黄果源的诚实提示（按成熟度分化，用户保留口径）：
 * blocked＝站点实测不可达——保留在列表、点开只给证据与状态，不拉
 * 数据、不拿别源内容冒充；其余（probe/stable）＝该分类的外部源
 * 浏览页尚未接通时暂不展示内容（视频/图片分类已于 2026-11-19
 * 最终版 D 线接通 SourceBrowse/SourceGallery、吃瓜帖分类已于
 * 3.3.0 接通批接通 SourcePosts，三分类均不再走本提示；
 * 本提示现行只用于 blocked 全部）。 */
export function SourcePendingNotice({ displayName, maturity, note }: { displayName: string; maturity?: SourceMaturity; note?: string }) {
  if (maturity === "blocked") {
    return (
      <div role="status" className="mx-4 mt-6 rounded-[18px] bg-s2 px-4 py-5 text-center">
        <div className="text-[14px] font-semibold text-on">{displayName}（暂不可用）</div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-mut">
          真站实测显示该站点当前不可达，暂不展示内容，也不会拿其他源的数据冒充。该源已保留在列表中，后续版本将重新评估开放。
        </p>
        {note && <p className="mt-1.5 text-[12px] leading-relaxed text-mut">实测记录：{note}</p>}
      </div>
    );
  }
  return (
    <div role="status" className="mx-4 mt-6 rounded-[18px] bg-s2 px-4 py-5 text-center">
      <div className="text-[14px] font-semibold text-on">{displayName}</div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-mut">
        该源已注册、适配器与受控取页通道已就绪，但本分类的外部源浏览页尚未接通，暂不展示内容，以免混入其他源数据。
        {maturity === "probe" ? "该源尚未完成真站验通，实际可用性以实测为准。" : ""}
      </p>
    </div>
  );
}
