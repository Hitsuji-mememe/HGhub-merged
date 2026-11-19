// Channel header gate (Muse 2026-11-20 fix331/covers-header):
// ② 外部视频播放页双层页头——列表态外层页头恰一层，详情（error 态，
//    与真机截图 1 同状态）打开后外层页头必须让位、只剩内层返回键；
// ③ 分类页压扁残行——静止态全几何扫描不得出现「矮且裁内容」的行，
//    并实测半裁滚动位形可复现的残高（定性用，不作失败断言）。
// Local only: scripted IPC/fetchPage fixtures; not WKWebView.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "channel-header", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { environment: "Channel header fixture in Chromium; scripted IPC; not WKWebView", passed: [], failed: [], notes: [] };
const check = (name, cond, detail = "") => {
  if (cond) report.passed.push(name);
  else report.failed.push(detail ? `${name}: ${detail}` : name);
};

let vite, browser;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });

  const waitState = async (page, pred, timeout = 15000) => {
    const t0 = Date.now();
    for (;;) {
      const s = await page.evaluate(() => (window).__hdr.state());
      if (pred(s)) return s;
      if (Date.now() - t0 > timeout) throw new Error(`waitState timeout: last=${JSON.stringify(s)}`);
      await new Promise((r) => setTimeout(r, 120));
    }
  };

  /* ── ② scene=video ── */
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on("pageerror", (e) => report.failed.push(`video pageerror: ${e.message}`));
    await page.goto(`${origin}tests/channel-header.html?scene=video`);
    const list = await waitState(page, (s) => s.cards >= 1);
    check("video list: outer header exactly one layer", list.headers === 1, `headers=${list.headers}`);
    check("video list: no detail back button", list.backList === 0);
    await page.click('[data-ui="media-grid"] > * >> nth=0');
    const detail = await waitState(page, (s) => s.backList >= 1);
    check("video detail: inner back-to-list present", detail.backList === 1, `backList=${detail.backList}`);
    check("video detail: outer header yielded (zero layers)", detail.headers === 0, `headers=${detail.headers}`);
    check("video detail: error phase reached (mirrors device screenshot)", detail.detailError === true);
    await page.click('[aria-label="返回列表"]');
    /* 页头恢复经 effect 回报链晚一帧于详情卸载，直接等页头本身。 */
    const back = await waitState(page, (s) => s.backList === 0 && s.headers === 1);
    check("video back-to-list: outer header restored", back.headers === 1, `headers=${back.headers}`);
    await page.close();
  }

  /* ── ③ scene=category ── */
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on("pageerror", (e) => report.failed.push(`category pageerror: ${e.message}`));
    await page.goto(`${origin}tests/channel-header.html?scene=category`);
    const s = await waitState(page, (st) => st.band !== null && st.band.elements.length > 0);
    const squashed = s.band.elements.filter((e) => e.height > 0 && e.height < 30 && e.clipped && e.text.length > 0);
    check("category at rest: no squashed clipped text row between heading and switcher", squashed.length === 0,
      JSON.stringify(squashed));
    const minTextRow = Math.min(...s.band.elements.filter((e) => e.text.length > 0).map((e) => e.height));
    report.notes.push(`category band elements=${s.band.elements.length}, min text row height=${minTextRow}px`);
    const clip = await page.evaluate(() => (window).__hdr.clipGuaHeader());
    report.notes.push(`mid-scroll clip reproduction: ${JSON.stringify(clip)}`);
    if (clip) {
      await page.screenshot({ path: join(output, "category-midscroll-clip.png") });
      check("mid-scroll: section header sliver is producible by scroll position alone",
        clip.visibleSliver > 0 && clip.visibleSliver < clip.btnHeight,
        JSON.stringify(clip));
    }
    await page.close();
  }
} catch (e) {
  report.failed.push(`harness: ${e.message}`);
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  if (browser) await browser.close();
  if (vite) await vite.close();
}
console.log(JSON.stringify(report, null, 2));
assert.equal(report.failed.length, 0, `channel-header failures: ${report.failed.join("; ")}`);
