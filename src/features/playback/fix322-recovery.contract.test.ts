/**
 * fix322/play 契约测试（Muse 2026-11-19）：HLS 恢复必须收敛——
 * 同一故障期内 fatal 错误持续到达时，已排定的恢复不得被后续错误
 * 无限推迟。旧实现 error() 对每个新错误都 cancelTimer 重排，而
 * attempts 只在计时器真正触发时递增：错误间隔小于恢复延迟时恢复
 * 永不执行、上限永不触发、onFatal 永不调用（用户只见无限等待，
 * 真机「frag loading 后 hls.error、waiting 不出画」同类签名）。
 * 契约：①错误洪流中恢复动作照常按原排期执行；②持续故障下恢复
 * 依次执行至 4 次上限后 onFatal 收敛；③单发错误与 buffered 重置
 * 的既有语义不变；④待执行动作跟随最新错误（清单错误改走
 * loadSource，不被先到的分片错误锁死）。
 * 运行：node src/features/playback/fix322-recovery.contract.test.ts
 */
import assert from "node:assert/strict";

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

const Hls = (await import("hls.js")).default;
const { createHlsRecovery } = await import("./hlsRecovery.ts");

type ErrorData = Parameters<ReturnType<typeof createHlsRecovery>["error"]>[0];
const fragError = (): ErrorData => ({
  fatal: true, type: Hls.ErrorTypes.NETWORK_ERROR, details: Hls.ErrorDetails.FRAG_LOAD_ERROR,
} as ErrorData);
const manifestError = (): ErrorData => ({
  fatal: true, type: Hls.ErrorTypes.NETWORK_ERROR, details: Hls.ErrorDetails.MANIFEST_LOAD_ERROR,
} as ErrorData);

function makeRecovery() {
  const calls = { loadSource: 0, startLoad: 0, recoverMediaError: 0 };
  const fatals: string[] = [];
  const hls = {
    loadSource: () => { calls.loadSource += 1; },
    startLoad: () => { calls.startLoad += 1; },
    recoverMediaError: () => { calls.recoverMediaError += 1; },
  };
  const recovery = createHlsRecovery({
    hls: hls as never, video: { currentTime: 0 } as never, url: "http://hg.localhost/hls?u=x",
    isCurrent: () => true, isActive: () => true,
    resumePlayback: () => {},
    onFatal: (d) => { fatals.push(String(d.details)); },
  });
  return { recovery, calls, fatals };
}

/* ① 错误洪流（每 100ms 一发、持续 3s）不得饿死已排定的恢复 */
{
  const { recovery, calls } = makeRecovery();
  for (let i = 0; i < 30; i++) { recovery.error(fragError()); advance(100); }
  assert.ok(calls.startLoad >= 1, `错误洪流中恢复动作必须执行（实际 startLoad=${calls.startLoad}）`);
}

/* ② 持续故障：恢复执行至 4 次上限后 onFatal 收敛 */
{
  const { recovery, calls, fatals } = makeRecovery();
  for (let i = 0; i < 400 && fatals.length === 0; i++) { recovery.error(fragError()); advance(100); }
  assert.equal(calls.startLoad, 4, "恢复上限为 4 次");
  assert.deepEqual(fatals, ["fragLoadError"], "4 次后 onFatal 收敛（带最后错误）");
}

/* ③ 既有语义：单发错误按期执行；buffered 后计数重置、再错再恢复 */
{
  const { recovery, calls } = makeRecovery();
  recovery.error(fragError());
  advance(249);
  assert.equal(calls.startLoad, 0, "延迟未到不提前执行");
  advance(1);
  assert.equal(calls.startLoad, 1, "250ms 到期执行第一次恢复");
  recovery.buffered();
  recovery.error(fragError());
  advance(250);
  assert.equal(calls.startLoad, 2, "buffered 重置后新故障期重新恢复（延迟回 250ms）");
}

/* ④ 待执行动作跟随最新错误：先分片错、后清单错 → 走 loadSource */
{
  const { recovery, calls } = makeRecovery();
  recovery.error(fragError());
  advance(100);
  recovery.error(manifestError());
  advance(200);
  assert.equal(calls.loadSource, 1, "清单错误按原排期走 loadSource");
  assert.equal(calls.startLoad, 0, "不被先到的分片错误锁死为 startLoad");
}

console.log("fix322-recovery.contract: all assertions passed");
