import { useSyncExternalStore } from "react";

/* 长按倍速的外部 store（Muse 2026-11-18）：hold 变化只通知订阅它的
   叶子组件（HoldBadge），不再触发整个 Feed 重渲染——长按卡顿的根因就是
   holdSpeed 作为 Feed 的 useState 时每次置位都重渲染 Feed 全树。
   值 = 当前 hold 倍速，0 表示未 hold；实际倍速由手势回调经
   videoRef.rate() 直接通道下发，VideoSurface 的 rate prop 只认基准倍速。 */
let holdRate = 0;
const listeners = new Set<() => void>();

export const holdState = {
  get: () => holdRate,
  set: (v: number) => {
    if (holdRate === v) return;
    holdRate = v;
    listeners.forEach((l) => l());
  },
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
};

export function useHoldRate() {
  return useSyncExternalStore(holdState.subscribe, holdState.get, holdState.get);
}
