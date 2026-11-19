/* ── 全屏过渡 keepAlive（Muse 2026-11-19 根治包，audit6 P1-4）──
 * 从 Feed 抽出。旧实现六个定时器回调只判 video.paused 就直调 handle
 * play()（非 automatic）——不仅绕过意愿门，还会把用户显式暂停反写成
 * 想播：用户进全屏后 1.2s 内暂停，必被 500/800/1200ms 三发拉回。
 * 回调走 activity.play("fs_keepalive", true)——automatic 受 wanted 门
 * 管辖；playKey 变化与卸载即清全部定时器。
 *
 * 三态信号改版（整改 B2，Hark G1 P1-1）：旧第①查读 Feed.paused——
 * 该 state 由任何 pause 事件置 true，iOS 全屏过渡的系统打断正是
 * keepAlive 唯一要处理的场景，却被当成用户暂停全灭。现回调时刻查
 * 活动层 pauseState() 三态：只有 paused_by_user 拦；paused_by_system
 * 与来源未知（默认 system 口径）不拦。原「paused 变化即清定时器」
 * 随之删除——系统打断必然伴随 paused 翻 true，清定时器等于自杀；
 * 用户暂停由回调时刻的三态复查拦截，语义更准。 */
import { useCallback, useEffect, useRef } from "react";

const KEEP_ALIVE_DELAYS = [50, 150, 300, 500, 800, 1200];

export type KeepAlivePauseState = "playing" | "paused_by_user" | "paused_by_system";

export function useFsKeepAlive(opts: {
  /** 当前播放键（变化即清定时器）。 */
  playKey: string;
  /** 回调时刻复查：活动层三态暂停信号（读最新值，不吃闭包旧值）。
   * 只有 paused_by_user 算用户暂停；paused_by_system 不拦。 */
  pauseState: () => KeepAlivePauseState;
  /** 回调时刻复查：当前播放键（与调度时比对）。 */
  currentPlayKey: () => string;
  /** 续播通道：必须走 activity 的 automatic 路径（受意愿门管辖）。 */
  play: () => void;
  /** video 元素当前确实处于 paused 才需要续播（过渡打断的判据）。 */
  isVideoPaused: () => boolean;
}) {
  const timers = useRef<number[]>([]);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const clear = useCallback(() => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  }, []);

  /* playKey 变化即清：旧条目的残留定时器不许在新条目上发。 */
  useEffect(() => { clear(); }, [opts.playKey, clear]);
  useEffect(() => clear, [clear]);

  const keepAlive = useCallback(() => {
    clear();
    const scheduledKey = optsRef.current.currentPlayKey();
    for (const delay of KEEP_ALIVE_DELAYS) {
      timers.current.push(window.setTimeout(() => {
        const o = optsRef.current;
        if (o.pauseState() === "paused_by_user") return;
        if (o.currentPlayKey() !== scheduledKey) return;
        if (!o.isVideoPaused()) return;
        o.play();
      }, delay) as unknown as number);
    }
  }, [clear]);

  return keepAlive;
}
