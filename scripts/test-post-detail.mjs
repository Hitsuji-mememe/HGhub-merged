#!/usr/bin/env node
// 吃瓜详情页 D2 回归（Muse 2026-11-19 最终版D2线，用户实报两条）：
//  1) 「先文后视频」：DOM 顺序断言——标题 h1、标签、正文 .article-body
//     必须在播放器区 [data-post-media] 之前（compareDocumentPosition）。
//  2) 「点了才播」不倒退：未点击前页面无 <video> 元素、无视频资源
//     请求（movie.mp4/.m3u8//hls?)；点击封面后 Player 才挂载出 <video>。
//  3) 封面圆罩回归：封面框 [data-ui="image-frame"] 的计算 border-radius
//     必须为 0px。根因（改前实测 999px）：播放 Button 是 .ios-button，
//     全局规则给它 border-radius:var(--control-radius)=999px（胶囊），
//     Img 框 .ios-image{border-radius:inherit} 继承之且自带
//     overflow:hidden，封面被裁成大椭圆、容器 bg-black 露黑边。
// 夹具 tests/post-detail（mock IPC，playback 成功解析一段地址）。
// 运行：node scripts/test-post-detail.mjs
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 Version/17.1 Mobile/15E148 Safari/604.1";

let vite, browser;
try {
  vite = await createViteServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, open: false } });
  await vite.listen();
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, userAgent: IPHONE_UA });
  const videoRequests = [];
  page.on("request", (req) => {
    const u = req.url();
    if (/movie\.mp4|\.m3u8|[/]hls\?/.test(u)) videoRequests.push(u);
  });
  await page.goto(`${base}/tests/post-detail.html`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-post-media]", { timeout: 20000 });
  await page.waitForSelector('button[aria-label="播放视频"]', { timeout: 20000 });

  const probe = await page.evaluate(() => {
    const media = document.querySelector("[data-post-media]");
    const h1 = document.querySelector("h1");
    const body = document.querySelector(".article-body");
    const tagBtn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("夹具标签甲"));
    const before = (a, b) => !!(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
    const frame = media?.querySelector('[data-ui="image-frame"]');
    return {
      titleBeforeMedia: before(h1, media),
      tagsBeforeMedia: before(tagBtn, media),
      bodyBeforeMedia: before(body, media),
      frameRadius: frame ? getComputedStyle(frame).borderRadius : null,
      mediaRadius: media ? getComputedStyle(media).borderRadius : null,
      videoCount: document.querySelectorAll("video").length,
    };
  });

  assert.equal(probe.titleBeforeMedia, true, `标题应在播放器之前 (probe=${JSON.stringify(probe)})`);
  assert.equal(probe.tagsBeforeMedia, true, "标签应在播放器之前");
  assert.equal(probe.bodyBeforeMedia, true, "介绍正文应在播放器之前");
  assert.equal(probe.frameRadius, "0px", `封面框圆角应为 0px（圆罩回归），实际 ${probe.frameRadius}`);
  assert.equal(probe.videoCount, 0, "未点击时不应有 <video> 元素");
  assert.deepEqual(videoRequests, [], `未点击时不应请求视频资源，实际 ${JSON.stringify(videoRequests)}`);

  /* 点击封面 → Player 挂载（点了才播的行为不倒退） */
  await page.click('button[aria-label="播放视频"]');
  await page.waitForSelector("[data-post-media] video", { timeout: 20000 });
  console.log("post-detail: all assertions passed", JSON.stringify(probe));
} finally {
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
}
