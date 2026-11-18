#!/usr/bin/env node
// 关键页面截图基线捕获（Muse 2026-11-19 fix2 B4）：把八个关键视图
// 在固定夹具数据下截图存档，作为后续改版的版式/结构回归对照。
// 不是门禁（不做像素 diff）：产物 = PNG + manifest（视口/字节数），
// 存 test-results/baselines/<时间戳>/，由维护者目检或与上批对照。
// 播放器三态（控制层/横屏/选集弹层）走 player-seek 真实夹具 + 本地
// HLS 媒体（与 test-layout 同法）；内容四页走 tests/baselines 夹具。
import { execFileSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const output = join(root, "test-results", "baselines", stamp);
await mkdir(output, { recursive: true });
const manifest = { captured: stamp, transport: "browser fixture; not Tauri/WKWebView", shots: [] };

const generateHlsFixture = (dir, size) => execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=15`, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "90", "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod", "-hls_segment_filename", join(dir, "seg%03d.ts"), join(dir, "list.m3u8")], { timeout: 60000, stdio: "pipe" });

async function serveMedia(dir) {
  const manifestText = await readFile(join(dir, "list.m3u8"), "utf8");
  const server = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      let body, kind;
      if (url.pathname === "/hls") {
        body = Buffer.from(manifestText.split("\n").map(line => !line || line.startsWith("#") ? line :
          `http://hg.localhost/seg?u=${encodeURIComponent(`https://media.fixture.invalid/${line.trim()}`)}`).join("\n"));
        kind = "application/vnd.apple.mpegurl";
      } else if (url.pathname === "/seg") {
        const fragment = basename(new URL(url.searchParams.get("u")).pathname);
        body = await readFile(join(dir, fragment)); kind = "video/mp2t";
      } else { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": kind, "Content-Length": body.length, "Access-Control-Allow-Origin": "*" });
      res.end(body);
    } catch { res.writeHead(404); res.end("fixture error"); }
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  return server;
}

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 Version/17.1 Mobile/15E148 Safari/604.1";
let vite, browser;
const servers = [];
try {
  const portDir = await mkdtemp(join(tmpdir(), "hghubx-base-port-"));
  const landDir = await mkdtemp(join(tmpdir(), "hghubx-base-land-"));
  generateHlsFixture(portDir, "360x640");
  generateHlsFixture(landDir, "320x180");
  const portServer = await serveMedia(portDir); servers.push(portServer);
  const landServer = await serveMedia(landDir); servers.push(landServer);
  const portBase = `http://127.0.0.1:${portServer.address().port}`;
  const landBase = `http://127.0.0.1:${landServer.address().port}`;

  vite = await createViteServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, open: false } });
  await vite.listen();
  const ui = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || chromium.executablePath(), args: ["--autoplay-policy=no-user-gesture-required"] });

  const shot = async (page, name, viewport) => {
    const file = join(output, `${name}.png`);
    await page.screenshot({ path: file });
    const { size } = await import("node:fs").then(m => m.promises.stat(file));
    manifest.shots.push({ name, viewport, file: `test-results/baselines/${stamp}/${name}.png`, bytes: size });
    console.log(`shot ${name} (${size} bytes)`);
  };

  /* ── 内容四页（baselines 夹具） ── */
  const contentViews = [
    ["posts-list", "posts", "基线帖子标题"],
    ["post-detail", "post", "基线正文段落"],
    ["channel-detail", "channel", "基线短剧"],
    ["settings", "settings", "设置"],
  ];
  for (const [name, view, marker] of contentViews) {
    const context = await browser.newContext({ userAgent: IPHONE_UA, hasTouch: true, viewport: { width: 393, height: 852 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === ui) return route.continue();
      return route.abort("blockedbyclient");
    });
    await page.goto(`${ui}/tests/baselines.html?view=${view}`);
    await page.getByText(marker, { exact: false }).first().waitFor({ state: "visible", timeout: 15000 });
    await page.waitForTimeout(700);
    await shot(page, name, "393x852");
    await context.close();
  }

  /* ── 播放器三态（player-seek 真实夹具） ── */
  const openPlayer = async (viewport, base) => {
    const context = await browser.newContext({ userAgent: IPHONE_UA, hasTouch: true, viewport });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    await page.addInitScript(() => {
      try { localStorage.setItem("hghubx_app_v1", JSON.stringify({ fsIdleSecs: 0 })); } catch { /* ignore */ }
    });
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === ui || url.origin === base) return route.continue();
      if (url.hostname === "hg.localhost") return route.continue({ url: `${base}${url.pathname}${url.search}` });
      return route.abort("blockedbyclient");
    });
    await page.goto(`${ui}/tests/player-seek.html?diagnostics=1&portrait-fit=1&episodes=6&proxy=${encodeURIComponent(base)}`);
    await page.waitForFunction(() => {
      const v = document.querySelector("video");
      return v && v.videoWidth > 0 && v.currentTime > 1 && !v.paused;
    }, null, { timeout: 20000 });
    return { context, page };
  };

  /* 唤醒控制层：点画面中央一次（与 test-layout 同序——控制层默认
   * 沉浸隐藏，全屏/选集钮须先唤醒才可点）。 */
  const wakeAndFullscreen = async (page) => {
    const box = await page.evaluate(() => {
      const r = document.querySelector("video").getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.touchscreen.tap(box.x, box.y);
    const fsBtn = page.getByRole("button", { name: "全屏", exact: true });
    await fsBtn.waitFor({ state: "visible", timeout: 8000 });
    await fsBtn.click();
    await page.waitForTimeout(1400);
  };
  {
    const { context, page } = await openPlayer({ width: 393, height: 852 }, portBase);
    await page.waitForTimeout(600);
    await shot(page, "player-controls", "393x852");
    try {
      await wakeAndFullscreen(page);
      await page.getByRole("button", { name: "选集", exact: true }).last().click({ timeout: 8000 });
      await page.locator(".video-details-sheet, [role='dialog']").first().waitFor({ state: "visible", timeout: 8000 });
      await page.waitForTimeout(500);
      await shot(page, "player-episodes-sheet", "393x852");
    } catch (e) {
      manifest.shots.push({ name: "player-episodes-sheet", error: String(e).slice(0, 200) });
      console.log(`shot player-episodes-sheet FAILED: ${String(e).slice(0, 120)}`);
    }
    await context.close();
  }
  {
    const { context, page } = await openPlayer({ width: 852, height: 393 }, landBase);
    try { await wakeAndFullscreen(page); } catch { /* 保持当前态截图 */ }
    await page.waitForTimeout(500);
    await shot(page, "player-landscape", "852x393");
    await context.close();
  }

  await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`baselines: ${manifest.shots.length} shots -> ${output}`);
} finally {
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
  for (const s of servers) s.close();
}
