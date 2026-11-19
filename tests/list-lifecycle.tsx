/* 列表生命周期夹具（Muse 2026-11-19 fix2.1）：分页状态机 reset 预取
 * 续拉、A2 分页契约五种注入、封面 attempt 超时起算点、频道页换筛选
 * 页数基线。全部用真实 hook/组件 + 脚本化 request/IPC，不访问网络。
 * 场景由 ?scene= 选择，状态经 window.__list / __img 暴露给驱动脚本。 */
import React, { useRef } from "react";
import { createRoot } from "react-dom/client";
import { usePaginatedList } from "../src/shared/lib/usePaginatedList";
import { feedTraceSnapshot } from "../src/shared/lib/feedTrace";
import { Img } from "../src/shared/ui/ui";
import { ChannelPage } from "../src/features/category/Category";
import { AppProvider } from "../src/shared/model/store";
import type { Paged } from "../src/shared/api/types";
import "../src/index.css";

type Item = { id: number };
const paged = (items: Item[], pagination: Record<string, unknown>): Paged<Item> =>
  ({ items, pagination } as unknown as Paged<Item>);

/* 分页脚本：respond 按页返回脚本化响应；delay 模拟慢线（让哨兵边沿
 * 在 reset 完成前被消费，复现 GPT 四审 #2 的停摆时序）。 */
const scenarios: Record<string, { delay: number; respond: (page: number) => Paged<Item> }> = {
  /* #2：总 5 页、每页 1 条、内容总高远小于容器，哨兵恒可见 */
  prefetch: {
    delay: 120,
    respond: (page) => paged([{ id: page }], { page, pages: 5, size: 1, total: 5 }),
  },
  /* 契约 a：响应缺 pagination.pages（接口偶发缺字段） */
  missing: {
    delay: 0,
    respond: (page) => paged([{ id: page }], { page, size: 1, total: 1 }),
  },
  /* 契约 b：pages=0 */
  zero: {
    delay: 0,
    respond: (page) => paged([{ id: page }], { page, pages: 0, size: 1, total: 1 }),
  },
  /* 契约 c：后续页把 pages 缩到小于当前页 */
  shrink: {
    delay: 0,
    respond: (page) => (page === 1
      ? paged([{ id: 1 }], { page, pages: 3, size: 1, total: 3 })
      : paged([{ id: page }], { page, pages: 1, size: 1, total: 3 })),
  },
  /* 契约 d：中间页空但 pages 称还有后续 */
  emptymid: {
    delay: 0,
    respond: (page) => (page === 2
      ? paged([], { page, pages: 3, size: 1, total: 3 })
      : paged([{ id: page }], { page, pages: 3, size: 1, total: 3 })),
  },
  /* 契约 e：total 已满但 pages 称还有后续（终止只认 pages） */
  conflict: {
    delay: 0,
    respond: (page) => paged([{ id: page }], { page, pages: 5, size: 1, total: 1 }),
  },
};

function Harness({ name }: { name: string }) {
  const calls = useRef<number[]>([]);
  const loadMoreRef = useRef<() => void>(() => {});
  const sc = scenarios[name];
  const list = usePaginatedList<Item>({
    getId: (i) => i.id,
    request: async (page) => {
      calls.current.push(page);
      if (sc.delay) await new Promise((r) => setTimeout(r, sc.delay));
      return sc.respond(page);
    },
  });
  loadMoreRef.current = () => list.loadMore(false);
  (window as unknown as { __list: unknown }).__list = {
    state: () => ({
      items: list.items.length, page: list.page, pages: list.pages,
      hasMore: list.hasMore, loading: list.loading, err: list.err,
      total: list.total, calls: [...calls.current],
    }),
    loadMore: () => loadMoreRef.current(),
  };
  /* 几何即场景的一部分：prefetch 场景要哨兵恒可见（矮容器+矮条目）；
   * 契约场景要哨兵恒在检测区外（条目 800px > 容器 300px + 哨兵
   * rootMargin 240px），否则预取续拉会冲掉要钉的中间态——契约
   * 场景只走手动 loadMore。 */
  const short = name === "prefetch";
  return (
    <div ref={list.scroller} style={{ height: short ? 600 : 300, overflowY: "auto" }}>
      {/* 契约场景占位块：空列表阶段哨兵本在容器顶部（可见），首帧起就
          把它顶出检测区，免得 reset 成功瞬间预取链靠陈旧可见性抢跑 */}
      {!short && <div style={{ height: 800 }} />}
      {list.items.map((i) => <div key={i.id} style={{ height: short ? 10 : 800 }}>#{i.id}</div>)}
      <div ref={list.sentinel} style={{ height: 10 }} />
    </div>
  );
}

function ImageScene({ variant }: { variant: string }) {
  (window as unknown as { __img: unknown }).__img = { trace: () => feedTraceSnapshot() };
  if (variant === "offscreen") {
    return (
      <div style={{ paddingTop: 5000 }}>
        <div style={{ position: "relative", width: 200, height: 200 }}>
          <Img src="https://covers.fixture/slow.png" />
        </div>
      </div>
    );
  }
  return (
    <div style={{ position: "relative", width: 200, height: 200 }}>
      <Img src="https://covers.fixture/hang.png" />
    </div>
  );
}

/* 频道页场景：mock Tauri IPC。latest 给 pages=5；切到 hot_window 后
 * 响应缺 pages 字段——旧实现会继承旧筛选的 5 页（GPT 四审 #10）。 */
function installChannelIpc() {
  const card = (id: number, title: string) => ({
    id, title, cover: "", tags: [], score: 0, hot: 0,
    episode_count: 1, total_episodes: 1, is_finished: true, is_original: 0,
    like_count: 0, comment_count: 0, collect_count: 0,
  });
  Object.assign(window, {
    __TAURI_INTERNALS__: {
      invoke(cmd: string, args: Record<string, unknown> = {}) {
        if (cmd === "app_boot") return Promise.resolve({ user: null, logged_in: false, base: "https://fixture.invalid" });
        if (cmd === "debug_log") return Promise.resolve();
        if (cmd === "api_category") {
          if (args.sort === "hot_window") {
            return Promise.resolve({ items: [card(9, "热播一")], pagination: { page: 1, size: 20, total: 1 } });
          }
          /* 每页 20 条把哨兵顶出视口，免得哨兵连拉把 5 页一次吃完 */
          const page = Number(args.page) || 1;
          const items = Array.from({ length: 20 }, (_, i) => card(page * 100 + i, `最新第${page}页·${i}`));
          return Promise.resolve({ items, pagination: { page, pages: 5, size: 20, total: 100 } });
        }
        return Promise.reject(`Unexpected IPC: ${cmd}`);
      },
    },
  });
}

const scene = new URLSearchParams(location.search).get("scene") || "prefetch";
const root = createRoot(document.getElementById("root")!);
if (scene === "offscreen" || scene === "late") {
  root.render(<ImageScene variant={scene} />);
} else if (scene === "channel") {
  installChannelIpc();
  root.render(
    <AppProvider>
      <div style={{ position: "relative", width: 420, height: 800 }}>
        <ChannelPage cate="ai-duanju" name="AI成人短剧" onBack={() => {}} wide={false} />
      </div>
    </AppProvider>,
  );
} else {
  root.render(<Harness name={scene} />);
}
