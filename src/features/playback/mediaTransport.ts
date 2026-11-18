import { invoke } from "@tauri-apps/api/core";
import { LOCAL, platform, playlist } from "../../shared/api/api";
import { tracePlayback } from "../../shared/diagnostics/playbackDiagnostics";

type PlaybackSource = { engine: "hls.js" | "native"; url: string; route: string };

/* ── 会话级原生降级（2026-11-18 收官批 F 项）──
 * append 卡死按 App 会话发作（坏会话整场全坏）：看门狗在同一会话内
 * 二次判死后置此标记，后续所有视频的 playbackSource 直接走 native
 * 引擎，不再经 hls.js/MMS。只置一次，事实写进 trace（web.playback.fallback），
 * 诊断报告结论行据此提示。进程重启即清零（新会话重新给 hls.js 机会）。 */
let nativeFallback: { reason: string; at: number } | null = null;

export function noteNativeFallback(reason: string): boolean {
  if (nativeFallback) return false;
  nativeFallback = { reason, at: Date.now() };
  tracePlayback("web.playback.fallback", { reason });
  return true;
}

export function nativeFallbackState(): { reason: string; at: number } | null {
  return nativeFallback;
}

/** 仅测试夹具用（fix2 B1）：会话降级是进程级单向状态，夹具需在
 * 场景间隔离重置；生产路径不调用。 */
export function resetNativeFallbackForTests(): void {
  nativeFallback = null;
}

/** Only our own media routes carry a wrapped upstream URL. An upstream ?u= is opaque. */
export function playbackSource(src: string, hlsSupported: boolean): PlaybackSource {
  let route = "";
  let direct = false;
  try {
    const source = new URL(src);
    if (source.href.startsWith(`${LOCAL}/`) && (source.pathname === "/hls" || source.pathname === "/seg")) {
      route = `${source.pathname}${source.search}${source.hash}`;
      direct = source.pathname === "/seg";
    }
  } catch { /* An unwrapped source is passed intact to the playlist route. */ }
  const url = route ? `${LOCAL}${route}` : playlist(src);
  if (!route) route = url.slice(LOCAL.length);
  return { engine: hlsSupported && !direct && !nativeFallback ? "hls.js" : "native", url, route };
}

/** Native AVFoundation cannot fetch WKURLSchemeHandler's hg:// resources. */
export function connectNativeMedia(video: HTMLVideoElement, source: PlaybackSource, callbacks: {
  isCurrent: () => boolean;
  onReady: () => void;
  onError: (message: string) => void;
}) {
  let disposed = false;
  const current = () => !disposed && callbacks.isCurrent();
  const clear = () => {
    video.pause();
    video.removeAttribute("src");
    video.load();
  };
  clear();
  const attach = (url: string) => {
    if (!current()) return;
    video.src = url;
    callbacks.onReady();
  };
  if (platform === "ios") {
    // Ask only when native playback needs it. Each attempt can retry a failed server start.
    void invoke<string>("media_http_origin").then(origin => {
      if (!current()) return;
      const parsed = new URL(origin);
      if (!parsed.port || !parsed.href.startsWith(`http://127.0.0.1:${parsed.port}/`)
        || parsed.pathname === "/" || parsed.search || parsed.hash) {
        throw new Error("Invalid local media origin");
      }
      attach(`${origin.replace(/\/$/, "")}${source.route}`);
    }).catch(() => {
      if (current()) callbacks.onError("本地媒体服务启动失败，请切换视频或重试");
    });
  } else attach(source.url);
  return () => {
    disposed = true;
    clear();
  };
}
