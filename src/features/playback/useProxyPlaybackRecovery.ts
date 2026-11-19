import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

type Activity = {
  isActive: () => boolean;
  isPlayWanted: () => boolean;
  play: (source: string, automatic?: boolean) => void;
  pause: (source?: string) => void;
  setPlayWanted: (on: boolean) => void;
  /** 三态暂停状态（整改 B7）：retry 推导先查它，系统暂停不表态。 */
  pauseState?: () => "playing" | "paused_by_user" | "paused_by_system";
};
type Resume = { src: string; time: number; playing: boolean; rate: number };

/** Reload the same media through a changed Rust proxy without replacing the page. */
export function useProxyPlaybackRecovery(
  videoRef: RefObject<HTMLVideoElement | null>, src: string, activity: Activity,
  trace: (event: string, data?: Record<string, unknown>) => void,
) {
  const [revision, setRevision] = useState(0);
  const pending = useRef<Resume | null>(null);
  const latest = useRef({ src, activity, trace });
  latest.current = { src, activity, trace };

  const retry = useCallback((source = "manual", playWanted?: boolean) => {
    const video = videoRef.current;
    const { src, activity, trace } = latest.current;
    if (!src || !video) return;
    // Repeated retries must not replace the saved position with a reset clock.
    const previous = pending.current?.src === src ? pending.current : null;
    /* playing 推导顺序（整改 B7 收紧）：显式参数 → 上一份快照 → 活状态
     * 意愿。旧实现第三顺位直接读 !video.paused：系统暂停（页面挂起/
     * 全屏过渡打断）会被推导成「不想播」、反写 wanted。现先查三态：
     * paused_by_user → false（硬意愿）；paused_by_system → 只沿用
     * isPlayWanted（系统暂停不表态，不许推导成想播或不想播）；
     * playing → true；无三态的旧调用方才回落旧活状态推导。 */
    const derivePlaying = (): boolean => {
      const ps = activity.pauseState?.();
      if (ps === "paused_by_user") return false;
      if (ps === "paused_by_system") return activity.isPlayWanted();
      if (ps === "playing") return true;
      return activity.isActive() && video.readyState >= 2 && !video.error ? !video.paused : activity.isPlayWanted();
    };
    const playing = playWanted ?? previous?.playing ?? derivePlaying();
    pending.current = {
      src,
      time: previous?.time ?? (Number.isFinite(video.currentTime) ? video.currentTime : 0),
      playing,
      rate: previous?.rate ?? video.playbackRate,
    };
    activity.setPlayWanted(playing);
    trace("proxy.retry", { source, time: pending.current.time, play_wanted: playing });
    setRevision(value => value + 1);
  }, [videoRef]);

  useEffect(() => {
    const onProxyChanged = () => retry("proxy_changed");
    window.addEventListener("hg:proxy-changed", onProxyChanged);
    return () => window.removeEventListener("hg:proxy-changed", onProxyChanged);
  }, [retry]);

  const resume = useCallback(() => {
    if (pending.current?.src !== latest.current.src) pending.current = null;
    return pending.current;
  }, []);

  const restore = useCallback(() => {
    const snapshot = resume();
    const video = videoRef.current;
    if (!snapshot || !video || video.readyState < 1) return;
    const duration = video.duration;
    const time = Number.isFinite(duration) && duration > 0
      ? Math.min(snapshot.time, Math.max(0, duration - 0.15)) : snapshot.time;
    try { video.currentTime = time; } catch { return; }
    pending.current = null;
    video.playbackRate = snapshot.rate;
    const { activity, trace } = latest.current;
    // Respect a pause/play made while the replacement source was loading.
    trace("proxy.restored", { time, play_wanted: activity.isPlayWanted() });
    /* 恢复结果统一埋点（整改 B14，diag-audit #12）：与原生降级的
     * recovery.outcome 同名同形（本文件 trace 即 tracePlayback 加播放器
     * 上下文），供诊断按 kind/result 聚合恢复结局。纯埋点不改行为。 */
    trace("recovery.outcome", { kind: "proxy", result: "restored" });
    if (!activity.isPlayWanted()) activity.pause("proxy_restore");
    else if (activity.isActive()) activity.play("proxy_restore", true);
  }, [resume, videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.addEventListener("loadedmetadata", restore);
    video.addEventListener("loadeddata", restore);
    return () => {
      video.removeEventListener("loadedmetadata", restore);
      video.removeEventListener("loadeddata", restore);
    };
  }, [restore, videoRef]);

  return { revision, resume, retry };
}
