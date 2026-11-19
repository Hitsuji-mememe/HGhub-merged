/* 吃瓜详情页 D2 夹具（Muse 2026-11-19 最终版D2线）：真实 PostDetail +
 * 确定性 mock IPC。与 baselines 夹具的差别：api_post_playback 成功解析
 * 出一段视频地址——baselines 夹具恒拒绝解析（src 恒空），测不到
 * 「有视频时」的封面按钮态与点击才播。本夹具专供
 * scripts/test-post-detail.mjs：断言 DOM 顺序（标题/标签/介绍在
 * 播放器之前）、未点击无视频装载、封面框计算圆角为 0（圆罩回归）。 */
import React from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import { PostDetail } from "../src/features/posts/Posts";
import "../src/index.css";

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
        case "api_post":
          return Promise.resolve({
            id: Number(args.id) || 100,
            title: "D2夹具帖子标题：先文后视频顺序断言用",
            cover: "https://fixture.invalid/cover.jpg",
            tags: ["夹具标签甲", "夹具标签乙"],
            created_at: "2026-11-18 10:00:00", publish_time: "2026-11-18 12:00:00",
            hot: 1234, counts: { like: 10, comment: 3, collect: 2 },
            content: "<p>夹具介绍正文第一段：用户先读这段文字。</p><p>夹具介绍正文第二段：读完才看视频。</p>",
            video_url: "",
          });
        case "api_post_playback":
          return Promise.resolve({ videos: [{ url: "https://fixture.invalid/movie.mp4" }] });
        case "api_post_comments":
          return Promise.resolve({ items: [], pagination: { page: 1, pages: 1, size: 20, total: 0 } });
        default:
          return Promise.resolve({});
      }
    },
  },
});

createRoot(document.querySelector("#root")!).render(
  <React.StrictMode>
    <AppProvider>
      <div style={{ position: "relative", width: "100vw", height: "100dvh" }}>
        <PostDetail id={100} onBack={() => {}} active />
      </div>
    </AppProvider>
  </React.StrictMode>,
);
