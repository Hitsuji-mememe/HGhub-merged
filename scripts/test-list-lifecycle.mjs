// List lifecycle gate (Muse 2026-11-19 fix2.1): drives the list-lifecycle
// fixture — pagination reset-prefetch continuation, A2 pagination contract
// injections, cover attempt timeout start point, channel filter page-base
// reset. Local only: scripted requests/IPC, images fulfilled by route.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "list-lifecycle", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { environment: "List lifecycle fixture in Chromium; scripted requests; not WKWebView", passed: [], failed: [] };
const check = (name, cond, detail = "") => {
  if (cond) report.passed.push(name);
  else report.failed.push(detail ? `${name}: ${detail}` : name);
};

/* 1x1 PNG */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let vite, browser;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });

  const newPage = async () => {
    const page = await browser.newPage({ viewport: { width: 480, height: 800 } });
    page.on("pageerror", (e) => report.failed.push(`pageerror: ${e.message}`));
    return page;
  };
  const gotoScene = async (page, scene) => {
    await page.goto(`${origin}tests/list-lifecycle.html?scene=${scene}`);
    await page.waitForFunction(() => (window).__list !== undefined || (window).__img !== undefined || document.querySelector(".ios-page") !== null, null, { timeout: 15000 });
  };
  const listState = (page) => page.evaluate(() => (window).__list.state());
  /* Node 侧轮询：谓词是普通函数（waitForFunction + eval 在本环境不可靠） */
  const waitList = async (page, pred, timeout = 12000) => {
    const t0 = Date.now();
    for (;;) {
      const s = await listState(page);
      if (pred(s)) return s;
      if (Date.now() - t0 > timeout) throw new Error(`waitList timeout: last=${JSON.stringify(s)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  /* —— 分页场景 —— */
  const pagScene = async (scene, waits, asserts) => {
    const page = await newPage();
    await gotoScene(page, scene);
    for (const w of waits) {
      if (w.wait) await waitList(page, w.wait, w.timeout);
      if (w.more) { await page.evaluate(() => (window).__list.loadMore()); }
    }
    const s = await listState(page);
    asserts(s);
    await page.close();
  };

  /* #2 reset 后预取续拉：无交互自动到 4 页（1+MAX_AUTO_PREFETCH 3）停住 */
  await pagScene("prefetch",
    [{ wait: (s) => s.calls.length === 4 && !s.loading }],
    (s) => {
      check("prefetch: reset 后自动续拉到上限 4 页", s.page === 4 && s.items === 4, JSON.stringify(s));
      check("prefetch: 上限处仍 hasMore", s.hasMore === true, JSON.stringify(s));
    });
  {
    const page = await newPage();
    await gotoScene(page, "prefetch");
    await waitList(page, (s) => s.calls.length === 4 && !s.loading);
    await page.evaluate(() => (window).__list.loadMore());
    await waitList(page, (s) => s.calls.length === 5 && !s.loading);
    const s = await listState(page);
    check("prefetch: 手动续拉到尾页后 hasMore=false", s.page === 5 && s.hasMore === false, JSON.stringify(s));
    await page.close();
  }

  /* A2 契约注入五种 */
  await pagScene("missing", [{ wait: (s) => s.calls.length === 1 && !s.loading }],
    (s) => check("contract missing-pages: 只拉一页即终止", s.hasMore === false && s.items === 1, JSON.stringify(s)));
  await pagScene("zero", [{ wait: (s) => s.calls.length === 1 && !s.loading }],
    (s) => check("contract zero-pages: 终止且保留已收条目", s.hasMore === false && s.items === 1, JSON.stringify(s)));
  await pagScene("shrink",
    [{ wait: (s) => s.page === 1 && !s.loading && s.hasMore === true }, { more: true }, { wait: (s) => s.page === 2 && !s.loading }],
    (s) => check("contract shrinking-pages: pages 缩到小于当前页即终止", s.hasMore === false && s.calls.length === 2, JSON.stringify(s)));
  await pagScene("emptymid",
    [{ wait: (s) => s.page === 1 && !s.loading }, { more: true }, { wait: (s) => s.page === 2 && !s.loading }, { more: true }, { wait: (s) => s.page === 3 && !s.loading }],
    (s) => check("contract empty-mid-page: 空页不终止、前进到尾页", s.hasMore === false && s.items === 2 && s.calls.length === 3, JSON.stringify(s)));
  await pagScene("conflict", [{ wait: (s) => s.calls.length === 1 && !s.loading }],
    (s) => check("contract total-conflict: 终止只认 pages 不认 total", s.hasMore === true && s.total === 1, JSON.stringify(s)));

  /* —— 3.2.2 自动续页：滚动到底自动拉页（全程不调手动 loadMore） —— */
  {
    const page = await newPage();
    await gotoScene(page, "autoscroll");
    await waitList(page, (s) => s.page === 1 && !s.loading && s.calls.length === 1);
    const scrollBottom = () => page.evaluate(() => {
      const el = document.querySelector('[data-testid="scroller"]');
      if (el) el.scrollTop = el.scrollHeight;
    });
    await scrollBottom();
    await waitList(page, (s) => s.calls.length >= 2);
    await scrollBottom();
    const s = await waitList(page, (s) => s.page === 3 && !s.loading);
    check("autoscroll: 滚动到底自动续页到尾页（未调用手动 loadMore）",
      s.items === 3 && s.hasMore === false && s.calls.join() === "1,2,3", JSON.stringify(s));
    await page.close();
  }
  /* —— 3.2.2 自动续页失败：进 error 态不前进，兜底重试同页成功 —— */
  {
    const page = await newPage();
    await gotoScene(page, "autofail");
    await waitList(page, (s) => s.page === 1 && !s.loading);
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="scroller"]');
      if (el) el.scrollTop = el.scrollHeight;
    });
    const f = await waitList(page, (s) => s.err !== "" && !s.loading);
    check("autofail: 自动续页失败进 error 态、页码不前进",
      f.page === 1 && f.calls.join() === "1,2", JSON.stringify(f));
    await page.evaluate(() => (window).__list.loadMore());
    /* 重试成功后哨兵仍在底部、预取链会立即续拉下一页——page=2 是
     * 瞬态，等到页码越过 2 且请求序列以 1,2,2 开头即证重试同页成功。 */
    const s = await waitList(page, (s) => s.page >= 2 && !s.loading);
    check("autofail: 兜底（手动 loadMore）重试同页成功",
      s.items >= 2 && s.calls.slice(0, 3).join() === "1,2,2", JSON.stringify(s));
    await page.close();
  }

  /* —— 封面场景 A：视口外不烧 attempt —— */
  {
    const page = await newPage();
    await page.route("**/img?u=*", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
    await gotoScene(page, "offscreen");
    await new Promise((r) => setTimeout(r, 22000));
    let snap = await page.evaluate(() => (window).__img.trace());
    const failedEvents = snap.events.filter((e) => e.kind === "image" && e.data.ev === "failed");
    check("image offscreen: 视口外 22s 无 attempt 超时烧毁", failedEvents.length === 0, JSON.stringify(failedEvents));
    const errShown = await page.evaluate(() => document.querySelector(".ios-image-error") !== null);
    check("image offscreen: 无失败占位", errShown === false);
    await page.evaluate(() => document.querySelector('[data-ui="image-frame"]').scrollIntoView());
    await page.waitForFunction(() => (window).__img.trace().events.some((e) => e.kind === "image" && e.data.ev === "decoded"), null, { timeout: 10000 });
    snap = await page.evaluate(() => (window).__img.trace());
    check("image offscreen: 进入视口后正常加载", snap.events.some((e) => e.kind === "image" && e.data.ev === "decoded"));
    await page.close();
  }

  /* —— 封面场景 B：迟到旧 attempt 事件不污染新 attempt —— */
  {
    const page = await newPage();
    let hangRoute = null;
    await page.route("**/img?u=*", (route) => {
      const url = route.request().url();
      if (url.includes("r=1")) return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
      hangRoute = route; /* attempt 0 挂起，等超时 */
      return undefined;
    });
    await gotoScene(page, "late");
    await page.waitForFunction(() => (window).__img.trace().events.some((e) => e.kind === "image" && e.data.ev === "failed" && e.data.reason === "timeout"), null, { timeout: 30000 });
    await page.waitForFunction(() => (window).__img.trace().events.some((e) => e.kind === "image" && e.data.ev === "decoded"), null, { timeout: 10000 });
    /* 注入迟到事件：合成 error + 让挂起的旧请求迟到成功 */
    await page.evaluate(() => {
      const img = document.querySelector('[data-ui="image-frame"] img');
      img.dispatchEvent(new Event("error"));
    });
    if (hangRoute) { try { await hangRoute.fulfill({ status: 200, contentType: "image/png", body: PNG }); } catch { /* 已随 src 切换中止 */ } }
    await new Promise((r) => setTimeout(r, 500));
    const snap = await page.evaluate(() => (window).__img.trace());
    const failedCount = snap.events.filter((e) => e.kind === "image" && e.data.ev === "failed").length;
    check("image late: 迟到事件未污染新 attempt（failed 仍为 1）", failedCount === 1, `failed=${failedCount}`);
    const stillOk = await page.evaluate(() => {
      const img = document.querySelector('[data-ui="image-frame"] img');
      return img !== null && img.className.includes("opacity-100") && document.querySelector(".ios-image-error") === null;
    });
    check("image late: 迟到事件后仍呈 displayed", stillOk === true);
    await page.close();
  }

  /* —— 频道页换筛选页数基线 —— */
  {
    const page = await newPage();
    await gotoScene(page, "channel");
    await page.waitForFunction(() => document.body.innerText.includes("1/5 页"), null, { timeout: 15000 });
    await page.getByRole("button", { name: "当前热播" }).click();
    await page.waitForFunction(() => document.body.innerText.includes("1/1 页"), null, { timeout: 15000 });
    const body = await page.evaluate(() => document.body.innerText);
    check("channel filter: 换筛选后页数基线归 1（不继承旧 5 页）", body.includes("1/1 页"));
    check("channel filter: 换筛选后判到尾", body.includes("已经到底啦") && !body.includes("加载更多"));
    await page.close();
  }
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { await vite?.close(); } catch { /* ignore */ }
}

await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
console.log(`passed ${report.passed.length}, failed ${report.failed.length}`);
for (const f of report.failed) console.log(`FAIL ${f}`);
assert.equal(report.failed.length, 0, `${report.failed.length} checks failed`);
