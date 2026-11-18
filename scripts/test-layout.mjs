// Layout geometry gate (Muse 2026-11-18, user-directed after the 2.2.0 fullscreen
// bottom-bar overflow shipped: DOM-presence tests cannot see a control pushed
// off-viewport). For each viewport in the matrix it loads the real Feed fixture,
// enters fullscreen, and asserts geometry, not existence:
//   - no page-level horizontal overflow;
//   - every visible control in the bottom bar region lies fully inside the viewport;
//   - the exit-fullscreen control is fully inside and hit-testable at its center
//     (elementFromPoint), under both the live clock text and an injected
//     worst-case "59:59/59:59" time text;
//   - rate / super-res menus and the episodes sheet stay inside the viewport;
//   - key controls do not overlap each other.
// One contract, one regression: this is the only layout-geometry scenario.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv.includes("--output") ? process.argv[process.argv.indexOf("--output") + 1] : join(root, "test-results", "layout", new Date().toISOString().replace(/[:.]/g, "-")));
await mkdir(output, { recursive: true });
const report = { started: new Date().toISOString(), transport: "browser fixture; not Tauri/WKWebView", cases: [] };

const fixtureMediaOrigins = new Set(["http://127.0.0.1:17650", "http://hg.localhost"]);
let mediaBase = "";
const fixtureMediaUrl = raw => {
  const url = new URL(raw);
  return fixtureMediaOrigins.has(url.origin) ? new URL(`${url.pathname}${url.search}`, mediaBase).href : raw;
};

async function serveMedia(dir) {
  const manifest = await readFile(join(dir, "list.m3u8"), "utf8");
  assert(manifest.startsWith("#EXTM3U"), "Expected a local VOD HLS fixture");
  const server = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      let body, kind;
      if (url.pathname === "/hls") {
        body = Buffer.from(manifest.split("\n").map(line => !line || line.startsWith("#") ? line :
          `http://hg.localhost/seg?u=${encodeURIComponent(`https://media.fixture.invalid/${line.trim()}`)}`).join("\n"));
        kind = "application/vnd.apple.mpegurl";
      } else if (url.pathname === "/seg") {
        const fragment = basename(new URL(url.searchParams.get("u")).pathname);
        assert(/^seg\d+\.ts$/.test(fragment), "Unexpected fixture segment");
        await new Promise(done => setTimeout(done, 60));
        body = await readFile(join(dir, fragment)); kind = "video/mp2t";
      } else { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": kind, "Content-Length": body.length, "Access-Control-Allow-Origin": "*" });
      res.end(body);
    } catch { res.writeHead(404); res.end("fixture error"); }
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  return server;
}

const generateHlsFixture = (dir, size) => execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=15`, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "90", "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod", "-hls_segment_filename", join(dir, "seg%03d.ts"), join(dir, "list.m3u8")], { timeout: 60000, stdio: "pipe" });

// In-page geometry probe: measures visible buttons in the bottom control region
// plus the named key controls. Runs synchronously so a worst-case time text can
// be injected and measured before the playback clock re-renders it.
const PROBE = (worstTime) => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const visible = el => {
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0.05;
  };
  const rectOf = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  if (worstTime) {
    // Stretch the bar's time text to the longest realistic value before measuring.
    for (const el of document.querySelectorAll("span")) {
      if (/^\s*\/\s*\d+:\d+\s*$/.test(el.textContent || "")) el.textContent = "/59:59";
      else if (/^\s*\d+:\d+\s*$/.test(el.textContent || "") && el.closest("div")?.querySelector("button")) el.textContent = "59:59";
    }
  }
  const byLabel = name => document.querySelector(`button[aria-label="${name}"]`);
  const keys = {};
  for (const name of ["退出全屏", "选集", "倍速选择", "静音", "取消静音"]) {
    const el = byLabel(name);
    if (el && visible(el)) keys[name] = rectOf(el);
  }
  const sr = [...document.querySelectorAll("button")].find(b => (b.getAttribute("aria-label") || "").startsWith("超分"));
  if (sr && visible(sr)) keys["超分选择"] = rectOf(sr);
  const bottomButtons = [...document.querySelectorAll("button")].filter(b => {
    if (!visible(b)) return false;
    const r = b.getBoundingClientRect();
    return r.height > 0 && r.bottom > vh * 0.82 && r.bottom <= vh + 1 && r.top >= vh * 0.6;
  }).map(rectOf);
  const exit = keys["退出全屏"];
  let exitHit = null;
  if (exit) {
    const el = byLabel("退出全屏");
    const cx = (exit.left + exit.right) / 2, cy = (exit.top + exit.bottom) / 2;
    const hit = document.elementFromPoint(cx, cy);
    exitHit = !!hit && (hit === el || el.contains(hit) || hit.closest("button") === el);
  }
  const overlaps = [];
  const names = Object.keys(keys);
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const a = keys[names[i]], b = keys[names[j]];
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (w > 2 && h > 2) overlaps.push(`${names[i]}×${names[j]}:${Math.round(w)}x${Math.round(h)}`);
  }
  return { vw, vh, scrollWidth: document.documentElement.scrollWidth, keys, bottomButtons, exitHit, overlaps };
};

function assertGeometry(m, label, requireExit = true) {
  assert(m.scrollWidth <= m.vw + 1, `${label}: page horizontal overflow scrollWidth=${m.scrollWidth} vw=${m.vw}`);
  for (const [name, r] of Object.entries(m.keys)) {
    assert(r.left >= -1 && r.right <= m.vw + 1 && r.top >= -1 && r.bottom <= m.vh + 1,
      `${label}: control ${name} out of viewport ${JSON.stringify(r)} vw=${m.vw} vh=${m.vh}`);
    assert(r.width >= 24 && r.height >= 24, `${label}: control ${name} degenerate size ${JSON.stringify(r)}`);
  }
  for (const r of m.bottomButtons) {
    assert(r.left >= -1 && r.right <= m.vw + 1, `${label}: bottom-region button out of viewport ${JSON.stringify(r)} vw=${m.vw}`);
  }
  if (requireExit) {
    assert(m.keys["退出全屏"], `${label}: exit-fullscreen control missing`);
    assert(m.exitHit, `${label}: exit-fullscreen center not hit-testable`);
  } else {
    // 竖屏即全屏呈现：无进入动作即无退出语义，退出钮必须不存在（负断言）
    assert(!m.keys["退出全屏"], `${label}: exit-fullscreen must be absent in portrait presentation`);
  }
  assert.deepEqual(m.overlaps, [], `${label}: key controls overlap: ${m.overlaps.join(", ")}`);
}

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 Version/17.1 Mobile/15E148 Safari/604.1";
const PORTRAIT_VIEWPORTS = [[320, 568], [360, 780], [375, 812], [393, 852], [402, 874], [430, 932]];
const LANDSCAPE_VIEWPORTS = [[844, 390], [852, 393]];

let vite, browser, landServer, portServer, landDir, portDir;
const servers = [];
try {
  landDir = await mkdtemp(join(tmpdir(), "hghubx-layout-land-"));
  portDir = await mkdtemp(join(tmpdir(), "hghubx-layout-port-"));
  generateHlsFixture(landDir, "320x180");
  generateHlsFixture(portDir, "360x640");
  landServer = await serveMedia(landDir); servers.push(landServer);
  portServer = await serveMedia(portDir); servers.push(portServer);
  const landBase = `http://127.0.0.1:${landServer.address().port}`;
  const portBase = `http://127.0.0.1:${portServer.address().port}`;
  vite = await createViteServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, open: false } });
  await vite.listen();
  const ui = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || chromium.executablePath(), args: ["--autoplay-policy=no-user-gesture-required"] });

  async function runCase(name, viewport, proxy, base, expectVideo, portraitSrc = false) {
    const result = { name, viewport, status: "running" };
    report.cases.push(result);
    mediaBase = base;
    const context = await browser.newContext({ userAgent: IPHONE_UA, hasTouch: true, viewport: { width: viewport[0], height: viewport[1] } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await context.route("**/*", route => {
      const raw = route.request().url(), url = new URL(raw), mapped = fixtureMediaUrl(raw);
      if (mapped !== raw) return route.continue({ url: mapped });
      if ([ui, landBase, portBase].includes(url.origin)) return route.continue();
      return route.abort("blockedbyclient");
    });
    try {
      await page.goto(`${ui}/tests/player-seek.html?diagnostics=1&portrait-fit=1&episodes=6&proxy=${encodeURIComponent(proxy)}`);
      await page.waitForFunction(([w, h]) => {
        const v = document.querySelector("video");
        return v && v.videoWidth === w && v.videoHeight === h && v.currentTime > 1 && !v.paused;
      }, expectVideo);
      // Non-fullscreen surface: no horizontal overflow, fullscreen entry visible & inside.
      const home = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, vw: window.innerWidth }));
      assert(home.scrollWidth <= home.vw + 1, `${name}: home overflow ${home.scrollWidth} > ${home.vw}`);
      if (portraitSrc) {
        // ── 竖屏即全屏呈现流程 (Muse 2026-11-18 断言接棒) ──
        // 原竖屏与横屏共用「点全屏钮 → 验退出钮可达」, 保护的是手动进全屏
        // 后的恢复入口。用户裁定竖屏源直接以全屏呈现态播放后, 竖屏不再有
        // 进入动作与退出钮, 该保护点由本流程接棒: ①底栏控件几何 (44px
        // 红线/不出视口/不重叠, PROBE 同一套); ②退出钮负断言 (无进入即
        // 无退出语义); ③单击 (非按钮区) 只翻显隐、底栏可隐可现;
        // ④倍速菜单与选集面板仍在视口内。横屏源维持下方旧流程。
        const tapUpper = async () => {
          const box = await page.evaluate(() => {
            const r = document.querySelector("video").getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height * 0.3 };
          });
          await page.touchscreen.tap(box.x, box.y);
          await page.waitForTimeout(160);
        };
        const rateBtnP = page.getByRole("button", { name: "倍速选择", exact: true });
        await rateBtnP.waitFor({ state: "visible" });
        assert.equal(await page.getByRole("button", { name: "退出全屏", exact: true }).count(), 0,
          `${name}: portrait presentation must not render exit-fullscreen`);
        assertGeometry(await page.evaluate(PROBE, false), `${name} portrait-fs`, false);
        await tapUpper();
        assert(!((await page.evaluate(PROBE, false)).keys["倍速选择"]), `${name}: tap must hide portrait-fs bar`);
        await tapUpper();
        await rateBtnP.waitFor({ state: "visible" });
        await rateBtnP.click();
        const rateMenuP = page.getByRole("menu", { name: "倍速选择", exact: true });
        await rateMenuP.waitFor({ state: "visible" });
        const rmP = await rateMenuP.boundingBox();
        assert(rmP && rmP.x >= -1 && rmP.x + rmP.width <= viewport[0] + 1 && rmP.y >= -1, `${name}: rate menu out of viewport ${JSON.stringify(rmP)}`);
        await rateMenuP.getByRole("menuitemradio", { name: "1x", exact: true }).click();
        // 超分入口负断言 (全自动接棒, 与横屏流程同口径)
        assert.equal(await page.locator('[aria-label^="超分"]').count(), 0, `${name}: SR entry must be gone from playback UI (auto mode)`);
        await page.getByRole("button", { name: "选集", exact: true }).last().click();
        const sheetP = page.locator(".video-details-sheet");
        await sheetP.waitFor({ state: "visible" });
        const sbP = await sheetP.boundingBox();
        assert(sbP && sbP.x >= -1 && sbP.x + sbP.width <= viewport[0] + 1, `${name}: episodes sheet out of viewport ${JSON.stringify(sbP)}`);
        await page.getByRole("button", { name: "关闭", exact: true }).click();
        await sheetP.waitFor({ state: "hidden" });
        result.status = "passed";
        console.log(`PASS ${name}`);
        return;
      }
      // 入口路径接棒 (Muse 2026-11-18): 解耦模型下播放中控件初始可见、
      // 中央大钮在位, tapCenter 实际点中中央钮暂停 (与旧版点手势面等效,
      // 验的仍是全屏入口可达); 进全屏后的几何断言 (出口/菜单/选集面板
      // 位置与可命中) 全部不变。进全屏的 keepAlive 续播会再次隐藏控件,
      // 等其耗尽 (≤1200ms) 后再点中央钮暂停, 让后续探针在控件全显态下进行。
      const tapCenter = async () => {
        const box = await page.evaluate(() => {
          const r = document.querySelector("video").getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        await page.touchscreen.tap(box.x, box.y);
      };
      await tapCenter();
      await page.waitForFunction(() => document.querySelector("video")?.paused === true);
      await page.getByRole("button", { name: "全屏", exact: true }).click();
      await page.waitForTimeout(1400);
      await tapCenter();
      await page.waitForFunction(() => document.querySelector("video")?.paused === true);
      await page.getByRole("button", { name: "退出全屏", exact: true }).waitFor({ state: "visible" });
      await page.waitForTimeout(120);
      assertGeometry(await page.evaluate(PROBE, false), `${name} fs`);
      assertGeometry(await page.evaluate(PROBE, true), `${name} fs worst-time`);
      // Rate menu must stay inside the viewport.
      await page.getByRole("button", { name: "倍速选择", exact: true }).click();
      const rateMenu = page.getByRole("menu", { name: "倍速选择", exact: true });
      await rateMenu.waitFor({ state: "visible" });
      const rm = await rateMenu.boundingBox();
      assert(rm && rm.x >= -1 && rm.x + rm.width <= viewport[0] + 1 && rm.y >= -1, `${name}: rate menu out of viewport ${JSON.stringify(rm)}`);
      await rateMenu.getByRole("menuitemradio", { name: "1x", exact: true }).click();
      // 超分菜单断言接棒 (Muse 2026-11-18): 原断言保护「超分菜单在全屏底栏
      // 可达且不出视口」; 用户裁定超分全自动后, 播放界面的超分入口全部撤下,
      // 「手动可达」改由设置页 自动/关闭 覆盖项接棒 (本门禁是播放面几何门禁,
      // 不覆盖设置页), 本处接棒为负断言: 全屏底栏不得再出现超分入口。
      assert.equal(await page.locator('[aria-label^="超分"]').count(), 0, `${name}: SR entry must be gone from playback UI (auto mode)`);
      // Episodes sheet stays inside the viewport.
      await page.getByRole("button", { name: "选集", exact: true }).last().click();
      const sheet = page.locator(".video-details-sheet");
      await sheet.waitFor({ state: "visible" });
      const sb = await sheet.boundingBox();
      assert(sb && sb.x >= -1 && sb.x + sb.width <= viewport[0] + 1, `${name}: episodes sheet out of viewport ${JSON.stringify(sb)}`);
      await page.getByRole("button", { name: "关闭", exact: true }).click();
      await sheet.waitFor({ state: "hidden" });
      // Exit path works end to end. (接棒同上: 退全屏过渡的 keepAlive 续播可能
      // 把已暂停的视频拉回播放、控件随之隐藏; 等其耗尽后若在播则点中央钮
      // 暂停, 再验「全屏」钮可见——验的仍是出口可达性本身。)
      await page.getByRole("button", { name: "退出全屏", exact: true }).click();
      await page.waitForTimeout(1400);
      if (await page.evaluate(() => !document.querySelector("video")?.paused)) {
        await tapCenter();
        await page.waitForFunction(() => document.querySelector("video")?.paused === true);
      }
      await page.getByRole("button", { name: "全屏", exact: true }).waitFor({ state: "visible" });
      result.status = "passed";
      console.log(`PASS ${name}`);
    } catch (error) {
      result.status = "failed"; result.error = error.message;
      console.error(`FAIL ${name}: ${error.message}`);
      await page.screenshot({ path: join(output, `${name.replace(/[^\w-]+/g, "_")}.png`) }).catch(() => {});
    } finally {
      await context.close();
      await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
    }
  }

  for (const vp of PORTRAIT_VIEWPORTS) await runCase(`portrait-${vp[0]}x${vp[1]}`, vp, portBase, portBase, [360, 640], true);
  await runCase("portrait-393-rotated-source", [393, 852], landBase, landBase, [320, 180]);
  for (const vp of LANDSCAPE_VIEWPORTS) await runCase(`landscape-${vp[0]}x${vp[1]}`, vp, landBase, landBase, [320, 180]);
} catch (error) {
  report.setup_error = error.message;
  console.error(`SETUP FAIL: ${error.message}`);
} finally {
  await browser?.close();
  for (const s of servers) await new Promise(done => s.close(done));
  await vite?.close();
  if (landDir) await rm(landDir, { recursive: true, force: true });
  if (portDir) await rm(portDir, { recursive: true, force: true });
  report.finished = new Date().toISOString();
  report.passed = report.cases.filter(c => c.status === "passed").length;
  report.failed = report.cases.filter(c => c.status !== "passed").length + (report.setup_error ? 1 : 0);
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Layout checks: ${report.passed} passed, ${report.failed} failed. Artifacts: ${output}`);
  process.exitCode = report.failed ? 1 : 0;
}
