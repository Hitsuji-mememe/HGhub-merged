import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** 播放器控件闲置自动隐藏（#146-3）。
 * 桌面：2.8s，键盘聚焦控件/菜单时不隐藏（原行为不变）。
 * 移动全屏呈现（fs/fsUi）：按设置秒数，2026-11-18 用户重新裁定默认 3 秒
 * （与官方一致，此前写死 0 解硬）；仅播放中生效——暂停时清计时并强制
 * 可见，计时触发瞬间再查一次暂停态，暂停永不被自动隐藏（与暂停锁显
 * 一致）。自动隐藏只是兜底：单击随时可即时收起/呼出。 */
export function useFsIdle(isDesktop: boolean, fs: boolean, paused: boolean, mobileSecs: number, boxRef: RefObject<HTMLDivElement | null>) {
  const [idle, setIdle] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const delay = isDesktop ? 2800 : fs ? mobileSecs * 1000 : 0;
  const delayRef = useRef(delay);
  delayRef.current = delay;
  const arm = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    if (!delayRef.current) return;
    timer.current = window.setTimeout(() => {
      if (pausedRef.current) return;
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
    if (paused) { setIdle(false); window.clearTimeout(timer.current); }
    else if (isDesktop || fs) arm();
  }, [paused, isDesktop, fs, arm]);
  return { idle, setIdle, wake, arm };
}
