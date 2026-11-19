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
  /* 我方 pause 计数（最终版 B 线，GPT P1-02）：本 hook 内部对元素的
   * 每次 pause()（activity.pause／页面挂起／PiP 退出／play 守卫）若在
   * 元素处于播放态时发出，必然伴随恰好一个 pause 事件——先计数，
   * 原生 pause 监听按数消费；消费不完的 pause 事件即来自元素原生
   * 控件（PiP／系统播放控件／iOS 原生全屏），不经任何我方路径。 */
  const internalPauses = useRef(0);
  const pauseElement = (v: HTMLVideoElement) => {
    if (!v.paused) internalPauses.current += 1;
    v.pause();
  };
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
      if (!mounted.current || (!latest.current.active && !inPip(v))) pauseElement(v);
    }).catch(e => latest.current.trace("play.rejected", { source, error_name: e?.name }));
  }, [videoRef, hlsRef]);

  const pause = useCallback((source = "handle") => {
    wanted.current = false;
    /* proxy_restore 是恢复链的系统侧回滚暂停，其余皆为用户显式暂停 */
    pauseKind.current = source === "proxy_restore" ? "system" : "user";
    latest.current.trace("pause.request", { source, pause_state: pauseKind.current === "user" ? "paused_by_user" : "paused_by_system" });
    const v = videoRef.current;
    if (v) pauseElement(v);
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
      pauseElement(v);
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
      pauseElement(v);
      if (hlsRef.current?.levels.length) hlsRef.current.stopLoad();
    };
    const onLeavePip = () => {
      if (latest.current.active) return;
      wanted.current = !v.paused;
      if (!v.paused) pauseKind.current = "system";
      pauseElement(v);
      if (hlsRef.current?.levels.length) hlsRef.current.stopLoad();
      latest.current.trace("page.suspended", { play_wanted: wanted.current, source: "pip_exit" });
    };
    /* 原生暂停意愿写回（最终版 B 线，GPT P1-02）：PiP／系统控件的
     * 原生暂停绕过 activity.pause，旧实现 wanted 恒 true、pauseKind
     * 恒缺省 system——自愈/代理恢复据此把用户暂停的视频反向自动
     * 播放。现监听元素 pause 事件：我方 pause 已计数消费、页面挂起
     * 与 proxy_restore 都经我方 pause 落账，剩下的原生暂停一律是
     * 用户经原生控件表达的暂停意愿，同步写回 wanted=false＋
     * pauseKind=user。拆除型暂停不表态：换源 clear()/load() 后
     * currentSrc 已空、readyState 归零，与原生控件暂停（源在、
     * readyState≥2）可判别。wanted 已为 false 时意愿已由其他路径
     * 写回（如 retry 快照），不重复落账、不改其 pauseKind。 */
    const onNativePause = () => {
      if (internalPauses.current > 0) {
        internalPauses.current -= 1;
        return;
      }
      if (!v.currentSrc || v.readyState === 0) return;
      if (!wanted.current) return;
      wanted.current = false;
      pauseKind.current = "user";
      latest.current.trace("pause.request", { source: "native_controls", pause_state: "paused_by_user" });
    };
    v.addEventListener("play", guard);
    v.addEventListener("playing", guard);
    v.addEventListener("pause", onNativePause);
    v.addEventListener("leavepictureinpicture", onLeavePip);
    return () => {
      mounted.current = false;
      v.removeEventListener("play", guard);
      v.removeEventListener("playing", guard);
      v.removeEventListener("pause", onNativePause);
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
     * 暂停来源分 user/system。原生控件直暂停已经 pause 事件监听
     * 写回 user（最终版 B 线 P1-02）；仍无来源的暂停（拆除型暂停
     * 等）默认 system——不把未知暂停冒充用户意愿，门控仍由
     * isPlayWanted 兜底。 */
    pauseState: (): "playing" | "paused_by_user" | "paused_by_system" => {
      const v = videoRef.current;
      if (!v || !v.paused) return "playing";
      return pauseKind.current === "user" ? "paused_by_user" : "paused_by_system";
    },
  };
}
