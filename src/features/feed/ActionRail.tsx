import { useMemo } from "react";
import { Button } from "../../shared/ui/ios/controls";
import { fmt } from "../../shared/api/api";
import { ICommentF, IExpand, IHeart, IHeartF, IStar, IStarF } from "../../shared/ui/icons";

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

/* 右侧动作栏（喜欢/收藏/评论）：2026-11-18 用户再裁定恢复——此前以
   「游客用不上」撤下是误判，用户明确说喜欢和收藏用得上。行为与计数沿
   上游原样；不做常驻覆层，由 Feed 按控制层显隐门控挂载（呼出时出现、
   收起时一起消失）。评论钮直达抽屉评论页。颜色写死不跟主题走：浅色
   主题下这些字必须仍是白色。本文件由 Feed.tsx 拆出（尺寸预算规矩：
   关注点移出时降预算），呈现与门控仍归 Feed。 */

type SocialProps = {
  liked: boolean; likeCount: number; onLike: () => void; likePending: boolean;
  collected: boolean; onFav: () => void; collectPending: boolean;
  commentCount: number; onComments: () => void;
};

export function MobileActionRail({ bottom, fsUi, isVideo, collectCount, onFullscreen, ...s }: SocialProps & {
  bottom: string; fsUi: boolean; isVideo: boolean; collectCount: number; onFullscreen: () => void;
}) {
  return (
    <div className="mobile-video-action-rail absolute right-3 z-20 flex flex-col items-center gap-[16px]" style={{ bottom }}>
      {isVideo && (
        <Button onClick={s.onLike} disabled={s.likePending} aria-busy={s.likePending} className="flex flex-col items-center gap-1 pressable" aria-pressed={s.liked} aria-label="点赞">
          {s.liked ? <IHeartF size={27} className="text-neon" /> : <IHeart size={27} className="hg-ink hg-ov-shadow" />}
          <span className="text-[12px] text-white/90 tabular-nums">{fmt(s.likeCount)}</span>
        </Button>
      )}
      <Button onClick={s.onFav} disabled={s.collectPending} aria-busy={s.collectPending} className="flex flex-col items-center gap-1 pressable" aria-pressed={s.collected} aria-label="收藏">
        {s.collected ? <IStarF size={27} className="hg-gold" /> : <IStar size={27} className="hg-ink hg-ov-shadow" />}
        <span className="text-[12px] text-white/90 tabular-nums">{fmt(collectCount)}</span>
      </Button>
      <Button onClick={s.onComments} className="flex flex-col items-center gap-1 pressable" aria-label={`评论 ${fmt(s.commentCount)} 条`}>
        <ICommentF size={26} className="hg-ink hg-ov-shadow" />
        <span className="text-[12px] hg-ink-2 hg-ov-shadow tabular-nums">{fmt(s.commentCount)}</span>
      </Button>
      {!fsUi && (
        <Button onClick={onFullscreen} className="flex flex-col items-center gap-1 pressable" aria-label="全屏">
          <IExpand size={26} className="hg-ink hg-ov-shadow" />
          <span className="text-[12px] hg-ink-2 hg-ov-shadow">全屏</span>
        </Button>
      )}
    </div>
  );
}

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
      <Button onClick={s.onFav} disabled={s.collectPending} aria-busy={s.collectPending} aria-label="收藏" className="flex flex-col items-center gap-1 pressable" aria-pressed={s.collected}>
        {s.collected ? <IStarF size={27} className="hg-gold" /> : <IStar size={27} className="hg-ink hg-ov-shadow" />}
        <span className="text-[12px] text-white/90 tabular-nums">{fmt(collectLabel)}</span>
      </Button>
    </>
  );
}
