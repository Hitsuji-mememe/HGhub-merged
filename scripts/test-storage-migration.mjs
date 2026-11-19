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
    // 接棒 (3.3.0 账号拆除): dirtyHistory 断言删除——该字段只是未上传
    // 标记, 进度本体在 history 行内, 由 history44 本体断言接棒覆盖。
    assert.deepEqual(mergeResult.localHistory, [45, 44, 46], "local-only history unioned");
    assert.deepEqual(mergeResult.favs, [7, 8], "collections unioned");
    assert.deepEqual(mergeResult.postFavs, [9], "post collections unioned");
    assert.deepEqual(mergeResult.likeEpisodes, [{ video_id: 44, ep: 2 }, { video_id: 44, ep: 3 }], "liked episodes deduped by (video_id, ep)");
    console.log("PASS: cross-line bucket migration merges instead of dropping dirty/local progress");
    // 接棒 (Muse 2026-11-19, 3.3.0 账号线顺带适配): 外观已于 3.2.2 砍单
    // 固定跟随系统——readThemePreference 恒 "system"、不再读存档偏好、
    // 无 setTheme 切换面。原断言 (偏好 "light"、setTheme 流、主题落盘)
    // 在 3.2.2 基线上即已失效, 本批按已落地契约适配: 偏好恒 system;
    // 旧键 hghub_theme 自 3.2.2 起无读取方 (惰性残留, 不迁移不删除),
    // 键集合断言据实含它; 主题切换流删除, 清历史+重启持久化实质保留。
    assert.equal(await page.evaluate(() => window.storageMigrationFixture.getThemePreference()), "system");
    assert.equal(await page.evaluate(() => window.initialTheme), true);
    const saved = await storage(page);
    assert.deepEqual(Object.keys(saved).sort(), ["hghub_theme", "hghubx_app_v1", "hghubx_swipe_ep_v2", "hghubx_theme"]);
    assert.deepEqual(JSON.parse(saved.hghubx_app_v1), { ...migrated, srMode: "natural", srPref: "auto", rate: 1 }); // 落盘含超分模式与超分偏好 (2.2.0 合并新增字段; srPref 为超分全自动默认值; rate 为蓝图 P4 全局倍速默认值，接棒同处)
    await page.evaluate(() => { window.storageMigrationFixture.clearHistory(); });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("hghubx_app_v1")).history.length === 0);
    await page.reload();
    await page.waitForFunction(() => window.storageMigrationFixture?.strictSecurityReady);
    const { theme: _themeAfterRestart, ...snapshotAfterRestart } = await snapshot(page);
    assert.deepEqual(snapshotAfterRestart, { ...migrated, history: [] });
    await context.close();
    console.log("PASS: legacy data, swipe opt-out and cleared history survive migration and restart");
  }
  {
    const newer = { ...migrated, favs: [99], history: [] };
    const { context, page } = await open({ ...oldData, hghubx_app_v1: JSON.stringify(newer), hghubx_theme: "dark", hghubx_swipe_ep_v2: "1" });
    // 接棒 (同上): 存档主题不再被读, 快照 theme 只随系统解析, 此处不断言其值。
    const { theme: _themeNewer, ...snapshotNewer } = await snapshot(page);
    assert.deepEqual(snapshotNewer, newer);
    assert.equal(await page.evaluate(() => window.initialTheme), false);
    assert(Object.keys(await storage(page)).filter(key => key !== "hghub_theme").every(key => key.startsWith("hghubx_")));
    await context.close();
    console.log("PASS: new values win over stale old data and old keys are cleaned");
  }
  /* 3.3.0 账号拆除吸收（升级不丢数据证伪）：旧版登录分桶
   * hghubx_accounts_v1（两桶）+ 游客 blob → 启动时全桶合并进本机
   * 资料库，合并落盘验证后旧键删除；屏蔽设置键与账号无关，原样不动。
   * 旧码无此吸收：分桶数据会随键孤儿化（即本场景在旧码上必红）。 */
  const absorbSeed = {
    hghubx_app_v1: JSON.stringify({
      likes: [11], favs: [22], follows: [], postFavs: [5],
      history: [{ id: 44, ep: 2, t: 5, dur: 80, at: 1000 }],
      searchHist: [], volume: 0.7, muted: true, muteOnStartup: true, swipeEp: false,
      preferHevc: true, fsIdleSecs: 3, srMode: "natural", srPref: "auto", rate: 1,
    }),
    hghubx_accounts_v1: JSON.stringify({ version: 1, accounts: {
      '["https://a.example",1]': {
        likes: [12], favs: [23], follows: [33], postLikes: [7], postFavs: [6],
        history: [{ id: 44, ep: 3, t: 12.5, dur: 80, at: 2000 }, { id: 46, ep: 1, t: 3, dur: 30, at: 800 }],
        likeEpisodes: [{ video_id: 44, ep: 3 }], dirtyHistory: { 44: { ep: 3, at: 2000 } }, localHistory: [44, 46],
      },
      '["https://b.example",2]': {
        favs: [24], postFavs: [5], history: [{ id: 47, ep: 1, t: 0, dur: 10, at: 700 }],
      },
    } }),
    hghubx_content_preferences_v1: JSON.stringify({ blockedTags: ["示例标签"], hideUntagged: false, paused: false }),
  };
  {
    const { context, page } = await open(absorbSeed);
    const value = await snapshot(page);
    assert.deepEqual(value.favs, [22, 23, 24], "guest + both account buckets' favorites unioned");
    assert.deepEqual(value.likes, [11, 12], "likes unioned");
    assert.deepEqual(value.follows, [33], "follows unioned");
    assert.deepEqual(value.history, [
      { id: 44, ep: 3, t: 12.5, dur: 80, at: 2000 },
      { id: 46, ep: 1, t: 3, dur: 30, at: 800 },
      { id: 47, ep: 1, t: 0, dur: 10, at: 700 },
    ], "history merged across buckets, newer row wins, sorted by recency");
    const saved = await storage(page);
    assert.equal(saved.hghubx_accounts_v1, undefined, "legacy accounts key removed after verified write");
    const blob = JSON.parse(saved.hghubx_app_v1);
    assert.deepEqual(blob.postFavs, [5, 6], "post favorites unioned into the app blob");
    assert.deepEqual(blob.postLikes, [7], "post likes unioned into the app blob");
    assert.deepEqual(blob.likeEpisodes, [{ video_id: 44, ep: 3 }], "liked episodes carried over");
    assert.equal(saved.hghubx_content_preferences_v1, absorbSeed.hghubx_content_preferences_v1, "content preferences key untouched by absorption");
    await page.reload();
    await page.waitForFunction(() => window.storageMigrationFixture?.strictSecurityReady);
    const again = await snapshot(page);
    assert.deepEqual(again.favs, [22, 23, 24], "absorption is idempotent across restarts");
    assert.deepEqual(again.history, value.history, "merged history stable across restarts");
    await context.close();
    console.log("PASS: legacy account buckets absorbed into the local library; accounts key removed; preferences untouched");
  }
  {
    /* 写失败时旧分桶键必须保留（不变量 7），内存合并仍生效，下次启动重吸收。 */
    const { context, page } = await open(absorbSeed, "write");
    const value = await snapshot(page);
    assert.deepEqual(value.favs, [22, 23, 24], "in-memory absorption still applies when the write fails");
    const saved = await storage(page);
    assert.equal(saved.hghubx_accounts_v1, absorbSeed.hghubx_accounts_v1, "legacy accounts key retained when the write fails");
    await context.close();
    console.log("PASS: failed write retains the legacy accounts key for the next launch");
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
