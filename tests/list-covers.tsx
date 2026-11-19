/**
 * 列表封面设备链夹具（Muse 2026-11-20 fix331/covers-header）。
 *
 * 挂载真实 SourcePosts（source-005 注册表定义），列表 HTML 按真站
 * 形态在页内合成：封面只由 loadBannerDirect('<直址>', ...) 脚本参数
 * 承载，直址指向场景脚本起的图床模拟服务（127.0.0.1:<cdn>）。Img
 * 走 App 真实本地路由地址形态——Chromium/Linux 下 LOCAL 恰为
 * http://127.0.0.1:17650，场景脚本在该端口按 Rust 路由语义
 * （上游 20s 超时＋retryable 三试＋502 终局＋同址在途去重/成功
 * 缓存）实现 /img，链路为：WebView → 本地 /img 路由 → 图床。
 * 读数面 = feedTrace 快照（与诊断导出同一聚合）＋DOM 终态计数。
 */
import React from "react";
import { createRoot } from "react-dom/client";
import SourcePosts from "../src/features/sources/SourcePosts";
import { AppProvider } from "../src/shared/model/store";
import { getBuiltinRegistry } from "../src/features/sources/registry";
import { setFetchPage } from "../src/features/sources/adapters/fetchPage";
import { feedTraceSnapshot } from "../src/shared/lib/feedTrace";
import "../src/index.css";

Object.assign(window, {
  __TAURI_INTERNALS__: {
    invoke(cmd: string, _args: Record<string, unknown> = {}) {
      if (cmd === "app_boot") return Promise.resolve({ user: null, logged_in: false, base: "https://fixture.invalid" });
      if (cmd === "debug_log") return Promise.resolve();
      return Promise.reject(`Unexpected IPC: ${cmd}`);
    },
  },
});

const q = new URLSearchParams(location.search);
const cdnPort = q.get("cdn") ?? "0";
const count = Number(q.get("n") ?? "20");

const cards = Array.from({ length: count }, (_, i) => `
  <a href="/archives/${30000 + i}/">
    <div class="post-card" id="post-card-${30000 + i}">
      <div class="blog-background"></div>
      <script type="text/javascript">loadBannerDirect('http://127.0.0.1:${cdnPort}/c/${i}.jpg', '', document.querySelector('#post-card-${30000 + i}'), '-1', 300);</script>
      <div class="post-card-mask  "><div class="post-card-container">
        <h2 class="post-card-title" itemprop="headline">合成帖 ${i + 1}</h2>
      </div></div>
    </div>
  </a>`).join("\n");
setFetchPage(async () => `<html><body><div class="list">${cards}</div></body></html>`);

const def = getBuiltinRegistry().find((s) => s.id === "meiridasai");
if (!def) throw new Error("meiridasai def missing");

Object.assign(window, {
  __covers: {
    state() {
      const snap = feedTraceSnapshot();
      return {
        image: snap.image,
        hg: document.querySelectorAll(".ios-image-error").length,
        shown: [...document.querySelectorAll("[data-ui='image-frame'] img")].filter((im) => (im as HTMLImageElement).naturalWidth > 0).length,
        frames: document.querySelectorAll("[data-ui='image-frame']").length,
      };
    },
    scrollStep() {
      const el = document.querySelector("[data-covers-scroll]");
      if (el) el.scrollTop += 520;
      return el ? el.scrollTop : -1;
    },
  },
});

function Fixture() {
  return (
    <AppProvider>
      <div style={{ position: "relative", width: 390, height: 844 }}>
        <div data-covers-scroll style={{ height: "100%", overflowY: "auto" }}>
          <SourcePosts def={def!} />
        </div>
      </div>
    </AppProvider>
  );
}
createRoot(document.querySelector("#root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
