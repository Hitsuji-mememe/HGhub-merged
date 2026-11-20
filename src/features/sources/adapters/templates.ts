/**
 * 适配器模板骨架（Muse 2026-11-19 根治包·多源线 条目4）：
 * (a) chigua 吃瓜模板——同模板站共用爬取骨架（51吃瓜网/每日大赛）；
 * (b) wp-rest WP REST 骨架（秀人网）；
 * (c) hls-site 通用 HLS 站骨架——参数=列表/详情路径+条目链接特征+
 *     m3u8 提取（正则），视频与图集站按参数实例化；
 * (d) danbooru-api 公开 API 实例化（Danbooru）；
 * (e) preview-only 预览专区（myfans）：只给预览条目、resolve 明确拒绝。
 * 全部经 fetchPage.ts 收敛取页；解析为正则级（见 parse.ts）。
 */
import type { Paged } from "../../../shared/api/types";
import type { SourceAdapter, SourceDef, SourceDetail, SourceItem, SourceTaxonomy } from "../types.ts";
import { fetchPage } from "./fetchPage.ts";
import { IWARA_API_ORIGIN, REDGIFS_API_ORIGIN, SWAG_API_ORIGIN } from "./fetchOrigins.ts";
import { httpStatusOf, traceListItemSkips, traceResolveFailure } from "./resolveTrace.ts";
import { allImgSrcs, cardCategoryTokens, contentImgSrcs, decodeEntities, extractIframeSrc, extractM3u8, extractMp4, findAnchors, findCardAnchors, firstCoverSrc, firstImgSrc, headingText, imgAlt, lastPageInNav, metaContent, pageOf, stripTags } from "./parse.ts";

export const TEMPLATE_IDS = ["native-huangguo", "chigua", "wp-rest", "hls-site", "danbooru-api", "swag-api", "redgifs-api", "hanime-api", "iwara-api", "hanime1", "hentaihaven-api", "preview-only", "none"] as const;
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
 * ① 服务端真信号：API 总数字段（iwara count）、HTML 分页导航末页
 *    （parse.ts lastPageInNav）、响应自带总页数（redgifs pages）；
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
 * htmlListAdapter 从 params 组装、list/search 两路同口径透传。 */
function parseAnchorList(html: string, base: string, sourceId: string, itemLinkPattern: string, cardContainer = "", promo?: PromoCardFilter, retainCats = false): SourceItem[] {
  const seen = new Set<string>();
  const items: SourceItem[] = [];
  let anchors = cardContainer === "article" || cardContainer === "video-item" ? findCardAnchors(html, cardContainer) : [];
  if (anchors.length === 0) anchors = findAnchors(html);
  for (const a of anchors) {
    if (!a.href.includes(itemLinkPattern)) continue;
    const href = absUrl(base, a.href);
    if (seen.has(href)) continue;
    seen.add(href);
    const title = a.titleAttr || headingText(a.inner) || imgAlt(a.inner) || stripTags(a.inner) || titleFromHref(href);
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
      const all = parseAnchorList(html, base, def.id, itemLinkPattern, cardContainer, promo, opts?.retainCats ?? false);
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
      const all = parseAnchorList(html, base, def.id, itemLinkPattern, cardContainer, promo, opts?.retainCats ?? false);
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
  return { ...base0, detail: (id) => htmlDetail(def, id, true) };
}

/** (b) WP REST 骨架（秀人网）。 */
export function createWpRestAdapter(def: SourceDef): SourceAdapter {
  const params = (def.adapter.params ?? {}) as Params;
  const restBase = str(params, "restBase", "/wp-json/wp/v2");
  const listPath = str(params, "listPath", "/posts");
  const apiUrl = (path: string) => `${def.baseUrls[0]}${restBase}${path}`;
  interface WpPost { id: number; link: string; title?: { rendered?: string }; content?: { rendered?: string }; excerpt?: { rendered?: string }; categories?: number[]; tags?: number[] }
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
      title: stripTags(p.title?.rendered ?? ""), cover: firstImgSrc(p.excerpt?.rendered ?? "") || firstImgSrc(p.content?.rendered ?? ""),
      href: p.link, tags, ...(cats.length ? { cats } : {}),
    };
  };
  /* taxonomy 取数（fix335/f-discovery）：categories/tags 端点与
   * posts 同在 restBase 下；按计数降序取（chips 的 Top-N 顺序即
   * 端点顺序，适配器不另排序）。模块级缓存只存成功结果，失败删
   * 缓存容许下次重试；list 与 DiscoveryBar 的 taxonomy() 共用。 */
  const fetchTaxonomy = (): Promise<SourceTaxonomy> => {
    const key = `${def.id}|${apiUrl("")}`;
    const hit = wpTaxonomyCache.get(key);
    if (hit) return hit;
    const toEntries = (rows: { id?: number; name?: string; count?: number }[]): SourceTaxonomy["categories"] =>
      rows.flatMap((r) => (typeof r?.id === "number" && typeof r?.name === "string" && r.name
        ? [{ id: String(r.id), name: stripTags(r.name), ...(typeof r.count === "number" ? { count: r.count } : {}) }]
        : []));
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

/* Danbooru 排序预设（Muse 2026-11-20 fix335/f-discovery）：tags
 * 参数的 order: 预设，住宅终验三值均严格降序（rank 日榜/score
 * 高分/favcount 收藏）；缺省（无 tags 参数）＝id 降序最新。
 * DiscoverySpec 同读本表（templateCapabilities 派生）。 */
export const DANBOORU_ORDER_PRESETS: { value: string; label: string }[] = [
  { value: "order:rank", label: "日榜" },
  { value: "order:score", label: "高分" },
  { value: "order:favcount", label: "收藏" },
];

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
    async list(page, size, disc) {
      /* 排序预设（fix335/f-discovery）：disc.sort 命中预设表才拼
       * tags= 参数；缺省 URL 与旧实现逐字一致。 */
      const preset = disc?.sort && DANBOORU_ORDER_PRESETS.some((o) => o.value === disc.sort) ? disc.sort : "";
      const posts = parseJsonArray<DbPost>(await fetchPage(`${def.baseUrls[0]}${listPath}?page=${page}&limit=${size}${preset ? `&tags=${encodeURIComponent(preset)}` : ""}`), def.id);
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

/** (f) SWAG 公开 API（Muse 2026-11-19 fix321-F2b）：免登录通道
 * api.swag.live（住宅验收四级全通＋本机出口实测 200，推翻旧「需
 * 登录态」机房定性；结构据 Hentai-Park swag_shortvideo 插件）：
 * 列表 GET /feeds/shorts_curated?limit&page → JSON 数组（行只有
 * id/caption），逐条 GET /messages/<id> 补标题/封面（metadata.
 * thumbnail_url 相对 public.swag.live）。只收免费短视频（sfw=
 * false、type=short、unlockPrice=0、含 video asset）。流为
 * AES-128 加密 HLS（清单 key URI 为 mock.url 占位、真钥须带
 * X-Client-ID/X-Session-ID 会话头向 API 换取并重写清单）——超
 * 本仓播放栈，resolve 诚实返回空、源维持 probe。 */
export function createSwagAdapter(def: SourceDef): SourceAdapter {
  const apiBase = def.baseUrls.find((u) => u.includes("api.")) ?? SWAG_API_ORIGIN;
  const publicBase = "https://public.swag.live";
  const headers = { Referer: `${def.baseUrls[0]}/`, "Accept-Language": "zh-TW" };
  interface SwagAsset { id?: string; "content-type"?: string; url?: string; aes?: boolean }
  interface SwagMessage {
    id?: string; type?: string; sfw?: boolean; unlockPrice?: number | string;
    caption?: string | { text?: string }; text?: string;
    metadata?: { thumbnail_url?: string };
    assets?: SwagAsset[];
  }
  const isFreeShort = (m: SwagMessage): boolean =>
    m.sfw === false && m.type === "short" && Number(m.unlockPrice ?? 0) === 0 &&
    Array.isArray(m.assets) && m.assets.some((x) => /^video\/(?:mp4|quicktime)$/i.test(String(x?.["content-type"] ?? "")));
  const toItem = (m: SwagMessage): SourceItem | null => {
    const id = String(m.id ?? "");
    if (!/^[a-f0-9]{24}$/i.test(id)) return null;
    const rawTitle = typeof m.caption === "object" ? m.caption?.text : m.caption;
    const title = String(rawTitle || m.text || id).replace(/\s+/g, " ").trim();
    const thumb = m.metadata?.thumbnail_url ?? "";
    return {
      sourceId: def.id, externalId: id, title,
      cover: thumb ? absUrl(publicBase, thumb) : "",
      href: `${def.baseUrls[0]}/post/${id}`, tags: [],
    };
  };
  const getMessage = async (id: string): Promise<SwagMessage> =>
    JSON.parse(await fetchPage(`${apiBase}/messages/${id}`, headers)) as SwagMessage;
  return {
    sourceId: def.id,
    async list(page, size) {
      const raw = await fetchPage(`${apiBase}/feeds/shorts_curated?limit=${size}&page=${page}`, headers);
      const rows = JSON.parse(raw) as SwagMessage[];
      if (!Array.isArray(rows)) throw new Error("SWAG 列表数据无效");
      const items: SourceItem[] = [];
      let fetchFailed = 0;
      for (const row of rows) {
        const id = String(row?.id ?? "");
        if (!/^[a-f0-9]{24}$/i.test(id)) continue;
        try {
          const m = await getMessage(id);
          if (!isFreeShort(m)) continue;
          const item = toItem(m);
          if (item) items.push(item);
        } catch { fetchFailed += 1; /* 单条取数失败跳过该条，不拖垮整页（插件同口径）；计数后统一留痕（见循环后） */ }
      }
      /* 逐条取数失败留痕（fix335/a-pagination 收敛审计）：旧实现静默
       * 跳过——失败与免费/短视频判据过滤在结果里不可分、诊断导出查
       * 无此失败。现整页结算后落一条 source.list_skip（计数口径，
       * 通道见 resolveTrace.traceListItemSkips）；成功路径逐字不变
       * （过滤判读、条目集、抛错点均不受影响）。 */
      if (fetchFailed > 0) traceListItemSkips(def.id, fetchFailed);
      if (items.length === 0) throw new SourceParseEmptyError(def.id);
      return { items, pagination: pageOf(rows.length, page, size) };
    },
    async detail(id) {
      const m = await getMessage(id);
      const item = toItem(m);
      if (!item) throw new Error("SWAG 条目无效");
      return { ...item, description: item.title, images: [], episodes: [] };
    },
    async resolve() {
      /* AES-128 加密 HLS＋会话头换钥重写清单，超播放栈 → 诚实无流 */
      return { streams: [] };
    },
  };
}

/** (g) RedGifs 官方 API（Muse 2026-11-19 fix321-F2b）：匿名临时
 * 令牌链（结构据 Hentai-Park redgifs 插件＋官方 API 实测形态）：
 * GET api.redgifs.com/v2/auth/temporary → {token}，后续调用带
 * Authorization: Bearer <token>（Rust source_fetch 仅对
 * api.redgifs.com origin 定向放行该头——令牌为匿名临时令牌、非
 * 用户凭据）；search/list 走 /v2/gifs/search，detail 走
 * /v2/gifs/<id>，流取 urls.hd 优先的 mp4 直链。令牌进程内缓存，
 * 失效（取数抛错）时刷新一次重试。 */
export function createRedgifsAdapter(def: SourceDef): SourceAdapter {
  const apiBase = def.baseUrls.find((u) => u.includes("api.")) ?? REDGIFS_API_ORIGIN;
  interface RgGif {
    id?: string; title?: string; width?: number; height?: number; duration?: number;
    urls?: { thumbnail?: string; sd?: string; hd?: string };
  }
  let token: string | null = null;
  const auth = async (): Promise<string> => {
    const d = JSON.parse(await fetchPage(`${apiBase}/v2/auth/temporary`)) as { token?: string };
    if (!d.token) throw new Error("RedGifs 临时令牌获取失败");
    token = d.token;
    return token;
  };
  const api = async <T>(path: string): Promise<T> => {
    const call = async () => JSON.parse(await fetchPage(`${apiBase}${path}`, { Authorization: `Bearer ${token ?? (await auth())}` })) as T;
    try { return await call(); } catch { token = null; return await call(); }
  };
  const toItem = (g: RgGif): SourceItem | null => {
    const id = String(g?.id ?? "");
    if (!id) return null;
    return {
      sourceId: def.id, externalId: id, title: String(g.title || id),
      cover: g.urls?.thumbnail ?? g.urls?.sd ?? "",
      href: `${def.baseUrls[0]}/watch/${id}`, tags: [],
      duration: g.duration ? String(g.duration) : undefined,
    };
  };
  return {
    sourceId: def.id,
    async list(page, size) {
      const d = await api<{ gifs?: RgGif[]; pages?: number; total?: number }>(`/v2/gifs/search?search_text=&order=trending&count=${size}&page=${page}`);
      const items = (d.gifs ?? []).map(toItem).filter((x): x is SourceItem => x !== null);
      if (items.length === 0) throw new SourceParseEmptyError(def.id);
      /* 分页信号（fix335/a-pagination）：响应自带 pages 总页数（旧
       * 实现已声明该字段却未消费、拿本页条数冒充）——有则真信号、
       * total 同理；缺失回落满页推断。 */
      const pagination = typeof d.pages === "number" && Number.isFinite(d.pages) && d.pages >= 1
        ? { page, pages: d.pages, size, total: typeof d.total === "number" && Number.isFinite(d.total) ? d.total : (page - 1) * size + items.length }
        : { page, size, ...apiSignal(items.length, page, size) };
      return { items, pagination };
    },
    async detail(id) {
      const d = await api<{ gif?: RgGif }>(`/v2/gifs/${id}`);
      const item = d.gif ? toItem(d.gif) : null;
      if (!item) throw new Error("RedGifs 条目无效");
      return { ...item, description: "", images: [], episodes: [{ label: "正片", externalId: id }] };
    },
    async resolve(id) {
      const d = await api<{ gif?: RgGif }>(`/v2/gifs/${id}`);
      const url = d.gif?.urls?.hd ?? d.gif?.urls?.sd;
      return { streams: url ? [{ url, kind: "file" as const }] : [] };
    },
    async search(q, page, size) {
      const d = await api<{ gifs?: RgGif[] }>(`/v2/gifs/search?search_text=${encodeURIComponent(q)}&order=trending&count=${size}&page=${page}`);
      const items = (d.gifs ?? []).map(toItem).filter((x): x is SourceItem => x !== null);
      return { items, pagination: pageOf(items.length, page, size) };
    },
  };
}

/* ── SHA-1（纯实现，Muse 2026-11-19 fix330 接通批）：Iwara 取流
 * 签名头 X-Version 的摘要算法；同步实现避免 WebView/Node 两环境
 * crypto.subtle 可用性差异，契约以 Node createHash 对照验证。 */
function sha1Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, bitLen >>> 0);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4);
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f = 0, k = 0;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = tmp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, "0")).join("");
}

/** Iwara fileUrl 签名盐：站点协议固定常数（公开插件 iwara.js 与
 * 独立用户脚本双证据的协议事实、非用户凭据），X-Version =
 * sha1(<fileUrl 末段>_<expires 参数>_<盐>)。站点会轮换签名盐
 * （维护客户端 IwaraTool「verified」API 文档＋gallery-dl 双证据）：
 * 现行盐在前、旧盐兜底，逐个试——轮换期站方对旧签名回空表/错误，
 * 单盐一次判读即终局会把全站取流打成 stream_unavailable
 * （fix337/video-resolve）。 */
const IWARA_FILE_VERSION_SALTS = [
  "mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN",
  "5nFp9kmbNnHdAFhaqMvt",
] as const;

/** (h) Iwara 公开 API（Muse 2026-11-19 fix330 接通批）：结构据
 * Hentai-Park 公开插件 iwara.js 的协议事实（只借协议/结构、代码
 * 原创）：列表 GET api.iwara.tv/videos?sort=views&page=<0基>&limit
 * → {results:[{id,slug,title,file:{id,duration},user,tags,body}]}；
 * 搜索 GET /search?type=videos&query&page&limit 同形；详情 GET
 * /video/<id>；封面由 file.id 拼 files.iwara.tv/image/thumbnail/
 * <file.id>/thumbnail-00.jpg；取流 GET 详情 fileUrl（带 X-Version
 * 签名头，Rust source_fetch 仅对 files/filesq.iwara.tv 两 host
 * 定向放行该头）→ [{name,src:{view,download}}] mp4 多档取最高档。 */
/* Iwara 排序值（Muse 2026-11-20 fix335/f-discovery）：/videos 的
 * sort 参数三值（探针实证：views 现行写死默认/date 最新/likes
 * 点赞，返回集与计数各异）；DiscoverySpec 同读本表。 */
export const IWARA_SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "views", label: "最热" },
  { value: "date", label: "最新" },
  { value: "likes", label: "点赞" },
];

export function createIwaraAdapter(def: SourceDef): SourceAdapter {
  const apiBase = def.baseUrls.find((u) => u.includes("api.")) ?? IWARA_API_ORIGIN;
  const siteBase = def.baseUrls.find((u) => !u.includes("api.")) ?? "https://www.iwara.tv";
  interface IwaraVideo {
    id?: string; slug?: string; title?: string; body?: string; fileUrl?: string;
    file?: { id?: string; duration?: number };
    tags?: { id?: string }[];
  }
  const toItem = (v: IwaraVideo): SourceItem | null => {
    const id = String(v?.id ?? "");
    const title = String(v?.title ?? "").trim();
    const fileId = String(v?.file?.id ?? "");
    if (!/^[A-Za-z0-9]{8,32}$/.test(id) || !title || !fileId) return null;
    return {
      sourceId: def.id, externalId: id, title,
      cover: `https://files.iwara.tv/image/thumbnail/${encodeURIComponent(fileId)}/thumbnail-00.jpg`,
      href: `${siteBase}/video/${id}/${v.slug ?? ""}`,
      tags: (v.tags ?? []).map((t) => String(t?.id ?? "")).filter(Boolean),
      duration: v.file?.duration ? String(v.file.duration) : undefined,
    };
  };
  const getJson = async <T>(url: string, headers?: Record<string, string>): Promise<T> =>
    JSON.parse(await fetchPage(url, headers)) as T;
  const listFrom = async (url: string, page: number, size: number) => {
    const d = await getJson<{ results?: IwaraVideo[]; count?: number }>(url);
    const rows = Array.isArray(d?.results) ? d.results : [];
    const items = rows.map(toItem).filter((x): x is SourceItem => x !== null);
    /* 分页信号（fix335/a-pagination）：响应自带 count 总数字段
     * （站方 API 协议事实，旧实现未消费、拿本页行数冒充总量）——
     * 有 count 走真信号 pageOf；缺失/形态异常回落满页推断，满页
     * 判读用过滤前行数（toItem 剔除的无效行不代表站方页未满）。 */
    const pagination = typeof d?.count === "number" && Number.isFinite(d.count) && d.count >= 0
      ? pageOf(d.count, page, size)
      : { page, size, ...apiSignal(rows.length, page, size) };
    return { items, pagination };
  };
  return {
    sourceId: def.id,
    async list(page, size, disc) {
      /* 排序（fix335/f-discovery）：disc.sort 命中三值才切换，未
       * 命中/缺省＝views（现行写死值，URL 逐字不变）。 */
      const sort = disc?.sort && IWARA_SORT_OPTIONS.some((o) => o.value === disc.sort) ? disc.sort : "views";
      const r = await listFrom(`${apiBase}/videos?sort=${sort}&page=${page - 1}&limit=${size}`, page, size);
      /* 第一页空 = 解析为空抛错（旧口径不变）；第二页起空是满页
       * 推断探出的尾页，按 listFrom 的信号收尾返回、不冒充故障。 */
      if (r.items.length === 0 && page <= 1) throw new SourceParseEmptyError(def.id);
      return r;
    },
    async detail(id) {
      const v = await getJson<IwaraVideo>(`${apiBase}/video/${id}`);
      const item = toItem(v);
      if (!item) throw new Error("Iwara 条目无效");
      return { ...item, description: String(v.body ?? ""), images: [], episodes: [{ label: "正片", externalId: id }] };
    },
    async resolve(id) {
      /* 取流分段留痕（fix333-m5 P5，与 002 同口径）：detail（详情取数
       * 得 fileUrl）/fetch（流表取数）/decode（流表判读）三段，任一
       * 失败或终局无流落 source.resolve_fail，不再只有 fetchHealth
       * 的 host 级兜底。取数在此内联（不走 getJson）以便分段归属，
       * 失败行为与原实现一致（抛出点不变、空结果仍回空流表）。 */
      let detailRaw: string;
      try {
        detailRaw = await fetchPage(`${apiBase}/video/${id}`);
      } catch (e) {
        traceResolveFailure(def.id, "detail", "detail_fetch_failed", httpStatusOf(e), 0);
        throw e;
      }
      let v: IwaraVideo;
      try {
        v = JSON.parse(detailRaw) as IwaraVideo;
      } catch (e) {
        traceResolveFailure(def.id, "detail", "detail_decode_failed", undefined, 0);
        throw e;
      }
      const fileUrl = String(v?.fileUrl ?? "");
      if (!fileUrl) {
        traceResolveFailure(def.id, "detail", "file_url_unavailable", undefined, 0);
        return { streams: [] };
      }
      /* 签名盐逐个试（fix337/video-resolve）：fileUrl 形态可算签名
       * 时按 IWARA_FILE_VERSION_SALTS 顺序逐盐取表，任一盐产出候选
       * 即终局；取数失败/解码失败/非数组/零候选都先换下一盐，全盐
       * 终局才按旧口径落痕/抛出（留痕只记终局一次、不按盐重复记）。
       * fileUrl 形态异常算不出签名时退化为单次无签名取数（旧行为）。 */
      let seg = "";
      let exp = "";
      try {
        const u = new URL(fileUrl);
        seg = u.pathname.split("/").filter(Boolean).pop() ?? "";
        exp = u.searchParams.get("expires") ?? "";
      } catch { /* fileUrl 形态异常：无签名取数、由响应形态决定成败 */ }
      const versions: (string | undefined)[] = seg && exp
        ? IWARA_FILE_VERSION_SALTS.map((salt) => sha1Hex(`${seg}_${exp}_${salt}`))
        : [undefined];
      type IwaraRow = { name?: string; quality?: string; src?: { view?: string; download?: string }; url?: string };
      for (let attempt = 0; attempt < versions.length; attempt++) {
        const last = attempt === versions.length - 1;
        const version = versions[attempt];
        let rowsRaw: string;
        try {
          rowsRaw = await fetchPage(fileUrl, version ? { "X-Version": version } : undefined);
        } catch (e) {
          if (!last) continue;
          traceResolveFailure(def.id, "fetch", "stream_fetch_failed", httpStatusOf(e), 0);
          throw e;
        }
        let rows: IwaraRow[];
        try {
          rows = JSON.parse(rowsRaw) as IwaraRow[];
        } catch (e) {
          if (!last) continue;
          traceResolveFailure(def.id, "decode", "stream_decode_failed", undefined, 0);
          throw e;
        }
        if (!Array.isArray(rows)) {
          if (!last) continue;
          traceResolveFailure(def.id, "decode", "stream_table_invalid", undefined, 0);
          return { streams: [] };
        }
        /* 候选地址规范化（fix337/video-resolve）：站方流表的
         * src.view/download 实为**协议相对地址**（//host/...，
         * IwaraTool 取画质代码＋gallery-dl 双证据，客户端须补
         * https:）——旧实现只收 ^https:// 把全部候选滤光，真机
         * 取数/解码都成功却恒 stream_unavailable（3.3.6 三连）。 */
        const cands = rows
          .map((r) => {
            const raw = r.src?.view ?? r.src?.download ?? r.url ?? "";
            return { url: raw.startsWith("//") ? `https:${raw}` : raw, q: Number(String(r.name ?? r.quality ?? "").match(/\d+/)?.[0] ?? 0) };
          })
          .filter((c) => /^https:\/\//i.test(c.url));
        cands.sort((a, b) => b.q - a.q);
        if (cands.length) return { streams: [{ url: cands[0].url, kind: "file" as const }] };
        if (!last) continue;
        traceResolveFailure(def.id, "decode", "stream_unavailable", undefined, 0);
        return { streams: [] };
      }
      return { streams: [] };
    },
    async search(q, page, size) {
      return listFrom(`${apiBase}/search?type=videos&query=${encodeURIComponent(q.slice(0, 100))}&page=${page - 1}&limit=${size}`, page, size);
    },
  };
}

/** (i) Hanime1 HTML 站（Muse 2026-11-19 fix330 接通批）：结构据
 * Hentai-Park 公开插件 hanime1.js 的协议事实（只借协议/结构、代码
 * 原创）：列表与搜索同走 GET /search（列表=sort 最新上市、搜索=
 * query 参数），卡片为 a[href*=watch?v=<数字id>]（标题取卡内
 * home-rows-videos-title/card-mobile-title 元素或 img alt、封面
 * img、时长取 duration 元素）；详情 GET /watch?v=<id>（标题
 * #shareBtn-title 或 og:title、封面 video poster 或 og:image）；
 * 取流解析 watch 页 <source size>/data-url 的 mp4 多档、无档时
 * 回落 /download?v=<id> 同法解析，取最高档。 */
/* Hanime1 排序值（Muse 2026-11-20 fix335/f-discovery）：/search
 * 的 sort 参数九值，**必须逐字用站方繁体原值**——简体拼法被站方
 * 静默回落默认序（探针＋住宅终验实证：简体「最新上传」回落最新
 * 上市序）。label 即原值本身（界面原文呈现，不另译）。
 * DiscoverySpec 同读本表。 */
export const HANIME1_SORT_VALUES: string[] = [
  "最新上市", "最新上傳", "本日排行", "本週排行", "本月排行",
  "觀看次數", "讚好比例", "時長最長", "他們在看",
];

export function createHanime1Adapter(def: SourceDef): SourceAdapter {
  const base = def.baseUrls[0].replace(/\/$/, "");
  const cardTitle = (inner: string): string => {
    const m = /class="[^"]*(?:home-rows-videos-title|card-mobile-title)[^"]*"[^>]*>([\s\S]*?)<\//i.exec(inner)
      ?? /class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\//i.exec(inner);
    return m ? stripTags(m[1]) : "";
  };
  /* matched（fix335/a-pagination）：命中 watch?v= 形态的去重卡数
   * （标题/封面校验前）——分页满页判读的口径。校验会剔除缺标题/
   * 封面的卡，若以实收条数判满页，站方满页也会因剔除跌破阈值被
   * 误判尾页（吃瓜 005 第一页实收 15<20 的同型教训）。 */
  const parseCards = (html: string): { items: SourceItem[]; matched: number } => {
    const seen = new Set<string>();
    const matchedIds = new Set<string>();
    const items: SourceItem[] = [];
    for (const a of findAnchors(html)) {
      const m = /watch\?v=(\d{1,8})/.exec(a.href);
      if (!m) continue;
      matchedIds.add(m[1]);
      if (seen.has(m[1])) continue;
      const title = cardTitle(a.inner) || imgAlt(a.inner);
      const cover = firstImgSrc(a.inner);
      if (!title || !cover) continue;
      seen.add(m[1]);
      const dur = /class="[^"]*(?:card-mobile-duration|duration)[^"]*"[^>]*>\s*([\d]+:[\d:]+)/i.exec(a.inner)?.[1];
      items.push({ sourceId: def.id, externalId: m[1], title, cover: absUrl(base, cover), href: `${base}/watch?v=${m[1]}`, tags: [], duration: dur });
    }
    return { items, matched: matchedIds.size };
  };
  const parseSources = (html: string): { url: string; q: number }[] => {
    const byQuality = new Map<number, string>();
    const add = (raw: string, q: number) => {
      if (!raw || !Number.isInteger(q) || q < 144 || q > 4320 || byQuality.has(q)) return;
      const url = absUrl(base, raw.trim());
      if (/^https:\/\//i.test(url) && /\.mp4(\?|$)/i.test(url)) byQuality.set(q, url);
    };
    for (const tag of html.match(/<source\b[^>]*>/gi) ?? []) {
      const src = /\bsrc="([^"]+)"/i.exec(tag)?.[1] ?? "";
      const q = Number(/\bsize="(\d+)"/i.exec(tag)?.[1] ?? /\-(\d{3,4})p\.mp4/i.exec(src)?.[1] ?? 0);
      add(src, q);
    }
    for (const m of html.matchAll(/\bdata-url="([^"]+\.mp4[^"]*)"/gi)) {
      add(m[1], Number(/\-(\d{3,4})p\.mp4/i.exec(m[1])?.[1] ?? 0));
    }
    return [...byQuality.entries()].map(([q, url]) => ({ url, q })).sort((a, b) => b.q - a.q);
  };
  const pageParam = (page: number) => (page > 1 ? `&page=${page}` : "");
  return {
    sourceId: def.id,
    async list(page, size, disc) {
      /* 排序（fix335/f-discovery）：disc.sort 须逐字命中九值表，
       * 未命中/缺省＝最新上市（现行写死值，URL 逐字不变）。 */
      const sort = disc?.sort && HANIME1_SORT_VALUES.includes(disc.sort) ? disc.sort : "最新上市";
      const html = await fetchPage(`${base}/search?sort=${encodeURIComponent(sort)}${pageParam(page)}`);
      const { items, matched } = parseCards(html);
      /* 分页信号（fix335/a-pagination）：整页消费（旧 slice 同 HTML
       * 模板尾损问题）；无导航末页可读（本机出口 CF 403、形态未实
       * 测），走满页推断、满页口径取 matched。第一页无有效卡仍抛
       * 解析为空；第二页起无卡按尾页收尾。 */
      if (items.length === 0 && page <= 1) throw new SourceParseEmptyError(def.id);
      return { items, pagination: { page, size, ...apiSignal(matched, page, size) } };
    },
    async detail(id) {
      const html = await fetchPage(`${base}/watch?v=${id}`);
      const title = stripTags(/id="shareBtn-title"[^>]*>([\s\S]*?)<\//i.exec(html)?.[1] ?? "")
        || metaContent(html, "og:title").replace(/\s*-\s*Hanime1\.me\s*$/i, "");
      if (!title) throw new Error("Hanime1 条目无效");
      const cover = /<video\b[^>]*\bposter="([^"]+)"/i.exec(html)?.[1] ?? metaContent(html, "og:image");
      return {
        sourceId: def.id, externalId: id, title, cover: cover ? absUrl(base, cover) : "",
        href: `${base}/watch?v=${id}`, tags: [], description: metaContent(html, "description"),
        images: [], episodes: parseSources(html).length ? [{ label: "正片", externalId: id }] : [],
      };
    },
    async resolve(id) {
      /* 取流分段留痕（fix333-m5 P5，与 002 同口径）：watch（详情页
       * 取数）/download（回落下载页取数）/decode（页内流解析判读）
       * 三段；下载页失败原为静默吞掉，现留痕后仍按 watch 页结论
       * 走（行为不变），终局无流同落一条 decode 留痕。 */
      let watchHtml: string;
      try {
        watchHtml = await fetchPage(`${base}/watch?v=${id}`);
      } catch (e) {
        traceResolveFailure(def.id, "watch", "watch_fetch_failed", httpStatusOf(e), 0);
        throw e;
      }
      let sources = parseSources(watchHtml);
      if (sources.length === 0) {
        try {
          sources = parseSources(await fetchPage(`${base}/download?v=${id}`));
        } catch (e) { /* 下载页不可达：以 watch 页结论为准（无流），失败本身留痕 */
          traceResolveFailure(def.id, "download", "download_fetch_failed", httpStatusOf(e), 0);
        }
      }
      if (sources.length === 0) traceResolveFailure(def.id, "decode", "stream_unavailable", undefined, 0);
      return { streams: sources.length ? [{ url: sources[0].url, kind: "file" as const }] : [] };
    },
    async search(q, page, size) {
      const html = await fetchPage(`${base}/search?query=${encodeURIComponent(q)}${pageParam(page)}`);
      const { items, matched } = parseCards(html);
      return { items, pagination: { page, size, ...apiSignal(matched, page, size) } };
    },
  };
}

/** (j) HentaiHaven 目录 API＋集页取流（Muse 2026-11-19 fix330
 * 接通批）：结构据 Hentai-Park 公开插件 hentaihaven.js 的协议事实
 * （只借协议/结构、代码原创）：列表 GET /api/manga/?trending_
 * period=monthly&per_page&page → {data:[{slug,title:{rendered},
 * meta:{vraven_remote_thumbnail}}]}，搜索同端点 search 参数；
 * 封面拼 img.hentaihaven.xxx/<meta 路径>；详情 GET /watch/<slug>/
 * （h1/og:image＋episode-<n> 分集链接）；取流取集页（无分集时
 * watch 页）ld+json VideoObject 的 contentUrl（.m3u8）。 */
/* HentaiHaven 榜单周期（Muse 2026-11-20 fix335/f-discovery）：
 * trending_period 只登记 monthly（现行写死默认）与 all（全部）两
 * 值——weekly/daily/week/day 被站方应用层拒绝（Unsupported
 * trending period），不得登记（探针实证）。DiscoverySpec 同读本表。 */
export const HENTAIHAVEN_PERIOD_OPTIONS: { value: string; label: string }[] = [
  { value: "monthly", label: "月榜" },
  { value: "all", label: "全部" },
];

export function createHentaihavenAdapter(def: SourceDef): SourceAdapter {
  const base = def.baseUrls[0].replace(/\/$/, "");
  interface HhRow { slug?: string; title?: { rendered?: string } | string; meta?: { vraven_remote_thumbnail?: string } }
  const toItem = (r: HhRow): SourceItem | null => {
    const slug = String(r?.slug ?? "");
    if (!/^[a-z0-9-]{1,240}$/.test(slug)) return null;
    const rawTitle = typeof r.title === "object" ? r.title?.rendered : r.title;
    const title = stripTags(String(rawTitle ?? "")).trim();
    if (!title) return null;
    const thumb = String(r.meta?.vraven_remote_thumbnail ?? "").replace(/^\/+/, "");
    return {
      sourceId: def.id, externalId: slug, title,
      cover: thumb ? `https://img.hentaihaven.xxx/${thumb}` : "",
      href: `${base}/watch/${slug}/`, tags: [],
    };
  };
  const apiList = async (params: string, page: number, size: number): Promise<{ items: SourceItem[]; fetched: number }> => {
    const d = JSON.parse(await fetchPage(`${base}/api/manga/?${params}&per_page=${size}&page=${page}`)) as { data?: HhRow[] };
    const rows = Array.isArray(d?.data) ? d.data : [];
    /* fetched = 过滤前行数（分页满页判读口径，见 iwara 同注）。 */
    return { items: rows.map(toItem).filter((x): x is SourceItem => x !== null), fetched: rows.length };
  };
  const episodeNums = (html: string, slug: string): number[] => {
    const seen = new Set<number>();
    const re = new RegExp(`/watch/${slug}/episode-(\\d+)`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) seen.add(Number(m[1]));
    return [...seen].sort((a, b) => a - b);
  };
  const extractHls = (html: string): string | null => {
    /* 只认 ld+json contentUrl 这一权威字段（fix337/video-resolve）：
     * 旧实现回落 extractM3u8 整页首个 .m3u8 字面——现行集页的取流
     * 走 player-logic iframe＋加密 POST 流程（维护客户端 CloudStream
     * 同 host 实证、独立实现 60+），页内字面是预告/嵌入残留、非权威
     * 流：3.3.6 真机取到后主清单能开、子级（变体/分片）全灭。宁可
     * 诚实回空（decode/stream_unavailable 留痕）也不冒充成功；
     * player-logic POST 流程需 Rust 定向 POST 通道＋真机验证，
     * 另批落地。 */
    const m = /"contentUrl"\s*:\s*"(https:[^"]+?\.m3u8[^"]*)"/i.exec(html.replace(/\\\//g, "/"));
    return m ? m[1] : null;
  };
  return {
    sourceId: def.id,
    async list(page, size, disc) {
      /* 榜单周期（fix335/f-discovery）：disc.period 命中登记两值
       * 才切换，未命中/缺省＝monthly（现行写死值，URL 逐字不变）。 */
      const period = disc?.period && HENTAIHAVEN_PERIOD_OPTIONS.some((o) => o.value === disc.period) ? disc.period : "monthly";
      const { items, fetched } = await apiList(`trending_period=${period}`, page, size);
      /* 分页信号（fix335/a-pagination）：响应只有 data 数组、无总量
       * 字段（协议事实见文件头），走满页推断；第一页空仍抛解析为
       * 空、第二页起空按尾页收尾（与 iwara 同口径）。 */
      if (items.length === 0 && page <= 1) throw new SourceParseEmptyError(def.id);
      return { items, pagination: { page, size, ...apiSignal(fetched, page, size) } };
    },
    async detail(id) {
      const slug = id.split("/episode-")[0];
      const html = await fetchPage(`${base}/watch/${slug}/`);
      const title = stripTags(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "") || metaContent(html, "og:title") || slug;
      const eps = episodeNums(html, slug);
      return {
        sourceId: def.id, externalId: slug, title, cover: metaContent(html, "og:image"),
        href: `${base}/watch/${slug}/`, tags: [], description: metaContent(html, "description"),
        images: [],
        episodes: eps.length ? eps.map((n) => ({ label: `第 ${n} 集`, externalId: `${slug}/episode-${n}` })) : [{ label: "正片", externalId: slug }],
      };
    },
    async resolve(id) {
      /* 取流分段留痕（fix333-m5 P5，与 002 同口径）：watch（详情页
       * 取数）/episode（集页取数）/decode（ld+json 流提取判读）
       * 三段；任一段取数失败或终局无流落 source.resolve_fail，
       * 抛出点与原实现一致。 */
      const [slug, epPart] = id.split("/episode-");
      let watchHtml: string;
      try {
        watchHtml = await fetchPage(`${base}/watch/${slug}/`);
      } catch (e) {
        traceResolveFailure(def.id, "watch", "watch_fetch_failed", httpStatusOf(e), 0);
        throw e;
      }
      const eps = episodeNums(watchHtml, slug);
      const want = epPart ? Number(epPart) : eps[0];
      let url: string | null = null;
      if (want !== undefined && eps.includes(want)) {
        let epHtml: string;
        try {
          epHtml = await fetchPage(`${base}/watch/${slug}/episode-${want}/`);
        } catch (e) {
          traceResolveFailure(def.id, "episode", "episode_fetch_failed", httpStatusOf(e), 0);
          throw e;
        }
        url = extractHls(epHtml);
      }
      url ??= extractHls(watchHtml);
      if (!url) traceResolveFailure(def.id, "decode", "stream_unavailable", undefined, 0);
      return { streams: url ? [{ url, kind: "hls" as const }] : [] };
    },
    async search(q, page, size) {
      const { items, fetched } = await apiList(`search=${encodeURIComponent(q.slice(0, 100))}`, page, size);
      return { items, pagination: { page, size, ...apiSignal(fetched, page, size) } };
    },
  };
}

/** (e) 预览专区：只出预览条目（标注「仅预览」），不提供完整内容解析。 */
export function createPreviewOnlyAdapter(def: SourceDef): SourceAdapter {
  return {
    sourceId: def.id,
    async list(page, size): Promise<Paged<SourceItem>> {
      return {
        items: [{
          sourceId: def.id, externalId: "preview-root", title: `${def.displayName}（仅预览）`,
          cover: "", href: def.baseUrls[0], tags: ["仅预览"], previewOnly: true,
        }],
        pagination: pageOf(1, page, size),
      };
    },
    async detail(id) {
      return {
        sourceId: def.id, externalId: id, title: `${def.displayName}（仅预览）`, cover: "",
        href: def.baseUrls[0], tags: ["仅预览"], previewOnly: true, images: [], episodes: [],
        description: "仅预览：完整内容请回原站查看",
      };
    },
    async resolve() {
      throw new Error("仅预览源不提供播放解析，完整内容请回原站");
    },
  };
}
