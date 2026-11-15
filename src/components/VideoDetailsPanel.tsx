import { fmt } from "../api";
import type { VideoCard } from "../types";
import { IClose } from "../icons";
import { Button, Surface } from "./ios/controls";
import { Avatar, Img } from "./ui";
import { ContentTags } from "./ContentTags";
import { FilteredContent } from "./FilteredContent";
import { RowCard } from "./cards";
import "../styles/video-details.css";

type VideoMeta = {
  title: string; cover: string; score: number; like: number; collect: number; comment: number;
  author: string; authorId: number; tags: readonly string[]; desc: string;
};

/** One details body for the mobile sheet and desktop dock. */
export default function VideoDetailsPanel({ meta, videoId, episodeCount, related, following, followPending,
  onFollow, onAuthor, onRelated, onClose }: {
  meta: VideoMeta; videoId: number; episodeCount: number; related: VideoCard[];
  following: boolean; followPending: boolean; onFollow: () => void;
  onAuthor: () => void; onRelated: (video: VideoCard) => void; onClose?: () => void;
}) {
  return <div className="video-details-panel" data-video-details>
    {onClose && <div className="video-details-heading">
      <h2>视频详情</h2>
      <Button className="ios-icon-button" aria-label="关闭视频详情" onClick={onClose}><IClose size={18} /></Button>
    </div>}
    <div className="video-details-scroll scroll-y">
      <div className="video-details-overview">
        <Surface className="video-details-cover"><Img src={meta.cover} eager loadingIndicator alt={meta.title} /></Surface>
        <div className="video-details-copy">
          <h3>{meta.title}</h3>
          <div className="video-details-stats">
            {!!meta.score && <span className="text-amber font-bold">{meta.score.toFixed(1)} 分</span>}
            {episodeCount > 0 && <span>共 {episodeCount} 集</span>}
          </div>
          <div className="video-details-stats"><span>点赞 {fmt(meta.like)}</span><span>收藏 {fmt(meta.collect)}</span><span>评论 {fmt(meta.comment)}</span></div>
        </div>
      </div>

      {/* Muse 2026-11-15 (2.1.1 简化版): 标签只作纯文本展示；屏蔽规则管理只在设置页 */}
      <section className="video-details-section" aria-label="标签">
        <div className="video-details-section-heading"><h3>标签</h3>
        </div>
        <ContentTags tags={meta.tags} />
      </section>

      <Surface className="video-details-author">
        <Button onClick={onAuthor} disabled={meta.authorId <= 0} className="video-details-author-link">
          <Avatar size={36} name={meta.author} hue={220} />
          <span className="min-w-0"><span className="block text-[14px] font-semibold truncate">{meta.author}</span><span className="text-[12px] text-mut">作者主页</span></span>
        </Button>
        {/* Muse 2026-11-15 (2.1.2): 详情面板内隐藏「+关注」钮——关注是服务端动作，游客点它必弹登录框，
            看剧的人不该在详情里踩登录坑。关注入口保留在作者主页（User 页）等原位置，onFollow prop 不再被本面板使用。 */}
      </Surface>

      <section className="video-details-section">
        <h3 className="video-details-section-heading">简介</h3>
        <p className="video-details-description">{meta.desc || "暂无简介"}</p>
      </section>

      {related.length > 0 && <section className="video-details-section">
        <h3 className="video-details-section-heading">相关推荐</h3>
        <FilteredContent items={related.slice(0, 12)} scopeKey={videoId}>{visible => <div className="scroll-x flex gap-2.5 snap-x">
          {visible.map(video => <RowCard key={video.id} v={video} onOpen={() => onRelated(video)} />)}
        </div>}</FilteredContent>
      </section>}
    </div>
  </div>;
}
