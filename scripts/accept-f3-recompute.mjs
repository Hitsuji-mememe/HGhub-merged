/* F3/F3b 验收复算脚本（Muse 2026-11-19 3.2.1修复批验收员 B 增补；
 * 经本批任务书授权新增，AGENTS 不变量 11 的维护者同意来自验收任务书）。
 * 运行：node scripts/accept-f3-recompute.mjs [--root <仓库路径>]
 *
 * 验收对象＝用户可见不变量：「诊断报告里每个汇总数字，都能由同一份
 * 导出的原始记录（账本事件＋播放日志）复算一致。」
 *
 * 方法（与既有 fix321-f3/f3b 契约的区别：那两份契约把手捏事件数组喂给
 * 纯聚合器＋源码字符串断言；本脚本走报告全链）：esbuild 把目标树的
 * diagnosticReport 打包，mock Tauri IPC（playback_log_read 返回自备的
 * Rust 落盘 JSONL 原形日志），账本事件经生产写账路径
 * （createLedgerBinding.record）落账，Feed 事件经生产 traceFeed 落账，
 * 然后真跑 buildDiagnosticReport / buildFullDiagnosticExport，对报告
 * 文本逐节与本脚本内独立复算的 oracle 对账。期望值不调用任何被测
 * 聚合器生成。
 *
 * 原始记录＝两份 3.2.0 真机诊断实锤场景的同构复现（数字为本验收自备、
 * 与既有契约夹具不同）：①账本尾段 hold.release_profile ×3＋hold.jank
 * ×3（sr_engaged 混合）＋无标记 jank ×1；②账本尾段 media.playing＋
 * hlsFragLoaded 连串、播放日志尾段 pid 被 diagnostics.env/debug.line
 * 占据。两种日志形态各跑一轮：fullseg（更早 pid 段含完整播放）与
 * ledgeronly（日志无任何完整播放段、只有账本有播放）。
 *
 * 旧码基线 a3b122f 判别：把本脚本拷入基线树运行，长按/最近播放/流水/
 * 会话降级/全量导出诸节红（汇总 0/0、报无记录），exit=1；新码全绿。 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootArg = process.argv.indexOf("--root");
const root = rootArg >= 0 ? resolve(process.argv[rootArg + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "hghubx-accept-f3-"));

/* ── 原始记录：播放日志（Rust playback_log.rs 落盘 JSONL 原形）── */
const LOG_LINES = [
  { ts: "2026-11-19T10:03:01.000Z", pid: 4242, seq: 1, event: "web.source.load", strict: true, data: { player: "player-2", mono_ms: 100 } },
  { ts: "2026-11-19T10:03:01.100Z", pid: 4242, seq: 2, event: "web.hls.manifest", strict: true, data: { player: "player-2", mono_ms: 160 } },
  { ts: "2026-11-19T10:03:01.200Z", pid: 4242, seq: 3, event: "web.hlsFragLoaded", strict: true, data: { player: "player-2", mono_ms: 260 } },
  { ts: "2026-11-19T10:03:01.300Z", pid: 4242, seq: 4, event: "web.hls.buffer_appended", strict: true, data: { player: "player-2", mono_ms: 320 } },
  { ts: "2026-11-19T10:03:01.400Z", pid: 4242, seq: 5, event: "web.hlsFragBuffered", strict: true, data: { player: "player-2", mono_ms: 380 } },
  { ts: "2026-11-19T10:03:01.500Z", pid: 4242, seq: 6, event: "web.media.playing", strict: true, data: { player: "player-2", mono_ms: 460 } },
  { ts: "2026-11-19T10:04:01.000Z", pid: 4242, seq: 11, event: "web.play.resolve", strict: true, data: { mono_ms: 500 } },
  { ts: "2026-11-19T10:04:01.100Z", pid: 4242, seq: 12, event: "web.source.load", strict: true, data: { player: "player-2", mono_ms: 1000 } },
  { ts: "2026-11-19T10:04:01.500Z", pid: 4242, seq: 13, event: "web.hls.manifest", strict: true, data: { player: "player-2", mono_ms: 1400 } },
  { ts: "2026-11-19T10:04:02.200Z", pid: 4242, seq: 14, event: "web.hlsFragLoaded", strict: true, data: { player: "player-2", mono_ms: 2100 } },
  { ts: "2026-11-19T10:04:02.400Z", pid: 4242, seq: 15, event: "web.hls.buffer_appended", strict: true, data: { player: "player-2", mono_ms: 2300 } },
  { ts: "2026-11-19T10:04:02.700Z", pid: 4242, seq: 16, event: "web.hlsFragBuffered", strict: true, data: { player: "player-2", mono_ms: 2600 } },
  { ts: "2026-11-19T10:04:03.000Z", pid: 4242, seq: 17, event: "web.media.playing", strict: true, data: { player: "player-2", mono_ms: 2900 } },
  { ts: "2026-11-19T10:04:05.100Z", pid: 4242, seq: 18, event: "web.hlsFragLoaded", strict: true, data: { player: "player-2", mono_ms: 5000 } },
  { ts: "2026-11-19T10:04:06.100Z", pid: 4242, seq: 19, event: "web.hls.append_stall", strict: true, data: { player: "player-2", mono_ms: 6000, attempt: 0, state: "append-hung" } },
  { ts: "2026-11-19T10:05:00.000Z", pid: 7777, seq: 3, event: "diagnostics.env", strict: true, data: { os: "ios" } },
  { ts: "2026-11-19T10:05:01.000Z", pid: 7777, seq: 4, event: "debug.line", strict: true, data: { text: "tail" } },
];
const LOG_FULL = LOG_LINES.map(l => JSON.stringify(l)).join("\n") + "\n{broken half line\n";
const LOG_TAILONLY = LOG_LINES.filter(l => l.pid !== 4242).map(l => JSON.stringify(l)).join("\n") + "\n{broken half line\n";

/* ── 原始记录：账本事件（经生产绑定写账，data 形态同真机落账）── */
const RAW_LEDGER = [
  { inst: "A", name: "hold.release_profile", data: { sr_engaged: true, pipeline: "webgpu" } },
  { inst: "A", name: "hold.jank", data: { sr_engaged: true, pipeline: "webgpu" } },
  { inst: "A", name: "hold.release_profile", data: { sr_engaged: true, pipeline: "webgpu" } },
  { inst: "A", name: "hold.release_profile", data: { sr_engaged: false, pipeline: "none" } },
  { inst: "A", name: "hold.jank", data: { sr_engaged: false, pipeline: "none" } },
  { inst: "A", name: "hold.jank", data: { sr_engaged: false, pipeline: "none" } },
  { inst: "A", name: "hold.jank", data: { pipeline: "none" } },
  { inst: "B", name: "source.load", data: {} },
  { inst: "B", name: "play.resolve", data: {} },
  { inst: "B", name: "hls.manifest", data: {} },
  { inst: "B", name: "hlsFragLoaded", data: {} },
  { inst: "B", name: "hlsFragLoaded", data: {} },
  { inst: "B", name: "hlsFragLoaded", data: {} },
  { inst: "B", name: "hlsFragLoaded", data: {} },
  { inst: "B", name: "hls.buffer_appended", data: {} },
  { inst: "B", name: "media.playing", data: {} },
  { inst: "B", name: "hls.append_stall", data: { attempt: 0, state: "append-hung" } },
];

/* ── 打包目标树报告模块（flowSegments/fetchCounts 旧码不存在时降级）── */
const hasFlowSeg = existsSync(join(root, "src/shared/diagnostics/flowSegments.ts"));
const hasFetchCounts = existsSync(join(root, "src/features/sources/fetchCounts.ts"));
const entry = [
  `export * as report from ${JSON.stringify(join(root, "src/shared/diagnostics/diagnosticReport.ts"))};`,
  `export * as ledger from ${JSON.stringify(join(root, "src/shared/diagnostics/eventLedger.ts"))};`,
  `export * as feedTrace from ${JSON.stringify(join(root, "src/shared/lib/feedTrace.ts"))};`,
  `export * as registryDiag from ${JSON.stringify(join(root, "src/features/sources/registryDiag.ts"))};`,
  `export * as sourceRegistry from ${JSON.stringify(join(root, "src/shared/diagnostics/sourceRegistry.ts"))};`,
  hasFlowSeg ? `export * as flowSegments from ${JSON.stringify(join(root, "src/shared/diagnostics/flowSegments.ts"))};` : "",
  hasFetchCounts ? `export * as fetchCounts from ${JSON.stringify(join(root, "src/features/sources/fetchCounts.ts"))};` : "",
].join("\n");
writeFileSync(join(tmp, "entry.ts"), entry);
const bundlePath = join(tmp, "bundle.mjs");
execFileSync(join(root, "node_modules/.bin/esbuild"), [
  join(tmp, "entry.ts"), "--bundle", "--format=esm", "--platform=browser",
  `--outfile=${bundlePath}`, "--log-level=warning",
  `--define:__APP_VERSION__="accept"`, `--define:__BUILD_HASH__="accept"`, `--define:__BUILD_TIME__="accept"`,
], { stdio: "inherit" });

/* ── Tauri IPC mock ── */
let currentLog = LOG_FULL;
globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd) => {
      switch (cmd) {
        case "playback_log_read": return currentLog;
        case "net_diag": return { runtime: {}, env: {}, speed_ab: {}, base: "" };
        case "line_state": return { base: "", fixed: [], ledger: [], breaker: {} };
        case "proxy_state": return { mode: "off" };
        case "line_probe": return [];
        default: return undefined;
      }
    },
  },
};

const M = await import(bundlePath);
const { report, ledger, feedTrace, registryDiag, sourceRegistry } = M;

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label} | 汇总=${JSON.stringify(actual)} 复算=${JSON.stringify(expected)}`);
};
const checkHas = (label, text, needle) => {
  const ok = text.includes(needle);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label} | 报告含=${JSON.stringify(needle)}`);
};

/* 落账（生产写账路径） */
const bindings = { A: ledger.createLedgerBinding(), B: ledger.createLedgerBinding() };
for (const e of RAW_LEDGER) bindings[e.inst].record(e.name, e.data, 0);
feedTrace.traceFeed("page.request", { list: "channel:original", page: 1 });
feedTrace.traceFeed("page.success", { list: "channel:original", page: 1 });
feedTrace.traceFeed("page.success", { list: "channel:original", page: 2 });
feedTrace.traceFeed("page.state", { list: "channel:original", to: "ready" });
feedTrace.traceFeed("page.success", { list: "channel:ai-duanju", page: 1 });
feedTrace.traceFeed("page.fail", { list: "channel:ai-duanju", page: 2, reason: "error" });
feedTrace.imageStarted(); feedTrace.imageStarted(); feedTrace.imageStarted();
feedTrace.imageDisplayed(); feedTrace.imageDisplayed(); feedTrace.imageFailed("timeout");
try { sourceRegistry.registerSourceHealthProvider(registryDiag.sourceHealthLines); } catch { /* 钩子缺失则报告自降级 */ }

/* ── 独立复算 oracle ── */
const cnt = (name, sr) => RAW_LEDGER.filter(e => e.name === name && e.data.sr_engaged === sr).length;
const oracleHold = { engHolds: cnt("hold.release_profile", true), engJanks: cnt("hold.jank", true), bypHolds: cnt("hold.release_profile", false), bypJanks: cnt("hold.jank", false) };
const oracleStalls = RAW_LEDGER.filter(e => e.name === "hls.append_stall").length;
const logEntries = LOG_FULL.split("\n").filter(l => l.trim().startsWith("{")).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const oracleSegAll = logEntries.filter(e => e.pid === 4242);
const lastLoadAt = oracleSegAll.map(e => e.event).lastIndexOf("web.source.load");
const oracleSeg = oracleSegAll.slice(lastLoadAt);
const monoOf = (ev) => oracleSeg.find(e => e.event === ev)?.data?.mono_ms ?? null;
const oracleStartup = monoOf("web.media.playing") - monoOf("web.source.load");
const oracleTable = [["resolve", "web.play.resolve"], ["manifest", "web.hls.manifest"], ["range", "web.hlsFragLoaded"], ["append", "web.hls.buffer_appended"], ["buffered", "web.hlsFragBuffered"], ["playing", "web.media.playing"]]
  .map(([label, ev]) => {
    const m = ev === "web.play.resolve" ? 500 : monoOf(ev);
    return `${label} ✓ ${Math.max(0, m - monoOf("web.source.load"))}ms`;
  }).join(" · ");
/* 逐次 oracle：同 pid 内按 source.load 切段——第 1 次干净出画（playing
 * mono 460 − load 100 ＝ 360ms）、第 2 次卡死后出画（stall 1 次）。 */
const oraclePlaysLine = "本会话播放：共 2 次 · 出画 1 · 卡死后出画 1 · 起播 P50 1.9s · P90 1.9s · 干净起播中位 0.4s · 最慢 0.4s（#1）";

async function runMode(mode, logText) {
  currentLog = logText;
  const text = await report.buildDiagnosticReport();
  const full = await report.buildFullDiagnosticExport();
  const line = (p) => text.split("\n").find(l => l.startsWith(p)) ?? "(缺行)";
  console.log(`── mode=${mode} ──`);
  check("长按·SR接管", line("SR 接管：长按"), `SR 接管：长按 ${oracleHold.engHolds} 次 · 松手卡顿 ${oracleHold.engJanks} 次`);
  check("长按·判档直通", line("判档直通：长按"), `判档直通：长按 ${oracleHold.bypHolds} 次 · 松手卡顿 ${oracleHold.bypJanks} 次`);
  if (mode === "fullseg") {
    checkHas("最近播放·结论", text, `最近播放：最近播放已正常出画（playing） · 起播约 ${(oracleStartup / 1000).toFixed(1)}s（以 playing 代首帧）`);
    checkHas("流水·阶段表", text, oracleTable);
    checkHas("结论·卡死自愈", text, `会话降级：发生过 append 卡死、已自愈重建（未降级）（本会话卡死 ${oracleStalls} 次 · 自愈重建 ${oracleStalls} 次 · 降级 0 次 · 最近卡死形态：append 处理中卡住）`);
    check("结论·本会话逐次", line("本会话播放："), oraclePlaysLine);
    checkHas("全量导出·流水一致", full, oracleTable);
  } else {
    checkHas("最近播放·账本明示", text, "最近播放：未知（诊断日志无完整播放段——事件账本显示本会话有播放，流水通道与账本不一致）");
    checkHas("流水·账本明示", text, "（诊断日志无完整播放段——事件账本显示本会话有播放，本次无法提供播放流水）");
    checkHas("结论·卡死认账本", text, `会话降级：发生过 append 卡死、已自愈重建（未降级）（本会话卡死 ${oracleStalls} 次——据事件账本，诊断日志无完整播放段）`);
    checkHas("全量导出·流水账本明示", full, "（诊断日志无完整播放段——事件账本显示本会话有播放，本次无法提供播放流水）");
  }
  check("最近播放·不许报无记录", text.includes("最近播放：无最近播放记录"), false);
  check("流水·不许（无记录）", text.includes("（无记录）"), false);
  checkHas("Feed·original 分页", text, "分页[channel-02（主内容频道）]：已加载至第 2 页 · 终态 ready");
  checkHas("Feed·封面计数", text, "封面：已显示 2 · 终局失败 1（timeout 1） · 在途峰值 3");
  const l1 = text.split("\n").find(l => l.startsWith("源总览：")) ?? "";
  const num = (re) => { const m = re.exec(l1); return m ? Number(m[1]) : null; };
  check("源总览·四计数和=源总数", (num(/成功 (\d+)/) ?? 0) + (num(/失败 (\d+)/) ?? 0) + (num(/未(?:发生|观测) (\d+)/) ?? 0) + (num(/记录缺失 (\d+)/) ?? 0), num(/共 (\d+) 源/));
  checkHas("全量导出·长按行一致", full, `SR 接管：长按 ${oracleHold.engHolds} 次 · 松手卡顿 ${oracleHold.engJanks} 次`);
  const tail = full.split("══ 账本事件（尾 64 条） ══")[1]?.split("══")[0] ?? "";
  const tailCount = (n) => tail.split("\n").filter(l => l.endsWith(` ${n}`)).length;
  check("全量导出·账本尾 release_profile 数", tailCount("hold.release_profile"), 3);
  check("全量导出·账本尾 jank 数", tailCount("hold.jank"), 4);
  check("全量导出·账本尾 media.playing 数", tailCount("media.playing"), 1);
}

await runMode("fullseg", LOG_FULL);
await runMode("ledgeronly", LOG_TAILONLY);

/* ── 纯函数节（源总览记录缺失＋账本证据）：旧码无此模块即记红 ── */
console.log("── pure sections ──");
if (hasFetchCounts) {
  const hostOf = (u) => { try { return new URL(u).host || "?"; } catch { return "?"; } };
  const sources = [{ origin: "https://a.example.com" }, { origin: "https://b.example.com" }, { origin: "https://c.example.com" }, { origin: "https://d.example.com" }, { origin: "" }];
  const byHost = new Map([["a.example.com", { ok: true }], ["b.example.com", { ok: false }]]);
  const c = M.fetchCounts.countFetchStates(sources, byHost, hostOf);
  check("源计数·ok", c.ok, 1); check("源计数·fail", c.fail, 1);
  check("源计数·none", c.none, 2); check("源计数·missing", c.missing, 1);
  check("源计数·和=总数", c.ok + c.fail + c.none + c.missing, sources.length);
} else { failures++; console.log("FAIL 源计数·模块缺失（旧码无 countFetchStates，记录缺失被静默漏计）"); }
if (hasFlowSeg) {
  const ev2 = M.flowSegments.ledgerPlaybackEvidence(RAW_LEDGER.map(e => ({ name: e.name, instanceId: e.inst })));
  check("账本证据·hasPlayback", ev2.hasPlayback, true);
  check("账本证据·stallCount", ev2.stallCount, oracleStalls);
  const seg = M.flowSegments.selectFlowSegment(logEntries.map(e => ({ event: e.event, pid: e.pid })));
  check("选段·落到含 load 的 pid 段", seg.every(e => e.pid === 4242) && seg.some(e => e.event === "web.source.load"), true);
} else { failures++; console.log("FAIL 账本证据/选段·模块缺失（旧码无 flowSegments，选段被尾段 pid 绑架）"); }

console.log(`RESULT failures=${failures}`);
process.exit(failures ? 1 : 0);
