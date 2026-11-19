/**
 * 页内去重（Muse 2026-11-19 根治包 P2-20，audit6 §四）：
 * 旧四处手写 filter 只拿 prev 建 seen、从不把 incoming 已收的 id
 * 同步入 seen，同一页响应内部自带重复 id 时会整批漏过、列表里
 * 出现重复条目（React key 撞车 + 视觉重复）。统一收敛到这里：
 * 迭代 incoming 时同步入 seen，页内重复只入一条。
 */
export function dedupedIncoming<T>(
  prev: readonly T[],
  incoming: readonly T[],
  getId: (item: T) => number | string,
): T[] {
  const seen = new Set(prev.map(getId));
  const added: T[] = [];
  for (const item of incoming) {
    const key = getId(item);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(item);
  }
  return added;
}

/** 返回 [...prev, ...incoming 中未出现过的新条目]（含 incoming 页内去重）。 */
export function appendDeduped<T>(
  prev: readonly T[],
  incoming: readonly T[],
  getId: (item: T) => number | string,
): T[] {
  return [...prev, ...dedupedIncoming(prev, incoming, getId)];
}
