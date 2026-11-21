/**
 * 适配器模板骨架（Muse 2026-11-19 根治包·多源线 条目4）：
 * (a) chigua 吃瓜模板——同模板站共用爬取骨架（51吃瓜网/每日大赛）；
 * (b) wp-rest WP REST 骨架（秀人网）；
 * (c) hls-site 通用 HLS 站骨架——参数=列表/详情路径+条目链接特征+
 *     m3u8 提取（正则），视频与图集站按参数实例化；
 * (d) danbooru-api 公开 API 实例化（Danbooru）。
 * 全部经 fetchPage.ts 收敛取页；解析为正则级（见 parse.ts）。
 */
import type { Paged } from "../../../shared/api/types";
import type { SourceAdapter, SourceDef, SourceDetail, SourceItem, SourceTaxonomy } from "../types.ts";
import { fetchPage } from "./fetchPage.ts";
import { httpStatusOf } from "./resolveTrace.ts";
import { allImgSrcs, cardCategoryTokens, contentImgSrcs, decodeEntities, extractIframeSrc, extractM3u8, extractMp4, findAnchors, findCardAnchors, firstCoverSrc, firstImgSrc, headingText, imgAlt, lastPageInNav, metaContent, pageOf, stripTags } from "./parse.ts";

export const TEMPLATE_IDS = ["native-huangguo", "chigua", "wp-rest", "hls-site", "danbooru-api", "hanime-api", "none"] as const;
type Params = Record<string, unknown>;
const str = (p: Params, k: string, d = "") => (typeof p[k] === "string" ? (p[k] as string) : d);

/* WP taxonomy 成功结果缓存（fix335/f-discovery，见 createWpRestAdapter）。 */
const wpTaxonomyCache = new Map<string, Promise<SourceTaxonomy>>();

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}

function absUrl(base: string, href: string): string {
  try { return new URL(href, base).href; } catch { return href; }
}

/* ── 分页信号（Muse 2026-11-20 fix335/a-pagination 根治）──
 * 旧口径之病：除 002（全目录本地切片、总数真实）外，每个适配器都把
 * 「本次取回条数」喂给 pageOf 冒充总量——满页型 pages 恒 1、HTML 型
 * 恒 2，三套 UI 以 page>=pages 停拉，各源在 20–40 条见底，与站方
 * 万级库存脱钩（审计 fix335/audit-007-inventory.md §1，live 旧红
 * harness 实证）。新口径：pages 只许来自下列信号，按优先级——
 * ① 服务端真信号：API 总数字段、HTML 分页导航末页
 *    （parse.ts lastPageInNav）、响应自带总页数；
 * ② 「下一页」链接实存（HTML 列表模板，nextPageLinkPresent）；
 * ③ 满页推断：本页取回数达到请求页容量（服务端页式 API 的满页是
 *    精确的 size、HTML 站方页卡数 ≥ size）→ 暂报 page+1（只声称
 *    「至少还有一页可探」），不满页即尾页。推断的终止由后续空页
 *    （apiSignal 对 fetched=0 报 page-1）与 UI 侧零新增终止兜底，
 *    不会无限续拉。total 无真信号时只报「已取回条数下限」
 *    （(page-1)*size+fetched，均匀页 API 口径）或本页条数（HTML
 *    口径，与旧 pageOf 的 total 语义一致），不冒充站方总量。 */
interface PageSignal { pages: number; total: number }

function apiSignal(fetched: number, page: number, size: number): PageSignal {
  if (fetched <= 0) return { pages: Math.max(1, page - 1), total: Math.max(0, (page - 1) * size) };
  return fetched >= size
    ? { pages: page + 1, total: page * size }
    : { pages: page, total: (page - 1) * size + fetched };
}

/** 「下一页」链接实存判读（HTML 模板信号②）：路径模板填入 page+1
 * 后与页内任一锚点 href 精确对上（相对/绝对形态都认尾段一致）。
 * 模板除 {page} 外还有别的占位（搜索 {q} 的编码形态与站方 href
 * 不可比）时不判，留给导航末页信号。 */
function nextPageLinkPresent(html: string, pathTemplate: string, page: number): boolean {
  if (pathTemplate.replace("{page}", "").includes("{")) return false;
  const next = fill(pathTemplate, { page: page + 1 });
  return findAnchors(html).some((a) => a.href === next || a.href.endsWith(next));
}

/** HTML 列表模板的分页信号：模板无 {page} = 站方面无分页形态
 * （007 /recent/ 橱窗实证：站方不认页码、恒回同一组），pages 恒为
 * 当前页——满页推断对它不适用，防它被误判出无限下一页。 */
function htmlSignal(html: string, pathTemplate: string, fetched: number, page: number, size: number): PageSignal {
  if (!pathTemplate.includes("{page}")) return { pages: page, total: fetched };
  const nav = lastPageInNav(html, pathTemplate);
  if (nav !== null) return { pages: Math.max(page, nav), total: fetched };
  if (nextPageLinkPresent(html, pathTemplate, page)) return { pages: page + 1, total: fetched };
  if (fetched >= size) return { pages: page + 1, total: fetched };
  return { pages: page, total: fetched };
}

/** 解析为空错误（Muse 2026-11-19 fix321-F2）：取页成功但锚点解析
 * 为 0 = 页面结构与模板不匹配（或内容由前端渲染），不是「真空」。
 * 列表层据此落显式失败态，不许再显示假成功空页；search 不用本错
 * （搜索无结果是合法真空）。 */
export class SourceParseEmptyError extends Error {
  constructor(sourceId: string) {
    super(`列表解析失败：${sourceId} 取回的页面未解析到条目（页面结构与适配器模板不匹配，或内容由前端渲染）`);
    this.name = "SourceParseEmptyError";
  }
}

/** JSON 列表响应形状守卫（Muse 2026-11-20 fix333-M3，3.3.2 清扫
 * P3）：JSON 模板与 HTML 模板的「空」语义不同——HTML 解析出 0 锚点
 * 几乎必然是结构漂移（抛 SourceParseEmptyError），JSON API 的 []
 * 则是上游明示的真空（列表真空/搜索无结果），必须正常返回空列表、
 * 不抛错、自检不记失败。但响应形状漂移（上游改版成对象包裹、错误
 * 页冒充 200、非 JSON 文本）不能冒充真空：解析不出数组即按解析为
 * 空抛 SourceParseEmptyError，与 HTML 口径一致——界面「解析不到条
 * 目时已按加载失败处理」的空态文案对 JSON 模板由此成立。此前
 * wp-rest/danbooru 对响应直接 JSON.parse 后 .map：[] 静默当真空、
 * 非数组则抛 TypeError 裸奔，两头都不对。 */
function parseJsonArray<T>(raw: string, sourceId: string): T[] {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new SourceParseEmptyError(sourceId); }
  if (!Array.isArray(data)) throw new SourceParseEmptyError(sourceId);
  return data as T[];
}

/** 标题兜底（fix321-F2）：锚点无 title/alt/文本时（如 PornPics 图集
 * tile 的 img alt 为空）由 href 末段 slug 还原（去尾部数字 id）。 */
function titleFromHref(href: string): string {
  try {
    const seg = new URL(href).pathname.split("/").filter(Boolean).pop() ?? "";
    /* slug 还原的标题同样是文本入界面路径，经共用解码单点（fix330）。 */
    return decodeEntities(decodeURIComponent(seg).replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").replace(/\s+\d+$/, "").trim());
  } catch { return ""; }
}

/** 卡内推广帖组合判据（Muse 2026-11-20 fix333/promo-filter）：只认
 * 站方分类学信号，不用标题关键词表。判据＝卡片分类词元（post-card-
 * meta 的分类 span，见 parse.ts cardCategoryTokens）命中源声明的
 * 公告类分类（params.announcementCats，如站方的活动存档/主题大赛
 * 分类——该分类在真站样本里只装公告/活动帖），或「分类＝大赛栏目
 * （params.contestCat）∧ 标题为栏目公告框式（params.contestTitle-
 * Prefix 开头，如「每日大赛之【…】」征集帖）」的组合（栏目分类本身
 * 也装参赛内容帖，须叠标题框式才判公告）。词元逐个精确比对；无
 * 分类 span 的卡片（旧卡变体、无元信息卡）不判。样本与杀率见
 * fix333/evidence/promo-filter.md（003/005 分类样本内容误杀 0）。 */
export interface PromoCardFilter {
  announcementCats: string[];
  contestCat: string;
  contestTitlePrefix: string;
}

function isPromoCard(inner: string, title: string, promo: PromoCardFilter): boolean {
  const tokens = cardCategoryTokens(inner);
  if (tokens.length === 0) return false;
  if (promo.announcementCats.some((c) => tokens.includes(c))) return true;
  return Boolean(promo.contestCat && promo.contestTitlePrefix
    && tokens.includes(promo.contestCat) && title.startsWith(promo.contestTitlePrefix));
}

/** 锚点列表解析（chigua 与 hls-site 共用）：href 含 itemLinkPattern 的锚点为条目。
 * 卡片容器限定（Muse 2026-11-20 fix333/list-noise）：源在注册表声明
 * cardContainer 时只认卡片容器内的锚点——整页扫描会把页眉导航下拉、
 * 页脚站务/招募组的同形态锚点误收为条目（吃瓜三源普查 9 页实测：
 * 003 每页 2 条恒居首、004 每页 12 条，容器内外零交叉，证据
 * fix333/evidence/adpost-census.md）。页面层广告卡（ad-item 类、
 * rel="sponsored"、ssp-placement＋template 假卡）由 findCardAnchors
 * 显式排除（此前靠外链不含条目模式偶然挡住）。容器采集为 0＝页面
 * 形态与声明不匹配，按「未知不是空」回落整页扫描（旧行为），不把
 * 形态漂移误报成空列表。未声明 cardContainer 的源行为逐字不变。
 * 推广帖过滤（fix333/promo-filter）：promo 声明时，条目成形后（标题
 * 确定后）、入列前过 isPromoCard；与容器采集正交，两参数由
 * htmlListAdapter 从 params 组装、list/search 两路同口径透传。
 * 条目链接正则（Muse 2026-11-20 fix338/realphoto-add）：源声明
 * itemLinkRegex 时锚点匹配改走正则（对原始 href 全串匹配）——子串
 * 模式在路径前缀多义的站上会误收同前缀的分类页/隐藏空锚/分页锚
 * （xsnvshen /album/ 裸子串实测 132 条 vs 真卡 25 条）；未声明的
 * 源逐字走子串口径、行为不变。 */
function parseAnchorList(html: string, base: string, sourceId: string, itemLinkPattern: string, cardContainer = "", promo?: PromoCardFilter, retainCats = false, itemLinkRe?: RegExp): SourceItem[] {
  const seen = new Set<string>();
  const items: SourceItem[] = [];
  let anchors = cardContainer === "article" || cardContainer === "video-item" ? findCardAnchors(html, cardContainer) : [];
  if (anchors.length === 0) anchors = findAnchors(html);
  for (const a of anchors) {
    if (itemLinkRe ? !itemLinkRe.test(a.href) : !a.href.includes(itemLinkPattern)) continue;
    const href = absUrl(base, a.href);
    if (seen.has(href)) continue;
    seen.add(href);
    const realTitle = a.titleAttr || headingText(a.inner) || imgAlt(a.inner) || stripTags(a.inner);
    /* 严格形态源的空壳锚剔除（fix338/realphoto-add）：声明
     * itemLinkRegex 的源按「卡片必有真实标题载体」收紧——站方埋的
     * 隐藏 SEO 空锚（rel=nofollow noindex、无 title/文本/图 alt）
     * 形态上能过正则，但标题只能靠 href 末段数字冒充，不是卡片。
     * 未声明正则的源逐字走旧口径（titleFromHref 兜底不变）。 */
    if (itemLinkRe && !realTitle) continue;
    const title = realTitle || titleFromHref(href);
    if (!title) continue;
    /* 推广帖过滤（fix333/promo-filter）：源声明判据时，公告/活动类
     * 卡片在列表层整条剔除（搜索同路径同口径）；未声明的源零影响。 */
    if (promo && isPromoCard(a.inner, title, promo)) continue;
    /* 封面空串守卫（Muse 2026-11-20 fix331/covers-header）：无封面
     * 载体时 firstCoverSrc 返回 ""，旧写法 absUrl(base, "") 把它补成
     * 站点根 URL——非空合法地址冒充封面，Img 遂把站点首页 HTML 当
     * 图片拉取、解码必失败整屏落 HG（3.3.1 真机 source-005 实锤）。
     * 与详情路径同口径：空则保持空串，界面走诚实无封面态。 */
    const coverSrc = firstCoverSrc(a.inner);
    /* 分类保留（Muse 2026-11-20 fix335/f-discovery）：仅吃瓜模板
     * 经 htmlListAdapter 选项开启——卡片分类词元即站方栏目归属，
     * 进 cats（与 tags 分开，见 types.ts）；未开启的源零影响。 */
    const cats = retainCats ? cardCategoryTokens(a.inner) : [];
    items.push({ sourceId, externalId: href, title, cover: coverSrc ? absUrl(base, coverSrc) : "", href, tags: [], ...(cats.length ? { cats } : {}) });
  }
  return items;
}

async function htmlDetail(def: SourceDef, externalId: string, scopeImagesToContent = false): Promise<SourceDetail> {
  const base = def.baseUrls[0];
  const html = await fetchPage(absUrl(base, externalId));
  const title = metaContent(html, "og:title") || stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  const cover = metaContent(html, "og:image");
  const hasStream = extractM3u8(html) !== null || extractMp4(html) !== null;
  return {
    sourceId: def.id, externalId, title, cover: cover ? absUrl(base, cover) : "",
    href: absUrl(base, externalId), tags: [], description: metaContent(html, "description"),
    contentHtml: undefined, images: (scopeImagesToContent ? contentImgSrcs(html) : allImgSrcs(html)).map((s) => absUrl(base, s)),
    episodes: hasStream ? [{ label: "正片", externalId }] : [],
  };
}

async function htmlResolve(def: SourceDef, externalId: string): Promise<{ streams: { url: string; kind: "hls" | "file" }[] }> {
  const base = def.baseUrls[0];
  /* 站内流端点模板（Muse 2026-11-19 fix321-F2b，肉视频）：真站流
   * 不在详情页 HTML 里、而是站内固定形态端点 /api/hls/<id>（插件与
   * 真站前端 chunk 双证据）；params.streamUrlTemplate 存在时直接按
   * 条目 id 拼端点、不回详情页找 m3u8。id 取条目 href 末段。 */
  const streamTpl = str((def.adapter.params ?? {}) as Params, "streamUrlTemplate", "");
  if (streamTpl) {
    let id = externalId;
    try { id = new URL(externalId).pathname.split("/").filter(Boolean).pop() ?? externalId; } catch { /* externalId 本就是 id */ }
    return { streams: [{ url: absUrl(base, fill(streamTpl, { id })), kind: "hls" as const }] };
  }
  const html = await fetchPage(absUrl(base, externalId));
  const m3u8 = extractM3u8(html);
  if (m3u8) return { streams: [{ url: m3u8, kind: "hls" as const }] };
  const mp4 = extractMp4(html);
  return { streams: mp4 ? [{ url: mp4, kind: "file" as const }] : [] };
}

/* 栏目表读取（Muse 2026-11-20 fix335/f-discovery）：注册表 params
 * 的 discoveryCategories（slug↔栏目名）是栏目全集的唯一出处，
 * htmlListAdapter 的路径校验与 DiscoverySpec 同读本函数，不许两处
 * 各抄一份。形态不符的条目剔除。rank＝该栏目是站方榜单（fix337/
 * chigua-surface：发现面只登记榜单子集、栏目全集降为 categoryPath
 * 路径校验出处，见 readDiscoveryRanks）。hot＝该榜单是站方热门
 * 栏目、即该源「最热」pill 的上游映射（fix338/chigua-pill：每源
 * 至多一个，与 rank 同标一处、不另抄名单）。 */
export interface DiscoveryCategoryParam { slug: string; name: string; rank?: boolean; hot?: boolean }
export function readDiscoveryCategories(def: SourceDef): DiscoveryCategoryParam[] {
  const params = (def.adapter.params ?? {}) as Record<string, unknown>;
  const raw = params.discoveryCategories;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    const o = x as { slug?: unknown; name?: unknown; rank?: unknown; hot?: unknown };
    return typeof o?.slug === "string" && o.slug && typeof o?.name === "string" && o.name
      ? [{ slug: o.slug, name: o.name, ...(o?.rank === true ? { rank: true } : {}), ...(o?.hot === true ? { hot: true } : {}) }]
      : [];
  });
}

/* 榜单子集（Muse 2026-11-20 fix337/chigua-surface）：栏目表中标
 * rank 的条目、按表内序——吃瓜面发现维度的唯一登记出处。榜单不
 * 是新维度：disc 的 period 字段承载榜单 slug（discFingerprint 已
 * 含 period、指纹与滚动恢复 key 天然隔离）、取页复用 categoryPath
 * 归档机制，见 htmlListAdapter.list。 */
export function readDiscoveryRanks(def: SourceDef): DiscoveryCategoryParam[] {
  return readDiscoveryCategories(def).filter((c) => c.rank === true);
}

/* 栏目归档路径（Muse 2026-11-20 fix335/f-discovery）：categoryPath
 * 模板含 {slug} 与 {page}；第 1 页为裸栏目路径（站方实证：带
 * /page/1/ 或 /1/ 后缀回 404 或重定向首页），故 page<=1 时剥掉页码
 * 段——两种模板形态（/category/{slug}/{page}/ 与 /{slug}/page/
 * {page}/）共用本构造。 */
function categoryPagePath(template: string, slug: string, page: number): string {
  const filled = template.replace("{slug}", slug);
  if (page > 1) return filled.replace("{page}", String(page));
  return filled.replace(/page\/\{page\}\/?/, "").replace(/\{page\}\/?/, "");
}

function htmlListAdapter(def: SourceDef, opts?: { retainCats?: boolean; searchRequiresPath?: boolean }): SourceAdapter {
  const params = (def.adapter.params ?? {}) as Params;
  const listPath = str(params, "listPath", "/?page={page}");
  const itemLinkPattern = str(params, "itemLinkPattern", "/");
  /* 条目链接正则（fix338/realphoto-add）：params 声明 itemLinkRegex
   * 时锚点匹配改走正则（见 parseAnchorList 头注）；正则非法属内置
   * 参数写错，构造期直接抛错由契约拦下，不静默回落子串口径。 */
  const itemLinkRegexRaw = str(params, "itemLinkRegex", "");
  const itemLinkRe = itemLinkRegexRaw ? new RegExp(itemLinkRegexRaw) : undefined;
  /* 卡片容器声明（fix333/list-noise）：按源主题在注册表 params 里
   * 声明（article / video-item），未声明的源整页扫描、行为不变。 */
  const cardContainer = str(params, "cardContainer", "");
  /* 推广帖判据（fix333/promo-filter）：params 声明才启用——
   * announcementCats=公告类分类词元数组、contestCat/contestTitlePrefix
   * =大赛栏目公告组合；三者皆缺省时 promo 为 undefined、解析旧行为。 */
  const announcementCats = Array.isArray(params.announcementCats)
    ? (params.announcementCats as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  const contestCat = str(params, "contestCat", "");
  const contestTitlePrefix = str(params, "contestTitlePrefix", "");
  const promo: PromoCardFilter | undefined = (announcementCats.length > 0 || (contestCat && contestTitlePrefix))
    ? { announcementCats, contestCat, contestTitlePrefix }
    : undefined;
  /* 栏目归档（Muse 2026-11-20 fix335/f-discovery）：params 声明
   * categoryPath 模板＋discoveryCategories 栏目表（slug↔名，注册表
   * 为唯一出处、DiscoverySpec 同读此处）才启用；disc.category 必须
   * 命中栏目表才拼路径，未命中/未声明一律走现行 listPath 缺省路径
   * 逐字不变。榜单（fix337/chigua-surface）：disc.period 命中
   * readDiscoveryRanks 子集时以同一机制拼归档路径（period 字段本
   * 为「周期榜」语义、指纹天然隔离）；category 优先于 period（两
   * 者同为归档 slug、UI 不会同时下发）；未标 rank 的栏目与未知值
   * 不入 period、回落缺省路径。011 的 period（monthly/all）走其
   * 专用适配器、不经本分支。 */
  const categoryPath = str(params, "categoryPath", "");
  const discoveryCategories = readDiscoveryCategories(def);
  const discoveryRanks = readDiscoveryRanks(def);
  return {
    sourceId: def.id,
    async list(page, size, disc) {
      const base = def.baseUrls[0];
      const cat = disc?.category && categoryPath && discoveryCategories.some((c) => c.slug === disc.category)
        ? disc.category
        : "";
      const rank = !cat && disc?.period && categoryPath && discoveryRanks.some((c) => c.slug === disc.period)
        ? disc.period
        : "";
      const slug = cat || rank;
      const pathTemplate = slug ? categoryPath.replace("{slug}", slug) : listPath;
      const path = slug ? categoryPagePath(categoryPath, slug, page) : fill(listPath, { page });
      const html = await fetchPage(absUrl(base, path));
      const all = parseAnchorList(html, base, def.id, itemLinkPattern, cardContainer, promo, opts?.retainCats ?? false, itemLinkRe);
      if (all.length === 0) {
        /* 未知不是空（fix321-F2）：第一页 0 条目 = 解析失败，显式抛错
         * 走列表层错误通道，口径不变。第二页起 0 条目按分页信号判读：
         * 导航仍覆盖本页（nav>=page）→ 返回空页让 UI 继续前进（站方
         * 整页被推广判据滤空等形态不许冒充到底）；导航不及本页 →
         * 已过末页，报尾页收尾。 */
        if (page <= 1) throw new SourceParseEmptyError(def.id);
        const nav = lastPageInNav(html, pathTemplate);
        return { items: [], pagination: { page, pages: nav !== null && nav >= page ? nav : page - 1, size, total: 0 } };
      }
      /* 整页消费（fix335/a-pagination）：UI 页与站方页 1:1——旧
       * slice(0, size) 把站方页第 21–30 卡在每一页恒定跳过（005 每
       * 页漏 10/30、live 实证），且 UI 页与站方页错位后无对齐点可
       * 补。现整页返回（22–30 条/页，UI 网格按实收条数渲染、口径
       * 与过滤后变长页一致），分页信号走 htmlSignal。 */
      return { items: all, pagination: { page, size, ...htmlSignal(html, pathTemplate, all.length, page, size) } };
    },
    detail: (id) => htmlDetail(def, id),
    resolve: (id) => htmlResolve(def, id),
    async search(q, page, size) {
      const base = def.baseUrls[0];
      /* 搜索路径按源校准（Muse 2026-11-19 3.3.0 接通批·吃瓜线）：
       * params.searchPath 存在时按真站形态拼（{q} 已编码、{page} 页码；
       * 51吃瓜/每日大赛实证为 Typecho 形态 /search/{q}/{page}/——站点
       * 对 /?s= 的重写会吞掉 paged 参数、恒回第一页，故不走默认形）。
       * 假回退拆除（Muse 2026-11-20 fix337/chigua-surface，范围＝
       * chigua 模板）：未声明 searchPath 时旧实现回退 WordPress 式
       * 默认形 /?s=&paged=——对无 GET 搜索段的源（005 实拉证伪：
       * 原样回首页流）等于把缺省流冒充搜索结果，违反「未知不是
       * 空」。chigua 家族改为显式抛错（opts.searchRequiresPath）：
       * 无搜索段就是无搜索段，caps 扇出本就不会对 caps.search=
       * false 的源调 search。hls-site 模板不在拆除范围：无在册
       * def、其默认形行为由既有契约钉住（Shorties 裁定走资格出
       * 局、不走适配器抛错），维持旧形态。 */
      const searchPath = str(params, "searchPath", "");
      if (!searchPath && opts?.searchRequiresPath) {
        throw new Error(`该源无搜索段（未声明 searchPath）：${def.id}`);
      }
      const path = searchPath
        ? fill(searchPath, { q: encodeURIComponent(q), page })
        : `/?s=${encodeURIComponent(q)}&paged=${page}`;
      const html = await fetchPage(absUrl(base, path));
      const all = parseAnchorList(html, base, def.id, itemLinkPattern, cardContainer, promo, opts?.retainCats ?? false, itemLinkRe);
      /* 搜索同列表口径（fix335/a-pagination）：整页消费＋htmlSignal
       * （信号模板用未填的 searchPath 形状、无声明时用默认形，两者
       * 的 {page} 段都是导航末页的提取形状）。搜索真空合法：0 条目
       * 返回空页、pages 止于当前页，不抛解析为空。 */
      const signalTemplate = searchPath || "/?s={q}&paged={page}";
      if (all.length === 0 && page > 1) {
        const nav = lastPageInNav(html, signalTemplate);
        return { items: all, pagination: { page, pages: nav !== null && nav >= page ? nav : page - 1, size, total: 0 } };
      }
      return { items: all, pagination: { page, size, ...htmlSignal(html, signalTemplate, all.length, page, size) } };
    },
  };
}

/** (a) 吃瓜模板：与 hls-site 共用锚点骨架，差异在详情带正文 HTML。 */
export function createChiguaAdapter(def: SourceDef): SourceAdapter {
  /* retainCats（fix335/f-discovery）：吃瓜卡片带站方分类词元，进
   * cats 字段；hls-site 不开（无分类登记）。searchRequiresPath
   * （fix337/chigua-surface）：chigua 家族无 searchPath 即无搜索
   * 段、search 显式抛错，不许模板默认形冒充（见 search 内注释）。 */
  const base0 = htmlListAdapter(def, { retainCats: true, searchRequiresPath: true });
  return {
    ...base0,
    async detail(id) {
      const d = await htmlDetail(def, id);
      const base = def.baseUrls[0];
      const html = await fetchPage(absUrl(base, id));
      /* 正文容器三形态：通用 <article>／entry-content 系 div／黑料网
       * editormd-preview 容器（Muse 2026-11-19 3.3.0 接通批·吃瓜线：
       * 该站正文 SSR 在 editormd-preview 内、旧两式恒捕获不到；捕获
       * 至正文后的 detail-blockquote 推荐段之前终止）。 */
      const bodyMatch = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html) ?? /<div\b[^>]*class="[^"]*(?:entry-content|post-content|article-content)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<footer|<aside)/i.exec(html) ?? /<div\b[^>]*class="[^"]*editormd-preview[^"]*"[^>]*>([\s\S]*?)<div\b[^>]*class="[^"]*detail-blockquote/i.exec(html);
      return { ...d, contentHtml: bodyMatch?.[1] };
    },
  };
}

/** (c) 通用 HLS 站骨架。详情图片限定内容区（Muse 2026-11-20
 * fix332-B1）：整页采集把页眉/页脚的站点样式图形混进图集
 * （pornpics 真站实锤：每册恒定 5 张样式 SVG），hls-site 的
 * detail.images 是相册本体、须纯；限定只挂本模板的 detail 路径
 * ——chigua 的 detail 不经此处（其正文图由 contentHtml 提取链
 * 负责），wp-rest/danbooru 的 images 本就来自内容载荷，均不外溢。 */
export function createHlsSiteAdapter(def: SourceDef): SourceAdapter {
  const base0 = htmlListAdapter(def);
  const params = (def.adapter.params ?? {}) as Params;
  /* 详情分页组装＋本册图过滤（Muse 2026-11-20 fix338/realphoto-add，
   * xsnvshen 校准）：详情页服务端分页（?p=N、每页定额张）且内容区
   * 混排相关推荐的他人图集缩略图——单页取图只有首段、整页取图会
   * 把推荐缩略图冒充本册图。params 声明 detailPageParam 时逐页
   * 跟进组装整册（新页零新增或取页失败即停、失败不拖垮已收段，
   * 上限 12 页防异常形态无限跟进）；声明 detailImagePattern
   * （含 {id} 占位、id 取条目 href 末段）时只留命中本册形态的全
   * 尺寸图。两参数皆未声明的源逐字走旧单页口径、行为不变。og
   * 封面缺失时以本册首图兜底（站方无 og:image、封面即图集首帧，
   * 非合成地址）。 */
  const detailPageParam = str(params, "detailPageParam", "");
  const detailImagePattern = str(params, "detailImagePattern", "");
  if (!detailPageParam && !detailImagePattern) return { ...base0, detail: (id) => htmlDetail(def, id, true) };
  return {
    ...base0,
    async detail(id) {
      const base = def.baseUrls[0];
      const first = await htmlDetail(def, id, true);
      let imageRe: RegExp | null = null;
      if (detailImagePattern) {
        let itemId = id;
        try { itemId = new URL(absUrl(base, id)).pathname.split("/").filter(Boolean).pop() ?? id; } catch { /* id 本就是末段形态 */ }
        imageRe = new RegExp(fill(detailImagePattern, { id: itemId }));
      }
      const keep = (urls: string[]): string[] => (imageRe ? urls.filter((u) => imageRe.test(u)) : urls);
      const seen = new Set<string>();
      const images: string[] = [];
      for (const u of keep(first.images)) { if (!seen.has(u)) { seen.add(u); images.push(u); } }
      if (detailPageParam) {
        const detailUrl = absUrl(base, id);
        const sep = detailUrl.includes("?") ? "&" : "?";
        for (let n = 2; n <= 12; n++) {
          let html: string;
          try { html = await fetchPage(`${detailUrl}${sep}${detailPageParam}=${n}`); } catch { break; }
          const fresh = keep(contentImgSrcs(html).map((s) => absUrl(base, s))).filter((u) => !seen.has(u));
          if (fresh.length === 0) break;
          for (const u of fresh) { seen.add(u); images.push(u); }
        }
      }
      return { ...first, images, cover: first.cover || images[0] || "" };
    },
  };
}

/** (b) WP REST 骨架（秀人网）。
 * Yoast 封面校准（Muse 2026-11-21 fix3312/cover-021，021）：
 * params 声明 yoastCover=true 时，toItem 封面在 <img> 回落
 * 落空后再回落帖对象 yoast_head_json.twitter_image——Yoast
 * SEO 发出的社交图字段、与 featured_media 同一文件、就在列表
 * 载荷内一次取数可得（021 接线时「封面不在 REST 载荷内」的
 * 结论只查了正文/excerpt 的 <img>，逐 key 穷尽复核后订正，
 * 证据 fix3312/evidence/cover-021.md）。Yoast 个别帖不发该
 * 字段时如实留空、不合成地址。未声明的源逐字走旧行为。
 * （fix3314 曾随视频整组删除同删，fix3315 随 021 恢复捡回；
 * JW 回落（原 020 专用）不恢复。） */
export function createWpRestAdapter(def: SourceDef): SourceAdapter {
  const params = (def.adapter.params ?? {}) as Params;
  const restBase = str(params, "restBase", "/wp-json/wp/v2");
  const listPath = str(params, "listPath", "/posts");
  const yoastCover = params.yoastCover === true;
  const apiUrl = (path: string) => `${def.baseUrls[0]}${restBase}${path}`;
  interface WpPost { id: number; link: string; title?: { rendered?: string }; content?: { rendered?: string }; excerpt?: { rendered?: string }; categories?: number[]; tags?: number[]; yoast_head_json?: { twitter_image?: string } }
  /* Yoast 回落取值守卫（Muse 2026-11-21 fix3312 disc-fix 同批，
   * 清扫潜在-1）：twitter_image 只认字符串——上游畸形数据发数字/
   * 对象时如实留空，不让非字符串进 SourceItem.cover（其类型声明
   * 为 string，下游 /img 与 img src 按字符串消费）。 */
  const yoastImage = (p: WpPost): string => {
    const v = p.yoast_head_json?.twitter_image;
    return typeof v === "string" ? v : "";
  };
  /* taxonomy 名称映射（Muse 2026-11-20 fix335/f-discovery）：帖子
   * 载荷只有分类/标签的数字 id，名称经 taxonomy 端点解析——分类名
   * 进 cats、标签名进 tags（真标签才进 tags 的口径）；taxonomy 不
   * 可达时省略两字段（不拿 id 冒充名称）。 */
  const toItem = (p: WpPost, tax?: SourceTaxonomy | null): SourceItem => {
    const names = (ids: number[] | undefined, pool: { id: string; name: string }[] | undefined): string[] =>
      (ids ?? []).map((id) => pool?.find((t) => t.id === String(id))?.name ?? "").filter(Boolean);
    const cats = tax ? names(p.categories, tax.categories) : [];
    const tags = tax ? names(p.tags, tax.tags) : [];
    return {
      sourceId: def.id, externalId: String(p.id),
      title: stripTags(p.title?.rendered ?? ""), cover: firstImgSrc(p.excerpt?.rendered ?? "") || firstImgSrc(p.content?.rendered ?? "") || (yoastCover ? yoastImage(p) : ""),
      href: p.link, tags, ...(cats.length ? { cats } : {}),
    };
  };
  /* taxonomy 取数（fix335/f-discovery）：categories/tags 端点与
   * posts 同在 restBase 下；按计数降序取（chips 的 Top-N 顺序即
   * 端点顺序，适配器不另排序）。模块级缓存只存成功结果，失败删
   * 缓存容许下次重试；list 与 DiscoveryBar 的 taxonomy() 共用。 */
  const toEntries = (rows: { id?: number; name?: string; count?: number }[]): SourceTaxonomy["categories"] =>
    rows.flatMap((r) => (typeof r?.id === "number" && typeof r?.name === "string" && r.name
      ? [{ id: String(r.id), name: stripTags(r.name), ...(typeof r.count === "number" ? { count: r.count } : {}) }]
      : []));
  const fetchTaxonomy = (): Promise<SourceTaxonomy> => {
    const key = `${def.id}|${apiUrl("")}`;
    const hit = wpTaxonomyCache.get(key);
    if (hit) return hit;
    const p = (async (): Promise<SourceTaxonomy> => {
      const [cats, tags] = await Promise.all([
        parseJsonArray<{ id?: number; name?: string; count?: number }>(await fetchPage(`${apiUrl("/categories")}?per_page=100&orderby=count&order=desc`), def.id),
        parseJsonArray<{ id?: number; name?: string; count?: number }>(await fetchPage(`${apiUrl("/tags")}?per_page=100&orderby=count&order=desc`), def.id),
      ]);
      return { categories: toEntries(cats), tags: toEntries(tags) };
    })();
    wpTaxonomyCache.set(key, p);
    p.catch(() => { if (wpTaxonomyCache.get(key) === p) wpTaxonomyCache.delete(key); });
    return p;
  };
  /* 分页取页（fix335/a-pagination）：WP 的总量在 X-WP-Total 响应头里，
   * 而取页通道（Rust source_fetch）只回正文、不回头（契约见
   * fetchPage.ts）——总量在前端不可达，信号走满页推断（apiSignal）。
   * 越界收尾：WP 对 page 超过总页数恒回 400 rest_post_invalid_page_
   * number（2026-11-20 对 006/008 live 实证，两站同码同文）——满页
   * 推断探出的尾页恰会撞它。请求参数全由本适配器构造（page/
   * per_page/search 均为受控值），page>1 的 400 在此上下文只可能
   * 是越界，故按「已到尾页」收尾返回空页；page=1 的 400 仍如实
   * 抛错（配置/权限类错误不许冒充空列表）。残余风险：他因 400
   * （如 WAF 拦截）会被误判到底，代价是少看尾页而非误报故障，
   * 与「未知不是空」的权衡记录在此。 */
  const fetchPosts = async (query: string, page: number, size: number): Promise<WpPost[] | null> => {
    try {
      return parseJsonArray<WpPost>(await fetchPage(`${apiUrl(listPath)}?${query}`), def.id);
    } catch (e) {
      if (page > 1 && httpStatusOf(e) === 400) return null;
      throw e;
    }
  };
  const paged = (posts: WpPost[] | null, page: number, size: number, tax?: SourceTaxonomy | null): Paged<SourceItem> => posts === null
    ? { items: [], pagination: { page, pages: Math.max(1, page - 1), size, total: Math.max(0, (page - 1) * size) } }
    : { items: posts.map((p) => toItem(p, tax)), pagination: { page, size, ...apiSignal(posts.length, page, size) } };
  return {
    sourceId: def.id,
    /* 发现维度（fix335/f-discovery，探针实证 2026-11-20）：缺省
     * 查询与旧实现逐字一致（page/per_page 两参数、无 orderby——
     * 站方默认即 date desc）；disc.sort＝date-asc/date-desc 译为
     * orderby=date&order=asc/desc，disc.category/tag 须为数字 id
     * 才拼 categories=/tags= 参数（形态不符忽略、不拼坏参数）。
     * taxonomy 与帖取数并行竞速，只作名称映射、失败省略。 */
    async list(page, size, disc) {
      const query = [`page=${page}`, `per_page=${size}`];
      if (disc?.sort === "date-asc") query.push("orderby=date", "order=asc");
      else if (disc?.sort === "date-desc") query.push("orderby=date", "order=desc");
      if (disc?.category && /^\d+$/.test(disc.category)) query.push(`categories=${disc.category}`);
      if (disc?.tag && /^\d+$/.test(disc.tag)) query.push(`tags=${disc.tag}`);
      const [posts, tax] = await Promise.all([
        fetchPosts(query.join("&"), page, size),
        fetchTaxonomy().catch(() => null),
      ]);
      return paged(posts, page, size, tax);
    },
    taxonomy: () => fetchTaxonomy(),
    /* 标签服务端搜索（Muse 2026-11-21 fix3313/discovery-tail）：
     * tags 端点 search 参数按名子串检索（站方语义），一次补取
     * per_page=100——Top-100 名单外的长尾标签靠此直达；结果不进
     * taxonomy 缓存（名单口径仍是 count 降序 Top-100，补取只供
     * 搜索态合并池）。 */
    async searchTags(query) {
      const q = query.trim();
      if (!q) return [];
      return toEntries(parseJsonArray<{ id?: number; name?: string; count?: number }>(
        await fetchPage(`${apiUrl("/tags")}?search=${encodeURIComponent(q)}&per_page=100`), def.id));
    },
    /* 条目存在性探针（fix3313/discovery-tail）：单条端点直查——
     * 200 且回对象即在；HTTP 404（WP 对不存在的 term 恒回
     * rest_term_invalid 404）即明确不在；其余失败（网络/5xx/
     * 解析）一律未知 null，调用方不据此清值。 */
    async taxonExists(kind, id) {
      try {
        const raw = await fetchPage(`${apiUrl(kind === "category" ? "/categories" : "/tags")}/${encodeURIComponent(id)}`);
        const obj = JSON.parse(raw) as { id?: number };
        return typeof obj?.id === "number";
      } catch (e) {
        return httpStatusOf(e) === 404 ? false : null;
      }
    },
    async detail(id) {
      const p = JSON.parse(await fetchPage(`${apiUrl(listPath)}/${id}`)) as WpPost;
      const item = toItem(p);
      const content = p.content?.rendered ?? "";
      return { ...item, description: stripTags(p.excerpt?.rendered ?? ""), contentHtml: content, images: allImgSrcs(content), episodes: [] };
    },
    async resolve(id) {
      const p = JSON.parse(await fetchPage(`${apiUrl(listPath)}/${id}`)) as WpPost;
      const content = p.content?.rendered ?? "";
      const m3u8 = extractM3u8(content);
      if (m3u8) return { streams: [{ url: m3u8, kind: "hls" as const }] };
      const mp4 = extractMp4(content);
      if (mp4) return { streams: [{ url: mp4, kind: "file" as const }] };
      // WP 站常见形态：正文只嵌播放器 iframe，流地址在 iframe 页内。
      const iframe = extractIframeSrc(content);
      if (iframe) {
        const playerHtml = await fetchPage(absUrl(def.baseUrls[0], iframe));
        const im3u8 = extractM3u8(playerHtml);
        if (im3u8) return { streams: [{ url: im3u8, kind: "hls" as const }] };
        const imp4 = extractMp4(playerHtml);
        if (imp4) return { streams: [{ url: imp4, kind: "file" as const }] };
      }
      // 图集型帖子：resolve 给正文首图作 file 流（与 danbooru-api 口径一致）。
      const first = firstImgSrc(content);
      return { streams: first ? [{ url: first, kind: "file" as const }] : [] };
    },
    async search(q, page, size) {
      return paged(await fetchPosts(`search=${encodeURIComponent(q)}&page=${page}&per_page=${size}`, page, size), page, size);
    },
  };
}

/** (d) Danbooru 公开 API。 */
export function createDanbooruAdapter(def: SourceDef): SourceAdapter {
  const params = (def.adapter.params ?? {}) as Params;
  const listPath = str(params, "listPath", "/posts.json");
  /* moebooru 校准（fix335/g-sources，2026-11-20）：同族站点（yande.re／
   * konachan.com，站点形态本机实测见证据 g-sources.md）经 params 覆写
   * 端点与字段——detailPath（{id} 占位、响应可为对象或单元素数组、
   * 归一化取首元素）、postPath（条目页地址形态）、tagsField／
   * previewField／largeField（moebooru：tags／preview_url／jpeg_url）。
   * 未声明的源（danbooru 本体）逐字走默认形态、行为不变。 */
  const detailPath = str(params, "detailPath", "");
  const postPath = str(params, "postPath", "/posts/{id}");
  const tagsField = str(params, "tagsField", "tag_string");
  const previewField = str(params, "previewField", "preview_file_url");
  const largeField = str(params, "largeField", "large_file_url");
  interface DbPost { id: number; file_url?: string; [k: string]: unknown }
  const tagsOf = (p: DbPost) => String(p[tagsField] ?? "").split(" ").filter(Boolean);
  const toItem = (p: DbPost): SourceItem => ({
    sourceId: def.id, externalId: String(p.id), title: tagsOf(p).slice(0, 4).join(" ") || `post ${p.id}`,
    cover: (p[previewField] as string | undefined) ?? "", href: `${def.baseUrls[0]}${postPath.replace("{id}", String(p.id))}`,
    tags: tagsOf(p).slice(0, 8),
    /* 单帖单图模型（fix337/008-detail）：列表载荷逐帖自带大图（与
     * detail 同口径：largeField 优先、file_url 回落），旧实现只留
     * preview 作 cover、大图被丢弃——宿主无从以列表组装画廊，点开
     * 恒只见 detail 的 1 张（3.3.6 真机实报，家族三源同病）。 */
    largeImage: (p[largeField] as string | undefined) ?? p.file_url ?? undefined,
  });
  const fetchPost = async (id: string): Promise<DbPost> => {
    const raw = JSON.parse(await fetchPage(detailPath
      ? `${def.baseUrls[0]}${detailPath.replace("{id}", encodeURIComponent(id))}`
      : `${def.baseUrls[0]}/posts/${id}.json`)) as DbPost | DbPost[];
    const p = Array.isArray(raw) ? raw[0] : raw;
    if (!p || typeof p.id !== "number") throw new SourceParseEmptyError(def.id);
    return p;
  };
  return {
    sourceId: def.id,
    async list(page, size) {
      /* 排序预设已随 008 摘除退役（fix338/registry-cut）：order:
       * 三预设只在 danbooru 本尊实证、发现登记只对该源开放，源删
       * 后本模板无源可达该参数——机制同删，现行 URL 恒为缺省形态
       * （与旧实现缺省分支逐字一致，yandere/gelbooru 行为不变）。 */
      const posts = parseJsonArray<DbPost>(await fetchPage(`${def.baseUrls[0]}${listPath}?page=${page}&limit=${size}`), def.id);
      /* 分页信号（fix335/a-pagination）：服务端 limit 页式、无总量
       * 字段，走满页推断；越界页站方回 []（真空即尾页，apiSignal
       * 对 0 条报 page-1 收尾）。 */
      return { items: posts.map(toItem), pagination: { page, size, ...apiSignal(posts.length, page, size) } };
    },
    async detail(id) {
      const p = await fetchPost(id);
      const item = toItem(p);
      return { ...item, images: [(p[largeField] as string | undefined) ?? p.file_url ?? ""].filter(Boolean), episodes: [] };
    },
    async resolve(id) {
      const p = await fetchPost(id);
      const url = p.file_url ?? (p[largeField] as string | undefined);
      return { streams: url ? [{ url, kind: "file" as const }] : [] };
    },
    async search(q, page, size) {
      const posts = parseJsonArray<DbPost>(await fetchPage(`${def.baseUrls[0]}${listPath}?tags=${encodeURIComponent(q)}&page=${page}&limit=${size}`), def.id);
      return { items: posts.map(toItem), pagination: { page, size, ...apiSignal(posts.length, page, size) } };
    },
  };
}
