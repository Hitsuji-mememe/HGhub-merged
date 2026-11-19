/**
 * 源切换器（Muse 2026-11-19 根治包·多源线 条目5）：
 * 同一分类内切换数据源，切换即整页换源重拉、源间不混排。
 * badge 口径：preview→「仅预览」；probe→「未实测」（适配器已注册、
 * 未完整验通，不假装可用）；blocked→「暂不可用」（用户保留口径：
 * 列表可见、点开诚实提示，不删不假数据）。
 */
import { Button } from "../../shared/ui/ios/controls";
import { tracePlayback } from "../../shared/diagnostics/playbackDiagnostics";
import { sourcesForCategory } from "./registry.ts";
import { getActiveRegistry } from "./manifest.ts";
import type { SourceCategory, SourceMaturity } from "./types.ts";

export interface SourceOption { id: string; label: string; badge?: string }

/* UI 消费口径（Muse 2026-11-19 整改 D2）：一律读 active 注册表
 * （远程清单覆盖后即时生效），不再读内置表。 */
export function sourceOptionsForCategory(category: SourceCategory): SourceOption[] {
  return sourcesForCategory(category, getActiveRegistry().sources).map((s) => ({
    id: s.id,
    label: s.displayName,
    badge: s.maturity === "preview" ? "仅预览" : s.maturity === "blocked" ? "暂不可用" : s.maturity === "probe" ? "未实测" : undefined,
  }));
}

export function SourceSwitcher({ options, value, onChange, ariaLabel }: {
  options: SourceOption[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
}) {
  if (options.length <= 1) return null;
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
      {options.map((o) => (
        <Button key={o.id} aria-pressed={value === o.id} onClick={() => handleSelect(o.id)}
          className="ios-filter-pill shrink-0">
          <span>{o.label}</span>
          {o.badge && <span className="ml-1 text-[11px] text-mut">{o.badge}</span>}
        </Button>
      ))}
    </div>
  );
}

/** 非黄果源的诚实提示（按成熟度分化，用户保留口径）：
 * blocked＝站点实测不可达——保留在列表、点开只给证据与状态，不拉
 * 数据、不拿别源内容冒充；其余（probe/stable）＝本分类的外部源
 * 浏览页尚未接通时暂不展示内容（视频/图片分类已于 2026-11-19
 * 最终版 D 线接通 SourceBrowse/SourceGallery，不再走本提示；
 * 本提示现行用于 blocked 全部与吃瓜帖分类的非黄果源）。 */
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
