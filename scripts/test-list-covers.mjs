// List-cover device-chain gate (Muse 2026-11-20 fix331/covers-header).
// 验收门槛（2026-11-20 01:06 用户亲定）：封面「修好」的证据必须走完
// 整设备链模拟——真实本地 /img 路由（127.0.0.1:17650，Rust 语义：
// 上游 20s 超时 / retryable 三试 350·700ms 退避 / 终局 502 / 同址
// 在途去重与成功缓存）＋代理线路量级延迟注入；组件级或直连快网
// 通过只算本地初验。
// 三个场景对 3.3.1 真机一级证据（Feed 封面 159 显示 · 45 终局失败
// 全 network · 在途峰值 17）做判别：
//   latency —— 代理量级延迟（TTFB 600ms）＋20 图并发武装：链路应
//              全部显示、零终局失败（延迟本身不是失败因）；
//   cliff   —— 图床对超额并发连接直接 reset（>4 并发、瞬时型）：
//              验证双层重试能否吸收（吸收则排除该解释）；
//   penalty —— 超额并发触发 30s 惩罚窗（持续型拒绝）：若终局失败
//              出现，其形态应全为 network（与真机签名对照）；
//   stall   —— 上游只接不答：形态应全为 timeout（与真机签名相反，
//              证真机失败不是慢响应型）。
// Local only: loopback fixture servers + Chromium; not WKWebView,
// 上游为本地模拟（真实图床并发探针结论另见 evidence 报告）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "list-covers", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { environment: "Device-chain simulation: Chromium -> local /img route sim (Rust semantics) -> CDN sim; not WKWebView", modes: {}, passed: [], failed: [] };
const check = (name, cond, detail = "") => {
  if (cond) report.passed.push(name);
  else report.failed.push(detail ? `${name}: ${detail}` : name);
};

/* ~74KB 真实形态 JPEG（噪点源，与真站封面同量级） */
const jpegPath = join(tmpdir(), "hghub-cover-fixture.jpg");
execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "testsrc2=size=480x640:rate=1", "-vf", "noise=alls=35:allf=t", "-frames:v", "1", "-q:v", "5", jpegPath]);
const JPEG = await readFile(jpegPath);
report.jpegBytes = JPEG.length;

/* ── 图床模拟 ── */
function startCdn(mode) {
  const state = { inflight: 0, peak: 0, requests: 0, resets: 0, served: 0, penaltyUntil: 0 };
  const server = createHttpServer((req, res) => {
    state.requests++;
    state.inflight++;
    if (state.inflight > state.peak) state.peak = state.inflight;
    const done = () => { state.inflight--; };
    /* penalty：超额并发触发 30s 惩罚窗，窗内一切新连接直接 reset
     * （图床/代理常见的限流形态——瞬时拒绝靠重试可吸收，持续拒绝
     * 才能打穿路由三试＋Img 三试，见 cliff 实测对照）。 */
    if (mode === "penalty" && Date.now() < state.penaltyUntil) {
      state.resets++;
      req.socket.destroy();
      done();
      return;
    }
    if ((mode === "cliff" || mode === "penalty") && state.inflight > 4) {
      if (mode === "penalty") state.penaltyUntil = Date.now() + 30000;
      state.resets++;
      req.socket.destroy();
      done();
      return;
    }
    if (mode === "stall") return; // 只接不答；进程退出时统一销毁
    const ttfb = mode === "cliff" ? 800 : 600;
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": JPEG.length });
      res.end(JPEG);
      state.served++;
      done();
    }, ttfb);
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, state, port: server.address().port })));
}

/* ── /img 路由模拟（Rust media::load_image + net::with_retry 语义） ── */
function startRoute() {
  const state = { requests: 0, upstreamAttempts: 0, ok: 0, failed: 0 };
  const cache = new Map();
  const inflight = new Map();
  const fetchUpstream = async (u) => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      state.upstreamAttempts++;
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
        if (r.ok) return Buffer.from(await r.arrayBuffer());
        lastErr = new Error(`HTTP ${r.status}`);
        if (r.status < 500) break;
      } catch (e) { lastErr = e; }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
    }
    throw lastErr;
  };
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1:17650");
    if (url.pathname !== "/img") { res.writeHead(404); res.end(); return; }
    state.requests++;
    const u = url.searchParams.get("u") ?? "";
    try {
      let body = cache.get(u);
      if (!body) {
        let p = inflight.get(u);
        if (!p) { p = fetchUpstream(u).finally(() => inflight.delete(u)); inflight.set(u, p); }
        body = await p;
        cache.set(u, body);
      }
      state.ok++;
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": body.length });
      res.end(body);
    } catch {
      state.failed++;
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("upstream error");
    }
  });
  return new Promise((done) => server.listen(17650, "127.0.0.1", () => done({ server, state })));
}

let vite, browser;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const route = await startRoute();

  const runMode = async (mode, n, timeoutMs) => {
    const cdn = await startCdn(mode);
    route.state.requests = 0; route.state.upstreamAttempts = 0; route.state.ok = 0; route.state.failed = 0;
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => report.failed.push(`${mode} pageerror: ${e.message}`));
    await page.goto(`${origin}tests/list-covers.html?cdn=${cdn.port}&n=${n}`);
    const state = () => page.evaluate(() => (window).__covers.state());
    /* 等卡片挂载后连续滚动武装全部封面（模拟真机快速翻列表）。 */
    const t0 = Date.now();
    let s = await state();
    while (s.frames < n && Date.now() - t0 < 20000) { await new Promise((r) => setTimeout(r, 150)); s = await state(); }
    while (Date.now() - t0 < timeoutMs) {
      await page.evaluate(() => (window).__covers.scrollStep());
      s = await state();
      if (s.image.displayed + s.image.failed >= n) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const rec = {
      settled: s.image.displayed + s.image.failed,
      displayed: s.image.displayed,
      failed: s.image.failed,
      byReason: s.image.byReason,
      inFlightPeak: s.image.inFlightPeak,
      surfacePosts: s.image.bySurface?.["source-posts"] ?? null,
      hgDom: s.hg,
      cdn: { ...cdn.state },
      route: { ...route.state },
      ms: Date.now() - t0,
    };
    report.modes[mode] = rec;
    await ctx.close();
    cdn.server.closeAllConnections?.();
    cdn.server.close();
    return rec;
  };

  const lat = await runMode("latency", 20, 90000);
  check("latency: all 20 covers displayed through device chain", lat.displayed === 20 && lat.failed === 0,
    JSON.stringify(lat));
  check("latency: surface attribution complete (source-posts)", lat.surfacePosts?.displayed === 20,
    JSON.stringify(lat.surfacePosts));

  const cliff = await runMode("cliff", 20, 120000);
  /* 瞬时 reset 型拒绝：双层重试（路由 3 试＋Img 3 试）应将其全数
   * 吸收——47% 量级的连接重置也不产生终局失败（实测值见 report）。
   * 这把「图床偶发拒并发」从真机 22% 终局失败的解释里排除。 */
  check("cliff: transient reset cliff is fully absorbed by retry layers (no terminal failures)",
    cliff.failed === 0 && cliff.displayed === 20, JSON.stringify(cliff));

  const penalty = await runMode("penalty", 20, 120000);
  check("penalty: sustained refusal produces terminal failures", penalty.failed > 0, JSON.stringify(penalty));
  check("penalty: terminal failures are all network-form (device signature)",
    penalty.failed > 0 && (penalty.byReason?.network ?? 0) === penalty.failed, JSON.stringify(penalty.byReason));

  const stall = await runMode("stall", 6, 150000);
  check("stall: unresponsive upstream produces only timeout-form failures",
    stall.failed === 6 && (stall.byReason?.timeout ?? 0) === 6, JSON.stringify(stall));

  route.server.closeAllConnections?.();
  route.server.close();
} catch (e) {
  report.failed.push(`harness: ${e.message}`);
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  if (browser) await browser.close();
  if (vite) await vite.close();
}
console.log(JSON.stringify(report, null, 2));
assert.equal(report.failed.length, 0, `list-covers failures: ${report.failed.join("; ")}`);
