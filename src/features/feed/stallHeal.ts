import { useEffect, useRef } from "react";
import { pickLine } from "../../shared/network/autoLine";
import { tracePlayback } from "../../shared/diagnostics/playbackDiagnostics";
import type { FragStats, VideoHandle } from "../playback";

/* ── 卡顿自愈（2.0.5，Muse 2026-11-18 自 Feed 拆出，逻辑与移植时一致） ──
 * 最近 3 片吞吐都低于码率且刚发生 waiting 才触发：pickLine("stall", true) 重选线；
 * 真的切线后清本集地址缓存重解析并接回位置。护栏：全局间隔 ≥90s、同集 ≤2 次、手动暂停不触发。 */
export function useStallHeal(deps: {
  active: boolean;
  isDesktop: boolean;
  playKey: string;
  curId: number;
  curEp: number;
  videoRef: React.RefObject<VideoHandle | null>;
  paused: boolean;
  /* 播放 URL 缓存已收敛到 usePlayUrlCache（audit6 P1-3）：自愈只需按
   * 作用域键清一条，不再直接操作两张状态表。 */
  clearPlayUrl: (key: string) => void;
  setErr: React.Dispatch<React.SetStateAction<string>>;
  setProxyRetry: React.Dispatch<React.SetStateAction<number>>;
}) {
  const { active, isDesktop, playKey, curId, curEp, videoRef, paused, clearPlayUrl, setErr, setProxyRetry } = deps;
  const fragWindowRef = useRef<{ slow: boolean; kbps: number }[]>([]);
  const lastStallAtRef = useRef(0);
  const healStateRef = useRef<{ lastAt: number; counts: Record<string, number>; pendingKey: string | null; pendingAt: number }>(
    { lastAt: 0, counts: {}, pendingKey: null, pendingAt: 0 },
  );
  const healResumeRef = useRef<{ key: string; t: number } | null>(null);
  const playKeyRef = useRef(playKey);
  playKeyRef.current = playKey;

  const maybeHealStall = () => {
    if (isDesktop || !active) return;
    const v = videoRef.current?.el();
    if (!v || paused || v.paused || v.ended) return;
    const now = Date.now();
    if (!lastStallAtRef.current || now - lastStallAtRef.current > 30_000) return;
    const hs = healStateRef.current;
    if (now - hs.lastAt < 90_000) return;
    if ((hs.counts[playKey] || 0) >= 2) return;
    hs.lastAt = now;
    hs.counts[playKey] = (hs.counts[playKey] || 0) + 1;
    hs.pendingKey = playKey;
    hs.pendingAt = now;
    const rates = fragWindowRef.current.map((w) => Math.round(w.kbps)).join("/");
    fragWindowRef.current = [];
    lastStallAtRef.current = 0;
    tracePlayback("line.stallHeal", { stage: "trigger", video_id: curId, episode: curEp, frag_kbps: rates, heal_count: hs.counts[playKey] });
    /* 播放卡顿自愈 = 故障路径：urgent 绕过选线两轮确认（整改 5） */
    void pickLine("stall", true, true).then(() => {
      if (healStateRef.current.pendingKey === playKey) healStateRef.current.pendingKey = null;
    });
  };

  const onFragStats = (st: FragStats) => {
    if (isDesktop || !active) return;
    const loadSec = st.loadMs / 1000;
    if (loadSec <= 0 || st.bytes <= 0) return;
    const kbps = (st.bytes * 8) / loadSec / 1000;
    const slow = st.bitrate > 0 ? kbps < st.bitrate / 1000 : st.fragDuration > 0 && loadSec > st.fragDuration;
    const win = fragWindowRef.current;
    win.push({ slow, kbps });
    if (win.length > 3) win.shift();
    if (win.length === 3 && win.every((w) => w.slow)) maybeHealStall();
  };

  useEffect(() => {
    const onLineChanged = () => {
      const hs = healStateRef.current;
      if (!hs.pendingKey || Date.now() - hs.pendingAt > 60_000) return;
      const key = hs.pendingKey;
      hs.pendingKey = null;
      if (key !== playKeyRef.current) return;
      const v = videoRef.current?.el();
      const t = v && Number.isFinite(v.currentTime) ? v.currentTime : 0;
      if (t > 1) healResumeRef.current = { key, t };
      tracePlayback("line.stallHeal", { stage: "re-resolve", key, resume_t: Math.round(t * 10) / 10 });
      clearPlayUrl(key);
      setErr("");
      setProxyRetry((n) => n + 1);
    };
    window.addEventListener("hg:line-changed", onLineChanged);
    return () => window.removeEventListener("hg:line-changed", onLineChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetHealWindow = () => {
    fragWindowRef.current = [];
    lastStallAtRef.current = 0;
  };

  return { lastStallAtRef, healResumeRef, onFragStats, resetHealWindow };

}
