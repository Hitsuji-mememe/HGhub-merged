import { IBoltF, ICheck } from "../../shared/ui/icons";

export const RATES = [0.75, 1, 1.25, 1.5, 2, 3];

/**
 * 全屏底栏倍速直达选单（深色毛玻璃浮层，样式对齐 SuperResMenu）：点选即定档并
 * 一直生效，取代原「⚡ 钮点按循环切档」；长按只作临时 2x 快进（2.0.4）。
 */
export function RateMenu({
  current,
  onSelect,
}: {
  current: number;
  onSelect: (r: number) => void;
}) {
  return (
    <div
      role="menu"
      aria-label="倍速选择"
      data-no-gesture
      onPointerDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        bottom: "calc(100% + 8px)",
        right: 0,
        width: 168,
        background: "rgba(14, 17, 24, 0.92)",
        backdropFilter: "blur(18px)",
        WebkitBackdropFilter: "blur(18px)",
        border: "1px solid rgba(255, 255, 255, 0.14)",
        boxShadow: "0 14px 36px rgba(0, 0, 0, 0.56)",
        borderRadius: 14,
        padding: 6,
        zIndex: 60,
      }}
      className="a-fade">
      <div className="flex items-center justify-between px-2.5 pt-1 pb-1.5 text-[10.5px] font-semibold text-white/55">
        <span className="flex items-center gap-1">
          <IBoltF size={11} className="text-primary" />
          <span>播放倍速</span>
        </span>
        <span className="text-[10px] text-white/40">点选生效</span>
      </div>
      <div className="flex flex-col gap-0.5">
        {RATES.map((r) => {
          const active = current === r;
          return (
            <button
              key={r}
              type="button"
              role="menuitemradio"
              aria-checked={active}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(r);
              }}
              className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-[10px] text-left transition-colors pressable ${
                active ? "bg-white/14" : "hover:bg-white/8"
              }`}>
              <span className={`text-[12px] font-bold ${active ? "text-primary" : "text-white/95"}`}>{r}x</span>
              {active && <ICheck size={14} className="text-primary shrink-0" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
