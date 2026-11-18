/**
 * WebGPU 超分检证 runner（Muse 2026-11-19，fix2 C；非门禁）。
 * 模式（argv[2]）：numeric | quality | stability | all（默认 numeric+quality）。
 * 产物：test-results/webgpu-sr/<时间戳>/（JSON 结果＋对比 PNG）。
 * Chromium 的 WebGPU 在本机走 SwiftShader/ANGLE——帧成本只作管线
 * 正确性与相对量级证据，设备级帧预算以真机探针 v2 为准（报告口径）。
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const mode = process.argv[2] ?? "all";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = new URL(`../test-results/webgpu-sr/${stamp}/`, import.meta.url);
mkdirSync(outDir, { recursive: true });

function startVite() {
  return new Promise((resolve, reject) => {
    const child = spawn("node_modules/.bin/vite", ["--port", "0", "--strictPort", "false"], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/Local:\s+(http:\/\/localhost:\d+\/)/);
      if (m) resolve({ child, base: m[1] });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", () => reject(new Error(`vite exited early: ${buf.slice(-400)}`)));
    setTimeout(() => reject(new Error("vite start timeout")), 30000);
  });
}

const { child: vite, base } = await startVite();
const browser = await chromium.launch({
  headless: true,
  args: ["--enable-unsafe-webgpu", "--disable-gpu-watchdog"],
});
const results = {};

async function runNumeric() {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on("console", (m) => { if (m.type() === "error") console.log("[numeric console]", m.text().slice(0, 200)); });
  await page.goto(`${base}tests/webgpu-sr.html?mode=numeric`, { waitUntil: "load" });
  await page.waitForFunction(() => (window).__srNumeric !== undefined, null, { timeout: 60000 });
  results.numeric = await page.evaluate(() => (window).__srNumeric);
  await page.close();
  console.log("numeric:", JSON.stringify(results.numeric));
}

async function runQuality() {
  const page = await browser.newPage({ viewport: { width: 400, height: 700 }, deviceScaleFactor: 1 });
  page.on("console", (m) => { if (m.type() === "error") console.log("[quality console]", m.text().slice(0, 200)); });
  await page.goto(`${base}tests/webgpu-sr.html?mode=quality`, { waitUntil: "load" });
  await page.waitForFunction(() => (window).__srQualityReady === true, null, { timeout: 90000 });
  /* 等 WebGL 超分画布真正呈现（opacity→1）再截图，避免截到未验证态。 */
  results.webglPresented = await page.evaluate(async () => {
    const canvas = document.querySelector('[data-panel="webgl"] canvas');
    if (!canvas) return false;
    for (let i = 0; i < 40; i += 1) {
      if (getComputedStyle(canvas).opacity === "1") return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return getComputedStyle(canvas).opacity === "1";
  });
  results.gpuStats = await page.evaluate(() => (window).__srGpuStats ?? null);
  const shots = {};
  for (const name of ["gt", "bilinear", "webgl"]) {
    const el = page.locator(`[data-panel="${name}"]`);
    const buf = await el.screenshot();
    writeFileSync(new URL(`${name}.png`, outDir), buf);
    shots[name] = `data:image/png;base64,${buf.toString("base64")}`;
  }
  /* WebGPU 面板隔离成单独页面/上下文截取（软件 GPU 进程多上下文
   * 互相干扰会传染 device lost，夹具实测）。 */
  {
    const gpuPage = await browser.newPage({ viewport: { width: 400, height: 300 }, deviceScaleFactor: 1 });
    gpuPage.on("console", (m) => { if (m.type() === "error") console.log("[gpu-only console]", m.text().slice(0, 200)); });
    await gpuPage.goto(`${base}tests/webgpu-sr.html?mode=gpu-only`, { waitUntil: "load" });
    await gpuPage.waitForFunction(() => (window).__srQualityReady === true, null, { timeout: 90000 });
    results.gpuStats = await gpuPage.evaluate(() => (window).__srGpuStats ?? null);
    const buf = await gpuPage.locator(`[data-panel="webgpu"]`).screenshot();
    writeFileSync(new URL(`webgpu.png`, outDir), buf);
    shots.webgpu = `data:image/png;base64,${buf.toString("base64")}`;
    await gpuPage.close();
  }
  /* 指标页：同尺寸截图解码后算亮度 PSNR / 全局 SSIM（对 GT）。 */
  const metrics = await page.evaluate(async (imgs) => {
    async function loadLuma(dataUrl) {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const luma = new Float32Array(c.width * c.height);
      for (let i = 0, j = 0; i < d.length; i += 4, j += 1) {
        luma[j] = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      }
      return luma;
    }
    function psnr(a, b) {
      let mse = 0;
      for (let i = 0; i < a.length; i += 1) { const d = a[i] - b[i]; mse += d * d; }
      mse /= a.length;
      return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
    }
    function ssim(a, b) {
      const n = a.length;
      let ma = 0, mb = 0;
      for (let i = 0; i < n; i += 1) { ma += a[i]; mb += b[i]; }
      ma /= n; mb /= n;
      let va = 0, vb = 0, cov = 0;
      for (let i = 0; i < n; i += 1) {
        const da = a[i] - ma, db = b[i] - mb;
        va += da * da; vb += db * db; cov += da * db;
      }
      va /= n; vb /= n; cov /= n;
      const c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2;
      return ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
    }
    const gt = await loadLuma(imgs.gt);
    const out = {};
    for (const k of ["bilinear", "webgl", "webgpu"]) {
      const l = await loadLuma(imgs[k]);
      out[k] = { psnr: Math.round(psnr(gt, l) * 100) / 100, ssim: Math.round(ssim(gt, l) * 10000) / 10000 };
    }
    return out;
  }, shots);
  results.quality = metrics;
  console.log("quality:", JSON.stringify(metrics), "gpuStats:", JSON.stringify(results.gpuStats));
  await page.close();
}

async function runStability() {
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  page.on("console", (m) => { if (m.type() === "error") console.log("[stability console]", m.text().slice(0, 200)); });
  await page.goto(`${base}tests/webgpu-sr.html?mode=stability`, { waitUntil: "load" });
  await page.waitForFunction(() => (window).__srStability?.done === true, null, { timeout: 660000 });
  results.stability = await page.evaluate(() => (window).__srStability);
  console.log("stability samples:", results.stability.samples?.length, "error:", results.stability.error ?? "none");
  await page.close();
}

try {
  if (mode === "numeric" || mode === "all") await runNumeric();
  if (mode === "quality" || mode === "all") await runQuality();
  if (mode === "stability") await runStability();
} finally {
  writeFileSync(new URL("results.json", outDir), JSON.stringify(results, null, 2));
  await browser.close();
  vite.kill();
}
console.log(`webgpu-sr ${mode} -> ${outDir.pathname}`);
