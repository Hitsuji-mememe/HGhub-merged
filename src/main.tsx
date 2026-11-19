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
import { recordFetchResult } from "./features/sources/adapters/fetchHealth";
import { FALLBACK_APP_VERSION, getActiveRegistry, getRegistryInfo, resolveRegistry } from "./features/sources/manifest";
import { sourceFetchAllowlistOrigins } from "./features/sources/allowlist";
import { getVersion } from "@tauri-apps/api/app";
import { sourceHealthLines } from "./features/sources/registryDiag";
import { registerSourceRegistryProvider, registerSourceHealthProvider } from "./shared/diagnostics/sourceRegistry";
import { createAdapter } from "./features/sources/adapters/index";
import { startSourceSelfCheckScheduler } from "./features/sources/healthCheck";

const loadAcceptedApp = () => import("./app/AcceptedApp");
const AcceptedApp = lazy(loadAcceptedApp);

installPlaybackPageEvents();

/* 多源取页通道接线（Muse 2026-11-19 根治包）：Rust source_fetch 命令已落地
 * （生产网络栈：目标校验/DNS 固定/逐跳重定向复检＋4MB 上限），在此一处注入，
 * 全部源适配器经 fetchPage 取页生效；契约见 features/sources/adapters/fetchPage.ts。
 * 飞行记录仪收口（同日）：包装层逐次埋点取页健康（成败/错误类别/耗时入
 * fetchHealth＋统一时间线 source.fetch），源在用户网络下的健康状态从
 * 诊断导出直接可见；埋点失败不影响取页（recordFetchResult 内部吞异常）。 */
setFetchPage(async (url, headers) => {
  const t0 = performance.now();
  try {
    /* 契约对齐（整改 D6.3）：headers 透传 Rust source_fetch（可选参，
     * 不传时不带该字段，Rust 侧 Option 缺省无头）。 */
    const html = await invoke<string>("source_fetch", headers ? { url, headers } : { url });
    recordFetchResult(url, true, Math.round(performance.now() - t0));
    return html;
  } catch (e) {
    recordFetchResult(url, false, Math.round(performance.now() - t0), String(e));
    throw e;
  }
});

/* 远程清单启动接通（Muse 2026-11-19 整改 D2，P0-3）：fetchPage 注入后
 * 后台解析注册表——真实 App 版本经 Tauri getVersion() 注入（minAppVersion
 * 门口径），失败回落 FALLBACK_APP_VERSION；异步不阻塞挂载，落定后 dispatch
 * hg:registry-changed，UI（SourceSwitcher/Category/Posts）订阅后改读
 * getActiveRegistry()。解析落定埋点 registry.applied 在 manifest.ts 内。 */
async function bootstrapRegistry(): Promise<void> {
  let appVersion = FALLBACK_APP_VERSION;
  try { appVersion = await getVersion(); } catch { /* 非 Tauri 环境回落 */ }
  try { await resolveRegistry({ appVersion }); } catch { /* resolveRegistry 内部已三段回退 */ }
  window.dispatchEvent(new Event("hg:registry-changed"));
}

/* source_fetch origin 白名单推送（Muse 2026-11-19 整改 D6.2；
 * 2026-11-19 fix321-F2c 改派生出处）：注册表落定（hg:registry-changed）
 * 时把白名单推给 Rust 命令 source_allowlist_set；名单内容不在此
 * 内联拼装、只消费 features/sources/allowlist.ts 的唯一派生
 * sourceFetchAllowlistOrigins（已启用且可取页源的 baseUrls ∪ 模板
 * 声明 origin——旧内联只拼 baseUrls，远程清单削掉 swag/redgifs 的
 * API origin 后两源 API 取页被 Rust 拒，验收 D 缺口 G1）。Rust 侧
 * 名单未设置时 source_fetch 一律拒绝，名单内才放行。推送失败不
 * 阻塞启动（取页会明确报错、可再触发）。 */
function pushSourceAllowlist(): void {
  const origins = sourceFetchAllowlistOrigins(getActiveRegistry().sources);
  invoke("source_allowlist_set", { origins }).catch(() => { /* 名单推送失败：source_fetch 将明确拒绝，不静默放行 */ });
}
window.addEventListener("hg:registry-changed", pushSourceAllowlist);
void bootstrapRegistry();

/* 源注册表诊断接线（Muse 2026-11-19 根治包·飞行记录仪收口）：注册表
 * 本体在 features/sources，诊断报告在 shared——经 provider 钩子注入
 * 版本串与每源健康行，报告的「状态快照」节据此呈现清单版本＋每源
 * maturity/生效 origin/最近取页，shared 不反向依赖 features。 */
registerSourceRegistryProvider(() => {
  const info = getRegistryInfo();
  return `清单 v${info.manifestVersion} · 来源 ${info.registrySource} · 内置 ${info.builtinCount} 源`;
});
registerSourceHealthProvider(() => sourceHealthLines());

/* 源健康自检调度（Muse 2026-11-19 fix321-F7）：启动后延迟静默分批，
 * 对已启用源用其自身适配器（createAdapter 生产路径：模板适配器经
 * fetchPage→Rust 取页＋当前线路）做列表＋详情探测，结果落盘只进
 * 诊断与源明细、无任何用户可见打扰；纯旁路——注册与自检异常都不
 * 影响启动与正常使用（healthCheck 内已吞异常，此处再兜一层）。 */
try {
  startSourceSelfCheckScheduler({ createAdapterFor: (def) => createAdapter(def) });
} catch { /* 自检调度注册失败不影响启动 */ }

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
