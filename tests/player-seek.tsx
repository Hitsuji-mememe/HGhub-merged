import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Feed } from "../src/features/feed";
import { AppProvider } from "../src/shared/model/store";
import { api } from "../src/shared/api/api";
import "../src/index.css";
import { flushPlaybackLog, initPlaybackLog, playbackLogApi, setPlaybackLog } from "../src/shared/diagnostics/playbackDiagnostics";
import Settings from "../src/features/settings/Settings";
import Hls from "hls.js";
import { Player, VideoSurface } from "../src/features/playback";

// 仅将自定义媒体协议映射到本地测试服务器；播放器、HLS 和鼠标事件均使用真实实现。
const proxy = new URLSearchParams(location.search).get("proxy") || "http://127.0.0.1:17779";
const open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, target: string | URL, async: boolean = true, user?: string | null, credential?: string | null) {
  const url = new URL(String(target), location.href);
  if (url.hostname === "hg.localhost" || (url.hostname === "localhost" && url.protocol === "hg:")) {
    target = `${proxy}${url.pathname}${url.search}`;
  }
  return open.call(this, method, target, async, user, credential);
};

const fixture = {
  rejectPlaybackApi: new URLSearchParams(location.search).has("api-failure"),
  seeks: [] as number[], errors: [] as string[],
  setActive: (_active: boolean) => {},
  setMounted: (_mounted: boolean) => {},
  logs: [] as { event: string; data: Record<string, unknown> }[],
  setLogging: setPlaybackLog,
  flushLogs: flushPlaybackLog,
  rejectLoggingSave: false,
  pauseBuffering: () => testHls?.pauseBuffering(),
  resumeBuffering: () => testHls?.resumeBuffering(),
  suppressMediaRecovery: false,
  mediaRecoveryCalls: 0,
  stopForMediaFailure: () => { fixture.suppressMediaRecovery = true; testHls?.stopLoad(); },
  failMedia: () => testHls?.trigger(Hls.Events.ERROR, {
    type: Hls.ErrorTypes.MEDIA_ERROR,
    details: Hls.ErrorDetails.BUFFER_APPEND_ERROR,
    fatal: true,
    error: new Error("fixture media failure"),
  }),
  engineState: () => ({ loading: testHls?.loadingEnabled, buffering: testHls?.bufferingEnabled, levels: testHls?.levels.length }),
};
let testHls: Hls | undefined;
const diagnosticTest = new URLSearchParams(location.search).has("diagnostics");
const legacyTest = new URLSearchParams(location.search).has("legacy");
const initiallyInactive = new URLSearchParams(location.search).has("inactive");
const delayedMount = new URLSearchParams(location.search).has("delayed-mount");
// issue #142 fit 回归：手机竖屏视口下按真实视口尺寸铺满播放面，
// 并跳过仅桌面端会成立的闲置进度条命中测试（移动端没有 .player-root.is-idle）。
const portraitFitTest = new URLSearchParams(location.search).has("portrait-fit");
if (diagnosticTest) {
  // Test-only handle: exercise the real engine's public API without rewriting production modules.
  const attach = Hls.prototype.attachMedia;
  Hls.prototype.attachMedia = function (...args) { testHls = this; return attach.apply(this, args); };
  // Simulate a persistent decoder failure without detaching MSE or allowing
  // fresh buffers to reset the application's bounded recovery budget.
  const recoverMediaError = Hls.prototype.recoverMediaError;
  Hls.prototype.recoverMediaError = function () {
    fixture.mediaRecoveryCalls += 1;
    if (!fixture.suppressMediaRecovery) recoverMediaError.call(this);
  };
  const startLoad = Hls.prototype.startLoad;
  Hls.prototype.startLoad = function (...args) {
    if (!fixture.suppressMediaRecovery) startLoad.apply(this, args);
  };
  let enabled = false;
  playbackLogApi.status = async () => ({ enabled, path: "playback.log", error: null });
  playbackLogApi.set = async (on) => {
    if (fixture.rejectLoggingSave) throw new Error("fixture: disk unavailable");
    return { enabled: enabled = on, path: "playback.log", error: null };
  };
  playbackLogApi.write = async entries => {
    if (!enabled) return;
    fixture.logs.push(...entries);
    const collect = (window as typeof window & { collectPlaybackLogs?: (entries: typeof fixture.logs) => Promise<void> }).collectPlaybackLogs;
    await collect?.(entries);
  };
  playbackLogApi.read = async () => fixture.logs.map(e => JSON.stringify(e)).join("\n");
  api.lineState = async () => ({ base: "https://fixture.invalid", default: "https://fixture.invalid", fixed: [] });
  void initPlaybackLog();
}
Object.assign(window, { playerSeekFixture: fixture });
document.addEventListener("seeking", (e) => {
  if (e.target instanceof HTMLVideoElement) fixture.seeks.push(e.target.currentTime);
}, true);
window.addEventListener("error", (e) => fixture.errors.push(e.message));
api.boot = async () => ({ user: null, logged_in: false, base: "https://fixture.invalid", strict_security: true });
api.play = async () => {
  if (fixture.rejectPlaybackApi) throw new Error("fixture playback API unavailable");
  return { id: 991, ep_num: 1, title: "Seek fixture", duration: 90, video_url: "https://media.fixture.invalid/list.m3u8" };
};
// 布局门禁需要多集形态（全屏底栏「选集」钮只在多集时出现）：?episodes=N 扩集数，默认 1 不影响既有场景。
const fixtureEpisodes = Math.max(1, Number(new URLSearchParams(location.search).get("episodes")) || 1);
api.video = async () => ({
  id: 991, title: "Seek fixture", description: "", cover: "", tags: [], score: 0,
  episode_count: fixtureEpisodes, total_episodes: fixtureEpisodes,
  episodes: Array.from({ length: fixtureEpisodes }, (_, i) => ({ ep_num: i + 1, title: `ep${i + 1}`, duration: 90, status: 1 })),
  counts: { like: 0, collect: 0, comment: 0, hot: 0 },
  author: { id: 1, name: "Fixture" }, is_finished: true, is_original: 0,
});
// 评论夹具（布局门禁的抽屉文字对比度断言需要真实评论条目渲染）：三条与
// review-shots/02 同场景的示例评论，形状对齐 CommentPage 契约。
api.comments = async () => ({
  ep: 1,
  items: [
    { id: 1, user_id: 11, nickname: "夜航船", avatar: "", avatar_color: "", time: "2小时前", text: "第三集那个长镜头绝了，氛围感直接拉满。", like_count: 342, reply_count: 12, liked: false, reply_id: 0 },
    { id: 2, user_id: 23, nickname: "momo", avatar: "", avatar_color: "", time: "3小时前", text: "更新太慢了，一天一集不够看，先收藏了慢慢追。", like_count: 128, reply_count: 4, liked: false, reply_id: 0 },
    { id: 3, user_id: 37, nickname: "江城子", avatar: "", avatar_color: "", time: "5小时前", text: "男主这波操作属实没想到，反转来得太突然了。", like_count: 96, reply_count: 21, liked: false, reply_id: 0 },
  ],
  pagination: { page: 1, pages: 1, size: 20, total: 20 },
});
function Fixture() {
  const [active, setActive] = useState(!initiallyInactive);
  const [mounted, setMounted] = useState(!delayedMount);
  const [settings, setSettings] = useState(false);
  fixture.setActive = setActive;
  fixture.setMounted = setMounted;
  return <AppProvider>
    <div data-player-fixture data-active={active} style={portraitFitTest
      ? { position: "relative", width: window.innerWidth, height: window.innerHeight }
      : { position: "relative", width: 900, height: 540 }}>
      {mounted && (legacyTest
        ? <Player src="https://media.fixture.invalid/list.m3u8" autoPlay active={active} className="w-full h-full" diagnosticContext={{ video_id: 991, active }} />
        : delayedMount
          ? <VideoSurface src="https://media.fixture.invalid/list.m3u8" autoPlay active={active} className="w-full h-full" diagnosticContext={{ video_id: 991, active }} />
          : <Feed videoIds={[991]} mode="home" active={active} bottomInset={0} />)}
    </div>
    <button onClick={() => setActive((v) => !v)}>切换播放页激活状态</button>
    {diagnosticTest && <button onClick={() => setSettings(v => !v)}>诊断设置</button>}
    {settings && <div style={{ position: "relative", width: 900, height: 700 }}><Settings onBack={() => setSettings(false)} wide /></div>}
  </AppProvider>;
}
createRoot(document.querySelector("#root")!).render(<Fixture />);

// 自动检查真正的浏览器命中测试，而非仅匹配 CSS 字符串。
async function checkIdleSeekTarget() {
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    const video = document.querySelector("video");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="播放进度"]');
    if (video && input && video.currentTime > 0 && document.querySelector(".player-root.is-idle")) {
      const rect = input.getBoundingClientRect();
      if (document.elementFromPoint(rect.x + rect.width * .8, rect.y + rect.height / 2) !== input) {
        throw new Error("闲置进度条点击穿透到视频");
      }
      document.querySelector("#results")!.textContent = JSON.stringify({ passed: 1, failed: 0 });
      return;
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  throw new Error("等待播放或控制条隐藏超时");
}
if (!legacyTest && !initiallyInactive && !delayedMount && !portraitFitTest) void checkIdleSeekTarget().catch((error) => {
  fixture.errors.push(String(error));
  document.querySelector("#results")!.textContent = JSON.stringify({ passed: 0, failed: 1, error: String(error) });
});
