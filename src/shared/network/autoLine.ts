/* Automatic line selection uses the real content API and keeps the current line
 * when every candidate is unavailable. */
import { api, hostOf, logLine, setNetObserver } from "../api/api";
import { tracePlayback } from "../diagnostics/playbackDiagnostics";
import { isPlaybackPlaying } from "../diagnostics/playbackFacts";
import { readStorage, STORAGE_KEYS } from "../storage/storage";

const HEALTH_STEPS = [60_000, 120_000, 300_000];
const RECHECK_MS = 4_000;
const DOWN_RETRY_MS = 10_000;
const PICK_COOLDOWN_MS = 15_000;
let enabledOverride: boolean | null = null;

export const autoLineEnabled = (): boolean => {
  return enabledOverride ?? readStorage(STORAGE_KEYS.autoLine) !== "off";
};

let started = false;
let attached = false;
let picking = false;
let checking = false;
let step = 0;
let downStreak = 0;
let failStreak = 0;
let lastPickAt: number | null = null;
let cancellation: Promise<void> = Promise.resolve();

/* 计时器单一注册表（Muse 2026-11-19 根治包，audit5 条 2）：旧实现有
 * 两套计时器——schedule 链的 timer 与 confirm-pending 的 20 秒确认任务，
 * 后者无 handle、stopTimer 清不掉，关闭→重开后旧任务到期会多发一轮
 * 无调度选线。现全部计时器收进同一注册表，stopTimer 停一切；确认
 * 回调另带 pick epoch，开关/纪元变更后过期即弃（与 Rust 侧双代次对齐）。 */
const timers = new Set<number>();
let pickEpoch = 0;
let confirmDelayMs = 20_000;
/** 测试缝：确认延迟可注入（生产恒 20s）。 */
export const setConfirmDelayForTests = (ms: number | null): void => { confirmDelayMs = ms ?? 20_000; };

function later(fn: () => void, delay: number): number {
  const id = window.setTimeout(() => { timers.delete(id); fn(); }, delay);
  timers.add(id);
  return id;
}

function stopTimer() {
  for (const id of timers) window.clearTimeout(id);
  timers.clear();
}

function schedule(delay: number) {
  stopTimer();
  if (!autoLineEnabled()) return;
  later(() => {
    if (navigator.onLine === false) {
      schedule(30_000);
    } else if (document.visibilityState === "visible") {
      void check("timer");
    } else {
      schedule(HEALTH_STEPS[0]);
    }
  }, delay);
}

export const setAutoLine = (on: boolean): Promise<void> => {
  pickEpoch += 1;
  enabledOverride = on;
  try { localStorage.setItem(STORAGE_KEYS.autoLine, on ? "on" : "off"); } catch { /* storage can be unavailable */ }
  if (!on) {
    stopTimer();
    const pending = cancellation.then(() => api.lineCancel());
    cancellation = pending.catch((error) => {
      logLine(`[line] cancel failed: ${(error as Error).message}`);
    });
    window.dispatchEvent(new Event("hg:auto-line-changed"));
    return pending;
  }
  if (started && !attached) attach();
  if (started) void pickLine("manual", true);
  window.dispatchEvent(new Event("hg:auto-line-changed"));
  return Promise.resolve();
};

/* 最近一轮选线探测结果（整改 2）：诊断报告直接复用，不再为生成报告
 * 重测一遍（GPT 审计实施细节）。只存内存快照，本进程内有效。 */
export type PickRound = {
  at: number;
  base: string;
  reason: string;
  /** 本轮被会话熔断拦截（line_auto 的 breakerBlocked）：诊断/设置页据此明示。 */
  breakerBlocked?: boolean;
  published: number | null;
  probed: number | null;
  okCount: number | null;
  measured: { host: string; tier: string; ms: number; kbps: number | null }[];
};
let lastRound: PickRound | null = null;
export const lastPickRound = (): PickRound | null => lastRound;

/* 线路热身（Muse 2026-11-19 根治包，audit6 P0-B 起播⑥）：仓内此前无
 * warmup 机制。线路确定（每轮选线落定且 base 变化）后，用生产客户端
 * 对当前 origin 做一次健康请求——line_health 走 Rust 生产栈（DNS 固定
 * ＋TLS），把冷连接成本付在选线时而非用户首点时。每 base 只热一次。 */
let lastWarmedBase = "";
function warmupCurrentLine(base: string): void {
  if (!base || base === lastWarmedBase) return;
  lastWarmedBase = base;
  void api.lineHealth()
    .then(() => tracePlayback("line.warmup", { line: hostOf(base) }))
    .catch(() => { /* 热身失败静默：正式请求路径自有重试 */ });
}

/* pending 槽（Muse 2026-11-19 根治包，audit6 P2-01 残项）：picking 中
 * 到达的手动选线旧实现静默丢弃。现置位 pendingManual，在飞轮次 finally
 * 消费、立即补跑一轮 force pick（仍受熔断/两轮确认约束，不新增旁路）；
 * main-return 同理走 pendingMainReturn 槽补跑普通一轮。 */
let pendingManual = false;
let pendingMainReturn = false;

export async function pickLine(reason: string, force = false, urgent = false): Promise<void> {
  if (!autoLineEnabled()) return;
  if (picking) {
    if (force) pendingManual = true;
    else if (reason === "main-return") pendingMainReturn = true;
    return;
  }
  if (!force && document.visibilityState !== "visible") return;
  if (!force && lastPickAt !== null && Date.now() - lastPickAt < PICK_COOLDOWN_MS) return;
  picking = true;
  let down = false;
  try {
    await cancellation;
    if (!autoLineEnabled()) return;
    const result = await api.lineAuto(urgent);
    if (result.cancelled || !autoLineEnabled()) return;
    lastPickAt = Date.now();
    downStreak = 0;
    failStreak = 0;
    step = 0;
    lastRound = {
      at: Date.now(),
      base: result.base,
      reason: result.pick.reason,
      breakerBlocked: result.breakerBlocked === true,
      published: result.pick.published ?? null,
      probed: result.pick.probed ?? null,
      okCount: result.pick.okCount ?? null,
      measured: result.pick.candidates.map((c) => ({
        host: hostOf(c.url), tier: c.tier, ms: c.ms, kbps: c.kbps ?? null,
      })),
    };
    if (result.breakerBlocked) {
      logLine(`[line] auto(${reason}) breaker-blocked keep ${hostOf(result.base)}`);
      tracePlayback("line.breakerBlocked", { reason, line: hostOf(result.base) });
    }
    warmupCurrentLine(result.base);
    const candidates = result.pick.candidates
      .map((candidate) => `${candidate.tier}:${candidate.kbps != null ? `${candidate.kbps}kbps` : candidate.ok ? "ok" : candidate.reachable ? "reachable" : "down"}/${candidate.ms}ms`)
      .join(",");
    if (result.pick.reason === "confirm-pending") {
      /* 两轮确认（整改 5）：首轮胜者已记待确认，约一轮确认探测——
       * 同胜者再胜才真切；胜者变了就重新计待确认。 */
      logLine(`[line] auto(${reason}) confirm-pending winner=${result.pick.pendingWinner ? hostOf(result.pick.pendingWinner) : "?"} keep ${hostOf(result.base)} | ${candidates}`);
      tracePlayback("line.confirmPending", { reason, winner: result.pick.pendingWinner ? hostOf(result.pick.pendingWinner) : "", line: hostOf(result.base) });
      const epoch = pickEpoch;
      later(() => {
        if (epoch !== pickEpoch || !autoLineEnabled()) return;
        void pickLine("confirm");
      }, confirmDelayMs);
      return;
    }
    if (result.pick.reason === "all-down") {
      down = true;
      logLine(`[line] auto(${reason}) all-down, keep ${hostOf(result.base)} | ${candidates}`);
      tracePlayback("line.allDown", { reason, line: hostOf(result.base), candidates });
      window.dispatchEvent(new Event("hg:line-down"));
      return;
    }
    logLine(`[line] auto(${reason}) ${hostOf(result.base)} tier=${result.pick.tier} ms=${result.pick.ms} switched=${result.switched} | ${candidates}`);
    tracePlayback("line.pick", { reason, line: hostOf(result.base), tier: result.pick.tier, ms: result.pick.ms, switched: result.switched, candidates });
    if (result.switched) {
      window.dispatchEvent(new CustomEvent("hg:line", {
        detail: { region: result.pick.tier === "main" ? "intl" : "cn", host: hostOf(result.base), ms: result.pick.ms },
      }));
      window.dispatchEvent(new Event("hg:line-changed"));
    }
  } catch (error) {
    logLine(`[line] auto(${reason}) failed: ${(error as Error).message}`);
    tracePlayback("line.fail", { where: "auto", reason, err: (error as Error).message });
  } finally {
    picking = false;
    if (pendingManual) {
      pendingManual = false;
      if (autoLineEnabled()) { void pickLine("manual-pending", true); return; }
    }
    if (pendingMainReturn) {
      pendingMainReturn = false;
      if (autoLineEnabled()) { void pickLine("main-return"); return; }
    }
    if (started) schedule(down ? DOWN_RETRY_MS : HEALTH_STEPS[0]);
  }
}

/* tryMain 收编（Muse 2026-11-19 根治包，audit6 条 5）：旧 line_try_main
 * 单次健康检查即直切主站，绕过排名/两轮确认/熔断/记账四道。现删除该
 * 切换权——check() 发现主站健康只触发一轮普通 pickLine("main-return")，
 * 主站作为候选进统一排名、经同一 confirm/熔断/记账路径决定切不切。 */

async function check(reason: string): Promise<void> {
  if (!autoLineEnabled() || checking) return;
  if (picking) {
    schedule(HEALTH_STEPS[step]);
    return;
  }
  checking = true;
  try {
    const health = await api.lineHealth();
    if (health.ok) {
      downStreak = 0;
      step = Math.min(step + 1, HEALTH_STEPS.length - 1);
      /* 播放中护栏（整改 3）：回切主站会让播放器换 origin 重载——正在
       * 播放时不做这个常规切换，等下个健康周期/暂停后再回。故障路径
       * （下方 down 分支）不受此护栏影响。 */
      if (hostOf(health.base) !== "huangguoai.com" && !isPlaybackPlaying()) await pickLine("main-return");
      schedule(HEALTH_STEPS[step]);
      return;
    }
    downStreak += 1;
    logLine(`[line] health(${reason}) down=${downStreak} base=${hostOf(health.base)} ms=${health.ms}`);
    tracePlayback("line.health", { reason, line: hostOf(health.base), down: downStreak, ms: health.ms, status: health.status });
    if (downStreak < 2) {
      schedule(RECHECK_MS);
      return;
    }
    downStreak = 0;
    step = 0;
    /* 当前线健康检查连挂 = 故障路径：绕过两轮确认立即重选（整改 5） */
    await pickLine(reason, true, true);
  } catch (error) {
    logLine(`[line] health(${reason}) failed: ${(error as Error).message}`);
    schedule(HEALTH_STEPS[step]);
  } finally {
    checking = false;
  }
}

function attach() {
  if (attached) return;
  attached = true;
  setNetObserver((result) => {
    if (!autoLineEnabled()) return;
    if (!result.cmd.startsWith("api_")) return;
    if (result.ok) { failStreak = 0; return; }
    if (!result.networkish || ++failStreak < 2) return;
    failStreak = 0;
    void check("api-fail");
  });
  window.addEventListener("online", () => { step = 0; void pickLine("online"); });
  window.addEventListener("offline", () => schedule(30_000));
  window.addEventListener("hg:proxy-changed", () => {
    // Backend invalidates outstanding selections on save. Keep the selected
    // line and let a fresh health check evaluate the new route after settling.
    failStreak = 0;
    downStreak = 0;
    step = 0;
    lastPickAt = null;
    schedule(RECHECK_MS);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") stopTimer();
    else { downStreak = 0; step = 0; void check("visible"); }
  });
  schedule(HEALTH_STEPS[0]);
}

export function initAutoLine(): void {
  if (started) return;
  started = true;
  if (!autoLineEnabled()) return;
  attach();
  void pickLine("boot");
}
