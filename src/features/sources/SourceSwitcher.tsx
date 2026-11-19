/**
 * 源切换器（Muse 2026-11-19 根治包·多源线 条目5）：
 * 同一分类内切换数据源，切换即整页换源重拉、源间不混排。
 * badge 口径：preview→「仅预览」；probe→「未实测」（适配器已注册、
 * 运行时取页通道未接入，不假装可用）。
 */
import { Button } from "../../shared/ui/ios/controls";
import { sourcesForCategory } from "./registry.ts";
import type { SourceCategory } from "./types.ts";

export interface SourceOption { id: string; label: string; badge?: string }

export function sourceOptionsForCategory(category: SourceCategory): SourceOption[] {
  return sourcesForCategory(category).map((s) => ({
    id: s.id,
    label: s.displayName,
    badge: s.maturity === "preview" ? "仅预览" : s.maturity === "probe" ? "未实测" : undefined,
  }));
}

export function SourceSwitcher({ options, value, onChange, ariaLabel }: {
  options: SourceOption[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
}) {
  if (options.length <= 1) return null;
  return (
    <div role="group" aria-label={ariaLabel} className="flex gap-2 overflow-x-auto pb-1">
      {options.map((o) => (
        <Button key={o.id} aria-pressed={value === o.id} onClick={() => onChange(o.id)}
          className="ios-filter-pill shrink-0">
          <span>{o.label}</span>
          {o.badge && <span className="ml-1 text-[11px] text-mut">{o.badge}</span>}
        </Button>
      ))}
    </div>
  );
}

/** 非黄果源的诚实占位：已注册但取页通道未接入，不展示假数据。 */
export function SourcePendingNotice({ displayName }: { displayName: string }) {
  return (
    <div role="status" className="mx-4 mt-6 rounded-[18px] bg-s2 px-4 py-5 text-center">
      <div className="text-[14px] font-semibold text-on">{displayName}</div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-mut">
        该源已注册、适配器已就绪，但运行时取页通道（Rust 受控取页命令）尚未接入，暂不展示内容，以免混入其他源数据。
      </p>
    </div>
  );
}
