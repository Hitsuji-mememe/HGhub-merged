/**
 * 播放错误呈现（Muse 2026-11-21 fix3311/polish G1，整体打磨审计
 * §7）：Feed 全屏面与内嵌 Player 此前两套样式——Feed 为居中卡
 * （主文案＋详情小字＋重试钮），内嵌 Player 为左上角小横幅（裸错
 * 误串＋行内重试钮，同类失败在帖子面只剩一截红字）。现统一为本卡
 * 一份：宿主只决定定位（Feed 居中覆层 / Player 覆满播放器区），
 * 文案结构、详情行与重试钮样式两面一致。重试语义仍归宿主既有链
 * （Feed 的 videoRef.retry/proxyRetry、Player 的 proxyRecovery），
 * 本组件只呈现、不接管恢复。
 */
import { Button } from "../../shared/ui/ios/controls";

export default function PlaybackErrorCard({ detail, onRetry, retryDisabled = false }: {
  /** 宿主的原始错误详情（hls 串形/原生 mediaErrorMessage），小字呈现、可为空。 */
  detail?: string;
  onRetry: () => void;
  retryDisabled?: boolean;
}) {
  return (
    <div role="alert" className="rounded-xl p-5 flex flex-col items-center gap-3 text-[14px] hg-ink-2" style={{ background: "rgba(0,0,0,.7)" }}>
      <span>视频暂时无法加载</span>
      {detail ? <span className="text-[12px] hg-ink-4 max-w-[240px] text-center break-all">{detail}</span> : null}
      <Button className="hg-link text-[14px]" disabled={retryDisabled} onClick={onRetry}>重试</Button>
    </div>
  );
}
