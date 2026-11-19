/* ── 有界缓存工具（Muse 2026-11-19 根治包，audit6 P1-3/P2-08）──
 * Feed 的播放 URL / 详情 / 帖子缓存此前全是无上限 Record，长会话无界
 * 增长；仓内既有惯例是给表设 FIFO 上限（detailRequests 12 条）。这里
 * 抽一份共享工具：Map 版（保插入序）与 Record 版（状态对象）各一，
 * URL 类上限 200 条、details/posts 各 100 条（任务定版数值）。 */

export const URL_CACHE_CAPACITY = 200;
export const DETAIL_CACHE_CAPACITY = 100;

/* ── 缓存计数（Muse 2026-11-19 根治包·飞行记录仪收口）──
 * 命中/未命中/写入/淘汰/作用域失效只记聚合计数供诊断快照判读；
 * 逐次淘汰不入统一时间线（高频且单条无判读价值），作用域整表
 * 清空由调用方另发 cache.scope_clear 事件入流水。进程期有效、
 * 不落盘；计数本身永不抛错、永不影响缓存行为。 */
export type CacheCounters = { hits: number; misses: number; sets: number; evictions: number; scopeClears: number };
const counters: CacheCounters = { hits: 0, misses: 0, sets: 0, evictions: 0, scopeClears: 0 };
export const noteCacheHit = (): void => { counters.hits++; };
export const noteCacheMiss = (): void => { counters.misses++; };
export const noteCacheScopeClear = (): void => { counters.scopeClears++; };
export const cacheCountersSnapshot = (): CacheCounters => ({ ...counters });

/** Map 写入口：已存在键只更新值不刷新序；新键超限时淘汰最旧键。 */
export function setCapped<K, V>(map: Map<K, V>, key: K, value: V, capacity: number): void {
  counters.sets++;
  if (!map.has(key)) {
    while (map.size >= capacity) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
      counters.evictions++;
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
  counters.evictions += keys.length - capacity;
  const next = { ...record };
  for (const key of keys.slice(0, keys.length - capacity)) delete next[Number(key)];
  return next;
}

/** 字符串键 Record 版（relatedByVideo 等）：同样 FIFO 有界。 */
export function capStringRecordByFifo<T>(record: Record<string, T>, capacity: number): Record<string, T> {
  const keys = Object.keys(record);
  if (keys.length <= capacity) return record;
  counters.evictions += keys.length - capacity;
  const next = { ...record };
  for (const key of keys.slice(0, keys.length - capacity)) delete next[key];
  return next;
}

/** 播放缓存作用域键（不变量 2）：资料库作用域（恒 LOCAL_SCOPE）＋
 * 线路代次＋内容 id＋集数。切线后旧条目按键不可达，读路径不再需要
 * 额外校验。 */
export function scopedPlayKey(scope: string, lineEpoch: number, id: number, ep: number): string {
  return `${scope}:${lineEpoch}:${id}:${ep}`;
}
