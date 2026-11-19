/* 吃瓜详情 F9 夹具（Muse 2026-11-19 3.2.1修复F9线）：真实 PostDetail +
 * 确定性 mock IPC，内容形态按真实吃瓜帖构造——长文正文（多段 HTML，
 * 页面可滚动多屏）、视频位于正文之后中段、playback 解析出 1 段地址
 * （多数帖形态）。变体：?kind=image 时 playback 解析为空（纯图帖），
 * 正文带多张图。供 scripts/test-post-detail-playback.mjs 断言不变量：
 * 点播放后滚动位置不变、起播后进度持续前进。 */
import React from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import { PostDetail } from "../src/features/posts/Posts";
import "../src/index.css";

const kind = new URLSearchParams(location.search).get("kind") || "video";
const longBody = Array.from({ length: 14 }, (_, i) =>
  `<h3>事件经过（第 ${i + 1} 节）</h3><p>这是夹具长文正文第 ${i + 1} 段：当事人回应、现场细节与网友热议都在这一段里展开，文字长度模拟真实吃瓜帖的阅读量，确保页面需要滚动多屏才能看到中段的视频区域，滚动位置断言才有意义。</p>`,
).join("");
const imageBody = Array.from({ length: 6 }, (_, i) =>
  `<p>纯图帖正文第 ${i + 1} 段：先看文字再看图。</p><p><img src="https://fixture.invalid/pic${i + 1}.jpg" alt="图 ${i + 1}"></p>`,
).join("");

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
            title: "F9夹具帖子：长文吃瓜帖点播滚动与起播断言用",
            cover: "https://fixture.invalid/cover.jpg",
            tags: ["夹具标签甲", "夹具标签乙"],
            created_at: "2026-11-18 10:00:00", publish_time: "2026-11-18 12:00:00",
            hot: 4321, counts: { like: 10, comment: 3, collect: 2 },
            content: kind === "image" ? imageBody : longBody,
            video_url: "",
          });
        case "api_post_playback":
          return Promise.resolve(kind === "image" ? { videos: [] } : { videos: [{ url: "https://fixture.invalid/movie.m3u8" }] });
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
