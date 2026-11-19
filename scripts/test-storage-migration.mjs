import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const bootScript = (await readFile(new URL("../index.html", import.meta.url), "utf8"))
  .match(/<script>([\s\S]*?)<\/script>/)[1];
const fixtureHtml = (await readFile(new URL("../tests/storage-migration.html", import.meta.url), "utf8"))
  .replace('<script type="module"', `<script>${bootScript}\nwindow.initialTheme = document.documentElement.classList.contains("theme-light");</script><script type="module"`);
const state = {
  likes: [11], favs: [22], follows: [33],
  history: [{ id: 44, ep: 3, t: 12.5, dur: 80, at: 123456 }],
  searchHist: ["保留搜索记录"], volume: 0.42, muted: false,
  muteOnStartup: false, swipeEp: false, preferHevc: true,
};
// 迁移会为新字段补默认值（#146-3 全屏闲置隐藏秒数）：旧种子不带该字段，落盘应补齐。
// 接棒 (Muse 2026-11-18): fsIdleSecs 写死 0 被用户重新裁定解硬——默认 3 秒
// (与官方一致)、尊重存量, 不再 load 时强制归零; 启动静音仍写死强制。
// 再接棒 (同日真机纠正): swipeEp 写死值由 true 改 false——原断言保护
// 「1.2.9 一次性迁移把旧 false 强制改 true (上下划切集定版)」; 用户真机
// 纠正竖滑应切作品、非切集, 该定版推翻, load 恒归 false, 由本断言接棒。
const migrated = { ...state, fsIdleSecs: 3, muteOnStartup: true, muted: true, swipeEp: false };
const oldData = {
  hghub_app_v1: JSON.stringify(state), hghub_swipe_ep_v2: "1", hghub_theme: "light",
};
let vite, browser;
const errors = [];
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  const html = await vite.transformIndexHtml("/tests/storage-migration.html", fixtureHtml);
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });

  async function open(seed, failure = "") {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      assert.equal(new URL(route.request().url()).origin, new URL(origin).origin);
      if (new URL(route.request().url()).pathname === "/tests/storage-migration.html") {
        return route.fulfill({ contentType: "text/html", body: html });
      }
      return route.continue();
    });
    await page.addInitScript(({ seed, failure }) => {
      if (!sessionStorage.getItem("seeded")) {
        localStorage.clear();
        for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
        sessionStorage.setItem("seeded", "1");
      }
      Object.assign(window, { __TAURI_INTERNALS__: { async invoke(command) {
        if (command === "app_boot") return { strict_security: true };
        if (command === "debug_log" || command === "playback_log_write") return;
        throw new Error(`Unexpected IPC: ${command}`);
      } } });
      if (failure === "write") {
        const originalSet = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (this === localStorage) throw new DOMException("fixture: quota", "QuotaExceededError");
          return Reflect.apply(originalSet, this, [key, value]);
        };
      }
      if (failure === "read") {
        Storage.prototype.getItem = () => { throw new DOMException("fixture: blocked", "SecurityError"); };
      }
      if (failure === "remove") {
        Storage.prototype.removeItem = () => { throw new DOMException("fixture: blocked", "SecurityError"); };
      }
    }, { seed, failure });
    await page.goto(`${origin}tests/storage-migration.html`);
    await page.waitForFunction(() => window.storageMigrationFixture?.strictSecurityReady, null, { timeout: 10000 });
    return { context, page };
  }
  const snapshot = page => page.locator("pre").textContent().then(JSON.parse);
  const storage = page => page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));

  {
    const { context, page } = await open(oldData);
    assert.deepEqual(await snapshot(page), { ...migrated, theme: "light" });
    /* P1-2（audit6）：目标桶已存在 + 旧桶未上传进度 → 合并后进度在、新者胜 */
    const mergeResult = await page.evaluate(() => window.__accountMerge);
    assert.deepEqual(mergeResult.history44, { id: 44, ep: 3, t: 12.5, dur: 80, at: 2000 }, "newer previous progress wins");
    assert.deepEqual(mergeResult.historyIds, [44, 45, 46], "histories unioned and sorted by recency");
    assert.deepEqual(mergeResult.dirty44, { ep: 3, at: 2000 }, "un-uploaded dirty progress survives migration");
    assert.deepEqual(mergeResult.dirty45, { ep: 1, at: 900 }, "target dirty progress kept");
    assert.deepEqual(mergeResult.localHistory, [45, 44, 46], "local-only history unioned");
    assert.deepEqual(mergeResult.favs, [7, 8], "collections unioned");
    console.log("PASS: cross-line bucket migration merges instead of dropping dirty/local progress");
    assert.equal(await page.evaluate(() => window.storageMigrationFixture.getThemePreference()), "light");
    assert.equal(await page.evaluate(() => window.initialTheme), true);
    const saved = await storage(page);
    assert.deepEqual(Object.keys(saved).sort(), ["hghubx_app_v1", "hghubx_swipe_ep_v2", "hghubx_theme"]);
    assert.deepEqual(JSON.parse(saved.hghubx_app_v1), { ...migrated, srMode: "natural", srPref: "auto", rate: 1 }); // 落盘含超分模式与超分偏好 (2.2.0 合并新增字段; srPref 为超分全自动默认值; rate 为蓝图 P4 全局倍速默认值，接棒同处)
    await page.evaluate(() => window.storageMigrationFixture.setTheme("system"));
    await page.waitForFunction(() => localStorage.getItem("hghubx_theme") === "system");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    assert.equal(await page.evaluate(() => localStorage.getItem("hghubx_theme")), "system");
    await page.evaluate(() => {
      window.storageMigrationFixture.setTheme("dark");
      window.storageMigrationFixture.clearHistory();
    });
    await page.waitForFunction(() => localStorage.getItem("hghubx_theme") === "dark" && JSON.parse(localStorage.getItem("hghubx_app_v1")).history.length === 0);
    await page.reload();
    await page.waitForFunction(() => window.storageMigrationFixture?.strictSecurityReady);
    assert.deepEqual(await snapshot(page), { ...migrated, history: [], theme: "dark" });
    await context.close();
    console.log("PASS: legacy data, swipe opt-out, adaptive and explicit appearance survive migration and restart");
  }
  {
    const newer = { ...migrated, favs: [99], history: [] };
    const { context, page } = await open({ ...oldData, hghubx_app_v1: JSON.stringify(newer), hghubx_theme: "dark", hghubx_swipe_ep_v2: "1" });
    assert.deepEqual(await snapshot(page), { ...newer, theme: "dark" });
    assert.equal(await page.evaluate(() => window.initialTheme), false);
    assert(Object.keys(await storage(page)).every(key => key.startsWith("hghubx_")));
    await context.close();
    console.log("PASS: new values win over stale old data and old keys are cleaned");
  }
  {
    const { context, page } = await open({ hghub_app_v1: JSON.stringify({ ...state, history: [44] }) });
    const value = await snapshot(page);
    // 接棒 (Muse 2026-11-18): 原断言 swipeEp === true 保护 1.2.9 一次性
    // 迁移 (旧 false 强制改 true); 竖滑切作品定版后 load 恒归 false。
    assert.equal(value.swipeEp, false);
    assert.equal(value.history[0].id, 44);
    assert.equal(value.history[0].ep, 1);
    assert.equal(value.history[0].t, 0);
    await context.close();
    console.log("PASS: historical history format survives and swipeEp now normalizes to false");
  }
  for (const failure of ["write", "remove"]) {
    const { context, page } = await open(oldData, failure);
    assert.deepEqual(await snapshot(page), { ...migrated, theme: "light" });
    const saved = await storage(page);
    for (const [key, value] of Object.entries(oldData)) assert.equal(saved[key], value);
    await page.reload();
    await page.waitForFunction(() => window.storageMigrationFixture?.strictSecurityReady);
    assert.deepEqual(await snapshot(page), { ...migrated, theme: "light" });
    await context.close();
    console.log(`PASS: ${failure} failure retains legacy data and preferences across restarts`);
  }
  for (const seed of [{}, { hghub_app_v1: "invalid json" }]) {
    const { context, page } = await open(seed);
    assert.deepEqual((await snapshot(page)).history, []);
    assert.equal(await page.evaluate(() => window.storageMigrationFixture.getThemePreference()), "system");
    await context.close();
  }
  {
    const { context, page } = await open({}, "read");
    assert.deepEqual((await snapshot(page)).favs, []);
    await context.close();
  }
  {
    const { context, page } = await open({ hghub_swipe_ep_v2: "1" });
    const saved = await storage(page);
    assert.equal(saved.hghubx_swipe_ep_v2, "1");
    assert.equal(saved.hghub_swipe_ep_v2, undefined);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log("PASS: fresh installs, malformed data and unavailable storage do not crash");
} finally {
  await browser?.close();
  await vite?.close();
}
