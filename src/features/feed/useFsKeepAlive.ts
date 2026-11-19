/* ── 全屏过渡 keepAlive（Muse 2026-11-19 根治包，audit6 P1-4）──
 * 从 Feed 抽出。旧实现六个定时器回调只判 video.paused 就直调 handle
 * play()（非 automatic）——不仅绕过意愿门，还会把用户显式暂停反写成
 * 想播：用户进全屏后 1.2s 内暂停，必被 500/800/1200ms 三发拉回。
 * 现回调三查：①Feed 用户暂停态；②调度时的 playKey 与当前一致；
 * ③走 activity.play("fs_keepalive", true)——automatic 受 wanted 门
 * 管辖。paused 变化与 playKey 变化即清全部定时器；卸载同清。 */
import { useCallback, useEffect, useRef } from "react";

const KEEP_ALIVE_DELAYS = [50, 150, 300, 500, 800, 1200];

export function useFsKeepAlive(opts: {
  /** Feed 的用户暂停态（state 值，变化即清定时器）。 */
  paused: boolean;
  /** 当前播放键（变化即清定时器）。 */
  playKey: string;
  /** 回调时刻复查：用户是否处于暂停态（读最新值，不吃闭包旧值）。 */
  isUserPaused: () => boolean;
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

  /* paused / playKey 变化即清：暂停后残留的定时器不许再发。 */
  useEffect(() => { clear(); }, [opts.paused, opts.playKey, clear]);
  useEffect(() => clear, [clear]);

  const keepAlive = useCallback(() => {
    clear();
    const scheduledKey = optsRef.current.currentPlayKey();
    for (const delay of KEEP_ALIVE_DELAYS) {
      timers.current.push(window.setTimeout(() => {
        const o = optsRef.current;
        if (o.isUserPaused()) return;
        if (o.currentPlayKey() !== scheduledKey) return;
        if (!o.isVideoPaused()) return;
        o.play();
      }, delay) as unknown as number);
    }
  }, [clear]);

  return keepAlive;
}
