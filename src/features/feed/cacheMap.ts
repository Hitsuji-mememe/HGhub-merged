/* ── 有界缓存工具（Muse 2026-11-19 根治包，audit6 P1-3/P2-08）──
 * Feed 的播放 URL / 详情 / 帖子缓存此前全是无上限 Record，长会话无界
 * 增长；仓内既有惯例是给表设 FIFO 上限（detailRequests 12 条）。这里
 * 抽一份共享工具：Map 版（保插入序）与 Record 版（状态对象）各一，
 * URL 类上限 200 条、details/posts 各 100 条（任务定版数值）。 */

export const URL_CACHE_CAPACITY = 200;
export const DETAIL_CACHE_CAPACITY = 100;

/** Map 写入口：已存在键只更新值不刷新序；新键超限时淘汰最旧键。 */
export function setCapped<K, V>(map: Map<K, V>, key: K, value: V, capacity: number): void {
  if (!map.has(key)) {
    while (map.size >= capacity) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
  map.set(key, value);
}

/** Record 写后裁剪：按 Object.keys 的插入序淘汰最旧键（数字键会被 JS
 * 引擎按数值序枚举——details/posts 以视频 id 为键时 FIFO 退化为 id 序
 * 淘汰，仍保证有界；顺序敏感场景用 Map 版）。 */
export function capRecordByFifo<T>(record: Record<number, T>, capacity: number): Record<number, T> {
  const keys = Object.keys(record);
  if (keys.length <= capacity) return record;
  const next = { ...record };
  for (const key of keys.slice(0, keys.length - capacity)) delete next[Number(key)];
  return next;
}

/** 字符串键 Record 版（relatedByVideo 等）：同样 FIFO 有界。 */
export function capStringRecordByFifo<T>(record: Record<string, T>, capacity: number): Record<string, T> {
  const keys = Object.keys(record);
  if (keys.length <= capacity) return record;
  const next = { ...record };
  for (const key of keys.slice(0, keys.length - capacity)) delete next[key];
  return next;
}

/** 播放缓存作用域键（不变量 2）：账号作用域＋线路代次＋内容 id＋集数。
 * 切线/换账号后旧条目按键不可达，读路径不再需要额外校验。 */
export function scopedPlayKey(accountScope: string, lineEpoch: number, id: number, ep: number): string {
  return `${accountScope}:${lineEpoch}:${id}:${ep}`;
}
