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
  for (const name of ["返回", "选集", "倍速选择", "静音", "取消静音", "收藏", "搜索", "全屏", "退出全屏"]) {
    const el = byLabel(name);
    if (el && visible(el)) keys[name] = rectOf(el);
  }
  // 右栏负断言探针 (缺陷1 接棒, Muse 2026-11-18): 右栏覆层已整体撤销,
  // 保护点由「右栏不压信息行」改为「右栏不存在 + 信息行右端 (时间文本)
  // 命中测试落在信息行自身」——原断言保护的信息行可读性由这两条接棒。
  const railEl = document.querySelector(".mobile-video-action-rail");
  const railPresent = !!railEl && visible(railEl);
  let infoHitRight = null;
  const chromes = [...document.querySelectorAll(".hg-chrome-in")];
  const bottomChrome = chromes[chromes.length - 1];
  const infoRow = bottomChrome?.querySelector(":scope > div");
  if (infoRow && visible(infoRow)) {
    const r = infoRow.getBoundingClientRect();
    const hit = document.elementFromPoint(r.right - 10, (r.top + r.bottom) / 2);
    infoHitRight = !!hit && bottomChrome.contains(hit);
  }
  const sr = [...document.querySelectorAll("button")].find(b => (b.getAttribute("aria-label") || "").startsWith("超分"));
  if (sr && visible(sr)) keys["超分选择"] = rectOf(sr);
  const bottomButtons = [...document.querySelectorAll("button")].filter(b => {
    if (!visible(b)) return false;
    const r = b.getBoundingClientRect();
    return r.height > 0 && r.bottom > vh * 0.82 && r.bottom <= vh + 1 && r.top >= vh * 0.6;
  }).map(rectOf);
  const exit = keys["返回"];
  let exitHit = null;
  if (exit) {
    const el = byLabel("返回");
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
  return { vw, vh, scrollWidth: document.documentElement.scrollWidth, keys, bottomButtons, exitHit, overlaps, exitFsPresent: !!byLabel("退出全屏"), railPresent, infoHitRight };
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
    // 出口接棒 (蓝图 P1): 独立退出钮已并入顶栏「返回」(全屏时先退全屏),
    // 保护点仍是恢复入口在位且可命中
    assert(m.keys["返回"], `${label}: exit (top-bar back) control missing`);
    assert(m.exitHit, `${label}: exit (top-bar back) center not hit-testable`);
  } else {
    // 竖屏即全屏呈现：无进入动作即无退出语义，不得出现独立退出钮（负断言；
    // 顶栏返回是离开播放器、不是退出呈现，不在此限）
    assert(!m.exitFsPresent, `${label}: exit-fullscreen button must be absent in portrait presentation`);
  }
  assert.deepEqual(m.overlaps, [], `${label}: key controls overlap: ${m.overlaps.join(", ")}`);
  // 右栏负断言 (缺陷1 接棒): 视频区不得再有右栏覆层; 信息行在场时其
  // 右端 (时间文本处) 必须可命中信息行自身, 即整行无遮挡。
  assert(!m.railPresent, `${label}: right action rail must not exist (removed by ruling)`);
  if (m.infoHitRight !== null && m.infoHitRight !== undefined) {
    assert(m.infoHitRight, `${label}: info row right end (time text) is covered by another element`);
  }
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

  async function runCase(name, viewport, proxy, base, expectVideo, portraitSrc = false, seedLandPref = false) {
    const result = { name, viewport, status: "running" };
    report.cases.push(result);
    mediaBase = base;
    const context = await browser.newContext({ userAgent: IPHONE_UA, hasTouch: true, viewport: { width: viewport[0], height: viewport[1] } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    // 几何门禁不与自动隐藏计时赛跑: 夹具内把 fsIdleSecs 钉为 0 (自动隐藏
    // 行为本身不在本门禁范围, 由 fsIdle 口径与真机验收覆盖)。
    await page.addInitScript(() => {
      try { localStorage.setItem("hghubx_app_v1", JSON.stringify({ fsIdleSecs: 0 })); } catch { /* ignore */ }
    });
    // 缺陷8 断言种子: 预置旧版横屏偏好键为 landscape——旧实现会据此在
    // 条目激活时自动进横屏全屏, 新实现必须完全忽略该键 (自动旋转已删)。
    if (seedLandPref) {
      await page.addInitScript(() => {
        try { localStorage.setItem("hghub_land_pref", "landscape"); } catch { /* ignore */ }
      });
    }
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
      if (seedLandPref) {
        // A2 断言 (收官批): 横屏提示 LandHint 出现后 3 秒自动消失 (保留
        // ✕ 即时关、只出现一次) ——常驻遮挡是用户真机点名的问题。
        const hint = page.getByRole("button", { name: "关闭横屏提示", exact: true });
        await hint.waitFor({ state: "visible", timeout: 4000 });
        await hint.waitFor({ state: "detached", timeout: 5000 });
        result.landHintAutoDismiss = true;
        // 自动旋转删除断言 (缺陷8 接棒): 旧偏好键在场 + 横屏源已起播
        // 900ms 后, 方向必须仍保持竖屏呈现 (未被自动进横屏全屏),
        // 且控制层全屏钮在位 (唯一入口) ——原 P3 断言保护「记住偏好后
        // 自动进」, 用户真机裁定该行为本身即缺陷, 由本断言反向接棒。
        await page.waitForTimeout(900);
        const rootClass = await page.evaluate(() => document.querySelector(".player-root")?.className || "");
        assert(!/fs-immersive/.test(rootClass), `${name}: legacy landscape preference must not auto-enter fullscreen (auto-rotate removed)`);
      }
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
        // 自动隐藏 (fsIdleSecs=3, 仅播放中) 可能已让底栏进入隐藏态: 先单击
        // 唤出再验几何 (与真实用户路径一致)
        if (!(await rateBtnP.isVisible().catch(() => false))) await tapUpper();
        await rateBtnP.waitFor({ state: "visible" });
        assert.equal(await page.getByRole("button", { name: "退出全屏", exact: true }).count(), 0,
          `${name}: portrait presentation must not render exit-fullscreen`);
        // 全屏钮负断言 (缺陷7 接棒): 竖屏源无横屏全屏语义, 控制层不得
        // 出现全屏钮 (横屏源正断言在下方横屏流程: 在位且热区 ≥44px)。
        assert.equal(await page.getByRole("button", { name: "全屏", exact: true }).count(), 0,
          `${name}: portrait source must not render a fullscreen button`);
        assertGeometry(await page.evaluate(PROBE, false), `${name} portrait-fs`, false);
        await tapUpper();
        // 单击延迟判定 (250ms 窗口) 后才执行显隐: 等底栏真隐藏再探针
        await rateBtnP.waitFor({ state: "hidden" });
        const probeAfterHide = await page.evaluate(PROBE, false);
        const diag = await page.evaluate(() => ({ clean: document.querySelector(".player-root")?.dataset.clean, paused: document.querySelector("video")?.paused }));
        assert(!probeAfterHide.keys["倍速选择"], `${name}: tap must hide portrait-fs bar; keys=${JSON.stringify(Object.keys(probeAfterHide.keys))} diag=${JSON.stringify(diag)}`);
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
        // 抽屉实心底断言 (缺陷6 接棒): 蓝图规格本就是实心 #191B20, P5
        // 初版只覆盖 background、漏摘 backdrop-filter, 真机呈玻璃面板。
        // 本断言保护计算样式终态: 背景恰为 #191B20 且无 backdrop 模糊。
        const dlgStyle = await page.evaluate(() => {
          const d = document.querySelector(".ios-overlay-sheet .ios-dialog");
          if (!d) return null;
          const s = getComputedStyle(d);
          return { bg: s.backgroundColor, bf: s.backdropFilter };
        });
        assert(dlgStyle && dlgStyle.bg === "rgb(25, 27, 32)" && dlgStyle.bf === "none",
          `${name}: player drawer must be solid #191B20 with no backdrop blur, got ${JSON.stringify(dlgStyle)}`);
        await page.getByRole("button", { name: "关闭", exact: true }).click();
        await sheetP.waitFor({ state: "hidden" });
        result.status = "passed";
        console.log(`PASS ${name}`);
        return;
      }
      // 入口路径接棒 (Muse 2026-11-18): 开场默认沉浸 (蓝图 P0) 后播放中
      // 控件初始收起, 首击 tapCenter 只翻显隐呼出控件、全屏钮随之出现——
      // 验的仍是全屏入口可达; 进全屏后的几何断言 (出口/菜单/选集面板
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
      const fsBtn = page.getByRole("button", { name: "全屏", exact: true });
      await fsBtn.waitFor({ state: "visible" });
      // 全屏钮热区断言 (缺陷7; 位置由第11项定版在操作行右端): ≥44px。
      const fsBox = await fsBtn.boundingBox();
      assert(fsBox && fsBox.width >= 44 && fsBox.height >= 44,
        `${name}: fullscreen button hit area must be >= 44px, got ${JSON.stringify(fsBox)}`);
      await fsBtn.click();
      await page.waitForTimeout(1400);
      // 暂停走操作行底部中央钮 (中央大钮已随蓝图 P1 回退, tapCenter 只翻显隐)
      await page.getByRole("button", { name: "暂停", exact: true }).click();
      await page.waitForFunction(() => document.querySelector("video")?.paused === true);
      await page.getByRole("button", { name: "返回", exact: true }).waitFor({ state: "visible" });
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
      // 单入口断言 (Muse 2026-11-18 第11项, 接棒): 原双入口形态保护
      // 「选集/内容两钮各落其页、落点跟随入口」; 用户极简裁定合并后
      // 接棒为: ①操作行无「内容」钮 ②选集钮恒落选集页 ③抽屉内页签
      // 可达 (3.2.2 砍单后只剩选集/详情, 切到详情) ④关后重开仍落选集。
      assert.equal(await page.getByRole("button", { name: "内容", exact: true }).count(), 0,
        `${name}: ops row must not keep a separate 内容 entry (single 选集 entry)`);
      const tabBtn = (n) => sheet.getByRole("button", { name: n, exact: true });
      assert.equal(await tabBtn("选集").getAttribute("aria-pressed"), "true",
        `${name}: 选集 entry must land on the episodes tab`);
      // 3.2.2 砍单适配（评论删除）: 页签只剩选集/详情, 切到详情页签。
      await tabBtn("详情").click();
      await page.waitForFunction(() => document.querySelector('.video-details-sheet button[aria-pressed="true"]')?.textContent?.includes("详情"));
      assert.equal(await tabBtn("评论").count(), 0,
        `${name}: comments tab must be gone (3.2.2 cut list)`);
      // 抽屉文字对比度断言 (2026-11-18, 缺陷6 再接棒): 上方实心底断言只
      // 保护背景——底钉死 #191B20 后文字仍随环境主题变量, 浅色主题下
      // 正文是 #25241f 暗字压深底, 主代理看图 (review-shots/02) 拦下。
      // 原断言保护的「抽屉正文可读」: 评论页签删除后 (3.2.2 砍单) 由详情
      // 页的简介正文接棒: 正文恰为主字色 #F5F5F5、统计行等次级信息不低
      // 于基线 #A1A5AD (逐通道)。
      await page.waitForFunction(() => document.querySelector(".video-details-sheet")?.textContent?.includes("暂无简介"));
      const commentColors = await page.evaluate(() => {
        const sheetEl = document.querySelector(".video-details-sheet");
        const bodyEl = sheetEl?.querySelector(".video-details-description");
        const metaEl = sheetEl?.querySelector(".video-details-stats span");
        const rgbOf = (el) => { const m = /(\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(el).color); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
        return { body: bodyEl ? rgbOf(bodyEl) : null, meta: metaEl ? rgbOf(metaEl) : null };
      });
      assert.deepEqual(commentColors.body, [245, 245, 245],
        `${name}: drawer body must render primary #F5F5F5 on the solid drawer, got ${JSON.stringify(commentColors)}`);
      assert(commentColors.meta && commentColors.meta[0] >= 161 && commentColors.meta[1] >= 165 && commentColors.meta[2] >= 173,
        `${name}: drawer meta text must not fall below #A1A5AD, got ${JSON.stringify(commentColors)}`);
      // A3 断言 (收官批): 抽屉内只留一个关闭钮 (页签行右端) ——原实现
      // 评论页头部还有一个浮动 X, 用户真机点名双 X; 原 `.first()` 取法
      // 保护的是「至少有一个可关」, 由本计数断言接棒为「恰好一个」。
      assert.equal(await sheet.locator('button[aria-label="关闭"]').count(), 1,
        `${name}: drawer must contain exactly one close button (A3)`);
      await sheet.locator('button[aria-label="关闭"]').first().click();
      await sheet.waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "选集", exact: true }).last().click();
      await sheet.waitFor({ state: "visible" });
      assert.equal(await tabBtn("选集").getAttribute("aria-pressed"), "true",
        `${name}: reopening must land on episodes again (no tab memory)`);
      await sheet.locator('button[aria-label="关闭"]').first().click();
      await sheet.waitFor({ state: "hidden" });
      /* ── 收官批 A1/A4/A5/A6/A7 (全屏态) ── */
      {
        // A4/A6/A7: 顶栏无收藏/搜索; 底部信息单行 (剧名+热度同行、时间
        // 右置不被挤压) 且无「第X集」。
        const topLabels = await page.evaluate(() => {
          const tb = document.querySelector('button[aria-label="返回"]')?.closest("div");
          return tb ? [...tb.querySelectorAll("button")].map(b => b.getAttribute("aria-label") || "") : null;
        });
        assert(topLabels && !topLabels.some(l => /收藏|搜索/.test(l)),
          `${name}: A4 fullscreen topbar must not contain fav/search, got ${JSON.stringify(topLabels)}`);
        const info = await page.evaluate(() => {
          const bar = [...document.querySelectorAll("div")].find(d => d.classList.contains("hg-chrome-in") && d.classList.contains("bottom-0"));
          if (!bar) return null;
          const spans = [...bar.querySelectorAll("span")];
          const title = bar.querySelector(".truncate");
          const time = spans.find(s => /^\d+:\d{2}\s*\/\s*\d+:\d{2}$/.test((s.textContent || "").trim()));
          const heat = spans.find(s => (s.textContent || "").includes("赞"));
          const tr = title?.getBoundingClientRect(), hr = heat?.getBoundingClientRect(), mr = time?.getBoundingClientRect();
          const rotated = !!document.querySelector(".player-root.fs-landscape");
          const cx = r => (r.left + r.right) / 2, cy = r => (r.top + r.bottom) / 2;
          return {
            hasEpText: /第\s*\d+\s*集/.test(bar.textContent || ""),
            all: !!(title && heat && time),
            // 旋转呈现 (fs-landscape) 下该行沿页面纵轴排布, 比对轴随之换向
            sameRow: !!(tr && mr && Math.abs((rotated ? cx(tr) - cx(mr) : cy(tr) - cy(mr))) < 5),
            heatSameRow: !!(tr && hr && Math.abs((rotated ? cx(hr) - cx(tr) : cy(hr) - cy(tr))) < 5),
            noOverlap: !!(tr && mr && (rotated ? tr.bottom <= mr.top + 1 : tr.right <= mr.left + 1)),
          };
        });
        assert(info && !info.hasEpText, `${name}: A6 fullscreen bottom must not repeat 第X集`);
        assert(info && info.all && info.sameRow && info.heatSameRow && info.noOverlap,
          `${name}: A7 info must be one row (title+heat left, time right, no overlap), got ${JSON.stringify(info)}`);
        // A1: 单击进度条不 seek, 拖动才 seek (拖动中预览、松手落点)。
        // Feed 进度条是 barRef div (touchAction:none + pointer 手势), 无 role。
        const barRect = () => page.evaluate(() => {
          // 全屏态 stage 本身也是 touchAction:none 的 inset-0 div 且在 DOM
          // 序靠前, 裸 find 会误中 stage (点→翻 clean、拖→舞台手势); 按
          // 细条几何锁定真正的进度条 div。上限 36: 最终版 B2 线把 scrub
          // 热区按用户实报扩到 28px (视觉轨道仍 2.5px), 旧上限 24 系旧
          // 22px 热区口径; 36 仍远小于 stage 尺寸, 判别力不变。
          const el = [...document.querySelectorAll("div")].find(d => {
            if (d.style.touchAction !== "none") return false;
            const r = d.getBoundingClientRect();
            return (r.height >= 4 && r.height <= 36 && r.width > 80) || (r.width >= 4 && r.width <= 36 && r.height > 80);
          });
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        });
        const sbb = await barRect();
        assert(sbb, `${name}: A1 progress bar missing`);
        // 旋转呈现下进度条沿页面纵轴, 拖动方向随之换向 (stageXY 同口径)。
        const rotatedBar = await page.evaluate(() => !!document.querySelector(".player-root.fs-landscape"));
        const pt = f => rotatedBar
          ? { x: sbb.x + sbb.width / 2, y: sbb.y + sbb.height * f }
          : { x: sbb.x + sbb.width * f, y: sbb.y + sbb.height / 2 };
        const t0 = await page.evaluate(() => document.querySelector("video").currentTime);
        await page.mouse.click(pt(0.1).x, pt(0.1).y);
        await page.waitForTimeout(400);
        const t1 = await page.evaluate(() => document.querySelector("video").currentTime);
        assert(Math.abs(t1 - t0) < 0.5, `${name}: A1 tap on progress bar must not seek (${t0} -> ${t1})`);
        await page.mouse.move(pt(0.1).x, pt(0.1).y);
        await page.mouse.down();
        await page.mouse.move(pt(0.55).x, pt(0.55).y, { steps: 12 });
        await page.mouse.up();
        await page.waitForTimeout(300);
        const dragState = await page.evaluate(() => { const v = document.querySelector("video"); return { t: v.currentTime, dur: v.duration }; });
        assert(Math.abs(dragState.t - dragState.dur * 0.55) < 2.5 && dragState.t - t1 > 2,
          `${name}: A1 drag must seek to drop point, got t=${dragState.t} dur=${dragState.dur}`);
        // A5: 播放中单击隐藏 → 画面零覆层 (无进度条/无时间/无顶栏);
        // 竖屏细线保留不在本断言范围 (信息流态另测)。
        await page.getByRole("button", { name: "播放", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("video")?.paused === false);
        await tapCenter();
        await page.waitForTimeout(500);
        const overlay = await page.evaluate(() => {
          const r = document.querySelector(".player-root");
          return {
            slider: !![...r.querySelectorAll("div")].find(d => { if (d.style.touchAction !== "none") return false; const b = d.getBoundingClientRect(); return (b.height >= 4 && b.height <= 24 && b.width > 80) || (b.width >= 4 && b.width <= 24 && b.height > 80); }),
            topbar: !!r.querySelector('button[aria-label="返回"]'),
            time: [...r.querySelectorAll("span,div")].some(el => /^\d+:\d{2}\s*\/\s*\d+:\d{2}$/.test((el.textContent || "").trim())),
          };
        });
        assert(!overlay.slider && !overlay.topbar && !overlay.time,
          `${name}: A5 fullscreen hidden state must have zero overlay, got ${JSON.stringify(overlay)}`);
        await tapCenter();
        await page.waitForTimeout(500);
        assert(await barRect(), `${name}: A5 tap must restore the chrome (progress bar back)`);
      }
      // Exit path works end to end. (接棒同上: 退全屏过渡的 keepAlive 续播可能
      // 把已暂停的视频拉回播放、控件随之隐藏; 等其耗尽后若在播则点操作行
      // 暂停钮, 再验「全屏」钮可见——验的仍是出口可达性本身。出口本体已
      // 由独立退出钮接棒为顶栏「返回」, 见 assertGeometry 的出口断言。)
      await page.getByRole("button", { name: "返回", exact: true }).click();
      await page.waitForTimeout(1400);
      if (await page.evaluate(() => !document.querySelector("video")?.paused)) {
        await page.getByRole("button", { name: "暂停", exact: true }).click();
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

  /* ── 图集查看器布局 (Muse 2026-11-19 3.2.1修复F6线) ──
   * 用户实报 CosplayTele 图集图片太小: 两层顶栏+上下张按钮行+常驻
   * 缩略图条把照片挤在写死 4/5 盒子里。本场景保护新形态:
   * ①源码层: SourceGallery/Search 两个查看器不得再有写死 4/5 盒子;
   * ②几何层: 查看态舞台占可用区 ≥98% 宽高 (占屏比下限);
   * ③悬浮层: 计数/返回/关闭/缩略图条都在悬浮层内, 静止自动淡出、
   *    中央点按呼出/收起、左右两侧点按翻页、横滑翻页、缩略图跳张、
   *    上一张/下一张大按钮行不存在。LAYOUT_ONLY=gallery 只跑本场景。 */
  async function runGalleryCase(viewport) {
    const name = `gallery-${viewport[0]}x${viewport[1]}`;
    const result = { name, viewport, status: "running" };
    report.cases.push(result);
    const context = await browser.newContext({ userAgent: IPHONE_UA, hasTouch: true, viewport: { width: viewport[0], height: viewport[1] } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === ui) return route.continue();
      return route.abort("blockedbyclient");
    });
    try {
      for (const rel of ["src/features/sources/SourceGallery.tsx", "src/features/search/Search.tsx"]) {
        const src = await readFile(join(root, rel), "utf8");
        assert(!src.includes('aspectRatio: "4 / 5"'), `${name}: ${rel} must not keep the fixed 4/5 image box`);
      }
      await page.goto(`${ui}/tests/gallery-viewer.html`);
      const stage = page.locator('[data-ui="album-viewer-stage"]');
      await stage.waitFor({ state: "visible" });
      const geo = await page.evaluate(() => {
        const avail = document.querySelector('[data-ui="fixture-avail"]').getBoundingClientRect();
        const st = document.querySelector('[data-ui="album-viewer-stage"]').getBoundingClientRect();
        return { avail: { width: avail.width, height: avail.height }, stage: { width: st.width, height: st.height } };
      });
      assert(geo.stage.width >= geo.avail.width * 0.98, `${name}: stage width ${geo.stage.width} < 98% of available ${geo.avail.width}`);
      assert(geo.stage.height >= geo.avail.height * 0.98, `${name}: stage height ${geo.stage.height} < 98% of available ${geo.avail.height}`);
      result.stageFill = { w: +(geo.stage.width / geo.avail.width).toFixed(3), h: +(geo.stage.height / geo.avail.height).toFixed(3) };
      assert.equal(await page.getByRole("button", { name: "上一张", exact: true }).count(), 0, `${name}: prev button row must be gone`);
      assert.equal(await page.getByRole("button", { name: "下一张", exact: true }).count(), 0, `${name}: next button row must be gone`);
      const countText = async () => page.evaluate(() => document.querySelector('[data-ui="album-viewer-count"]')?.textContent?.trim() || "");
      const chromeOpacity = async () => page.evaluate(() => {
        const el = document.querySelector('[data-album-chrome="top"]');
        return el ? Number(getComputedStyle(el).opacity) : -1;
      });
      assert.equal(await countText(), "1 / 3", `${name}: count must start at 1 / 3`);
      assert(await chromeOpacity() > 0.9, `${name}: chrome must start visible`);
      // 静止自动淡出 (3s 口径, 留余量)
      await page.waitForTimeout(3600);
      assert(await chromeOpacity() < 0.05, `${name}: chrome must auto-fade when idle`);
      const stageBox = await stage.boundingBox();
      assert(stageBox, `${name}: stage box missing`);
      const tapAt = async (fx, fy) => { await page.touchscreen.tap(stageBox.x + stageBox.width * fx, stageBox.y + stageBox.height * fy); await page.waitForTimeout(200); };
      await tapAt(0.5, 0.5); // 中央点按呼出
      assert(await chromeOpacity() > 0.9, `${name}: center tap must reveal chrome`);
      await tapAt(0.88, 0.5); // 右侧点按翻页
      assert.equal(await countText(), "2 / 3", `${name}: right-zone tap must go next`);
      await tapAt(0.12, 0.5); // 左侧点按翻页
      assert.equal(await countText(), "1 / 3", `${name}: left-zone tap must go prev`);
      // 横滑翻页: 舞台上合成 touchstart→touchend (dx=-80)
      await page.evaluate(() => {
        const el = document.querySelector('[data-ui="album-viewer-stage"]');
        const r = el.getBoundingClientRect();
        const mk = (type, x) => {
          const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: r.top + r.height / 2 });
          el.dispatchEvent(new TouchEvent(type, { touches: type === "touchend" ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }));
        };
        mk("touchstart", r.left + r.width * 0.7); mk("touchend", r.left + r.width * 0.7 - 80);
      });
      await page.waitForTimeout(200);
      assert.equal(await countText(), "2 / 3", `${name}: swipe left must go next`);
      // 缩略图条随悬浮层呼出才在场, 点选跳张 + 当前张高亮
      // (横滑翻页已 setChrome(true) 呼出悬浮层, 此处不再点中央——
      // 中央点按是显隐开关, 再点会把悬浮层关掉)
      const thumb3 = page.getByRole("button", { name: "第 3 张", exact: true });
      await thumb3.waitFor({ state: "visible" });
      await thumb3.click();
      await page.waitForTimeout(200);
      assert.equal(await countText(), "3 / 3", `${name}: thumbnail tap must jump to 3 / 3`);
      assert.equal(await thumb3.getAttribute("aria-pressed"), "true", `${name}: current thumbnail must be pressed/highlighted`);
      // 返回列表经悬浮层返回钮
      await page.getByRole("button", { name: "返回相册列表", exact: true }).click();
      await page.locator('[data-ui="fixture-closed"]').waitFor({ state: "visible" });
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

  /* ── 图集缩略图条手势 (Muse 2026-11-19 fix322/gallery 线) ──
   * 真机实报: 146 张图集里底部缩略图条划不动、定不了位。根因在
   * 手势归属: 舞台 touchstart/touchend 不区分触摸起点, 悬浮层只拦了
   * click 没拦 touch——条上横拖松手被舞台当横滑翻页, idx 一变跟随
   * 滚动又把条强行拉回当前张居中, 用户永远停不住条。不变量:
   * ①条上横拖 (合成事件冒泡, 与既有舞台横滑同口径) 只滚条不翻页
   *   ——旧码在此红 (计数被翻到 2/146);
   * ②真实触摸快划条可大位移滚动且计数不变 (快速定位能力);
   * ③点尾部缩略图跳张+高亮; ④主图翻页后当前张缩略图在条内可见。 */
  async function runGalleryStripCase() {
    const name = "gallery-strip-146";
    const result = { name, viewport: [393, 852], status: "running" };
    report.cases.push(result);
    const context = await browser.newContext({ userAgent: IPHONE_UA, hasTouch: true, viewport: { width: 393, height: 852 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === ui) return route.continue();
      return route.abort("blockedbyclient");
    });
    try {
      await page.goto(`${ui}/tests/gallery-viewer.html?n=146`);
      const stage = page.locator('[data-ui="album-viewer-stage"]');
      await stage.waitFor({ state: "visible" });
      const strip = page.getByRole("group", { name: "相册图片缩略图", exact: true });
      await strip.waitFor({ state: "visible" });
      const countText = async () => page.evaluate(() => document.querySelector('[data-ui="album-viewer-count"]')?.textContent?.trim() || "");
      const chromeOpacity = async () => page.evaluate(() => {
        const el = document.querySelector('[data-album-chrome="top"]');
        return el ? Number(getComputedStyle(el).opacity) : -1;
      });
      const ensureChrome = async () => {
        if (await chromeOpacity() > 0.5) return;
        const box = await stage.boundingBox();
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(250);
      };
      assert.equal(await countText(), "1 / 146", `${name}: count must start at 1 / 146`);
      // ① 条上横拖: 合成 touchstart/touchend 派发在条元素上 (冒泡),
      //    舞台不得把起源于悬浮层的触摸认成横滑翻页。
      await ensureChrome();
      await page.evaluate(() => {
        const el = document.querySelector('[data-album-chrome="bottom"] .scroll-x');
        const r = el.getBoundingClientRect();
        const y = r.top + r.height / 2;
        const mk = (type, x) => {
          const t = new Touch({ identifier: 7, target: el, clientX: x, clientY: y });
          el.dispatchEvent(new TouchEvent(type, { touches: type === "touchend" ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }));
        };
        mk("touchstart", r.left + r.width * 0.8);
        mk("touchend", r.left + r.width * 0.8 - 120);
      });
      await page.waitForTimeout(200);
      assert.equal(await countText(), "1 / 146", `${name}: strip drag must not flip the page`);
      // ② 真实触摸快划: 条大位移滚动 (可快速掠过几十张), 计数不变。
      await ensureChrome();
      const stripBox = await strip.boundingBox();
      assert(stripBox, `${name}: strip box missing`);
      const cdp = await context.newCDPSession(page);
      const midY = stripBox.y + stripBox.height / 2;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: stripBox.x + stripBox.width * 0.85, y: midY, id: 1 }] });
      for (let i = 1; i <= 4; i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: stripBox.x + stripBox.width * (0.85 - 0.7 * i / 4), y: midY, id: 1 }] });
        await page.waitForTimeout(16);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(700);
      const scrolled = await strip.evaluate(el => el.scrollLeft);
      assert(scrolled > 120, `${name}: strip flick must scroll far, scrollLeft=${scrolled}`);
      assert.equal(await countText(), "1 / 146", `${name}: strip flick must not flip the page`);
      result.stripScrollLeft = Math.round(scrolled);
      // ③ 条滚到尾部后点最后一张: 跳张+高亮。
      await strip.evaluate(el => { el.scrollLeft = el.scrollWidth; });
      await page.waitForTimeout(250);
      const thumbLast = page.getByRole("button", { name: "第 146 张", exact: true });
      await thumbLast.click();
      await page.waitForTimeout(250);
      assert.equal(await countText(), "146 / 146", `${name}: last thumbnail tap must jump to 146 / 146`);
      assert.equal(await thumbLast.getAttribute("aria-pressed"), "true", `${name}: last thumbnail must be highlighted`);
      // ④ 回跳第 100 张后舞台横滑翻页: 当前张 (101) 缩略图须在条内可见且高亮。
      await page.getByRole("button", { name: "第 100 张", exact: true }).click();
      await page.waitForTimeout(250);
      assert.equal(await countText(), "100 / 146", `${name}: thumbnail tap must jump to 100 / 146`);
      await page.evaluate(() => {
        const el = document.querySelector('[data-ui="album-viewer-stage"]');
        const r = el.getBoundingClientRect();
        const mk = (type, x) => {
          const t = new Touch({ identifier: 3, target: el, clientX: x, clientY: r.top + r.height / 2 });
          el.dispatchEvent(new TouchEvent(type, { touches: type === "touchend" ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }));
        };
        mk("touchstart", r.left + r.width * 0.7);
        mk("touchend", r.left + r.width * 0.7 - 80);
      });
      await page.waitForTimeout(350);
      assert.equal(await countText(), "101 / 146", `${name}: stage swipe must still flip one page`);
      const follow = await page.evaluate(() => {
        const stripEl = document.querySelector('[data-album-chrome="bottom"] .scroll-x');
        const thumb = stripEl.querySelector('[data-thumb-index="100"]');
        const sr = stripEl.getBoundingClientRect();
        const tr = thumb.getBoundingClientRect();
        return { inside: tr.left >= sr.left - 1 && tr.right <= sr.right + 1, pressed: thumb.getAttribute("aria-pressed") };
      });
      assert(follow.inside, `${name}: current thumbnail must stay visible in strip after page turn`);
      assert.equal(follow.pressed, "true", `${name}: current thumbnail must be highlighted after page turn`);
      // ⑤ 条上持续活动须推迟 chrome 淡出（fix330/ui-fixes）：在条上
      //    反复派发 touchmove/scroll 跨越原 3s 闲置窗，chrome 仍须
      //    可见；停手后恢复淡出。旧码淡出计时只挂呼出/切张——条上
      //    划找图满 3s 整层在指下淡出，本段在此红。
      await ensureChrome();
      const pokeUntil = Date.now() + 3600;
      while (Date.now() < pokeUntil) {
        await page.evaluate(() => {
          const el = document.querySelector('[data-album-chrome="bottom"] .scroll-x');
          const r = el.getBoundingClientRect();
          const t = new Touch({ identifier: 9, target: el, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
          el.dispatchEvent(new TouchEvent("touchmove", { touches: [t], changedTouches: [t], bubbles: true, cancelable: true }));
          el.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        await page.waitForTimeout(800);
      }
      assert(await chromeOpacity() > 0.5, `${name}: strip activity must keep chrome visible past the idle window`);
      await page.waitForTimeout(3600);
      assert(await chromeOpacity() < 0.5, `${name}: chrome must fade again after activity stops`);
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

  /* ── 图集快速滑动不消失（Muse 2026-11-19 fix330/ui-fixes）──
   * 真机实报「图片预览滑的快了会直接消失隐藏」的主图一半：慢图
   * 源（请求 900ms 才返回）下快速连翻，窗口化舞台须保证当前帧
   * 与两侧邻帧始终已挂载、邻图在被翻到前已发出请求预取。旧单
   * Img 逐张重挂没有任何帧元素、首断言即红。 */
  async function runGalleryFastSwipeCase() {
    const name = "gallery-fast-swipe";
    const result = { name, viewport: [393, 852], status: "running" };
    report.cases.push(result);
    const context = await browser.newContext({ userAgent: IPHONE_UA, hasTouch: true, viewport: { width: 393, height: 852 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const PNG1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const requested = [];
    page.on("request", (req) => { try { requested.push(decodeURIComponent(req.url())); } catch { requested.push(req.url()); } });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === ui) return route.continue();
      await new Promise((r) => setTimeout(r, 900));
      return route.fulfill({ status: 200, contentType: "image/png", body: PNG1 });
    });
    try {
      await page.goto(`${ui}/tests/gallery-viewer.html?n=146`);
      const stage = page.locator('[data-ui="album-viewer-stage"]');
      await stage.waitFor({ state: "visible" });
      const frames = async () => page.evaluate(() => [...document.querySelectorAll("[data-album-frame]")].map((el) => Number(el.getAttribute("data-album-frame"))).sort((a, b) => a - b));
      await page.waitForTimeout(300);
      assert.deepEqual(await frames(), [0, 1], `${name}: initial window must mount current+next frame`);
      assert(requested.some((u) => u.includes("album/2.jpg")), `${name}: next image must be requested (prefetch) before it is shown`);
      const swipe = async () => page.evaluate(() => {
        const el = document.querySelector('[data-ui="album-viewer-stage"]');
        const r = el.getBoundingClientRect();
        const mk = (type, x) => {
          const t = new Touch({ identifier: 5, target: el, clientX: x, clientY: r.top + r.height / 2 });
          el.dispatchEvent(new TouchEvent(type, { touches: type === "touchend" ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }));
        };
        mk("touchstart", r.left + r.width * 0.7);
        mk("touchend", r.left + r.width * 0.7 - 80);
      });
      for (let i = 0; i < 6; i++) { await swipe(); await page.waitForTimeout(60); }
      const countText = await page.evaluate(() => document.querySelector('[data-ui="album-viewer-count"]')?.textContent?.trim() || "");
      assert.equal(countText, "7 / 146", `${name}: fast swipes must land on 7 / 146, got ${countText}`);
      assert.deepEqual(await frames(), [5, 6, 7], `${name}: window at landing index must mount prev+current+next frames`);
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

  /* ── 图集全屏 chrome 安全区（Muse 2026-11-19 fix330/gallery-viewer）──
   * 真机实报：fixed 全屏查看器顶栏（返回/标题/计数/关闭）与 iOS 状态
   * 栏同带重叠、底部条压手势区。根因：AlbumViewer chrome 只有写死
   * 12px 内边距、全仓独此一处沉浸层不吃安全区变量。夹具 immersive
   * 模式注入 --sat 47 / --sab 34（刘海机型量级），断言：①返回/关闭
   * 钮顶缘 ≥ 47（不得侵入状态栏带）；②缩略图条底缘 ≤ 视口高-34
   * （不得侵入手势区）。旧码两断言皆红（顶 12 / 条底 840>818）。 */
  async function runGallerySafeAreaCase() {
    const name = "gallery-safe-area";
    const result = { name, viewport: [393, 852], status: "running" };
    report.cases.push(result);
    const context = await browser.newContext({ userAgent: IPHONE_UA, hasTouch: true, viewport: { width: 393, height: 852 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === ui) return route.continue();
      return route.abort("blockedbyclient");
    });
    try {
      await page.goto(`${ui}/tests/gallery-viewer.html?immersive=1&n=3`);
      const stage = page.locator('[data-ui="album-viewer-stage"]');
      await stage.waitFor({ state: "visible" });
      const backBox = await page.getByRole("button", { name: "返回相册列表", exact: true }).boundingBox();
      const closeBox = await page.getByRole("button", { name: "关闭大图", exact: true }).boundingBox();
      assert(backBox && closeBox, `${name}: chrome buttons must exist`);
      result.backTop = Math.round(backBox.y); result.closeTop = Math.round(closeBox.y);
      assert(backBox.y >= 47, `${name}: back button top ${backBox.y} must be >= safe-area top 47 (status bar overlap)`);
      assert(closeBox.y >= 47, `${name}: close button top ${closeBox.y} must be >= safe-area top 47 (status bar overlap)`);
      const stripBox = await page.getByRole("group", { name: "相册图片缩略图", exact: true }).boundingBox();
      assert(stripBox, `${name}: strip must exist`);
      result.stripBottom = Math.round(stripBox.y + stripBox.height);
      assert(stripBox.y + stripBox.height <= 852 - 34 + 1,
        `${name}: strip bottom ${stripBox.y + stripBox.height} must be <= ${852 - 34} (home-indicator overlap)`);
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

  /* ── 图集缩略图随可见性加载（Muse 2026-11-19 fix330/gallery-viewer）──
   * 真机实报：126 张图集底部缩略图条除当前张外全是 HG 失败占位。
   * 根因：全量 lazy 挂载下浏览器取图窗口（条滚动口）与 Img attempt
   * 时钟窗口（主视口 IO）脱节、attempt 烧光终局锁死。修复形态＝条
   * 本体 root 的 IO 闩锁：进窗才挂 Img。断言：①打开后条内 <img>
   * 数有界（窗口量级 ≤40；旧码全量 126 红）；②远端索引（≥115）
   * 不发请求；③可视缩略图真实出图（naturalWidth>0、无失败占位）；
   * ④条滚到尾后尾部缩略图才挂图并出图、请求集合随之扩展，挂图
   * 总数仍有界（≤60）。图源统一 200ms 延迟 fulfill 1x1 PNG。 */
  async function runGalleryStripLoadCase() {
    const name = "gallery-strip-load";
    const result = { name, viewport: [393, 852], status: "running" };
    report.cases.push(result);
    const context = await browser.newContext({ userAgent: IPHONE_UA, hasTouch: true, viewport: { width: 393, height: 852 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const PNG1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const requested = new Set();
    page.on("request", (req) => {
      try {
        const inner = new URL(req.url()).searchParams.get("u") || "";
        const m = /album\/(\d+)\.jpg/.exec(inner);
        if (m) requested.add(Number(m[1]) - 1);
      } catch { /* ignore */ }
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === ui) return route.continue();
      await new Promise((r) => setTimeout(r, 200));
      return route.fulfill({ status: 200, contentType: "image/png", body: PNG1 });
    });
    const stripState = async () => page.evaluate(() => {
      const strip = document.querySelector('[data-album-chrome="bottom"] .scroll-x');
      const sr = strip.getBoundingClientRect();
      const thumbs = [...strip.querySelectorAll("[data-thumb-index]")].map((el) => {
        const r = el.getBoundingClientRect();
        const img = el.querySelector("img");
        return {
          i: Number(el.getAttribute("data-thumb-index")),
          inView: r.right > sr.left && r.left < sr.right,
          hasImg: !!img,
          loaded: !!img && img.complete && img.naturalWidth > 0,
          err: !!el.querySelector(".ios-image-error"),
        };
      });
      return { imgCount: thumbs.filter((t) => t.hasImg).length, thumbs };
    });
    try {
      await page.goto(`${ui}/tests/gallery-viewer.html?n=126`);
      await page.locator('[data-ui="album-viewer-stage"]').waitFor({ state: "visible" });
      await page.waitForTimeout(1500);
      const s1 = await stripState();
      result.initialImgCount = s1.imgCount;
      assert(s1.imgCount >= 5 && s1.imgCount <= 40,
        `${name}: mounted thumbnail <img> count ${s1.imgCount} must be a bounded window (5..40), not all 126`);
      assert(![...requested].some((i) => i >= 115),
        `${name}: far thumbnails (>=115) must not be requested before the strip scrolls there`);
      // 可视缩略图须真实出图（轮询等图源 200ms 延迟落座）
      await page.waitForFunction(() => {
        const strip = document.querySelector('[data-album-chrome="bottom"] .scroll-x');
        const sr = strip.getBoundingClientRect();
        const vis = [...strip.querySelectorAll("[data-thumb-index]")].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.right > sr.left && r.left < sr.right;
        });
        return vis.length >= 5 && vis.every((el) => {
          const img = el.querySelector("img");
          return img && img.complete && img.naturalWidth > 0 && !el.querySelector(".ios-image-error");
        });
      }, null, { timeout: 8000 });
      // 条滚到尾：尾部缩略图此时才挂图并出图
      await page.evaluate(() => {
        const strip = document.querySelector('[data-album-chrome="bottom"] .scroll-x');
        strip.scrollLeft = strip.scrollWidth;
        strip.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-thumb-index="125"]');
        const img = el?.querySelector("img");
        return !!img && img.complete && img.naturalWidth > 0 && !el.querySelector(".ios-image-error");
      }, null, { timeout: 8000 });
      assert(requested.has(125), `${name}: last thumbnail must be requested after scrolling to the end`);
      const s2 = await stripState();
      result.afterScrollImgCount = s2.imgCount;
      assert(s2.imgCount <= 60, `${name}: mounted thumbnail <img> count after scroll ${s2.imgCount} must stay bounded (<=60)`);
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

  await runGalleryCase([393, 852]);
  await runGalleryCase([360, 780]);
  await runGalleryStripCase();
  await runGalleryFastSwipeCase();
  await runGallerySafeAreaCase();
  await runGalleryStripLoadCase();
  if (process.env.LAYOUT_ONLY === "gallery") {
    console.log("LAYOUT_ONLY=gallery: player cases skipped");
  } else {
  for (const vp of PORTRAIT_VIEWPORTS) await runCase(`portrait-${vp[0]}x${vp[1]}`, vp, portBase, portBase, [360, 640], true);
  await runCase("portrait-393-rotated-source", [393, 852], landBase, landBase, [320, 180], false, true);
  for (const vp of LANDSCAPE_VIEWPORTS) await runCase(`landscape-${vp[0]}x${vp[1]}`, vp, landBase, landBase, [320, 180]);
  }
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
