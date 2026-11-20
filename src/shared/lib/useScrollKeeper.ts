/**
 * 列表滚动位置保存/恢复（Muse 2026-11-20 fix335/d-scroll）：外部源
 * 三浏览组件（SourceGallery/SourceBrowse/SourcePosts）用组件内分支
 * 整树替换实现详情，列表子树卸载期间宿主 scroller 内容高度塌缩、
 * scrollTop 被浏览器钳到 0，关闭详情后无人写回 → 返回恒落顶部
 * （审计 fix335/audit-scroll-restore §二，用户 2026-11-20 14:12
 * 真机实报）。本 hook 是全 App 唯一的滚动保存/恢复机制，三面共用，
 * 不许各面另写一份。
 *
 * 口径（审计 §四定版）：
 * - 保存值按 key 存模块级 Map，key＝面＋源 id（如 `gallery:<源id>`）；
 *   F 线日后扩为「面:源:disc 指纹」时只改 key 构造、机制不动。
 * - 恢复只认本实例 capture 过的 key：打开详情前 capture，列表分支
 *   重挂且数据就位（listReady）后在 layout effect 写回一次即消费；
 *   切面/切源（key 变化）先行作废待恢复标记——保存值按 key 留存也
 *   不会被新面/新源误消费，分页数据与位置不串扰。
 * - scroller 由宿主持有 ref 经 prop 下传（与 usePaginatedList 的
 *   scroller 口径一致），本 hook 不做 DOM 查询。
 * - 写回时机照 PostDetail F9 playScrollRef 先例：layout effect 先写
 *   一次，一帧 rAF 后实际值仍小于目标（封面异步加载让内容高度在
 *   首帧后继续长、写回被钳制）才再写一次；高度仍不足时浏览器钳到
 *   可达最大值，静默接受——不报错、不跳顶冒充恢复成功。
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

const savedScrollTops = new Map<string, number>();

export function useScrollKeeper(
  key: string,
  scroller: { current: HTMLElement | null } | undefined,
  listReady: boolean,
) {
  /* 本实例待恢复的 key：只由 capture 置位、恢复或 key 变化时清除。 */
  const armedKey = useRef<string | null>(null);

  /* 切面/切源：待恢复标记作废（恢复域收窄，审计 §四.3）。key 变化
   * 的同一轮渲染里 layout effect 先行执行，此时 armedKey 仍是旧
   * key、与新 key 不等，同样不会误恢复。 */
  useEffect(() => { armedKey.current = null; }, [key]);

  /** 打开详情/图集前调用：把当前 scrollTop 按 key 存下并置位待恢复。 */
  const captureScroll = useCallback(() => {
    const el = scroller?.current;
    if (!el) return;
    savedScrollTops.set(key, el.scrollTop);
    armedKey.current = key;
  }, [key, scroller]);

  useLayoutEffect(() => {
    if (!listReady || armedKey.current !== key) return;
    const el = scroller?.current;
    const want = savedScrollTops.get(key);
    if (!el || want === undefined) return;
    armedKey.current = null;
    el.scrollTop = want;
    const raf = requestAnimationFrame(() => {
      if (want - el.scrollTop > 2) el.scrollTop = want;
    });
    return () => cancelAnimationFrame(raf);
  }, [listReady, key, scroller]);

  return { captureScroll };
}
