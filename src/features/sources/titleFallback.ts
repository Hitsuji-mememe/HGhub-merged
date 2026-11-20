/**
 * 空壳卡标题兜底（Muse 2026-11-20 fix333/m1-title-fallback）。
 *
 * 背景：source-003 列表里存在「封面-only 卡」——卡片容器内只有
 * 封面锚点、无任何标题载体（标题 attr/标题节点/img alt/文本全
 * 空），parseAnchorList 的标题链最终落 titleFromHref 兜底，对
 * /archives/<纯数字 id>/ 型 href 产出的就是裸数字 id 本身，用户
 * 在列表里看到一串数字当标题。list-noise 线普查实证 4 例（003
 * 样本 p1×2、p2×2），detail() 抽查证实全是真帖（正文最长 3557
 * 字、图最多 123 张，证据 fix333/evidence/list-noise.md §4 与
 * fix333/evidence/m1-title-fallback.md）——不许杀，要补真标题。
 *
 * 做法（与 promoVerify 异步泵同型）：仅对「标题为裸数字 id 兜
 * 底」的卡（isBareIdTitle：标题为纯数字 ∧ 恰等于自身 href 末段
 * id），后台抓 detail 取真标题回填显示；正常卡零请求零变化。
 * 判定落盘缓存（hghubx_title_fallback_v1），作用域＝源 id＋兜底
 * 版本＋适配器模板——任一变化旧缓存整域失效，每帖只补一次。
 * 并发上限 3、队列＋在飞去重。抓取失败或 detail 标题为空：不
 * 落缓存、不改显示（保留裸 id、不撤卡不报错），下次挂载再试；
 * detail 标题与裸 id 相同（站点真以数字为题）照样落缓存，免
 * 得每次挂载重复抓取。
 *
 * 与 promoVerify 的分工：验杀决定卡在不在（隐藏集），本模块决
 * 定卡显示什么标题（覆盖集），两者正交、共用同一 detail 注入
 * 接缝，在 SourcePosts 里叠加消费。本模块不直依适配器工厂
 * （healthCheck/promoVerify 式接缝），契约可在 node 下直跑。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { SourceDef, SourceDetail, SourceItem } from "./types.ts";

/** 兜底口径版本：识别判据或 detail 标题口径变化时必须 +1（旧缓存整域失效）。 */
export const TITLE_FALLBACK_VERSION = 1;
export const TITLE_FALLBACK_STORAGE_KEY = "hghubx_title_fallback_v1";
export const TITLE_FALLBACK_CONCURRENCY = 3;

/**
 * 裸数字 id 兜底标题识别：标题（去空白）为纯数字 ∧ 恰等于自身
 * href 末段（去扩展名）。parseAnchorList 的 titleFromHref 只对
 * 纯数字末段产出纯数字标题（slug 还原会剥尾部数字、产出文本），
 * 故此形状即兜底签名；标题是数字但不等于自身 id 的卡（题文不
 * 符）不触发。误触发的代价上限是每帖一次 detail 抓取（结果落
 * 缓存），且 detail 真标题只会替换掉这串数字。
 */
export function isBareIdTitle(item: SourceItem): boolean {
  const t = item.title.trim();
  if (!/^\d+$/.test(t)) return false;
  const href = item.href || item.externalId;
  let seg = "";
  try {
    seg = new URL(href).pathname.split("/").filter(Boolean).pop() ?? "";
  } catch {
    seg = href.split(/[?#]/)[0].replace(/\/+$/, "").split("/").pop() ?? "";
  }
  return seg.replace(/\.[a-z0-9]+$/i, "") === t;
}

/** 缓存作用域：源 id＋兜底版本＋适配器模板，三者任一变化即换域、旧域自动失效。 */
export function titleFallbackScope(def: SourceDef): string {
  return `${def.id}/title-fallback/v${TITLE_FALLBACK_VERSION}/${def.adapter.template}`;
}

/* ── 标题落盘（hghubx_* 键，不变量 7；形态与 promoVerify 判定落盘同构） ── */

export interface TitleFallbackStorageLike {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
}

function defaultStorage(): TitleFallbackStorageLike | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

let storageOverride: TitleFallbackStorageLike | null | undefined;
let titlesCache: Record<string, Record<string, string>> | null = null;

/** 绑定存储（生产默认 localStorage；契约测试注入假存储模拟重启）。 */
export function bindTitleFallbackStorage(storage: TitleFallbackStorageLike | null): void {
  storageOverride = storage;
  titlesCache = null;
}

function currentStorage(): TitleFallbackStorageLike | null {
  return storageOverride !== undefined ? storageOverride : defaultStorage();
}

function loadTitles(): Record<string, Record<string, string>> {
  try {
    const raw = currentStorage()?.getItem(TITLE_FALLBACK_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, Record<string, string>> = {};
    for (const [scope, entries] of Object.entries(parsed ?? {})) {
      if (typeof entries !== "object" || entries === null) continue;
      const map: Record<string, string> = {};
      for (const [id, v] of Object.entries(entries as Record<string, unknown>)) {
        if (typeof v === "string" && v) map[id] = v;
      }
      if (Object.keys(map).length) out[scope] = map;
    }
    return out;
  } catch { return {}; }
}

function allTitles(): Record<string, Record<string, string>> {
  if (titlesCache === null) titlesCache = loadTitles();
  return titlesCache;
}

/** 读某作用域的全部已落盘标题（externalId → 真标题）。 */
export function getTitleFallbacks(scope: string): Record<string, string> {
  return allTitles()[scope] ?? {};
}

/** 记一条真标题并落盘；落盘时顺手清掉兜底版本已过期的旧作用域。 */
export function recordTitleFallback(scope: string, externalId: string, title: string): void {
  const all = allTitles();
  (all[scope] ??= {})[externalId] = title;
  const versionMark = `/title-fallback/v${TITLE_FALLBACK_VERSION}/`;
  for (const key of Object.keys(all)) {
    if (!key.includes(versionMark)) delete all[key];
  }
  try {
    currentStorage()?.setItem(TITLE_FALLBACK_STORAGE_KEY, JSON.stringify(all));
  } catch { /* 落盘失败不影响本次回填显示 */ }
}

/* ── 后台补题会话：队列＋并发上限＋在飞去重，失败/空标题只记会话内已试 ── */

export interface TitleFallbackSession {
  enqueue: (items: SourceItem[]) => void;
  dispose: () => void;
}

export function createTitleFallbackSession(opts: {
  def: SourceDef;
  fetchDetail: (externalId: string) => Promise<SourceDetail>;
  onTitle: (externalId: string, title: string) => void;
}): TitleFallbackSession {
  const scope = titleFallbackScope(opts.def);
  const queue: string[] = [];
  const queued = new Set<string>();
  const flying = new Set<string>();
  const handled = new Set<string>();
  let inFlight = 0;
  let disposed = false;

  const pump = (): void => {
    while (!disposed && inFlight < TITLE_FALLBACK_CONCURRENCY && queue.length > 0) {
      const id = queue.shift()!;
      queued.delete(id);
      flying.add(id);
      inFlight++;
      opts.fetchDetail(id)
        .then((detail) => {
          if (disposed) return;
          const title = (detail.title ?? "").trim();
          if (!title) return; /* 标题提取不到：不落缓存、不改显示，下次挂载再试 */
          recordTitleFallback(scope, id, title);
          opts.onTitle(id, title);
        })
        .catch(() => { /* 抓取失败：保留裸 id 显示、不落缓存，下次挂载再试 */ })
        .finally(() => {
          inFlight--;
          flying.delete(id);
          handled.add(id);
          pump();
        });
    }
  };

  return {
    enqueue(items) {
      if (disposed) return;
      const cached = getTitleFallbacks(scope);
      for (const item of items) {
        if (!isBareIdTitle(item)) continue; /* 只补裸 id 标题卡，正常卡零请求 */
        const id = item.externalId;
        if (handled.has(id) || queued.has(id) || flying.has(id)) continue;
        const hit = cached[id];
        if (hit) {
          handled.add(id);
          opts.onTitle(id, hit);
          continue;
        }
        queued.add(id);
        queue.push(id);
      }
      pump();
    },
    dispose() {
      disposed = true;
      queue.length = 0;
      queued.clear();
    },
  };
}

/* ── 列表面接线 hook：返回应覆盖显示的真标题（externalId → 真标题） ── */

const EMPTY_MAP: ReadonlyMap<string, string> = new Map();

/**
 * 列表先正常渲染，本 hook 在后台对裸 id 标题卡逐条补真标题：
 * 缓存已补的立即入覆盖集，新补到的到达即入集（调用方据此回填
 * 显示）。正常卡不入集、显示逐字不变。任一呈现 SourceItem[]
 * 的面接入本 hook 即同口径（当前接线面为 SourcePosts 全量＋
 * compact 两形态，与 useStaffPromoVerify 共存：验杀先定存废、
 * 本 hook 再叠标题）。
 */
export function useTitleFallback(
  def: SourceDef,
  items: SourceItem[],
  fetchDetail: (externalId: string) => Promise<SourceDetail>,
): ReadonlyMap<string, string> {
  const scope = useMemo(() => titleFallbackScope(def), [def]);
  const [sessionTitles, setSessionTitles] = useState<ReadonlyMap<string, string>>(EMPTY_MAP);
  const sessionRef = useRef<TitleFallbackSession | null>(null);

  /* 作用域（源/适配器）变化即换会话：旧会话弃置、在飞结果不再
   * 回写。fetchDetail 由调用方注入（healthCheck 式接缝）：本模
   * 块不直依适配器工厂，契约可在 node 下直跑、会话可注入假详情。 */
  useEffect(() => {
    setSessionTitles(EMPTY_MAP);
    const session = createTitleFallbackSession({
      def,
      fetchDetail,
      onTitle: (id, title) => {
        setSessionTitles((prev) => (prev.get(id) === title ? prev : new Map(prev).set(id, title)));
      },
    });
    sessionRef.current = session;
    return () => {
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  useEffect(() => {
    if (items.length) sessionRef.current?.enqueue(items);
  }, [items]);

  return useMemo(() => {
    if (!items.length) return EMPTY_MAP;
    const cached = getTitleFallbacks(scope);
    let out: Map<string, string> | null = null;
    for (const item of items) {
      const t = sessionTitles.get(item.externalId) ?? cached[item.externalId];
      if (t && t !== item.title) (out ??= new Map()).set(item.externalId, t);
    }
    return out ?? EMPTY_MAP;
  }, [scope, items, sessionTitles]);
}
