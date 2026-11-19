import { markStartupReady } from "./legacyRuntime";
import { initAutoLine } from "./shared/network/autoLine";
import React, { lazy, Suspense, useCallback, useLayoutEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { AppProvider } from "./shared/model/store";
import { invoke } from "@tauri-apps/api/core";
import "./index.css";
import { initPlaybackLog, installPlaybackPageEvents, tracePlayback } from "./shared/diagnostics/playbackDiagnostics";
import { APP_VERSION, LOCAL, logLine, platform, webviewVersion } from "./shared/api/api";
import { installLayoutDiagnostics } from "./shared/diagnostics/layoutDiagnostics";
import { scheduleGpuProbe } from "./shared/diagnostics/gpuProbe";
import { registerSrProbeV2 } from "./features/playback/srProbe";
import { hasAcceptedAgreement } from "./shared/storage/usageAgreement";
import { setFetchPage } from "./features/sources/adapters/fetchPage";

const loadAcceptedApp = () => import("./app/AcceptedApp");
const AcceptedApp = lazy(loadAcceptedApp);

installPlaybackPageEvents();

/* 多源取页通道接线（Muse 2026-11-19 根治包）：Rust source_fetch 命令已落地
 * （生产网络栈：目标校验/DNS 固定/逐跳重定向复检＋4MB 上限），在此一处注入，
 * 全部源适配器经 fetchPage 取页生效；契约见 features/sources/adapters/fetchPage.ts。 */
setFetchPage((url) => invoke<string>("source_fetch", { url }));

/* 运行期错误统一落到 debug.log，便于自查 */
function report(kind: string, msg: string) {
  invoke("debug_log", { msg: `[${kind}] ${msg}` }).catch(() => {});
  tracePlayback(`app.${kind}`, { detail: msg });
}
window.addEventListener("error", (e) => {
  report("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  report("reject", String((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
});

let bootDiagnosticsStarted = false;
function scheduleBootDiagnostics() {
  if (bootDiagnosticsStarted) return;
  bootDiagnosticsStarted = true;
  window.requestAnimationFrame(() => {
    void initPlaybackLog();
    const hasMediaSource = "MediaSource" in window || "ManagedMediaSource" in window;
    /* 环境指纹：写进始终记录的 debug.log。用户复制诊断时不用再自报版本、平台、内核版本 */
    logLine(
      `[env] ver=${APP_VERSION} platform=${platform} webview=${webviewVersion} ` +
        `engine=${hasMediaSource ? "hls.js" : "native"} ` +
        `mss=${"MediaSource" in window ? "y" : "n"} media=${LOCAL} ` +
        `screen=${screen.width}x${screen.height} dpr=${devicePixelRatio} lang=${navigator.language}`,
    );
    /* 环境指纹也进结构化日志（开诊断后不会只有一行空跑） */
    tracePlayback("app.env", {
      ver: APP_VERSION, platform, webview: webviewVersion,
      engine: hasMediaSource ? "hls.js" : "native",
      media_source: "MediaSource" in window, managed_media_source: "ManagedMediaSource" in window,
      media_scheme: LOCAL.split(":")[0], screen: `${screen.width}x${screen.height}`,
      dpr: devicePixelRatio, lang: navigator.language,
    });
    installLayoutDiagnostics();
    /* WebGPU 探针（Muse 2026-11-18 U3）：每会话后台自动跑一次——此处
     * 只登记调度，实际执行推迟到浏览器空闲，不阻塞启动与起播；结果
     * 记账本并缓存，诊断报告只读缓存（见 gpuProbe.ts 旁路纪律）。
     * 探针 v2（fix2 超分检证）：先把 features 层的实现注册进 v2 槽，
     * v1 完成后由 gpuProbe 顺带调度（见 srProbe.ts）。 */
    registerSrProbeV2();
    scheduleGpuProbe();
  });
}

function AcceptedAppHost({ onReady }: { onReady: () => void }) {
  useLayoutEffect(onReady, [onReady]);
  return <AcceptedApp />;
}

/* iOS 底部留白：改用 CSS 100dvh（见 index.css）动态跟踪可视高度。
   不再用 JS 在启动时钉死 html 高度——启动瞬间 visualViewport.height 尚未
   完成布局，抓到错误值会把 html 高度锁死，正是「底部留白、旋转一次才恢复」的根因。 */

/* Muse 2026-11-18 (2.2.0 合并, 移植 2.1.1 开场直进): 移除 StartupGate——
 * 定版语义是开场直进、不被开屏动画/协议门拦；协议全文保留在设置页可查。
 * 冷启动提速（App 预挂载）不依赖 Gate,直进同样受益。 */
function AcceptedApplication() {
  /* 跟版合并（Muse 2026-11-18）：直进口径不变，但上游 index.html 新增的
   * ES5 启动看门狗要靠 markStartupReady 解除、环境指纹靠
   * scheduleBootDiagnostics 落盘——原由 StartupReady 调用，现随直进在此补回，
   * 否则看门狗超时会误报启动失败面板。 */
  React.useEffect(() => { markStartupReady(); scheduleBootDiagnostics(); initAutoLine(); }, []);
  return <AppProvider><App /></AppProvider>;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AcceptedApplication />
  </React.StrictMode>,
);
// 已签署协议的冷启动：在首帧提交后并行预热业务入口 chunk，不阻塞启动动画首帧上屏。
if (hasAcceptedAgreement()) void loadAcceptedApp();
