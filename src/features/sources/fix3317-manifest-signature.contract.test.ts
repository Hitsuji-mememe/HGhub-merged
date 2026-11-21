/**
 * fix3317 契约测试（Muse 2026-11-21，冻结前收尾包）：
 * A. 远程清单签名门——无签名/验不过的远程清单一律视为远程失败，
 *    走 last-good → builtin 回退链，不写缓存、不半应用；验签通过
 *    才生效并写 last-good；低版本远程被既有防回滚拒（回归）。
 *    验签本体（Ed25519＋规范化字节）在 Rust manifest_sig.rs，其
 *    真钥匙端到端（发布脚本签名 ↔ Rust 验签同口径）由发布前离线
 *    回读验证承接，本契约以注入桩收口 TS 侧门控语义。
 * B2. playing 进展守卫——置真后持续无进展超 10s 自动回落；进展
 *    刷新续期；置假立即生效。假时钟注入，不碰真实计时器。
 * B1/B3/B4. 接线字面断言——Player 媒体事件归属守卫、内核换源清
 *    facts 快照、报告选线双来源标注、webgpuSr presentUniform 显
 *    式释放，四处在 3.3.16 旧码中均缺席（旧码红）。
 * 运行：node src/features/sources/fix3317-manifest-signature.contract.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MANIFEST_CACHE_KEY, resolveRegistry } from "./manifest.ts";
import { createPlayingProgressGuard, PLAYING_PROGRESS_TIMEOUT_MS } from "../../shared/diagnostics/playbackFacts.ts";

const memStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, map: m };
};
const signedShape = { manifestVersion: 11, minAppVersion: "2.0.0", sources: [{ id: "hanime-tv", enabled: false }], signature: "AAAA" };

{ // 无签名/验不过 + 有 last-good → last-good，且远程不写缓存
  const st = memStorage();
  st.setItem(MANIFEST_CACHE_KEY, JSON.stringify({ manifestVersion: 7, minAppVersion: "2.0.0", sources: [{ id: "hanime-tv", enabled: true }] }));
  const r = await resolveRegistry({
    fetcher: async () => signedShape, storage: st, appVersion: "2.2.0",
    verifyManifest: async () => false,
  });
  assert.equal(r.source, "last-good", "验不过的远程清单不得生效");
  assert.equal(r.manifestVersion, 7);
  assert.equal(JSON.parse(st.map.get(MANIFEST_CACHE_KEY)!).manifestVersion, 7, "验不过不得覆盖 last-good 缓存");
}
{ // 无签名/验不过 + 无缓存 → builtin
  const r = await resolveRegistry({
    fetcher: async () => signedShape, storage: memStorage(), appVersion: "2.2.0",
    verifyManifest: async () => false,
  });
  assert.equal(r.source, "builtin", "验不过且无缓存时回落内置");
}
{ // 验签通过 → remote 生效 + 写 last-good + 熔断位生效
  const st = memStorage();
  let seenRaw: unknown = null;
  const r = await resolveRegistry({
    fetcher: async () => signedShape, storage: st, appVersion: "2.2.0",
    verifyManifest: async (raw) => { seenRaw = raw; return true; },
  });
  assert.equal(r.source, "remote", "验签通过的远程清单应生效");
  assert.equal(r.manifestVersion, 11);
  assert.equal(r.sources.find((s) => s.id === "hanime-tv")!.enabled, false, "远程熔断位生效");
  assert.ok(st.map.has(MANIFEST_CACHE_KEY), "验签通过写入 last-good");
  assert.equal((seenRaw as typeof signedShape).signature, "AAAA", "验签入参为含 signature 的原始对象");
}
{ // 降级版本拒（既有防回滚回归）：远程 v3 < last-good v7，验签通过也不得生效
  const st = memStorage();
  st.setItem(MANIFEST_CACHE_KEY, JSON.stringify({ manifestVersion: 7, minAppVersion: "2.0.0", sources: [] }));
  const r = await resolveRegistry({
    fetcher: async () => ({ manifestVersion: 3, minAppVersion: "2.0.0", sources: [] }),
    storage: st, appVersion: "2.2.0",
    verifyManifest: async () => true,
  });
  assert.equal(r.source, "last-good", "低版本远程清单被防回滚拒绝（签名不豁免版本门）");
  assert.equal(r.manifestVersion, 7);
}
{ // 验签接缝缺席（非 Tauri 环境默认通道）→ fail-closed 走内置
  const r = await resolveRegistry({
    fetcher: async () => signedShape, storage: memStorage(), appVersion: "2.2.0",
  });
  assert.equal(r.source, "builtin", "默认验签通道不可用时必须 fail-closed");
}

/* ── B2 playing 进展守卫（假时钟） ── */
{
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const guard = createPlayingProgressGuard({
    now: () => now,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (h) => { timers.delete(h as number); },
  });
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = target;
  };
  assert.equal(PLAYING_PROGRESS_TIMEOUT_MS, 10_000, "进展超时与 append 看门狗 10s 同口径");
  guard.note(true);
  assert.equal(guard.isPlaying(), true, "置真即在播");
  advance(9_999);
  assert.equal(guard.isPlaying(), true, "超时前仍在播");
  advance(1);
  assert.equal(guard.isPlaying(), false, "持续无进展超 10s 自动回落未播放");
  guard.note(true);
  advance(9_000);
  guard.progress();
  advance(9_000);
  assert.equal(guard.isPlaying(), true, "进展刷新续期");
  advance(1_001);
  assert.equal(guard.isPlaying(), false, "续期后仍无进展则回落");
  guard.note(true);
  guard.note(false);
  assert.equal(guard.isPlaying(), false, "置假立即生效");
  advance(60_000);
  assert.equal(guard.isPlaying(), false, "置假后计时器已清、不复活");
  guard.progress();
  assert.equal(guard.isPlaying(), false, "未在播时进展信号不置真");
}

/* ── B1/B3/B4/A 接线字面断言 ── */
{
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  const player = read("../playback/Player.tsx");
  assert.ok(player.includes("attachedSource"), "B1：Player 有 attachedSource 归属登记");
  assert.ok(player.includes("isAttachedEvent()"), "B1：Player 媒体事件先验归属");
  const kernel = read("../playback/usePlaybackKernel.ts");
  assert.ok(kernel.includes("clearPlaybackFacts()"), "B3：内核 beginSource 清 facts 快照");
  assert.ok(kernel.includes("notePlaybackProgress()"), "B2：内核接线 timeupdate 进展信号");
  const report = read("../../shared/diagnostics/diagnosticReport.ts");
  assert.ok(report.includes("（Rust line_state 当前 base）"), "B3：报告标注 Rust 当前 base 来源");
  assert.ok(report.includes("（JS lastPickRound）"), "B3：报告标注 lastPickRound 来源");
  const sr = read("../playback/webgpuSr.ts");
  assert.ok(sr.includes("presentUniform as { destroy?:"), "B4：destroy() 显式释放 presentUniform");
  const manifestTs = read("./manifest.ts");
  assert.ok(manifestTs.includes("manifest_verify_signature"), "A：TS 侧经 Rust 命令验签");
  const manifestSig = read("../../../src-tauri/src/manifest_sig.rs");
  assert.ok(manifestSig.includes("MANIFEST_PUBKEY"), "A：Rust 侧公钥固化");
  assert.ok(manifestSig.includes("verify_strict"), "A：Rust 侧严格验签");
}

console.log("fix3317-manifest-signature contract ok");
