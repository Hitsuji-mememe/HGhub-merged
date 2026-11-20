/* ── 源健康展示面消费钩子（Muse 2026-11-20 fix331/source-reliability）──
 * 派生本体在 healthCheck.ts（classifySelfCheckResult 四态＋
 * sourceHealthBadgeText 徽标文案，全 App 单一出处）；本文件只放
 * React 消费层三件：
 * ① useSourceHealthResults——经 useSyncExternalStore 订阅自检
 *    结果落盘通知，补探/整轮一有新结果，正在显示的徽标即刷新
 *    （「探完即刷新标签」）；
 * ② useSourceSelfCheckOnView——浏览面（SourceBrowse/SourcePosts/
 *    SourceGallery）挂载时按缺失/过期/版本不符口径触发单源后台
 *    补探（ensureSourceSelfCheck），不阻塞浏览、不弹窗；
 * ③ useSourceSelfCheckOnShow——展示面（分类总览源行/源切换器）
 *    挂载时对本面展示的源批量补探（ensureSourcesSelfCheck，
 *    fix333/selfcheck-trigger）：此前展示面只读派生不触发，
 *    未点开过的源在总览长挂「未实测」；批量补探串行节制、
 *    后台执行、不阻塞渲染。启动序经 healthCheck 排序（fix333/
 *    m7-selfcheck M7：本面选中源最先、最近打开过的源次之）——
 *    选中源经钩子第二参透传；「最近打开」由 ② 在进入浏览面时
 *    经 recordSourceView 落盘记录（M7 排序信号）。 */

import { useEffect, useSyncExternalStore } from "react";
import {
  ensureSourceSelfCheck,
  ensureSourcesSelfCheck,
  getSelfCheckResults,
  recordSourceView,
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
 * 依赖只认 id；补探时现查 active 注册表拿最新 def）。进入即记
 * 一次「最近打开」（M7 排序信号，recordSourceView 落盘）。 */
export function useSourceSelfCheckOnView(def: SourceDef): void {
  const id = def.id;
  useEffect(() => {
    recordSourceView(id);
    const current = getActiveRegistry().sources.find((s) => s.id === id);
    if (current) ensureSourceSelfCheck(current, { createAdapterFor: (d) => createAdapter(d) });
  }, [id]);
}

/** 展示面挂载时批量补探：对本面展示的源按 id 集合触发（依赖只认
 * id 集合；补探时现查 active 注册表拿最新 def——注册表覆盖换代
 * 后 id 不变、def 已是新对象）。补探在 healthCheck 串行队列里
 * 后台跑，本钩子不等待、不阻塞渲染；结果落盘经订阅刷新徽标。
 * selectedId（本面当前选中源）只作排序信号、在挂载时读取，不
 * 进依赖——选中源本身另经浏览面单源补探即时触发，不靠本批量。 */
export function useSourceSelfCheckOnShow(defs: readonly SourceDef[], selectedId?: string | null): void {
  const key = defs.map((d) => d.id).join("\n");
  useEffect(() => {
    if (!key) return;
    const ids = new Set(key.split("\n"));
    const current = getActiveRegistry().sources.filter((s) => ids.has(s.id));
    if (current.length) {
      void ensureSourcesSelfCheck(current, {
        createAdapterFor: (d) => createAdapter(d),
        selectedId,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
