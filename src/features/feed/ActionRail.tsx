import { useMemo } from "react";

/* 收藏计数（上游原算法）：基础计数 ± 本地乐观状态与服务端已载状态的差。
   detail 为当前条目的详情（含 interaction 已载状态）。点赞计数已于
   3.2.2 砍单随点赞一并删除，本文件只剩收藏计数 hook。 */
export function useSocialCounts(meta: { collect: number }, detail: { interaction?: { collected?: boolean } } | undefined,
  kind: string, collected: boolean) {
  const collectCount = useMemo(() => {
    const loadedCollected = kind === "video" && detail?.interaction?.collected;
    return Math.max(0, meta.collect + Number(collected) - Number(!!loadedCollected));
  }, [meta.collect, collected, kind, detail?.interaction]);
  return { collectCount };
}

/* 移动端右栏（喜欢/收藏/评论覆层）已整体撤销（2026-11-18 用户再裁定）：
   喜欢删除、评论只在抽屉评论页、收藏移入控制层顶栏。桌面右侧社交钮组
   （DesktopSocialButtons）于收官批 B 项一并撤销、与移动端右栏同命运。
   3.2.2 砍单：点赞与评论功能整体删除，收藏保留。 */
