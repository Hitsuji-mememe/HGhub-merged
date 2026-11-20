import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, platform as envPlatform } from "../api/api";
import { exitDocumentFullscreen, getFullscreenElement } from "../lib/fullscreen";
import { isStrictSecurity, setStrictSecurity as setHtmlStrictSecurity } from "../lib/securityMode";
import { readStorage, STORAGE_KEYS } from "../storage/storage";
import {
  absorbLegacyAccounts, clearAbsorbedLegacyAccounts, pickLibraryData, useLocalLibrary, type LibraryData,
  type ExternalItemRef, type ExternalKind, type ExternalRef,
} from "./localLibrary";

export type Platform = "android" | "ios" | "windows" | "macos" | "linux";
export type Theme = "dark" | "light";
export type ThemePreference = Theme | "system";
export type Tab = "home" | "search" | "category" | "profile";
/** GPU 超分档位（移植自 LNPANDY v1.2.2，Muse 2026-11-18） */
export type SuperResMode = "off" | "natural" | "cinema" | "crisp" | "anime_3d" | "anime_2d";
/** 超分用户偏好只剩两档（2026-11-18 用户裁定全自动）：auto=按源分辨率自动
    选档（见 playback/SuperResCanvas.effectiveSrMode），off=强制关闭。
    具体档位不再由用户选，播放界面上的超分入口已全部撤下。 */
export type SrPref = "auto" | "off";

/** 播放页上下文：ids 是来源列表，index 是当前条目。 */
export type FeedContext = {
  kind: "feed";
  key: string;
  videoIds: number[];
  index: number;
  title: string;
  source: string;
  feedKind?: "video" | "post";
  /** 从观看记录续播：起始集数与秒数 */
  startEp?: number;
  startTime?: number;
};

export type Page =
  | FeedContext
  | { kind: "channel"; key: string; cate: string; name: string; openExternalId?: string; openExternalEp?: number }
  | { kind: "ranks"; key: string }
  | { kind: "settings"; key: string; section?: "内容偏好" }
  | { kind: "posts"; key: string; sourceId?: string; openExternalId?: string }
  | { kind: "post"; key: string; id: number }
  | { kind: "topics"; key: string }
  | { kind: "topic"; key: string; slug: string; name: string }
  | { kind: "tags"; key: string }
  | { kind: "tag"; key: string; tag: string; name: string }
  | { kind: "user"; key: string; id: number; name?: string };

export type PageInput =
  | { kind: "feed"; videoIds: number[]; index: number; title: string; source?: string; feedKind?: "video" | "post"; startEp?: number; startTime?: number }
  | { kind: "channel"; cate: string; name: string; openExternalId?: string; openExternalEp?: number }
  | { kind: "ranks" }
  | { kind: "settings"; section?: "内容偏好" }
  | { kind: "posts"; sourceId?: string; openExternalId?: string }
  | { kind: "post"; id: number }
  | { kind: "topics" }
  | { kind: "topic"; slug: string; name: string }
  | { kind: "tags" }
  | { kind: "tag"; tag: string; name: string }
  | { kind: "user"; id: number; name?: string };

export type Toast = {
  id: number;
  msg: string;
  icon?: "ok" | "heart" | "star" | "info";
  /** 线路切换专用的结构化内容，有这个就不看 msg */
  line?: { region: "cn" | "intl"; host: string; ms: number };
};

/** 观看记录：看到第几集、第几秒（`dur` 用来判断是否已看完） */
export type WatchProgress = { id: number; ep: number; t: number; dur: number; at: number };

type Persist = LibraryData & {
  muted: boolean;
  muteOnStartup: boolean;
  volume: number;
  searchHist: string[];
  /** 旧「上下划切集」字段，仅作旧配置兼容保留：2026-11-18 用户真机纠正
      推翻该定版——竖滑恒沿 feed 切作品，集内切换只走选集抽屉/上下集钮/
      片尾自动。恒 false（load 强制 + setter 恒写 false）。 */
  swipeEp: boolean;
  /** 优先高清：有 HEVC 就用 HEVC，播不了自动回退标准 */
  preferHevc: boolean;
  /** 移动全屏控件无操作自动隐藏秒数：0=不自动隐藏（#146-3） */
  fsIdleSecs: number;
  /** GPU 超分档位（移植自 LNPANDY v1.2.2），随 app 配置一块持久化。
      2026-11-18 起仅作旧配置兼容保留：播放路径不再读它，实际档位由
      srPref + 源分辨率自动推导（effectiveSrMode）。 */
  srMode: SuperResMode;
  /** 超分覆盖项（设置页唯一入口）：auto=自动选档，off=强制关闭 */
  srPref: SrPref;
  /** 全局倍速（蓝图 P4）：Feed 与帖子播放器同源，改一处全局生效、重启保留 */
  rate: number;
};

const LS = STORAGE_KEYS.app;
const DEFAULTS: Persist = {
  likes: [], favs: [], history: [], follows: [],
  muted: true, muteOnStartup: true, volume: 0.7, searchHist: [], swipeEp: false, preferHevc: true,
  fsIdleSecs: 3,
  srMode: "natural",
  srPref: "auto",
  rate: 1,
};

/** 旧版本 history 是 number[]，读出来时升级成带进度的结构 */
function normalizeHistory(raw: unknown): WatchProgress[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchProgress[] = [];
  raw.forEach((item, i) => {
    if (typeof item === "number") {
      out.push({ id: item, ep: 1, t: 0, dur: 0, at: Date.now() - i });
      return;
    }
    const h = item as Partial<WatchProgress> | null;
    if (h && typeof h.id === "number") {
      out.push({ id: h.id, ep: Number(h.ep) || 1, t: Number(h.t) || 0, dur: Number(h.dur) || 0, at: Number(h.at) || Date.now() - i });
    }
  });
  return out;
}

/** 旧账号分桶吸收（3.3.0 拆除线）：曾登录用户的资料库只在
 * `hghubx_accounts_v1` 分桶里，load 时合并进本机 Persist。合并结果
 * 先写新键并回读验证、成功才删旧键（存储不变量 7）；写失败保留
 * 旧键，下次启动幂等重吸收，本次内存数据已合并、不受影响。 */
function absorbIntoPersist(base: Persist): Persist {
  const legacy = absorbLegacyAccounts(pickLibraryData(base));
  if (!legacy.absorbed) return base;
  const merged = { ...base, ...legacy.data };
  try {
    const text = JSON.stringify(merged);
    localStorage.setItem(LS, text);
    if (localStorage.getItem(LS) === text) clearAbsorbedLegacyAccounts();
  } catch { /* 写失败保留旧分桶键，下次启动重吸收 */ }
  return merged;
}

function loadPersist(): Persist {
  try {
    const raw = readStorage(LS);
    /* swipeEp 的值不再使用（恒 false），但这一读必须保留：readStorage
       在读时把旧键 hghub_swipe_ep_v2 复制到新键并清旧键（存储不变量
       7），删掉它旧键会永远残留、新键永不落地（storage-migration
       门禁实测）。 */
    void readStorage(STORAGE_KEYS.swipeEp);
    if (!raw) return DEFAULTS;
    const p = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persist>) };
    // 只在启动时应用；本次使用中取消静音不会关闭此偏好。
    const muteOnStartup = p.muteOnStartup !== false;
    const fsIdleSecs = DEFAULTS.fsIdleSecs; // 3.2.2 砍单：全屏隐藏时长固定默认 3 秒（微设置打包删除）
    /* 超分档位归一化：LNPANDY 早期版本用过 fsr / anime 两个旧名，映射到现档位 */
    const rawSr = (p as { srMode?: string }).srMode;
    const srMode: SuperResMode =
      rawSr === "fsr" ? "natural"
      : rawSr === "anime" ? "anime_3d"
      : rawSr === "off" || rawSr === "natural" || rawSr === "cinema" || rawSr === "crisp" || rawSr === "anime_3d" || rawSr === "anime_2d"
        ? rawSr
        : "natural";
    const srPref: SrPref = (p as { srPref?: string }).srPref === "off" ? "off" : "auto";
    /* fsIdleSecs 于 2026-11-18 用户重新裁定解硬：默认 3 秒（与官方一致）、
       尊重存量取值。写死项：muteOnStartup+muted/preferHevc 恒 true；
       swipeEp 同日被用户真机纠正推翻（竖滑切作品、非切集），恒 false——
       1.2.9 的一次性迁移（旧 false 视为默认、强制改 true）就此废止。 */
    const base: Persist = { ...p, swipeEp: false, srMode, srPref, muteOnStartup: true, muted: true, fsIdleSecs, preferHevc: true, history: normalizeHistory(p.history) };
    return absorbIntoPersist(base);
  } catch {
    return absorbIntoPersist(DEFAULTS);
  }
}

/* 外观已于 3.2.2 砍单固定为默认档（跟随系统）：不再读存档偏好、
 * 不再提供切换入口（微设置打包删除）。 */
function readThemePreference(): ThemePreference {
  return "system";
}

function resolveTheme(preference: ThemePreference): Theme {
  if (preference !== "system") return preference;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("theme-light", theme === "light");
  document.documentElement.style.colorScheme = theme;
  root.dataset.theme = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta && !root.hasAttribute("data-hg-launching")) {
    meta.content = theme === "light" ? "#eeece7" : "#121212";
  }
}

let themeTransitionTimer = 0;
function beginThemeTransition() {
  const root = document.documentElement;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  root.style.setProperty("--theme-transition-surface", getComputedStyle(root).getPropertyValue("--p-bg").trim());
  root.classList.add("theme-transitioning");
  window.clearTimeout(themeTransitionTimer);
  themeTransitionTimer = window.setTimeout(() => root.classList.remove("theme-transitioning"), 420);
}

type Store = {
  platform: Platform;
  theme: Theme; themePreference: ThemePreference;
  tab: Tab; setTab: (t: Tab) => void;
  stack: Page[]; push: (p: PageInput) => void; openRootPage: (p: PageInput) => void; pop: () => void;
  setCollected: (kind: "video" | "post", id: number, on: boolean) => Promise<void>;
  actionPending: (key: string) => boolean;
  likes: number[]; favs: number[]; postLikes: number[]; postFavs: number[]; history: WatchProgress[]; follows: number[];
  isFav: (id: number, kind?: "video" | "post") => boolean;
  /** 记一条观看记录；`ep/t/dur` 省略时保留原进度，`ep` 变了就把进度归零 */
  addHistory: (id: number, ep?: number, t?: number, dur?: number) => void;
  /** G4 外部源快照侧表（fix334/L3）：外部收藏/历史的回访事实来源。 */
  extRefs: Record<number, ExternalRef>;
  /** 外部条目收藏：哈希＋快照与收藏同写（video→favs、post/image→postFavs）。 */
  setExternalCollected: (kind: ExternalKind, item: ExternalItemRef, on: boolean, epCount?: number) => Promise<void>;
  /** 外部条目历史：行 t=0/dur=0，续播只恢复到集（epOrdinal）。 */
  addExternalHistory: (item: ExternalItemRef, epOrdinal?: number, epCount?: number) => void;
  clearHistory: () => Promise<void>;
  fs: boolean; setFs: (v: boolean | ((p: boolean) => boolean)) => void;
  /** 移动端「净屏」：只留画面，UI 全隐 */
  clean: boolean; setClean: (v: boolean | ((p: boolean) => boolean)) => void;
  /** 锁屏状态：锁屏期间隐藏移动端底栏 */
  muted: boolean; setMuted: (v: boolean | ((p: boolean) => boolean)) => void;
  muteOnStartup: boolean; setMuteOnStartup: (on: boolean) => void;
  swipeEp: boolean; setSwipeEp: (on: boolean) => void;
  preferHevc: boolean; setPreferHevc: (on: boolean) => void;
  fsIdleSecs: number;
  srMode: SuperResMode; setSrMode: (m: SuperResMode) => void; cycleSrMode: () => void;
  srPref: SrPref; setSrPref: (p: SrPref) => void;
  volume: number; setVolume: (v: number) => void;
  rate: number; setRate: (v: number) => void;
  searchHist: string[]; addSearch: (q: string) => void; clearSearchHist: () => void;
  strictSecurity: boolean; strictSecurityReady: boolean; securityPending: boolean; cliRelaxed: boolean; setStrictSecurity: (on: boolean) => Promise<void>;
  toasts: Toast[]; toast: (msg: string, icon?: Toast["icon"]) => void;
  /** 线路切换计数：变了就让列表页重挂载，重新拉一遍数据 */
  lineEpoch: number;
};

const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);
let seq = 0;

/* 独立订阅 Toast 列表：弹出/消失只重渲染 ToastHost，不惊动全应用 30 个 useStore() 页面 */
let toastList: Toast[] = [];
let toastNextId = 0;
const toastListeners = new Set<() => void>();
function updateToasts(updater: (prev: Toast[]) => Toast[]) {
  toastList = updater(toastList);
  toastListeners.forEach((fn) => fn());
}
function pushToastItem(item: Omit<Toast, "id">, durationMs: number) {
  const id = ++toastNextId;
  updateToasts((prev) => [...prev.slice(-2), { ...item, id }]);
  window.setTimeout(() => updateToasts((prev) => prev.filter((x) => x.id !== id)), durationMs);
}
const subscribeToasts = (fn: () => void) => {
  toastListeners.add(fn);
  return () => { toastListeners.delete(fn); };
};
const getToasts = () => toastList;
export const useToasts = () => useSyncExternalStore(subscribeToasts, getToasts);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [p, setP] = useState<Persist>(loadPersist);
  const [themePreference] = useState<ThemePreference>(readThemePreference);
  const [theme, setThemeState] = useState<Theme>(() => resolveTheme(readThemePreference()));
  const themeRef = useRef(theme);
  const [tab, setTabRaw] = useState<Tab>("home");
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const [stack, setStack] = useState<Page[]>([]);
  // Library writes must not roll back sound, quality, gestures or search preferences.
  const library = useLocalLibrary(
    pickLibraryData(p),
    data => setP(previous => ({ ...previous, ...pickLibraryData(data) })),
  );
  const [lineEpoch, setLineEpoch] = useState(0);
  const [fs, setFsState] = useState(false);
  const [clean, setCleanState] = useState(false);
  const lastVolumeRef = useRef(p.volume > 0 ? p.volume : 0.7);
  const [strictSecurity, setStrictSecurityState] = useState<boolean>(isStrictSecurity);
  const [cliRelaxed, setCliRelaxed] = useState(false);
  const [strictSecurityReady, setStrictSecurityReady] = useState(false);
  const [securityPending, setSecurityPending] = useState(false);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      const next = resolveTheme(themePreference);
      if (themeRef.current !== next) beginThemeTransition();
      themeRef.current = next;
      setThemeState(next);
    };
    sync();
    if (themePreference === "system") {
      media.addEventListener?.("change", sync);
      return () => media.removeEventListener?.("change", sync);
    }
  }, [themePreference]);

  useLayoutEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem(STORAGE_KEYS.theme, themePreference); } catch { /* ignore */ }
  }, [theme, themePreference]);


  useEffect(() => {
    try {
      localStorage.setItem(LS, JSON.stringify(p));
      /* 吸收后落盘成功即清旧分桶键（load 时写失败的兜底重试；
       * load 时已验证写成功的已在 loadPersist 内删）。 */
      clearAbsorbedLegacyAccounts();
    } catch { /* ignore */ }
  }, [p]);

  useEffect(() => {
    let request = 0;
    let active = true;
    const readBoot = () => {
      const current = ++request;
      void api.boot().then((r) => {
        if (!active || current !== request) return;
        if (typeof r.strict_security === "boolean") {
          setStrictSecurityState(r.strict_security);
          setHtmlStrictSecurity(r.strict_security);
          setStrictSecurityReady(true);
        }
        setCliRelaxed(!!r.cli_relaxed);
      }).catch(() => { /* 离线也能用 */ });
    };
    readBoot();
    // 切线/代理变化后重读 boot：严格模式与 CLI 放行状态随后端配置走。
    const changed = () => { readBoot(); };
    window.addEventListener("hg:line-changed", changed);
    window.addEventListener("hg:proxy-changed", changed);
    return () => {
      active = false;
      window.removeEventListener("hg:line-changed", changed);
      window.removeEventListener("hg:proxy-changed", changed);
    };
  }, []);

  const setStrictSecurity = useCallback(async (on: boolean) => {
    if (!strictSecurityReady) throw new Error("安全设置尚未读取，请重新启动应用");
    setSecurityPending(true);
    try {
      const saved = await api.securitySet(on);
      setHtmlStrictSecurity(saved);
      setStrictSecurityState(saved);
    } finally {
      setSecurityPending(false);
    }
  }, [strictSecurityReady]);

  const toast = useCallback((msg: string, icon?: Toast["icon"]) => {
    pushToastItem({ msg, icon }, 2200);
  }, []);
  /** 自动选线切换成功后由 `autoLine.ts` 派发，这里只负责显示 */
  useEffect(() => {
    const onLine = (e: Event) => {
      const d = (e as CustomEvent<{ region: "cn" | "intl"; host: string; ms: number }>).detail;
      if (!d) return;
      pushToastItem({ msg: "", line: d }, 3200);
    };
    window.addEventListener("hg:line", onLine);
    return () => window.removeEventListener("hg:line", onLine);
  }, []);
  /** 自动选线：主站和发布页上的镜像全都不通。
   *
   * 只说一次（60s 节流）——巡检本身 10s 一轮，不节流会一直弹。
   * 以前这种情况会悄悄切到 `.ai`（接口全 404），用户只看到「加载失败」，
   * 根本不知道是网络的事。
   */
  useEffect(() => {
    let last = 0;
    const onDown = () => {
      const now = Date.now();
      if (now - last < 60_000) return;
      last = now;
      pushToastItem({ msg: "线路全部不可用，请检查网络或代理", icon: "info" }, 3600);
    };
    window.addEventListener("hg:line-down", onDown);
    return () => window.removeEventListener("hg:line-down", onDown);
  }, []);
  /** 线路真的换了（自动、手切都算）：
   *
   * 旧数据全是在上一个域名上拉的，留着等于对着一条死链路。但各列表页只在
   * 挂载时拉一次，所以这里给一个递增的 key，让它们重挂载、重新请求。
   */
  useEffect(() => {
    const bump = () => setLineEpoch((n) => n + 1);
    window.addEventListener("hg:line-changed", bump);
    window.addEventListener("hg:proxy-changed", bump);
    return () => {
      window.removeEventListener("hg:line-changed", bump);
      window.removeEventListener("hg:proxy-changed", bump);
    };
  }, []);

  const exitNativeFs = useCallback(() => {
    if (getFullscreenElement()) {
      void exitDocumentFullscreen().catch(() => {});
    }
  }, []);

  const setTab = useCallback((t: Tab) => {
    exitNativeFs();
    setFsState(false);
    setCleanState(false);
    setTabRaw(t);
    setStack(s => s.length ? [] : s);
  }, [exitNativeFs]);
  const push = useCallback((pg: PageInput) => {
    exitNativeFs();
    setFsState(false);
    setCleanState(false);
    setStack((s) => [...s, { ...pg, key: `p${++seq}` } as Page]);
  }, [exitNativeFs]);
  const openRootPage = useCallback((pg: PageInput) => {
    exitNativeFs();
    setFsState(false);
    setCleanState(false);
    setStack([{ ...pg, key: `p${++seq}` } as Page]);
  }, [exitNativeFs]);
  const pop = useCallback(() => {
    exitNativeFs();
    setFsState(false);
    setCleanState(false);
    setStack((s) => {
      const next = s.slice(0, -1);
      return next;
    });
  }, [exitNativeFs]);

  const addSearch = useCallback((q: string) => {
    const t = q.trim();
    if (!t) return;
    setP((s) => ({ ...s, searchHist: [t, ...s.searchHist.filter((x) => x !== t)].slice(0, 12) }));
  }, []);
  const clearSearchHist = useCallback(() => setP((s) => ({ ...s, searchHist: [] })), []);

  const setFs = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setFsState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
    // 进出全屏/净屏时把「净屏」收掉，避免退出后 UI 还藏着
    setCleanState(false);
  }, []);

  const setClean = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setCleanState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setMuted = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setP((s) => {
      const nextMuted = typeof v === "function" ? v(s.muted) : v;
      if (!nextMuted && s.volume === 0) {
        return { ...s, muted: false, volume: lastVolumeRef.current || 0.7 };
      }
      return { ...s, muted: nextMuted };
    });
  }, []);
  /* Muse 2026-11-18 (fe-audit): 定版写死——setter 保留签名兼容既有调用点，
     但忽略入参：loadPersist 只在冷启动强制，会话内任何调用都不许改掉定版值。
     swipeEp 的定版值同日经用户真机纠正由 true 改 false（竖滑切作品）。 */
  const setMuteOnStartup = useCallback((_on: boolean) => {
    setP((s) => ({ ...s, muteOnStartup: true }));
  }, []);
  const setSwipeEp = useCallback((_on: boolean) => {
    setP((s) => ({ ...s, swipeEp: false }));
  }, []);
  const setPreferHevc = useCallback((_on: boolean) => {
    setP((s) => ({ ...s, preferHevc: true }));
  }, []);
  const setSrMode = useCallback((srMode: SuperResMode) => {
    setP((s) => ({ ...s, srMode }));
  }, []);
  const setSrPref = useCallback((srPref: SrPref) => {
    setP((s) => ({ ...s, srPref }));
  }, []);
  const cycleSrMode = useCallback(() => {
    const order: SuperResMode[] = ["natural", "cinema", "crisp", "anime_3d", "anime_2d", "off"];
    const next = order[(order.indexOf(p.srMode) + 1) % order.length];
    setP((s) => ({ ...s, srMode: next }));
    toast(next === "off" ? "超分已关" : "超分已开", "info");
  }, [p.srMode, toast]);
  const setVolume = useCallback((v: number) => {
    const volume = Math.max(0, Math.min(1, v));
    if (volume > 0) lastVolumeRef.current = volume;
    setP((s) => ({ ...s, volume, muted: volume === 0 }));
  }, []);
  const setRate = useCallback((v: number) => {
    const rate = Number.isFinite(v) ? Math.max(0.25, Math.min(4, v)) : 1;
    setP((s) => ({ ...s, rate }));
  }, []);

  const value = useMemo<Store>(() => ({
    platform: envPlatform,
    theme, themePreference,
    tab, setTab, stack, push, openRootPage, pop,
    likes: library.likes, favs: library.favs, postLikes: library.postLikes, postFavs: library.postFavs, history: library.history, follows: library.follows,
    isFav: library.isFav,
    setCollected: library.setCollected, actionPending: library.actionPending,
    addHistory: library.addHistory, clearHistory: library.clearHistory,
    extRefs: library.extRefs,
    setExternalCollected: library.setExternalCollected, addExternalHistory: library.addExternalHistory,
    muted: p.muted, setMuted, volume: p.volume, setVolume, rate: p.rate, setRate, fs, setFs, clean, setClean,
    muteOnStartup: p.muteOnStartup, setMuteOnStartup,
    swipeEp: p.swipeEp, setSwipeEp,
    preferHevc: p.preferHevc, setPreferHevc,
    fsIdleSecs: p.fsIdleSecs,
    srMode: p.srMode, setSrMode, cycleSrMode,
    srPref: p.srPref, setSrPref,
    searchHist: p.searchHist, addSearch, clearSearchHist,
    strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    get toasts() { return toastList; }, toast, lineEpoch,
  }), [theme, themePreference, tab, setTab, stack, push, openRootPage, pop,
    p, library,
    setMuted, setMuteOnStartup, setSwipeEp, setPreferHevc, setSrMode, cycleSrMode, setSrPref, setVolume, addSearch, clearSearchHist, strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    toast, lineEpoch, fs, setFs, clean, setClean]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
