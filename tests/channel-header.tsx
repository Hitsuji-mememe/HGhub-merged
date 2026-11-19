/**
 * 页头层数／分类页残行夹具（Muse 2026-11-20 fix331/covers-header）。
 *
 * scene=video：挂载真实 ChannelPage（cate="video:hanime-tv"，即图 1
 * 的同构容器），适配器取页经 setFetchPage 注入合成目录；resolve 的
 * POST 通道不注入 → 详情落 error 态，与真机截图 1 同状态（取流失败
 * 呈现）。场景断言：列表态外层页头恰一层；详情打开后外层页头必须
 * 让位（0 层）、只剩内层「返回列表」一枚返回键；返回列表后恢复。
 *
 * scene=category：挂载真实分类总览（移动形态），静态测量页头与吃瓜
 * 源切换器之间的全部可见元素几何，找「被压扁且内容被裁」的残行；
 * 并提供把吃瓜区头滚动到半裁位置的复现动作（__hdr.clipGuaHeader）。
 */
import React from "react";
import { createRoot } from "react-dom/client";
import Category, { ChannelPage } from "../src/features/category/Category";
import { AppProvider } from "../src/shared/model/store";
import { setFetchPage } from "../src/features/sources/adapters/fetchPage";
import "../src/index.css";

Object.assign(window, {
  __TAURI_INTERNALS__: {
    invoke(cmd: string, _args: Record<string, unknown> = {}) {
      if (cmd === "app_boot") return Promise.resolve({ user: null, logged_in: false, base: "https://fixture.invalid" });
      if (cmd === "debug_log") return Promise.resolve();
      if (["api_category", "api_original_videos", "api_post_category"].includes(cmd)) {
        return Promise.resolve({
          items: [{
            id: 991, title: "合成条目", cover: "", tags: [], score: 0, hot: 0,
            episode_count: 1, total_episodes: 1, is_finished: true, is_original: 0,
            like_count: 0, comment_count: 0, collect_count: 0,
          }],
          pagination: { page: 1, pages: 1, size: 8, total: 1 },
        });
      }
      return Promise.reject(`Unexpected IPC: ${cmd}`);
    },
  },
});

setFetchPage(async (url: string) => {
  if (url.includes("search_hvs")) {
    return JSON.stringify([
      { slug: "fixture-alpha", name: "合成条目甲", cover_url: "https://pic.fixture.invalid/a.jpg", created_at_unix: 200, views: 3, tags: [] },
      { slug: "fixture-beta", name: "合成条目乙", cover_url: "https://pic.fixture.invalid/b.jpg", created_at_unix: 100, views: 1, tags: [] },
    ]);
  }
  throw new Error("fixture offline");
});

const scene = new URLSearchParams(location.search).get("scene") ?? "video";

function bandScan() {
  const heading = document.querySelector(".ios-page-heading");
  const switcher = document.querySelector('[role="group"][aria-label="吃瓜数据源切换"]');
  if (!heading || !switcher) return null;
  const top = heading.getBoundingClientRect().bottom;
  const bottom = switcher.getBoundingClientRect().top;
  const out: { tag: string; cls: string; height: number; clipped: boolean; text: string }[] = [];
  document.querySelectorAll("body *").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.height <= 0 || r.bottom <= top || r.top >= bottom) return;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return;
    const clipped = el.scrollHeight > el.clientHeight + 2 && s.overflowY === "hidden";
    out.push({
      tag: el.tagName.toLowerCase(),
      cls: (el.getAttribute("class") ?? "").slice(0, 60),
      height: Math.round(r.height),
      clipped,
      text: (el.textContent ?? "").trim().slice(0, 16),
    });
  });
  return { top, bottom, elements: out };
}

Object.assign(window, {
  __hdr: {
    state() {
      return {
        headers: document.querySelectorAll(".ios-subpage-header").length,
        backList: document.querySelectorAll('[aria-label="返回列表"]').length,
        detailError: document.body.textContent?.includes("播放地址获取失败") ?? false,
        cards: document.querySelectorAll('[data-ui="media-grid"] > *').length,
        band: bandScan(),
      };
    },
    /* 把吃瓜区头滚到滚动容器顶缘半裁位置（模拟真机截图 2 的滚动位形），
     * 返回该区头在容器顶缘之上的可见残高（px）。 */
    clipGuaHeader() {
      const section = document.querySelector('section[aria-label="吃瓜"]');
      const btn = section?.querySelector("button");
      const scroller = document.querySelector(".ios-page .scroll-y");
      if (!btn || !scroller) return null;
      const sr = scroller.getBoundingClientRect();
      const br = btn.getBoundingClientRect();
      scroller.scrollTop += (br.top - sr.top) + br.height / 2;
      const br2 = btn.getBoundingClientRect();
      return { visibleSliver: Math.round(br2.bottom - sr.top), btnHeight: Math.round(br2.height) };
    },
  },
});

function Fixture() {
  return (
    <AppProvider>
      <div style={{ position: "relative", width: 390, height: 844 }}>
        {scene === "category"
          ? <Category wide={false} active />
          : <ChannelPage cate="video:hanime-tv" name="Hanime.tv" onBack={() => {}} wide={false} />}
      </div>
    </AppProvider>
  );
}
createRoot(document.querySelector("#root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
