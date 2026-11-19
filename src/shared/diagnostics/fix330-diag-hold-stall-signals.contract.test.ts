/**
 * 停滞判读埋点补缺契约测试（Muse 2026-11-19 3.3.0批诊断标尺线；
 * 新增测试经维护者在任务书中授权，AGENTS 不变量 11）。
 * 运行：node src/shared/diagnostics/fix330-diag-hold-stall-signals.contract.test.ts
 *
 * 背景（suspended-items-investigation 问题 A 标红项/候选 5）：append
 * 停滞判读缺两路信号。逐环复核后的实情（本契约钉住的口径）：
 * ① video emptied/abort 并非全仓零监听——它们混在 usePlayerDiagnostics
 *    的通用 media 事件表里、经 `media.${e.type}` 动态拼接入账，事件名
 *    无字面形态、无判读载荷，静态检索与判读都无从下手（调查按字面名
 *    grep 得「零命中」即源于此）。本线把两事件提为显式专用埋点：
 *    字面名 media.emptied / media.abort＋生命周期判读载荷（readyState/
 *    networkState/媒体错误码/缓冲末端/seeking），装配点仍是两播放面
 *    共用的 usePlayerDiagnostics（经 usePlaybackKernel），元素随组件
 *    挂载/卸载同生命周期，只入账本、零自动处置。
 * ② 内存压力：WKWebView/WebKit 不向 Web 内容暴露内存压力事件
 *    （WebKit 的 MemoryPressureHandler 只在原生进程内响应、不通知
 *    页面 JS；iOS 超限时 WebContent 进程被 jetsam 直接终止、页面无
 *    从记录）；performance.memory 与 navigator.deviceMemory 仅为
 *    Chromium 系用量仪表、非事件源；本仓 Tauri 桥亦无原生内存警告
 *    暴露（src-tauri 全仓零命中）。结论＝本环境无可用信号：只在
 *    installPlaybackPageEvents 落一行 memory.signal_check 能力查实
 *    记录，不编造 memory.pressure 一类事件源、不轮询、不处置。
 *    旧码无专用埋点字面名、无查实记录 → 本契约在旧码上先红。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mediaLifecycleTraceData, memoryPressureSignalCheck } from "./mediaLifecycle.ts";

/* ── 纯函数：生命周期判读载荷逐字段映射 ─────────────────────────── */
{
  const d = mediaLifecycleTraceData({ readyState: 0, networkState: 3, errorCode: 4, bufferedEnd: null, seeking: false });
  assert.deepEqual(d, { ready_state: 0, network_state: 3, media_error: 4, buffered_end: null, seeking: false }, "emptied/abort 判读载荷逐字段落盘形态");
  const d2 = mediaLifecycleTraceData({ readyState: 3, networkState: 1, errorCode: null, bufferedEnd: 12.5, seeking: true });
  assert.deepEqual(d2, { ready_state: 3, network_state: 1, media_error: null, buffered_end: 12.5, seeking: true }, "有缓冲/无错误形态同样逐字段");
}

/* ── 纯函数：内存压力信号查实——用量仪表存在与否都不构成事件源 ── */
{
  assert.deepEqual(
    memoryPressureSignalCheck({ performanceMemory: false, deviceMemory: false }),
    { pressure_event_available: false, heap_usage_api: false, device_memory_api: false },
    "WKWebView 形态：两仪表皆无、压力事件不可用（如实记录）",
  );
  assert.deepEqual(
    memoryPressureSignalCheck({ performanceMemory: true, deviceMemory: true }),
    { pressure_event_available: false, heap_usage_api: true, device_memory_api: true },
    "Chromium 形态：用量仪表存在也不冒充压力事件源（不轮询、不编造）",
  );
}

/* ── 生产接线断言（源码形态，仿 fix321-f3 先例） ─────────────────── */
{
  const diag = readFileSync(new URL("./playbackDiagnostics.ts", import.meta.url), "utf8");
  assert.ok(diag.includes('"media.emptied"'), "emptied 有字面名专用埋点（旧码仅动态拼接、零字面命中＝红）");
  assert.ok(diag.includes('"media.abort"'), "abort 有字面名专用埋点");
  assert.ok(diag.includes("mediaLifecycleTraceData("), "专用埋点带生命周期判读载荷（mediaLifecycleTraceData）");
  assert.ok(diag.includes('"memory.signal_check"'), "installPlaybackPageEvents 落内存信号能力查实记录");
  assert.ok(diag.includes("memoryPressureSignalCheck("), "查实记录经纯函数拼装（唯一口径）");
  assert.ok(!diag.includes('"memory.pressure"'), "不编造 memory.pressure 事件源");
  /* 装配点覆盖两播放面：usePlayerDiagnostics 由共用内核消费、
   * VideoSurface/Player 两面同走 usePlaybackKernel（元素更换/重挂
   * 随组件生命周期重新装配，不只挂一面）。 */
  const kernel = readFileSync(new URL("../../features/playback/usePlaybackKernel.ts", import.meta.url), "utf8");
  assert.ok(kernel.includes("usePlayerDiagnostics"), "共用内核装配 usePlayerDiagnostics（两播放面同一装配点）");
  /* 零自动处置：诊断装配文件不得引入恢复/降级消费方。 */
  assert.ok(!diag.includes("useProxyPlaybackRecovery") && !diag.includes("noteNativeFallback"), "专用埋点只入账本：诊断装配不接恢复/降级处置");
}

console.log("fix330-diag-hold-stall-signals.contract: all assertions passed");
