import { useEffect, useRef } from "react";
import { pickLine } from "../../shared/network/autoLine";
import { tracePlayback } from "../../shared/diagnostics/playbackDiagnostics";
import type { FragStats, VideoHandle } from "../playback";

/* ── 卡顿自愈（2.0.5，Muse 2026-11-18 自 Feed 拆出，逻辑与移植时一致） ──
 * 最近 3 片吞吐都低于码率且刚发生 waiting 才触发：pickLine("stall", true) 重选线；
 * 真的切线后清本集地址缓存重解析并接回位置。护栏：全局间隔 ≥90s、同集 ≤2 次、手动暂停不触发。
 *
 * 键口径改版（整改 B1，Hark G1 P0-1）：pending/计数/接回登记此前以
 * 作用域 playKey（accountScope:lineEpoch:id:ep）为键——自愈触发切线
 * 后 epoch 必变，事件时以旧键写入的接回登记与新 playKey 永不相等，
 * 位置接回必然失效。现全部改 epoch 无关的内容键 id:ep；强制重解析
 * 不再直接清作用域键，改经 invalidatePlay 把内容键登记进缓存层的
 * 迁移 skip 集（作用域变化时该条目不迁移、自然失效重解析）。 */

/** 内容键：与 epoch/账号作用域无关的条目标识（id:ep）。 */
export const healContentKey = (id: number, ep: number): string => `${id}:${ep}`;

/** 接回登记写入（内容键 → 位置秒）。 */
export function recordHealResume(map: Map<string, number>, id: number, ep: number, t: number): void {
  map.set(healContentKey(id, ep), t);
}

/** 接回登记消费：命中返回位置并删除（只消费一次），未命中返回 null。 */
export function consumeHealResume(map: Map<string, number>, id: number, ep: number): number | null {
  const key = healContentKey(id, ep);
  const t = map.get(key);
  if (t === undefined) return null;
  map.delete(key);
  return t;
}

export function useStallHeal(deps: {
  active: boolean;
  isDesktop: boolean;
  playKey: string;
  curId: number;
  curEp: number;
  videoRef: React.RefObject<VideoHandle | null>;
  paused: boolean;
  /* 自愈强制重解析（整改 B1）：把内容键登记进缓存层迁移 skip 集，
   * 作用域变化时该条目不被迁移、按新作用域重新解析。 */
  invalidatePlay: (contentKey: string) => void;
  setErr: React.Dispatch<React.SetStateAction<string>>;
  setProxyRetry: React.Dispatch<React.SetStateAction<number>>;
}) {
  const { active, isDesktop, curId, curEp, videoRef, paused } = deps;
  const fragWindowRef = useRef<{ slow: boolean; kbps: number }[]>([]);
  const lastStallAtRef = useRef(0);
  const healStateRef = useRef<{ lastAt: number; counts: Record<string, number>; pendingKey: string | null; pendingAt: number }>(
    { lastAt: 0, counts: {}, pendingKey: null, pendingAt: 0 },
  );
  const healResumeRef = useRef(new Map<string, number>());
  /* 事件回调在分发瞬间执行、早于 React 重渲染：一切跨渲染读取都经
   * depsRef 取最新值（内容键/回调），不吃首渲染闭包。 */
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const maybeHealStall = () => {
    if (isDesktop || !active) return;
    const v = videoRef.current?.el();
    if (!v || paused || v.paused || v.ended) return;
    const now = Date.now();
    if (!lastStallAtRef.current || now - lastStallAtRef.current > 30_000) return;
    const hs = healStateRef.current;
    if (now - hs.lastAt < 90_000) return;
    const contentKey = healContentKey(curId, curEp);
    if ((hs.counts[contentKey] || 0) >= 2) return;
    hs.lastAt = now;
    hs.counts[contentKey] = (hs.counts[contentKey] || 0) + 1;
    hs.pendingKey = contentKey;
    hs.pendingAt = now;
    const rates = fragWindowRef.current.map((w) => Math.round(w.kbps)).join("/");
    fragWindowRef.current = [];
    lastStallAtRef.current = 0;
    tracePlayback("line.stallHeal", { stage: "trigger", video_id: curId, episode: curEp, frag_kbps: rates, heal_count: hs.counts[contentKey] });
    /* 播放卡顿自愈 = 故障路径：urgent 绕过选线两轮确认（整改 5） */
    void pickLine("stall", true, true).then(() => {
      if (healStateRef.current.pendingKey === contentKey) healStateRef.current.pendingKey = null;
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
      const d = depsRef.current;
      /* 内容键比对（整改 B1）：epoch 已变是常态，只认 id:ep 是否仍是
       * 当前条目；旧实现比作用域 playKey 必然不等、接回永不发生。 */
      if (key !== healContentKey(d.curId, d.curEp)) return;
      const v = d.videoRef.current?.el();
      const t = v && Number.isFinite(v.currentTime) ? v.currentTime : 0;
      if (t > 1) recordHealResume(healResumeRef.current, d.curId, d.curEp, t);
      tracePlayback("line.stallHeal", { stage: "re-resolve", key, resume_t: Math.round(t * 10) / 10 });
      d.invalidatePlay(key);
      d.setErr("");
      d.setProxyRetry((n) => n + 1);
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
