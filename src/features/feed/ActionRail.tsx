import { useMemo } from "react";

/* 点赞/收藏计数（上游原算法）：基础计数 ± 本地乐观状态与服务端已载
   状态的差。detail 为当前条目的详情（含 interaction 已载状态）。 */
export function useSocialCounts(meta: { like: number; collect: number }, detail: { interaction?: { liked?: boolean; liked_ep?: number; collected?: boolean } } | undefined,
  kind: string, curEp: number, liked: boolean, collected: boolean) {
  const likeCount = useMemo(() => {
    const loadedLiked = kind === "video" && detail?.interaction?.liked
      && (detail.interaction.liked_ep === undefined || detail.interaction.liked_ep === curEp);
    return Math.max(0, meta.like + Number(liked) - Number(!!loadedLiked));
  }, [meta.like, liked, kind, detail?.interaction, curEp]);
  const collectCount = useMemo(() => {
    const loadedCollected = kind === "video" && detail?.interaction?.collected;
    return Math.max(0, meta.collect + Number(collected) - Number(!!loadedCollected));
  }, [meta.collect, collected, kind, detail?.interaction]);
  return { likeCount, collectCount };
}

/* 移动端右栏（喜欢/收藏/评论覆层）已整体撤销（2026-11-18 用户再裁定）：
   喜欢删除、评论只在抽屉评论页、收藏移入控制层顶栏。桌面右侧社交钮组
   （DesktopSocialButtons）于收官批 B 项一并撤销、与移动端右栏同命运——
   桌面点赞/收藏/评论动作走播放器控制层与抽屉。本文件只剩计数 hook。 */
