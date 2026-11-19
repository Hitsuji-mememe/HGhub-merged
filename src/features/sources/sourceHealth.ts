/* ── 源健康展示面消费钩子（Muse 2026-11-20 fix331/source-reliability）──
 * 派生本体在 healthCheck.ts（classifySelfCheckResult 四态＋
 * sourceHealthBadgeText 徽标文案，全 App 单一出处）；本文件只放
 * React 消费层两件：
 * ① useSourceHealthResults——经 useSyncExternalStore 订阅自检
 *    结果落盘通知，补探/整轮一有新结果，正在显示的徽标即刷新
 *    （「探完即刷新标签」）；
 * ② useSourceSelfCheckOnView——浏览面（SourceBrowse/SourcePosts/
 *    SourceGallery）挂载时按缺失/过期/版本不符口径触发单源后台
 *    补探（ensureSourceSelfCheck），不阻塞浏览、不弹窗。 */

import { useEffect, useSyncExternalStore } from "react";
import {
  ensureSourceSelfCheck,
  getSelfCheckResults,
  subscribeSelfCheckResults,
  type SourceSelfCheckResult,
} from "./healthCheck.ts";
import { getActiveRegistry } from "./manifest.ts";
import { createAdapter } from "./adapters/index.ts";
import type { SourceDef } from "./types.ts";

/** 订阅自检结果（快照即 healthCheck 的进程内缓存，落盘即换新对象）。 */
export function useSourceHealthResults(): Record<string, SourceSelfCheckResult> {
  return useSyncExternalStore(subscribeSelfCheckResults, getSelfCheckResults, getSelfCheckResults);
}

/** 进入源浏览面时补探：按源 id 触发（def 对象随注册表覆盖换代，
 * 依赖只认 id；补探时现查 active 注册表拿最新 def）。 */
export function useSourceSelfCheckOnView(def: SourceDef): void {
  const id = def.id;
  useEffect(() => {
    const current = getActiveRegistry().sources.find((s) => s.id === id);
    if (current) ensureSourceSelfCheck(current, { createAdapterFor: (d) => createAdapter(d) });
  }, [id]);
}
