/* 搜索历史多选的纯状态函数（Muse 2026-11-21 fix3311/small-features，
 * 上游 #184 拣选）：长按批量删的选集增删与有效性裁剪独立于组件，
 * 供 SearchHistory 组件与契约共用同一口径（仿 TagBlockMenu 的
 * validSelected：选集只认当前仍在历史里的条目，陈旧选择不计数、
 * 不删除）。 */

/** 长按进入多选的判定时长（ms）：短于此的点按仍是打开搜索。 */
export const HISTORY_LONG_PRESS_MS = 500;

/** 勾选切换：不在选集则加入、在则移除；不改入参，返回新数组。 */
export function toggleHistorySelection(selected: readonly string[], item: string): string[] {
  return selected.includes(item)
    ? selected.filter((x) => x !== item)
    : [...selected, item];
}

/** 有效选集：只保留当前历史里仍存在的条目（历史被清空/外部变更后
 * 选集自动失效，不许拿陈旧选集去删或计数）。 */
export function validHistorySelection(selected: readonly string[], hist: readonly string[]): string[] {
  return selected.filter((x) => hist.includes(x));
}
