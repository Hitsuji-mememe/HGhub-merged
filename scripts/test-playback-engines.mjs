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
  check("F5 hasBuffered predicate rescues at append deadline", r.f_predicate_rescue, 0);
  check("F5 handed-off second arm still judges buffered-no-play", r.f_predicate_handoff_stall, 1);
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
  check("F12 gate suspends without stalling", r.f_gate_suspends_no_stall, 0);
  check("F12 gate leaves watchdog suspended", r.f_gate_suspended, true);
  check("F12 resumed watchdog quiet before deadline", r.f_resumed_before_deadline, 0);
  check("F12 resumed watchdog stalls on renewed freeze", r.f_resumed_stall_fires, 1);
  check("F13 append deadline hands off without stalling", r.f_transfer_no_stall_yet, 0);
  check("F13 handed-off second arm stalls", r.f_transfer_stall_fires, 1);
  check("F13 handed-off state label", r.f_transfer_state, "buffered-no-play");

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

  // D — SR black-frame self-check pure predicates
  check("D content rect excludes side bars (portrait in landscape)", r.d_rect_wide_canvas, { x: 656.25, y: 0, w: 607.5, h: 1080 });
  check("D content rect excludes top/bottom bars (landscape in portrait)", r.d_rect_tall_canvas, { x: 0, y: 656.25, w: 1080, h: 607.5 });
  check("D content rect is full canvas for cover", r.d_rect_cover, { x: 0, y: 0, w: 1920, h: 1080 });
  check("D rVFC pending means no confirmed frame", r.d_frame_rvfc_pending, false);
  check("D rVFC seen confirms frame", r.d_frame_rvfc_seen, true);
  check("D no-rVFC fallback accepts readyState>=2 with size", r.d_frame_fallback_ready, true);
  check("D no-rVFC fallback rejects readyState<2", r.d_frame_fallback_notready, false);

  // U1 — automatic tiering: hysteresis perf step + compositor floor decision
  check("U1 bad window demotes immediately", r.u_demote_fast, "demote");
  check("U1 first good window does not promote", r.u_promote_first_good, "none");
  check("U1 neutral window resets good streak", r.u_promote_neutral_resets, "none");
  check("U1 streak restarts after neutral", r.u_promote_streak_restarts, "none");
  check("U1 three consecutive good windows promote", r.u_promote_after_3_good, "promote");
  check("U1 demote capped at floor", r.u_demote_at_floor, [2, "none"]);
  check("U1 auto-off without reason defaults to judged (true off)", r.u_filter_auto_off, null);
  check("U1 no floor when user explicitly off", r.u_filter_pref_off, null);
  check("U1 no filter while WebGL presenting", r.u_filter_webgl_presenting, null);
  check("U1 floor engages when perf-demoted to off", r.u_filter_demoted_off, "natural");
  check("U1 svg fallback keeps mode filter", r.u_filter_svg_fallback, "cinema");

  check("U2 judged off is true off (no filter)", r.u2_judged_true_off, null);
  check("U2 demoted off keeps SVG floor", r.u2_demoted_floor, "natural");
  check("U2 unavailable off keeps SVG floor", r.u2_unavailable_floor, "natural");
  check("U2 pipeline names SVG floor honestly", r.u2_pipeline_svg, "svg-natural");
  check("U2 pipeline none when judged off", r.u2_pipeline_none, "none");
  check("U2 pipeline webgl-crisp", r.u2_pipeline_webgl, "webgl-crisp");
  check("U2 pipeline webgpu wins over webgl", r.u2_pipeline_webgpu, "webgpu");
  check("S sampler median of first 3 frags", r.s_median, 800_000);
  check("S sampler carries fps+codec", r.s_fps_codec, [30, "avc1.640028"]);
  check("S sampler resamples on level switch", r.s_level_switch_resamples, 2_000_000);
  check("S sampler reset clears density", r.s_reset_clears, null);
  check("H seed takes max measured kbps as bps", r.h_seed_from_round, 4_500_000);
  check("H seed null without round", r.h_seed_empty, null);
  check("H config uses seeded estimate", r.h_config_seeded, 4_500_000);
  check("H config falls back to default estimate", r.h_config_fallback, 500_000);
  check("H default estimate is hls.js 500kbps", r.h_default_estimate, 500_000);
  check("H start level locks highest", r.h_lock_highest, [3, 3]);
  check("H first rendition format", r.h_first_rendition, "第 4/4 档 · 1920x1080 · 8000kbps");

  check("G gates v2 all pass", r.g_all_pass, true);
  check("G gates v2 720p P90 blocks", r.g_p90_720_blocks, false);
  check("G gates v2 1080p avg blocks", r.g_1080_avg_blocks, false);
  check("G gates v2 deviceLost blocks", r.g_device_lost_blocks, false);
  check("G gates v2 dropped rate blocks", r.g_dropped_blocks, false);
  check("G gates v2 tail ratio blocks", r.g_tail_blocks, false);
  check("G gates v2 no path blocks", r.g_no_path_blocks, false);

  check("K scoped play key format", r.k_scoped_key, "acct:3:7:42:2");
  check("K scoped key changes with line epoch", r.k_scoped_key_changes_with_epoch, true);
  check("K scoped key changes with account", r.k_scoped_key_changes_with_account, true);
  check("K FIFO evicts oldest beyond capacity", r.k_fifo_evicts_oldest, ["k2", "k3", "k4"]);
  check("K FIFO update does not evict", r.k_fifo_update_keeps, ["k2", "k3", "k4"]);
  check("K record capped to capacity", r.k_record_capped, 2);
  check("K prewarm first attempt due", r.k_prewarm_first_attempt, true);
  check("K prewarm success never retries", r.k_prewarm_ok_never, false);
  check("K prewarm failure within 30s not due", r.k_prewarm_too_soon, false);
  check("K prewarm failure after 30s due once", r.k_prewarm_retry_due, true);
  check("K prewarm retry exhausted", r.k_prewarm_retry_exhausted, false);

  check("T throughput quiet before 5 frags", r.t_quiet_before_5, 0);
  check("T throughput flushes median at 5 frags", r.t_flush_at_5, [["https://line.example", 8_000_000]]);
  check("T throughput flush sends remainder", r.t_flush_remainder, 2);
  check("T origin parsed from play URL", r.t_origin_parse, "https://line.example");
  check("T origin empty on bad URL", r.t_origin_bad, "");

  check("L ledger records while instance active", r.l_record_while_active, true);
  check("L ledger rejects late event after unregister", r.l_late_rejected, false);
  check("L droppedLate increments on late event", r.l_dropped_late_delta, 1);
  check("L window contains in-life event", r.l_window_has_load, true);
  check("L window excludes late event", r.l_window_has_late, false);
  check("L integrity validation is pure (same snapshot, same result)", r.l_validate_pure, true);
  check("L retired instance events counted under new name", r.l_retired_counted, true);
  check("L orphanedInstance field removed", r.l_no_orphan_field, true);

  // W — wiring-level stall escalation matrix (fix2 B1)
  check("W1 first stall retries in place", r.w1_first_stall_retry, ["append_stall"]);
  check("W1 attempt incremented", r.w1_attempt_after, 1);
  check("W1 stall traced before acting", r.w1_traced, [{ state: "not-started", attempt: 0 }]);
  check("W2 second stall retries via fallback", r.w2_second_stall_retry, ["append_stall_fallback"]);
  check("W2 session fallback noted", r.w2_fallback_noted, true);
  check("W3 exhausted surfaces message", r.w3_exhausted_message, ["视频卡死且自动恢复已用尽，请点重试或切换线路"]);
  check("W3 exhausted does not retry", r.w3_no_retry, []);
  check("W4 user-unwanted stall does not retry", r.w4_paused_no_retry, []);
  check("W4 user-unwanted stall does not trace", r.w4_paused_no_trace, []);
  check("W4 attempt unchanged", r.w4_attempt_unchanged, 0);
  check("W5 stale instance stall dropped (retry)", r.w5_stale_no_retry, []);
  check("W5 stale instance stall dropped (exhausted)", r.w5_stale_no_exhausted, []);
  check("W6 paused_by_user blocks escalation", r.w6_user_pause_no_retry, []);
  check("W6 paused_by_user attempt unchanged", r.w6_user_pause_attempt, 0);
  check("W7 paused_by_system still escalates", r.w7_system_pause_retry, ["append_stall"]);
  check("W8 buffered-no-play escalates", r.w8_buffered_no_play_retry, ["append_stall"]);
  check("W8 buffered-no-play state label", r.w8_buffered_no_play_state, ["buffered-no-play"]);
  check("W9 deadline predicate rescue (append window)", r.w9_predicate_rescue, []);
  check("W9 handed-off second arm escalates", r.w9_handoff_retry, ["append_stall"]);

  await page.waitForFunction(() => (window).__keepAlive !== undefined, null, { timeout: 15000 });
  const ka = await page.evaluate(() => (window).__keepAlive);
  check("KA user pause during transition: zero keepAlive plays in 1.2s window", ka.pausedPlays, 0);
  try { assert.ok(ka.resumedPlays >= 3, `want >=3, got ${ka.resumedPlays}`); report.passed.push("KA unpaused transition still resumes playback"); }
  catch { report.failed.push(`KA unpaused transition still resumes playback: got ${ka.resumedPlays}, want >=3`); }

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
