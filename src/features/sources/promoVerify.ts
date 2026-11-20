/**
 * 站务型推广帖异步验杀（Muse 2026-11-20 fix333/promo-004）。
 *
 * 背景：吃瓜列表卡内推广帖在 promo-filter 线以站方分类学判据处理
 * （003/005 已杀）；source-004（feedheiliao）列表卡只有标题/封面/
 * 装饰标、无分类与作者字段，列表层组合信号不存在（证据
 * fix333/evidence/promo-filter.md 第三节），唯一可分信号在详情层：
 * 站务推广三连正文 587–706 字、episodes=0；内容帖 1075–1770 字、
 * episodes=1；活动投票帖 1744 字、episodes=1（活动壳＋真内容，
 * 与内容不可分、按用户裁定保留）。
 *
 * 用户口径（2026-11-20 两次亲定）：硬线＝不许伤真正的内容帖与
 * 正文；擦边垃圾可伤；004 裁法＝站务型短帖杀、活动壳真内容留。
 * 故本模块只对在注册表 params 声明 staffVerify 的源生效（当前仅
 * feedheiliao）：列表先正常渲染，后台逐条抓详情验真伪，判站务型
 * 的就地撤下；判据＝正文字数 ≤ 阈值 ∧ episodes=0（合取——有流
 * 的短帖不杀，活动帖以 1744 字＋有流双重落在判据之外）。
 *
 * 阈值：站务样本上限 706、内容样本下限 1075，中点 ≈890，两侧各
 * 留约 180 字边距（见 registry feedheiliao 的 staffVerify 参数）。
 *
 * 已知尾巴风险（明示）：正文 ≤阈值且无流的真实短内容帖会被误
 * 杀——样本内不存在此形态（内容下限 1075 字且均有流），属未证
 * 实的长尾风险，按用户「垃圾可伤」口径接受；契约里以合成反例
 * 钉死其生死现状，判据收紧时必须先过该例。
 *
 * 判定缓存：验过的帖按 externalId 落盘（hghubx_promo_verdicts_v1），
 * 作用域串含源 id＋判据版本＋阈值——判据版本或阈值变化即整域
 * 失效、旧域落盘时清掉，每帖一生只验一次（判据不变时）。抓详情
 * 失败不落缓存、不撤帖（网络失败≠站务），本会话内不重试、下次
 * 挂载再验；正文提取不到（contentHtml 缺失）记 unknown，同样
 * 不落缓存不撤帖。并发上限 3。落盘失败吞掉，不影响列表本身。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { SourceDef, SourceDetail, SourceItem } from "./types.ts";

/** 判据版本：判据形状或适配器详情口径变化时必须 +1（旧缓存整域失效）。 */
export const PROMO_VERIFY_RULE_VERSION = 1;
export const PROMO_VERIFY_STORAGE_KEY = "hghubx_promo_verdicts_v1";
export const PROMO_VERIFY_CONCURRENCY = 3;

export interface StaffVerifyConfig {
  /** 正文字数上限（含）：≤ 此值且无流才判站务型。 */
  maxBodyChars: number;
}

/** 源是否声明站务验杀（params.staffVerify）；未声明返回 null、本模块全程旁路。 */
export function staffVerifyConfig(def: SourceDef): StaffVerifyConfig | null {
  const raw = (def.adapter.params ?? {}) as Record<string, unknown>;
  const sv = raw.staffVerify;
  if (typeof sv !== "object" || sv === null) return null;
  const max = (sv as Record<string, unknown>).maxBodyChars;
  return typeof max === "number" && Number.isFinite(max) && max > 0 ? { maxBodyChars: max } : null;
}

/** 缓存作用域：源＋判据版本＋阈值三者任一变化即换域，旧域自动失效。 */
export function promoVerifyScope(def: SourceDef, cfg: StaffVerifyConfig): string {
  return `${def.id}/staff-verify/v${PROMO_VERIFY_RULE_VERSION}/max${cfg.maxBodyChars}`;
}

/**
 * 正文纯文本长度，与 promo-filter 线 detail 抽查同一量法：去
 * script/style/标签、空白折叠后的字符数。contentHtml 缺失（正文
 * 容器未捕获到）返回 null——提取不到不等于正文为空，不许据此判杀。
 */
export function bodyTextLength(contentHtml: string | undefined): number | null {
  if (!contentHtml) return null;
  const text = contentHtml
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length;
}

export type StaffClassification = "staff" | "clean" | "unknown";

/**
 * 站务型判据（详情层组合）：正文字数在站务档 ∧ 无流（episodes=0）。
 * 正文提取不到 → unknown（不判、不杀、不落缓存）。
 */
export function classifyStaffPost(
  detail: { contentHtml?: string; episodes: unknown[] },
  cfg: StaffVerifyConfig,
): StaffClassification {
  const len = bodyTextLength(detail.contentHtml);
  if (len === null) return "unknown";
  return len <= cfg.maxBodyChars && detail.episodes.length === 0 ? "staff" : "clean";
}

/* ── 判定落盘（hghubx_* 键，不变量 7；形态与 healthCheck 自检落盘同构） ── */

export type PromoVerdict = "staff" | "clean";

export interface PromoVerdictStorageLike {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
}

function defaultStorage(): PromoVerdictStorageLike | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

let storageOverride: PromoVerdictStorageLike | null | undefined;
let verdictsCache: Record<string, Record<string, PromoVerdict>> | null = null;

/** 绑定存储（生产默认 localStorage；契约测试注入假存储模拟重启）。 */
export function bindPromoVerifyStorage(storage: PromoVerdictStorageLike | null): void {
  storageOverride = storage;
  verdictsCache = null;
}

function currentStorage(): PromoVerdictStorageLike | null {
  return storageOverride !== undefined ? storageOverride : defaultStorage();
}

function loadVerdicts(): Record<string, Record<string, PromoVerdict>> {
  try {
    const raw = currentStorage()?.getItem(PROMO_VERIFY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, Record<string, PromoVerdict>> = {};
    for (const [scope, entries] of Object.entries(parsed ?? {})) {
      if (typeof entries !== "object" || entries === null) continue;
      const map: Record<string, PromoVerdict> = {};
      for (const [id, v] of Object.entries(entries as Record<string, unknown>)) {
        if (v === "staff" || v === "clean") map[id] = v;
      }
      if (Object.keys(map).length) out[scope] = map;
    }
    return out;
  } catch { return {}; }
}

function allVerdicts(): Record<string, Record<string, PromoVerdict>> {
  if (verdictsCache === null) verdictsCache = loadVerdicts();
  return verdictsCache;
}

/** 读某作用域的全部已落盘判定（externalId → 判定）。 */
export function getPromoVerdicts(scope: string): Record<string, PromoVerdict> {
  return allVerdicts()[scope] ?? {};
}

/** 记一条判定并落盘；落盘时顺手清掉判据版本已过期的旧作用域。 */
export function recordPromoVerdict(scope: string, externalId: string, verdict: PromoVerdict): void {
  const all = allVerdicts();
  (all[scope] ??= {})[externalId] = verdict;
  const versionMark = `/v${PROMO_VERIFY_RULE_VERSION}/`;
  for (const key of Object.keys(all)) {
    if (!key.includes(versionMark)) delete all[key];
  }
  try {
    currentStorage()?.setItem(PROMO_VERIFY_STORAGE_KEY, JSON.stringify(all));
  } catch { /* 落盘失败不影响验杀本身 */ }
}

/* ── 后台验杀会话：队列＋并发上限＋在飞去重，失败/unknown 只记会话内已试 ── */

export interface PromoVerifySession {
  enqueue: (items: SourceItem[]) => void;
  dispose: () => void;
}

export function createPromoVerifySession(opts: {
  def: SourceDef;
  cfg: StaffVerifyConfig;
  fetchDetail: (externalId: string) => Promise<SourceDetail>;
  onVerdict: (externalId: string, verdict: PromoVerdict) => void;
}): PromoVerifySession {
  const scope = promoVerifyScope(opts.def, opts.cfg);
  const queue: string[] = [];
  const queued = new Set<string>();
  const flying = new Set<string>();
  const handled = new Set<string>();
  let inFlight = 0;
  let disposed = false;

  const pump = (): void => {
    while (!disposed && inFlight < PROMO_VERIFY_CONCURRENCY && queue.length > 0) {
      const id = queue.shift()!;
      queued.delete(id);
      flying.add(id);
      inFlight++;
      opts.fetchDetail(id)
        .then((detail) => {
          if (disposed) return;
          const cls = classifyStaffPost(detail, opts.cfg);
          if (cls === "unknown") return; /* 提取不到正文：不判、不落缓存，下次挂载再验 */
          recordPromoVerdict(scope, id, cls);
          opts.onVerdict(id, cls);
        })
        .catch(() => { /* 网络失败≠站务：不撤、不落缓存，下次挂载再验 */ })
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
      const cached = getPromoVerdicts(scope);
      for (const item of items) {
        const id = item.externalId;
        if (handled.has(id) || queued.has(id) || flying.has(id)) continue;
        const hit = cached[id];
        if (hit) {
          handled.add(id);
          opts.onVerdict(id, hit);
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

/* ── 列表面接线 hook：返回应就地隐藏（已判站务型）的 externalId 集 ── */

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * 列表先正常渲染，本 hook 在后台对未验过的卡逐条验真伪：缓存已
 * 判站务型的立即入隐藏集，新判站务型的到达即入集（调用方据此
 * 就地撤下）。未声明 staffVerify 的源直接返回空集、零请求零状态。
 * 列表与搜索同口径：任一呈现 SourceItem[] 的面接入本 hook 即同
 * 判据同缓存（source-004 当前无搜索段，实际接线面为 SourcePosts
 * 全量＋compact 两形态）。
 */
export function useStaffPromoVerify(
  def: SourceDef,
  items: SourceItem[],
  fetchDetail: (externalId: string) => Promise<SourceDetail>,
): ReadonlySet<string> {
  const scope = useMemo(() => {
    const cfg = staffVerifyConfig(def);
    return cfg ? promoVerifyScope(def, cfg) : null;
  }, [def]);
  const [sessionHidden, setSessionHidden] = useState<ReadonlySet<string>>(EMPTY_SET);
  const sessionRef = useRef<PromoVerifySession | null>(null);

  /* 作用域（源/判据）变化即换会话：旧会话弃置、在飞结果不再回写。
   * fetchDetail 由调用方注入（healthCheck 式接缝）：本模块不直依
   * 适配器工厂，契约可在 node 下直跑、会话可注入假详情。 */
  useEffect(() => {
    if (!scope) return undefined;
    const cfg = staffVerifyConfig(def);
    if (!cfg) return undefined;
    setSessionHidden(EMPTY_SET);
    const session = createPromoVerifySession({
      def,
      cfg,
      fetchDetail,
      onVerdict: (id, verdict) => {
        if (verdict !== "staff") return;
        setSessionHidden((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
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
    if (!scope) return EMPTY_SET;
    const cached = getPromoVerdicts(scope);
    let out: Set<string> | null = null;
    for (const item of items) {
      if (cached[item.externalId] === "staff" || sessionHidden.has(item.externalId)) {
        (out ??= new Set(sessionHidden)).add(item.externalId);
      }
    }
    return out ?? sessionHidden;
  }, [scope, items, sessionHidden]);
}
