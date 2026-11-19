/* 关键页面截图基线夹具（Muse 2026-11-19 fix2 B4）：真实页面组件 +
 * 确定性 mock IPC，供 scripts/capture-baselines.mjs 逐页截图存档。
 * 基线的用途是版式/结构回归对照（哪页塌了、控件丢了），不是像素级
 * 视觉验收：封面走空地址呈占位态、数据为固定假数据，跨环境可复现。
 * 播放页/控制层/横屏/弹层由 player-seek 夹具承担（见捕获脚本）。 */
import React from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import { PostsPage, PostDetail } from "../src/features/posts/Posts";
import { ChannelPage } from "../src/features/category/Category";
import Settings from "../src/features/settings/Settings";
import "../src/index.css";

const post = (id: number) => ({
  id, title: `基线帖子标题 ${id}：用于版式对照的固定文本，长度接近真实标题`,
  cover: "", tags: ["基线", "对照"], desc: "基线摘要文本。",
  created_at: "2026-11-18 10:00:00", publish_time: "2026-11-18 12:00:00",
  hot: 1000 + id, like_count: 10, comment_count: 3, collect_count: 2,
});
const card = (id: number) => ({
  id, title: `基线短剧 ${id}`, cover: "", tags: ["都市"], score: 9.1, hot: 5000,
  episode_count: 24, total_episodes: 24, is_finished: true, is_original: 0,
  like_count: 100, comment_count: 20, collect_count: 30,
});
const paged = (items: unknown[], total: number) => ({
  items, pagination: { page: 1, pages: Math.max(1, Math.ceil(total / 20)), size: 20, total },
});

Object.assign(window, {
  __TAURI_INTERNALS__: {
    invoke(cmd: string, args: Record<string, unknown> = {}) {
      switch (cmd) {
        case "app_boot":
          return Promise.resolve({ user: null, logged_in: false, base: "https://fixture.invalid" });
        case "debug_log":
          return Promise.resolve();
        case "line_state":
          return Promise.resolve({ base: "https://fixture.invalid", fixed: [], mode: "auto" });
        case "api_post_category":
          return Promise.resolve(paged(Array.from({ length: 20 }, (_, i) => post(100 + i)), 439));
        case "api_post":
          return Promise.resolve({ ...post(Number(args.id) || 100), content: "<p>基线正文段落。</p>", video_url: "" });
        case "api_post_playback":
          return Promise.reject("视频不存在或不可播放");
        case "api_category":
          return Promise.resolve(paged(Array.from({ length: 20 }, (_, i) => card(200 + i)), 1676));
        case "api_original_videos":
          return Promise.resolve(paged(Array.from({ length: 20 }, (_, i) => card(300 + i)), 245));
        default:
          return Promise.resolve({});
      }
    },
  },
});

function Fixture() {
  const view = new URLSearchParams(location.search).get("view") || "posts";
  const noop = () => {};
  return (
    <AppProvider>
      <div style={{ position: "relative", width: "100vw", height: "100dvh" }}>
        {view === "posts" && <PostsPage onBack={noop} wide={false} />}
        {view === "post" && <PostDetail id={100} onBack={noop} active />}
        {view === "channel" && <ChannelPage cate="ai-duanju" name="AI成人短剧" onBack={noop} wide={false} />}
        {view === "settings" && <Settings onBack={noop} wide={false} />}
      </div>
    </AppProvider>
  );
}
createRoot(document.querySelector("#root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
