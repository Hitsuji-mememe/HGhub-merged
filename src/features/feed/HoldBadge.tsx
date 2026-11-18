import { Button } from "../../shared/ui/ios/controls";
import { IBoltF } from "../../shared/ui/icons";
import { useStore } from "../../shared/model/store";
import { useHoldRate } from "./holdState";

/* 移动端倍速状态胶囊（自 Feed 抽出的叶子，Muse 2026-11-18）：自己订阅
   hold 外部 store 与基准 rate，hold 置位/复位只重渲染本叶子，不牵动 Feed。
   fs/idle 由 Feed 以 props 传入（显隐条件沿原版：hold 中恒显；非 hold 且
   rate!==1 时，真实全屏隐藏态不显）。点按恢复 1x 的动作（setRate +
   videoRef.rate(1)）由 Feed 以 onResetRate 回调传入，hold 中点按不恢复。 */
export function HoldBadge({ fs, idle, onResetRate }: { fs: boolean; idle: boolean; onResetRate: () => void }) {
  const hold = useHoldRate();
  const { rate } = useStore();
  if (!(hold || rate !== 1) || !(hold || !fs || !idle)) return null;
  const r = hold || rate;
  return (
    <Button
      onClick={() => { if (rate !== 1 && !hold) onResetRate(); }}
      className="absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 px-3.5 h-8 rounded-full text-[13px] font-semibold whitespace-nowrap pressable"
      style={{ top: "calc(var(--sat, 0px) + 54px)", background: "rgba(0,0,0,.18)", color: "rgba(255,255,255,.85)" }}>
      <IBoltF size={13} />
      {r}x {hold ? "加速中 · 松开恢复" : "倍速 · 点按恢复 1x"}
    </Button>
  );
}
