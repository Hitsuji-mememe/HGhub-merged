import { Button } from "../../shared/ui/ios/controls";
import { IClose } from "../../shared/ui/icons";

/* 「横屏观看」轻提示（蓝图 P3；2026-11-18 缺陷7 改位）：横屏源在竖屏
   容器内首次遇到时出现一次，位置与控制层顶栏的全屏钮同位（顶栏下方
   右侧），指向该钮——全屏入口本体恒在顶栏（随控制层出现），提示只是
   首次指路。点「横屏观看」才转横屏并记住选择（之后横屏源自动进横屏、
   按集守卫、手动退出不被拉回）；点关闭记住「不转」，不再出现。
   不强制旋转，与三维状态互不触发。 */
export function LandHint({ top, onAccept, onDismiss }: { top: string; onAccept: () => void; onDismiss: () => void }) {
  return (
    <div className="absolute inset-x-0 z-40 flex justify-end px-3 pointer-events-none" style={{ top }}>
      <div className="hg-chip-strong pointer-events-auto flex items-center gap-1 rounded-full backdrop-blur-md elev-1 pl-4 pr-1 py-1">
        <span className="text-[13px] font-semibold hg-ink">横屏观看更佳</span>
        <Button onClick={onAccept} className="h-9 px-3 rounded-full bg-primary text-on-primary text-[13px] font-bold pressable">横屏观看</Button>
        <Button onClick={onDismiss} aria-label="关闭横屏提示" className="w-9 h-9 rounded-full flex items-center justify-center pressable hg-ink-2">
          <IClose size={14} />
        </Button>
      </div>
    </div>
  );
}
