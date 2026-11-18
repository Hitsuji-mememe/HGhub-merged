// Playback engines gate (Muse 2026-11-18, 收官批 F/C): drives the pure
// logic fixture (fake clock / fake event sequences) for the append-stall
// watchdog three-stage policy, the session native fallback, and the
// density-based super-res tiering. No media, no Tauri, no network.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "playback-engines", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { environment: "Pure-logic fixture in Chromium; fake clock; not WKWebView", passed: [], failed: [] };
let vite, browser;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin === new URL(origin).origin) return route.continue();
    return route.abort();
  });
  await page.goto(`${origin}tests/playback-engines.html`);
  await page.waitForFunction(() => (window).__engines !== undefined, null, { timeout: 15000 });
  const r = await page.evaluate(() => (window).__engines);
  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);

  const check = (name, actual, expected) => {
    try {
      assert.deepEqual(actual, expected);
      report.passed.push(name);
    } catch {
      report.failed.push(`${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    }
  };

  // F — watchdog three-stage logic
  check("F1 normal buffered path never stalls", r.f_normal_buffered, 0);
  check("F2 no stall before 4s deadline", r.f_before_deadline, 0);
  check("F2 stall fires at 4s", r.f_at_deadline, 1);
  check("F2 stall fires exactly once", r.f_stays_once, 1);
  check("F3 slow network (no FragLoaded) never stalls", r.f_slow_network, 0);
  check("F4 playing clears the watchdog", r.f_playing_clears, 0);
  check("F5 hasBuffered predicate rescues at deadline", r.f_predicate_rescue, 0);
  check("F6 engine starts as hls.js", r.f_engine_before, "hls.js");
  check("F6 first stall retries in place", r.f_first_stall_action, "retry");
  check("F6 second stall falls back", r.f_second_stall_fell_back, true);
  check("F6 fallback reason recorded", r.f_fallback_state, "append_stall");
  check("F6 later sources go native", r.f_engine_after, "native");
  // F7–F11 — fault injection for the four-state verdicts and second arm
  check("F7 append in flight gets one grace window", r.f_append_hung_grace, 0);
  check("F7 append-hung fires after grace", r.f_append_hung_fires, 1);
  check("F7 append-hung state label", r.f_append_hung_state, "append-hung");
  check("F7 append-hung fires exactly once", r.f_append_hung_once, 1);
  check("F8 appended-no-buffer fires at deadline", r.f_appended_no_buffer_fires, 1);
  check("F8 appended-no-buffer state label", r.f_appended_no_buffer_state, "appended-no-buffer");
  check("F9 no buffered-no-play before 4s", r.f_buffered_no_play_before, 0);
  check("F9 buffered-no-play fires at 4s", r.f_buffered_no_play_fires, 1);
  check("F9 buffered-no-play state label", r.f_buffered_no_play_state, "buffered-no-play");
  check("F9 buffered-no-play fires exactly once", r.f_buffered_no_play_once, 1);
  check("F10 will gate blocks second arm", r.f_will_gate_blocks, 0);
  check("F11 playing clears second arm", r.f_playing_clears_second_arm, 0);

  // C — density-based SR tiering
  check("C high-density 1080p -> off", r.c_1080p_high_density, "off");
  check("C low-density 1080p -> crisp", r.c_1080p_low_density, "crisp");
  check("C low-density 720p -> natural", r.c_720p_low_density, "natural");
  check("C sampled starved 720p (bpp .042) -> crisp", r.c_sample_starved_720p, "crisp");
  check("C sampled mid 1080p (bpp .097) -> natural", r.c_sample_mid_1080p, "natural");
  check("C sampled healthy 720p (bpp .128) -> natural", r.c_sample_healthy_720p, "natural");
  check("C no-density 720p -> natural", r.c_no_density_720, "natural");
  check("C no-density 1080p -> off", r.c_no_density_1080, "off");
  check("C short<=480 -> crisp regardless of density", r.c_low_res, "crisp");
  check("C pref off -> off", r.c_pref_off, "off");
  check("C unknown size -> natural", r.c_unknown_size, "natural");
  check("C demote ladder", r.c_demote, ["natural", "off", "off", "off"]);

  await writeFile(join(output, "report.json"), JSON.stringify({ report, results: r }, null, 2));
  if (report.failed.length) {
    console.error(`playback-engines: ${report.failed.length} FAILED\n${report.failed.join("\n")}`);
    process.exit(1);
  }
  console.log(`playback-engines: ${report.passed.length} checks passed`);
} finally {
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
}
