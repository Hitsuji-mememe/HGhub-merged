#!/usr/bin/env node
// 吃瓜详情 F9 回归（Muse 2026-11-19 3.2.1修复F9线，用户实报两条）：
// 不变量「帖子详情页点播放：滚动位置保持不动、起播不冻结（进度持续前进）」。
// 夹具 tests/post-detail-f9（长文正文＋中段视频的真实形态帖，playback
// 解析 1 段 m3u8；?kind=image 为纯图帖），HLS 夹具由 ffmpeg 现生成、
// 经本地 fixture server 按 test-playback.mjs 同款 /hls、/seg 形态供片。
// 断言面：
//  1) 带视频帖：滚到中段点播放——滚动位置不变、currentTime 持续前进；
//     播放中派发 hg:line-changed（线路 epoch 变化，自动选线在播放期可
//     触发）——旧码在此跳顶＋卸载 Player（先红），修复后滚动/播放均保留。
//  2) 纯图帖：无 <video>；epoch 变化后滚动位置保留（旧码跳顶）。
// 运行：node scripts/test-post-detail-playback.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/* 引擎口径：桌面 UA → platform=linux → hls.js 引擎（与 Feed 共用内核/
 * 活动层）；iOS 真机为 AVFoundation 原生引擎，其起播推进属真机判读面，
 * 本脚本不断言——F9 缺陷接缝在宿主层（epoch 重置），与引擎无关。 */

const dir = mkdtempSync(join(tmpdir(), "f9-hls-"));
execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "30", "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod", "-hls_segment_filename", join(dir, "seg%03d.ts"), join(dir, "list.m3u8")], { timeout: 60000 });
const manifest = await readFile(join(dir, "list.m3u8"), "utf8");
const media = createHttpServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/hls") {
      const body = Buffer.from(manifest.split("\n").map(line => !line || line.startsWith("#") ? line :
        `http://hg.localhost/seg?u=${encodeURIComponent(`https://media.fixture.invalid/${line.trim()}`)}`).join("\n"));
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Access-Control-Allow-Origin": "*" }); res.end(body);
    } else if (url.pathname === "/seg") {
      const body = await readFile(join(dir, basename(new URL(url.searchParams.get("u")).pathname)));
      res.writeHead(200, { "Content-Type": "video/mp2t", "Access-Control-Allow-Origin": "*" }); res.end(body);
    } else { res.writeHead(404); res.end(); }
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise(done => media.listen(0, "127.0.0.1", done));
const mediaBase = `http://127.0.0.1:${media.address().port}`;

let vite, browser;
try {
  vite = await createViteServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, open: false } });
  await vite.listen();
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });

  const openKind = async (kind) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 },  });
    await page.route("**/hls?*", route => route.continue({ url: route.request().url().replace(/^https?:\/\/[^/]+/, mediaBase) }));
    await page.route("**/seg?*", route => route.continue({ url: route.request().url().replace(/^https?:\/\/[^/]+/, mediaBase) }));
    await page.goto(`${base}/tests/post-detail-f9.html?kind=${kind}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-post-media]", { timeout: 20000 });
    return page;
  };
  const scrollProbe = page => page.evaluate(() => document.querySelector("[data-post-scroll]").scrollTop);

  /* ── 面 1：带视频帖 ── */
  const page = await openKind("video");
  await page.waitForSelector('button[aria-label="播放视频"]', { timeout: 20000 });
  await page.evaluate(() => {
    const sc = document.querySelector("[data-post-scroll]");
    sc.scrollTop = document.querySelector("[data-post-media]").offsetTop - 120;
  });
  await page.waitForTimeout(300);
  const before = await scrollProbe(page);
  assert.ok(before > 500, `夹具应已滚到中段，实际 scrollTop=${before}`);
  await page.click('button[aria-label="播放视频"]');
  await page.waitForSelector("[data-post-media] video", { timeout: 20000 });
  await page.waitForTimeout(1200);
  const afterClick = await scrollProbe(page);
  assert.ok(Math.abs(afterClick - before) <= 2, `点播放后滚动应保持，实际 ${before} → ${afterClick}`);
  const t1 = await page.evaluate(() => document.querySelector("[data-post-media] video")?.currentTime ?? -1);
  await page.waitForTimeout(1800);
  const mid = await page.evaluate(() => {
    const v = document.querySelector("[data-post-media] video");
    return { t: v?.currentTime ?? -1, paused: v?.paused ?? true };
  });
  assert.ok(mid.t > t1 + 0.8 && !mid.paused, `起播应持续前进，实际 t1=${t1} mid=${JSON.stringify(mid)}`);

  /* 播放中线路 epoch 变化：旧码跳顶＋撕播放（F9 根因接缝） */
  await page.evaluate(() => window.dispatchEvent(new Event("hg:line-changed")));
  await page.waitForTimeout(1500);
  const afterEpoch = await page.evaluate(() => {
    const v = document.querySelector("[data-post-media] video");
    return { scrollTop: document.querySelector("[data-post-scroll]").scrollTop, hasVideo: !!v, t: v?.currentTime ?? -1, paused: v?.paused ?? true, poster: !!document.querySelector('button[aria-label="播放视频"]') };
  });
  assert.ok(Math.abs(afterEpoch.scrollTop - before) <= 2, `epoch 变化后滚动应保持，实际 ${before} → ${afterEpoch.scrollTop}`);
  assert.ok(afterEpoch.hasVideo && !afterEpoch.poster, `epoch 变化后 Player 应保留，实际 ${JSON.stringify(afterEpoch)}`);
  assert.ok(afterEpoch.t > mid.t && !afterEpoch.paused, `epoch 变化后进度应继续前进，实际 mid=${mid.t} after=${JSON.stringify(afterEpoch)}`);
  await page.close();

  /* ── 面 2：纯图帖 ── */
  const img = await openKind("image");
  await img.waitForTimeout(500);
  assert.equal(await img.evaluate(() => document.querySelectorAll("video").length), 0, "纯图帖不应有 <video>");
  await img.evaluate(() => { document.querySelector("[data-post-scroll]").scrollTop = 500; });
  await img.waitForTimeout(300);
  const imgBefore = await scrollProbe(img);
  await img.evaluate(() => window.dispatchEvent(new Event("hg:line-changed")));
  await img.waitForTimeout(1200);
  const imgAfter = await scrollProbe(img);
  assert.ok(Math.abs(imgAfter - imgBefore) <= 2, `纯图帖 epoch 变化后滚动应保持，实际 ${imgBefore} → ${imgAfter}`);
  await img.close();

  console.log("post-detail-playback: all assertions passed", JSON.stringify({ before, afterClick, t1, mid, afterEpoch, imgBefore, imgAfter }));
} finally {
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
  media.close();
}
