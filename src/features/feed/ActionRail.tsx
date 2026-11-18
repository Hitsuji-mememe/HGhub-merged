import { useMemo } from "react";
import { Button } from "../../shared/ui/ios/controls";
import { fmt } from "../../shared/api/api";
import { ICommentF, IHeart, IHeartF, IStar, IStarF } from "../../shared/ui/icons";

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
   喜欢删除、评论只在抽屉评论页、收藏移入控制层顶栏。本文件只剩桌面
   右侧社交钮组与计数 hook；移动端不再从这里渲染任何覆层。 */

type SocialProps = {
  liked: boolean; likeCount: number; onLike: () => void; likePending: boolean;
  collected: boolean; onFav: () => void; collectPending: boolean;
  commentCount: number; onComments: () => void;
};

/* 桌面右栏的社交钮组（计数沿上游原样：点赞 likeCount、收藏用 meta 原始
   计数由调用方传入 collectLabel；点赞 pop 动画属装饰、不恢复） */
export function DesktopSocialButtons({ collectLabel, ...s }: SocialProps & { collectLabel: number }) {
  return (
    <>
      <Button onClick={s.onLike} disabled={s.likePending} aria-busy={s.likePending} aria-label="点赞" className="flex flex-col items-center gap-1 pressable" aria-pressed={s.liked}>
        {s.liked ? <IHeartF size={30} className="text-neon" /> : <IHeart size={30} className="text-white tsh" />}
        <span className="text-[12px] text-white/90 tabular-nums">{fmt(s.likeCount)}</span>
      </Button>
      <Button onClick={s.onComments} aria-label={`评论 ${fmt(s.commentCount)} 条`} className="flex flex-col items-center gap-1 pressable">
        <ICommentF size={27} className="text-white tsh" />
        <span className="text-[12px] text-white/90 tabular-nums">{fmt(s.commentCount)}</span>
      </Button>
      <Button onClick={s.onFav} disabled={s.collectPending} aria-label="收藏" aria-pressed={s.collected} className="flex flex-col items-center gap-1 pressable">
        {s.collected ? <IStarF size={27} className="hg-gold" /> : <IStar size={27} className="hg-ink hg-ov-shadow" />}
        <span className="text-[12px] text-white/90 tabular-nums">{fmt(collectLabel)}</span>
      </Button>
    </>
  );
}
