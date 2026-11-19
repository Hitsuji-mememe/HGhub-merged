// Diagnostic report gate (Muse 2026-11-18, 收官批 D 重写).
// 接棒说明：旧版守「网络诊断」行与「播放诊断」区各自的复制链（原生 IPC
// 复制、失败保留报告、空日志不复制）。D 项合并后两处入口全部删除，本版
// 改守合并契约：设置页只剩一个「诊断报告」入口；点开即生成（网络探测 +
// 线路延迟 + 最近播放流水 + 源规格）→ 页面内预览全文 → 一个「复制报告」
// 按钮走原生 IPC；流水解析能识别 append 停滞签名与正常出画；日志记录
// 在状态为关时被 init 自动开启（记录始终开启、无开关）。
import assert from "node:assert/strict";
import { mkdir, writeFile} from "node:fs/promises";
import { dirname, join, resolve} from "node:path";
import { fileURLToPath} from "node:url";
import { createServer} from "vite";
import { chromium} from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "diagnostic-copy", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true});
const report = { environment: "Real Settings and merged diagnostic report; mocked Tauri IPC; not native iOS verification", passed: [], external: []};

/* 生产形态夹具（Muse 2026-11-19 整改 C3/C4/C5）：①play.resolve 在
 * source.load 之前发出且不带 player（Feed.tsx 口径），load 起的事件
 * 带 player（snapshot 注入）；②ts 为 Rust 写盘时刻、被前端 250ms
 * 批量 flush 量化成两批相同值，真实阶段间隔只在 data.mono_ms 里；
 * ③降级事件用落盘形态单前缀 web.playback.fallback 且不带 player。 */
const HEALTHY_LOG = [
{ event: "web.play.resolve", ts: "2026-11-18T05:00:00.250Z", pid: 4242, data: { mono_ms: 900}},
{ event: "web.source.load", ts: "2026-11-18T05:00:00.250Z", pid: 4242, data: { engine: "hls.js", player: "player-1", mono_ms: 1010}},
{ event: "web.hls.manifest", ts: "2026-11-18T05:00:00.250Z", pid: 4242, data: { player: "player-1", mono_ms: 1220}},
{ event: "web.hlsFragLoaded", ts: "2026-11-18T05:00:00.250Z", pid: 4242, data: { player: "player-1", mono_ms: 1500}},
{ event: "web.hls.buffer_appended", ts: "2026-11-18T05:00:02.500Z", pid: 4242, data: { player: "player-1", mono_ms: 1700}},
{ event: "web.hlsFragBuffered", ts: "2026-11-18T05:00:02.500Z", pid: 4242, data: { player: "player-1", mono_ms: 1710}},
{ event: "web.media.playing", ts: "2026-11-18T05:00:02.500Z", pid: 4242, data: { player: "player-1", mono_ms: 1900}},
{ event: "web.media.first_frame", ts: "2026-11-18T05:00:02.500Z", pid: 4242, data: { player: "player-1", mono_ms: 1950}},
].map(e => JSON.stringify(e)).join("\n") + "\n";

const STALL_LOG = [
{ event: "web.play.resolve", ts: "2026-11-18T05:10:00.250Z", pid: 4242, data: { mono_ms: 0}},
{ event: "web.source.load", ts: "2026-11-18T05:10:00.250Z", pid: 4242, data: { engine: "hls.js", player: "player-1", mono_ms: 100}},
{ event: "web.hls.manifest", ts: "2026-11-18T05:10:00.250Z", pid: 4242, data: { player: "player-1", mono_ms: 400}},
{ event: "web.hlsFragLoaded", ts: "2026-11-18T05:10:00.250Z", pid: 4242, data: { player: "player-1", mono_ms: 600}},
{ event: "web.hls.append_stall", ts: "2026-11-18T05:10:09.500Z", pid: 4242, data: { attempt: 0, player: "player-1", mono_ms: 4600}},
{ event: "web.playback.fallback", ts: "2026-11-18T05:10:09.500Z", pid: 4242, data: { reason: "append_stall", mono_ms: 9100}},
].map(e => JSON.stringify(e)).join("\n") + "\n";

let vite, browser, page;
try {
vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false}});
await vite.listen();
const origin = vite.resolvedUrls.local[0];
browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined});
page = await browser.newPage({ viewport: { width: 390, height: 844}, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 Version/17.1 Mobile/15E148 Safari/604.1"});
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("**/*", route => {
if (new URL(route.request().url()).origin === new URL(origin).origin) return route.continue();
report.external.push(route.request().url());
return route.abort();
});
await page.addInitScript((healthyLog) => {
const fixture = { failDiag: false, failCopy: false, failLogRead: false, diagCalls: 0, nativeCopies: [], webCopies: 0, calls: [], logText: healthyLog, logSetArgs: []};
Object.assign(window, {
isTauri: true,
diagnosticCopyFixture: fixture,
__TAURI_INTERNALS__: { async invoke(command, args = {}) {
fixture.calls.push(command);
if (command === "app_boot") return { strict_security: true, base: "https://fixture.invalid"};
if (command === "line_state") return { base: "https://fixture.invalid", fixed: [{ name: "固定线路1", url: "https://fixture.invalid"}, { name: "固定线路2", url: "https://mirror.fixture.invalid"}]};
if (command === "line_probe") return [
{ url: "https://fixture.invalid", ok: true, ms: 42, tier: "main"},
{ url: "https://mirror.fixture.invalid", ok: false, ms: 0, tier: "mirror"},
];
if (command === "proxy_state") return { mode: "custom", url: "http://127.0.0.1:7897", effective: "http://127.0.0.1:7897"};
if (command === "playback_log_status") return { enabled: false, path: "playback.log", error: null};
if (command === "playback_log_set") { fixture.logSetArgs.push(args); return { enabled: true, path: "playback.log", error: null};}
if (command === "playback_log_write" || command === "debug_log") return;
if (command === "net_diag") {
fixture.diagCalls++;
if (fixture.failDiag) throw "fixture: diagnostic unavailable";
return { verdict: "ok_proxy", summary: "应用 HTTP 请求已成功", host: "fixture.invalid", base: "https://fixture.invalid", dns: { count: 1}, tcp: { ok: false, timeout: true, proxy_bypassed: true, family: "IPv6"}, http: { status: 200, proxy_configured: true}, env: { app_proxy_mode: "custom", app_proxy: "http://127.0.0.1:7897"}, runtime: { os: "ios", arch: "aarch64", ver: "fixture"}, speed_ab: { bytes: 2097152, a_ms: 900, b_ms: 1500, host: "cdn.fixture.invalid"}};
}
if (command === "playback_log_read") { if (fixture.failLogRead) throw new Error("fixture: log read unavailable"); return fixture.logText;}
if (command === "plugin:clipboard-manager|write_text") {
if (fixture.failCopy) throw "fixture: clipboard unavailable";
fixture.nativeCopies.push(args.text);
return;
}
throw new Error(`Unexpected IPC: ${command}`);
}},
});
Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
writeText: async () => { fixture.webCopies++; throw new DOMException("The request is not allowed by the user agent", "NotAllowedError");},
}});
}, HEALTHY_LOG);

const load = async () => {
await page.goto(`${origin}tests/diagnostic-copy.html`);
await page.getByRole("button", { name: "诊断设置", exact: true}).waitFor();
};
const openGroup = async (group) => {
const trigger = page.getByRole("button", { name: `${group}设置`, exact: true});
if ((await trigger.getAttribute("aria-expanded"))!== "true") await trigger.click();
};
const generate = async () => {
await openGroup("诊断");
await page.getByRole("button").filter({ has: page.getByText("诊断报告", { exact: true})}).click();
const box = page.getByRole("textbox", { name: "诊断报告"});
await box.waitFor();
return box;
};

/* ── 旧入口全灭 + 记录自动开启 ── */
await load();
await openGroup("网络");
assert.equal(await page.getByText("网络诊断", { exact: true}).count(), 0, "网络诊断行应已删除");
assert.equal(await page.getByRole("button", { name: "播放诊断设置", exact: true}).count(), 0, "播放诊断分组应已删除");
assert.equal(await page.getByText("复制播放诊断日志", { exact: true}).count(), 0, "复制日志行应已删除");
await page.waitForFunction(() => window.diagnosticCopyFixture.logSetArgs.length === 1);
const setArgs = await page.evaluate(() => window.diagnosticCopyFixture.logSetArgs);
assert.equal(setArgs[0].enabled, true, "状态为关时应自动开启记录");
report.passed.push("Old diagnostic entries are gone (网络诊断 row, 播放诊断 group, log toggle/copy/path); playback log auto-enables on init");

/* ── 健康流水：生成 → 预览三段 → 复制 ── */
const box = await generate();
const text = await box.inputValue();
assert(text.startsWith(""), "标题缺失");
assert(text.includes("── 结论") && text.includes("── 硬数据") && text.includes("── 最近一次播放流水"), "三段结构缺失");
assert(text.includes("当前线路：line-01"), "当前线路必须稳定编号 ID 化（C8）");
assert(text.includes("line-01(当前) 42ms") && text.includes("line-02 不可达"), "各线延迟必须 ID 化（C8）");
assert(!text.includes("fixture.invalid"), "导出全文不许出现域名/host（C8 零业务词/零域名）");
assert(text.includes("账本事件"), "导出尾必须含 eventLedger 事件尾段（C8/#3）");
assert(text.includes("App 通道 2.2 MB/s"), "分片吞吐缺失");
assert(text.includes("最近播放已正常出画（playing）"), "健康卡点结论错误");
assert(text.includes("resolve ✓ 0ms") && text.includes("manifest ✓ 210ms") && text.includes("playing ✓ 890ms"), "流水耗时错误（阶段增量必须按 mono_ms 计算，resolve 必须归入本次起播）");
assert(text.includes("会话降级：未发生"), "降级行错误");
await writeFile(join(output, "sample-report-healthy.txt"), text);
await page.getByRole("button", { name: "复制报告", exact: true}).click();
await page.waitForFunction(() => window.diagnosticCopyFixture.nativeCopies.length === 1);
const copied = await page.evaluate(() => window.diagnosticCopyFixture.nativeCopies[0]);
assert.equal(copied, text, "复制内容应与预览全文一致");
assert.equal(await page.evaluate(() => window.diagnosticCopyFixture.webCopies), 0);
await page.getByText("诊断报告已复制", { exact: true}).waitFor();
report.passed.push("Healthy flow: report generates with three sections, line latencies, throughput, stage timings; copy matches preview via native IPC");

/* ── 卡死流水：append 停滞签名 + 会话降级入结论 ── */
await load();
await page.evaluate(log => { window.diagnosticCopyFixture.logText = log;}, STALL_LOG);
const stallBox = await generate();
const stallText = await stallBox.inputValue();
assert(stallText.includes("最近播放卡在 append（分片已下载、未入缓冲——append 停滞签名）"), "卡死签名未识别");
assert(stallText.includes("append ✗ 未达") && stallText.includes("playing ✗ 未达"), "流水未达标记缺失");
assert(stallText.includes("会话降级：本会话已降级原生播放（append 停滞）"), "降级结论缺失");
assert(stallText.includes("降级 1 次"), "降级计数必须按落盘单前缀 web.playback.fallback 数出（C5）");
await writeFile(join(output, "sample-report-stall.txt"), stallText);
report.passed.push("Stall flow: append-stall signature and session fallback land in the conclusion line");

/* ── net_diag 失败：报告降级不崩，网络段标注失败 ── */
await load();
await page.evaluate(() => { window.diagnosticCopyFixture.failDiag = true;});
const degradedBox = await generate();
const degradedText = await degradedBox.inputValue();
assert(degradedText.includes("网络：诊断失败（net_diag 不可用）"), "net_diag 失败未降级标注");
assert(degradedText.includes("── 最近一次播放流水"), "其余段落不应被拖垮");
report.passed.push("net_diag failure degrades only its own line; the rest of the report still generates");

/* ── 日志为空：报告明示记录未启动，不冒充「无播放」（终版加固回归） ── */
await load();
await page.evaluate(() => { window.diagnosticCopyFixture.logText = "";});
const emptyBox = await generate();
const emptyText = await emptyBox.inputValue();
assert(emptyText.includes("最近播放：未知（诊断日志为空"), "日志为空未明示");
assert(emptyText.includes("（诊断日志为空——记录可能未成功开启）"), "流水段未明示日志为空");
report.passed.push("Empty log: report states the log is empty instead of claiming no playback");

/* ── 日志读取失败：报告明示通道故障（终版加固回归） ── */
await load();
await page.evaluate(() => { window.diagnosticCopyFixture.failLogRead = true;});
const failBox = await generate();
const failText = await failBox.inputValue();
assert(failText.includes("最近播放：未知（诊断日志读取失败）"), "日志读取失败未明示");
assert(failText.includes("（诊断日志读取失败——本次无法提供播放流水）"), "流水段未明示读取失败");
report.passed.push("Log read failure: report states the diagnostics channel failed");

assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
console.log(`diagnostic-copy: ${report.passed.length} checks passed`);
} finally {
await browser?.close().catch(() => {});
await vite?.close().catch(() => {});
}
