// Nav chain gesture gate (Muse 2026-11-18, 收官批 E).
// 链序 = 底部页签序: 首页(播放器) → 搜索 → 分类 → 我的 (→ 设置为栈页)。
// 断言: 主页中部右划落搜索、搜索左划回主页、搜索右划落分类、分类左划
// 回搜索、我的右划无动作 (链尾)、纵向滑动不误触整页切换。
// 〈与放大镜落点一致 (同落搜索) 由 Feed 内同一 goBack/搜索入口的代码
// 路径保证, 本夹具 feed 为空、播放器顶栏不渲染, 不在此重复点击验证。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "nav-chain", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { environment: "Real App in Chromium (iPhone UA), mocked Tauri IPC, synthetic touch events; not WKWebView", passed: [] };
let vite, browser;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 Version/17.1 Mobile/15E148 Safari/604.1",
  });
  await context.addInitScript(installFixture, { theme: "dark", titles: ["城市与晚风", "重逢在夏日以后", "星河旅人"] });
  await context.addInitScript(() => localStorage.setItem("hghubx_usage_agreement", JSON.stringify({
    version: "2026-11-15-v1", accepted: true, acceptedAt: "2026-11-15T00:00:00.000Z",
  })));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin === new URL(origin).origin) return route.continue();
    return route.abort();
  });
  await page.goto(origin);
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.waitFor();

  const activeTab = () => page.evaluate(() => {
    const btn = document.querySelector('nav[aria-label="主导航"] button[aria-current="page"]');
    return btn ? btn.textContent.trim() : null;
  });
  const swipe = (x0, y0, x1, y1) => page.evaluate(([ax, ay, bx, by]) => {
    const target = document.elementFromPoint(ax, ay) || document.body;
    const mk = (type, x, y) => {
      const t = new Touch({ identifier: 1, target, clientX: x, clientY: y });
      target.dispatchEvent(new TouchEvent(type, { touches: type === "touchend" ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }));
    };
    mk("touchstart", ax, ay);
    mk("touchend", bx, by);
  }, [x0, y0, x1, y1]);
  const expectTab = async (name, label) => {
    await page.waitForTimeout(250);
    assert.equal(await activeTab(), name, `${label}: expected tab ${name}`);
    report.passed.push(label);
  };

  assert.equal(await activeTab(), "首页");
  await swipe(195, 420, 330, 428);           // 中部右划
  await expectTab("搜索", "E1 player mid right-swipe -> search");
  await swipe(195, 420, 60, 428);            // 左划回上一级
  await expectTab("首页", "E2 search left-swipe -> home");
  await swipe(195, 420, 330, 428);
  await expectTab("搜索", "E3 home right-swipe -> search again");
  await swipe(195, 420, 330, 428);           // 右划去下一级
  await expectTab("分类", "E4 search right-swipe -> category");
  await swipe(195, 420, 60, 428);
  await expectTab("搜索", "E5 category left-swipe -> search");
  await page.getByRole("button", { name: "我的", exact: true }).click();
  await expectTab("我的", "E6 tab bar still jumps directly");
  await swipe(195, 420, 330, 428);           // 链尾右划
  await expectTab("我的", "E7 profile right-swipe is a no-op (chain tail)");
  await swipe(195, 420, 60, 428);
  await expectTab("分类", "E8 profile left-swipe -> category");
  // 纵向滑动不误触: 回搜索后大幅纵向滑, 页签不变
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expectTab("搜索", "E9 back on search");
  await swipe(195, 300, 205, 640);
  await expectTab("搜索", "E10 vertical-dominant swipe does not switch tabs");
  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(`nav-chain: ${report.passed.length} checks passed`);
} finally {
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
}
