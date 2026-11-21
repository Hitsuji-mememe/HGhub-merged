/**
 * fix3313/playback-error 契约（Muse 2026-11-21）：清单级起播失败必须
 * 快速落卡——010 定因（fix3312/evidence/startup-stall-investigation.md
 * §4）：清单 502 时 hls.js 内重试（5 发）×App 恢复 loadSource（4 轮）
 * 双层相乘 ≈25 发、静默转圈 1~2 分钟才落错误卡；上游磨到 15s 截止
 * 时达数分钟。player-3（14s 无 loadedmetadata）同链：清单根本取不到。
 * 口径：①清单级失败只许有界重试（恢复层 loadSource ≤2 次）＋起播无
 * 进展预算 10s——预算内零进展（清单未到）即以最后真实错误（无错误
 * 时合成 MANIFEST_LOAD_TIMEOUT）落 onFatal；②慢但有进展不误杀：
 * MANIFEST_PARSED / FRAG_BUFFERED 任一到达即解除预算，其后时长不
 * 受本判据管辖；③被覆盖（不活跃）时不落卡，恢复活跃后交付。
 * 运行：node src/features/playback/fix3313-manifest-startup.contract.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* 假时钟 window：hlsRecovery 只经 window.setTimeout/clearTimeout 调度。 */
type Timer = { id: number; at: number; fn: () => void; cleared: boolean };
let now = 0;
let nextId = 1;
const timers: Timer[] = [];
(globalThis as { window?: unknown }).window = {
  setTimeout: (fn: () => void, ms: number) => {
    const id = nextId++;
    timers.push({ id, at: now + ms, fn, cleared: false });
    return id;
  },
  clearTimeout: (id: number) => {
    const t = timers.find((x) => x.id === id);
    if (t) t.cleared = true;
  },
};
function advance(ms: number) {
  const target = now + ms;
  for (;;) {
    const due = timers.filter((t) => !t.cleared && t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!due) break;
    now = due.at;
    due.cleared = true;
    due.fn();
  }
  now = target;
}
function resetClock() {
  now = 0;
  timers.length = 0;
}

const Hls = (await import("hls.js")).default;
const { createHlsRecovery, MANIFEST_STARTUP_BUDGET_MS, MANIFEST_RECOVERY_MAX_ATTEMPTS } = await import("./hlsRecovery.ts");

type ErrorData = Parameters<ReturnType<typeof createHlsRecovery>["error"]>[0];
const manifestError = (): ErrorData => ({
  fatal: true, type: Hls.ErrorTypes.NETWORK_ERROR, details: Hls.ErrorDetails.MANIFEST_LOAD_ERROR,
  response: { code: 502 },
} as ErrorData);
const fragError = (): ErrorData => ({
  fatal: true, type: Hls.ErrorTypes.NETWORK_ERROR, details: Hls.ErrorDetails.FRAG_LOAD_ERROR,
} as ErrorData);

function makeRecovery(opts?: { active?: boolean }) {
  resetClock();
  let active = opts?.active ?? true;
  const calls = { loadSource: 0, startLoad: 0, recoverMediaError: 0 };
  const fatals: { details: string; at: number }[] = [];
  const hls = {
    loadSource: () => { calls.loadSource += 1; },
    startLoad: () => { calls.startLoad += 1; },
    recoverMediaError: () => { calls.recoverMediaError += 1; },
  };
  const recovery = createHlsRecovery({
    hls: hls as never, video: { currentTime: 0 } as never, url: "http://hg.localhost/hls?u=x",
    isCurrent: () => true, isActive: () => active,
    resumePlayback: () => {},
    onFatal: (d) => { fatals.push({ details: String(d.details), at: now }); },
  });
  return { recovery, calls, fatals, setActive: (v: boolean) => { active = v; } };
}

/* ① 清单快速失败（502 约 300ms 一发）：有界重试内收敛落卡——
 * loadSource 恢复 ≤上限、落卡时刻 ≤无进展预算、且交付的是真实错误。 */
{
  const { recovery, calls, fatals } = makeRecovery();
  recovery.error(manifestError());
  let lastLoad = 0;
  let failAt = -1;
  for (let i = 0; i < 300 && fatals.length === 0; i++) {
    advance(100);
    if (calls.loadSource > lastLoad) { lastLoad = calls.loadSource; failAt = now + 300; }
    if (failAt >= 0 && now >= failAt) { failAt = -1; recovery.error(manifestError()); }
  }
  assert.equal(fatals.length, 1, "清单持续失败必须收敛落卡");
  assert.ok(calls.loadSource <= MANIFEST_RECOVERY_MAX_ATTEMPTS,
    `清单恢复 loadSource 须 ≤${MANIFEST_RECOVERY_MAX_ATTEMPTS} 次（实际 ${calls.loadSource}）`);
  assert.ok(fatals[0].at <= MANIFEST_STARTUP_BUDGET_MS,
    `落卡时刻须 ≤${MANIFEST_STARTUP_BUDGET_MS}ms（实际 ${fatals[0].at}）`);
  assert.equal(fatals[0].details, "manifestLoadError", "落卡交付最后真实错误而非合成错误");
}

/* ② 挂死型（清单取数永不返回、零错误回报）：预算到期合成落卡。
 * 旧码无此看门：advance 多久都不会有 onFatal（无限转圈的构成件）。 */
{
  const { recovery, calls, fatals } = makeRecovery();
  advance(MANIFEST_STARTUP_BUDGET_MS - 1);
  assert.equal(fatals.length, 0, "预算未到不提前落卡");
  advance(1);
  assert.equal(fatals.length, 1, "预算到期必须落卡");
  assert.equal(fatals[0].details, "manifestLoadTimeOut", "无真实错误时合成清单超时");
  assert.equal(calls.loadSource, 0, "全程无错误即无恢复动作（看门独立于错误链）");
  recovery.error(manifestError());
  advance(60_000);
  assert.equal(fatals.length, 1, "看门落卡后锁存：后续错误不再重复交付/恢复");
  assert.equal(calls.loadSource, 0, "锁存后不再发起恢复取数");
}

/* ③ 慢但有进展不误杀：清单在预算内到达后，时长不再受本判据管辖；
 * 其后分片恢复语义与既有契约一致（按期 startLoad）。 */
{
  const { recovery, calls, fatals } = makeRecovery();
  advance(8_000);
  recovery.manifestParsed();
  advance(30_000);
  assert.equal(fatals.length, 0, "清单已到：预算解除，慢起播不被误杀");
  recovery.error(fragError());
  advance(250);
  assert.equal(calls.startLoad, 1, "清单后分片恢复照常按期执行");
  assert.equal(fatals.length, 0, "单发分片错误不落卡");
}

/* ④ FRAG_BUFFERED（recovery.buffered）同样是进展：解除预算。 */
{
  const { recovery, fatals } = makeRecovery();
  advance(5_000);
  recovery.buffered();
  advance(30_000);
  assert.equal(fatals.length, 0, "已有分片入缓冲：预算解除");
}

/* ⑤ 被覆盖（不活跃）时预算到期不落卡；恢复活跃后经 activityChanged 交付。 */
{
  const { recovery, fatals, setActive } = makeRecovery({ active: false });
  advance(MANIFEST_STARTUP_BUDGET_MS + 5_000);
  assert.equal(fatals.length, 0, "不活跃时不落卡（与恢复队列的覆盖纪律一致）");
  setActive(true);
  recovery.activityChanged();
  assert.equal(fatals.length, 1, "恢复活跃后交付积压的清单失败");
  assert.equal(fatals[0].details, "manifestLoadTimeOut", "积压交付为合成清单超时");
}

/* ⑥ 配置层钉死：hls.js 清单内部重试不再与恢复层相乘（旧值 4）。 */
{
  const src = readFileSync(new URL("./hlsConfig.ts", import.meta.url), "utf8");
  assert.ok(/manifestLoadingMaxRetry:\s*1\b/.test(src), "hlsConfig 清单内部重试须为 1（工厂默认值口径）");
}

console.log("fix3313-manifest-startup.contract: all assertions passed");
