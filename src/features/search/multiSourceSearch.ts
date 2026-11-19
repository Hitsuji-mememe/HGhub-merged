/**
 * 全局搜索多源聚合（Muse 2026-11-19 最终版 D3 线，用户亲点＋
 * 17:29/17:33/17:35 三条拍板＋GPT 设计审查裁定 gpt-design-review-
 * 20261119-adjudication.md 落地）。纯逻辑层（无 React/Tauri 依赖，
 * 契约测试可直接在 Node 跑）：
 * - 页签恒四类（视频/短剧/帖子/图片），按内容性质归类（见
 *   kindForSourceDef/kindForHuangguoVideo 口径），永不按源分段；
 * - 扇出范围与权重按分层总表落搜索层口径（searchPolicyFor），
 *   不改注册表本身；权重只作排序/副本选择的最后 tiebreak，
 *   不冒充单条内容的质量证明（裁定第 1/5 条）；扇出资格另受三段
 *   齐全门约束（3.2.1 修复 F5 线，见 missingSearchSegments）：三段
 *   未验通的源权重照落表、但不进扇出，INCLUDE_OVERRIDE 不得绕过；
 * - 搜索调度（裁定第 5 条）：单源超时＋每源结果上限、渐进呈现
 *   （onPartial 先到先显；(热度,权重,seq) 全序保证已显条目相对
 *   顺序不被新到结果打乱＝稳定插入）、相关性（热度）优先于源
 *   等级、单源首屏贡献上限防淹没；
 * - 跨源合并（裁定第 3 条）：多信号置信（规范化标题＋封面指纹
 *   ＋发布时间），置信不足不合并、宁可留重复；合并是索引层合
 *   并、不删副本，全部副本引用保留；
 * - 默认副本选择链（裁定第 1 条）：身份一致 → 可用性 → 结构
 *   完整度 → 历史可靠性 → 分层权重（最后 tiebreak）。「结构完
 *   整度」只认图数/文长/有无视频等结构信号，不证明质量，任何
 *   口径不得声称已判优画质/码率；
 * - 自动切副本仅限身份已确认的合并条目（裁定第 4 条）：身份
 *   未确认时 loadWithFallback 禁止自动顺延，手动切换不受限；
 *   单源失败静默隔离、副本失败留痕（回调接 tracePlayback）。
 */
import type { SourceAdapter, SourceDef, SourceDetail, SourceItem } from "../sources/types.ts";

export type GlobalSearchKind = "video" | "drama" | "post" | "image";

/** 页签封顶四类（用户 2026-11-19 17:33 拍板：短剧单列）。 */
export const GLOBAL_SEARCH_TABS: readonly { kind: GlobalSearchKind; label: string }[] = [
  { kind: "video", label: "视频" },
  { kind: "drama", label: "短剧" },
  { kind: "post", label: "帖子" },
  { kind: "image", label: "图片" },
];

/* ── 来源权重（分层总表落搜索层；总表未覆盖者中性 40） ── */
const PRIMARY_WEIGHTS: Record<string, number> = {
  huangguo: 100, "51chigua": 100, redgifs: 100, shorties: 100, supjav: 100, pornpics: 100, missav: 100,
};
const SUPPLEMENT_WEIGHTS: Record<string, number> = {
  feedheiliao: 60, av123: 60, "rouvideo-drama": 60, tikporn: 60, jabletv: 60,
};
/** 每日大赛补充次档（用户 2026-11-19 17:35 改判：升补充、默认启用、权重在黑料网之下）。 */
const SUPPLEMENT_LOW_WEIGHTS: Record<string, number> = { meiridasai: 50 };
/** 默认禁用/暂缓/观察：保留注册、不进搜索默认范围。 */
const OFF_IDS = new Set(["drama91", "huangdou", "xiuren", "myfans"]);
/** 总表点名默认启用：在三段齐全者中覆盖注册表 enabled 的搜索层纳入
 * （3.2.1 修复 F5 线收紧：override 不得绕过下方三段门——D3 时代它曾
 * 绕过 enabled/capabilities/blocked，把只有骨架模板的源放进扇出，
 * 搜得出≠播得了，见 fix321-f5.contract.test.ts）。注册表本身的启用
 * 与域名动作走清单 v2，不在本层。 */
const INCLUDE_OVERRIDE = new Set(["51chigua", "feedheiliao", "meiridasai", "shorties", "supjav", "av123", "rouvideo-drama"]);
export const NEUTRAL_WEIGHT = 40;

/* ── 扇出资格：三段齐全门（3.2.1 修复 F5 线，用户实报 Shorties 搜得出
 * 播不了＋封面全占位后立） ──
 * 资格＝适配器三段（搜索＋详情＋取流）都有真实现，缺一段即出局；源不
 * 删、频道浏览不受此限，只管搜索扇出（与 F2 线口径一致）。
 * 「真实现」的可测口径（源粒度认定，因注册表证据本身是源粒度的）：
 * ① 模板在 CHAIN_TEMPLATES 内——工厂真能实例化出带 search/detail/
 *    resolve 的适配器（none→null、preview-only 无 search 且 resolve
 *    明确拒绝，均不算）；② capabilities.search 为真（搜索段声明）；
 * ③ maturity="stable"——types.ts 定义即「真站实测三段全通」，probe=
 *    部分未证、blocked/preview 自不在内；④ note 不含「未按真站校准」
 *    （目录导入通用骨架标记，防被误标 stable 时兜底）。
 * 结构上有方法≠真实现：hls-site 骨架对任何源都生成三方法，Shorties
 * 正是这样混进扇出的——故认定只认验通标记，不认方法存在性。 */
export type SearchSegment = "search" | "detail" | "play";
const CHAIN_TEMPLATES = new Set(["native-huangguo", "chigua", "wp-rest", "hls-site", "danbooru-api"]);

/** 未获真实现认定的段（三段全列或空）：认定须四条同时成立，任一不
 * 成立则三段均不获认定（卡点段逐源写在注册表 note 里）。 */
export function missingSearchSegments(def: SourceDef): SearchSegment[] {
  const skeleton = (def.note ?? "").includes("未按真站校准");
  const verified = CHAIN_TEMPLATES.has(def.adapter.template)
    && def.capabilities.search
    && def.maturity === "stable"
    && !skeleton;
  return verified ? [] : ["search", "detail", "play"];
}

export function hasCompleteSearchChain(def: SourceDef): boolean {
  return missingSearchSegments(def).length === 0;
}

export interface SearchPolicy {
  include: boolean;
  weight: number;
  tier: "primary" | "supplement" | "supplement-low" | "neutral" | "off";
  reason: string;
}

export function searchPolicyFor(def: SourceDef): SearchPolicy {
  const id = def.id;
  let weight = NEUTRAL_WEIGHT;
  let tier: SearchPolicy["tier"] = "neutral";
  if (id in PRIMARY_WEIGHTS) { weight = PRIMARY_WEIGHTS[id]; tier = "primary"; }
  else if (id in SUPPLEMENT_WEIGHTS) { weight = SUPPLEMENT_WEIGHTS[id]; tier = "supplement"; }
  else if (id in SUPPLEMENT_LOW_WEIGHTS) { weight = SUPPLEMENT_LOW_WEIGHTS[id]; tier = "supplement-low"; }
  if (OFF_IDS.has(id)) return { include: false, weight: 0, tier: "off", reason: "分层总表默认禁用/暂缓/观察，不进搜索默认范围" };
  const missing = missingSearchSegments(def);
  if (missing.length > 0) {
    return { include: false, weight, tier, reason: `三段不齐（缺 ${missing.join("/")} 真实现）：不进搜索扇出（源保留、频道浏览不受此限）` };
  }
  if (INCLUDE_OVERRIDE.has(id)) return { include: true, weight, tier, reason: "分层总表点名默认启用且三段齐全（搜索层纳入，注册表动作走清单 v2）" };
  if (!def.enabled) return { include: false, weight, tier, reason: "未启用" };
  return { include: true, weight, tier, reason: "已启用且三段齐全（总表未覆盖者中性纳入）" };
}

/* ── 归类（用户 2026-11-19 17:43 原则：按内容性质、不按媒体格式） ──
 * 判定信号优先级（可测口径，每条只归一个主类）：
 * ① 图片主体（image 类源/图集）→ 图片；
 * ② 文字主体（post 类源）→ 帖子（带视频/分集也归帖子，文字主体优先）；
 * ③ 有分集/连续剧集结构 → 短剧（原生 VideoCard 看 total_episodes/
 *    episode_count＞1；外部专用短剧源内容性质即连续剧集）；
 * ④ 其余独立单条视频 → 视频。
 * 边界：单集短剧（仅 1 集）在原生侧无结构信号可辨，归视频（如实
 * 限制，不臆造判据）；外部 post 源条目即使详情带视频也不改类。 */
const DRAMA_SOURCE_IDS = new Set(["rouvideo-drama", "drama91", "huangdou"]);
export function kindForSourceDef(def: SourceDef): GlobalSearchKind {
  if (def.category === "image" || def.kind === "image") return "image";
  if (def.category === "posts" || def.kind === "post") return "post";
  if (DRAMA_SOURCE_IDS.has(def.id)) return "drama";
  return "video";
}
/** 黄果 VideoCard 归类：有分集结构（总集数/已出集数＞1）→ 短剧，其余单条 → 视频。 */
export function kindForHuangguoVideo(card: { total_episodes?: number; episode_count?: number }): GlobalSearchKind {
  return (card.total_episodes ?? 0) > 1 || (card.episode_count ?? 0) > 1 ? "drama" : "video";
}

/* ── 扇出（调度：单源超时＋每源上限＋渐进呈现） ── */
export interface FanoutHit {
  sourceId: string;
  sourceName: string;
  kind: GlobalSearchKind;
  item: SourceItem;
  weight: number;
  hot: number;
  /** 确定性序号（目标源序×1000＋源内序）：与到达先后无关，渐进重排时已显条目相对序不变。 */
  seq: number;
  /** 发布时间（ms，可缺：外部 SourceItem 无此字段，黄果侧由 created_at/publish_time 解析）。 */
  publishedAt?: number;
}

export interface FanoutFailure { sourceId: string; message: string }

export interface FanoutOptions {
  /** 单源超时（ms），超时按失败静默跳过。默认 10s。 */
  timeoutMs?: number;
  /** 每源结果上限。默认 20。 */
  perSourceLimit?: number;
  onFailure?: (sourceId: string, message: string) => void;
  /** 渐进呈现：任一源落定即以累计 hits 回调（先到先显）。 */
  onPartial?: (hits: FanoutHit[]) => void;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => { setTimeout(() => reject(new Error("搜索超时")), ms); }),
  ]);
}

/**
 * 对全部纳入源并发 search。永不抛错：单源失败/超时进 failures 并
 * 回调 onFailure（生产接 tracePlayback 留痕），其余源照常。
 */
export async function fanoutSearch(
  keyword: string,
  defs: SourceDef[],
  makeAdapter: (def: SourceDef) => SourceAdapter | null,
  opts: FanoutOptions = {},
): Promise<{ hits: FanoutHit[]; failures: FanoutFailure[]; searched: string[] }> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const limit = opts.perSourceLimit ?? 20;
  const targets = defs.filter((d) => searchPolicyFor(d).include);
  const failures: FanoutFailure[] = [];
  const searched: string[] = [];
  const perDef: { def: SourceDef; items: SourceItem[] }[] = targets.map((def) => ({ def, items: [] }));
  const buildHits = (): FanoutHit[] => {
    const hits: FanoutHit[] = [];
    perDef.forEach(({ def, items }, di) => {
      const policy = searchPolicyFor(def);
      items.forEach((item, ii) => {
        hits.push({
          sourceId: def.id, sourceName: def.displayName, kind: kindForSourceDef(def),
          item, weight: policy.weight, hot: item.hot ?? 0, seq: di * 1000 + ii,
        });
      });
    });
    return hits;
  };
  await Promise.all(targets.map(async (def, di) => {
    const adapter = makeAdapter(def);
    if (!adapter?.search) {
      const message = "适配器不支持搜索";
      failures.push({ sourceId: def.id, message });
      opts.onFailure?.(def.id, message);
      return;
    }
    searched.push(def.id);
    try {
      const r = await withTimeout(adapter.search(keyword, 1, limit), timeoutMs);
      perDef[di].items = (r?.items ?? []).slice(0, limit);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failures.push({ sourceId: def.id, message });
      opts.onFailure?.(def.id, message);
    }
    opts.onPartial?.(buildHits());
  }));
  return { hits: buildHits(), failures, searched };
}

/* ── 合并置信（多信号：规范化标题＋封面指纹＋发布时间） ── */
export function normalizeTitle(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/\s+/g, "").replace(/[\p{P}\p{S}]/gu, "");
}

function bigramJaccard(a: string, b: string): number {
  const grams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i + 2 <= s.length; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

export type TitleSignal = "exact" | "similar" | "none";
/** 标题信号：归一化全等=exact；包含（短方≥8）或 bigram Jaccard ≥0.85（双方≥6）=similar；余 none。 */
export function titleSignal(a: string, b: string): TitleSignal {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return "none";
  if (na === nb) return "exact";
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (short.length >= 8 && long.includes(short)) return "similar";
  if (na.length >= 6 && nb.length >= 6 && bigramJaccard(na, nb) >= 0.85) return "similar";
  return "none";
}

export function areTitlesDuplicate(a: string, b: string): boolean {
  return titleSignal(a, b) !== "none";
}

/** 封面指纹：URL 路径部分（去协议/主机/查询），小写。解析失败用原串小写。 */
export function coverFingerprint(cover: string): string {
  if (!cover) return "";
  try { return new URL(cover).pathname.toLowerCase(); } catch { return cover.trim().toLowerCase(); }
}

export type CoverSignal = "match" | "similar" | "mismatch" | "unknown";
export function coverSignal(a: string, b: string): CoverSignal {
  const fa = coverFingerprint(a);
  const fb = coverFingerprint(b);
  if (!fa || !fb) return "unknown";
  if (fa === fb) return "match";
  const base = (p: string) => p.split("/").filter(Boolean).pop() ?? "";
  if (base(fa) && base(fa) === base(fb)) return "similar";
  const toks = (p: string) => new Set(p.split(/[/._-]+/).filter(Boolean));
  const ta = toks(fa);
  const tb = toks(fb);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union > 0 && inter / union >= 0.8 ? "similar" : "mismatch";
}

export type TimeSignal = "close" | "far" | "unknown";
/** 发布时间信号：相差 ≤48h=close；＞30 天=far；中间或任一缺失=unknown（不加不减）。 */
export function timeSignal(a?: number, b?: number): TimeSignal {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return "unknown";
  const diff = Math.abs(a - b);
  if (diff <= 48 * 3600_000) return "close";
  if (diff > 30 * 24 * 3600_000) return "far";
  return "unknown";
}

/** 合并置信分：标题 exact +3 / similar +1（none 直接 -Infinity 不合并）；
 * 封面 match +2 / similar +1 / mismatch −2 / unknown 0；
 * 时间 close +1 / far −2 / unknown 0。 */
export function mergeConfidence(a: FanoutHit, b: FanoutHit): number {
  const t = titleSignal(a.item.title, b.item.title);
  if (t === "none") return Number.NEGATIVE_INFINITY;
  let score = t === "exact" ? 3 : 1;
  const c = coverSignal(a.item.cover, b.item.cover);
  score += c === "match" ? 2 : c === "similar" ? 1 : c === "mismatch" ? -2 : 0;
  const ts = timeSignal(a.publishedAt, b.publishedAt);
  score += ts === "close" ? 1 : ts === "far" ? -2 : 0;
  return score;
}
/** 置信门：≥3 才合并（宁漏勿误，中低置信保持独立）。 */
export const MERGE_THRESHOLD = 3;
/** 身份确认门：合并置信 ≥4 才算身份已确认（允许自动切副本）。 */
export const CONFIRMED_THRESHOLD = 4;

/* ── 合并（索引层合并、不删副本） ── */
export interface CopyRef {
  sourceId: string;
  sourceName: string;
  weight: number;
  hot: number;
  seq: number;
  item: SourceItem;
  publishedAt?: number;
}

export interface MergedHit {
  kind: GlobalSearchKind;
  /** 展示字段取默认副本（簇内最高优先级副本）。 */
  title: string;
  cover: string;
  tags: string[];
  sourceId: string;
  sourceName: string;
  item: SourceItem;
  publishedAt?: number;
  /** 簇内热度 max（混排序用）。 */
  hot: number;
  seq: number;
  /** 全部副本（按权重 desc → hot desc → 源内序排列），一条不删。 */
  copies: CopyRef[];
  /** 其余副本的来源名（供「多源都有」呈现）。 */
  alsoOn: string[];
  /** 身份已确认（合并置信达确认门，或单副本天然自明）：决定详情失败时能否自动切副本。 */
  identityConfirmed: boolean;
  /** 簇内最弱一环的合并置信（单副本为确认门哨兵值）。 */
  mergeConfidence: number;
}

const byPriority = (a: CopyRef, b: CopyRef) => b.weight - a.weight || b.hot - a.hot || a.seq - b.seq;

/** 副本去重键（3.2.1 F1）：(sourceId, externalId)——同一条目经两条
 * 路径重复到达时是同一副本、不是两个副本。 */
export function copyDedupKey(c: { sourceId: string; item: { externalId: string } }): string {
  return `${c.sourceId}:${c.item.externalId}`;
}

/** 同源重复判据（3.2.1 F1，用户实报同源同帖出两张卡）：与簇内已有
 * 副本同源时，externalId 相同 = 同一条目（"id"，自明）；标题规范化
 * 全等＋封面指纹相同 = 同内容重复挂载（"content"）；其余同源条目
 * 仍视为不同条目（返回 null，不合并）。 */
export function sameSourceDuplicateKind(existing: CopyRef, incoming: FanoutHit): "id" | "content" | null {
  if (existing.sourceId !== incoming.sourceId) return null;
  if (existing.item.externalId === incoming.item.externalId) return "id";
  if (titleSignal(existing.item.title, incoming.item.title) === "exact"
    && coverSignal(existing.item.cover, incoming.item.cover) === "match") return "content";
  return null;
}

/** 合并规则（3.2.1 F1 修订）：同 kind 内——
 * ① 同源同 ID 必合并（去重、不留假副本、身份自明不降置信）；
 * ② 同源同标题＋同封面必合并；
 * ③ 跨源仍走既有多信号置信门（≥3 合并、≥4 身份确认、宁漏勿误，
 * 口径不削弱）；同源但非重复者不合并。
 * 代表条目取簇内首个（最高优先级）副本逐条比对。 */
export function mergeHits(hits: FanoutHit[]): MergedHit[] {
  const sorted = [...hits].sort((a, b) => byPriority(
    { sourceId: a.sourceId, sourceName: a.sourceName, weight: a.weight, hot: a.hot, seq: a.seq, item: a.item },
    { sourceId: b.sourceId, sourceName: b.sourceName, weight: b.weight, hot: b.hot, seq: b.seq, item: b.item },
  ));
  const clusters: MergedHit[] = [];
  const reps: FanoutHit[] = [];
  for (const h of sorted) {
    const copy: CopyRef = { sourceId: h.sourceId, sourceName: h.sourceName, weight: h.weight, hot: h.hot, seq: h.seq, item: h.item, publishedAt: h.publishedAt };
    let mergedInto: MergedHit | null = null;
    let conf = 0;
    let dedupSameId = false;
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i];
      if (c.kind !== h.kind) continue;
      let sameKind: "id" | "content" | null = null;
      for (const cp of c.copies) {
        const k = sameSourceDuplicateKind(cp, h);
        if (k === "id") { sameKind = "id"; break; }
        if (k === "content") sameKind = "content";
      }
      if (sameKind === "id") { mergedInto = c; dedupSameId = true; break; }
      if (sameKind === "content") {
        /* 同题（+3）＋同封面（+2）=5；同源重发发布时间可远，不扣时间分。 */
        mergedInto = c; conf = 5; break;
      }
      if (c.copies.some((cp) => cp.sourceId === h.sourceId)) continue;
      const score = mergeConfidence(reps[i], h);
      if (score >= MERGE_THRESHOLD) { mergedInto = c; conf = score; break; }
    }
    if (mergedInto) {
      if (!dedupSameId) {
        if (!mergedInto.copies.some((cp) => copyDedupKey(cp) === copyDedupKey(copy))) mergedInto.copies.push(copy);
        if (h.sourceName !== mergedInto.sourceName && !mergedInto.alsoOn.includes(h.sourceName)) mergedInto.alsoOn.push(h.sourceName);
        mergedInto.mergeConfidence = Math.min(mergedInto.mergeConfidence, conf);
        mergedInto.identityConfirmed = mergedInto.mergeConfidence >= CONFIRMED_THRESHOLD;
      }
      mergedInto.hot = Math.max(mergedInto.hot, h.hot);
    } else {
      clusters.push({
        kind: h.kind, title: h.item.title, cover: h.item.cover, tags: h.item.tags ?? [],
        sourceId: h.sourceId, sourceName: h.sourceName, item: h.item, publishedAt: h.publishedAt,
        hot: h.hot, seq: h.seq, copies: [copy], alsoOn: [],
        identityConfirmed: true, mergeConfidence: CONFIRMED_THRESHOLD,
      });
      reps.push(h);
    }
  }
  return clusters;
}

/** 同类混排序：相关性（热度）desc 优先，源等级（权重）只作 tiebreak，再源内序（稳定全序）。 */
export function rankMerged(merged: MergedHit[]): MergedHit[] {
  return [...merged].sort((a, b) =>
    b.hot - a.hot || (b.copies[0]?.weight ?? 0) - (a.copies[0]?.weight ?? 0) || a.seq - b.seq);
}

export const FIRST_SCREEN_WINDOW = 12;
export const FIRST_SCREEN_SOURCE_CAP = 6;
/** 单源首屏贡献上限：首屏窗口（head）内同一来源（按默认副本源）
 * 至多 cap 条，超出者顺延到窗口之后（相对序不变），防单一源淹没
 * 首屏；窗口靠其他源填不满时顺延项自然回填（多样性下限，不造空位）。 */
export function applySourceContributionCap(
  merged: MergedHit[],
  windowSize: number = FIRST_SCREEN_WINDOW,
  cap: number = FIRST_SCREEN_SOURCE_CAP,
): MergedHit[] {
  const head: MergedHit[] = [];
  const tail: MergedHit[] = [];
  const counts = new Map<string, number>();
  for (const m of merged) {
    const c = counts.get(m.sourceId) ?? 0;
    if (head.length < windowSize && c < cap) {
      head.push(m);
      counts.set(m.sourceId, c + 1);
    } else {
      tail.push(m);
    }
  }
  return [...head, ...tail];
}

/** 聚合：合并＋混排＋首屏上限后按四类分组（四键恒在）。 */
export function aggregateHits(hits: FanoutHit[]): Record<GlobalSearchKind, MergedHit[]> {
  const groups: Record<GlobalSearchKind, MergedHit[]> = { video: [], drama: [], post: [], image: [] };
  for (const m of rankMerged(mergeHits(hits))) groups[m.kind].push(m);
  for (const k of Object.keys(groups) as GlobalSearchKind[]) groups[k] = applySourceContributionCap(groups[k]);
  return groups;
}

/* ── 副本结构完整度与默认副本选择链 ── */
export interface StructuralCompleteness {
  hasVideo: boolean;
  imageCount: number;
  textLength: number;
}

const ZERO_STRUCTURAL: StructuralCompleteness = { hasVideo: false, imageCount: 0, textLength: 0 };

/** 结构完整度只认三项结构信号：有无视频（episodes 非空）、图数、
 * 正文长度（contentHtml 去标签字数＋description 字数）。它只证明
 * 结构组成、不证明质量；画质/码率不可测、不参与、不声称已判优。 */
export function structuralCompletenessOf(detail: SourceDetail): StructuralCompleteness {
  const text = (detail.contentHtml ?? "").replace(/<[^>]*>/g, "") + (detail.description ?? "");
  return {
    hasVideo: (detail.episodes?.length ?? 0) > 0,
    imageCount: detail.images?.length ?? 0,
    textLength: text.length,
  };
}

/** 正数 = a 结构更完整。比较序：有无视频 → 图数 → 文长。 */
function compareStructural(a: StructuralCompleteness, b: StructuralCompleteness): number {
  return (Number(b.hasVideo) - Number(a.hasVideo)) || (b.imageCount - a.imageCount) || (b.textLength - a.textLength);
}

/** 副本实测评估：可用性（详情/取流实测：true 成功 / false 失败 /
 * null 未测）、结构完整度、历史可靠性（取页成功率 0..1，null 无记录）。 */
export interface CopyAssessment {
  available: boolean | null;
  structural: StructuralCompleteness | null;
  reliability: number | null;
}

const availableRank = (a: CopyAssessment | undefined) => (a?.available === true ? 2 : a?.available === false ? 0 : 1);
const reliabilityOf = (a: CopyAssessment | undefined) => a?.reliability ?? 0.5;

/** 默认副本选择链（裁定第 1 条）：身份一致（簇内统一，不参与排序）
 * → 可用性 → 结构完整度 → 历史可靠性（无记录按中性 0.5）→
 * 分层权重（最后 tiebreak）→ 热度 → 源内序。 */
export function compareCopiesForDefault(
  a: CopyRef, b: CopyRef,
  assessments: Map<string, CopyAssessment>,
): number {
  const aa = assessments.get(a.sourceId);
  const ab = assessments.get(b.sourceId);
  const byAvail = availableRank(ab) - availableRank(aa);
  if (byAvail) return byAvail;
  const byStructural = compareStructural(aa?.structural ?? ZERO_STRUCTURAL, ab?.structural ?? ZERO_STRUCTURAL);
  if (byStructural) return byStructural;
  const byReliability = reliabilityOf(ab) - reliabilityOf(aa);
  if (byReliability) return byReliability;
  return b.weight - a.weight || b.hot - a.hot || a.seq - b.seq;
}

/** 默认副本：按选择链排序后首个「未实测失败」的副本；全部实测失败 → null。 */
export function selectDefaultCopy(
  copies: CopyRef[],
  assessments: Map<string, CopyAssessment>,
): CopyRef | null {
  const ordered = [...copies].sort((a, b) => compareCopiesForDefault(a, b, assessments));
  return ordered.find((c) => assessments.get(c.sourceId)?.available !== false) ?? null;
}

/** 展示/顺延序：默认副本居首，其余按选择链。 */
export function orderCopiesForDisplay(
  copies: CopyRef[],
  assessments: Map<string, CopyAssessment>,
): CopyRef[] {
  const ordered = [...copies].sort((a, b) => compareCopiesForDefault(a, b, assessments));
  const first = selectDefaultCopy(copies, assessments);
  if (!first) return ordered;
  return [first, ...ordered.filter((c) => c !== first)];
}

/**
 * 副本顺延加载：按给定顺序逐个尝试，失败回调留痕后静默试下一个；
 * 任一成功即返回（不抛错、不打断）；全部失败返回 null（调用方此时
 * 才呈现错误态）。身份门（裁定第 4 条）：allowAutoSwitch=false 时
 * 只试首个副本、禁止自动顺延（身份未确认的合并条目），手动切换
 * 走单副本直调、不经本函数。
 */
export async function loadWithFallback<T>(
  copies: CopyRef[],
  load: (copy: CopyRef) => Promise<T>,
  opts?: { allowAutoSwitch?: boolean; onFail?: (copy: CopyRef, error: unknown) => void } | ((copy: CopyRef, error: unknown) => void),
): Promise<{ copy: CopyRef; value: T; attempts: string[] } | null> {
  const onFail = typeof opts === "function" ? opts : opts?.onFail;
  const allowAutoSwitch = typeof opts === "function" ? true : (opts?.allowAutoSwitch ?? true);
  const attempts: string[] = [];
  const targets = allowAutoSwitch ? copies : copies.slice(0, 1);
  for (const copy of targets) {
    attempts.push(copy.sourceId);
    try {
      const value = await load(copy);
      return { copy, value, attempts };
    } catch (e) {
      onFail?.(copy, e);
    }
  }
  return null;
}
