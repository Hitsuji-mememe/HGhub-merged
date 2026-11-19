import { LiquidIndicator, Loader } from "../shared/ui/ios/effects";
import { Button } from "../shared/ui/ios/controls";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore, type Page, type Tab } from "../shared/model/store";
import { selfTest } from "../shared/api/api";
import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { runBack } from "../shared/lib/back";
import { runDetailNext } from "../shared/lib/detailNext";
import { exitDocumentFullscreen, getFullscreenElement } from "../shared/lib/fullscreen";
import Home from "../features/feed/Home";
import LoginModal from "../features/account/LoginModal";
import { ToastHost } from "../shared/ui/ui";
import { tracePlayback } from "../shared/diagnostics/playbackDiagnostics";
import { classifyChainStart, decideChainSwipe, type ChainAncestor } from "./gestureChain";
import { IGrid, IGridF, IHome, IHomeF, ISearch, IUser, IUserF } from "../shared/ui/icons";

// Local chunks load on first visit; visited tabs stay mounted as before.
// Feed (+ hls.js) is separated from the initial shell so cold start mounts chrome and
// starts app_boot / autoLine / api_feed before compiling the 524 kB media engine.
const Feed = lazy(() => import("../features/feed/Feed"));
const Search = lazy(() => import("../features/search/Search"));
const RankPage = lazy(() => import("../features/search/Search").then(module => ({ default: module.RankPage })));
const Category = lazy(() => import("../features/category/Category"));
const ChannelPage = lazy(() => import("../features/category/Category").then(module => ({ default: module.ChannelPage })));
const Profile = lazy(() => import("../features/account/Profile"));
const SettingsPage = lazy(() => import("../features/settings/Settings"));
const PostsPage = lazy(() => import("../features/posts/Posts").then(module => ({ default: module.PostsPage })));
const PostDetail = lazy(() => import("../features/posts/Posts").then(module => ({ default: module.PostDetail })));
const TopicsPage = lazy(() => import("../features/discover/Discover").then(module => ({ default: module.TopicsPage })));
const TopicPage = lazy(() => import("../features/discover/Discover").then(module => ({ default: module.TopicPage })));
const TagsPage = lazy(() => import("../features/discover/Discover").then(module => ({ default: module.TagsPage })));
const TagPage = lazy(() => import("../features/discover/Discover").then(module => ({ default: module.TagPage })));
const UserPage = lazy(() => import("../features/account/User").then(module => ({ default: module.UserPage })));

function PageLoading() {
  return <div className="absolute inset-0 grid place-items-center bg-bg"><Loader label="页面加载中" /></div>;
}

const SELECTABLE_TEXT = 'input, textarea, [contenteditable="true"], .select-text, .article-body';
const isSelectableText = (target: EventTarget | null) => target instanceof Element && !!target.closest(SELECTABLE_TEXT);

function TabBar() {
  const { tab, setTab, platform } = useStore();
  const items = [
    { key: "home", label: "首页", Icon: IHome, Active: IHomeF },
    { key: "search", label: "搜索", Icon: ISearch, Active: ISearch },
    { key: "category", label: "分类", Icon: IGrid, Active: IGridF },
    { key: "profile", label: "我的", Icon: IUser, Active: IUserF },
  ] as const;
  const index = items.findIndex(item => item.key === tab);
  return <nav className="hg-tabbar ios-mobile-nav" aria-label="主导航" data-over-video={tab === "home"}
    style={{ paddingBottom: platform === "android" ? "var(--sab, 16px)" : "calc(var(--sab, 16px) * .55)" }}>
      <div className="hg-glass">
      <div className="hg-drop" aria-hidden="true" style={{ transform: `translateX(${index * 100}%)` }}><LiquidIndicator /></div>
      <div className="ios-mobile-nav-items">
        {items.map(({ key, label, Icon, Active }) => {
          const Glyph = tab === key ? Active : Icon;
          return <Button key={key} className="ios-mobile-nav-item" onClick={() => setTab(key)}
            aria-current={tab === key ? "page" : undefined}>
            <Glyph size={22} /><span>{label}</span>
          </Button>;
        })}
      </div>
    </div>
  </nav>;
}

/* ============ 堆栈页面 ============ */
function StackPage(props: Parameters<typeof StackPageContent>[0]) {
  return <Suspense fallback={<PageLoading />}><StackPageContent {...props} /></Suspense>;
}

function StackPageContent({ page, onBack, wide, top, bottomInset, loginOpen }: {
  page: Page; onBack: () => void; wide: boolean; top: boolean; bottomInset: number; loginOpen: boolean;
}) {
  if (page.kind === "feed") {
    return (
      <Feed videoIds={page.videoIds} startIndex={page.index} title={page.title} kind={page.feedKind || "video"}
        startEp={page.startEp} startTime={page.startTime}
        mode="context" active={top && !loginOpen} bottomInset={bottomInset} onBack={onBack} />
    );
  }
  if (page.kind === "channel") return <ChannelPage cate={page.cate} name={page.name} onBack={onBack} wide={wide} />;
  if (page.kind === "ranks") return <RankPage onBack={onBack} wide={wide} />;
  if (page.kind === "settings") return <SettingsPage onBack={onBack} wide={wide} initialSection={page.section} />;
  if (page.kind === "posts") return <PostsPage onBack={onBack} wide={wide} />;
  if (page.kind === "post") return <PostDetail id={page.id} onBack={onBack} active={top && !loginOpen} />;
  if (page.kind === "topics") return <TopicsPage onBack={onBack} wide={wide} />;
  if (page.kind === "topic") return <TopicPage slug={page.slug} name={page.name} onBack={onBack} wide={wide} />;
  if (page.kind === "tags") return <TagsPage onBack={onBack} wide={wide} />;
  if (page.kind === "tag") return <TagPage tag={page.tag} name={page.name} onBack={onBack} wide={wide} />;
  if (page.kind === "user") return <UserPage id={page.id} name={page.name} onBack={onBack} wide={wide} />;
  return null;
}

/* ============ 应用主体 ============ */
function MainTabs({ wide, pageActive, covered, bottomInset }: { wide: boolean; pageActive: boolean; covered: boolean; bottomInset: number }) {
  const { tab } = useStore();
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set());
  useEffect(() => {
    if (pageActive) setVisited(previous => previous.has(tab) ? previous : new Set([...previous, tab]));
  }, [tab, pageActive]);
  const mounted = (key: Tab) => visited.has(key) || (pageActive && tab === key);
  const visible = (key: Tab) => tab === key ? `absolute inset-0 ${key === "home" ? "" : "ios-tab-active"}` : "absolute inset-0 hidden pointer-events-none";
  // First visits mount on demand; subsequent switches preserve queries, scroll and playback state.
  // DialogFrame's syncBackground() owns modal inertness so portals inside fullscreenElement never inherit ancestor inert.
  return <>
    <div className={visible("home")} inert={covered || tab !== "home"} aria-hidden={!pageActive || tab !== "home"}>{mounted("home") && <Home active={pageActive && tab === "home"} bottomInset={bottomInset} />}</div>
    <div className={visible("search")} inert={covered || tab !== "search"} aria-hidden={!pageActive || tab !== "search"}>{mounted("search") && <Suspense fallback={<PageLoading />}><Search active={pageActive && tab === "search"} wide={wide} /></Suspense>}</div>
    <div className={visible("category")} inert={covered || tab !== "category"} aria-hidden={!pageActive || tab !== "category"}>{mounted("category") && <Suspense fallback={<PageLoading />}><Category wide={wide} active={pageActive && tab === "category"} /></Suspense>}</div>
    <div className={visible("profile")} inert={covered || tab !== "profile"} aria-hidden={!pageActive || tab !== "profile"}>{mounted("profile") && <Suspense fallback={<PageLoading />}><Profile wide={wide} active={pageActive && tab === "profile"} /></Suspense>}</div>
  </>;
}

function AppBody() {
  const { platform, tab, setTab, stack, pop, push, loginOpen, setLoginOpen, fs, setFs, clean, setClean } = useStore();
  const mainRef = useRef<HTMLDivElement>(null);
  /* 链式手势 pop 冷却（fix2.1 批四#12）：手势连发/触摸抖动时 300ms
   * 内只许退一层，防一次滑退两页。用 ref 而非手势 effect 内变量——
   * effect 随 stack/tab 变化重建，冷却须跨重建存活。 */
  const lastChainPopAt = useRef(0);
  const [wide, setWide] = useState(false);

  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth > 640));
    ro.observe(el);
    setWide(el.clientWidth > 640);
    return () => ro.disconnect();
  }, []);

  /* 全局键盘 */
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (loginOpen) { if (e.key === "Escape") setLoginOpen(false); return; }
      if (e.key === "Escape") { if (runBack()) return; if (fs) { setFs(false); return; } if (getFullscreenElement()) { void exitDocumentFullscreen().catch(() => {}); return; } if (stack.length) pop(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (e.key === "/") { e.preventDefault(); setTab("search"); return; }
      if (["1", "2", "3", "4"].includes(e.key) && !e.repeat) {
        setTab((["home", "search", "category", "profile"] as Tab[])[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [stack.length, pop, setTab, loginOpen, setLoginOpen, fs, setFs]);

  /* ── 横向链式手势导航（收官批 E 项，用户裁定）──
     链序 = 底部页签序：首页（播放器）→ 搜索 → 分类 → 我的 →（齿轮）设置。
     方向（2026-11-18 晚用户真机再裁定，推翻 E 项原口头规格）：跟主流
     翻页直觉——左划去下一级、右划回上一级。原规格「右划去下一级」真机
     体感是反的（用户原话：往左滑是向右、往右划是向左），以真机为准。
     播放器中部左划进搜索（与顶栏〈、放大镜同落搜索，〈落点已在
     Feed.goBack 改齐）；搜索右划回播放器、左划去分类；分类右划回搜索、
     左划去我的；我的右划回分类、左划进设置（推栈）；栈页（设置/吃瓜/
     详情/频道/栈内 Feed 等全部）右划一律 pop 返回上一级、左划无动作
     （2026-11-19 fix2 A1 补齐，此前只有设置页能滑回）。链首（播放器）
     右划无动作。
     与播放器既有手势的冲突处理（以本链为准的除外，提交说明记账）：
     播放器左缘 24px 起手的右划仍归边缘返回手势（关面板/退全屏），
     本链只接中部起手；全屏（fs）中不触发本链；纵向滚动靠方向锁定
     （|dx|≥72 且 |dx|>|dy|×1.8）不误触；局部横滚区域（overflow-x 可滚
     的 chips 行/卡片行）、输入框、打开的 dialog/sheet 内起手不触发。
     底部页签保留作直接跳达，与本链并存。
     手势仲裁优先级（Muse 2026-11-19 fix2.1 批四#12 定版，fix322/play
     修订，高→低）：
     ①输入框/横滚区/dialog 起手——本链整体不触发（上方 walk）；
     ①′播放器手势面（data-player-surface）/进度条区
       （data-feed-scrub-zone）起手——本链整体不触发（fix322 新增：
       面内横拖即 seek 本身、位移 ≥72 与链方向锁重叠，旧版只让行
       左缘 24px，面内 seek 被 pop/切页签抢走、整个画面被划出去；
       起点分类与裁决见 gestureChain.ts＋其契约测试）；
     ②全屏 scrub 独占——fs 时本链不触发，横拖只归进度条；
     ③单击/双击/长按互斥——由播放器表面手势（mobileGestures）内部
       按位移与时长仲裁（横拖 seek 不在此列，归 ①′）；
     ④栈页右划返回——本链 pop，带 300ms 冷却防连退两层；
     ⑤详情页左划下一条——仅栈顶 feed 页、起手落在详情信息区
       （data-feed-info-zone）且不在进度条区（data-feed-scrub-zone）
       时，经 detailNext 通道切下一集/下一条；其余栈页左划无动作。 */
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    let start: { x: number; y: number; blocked: boolean; inInfo: boolean; inScrub: boolean } | null = null;
    /* 起点分类与终点裁决在 gestureChain.ts（纯函数＋契约测试）；此处
       只做 DOM walk 产出祖先描述符与副作用分发（pop 300ms 冷却防连
       退两层，fix2.1 批四#12）。 */
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) { start = null; return; }
      const t = e.touches[0];
      const ancestors: ChainAncestor[] = [];
      for (let n = e.target as Element | null; n && n !== el; n = n.parentElement) {
        const s = getComputedStyle(n);
        ancestors.push({
          tagName: n.tagName,
          role: n.getAttribute?.("role"),
          feedInfoZone: !!n.hasAttribute?.("data-feed-info-zone"),
          feedScrubZone: !!n.hasAttribute?.("data-feed-scrub-zone"),
          playerSurface: !!n.hasAttribute?.("data-player-surface"),
          hScrollable: (s.overflowX === "auto" || s.overflowX === "scroll") && n.scrollWidth > n.clientWidth,
        });
      }
      const c = classifyChainStart(ancestors, {
        fs, loginOpen, tab, stackDepth: stack.length,
        topKind: stack[stack.length - 1]?.kind, clientX: t.clientX,
      });
      start = { x: t.clientX, y: t.clientY, ...c };
    };
    const onEnd = (e: TouchEvent) => {
      const s = start;
      start = null;
      if (!s) return;
      const t = e.changedTouches[0];
      if (!t) return;
      const action = decideChainSwipe(s, t.clientX - s.x, t.clientY - s.y, {
        tab, topKind: stack[stack.length - 1]?.kind,
      });
      if (!action) return;
      if (action.type === "pop") {
        const now = Date.now();
        if (now - lastChainPopAt.current >= 300) {
          lastChainPopAt.current = now;
          pop();
        }
      } else if (action.type === "detailNext") {
        runDetailNext();
      } else if (action.type === "tab") {
        setTab(action.tab);
      } else if (action.type === "pushSettings") {
        push({ kind: "settings" });
      }
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchend", onEnd);
    };
  }, [tab, stack, fs, loginOpen, setTab, pop, push]);

  /* clean 是播放器沉浸态、只属于 home（Muse 2026-11-18 真机 bug）：
     沉浸态下链式手势可直接离 home（手势不要求先唤醒控件），clean 不清
     会让 TabBar 在所有页签被全局隐藏、底部留白同时归零——滑进搜索页
     底部按键消失即此故。在此统一收口：tab 一离开 home 即清 clean，
     覆盖手势/快捷键/顶栏钮全部离 home 路径；回 home 控件先全显，
     与进/退全屏的「恢复入口优先」一致。 */
  useEffect(() => { if (tab !== "home" && clean) setClean(false); }, [tab, clean, setClean]);

  const pageActive = stack.length === 0 && !loginOpen;
  /* 播放器即首页（蓝图 P0，Muse 2026-11-18）：home 页签就是播放面，
     不显示页签栏、底部不留页签栏高度；搜索/分类/我的作为播放器之外的
     浏览页存在，经控制层返回/搜索到达，那些页上页签栏照常显示。 */
  const bottomInset = fs || clean || tab === "home" ? 0 : 74;
  /* 栈页（从搜索/分类/我的进入的播放页、图文页）没有底栏，
     底部只让出安全区。之前多留了 20px，视频底边会露出一条
     「底栏」似的窄缝（底部的压暗渐变到不了屏幕最底）。 */
  const stackInset = 0;

  return (
    <div className={`absolute inset-0 flex bg-canvas plat-${platform}`}>
      <div ref={mainRef} className="relative flex-1 min-w-0 overflow-hidden win-main">
        <MainTabs wide={wide} pageActive={pageActive} covered={stack.length > 0} bottomInset={bottomInset} />

        {stack.map((p, i) => (
          <div key={p.key} inert={i !== stack.length - 1} aria-hidden={i !== stack.length - 1 || loginOpen} className="absolute inset-0 z-30 bg-bg a-page-in" style={{ boxShadow: "-18px 0 40px rgba(0,0,0,.5)" }}>
            <StackPage page={p} onBack={pop} wide={wide} top={i === stack.length - 1} bottomInset={stackInset} loginOpen={loginOpen} />
          </div>
        ))}

        {!fs && !clean && stack.length === 0 && tab !== "home" && <TabBar />}
      </div>
    </div>
  );
}

const supportsCssMax = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("top", "max(1px, 2px)");

/* ============ 移动端（无壳） ============ */
function MobileShell() {
  const { platform } = useStore();
  const minBottom = platform === "android" ? "24px" : "16px";
  const safeStyle = supportsCssMax
    ? {
        "--sat": "max(var(--native-sat, 0px), env(safe-area-inset-top, 0px), 12px)",
        "--sab": `max(var(--native-sab, 0px), env(safe-area-inset-bottom, 0px), ${minBottom})`,
        "--sal": "max(var(--native-sal, 0px), env(safe-area-inset-left, 0px))",
        "--sar": "max(var(--native-sar, 0px), env(safe-area-inset-right, 0px))",
      }
    : {
        "--sat": "var(--native-sat, 12px)",
        "--sab": `var(--native-sab, ${minBottom})`,
        "--sal": "var(--native-sal, 0px)",
        "--sar": "var(--native-sar, 0px)",
      };
  return (
    <div className={`absolute inset-0 flex flex-col bg-canvas plat-${platform}`}
      style={safeStyle as React.CSSProperties}>
      <div className="relative flex-1 min-h-0">
        <AppBody />
      </div>
    </div>
  );
}

/* ============ 入口 ============ */
export default function App() {
  const { platform, loginOpen, setLoginOpen, tab, setTab, stack, pop, fs, setFs } = useStore();
  useEffect(() => {
    tracePlayback("navigation.change", { tab, stack: stack.map(p => ({ page: p.kind, key: p.key })), login_open: loginOpen });
  }, [tab, stack, loginOpen]);

  /* iOS keeps player gestures free of selection handles while inputs and reading text
     retain native selection/copy. Pointer targeting also handles non-focusable articles. */
  useEffect(() => {
    if (platform !== "ios") return;
    let last: boolean | null = null;
    const setTI = (enabled: boolean) => {
      if (last === enabled) return;
      last = enabled;
      invoke("set_text_interaction", { enabled }).catch(() => { last = null; });
    };
    const onDown = (e: Event) => setTI(isSelectableText(e.target));
    const onFocusOut = (e: FocusEvent) => {
      // A touch on an article can blur an input with relatedTarget=null after pointerdown.
      // Keep that pointer decision; the next control interaction explicitly disables selection.
      if (e.relatedTarget) setTI(isSelectableText(e.relatedTarget));
    };
    document.addEventListener("touchstart", onDown, { capture: true, passive: true });
    document.addEventListener("pointerdown", onDown, { capture: true, passive: true });
    document.addEventListener("focusin", onDown, true);
    document.addEventListener("focusout", onFocusOut, true);
    return () => {
      document.removeEventListener("touchstart", onDown, true);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("focusin", onDown, true);
      document.removeEventListener("focusout", onFocusOut, true);
    };
  }, [platform]);

  /* —— 安卓硬件返回键 ——
     层级：面板/弹层 → 全屏 → 登录框 → 页面栈 → 回首页 → 退出应用。
     不注册这个监听，Tauri 会直接 webView.goBack() 或退出，表现就是「任意页面返回都回桌面」。 */
  const backRef = useRef<() => void>(() => {});
  backRef.current = () => {
    if (runBack()) return;                                  // 最上层弹窗/播放器面板
    if (fs) { setFs(false); return; }                        // 沉浸全屏
    if (getFullscreenElement()) { void exitDocumentFullscreen().catch(() => {}); return; }
    if (loginOpen) { setLoginOpen(false); return; }
    if (stack.length) { pop(); return; }
    if (tab !== "home") { setTab("home"); return; }
    invoke("plugin:app|exit", { code: 0 }).catch(() => {});
  };

  useEffect(() => {
    if (platform !== "android") return undefined;
    let disposed = false;
    let handle: { unregister: () => Promise<void> } | null = null;
    addPluginListener("app", "back-button", () => backRef.current())
      .then((l) => { if (disposed) l.unregister().catch(() => {}); else handle = l; })
      .catch(() => { /* 非安卓宿主忽略 */ });
    return () => {
      disposed = true;
      handle?.unregister().catch(() => {});
    };
  }, [platform]);

  useEffect(() => {
    const prevent = (e: Event) => { if (!isSelectableText(e.target)) e.preventDefault(); };
    document.addEventListener("contextmenu", prevent);
    return () => document.removeEventListener("contextmenu", prevent);
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const t = window.setTimeout(() => {
      selfTest().then((r) => { invoke("debug_log", { msg: r }).catch(() => {}); }).catch(() => {});
    }, 2500);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <>
      <MobileShell />
      <LoginModal />
      <ToastHost />
    </>
  );
}
