import Hls, { type ErrorData } from "hls.js";

/** 清单级恢复上限：清单 fatal 后 loadSource 重拉的最大次数（不含初次
 * 加载）。与 hlsConfig 的 manifestLoadingMaxRetry=1 相乘后，清单取数
 * 总量 ≤3 轮 ×2 发——旧口径（内重试 4 × 恢复 4）≈25 发、分钟级静默
 * 转圈（fix3312 定因 §4），本上限与无进展预算共同收敛。 */
export const MANIFEST_RECOVERY_MAX_ATTEMPTS = 2;

/** 起播无进展预算（ms）：自本恢复队列建立（≈loadSource 时刻）起，
 * 清单到达（manifestParsed / 首个分片入缓冲）之前零进展持续此时长，
 * 即判清单级失败落卡。上游每发磨到本地协议 15s 截止时，错误链本身
 * 要数分钟才收敛——预算是墙钟看门，不等错误链走完。判据只认「无任
 * 何进展」：清单在预算内到达即解除，其后慢起播（分片细水长流）不
 * 受本预算管辖、不误杀。 */
export const MANIFEST_STARTUP_BUDGET_MS = 10_000;

function isManifestError(data: ErrorData): boolean {
  return data.type === Hls.ErrorTypes.NETWORK_ERROR
    && (data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR
      || data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT);
}

/** A bounded recovery queue shared by the feed and inline post player. */
export function createHlsRecovery({ hls, video, url, isCurrent, isActive, resumePlayback, onFatal }: {
  hls: Hls;
  video: HTMLVideoElement;
  url: string;
  isCurrent: () => boolean;
  isActive: () => boolean;
  resumePlayback: () => void;
  onFatal: (data: ErrorData) => void;
}) {
  let attempts = 0;
  let timer: number | undefined;
  let pending: ErrorData | undefined;
  let disposed = false;
  /* 清单阶段收敛（fix3313）：manifestAttempts 只数清单 loadSource
   * 恢复；manifestSeen 表示清单已到、阶段结束；startupSettled 是
   * 清单失败已交付 onFatal 的锁存（落卡后同一实例的迟到错误/恢复
   * 一律不再动作，手动重试走组件重建）；startupExpired 是预算在
   * 不活跃期到期、待 activityChanged 交付的积压标记。 */
  let manifestAttempts = 0;
  let manifestSeen = false;
  let startupSettled = false;
  let startupExpired = false;
  let startupTimer: number | undefined;
  let lastManifestError: ErrorData | undefined;

  const cancelTimer = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };
  const cancelStartupTimer = () => {
    if (startupTimer !== undefined) window.clearTimeout(startupTimer);
    startupTimer = undefined;
  };
  /* 清单失败交付：锁存＋清双计时器＋清待执行恢复，落卡后本实例收口。 */
  const deliverManifestFatal = (data: ErrorData) => {
    startupSettled = true;
    startupExpired = false;
    cancelTimer();
    cancelStartupTimer();
    pending = undefined;
    onFatal(data);
  };
  /* 无进展预算到期：仍有最后真实清单错误就交付它（带上游状态码），
   * 一个错误都没等到（取数挂死）则合成清单超时——player-3 形态
   * （mount 后清单根本取不到、14s 无 metadata）正是后者。 */
  const onStartupDeadline = () => {
    startupTimer = undefined;
    if (disposed || manifestSeen || startupSettled || !isCurrent()) return;
    if (!isActive()) { startupExpired = true; return; }
    deliverManifestFatal(lastManifestError ?? ({
      fatal: true,
      type: Hls.ErrorTypes.NETWORK_ERROR,
      details: Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT,
      reason: "manifest startup budget exceeded",
    } as unknown as ErrorData));
  };
  startupTimer = window.setTimeout(onStartupDeadline, MANIFEST_STARTUP_BUDGET_MS);
  /* 清单到达（或首个分片入缓冲）：无进展阶段结束，预算永久解除。 */
  const noteManifestProgress = () => {
    manifestSeen = true;
    startupExpired = false;
    cancelStartupTimer();
  };

  const schedule = () => {
    if (disposed || !isCurrent() || !isActive() || !pending || timer !== undefined) return;
    if (attempts >= 4) {
      const data = pending;
      pending = undefined;
      onFatal(data);
      return;
    }
    timer = window.setTimeout(() => {
      timer = undefined;
      // A covered page keeps its pending recovery, but does not start requests.
      if (disposed || !isCurrent() || !isActive() || !pending) return;
      const data = pending;
      pending = undefined;
      attempts += 1;
      if (isManifestError(data)) manifestAttempts += 1;
      try {
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR
            || data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT) {
            // startLoad cannot refetch a manifest that never produced levels.
            hls.loadSource(url);
          } else {
            hls.startLoad(video.currentTime || -1);
          }
        } else {
          const time = video.currentTime || 0;
          hls.recoverMediaError();
          // autoStartLoad=false also applies when recovering at time zero.
          // Detaching MSE can synchronously reset the element's clock.
          hls.startLoad(time);
          resumePlayback();
        }
      } catch {
        pending = data;
        schedule();
      }
    }, 250 * (attempts + 1));
  };

  return {
    error(data: ErrorData) {
      // hls.js already applies its own backoff to recoverable errors.
      if (!data.fatal || disposed || !isCurrent()) return;
      /* 清单失败已落卡：本实例收口，迟到的错误不再恢复/重复落卡。 */
      if (startupSettled) return;
      if (data.type !== Hls.ErrorTypes.NETWORK_ERROR && data.type !== Hls.ErrorTypes.MEDIA_ERROR) {
        cancelTimer();
        pending = undefined;
        onFatal(data);
        return;
      }
      /* 清单级有界重试（fix3313）：清单恢复次数到顶即刻落卡，不再
       * 排队等共享 attempts 走完——快速 502 时这是主收敛路径，墙钟
       * 预算负责取数挂死的那一档。 */
      if (isManifestError(data)) {
        lastManifestError = data;
        if (manifestAttempts >= MANIFEST_RECOVERY_MAX_ATTEMPTS) {
          deliverManifestFatal(data);
          return;
        }
      }
      /* 恢复排期不被后续错误推迟（fix322/play）：旧实现在此无条件
       * cancelTimer 重排，而 attempts 只在计时器真正触发时递增——
       * 同一故障期内 fatal 错误以小于恢复延迟的间隔持续到达时，
       * 恢复永不执行、上限永不触发、onFatal 永不调用（饥饿型不
       * 收敛）。现只更新 pending（待执行动作跟随最新错误，如分片
       * 错后清单错改走 loadSource），排期由 schedule() 的
       * timer 已存守卫保住原触发时刻。 */
      pending = data;
      schedule();
    },
    /* 清单已解析（组件 MANIFEST_PARSED 喂入）：进展成立，解除预算。
     * 不重置 attempts——分片恢复预算语义不变，重置归 buffered()。 */
    manifestParsed() {
      noteManifestProgress();
    },
    buffered() {
      attempts = 0;
      manifestAttempts = 0;
      pending = undefined;
      cancelTimer();
      /* 分片能入缓冲必然清单已到：同 manifestParsed 的进展收口。 */
      noteManifestProgress();
    },
    activityChanged() {
      if (!isActive()) cancelTimer();
      else if (startupExpired && !manifestSeen && !startupSettled && isCurrent()) {
        /* 预算在被覆盖期间到期：恢复活跃后立即交付，不再等错误链。 */
        deliverManifestFatal(lastManifestError ?? ({
          fatal: true,
          type: Hls.ErrorTypes.NETWORK_ERROR,
          details: Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT,
          reason: "manifest startup budget exceeded",
        } as unknown as ErrorData));
      }
      else schedule();
    },
    dispose() {
      disposed = true;
      pending = undefined;
      cancelTimer();
      cancelStartupTimer();
    },
  };
}

export type HlsRecovery = ReturnType<typeof createHlsRecovery>;
