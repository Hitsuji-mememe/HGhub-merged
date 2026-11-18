import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** 播放器控件闲置自动隐藏（#146-3）。
 * 桌面：2.8s，键盘聚焦控件/菜单时不隐藏（原行为不变）。
 * 移动全屏呈现（fs/fsUi）：按设置秒数，2026-11-18 用户重新裁定默认 3 秒
 * （与官方一致，此前写死 0 解硬）；仅播放中生效——暂停时只清计时、
 * 不动当前显隐（暂停锁显已按用户真机纠正删除：暂停不强制全显，
 * 单击在暂停态照样可隐藏/呼出），计时触发瞬间再查一次暂停态，
 * 暂停永不被自动隐藏。自动隐藏只是兜底：单击随时可即时收起/呼出。
 * 跟版合并（Muse 2026-11-18）：吸收上游 #146-3 的 suspended 参数——
 * 拖动进度条期间挂起隐藏计时（挂起只清计时、不改显隐，同暂停口径）。 */
export function useFsIdle(
  isDesktop: boolean,
  fs: boolean,
  paused: boolean,
  mobileSecs: number,
  boxRef: RefObject<HTMLDivElement | null>,
  suspended = false,
) {
  const [idle, setIdle] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const delay = isDesktop ? 2800 : fs ? mobileSecs * 1000 : 0;
  const delayRef = useRef(delay);
  delayRef.current = delay;
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const arm = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    if (!delayRef.current || suspendedRef.current) return;
    timer.current = window.setTimeout(() => {
      if (pausedRef.current || suspendedRef.current) return;
      // Keyboard users must keep seeing the focused control/menu.
      if (isDesktop && boxRef.current?.parentElement?.contains(document.activeElement) && document.activeElement?.closest(".desktop-controls")) return;
      setIdle(true);
    }, delayRef.current);
  }, [isDesktop, boxRef]);
  const wake = useCallback(() => { setIdle(false); arm(); }, [arm]);
  useEffect(() => {
    if (isDesktop || fs) wake();
    else { setIdle(false); window.clearTimeout(timer.current); }
    return () => window.clearTimeout(timer.current);
  }, [isDesktop, fs, wake]);
  useEffect(() => {
    if (paused || suspended) { window.clearTimeout(timer.current); }
    else if (isDesktop || fs) arm();
  }, [paused, suspended, isDesktop, fs, arm]);
  return { idle, setIdle, wake, arm };
}
