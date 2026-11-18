import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type Hls from "hls.js";

/** Keep asynchronous autoplay and error recovery subject to the latest page activity. */
export function usePlaybackActivity(
  videoRef: RefObject<HTMLVideoElement | null>, hlsRef: RefObject<Hls | null>,
  { active, autoPlay, src, trace }: { active: boolean; autoPlay: boolean; src: string; trace: (event: string, data?: Record<string, unknown>) => void },
) {
  const latest = useRef({ active, trace }); latest.current = { active, trace };
  const wanted = useRef(autoPlay);
  /* 暂停来源显式区分（Muse 2026-11-19 fix2 B 增补，GPT 全文重读裁定）：
   * paused_by_user＝用户显式暂停（toggle/handle），任何自愈/重建不得
   * 据此自动播放；paused_by_system＝系统侧暂停（页面挂起/PiP 退出/
   * 代理恢复回滚），意愿仍以 wanted 为准、恢复时可续播。看门狗意愿
   * 门控与账本/诊断自此有明确状态可依，不再只有一个 wanted 布尔。 */
  const pauseKind = useRef<"user" | "system" | null>(null);
  const mounted = useRef(true);
  const previous = useRef(active);
  useLayoutEffect(() => { wanted.current = autoPlay; }, [src, autoPlay]);

  const inPip = (v: HTMLVideoElement | null) => typeof document !== "undefined" && !!v && document.pictureInPictureElement === v;

  const play = useCallback((source: string, automatic = false) => {
    const v = videoRef.current;
    if (!v) return;
    if (!mounted.current || (!latest.current.active && !inPip(v)) || (automatic && !wanted.current)) {
      latest.current.trace("play.blocked", { source, inactive: !latest.current.active, play_wanted: wanted.current });
      return;
    }
    wanted.current = true;
    pauseKind.current = null;
    const hls = hlsRef.current;
    if (hls?.levels.length && !hls.loadingEnabled) {
      const target = v.currentTime > 0 ? v.currentTime : (hls.config.startPosition >= 0 ? hls.config.startPosition : -1);
      hls.startLoad(target);
    }
    latest.current.trace("play.request", { source });
    v.play().then(() => {
      // The page may have changed while play() was pending.
      if (!mounted.current || (!latest.current.active && !inPip(v))) v.pause();
    }).catch(e => latest.current.trace("play.rejected", { source, error_name: e?.name }));
  }, [videoRef, hlsRef]);

  const pause = useCallback((source = "handle") => {
    wanted.current = false;
    /* proxy_restore 是恢复链的系统侧回滚暂停，其余皆为用户显式暂停 */
    pauseKind.current = source === "proxy_restore" ? "system" : "user";
    latest.current.trace("pause.request", { source, pause_state: pauseKind.current === "user" ? "paused_by_user" : "paused_by_system" });
    videoRef.current?.pause();
  }, [videoRef]);

  useLayoutEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    mounted.current = true;
    const hls = hlsRef.current;
    if (!active) {
      // Keep Picture-in-Picture playing across tab/page navigation until PiP exits.
      if (inPip(v)) {
        previous.current = active;
        return;
      }
      // Include pauses made through native/PiP controls, which bypass our buttons.
      if (v.readyState >= 2) wanted.current = !v.paused;
      /* 页面挂起由系统侧施加暂停：原本在播的记 paused_by_system
       * （意愿保留、回页可续播）；原本已暂停的不改其来源。 */
      if (!v.paused) pauseKind.current = "system";
      v.pause();
      // Let an in-flight manifest finish, but stop fragment loading for hidden pages.
      if (hls?.levels.length) hls.stopLoad();
      latest.current.trace("page.suspended", { play_wanted: wanted.current });
    } else if (!previous.current) {
      if (hls?.levels.length && !hls.loadingEnabled) {
        const target = v.currentTime > 0 ? v.currentTime : (hls.config.startPosition >= 0 ? hls.config.startPosition : -1);
        hls.startLoad(target);
      }
      if (wanted.current && (hls?.levels.length || v.readyState > 0)) play("page_active", true);
    }
    previous.current = active;
  }, [active, play, videoRef, hlsRef]);

  useLayoutEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const guard = () => {
      if (latest.current.active || inPip(v)) return;
      latest.current.trace("play.blocked", { source: "media_event", inactive: true });
      v.pause();
      if (hlsRef.current?.levels.length) hlsRef.current.stopLoad();
    };
    const onLeavePip = () => {
      if (latest.current.active) return;
      wanted.current = !v.paused;
      if (!v.paused) pauseKind.current = "system";
      v.pause();
      if (hlsRef.current?.levels.length) hlsRef.current.stopLoad();
      latest.current.trace("page.suspended", { play_wanted: wanted.current, source: "pip_exit" });
    };
    v.addEventListener("play", guard);
    v.addEventListener("playing", guard);
    v.addEventListener("leavepictureinpicture", onLeavePip);
    return () => {
      mounted.current = false;
      v.removeEventListener("play", guard);
      v.removeEventListener("playing", guard);
      v.removeEventListener("leavepictureinpicture", onLeavePip);
      v.pause();
    };
  }, [videoRef, hlsRef]);

  return {
    play,
    pause,
    setPlayWanted: (on: boolean) => { wanted.current = on; },
    isActive: () => mounted.current && (latest.current.active || inPip(videoRef.current)),
    isPlayWanted: () => wanted.current,
    /** 三态播放状态（fix2 B）：未暂停＝playing；暂停中按最近一次
     * 暂停来源分 user/system，来源未知（原生控件直暂停等）默认
     * system——不把未知暂停冒充用户意愿，门控仍由 isPlayWanted 兜底。 */
    pauseState: (): "playing" | "paused_by_user" | "paused_by_system" => {
      const v = videoRef.current;
      if (!v || !v.paused) return "playing";
      return pauseKind.current === "user" ? "paused_by_user" : "paused_by_system";
    },
  };
}
