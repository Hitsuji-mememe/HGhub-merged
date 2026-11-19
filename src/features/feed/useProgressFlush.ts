import { useEffect, useRef, type RefObject } from "react";

/* 续播位置即时落盘（蓝图 P4 多点保存）：守卫与原卸载兜底完全一致
   （权限/资料库作用域/playKey 对账后才写）。5 秒节流落盘之外，在暂停、
   切后台、离开页面三个时点各刷一次；切集由调用方在改集前同步刷。
   返回 ref 形态的 flush：调用方在事件点取最新闭包执行。 */
type Live = { id: number; ep: number; dur: number; t: number; permissionKey: string; scope: string };
type Guard = { allowed: boolean; id: number; playKey: string; permissionKey: string };

export function useProgressFlush(opts: {
  kind: string;
  paused: boolean;
  liveRef: RefObject<Live>;
  playGuard: RefObject<Guard>;
  actionContext: RefObject<{ scope: string }>;
  historyWriter: RefObject<(id: number, ep: number, t: number, dur: number) => void>;
}): RefObject<() => void> {
  const flush = () => {
    const s = opts.liveRef.current;
    const g = opts.playGuard.current;
    if (opts.kind === "video" && s && g && s.id && s.dur && g.allowed && g.id === s.id
      && opts.actionContext.current?.scope === s.scope
      && g.playKey === `${s.id}:${s.ep}` && g.permissionKey === s.permissionKey) {
      opts.historyWriter.current?.(s.id, s.ep, s.t, s.dur);
    }
  };
  const ref = useRef(flush);
  ref.current = flush;
  useEffect(() => { if (opts.paused) ref.current(); }, [opts.paused]);
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "hidden") ref.current(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  useEffect(() => () => { ref.current(); }, []);
  return ref;
}
