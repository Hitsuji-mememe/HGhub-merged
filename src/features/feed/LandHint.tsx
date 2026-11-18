import { Button } from "../../shared/ui/ios/controls";
import { IClose } from "../../shared/ui/icons";

/* 「横屏观看」轻提示（蓝图 P3；2026-11-18 缺陷8 收口为纯提示）：横屏源
   在竖屏容器内首次遇到时出现一次，位置与操作行全屏钮同位（底栏上方
   右侧；全屏钮位置由第11项定版在操作行右端），只指路、没有任何旋转
   动作——进横屏的唯一入口是用户亲手点全屏钮。关闭即记已见（Feed 的
   landHintSeen），切走该条目同样记已见，只出现一次。不强制旋转。 */
export function LandHint({ bottom, onDismiss }: { bottom: string; onDismiss: () => void }) {
  return (
    <div className="absolute inset-x-0 z-40 flex justify-end px-3 pointer-events-none" style={{ bottom }}>
      <div className="hg-chip-strong pointer-events-auto flex items-center gap-1 rounded-full backdrop-blur-md elev-1 pl-4 pr-1 py-1">
        <span className="text-[13px] font-semibold hg-ink">横屏源 · 点右下全屏钮横屏观看</span>
        <Button onClick={onDismiss} aria-label="关闭横屏提示" className="w-9 h-9 rounded-full flex items-center justify-center pressable hg-ink-2">
          <IClose size={14} />
        </Button>
      </div>
    </div>
  );
}
