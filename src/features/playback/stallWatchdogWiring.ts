import Hls, { type FragLoadedData } from "hls.js";
import { AppendStallWatchdog, type AppendStallState } from "./appendStallWatchdog";
import { noteNativeFallback } from "./mediaTransport";

/* ── append 卡死看门狗共享接线（U4 真收敛，Muse 2026-11-18）──
 * Player（帖子内嵌）与 VideoSurface（Feed）此前各写一份同义接线，
 * Player 那份漏传 shouldEscalate、onStall 不查播放意愿、没接
 * BUFFER_APPENDING/APPENDED，且两处在降级名额被占（noteNativeFallback
 * 返回 false）时都静默无动作。接线只此一份：意愿门控两道（构造期
 * shouldEscalate + onStall 首查）、判死计数、重建、会话级原生降级、
 * 降级用尽后经 onExhausted 明确报错，都在这里；调用方只注入差异——
 * isCurrent / isPlayWanted、trace 字段、retry 通道、onError 通道。
 * 不变量：用户明确暂停后，任何自愈不得自动播放。 */

/** 降级名额已被占用、自动恢复再无下一步时的统一报错文案。 */
export const APPEND_STALL_EXHAUSTED_MESSAGE = "视频卡死且自动恢复已用尽，请点重试或切换线路";

export type StallRetryReason = "append_stall" | "append_stall_fallback";

export function createStallWatchdog(opts: {
  video: HTMLVideoElement;
  /** 本代 hls 是否仍是当前实例（旧实例的判死回调必须丢弃）。 */
  isCurrent: () => boolean;
  /** 播放意愿（activity.isPlayWanted）：两道意愿门控共用。 */
  isPlayWanted: () => boolean;
  /** 同一源的判死计数（换源清零由调用方守，见各组件 stallSrcRef）。 */
  attemptRef: { current: number };
  /** 判死取证：调用方按各自字段组 trace（attempt 传的是递增前的值）。 */
  traceStall: (state: AppendStallState, attempt: number) => void;
  /** 重建通道：调用方落到自己的 proxyRecovery.retry(reason, true)。 */
  retry: (reason: StallRetryReason) => void;
  /** 自动恢复用尽时的报错通道：调用方落到自己的 onError / errMsg。 */
  onExhausted: (message: string) => void;
}): AppendStallWatchdog {
  return new AppendStallWatchdog({
    hasBuffered: () => { try { return opts.video.buffered.length > 0 && opts.video.buffered.end(opts.video.buffered.length - 1) > 0; } catch { return false; } },
    isPlaying: () => !opts.video.paused && opts.video.readyState >= 2,
    shouldEscalate: () => opts.isPlayWanted(),
    onStall: (state) => {
      if (!opts.isCurrent()) return;
      /* 意愿门控：起播期已被用户暂停的源不判死——他不想播，卡不卡
       * 死与他无关；恢复意愿时活动层会重新 play。 */
      if (!opts.isPlayWanted()) return;
      opts.traceStall(state, opts.attemptRef.current);
      if (opts.attemptRef.current < 1) {
        opts.attemptRef.current += 1;
        opts.retry("append_stall");
      } else if (noteNativeFallback("append_stall")) {
        opts.retry("append_stall_fallback");
      } else {
        /* 降级名额已被本会话早先的判死占用：不再静默，必须让用户
         * 知道自动恢复已用尽、需要手动处理。 */
        opts.onExhausted(APPEND_STALL_EXHAUSTED_MESSAGE);
      }
    },
  });
}

/** 把 hls 与 video 的信号喂给看门狗；返回解绑函数（只解 video 的
 * playing 监听——hls 监听随 hls.destroy() 一并销毁，无悬空监听）。
 * 信号次序与收敛前两处原文一致：FRAG_LOADED 先过两处共用的
 * part/sn 守卫、喂看门狗，再走调用方逻辑；FRAG_BUFFERED 先走调用方
 * 逻辑（recovery.buffered 等）再喂看门狗。调用方的 onFragLoaded 只放
 * 与看门狗无关的自有逻辑（守卫已由本函数统一施加）。 */
export function wireStallWatchdogSignals(opts: {
  hls: Hls;
  video: HTMLVideoElement;
  watchdog: AppendStallWatchdog;
  onFragLoaded?: (data: FragLoadedData) => void;
  onFragBuffered?: () => void;
}): () => void {
  const { hls, video, watchdog } = opts;
  /* append 生命周期信号（四状态判死）：开始/结束喂给看门狗，到点时
   * 据此区分未开始/处理中/已结束无缓冲，处理中先宽限不误杀。 */
  hls.on(Hls.Events.BUFFER_APPENDING, () => watchdog.appendStarted());
  hls.on(Hls.Events.BUFFER_APPENDED, () => watchdog.appendEnded());
  hls.on(Hls.Events.FRAG_LOADED, (_e, data) => {
    if (data.part || typeof data.frag.sn !== "number") return;
    watchdog.fragLoaded();
    opts.onFragLoaded?.(data);
  });
  hls.on(Hls.Events.FRAG_BUFFERED, () => {
    opts.onFragBuffered?.();
    watchdog.buffered();
  });
  const onPlaying = () => watchdog.playing();
  video.addEventListener("playing", onPlaying);
  return () => video.removeEventListener("playing", onPlaying);
}
