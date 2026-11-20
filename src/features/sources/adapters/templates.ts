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
import type { SourceAdapter, SourceDef, SourceDetail, SourceItem } from "../types.ts";
import { fetchPage } from "./fetchPage.ts";
import { IWARA_API_ORIGIN, REDGIFS_API_ORIGIN, SWAG_API_ORIGIN } from "./fetchOrigins.ts";
import { allImgSrcs, cardCategoryTokens, contentImgSrcs, decodeEntities, extractIframeSrc, extractM3u8, extractMp4, findAnchors, findCardAnchors, firstCoverSrc, firstImgSrc, headingText, imgAlt, metaContent, pageOf, stripTags } from "./parse.ts";

export const TEMPLATE_IDS = ["native-huangguo", "chigua", "wp-rest", "hls-site", "danbooru-api", "swag-api", "redgifs-api", "hanime-api", "iwara-api", "hanime1", "hentaihaven-api", "preview-only", "none"] as const;
type Params = Record<string, unknown>;
const str = (p: Params, k: string, d = "") => (typeof p[k] === "string" ? (p[k] as string) : d);

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}

function absUrl(base: string, href: string): string {
  try { return new URL(href, base).href; } catch { return href; }
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
function parseAnchorList(html: string, base: string, sourceId: string, itemLinkPattern: string, cardContainer = "", promo?: PromoCardFilter): SourceItem[] {
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
    items.push({ sourceId, externalId: href, title, cover: coverSrc ? absUrl(base, coverSrc) : "", href, tags: [] });
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

function htmlListAdapter(def: SourceDef): SourceAdapter {
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
  return {
    sourceId: def.id,
    async list(page, size) {
      const base = def.baseUrls[0];
      const html = await fetchPage(absUrl(base, fill(listPath, { page })));
      const all = parseAnchorList(html, base, def.id, itemLinkPattern, cardContainer, promo);
      /* 未知不是空（fix321-F2）：取到页却 0 条目 = 解析失败，显式抛错走列表层错误通道 */
      if (all.length === 0) throw new SourceParseEmptyError(def.id);
      const items = all.slice(0, size);
      return { items, pagination: pageOf(all.length, page, size) };
    },
    detail: (id) => htmlDetail(def, id),
    resolve: (id) => htmlResolve(def, id),
    async search(q, page, size) {
      const base = def.baseUrls[0];
      /* 搜索路径按源校准（Muse 2026-11-19 3.3.0 接通批·吃瓜线）：
       * params.searchPath 存在时按真站形态拼（{q} 已编码、{page} 页码；
       * 51吃瓜/每日大赛实证为 Typecho 形态 /search/{q}/{page}/——站点
       * 对 /?s= 的重写会吞掉 paged 参数、恒回第一页，故不走默认形）；
       * 未声明的源维持 WordPress 式默认形 /?s=&paged= 不变。 */
      const searchPath = str(params, "searchPath", "");
      const path = searchPath
        ? fill(searchPath, { q: encodeURIComponent(q), page })
        : `/?s=${encodeURIComponent(q)}&paged=${page}`;
      const html = await fetchPage(absUrl(base, path));
      const all = parseAnchorList(html, base, def.id, itemLinkPattern, cardContainer, promo);
      return { items: all.slice(0, size), pagination: pageOf(all.length, page, size) };
    },
  };
}

/** (a) 吃瓜模板：与 hls-site 共用锚点骨架，差异在详情带正文 HTML。 */
export function createChiguaAdapter(def: SourceDef): SourceAdapter {
  const base0 = htmlListAdapter(def);
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
 * （source-007 真站实锤：每册恒定 5 张样式 SVG），hls-site 的
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
  interface WpPost { id: number; link: string; title?: { rendered?: string }; content?: { rendered?: string }; excerpt?: { rendered?: string } }
  const toItem = (p: WpPost): SourceItem => ({
    sourceId: def.id, externalId: String(p.id),
    title: stripTags(p.title?.rendered ?? ""), cover: firstImgSrc(p.excerpt?.rendered ?? "") || firstImgSrc(p.content?.rendered ?? ""),
    href: p.link, tags: [],
  });
  return {
    sourceId: def.id,
    async list(page, size) {
      const raw = await fetchPage(`${apiUrl(listPath)}?page=${page}&per_page=${size}`);
      const posts = JSON.parse(raw) as WpPost[];
      return { items: posts.map(toItem), pagination: pageOf(posts.length, page, size) };
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
      const raw = await fetchPage(`${apiUrl(listPath)}?search=${encodeURIComponent(q)}&page=${page}&per_page=${size}`);
      const posts = JSON.parse(raw) as WpPost[];
      return { items: posts.map(toItem), pagination: pageOf(posts.length, page, size) };
    },
  };
}

/** (d) Danbooru 公开 API。 */
export function createDanbooruAdapter(def: SourceDef): SourceAdapter {
  const params = (def.adapter.params ?? {}) as Params;
  const listPath = str(params, "listPath", "/posts.json");
  interface DbPost { id: number; tag_string?: string; preview_file_url?: string; large_file_url?: string; file_url?: string }
  const toItem = (p: DbPost): SourceItem => ({
    sourceId: def.id, externalId: String(p.id), title: (p.tag_string ?? "").split(" ").slice(0, 4).join(" ") || `post ${p.id}`,
    cover: p.preview_file_url ?? "", href: `${def.baseUrls[0]}/posts/${p.id}`,
    tags: (p.tag_string ?? "").split(" ").filter(Boolean).slice(0, 8),
  });
  return {
    sourceId: def.id,
    async list(page, size) {
      const posts = JSON.parse(await fetchPage(`${def.baseUrls[0]}${listPath}?page=${page}&limit=${size}`)) as DbPost[];
      return { items: posts.map(toItem), pagination: pageOf(posts.length, page, size) };
    },
    async detail(id) {
      const p = JSON.parse(await fetchPage(`${def.baseUrls[0]}/posts/${id}.json`)) as DbPost;
      const item = toItem(p);
      return { ...item, images: [p.large_file_url ?? p.file_url ?? ""].filter(Boolean), episodes: [] };
    },
    async resolve(id) {
      const p = JSON.parse(await fetchPage(`${def.baseUrls[0]}/posts/${id}.json`)) as DbPost;
      const url = p.file_url ?? p.large_file_url;
      return { streams: url ? [{ url, kind: "file" as const }] : [] };
    },
    async search(q, page, size) {
      const posts = JSON.parse(await fetchPage(`${def.baseUrls[0]}${listPath}?tags=${encodeURIComponent(q)}&page=${page}&limit=${size}`)) as DbPost[];
      return { items: posts.map(toItem), pagination: pageOf(posts.length, page, size) };
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
      for (const row of rows) {
        const id = String(row?.id ?? "");
        if (!/^[a-f0-9]{24}$/i.test(id)) continue;
        try {
          const m = await getMessage(id);
          if (!isFreeShort(m)) continue;
          const item = toItem(m);
          if (item) items.push(item);
        } catch { /* 单条取数失败跳过该条，不拖垮整页（插件同口径） */ }
      }
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
      const d = await api<{ gifs?: RgGif[]; pages?: number }>(`/v2/gifs/search?search_text=&order=trending&count=${size}&page=${page}`);
      const items = (d.gifs ?? []).map(toItem).filter((x): x is SourceItem => x !== null);
      if (items.length === 0) throw new SourceParseEmptyError(def.id);
      return { items, pagination: pageOf(items.length, page, size) };
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
 * sha1(<fileUrl 末段>_<expires 参数>_<盐>)。 */
const IWARA_FILE_VERSION_SALT = "mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN";

/** (h) Iwara 公开 API（Muse 2026-11-19 fix330 接通批）：结构据
 * Hentai-Park 公开插件 iwara.js 的协议事实（只借协议/结构、代码
 * 原创）：列表 GET api.iwara.tv/videos?sort=views&page=<0基>&limit
 * → {results:[{id,slug,title,file:{id,duration},user,tags,body}]}；
 * 搜索 GET /search?type=videos&query&page&limit 同形；详情 GET
 * /video/<id>；封面由 file.id 拼 files.iwara.tv/image/thumbnail/
 * <file.id>/thumbnail-00.jpg；取流 GET 详情 fileUrl（带 X-Version
 * 签名头，Rust source_fetch 仅对 files/filesq.iwara.tv 两 host
 * 定向放行该头）→ [{name,src:{view,download}}] mp4 多档取最高档。 */
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
    const d = await getJson<{ results?: IwaraVideo[] }>(url);
    const rows = Array.isArray(d?.results) ? d.results : [];
    const items = rows.map(toItem).filter((x): x is SourceItem => x !== null);
    return { items, pagination: pageOf(rows.length, page, size) };
  };
  return {
    sourceId: def.id,
    async list(page, size) {
      const r = await listFrom(`${apiBase}/videos?sort=views&page=${page - 1}&limit=${size}`, page, size);
      if (r.items.length === 0) throw new SourceParseEmptyError(def.id);
      return r;
    },
    async detail(id) {
      const v = await getJson<IwaraVideo>(`${apiBase}/video/${id}`);
      const item = toItem(v);
      if (!item) throw new Error("Iwara 条目无效");
      return { ...item, description: String(v.body ?? ""), images: [], episodes: [{ label: "正片", externalId: id }] };
    },
    async resolve(id) {
      const v = await getJson<IwaraVideo>(`${apiBase}/video/${id}`);
      const fileUrl = String(v?.fileUrl ?? "");
      if (!fileUrl) return { streams: [] };
      let version = "";
      try {
        const u = new URL(fileUrl);
        const seg = u.pathname.split("/").filter(Boolean).pop() ?? "";
        const exp = u.searchParams.get("expires") ?? "";
        if (seg && exp) version = sha1Hex(`${seg}_${exp}_${IWARA_FILE_VERSION_SALT}`);
      } catch { /* fileUrl 形态异常：无签名取数、由响应形态决定成败 */ }
      const rows = await getJson<{ name?: string; quality?: string; src?: { view?: string; download?: string }; url?: string }[]>(
        fileUrl, version ? { "X-Version": version } : undefined);
      if (!Array.isArray(rows)) return { streams: [] };
      const cands = rows
        .map((r) => ({ url: r.src?.view ?? r.src?.download ?? r.url ?? "", q: Number(String(r.name ?? r.quality ?? "").match(/\d+/)?.[0] ?? 0) }))
        .filter((c) => /^https:\/\//i.test(c.url));
      cands.sort((a, b) => b.q - a.q);
      return { streams: cands.length ? [{ url: cands[0].url, kind: "file" as const }] : [] };
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
export function createHanime1Adapter(def: SourceDef): SourceAdapter {
  const base = def.baseUrls[0].replace(/\/$/, "");
  const cardTitle = (inner: string): string => {
    const m = /class="[^"]*(?:home-rows-videos-title|card-mobile-title)[^"]*"[^>]*>([\s\S]*?)<\//i.exec(inner)
      ?? /class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\//i.exec(inner);
    return m ? stripTags(m[1]) : "";
  };
  const parseCards = (html: string): SourceItem[] => {
    const seen = new Set<string>();
    const items: SourceItem[] = [];
    for (const a of findAnchors(html)) {
      const m = /watch\?v=(\d{1,8})/.exec(a.href);
      if (!m || seen.has(m[1])) continue;
      const title = cardTitle(a.inner) || imgAlt(a.inner);
      const cover = firstImgSrc(a.inner);
      if (!title || !cover) continue;
      seen.add(m[1]);
      const dur = /class="[^"]*(?:card-mobile-duration|duration)[^"]*"[^>]*>\s*([\d]+:[\d:]+)/i.exec(a.inner)?.[1];
      items.push({ sourceId: def.id, externalId: m[1], title, cover: absUrl(base, cover), href: `${base}/watch?v=${m[1]}`, tags: [], duration: dur });
    }
    return items;
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
    async list(page, size) {
      const html = await fetchPage(`${base}/search?sort=${encodeURIComponent("最新上市")}${pageParam(page)}`);
      const all = parseCards(html);
      if (all.length === 0) throw new SourceParseEmptyError(def.id);
      return { items: all.slice(0, size), pagination: pageOf(all.length, page, size) };
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
      let sources = parseSources(await fetchPage(`${base}/watch?v=${id}`));
      if (sources.length === 0) {
        try { sources = parseSources(await fetchPage(`${base}/download?v=${id}`)); } catch { /* 下载页不可达：以 watch 页结论为准（无流） */ }
      }
      return { streams: sources.length ? [{ url: sources[0].url, kind: "file" as const }] : [] };
    },
    async search(q, page, size) {
      const html = await fetchPage(`${base}/search?query=${encodeURIComponent(q)}${pageParam(page)}`);
      const all = parseCards(html);
      return { items: all.slice(0, size), pagination: pageOf(all.length, page, size) };
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
  const apiList = async (params: string, page: number, size: number): Promise<SourceItem[]> => {
    const d = JSON.parse(await fetchPage(`${base}/api/manga/?${params}&per_page=${size}&page=${page}`)) as { data?: HhRow[] };
    const rows = Array.isArray(d?.data) ? d.data : [];
    return rows.map(toItem).filter((x): x is SourceItem => x !== null);
  };
  const episodeNums = (html: string, slug: string): number[] => {
    const seen = new Set<number>();
    const re = new RegExp(`/watch/${slug}/episode-(\\d+)`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) seen.add(Number(m[1]));
    return [...seen].sort((a, b) => a - b);
  };
  const extractHls = (html: string): string | null => {
    const m = /"contentUrl"\s*:\s*"(https:[^"]+?\.m3u8[^"]*)"/i.exec(html.replace(/\\\//g, "/"));
    return m ? m[1] : extractM3u8(html);
  };
  return {
    sourceId: def.id,
    async list(page, size) {
      const items = await apiList("trending_period=monthly", page, size);
      if (items.length === 0) throw new SourceParseEmptyError(def.id);
      return { items, pagination: pageOf(items.length, page, size) };
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
      const [slug, epPart] = id.split("/episode-");
      const watchHtml = await fetchPage(`${base}/watch/${slug}/`);
      const eps = episodeNums(watchHtml, slug);
      const want = epPart ? Number(epPart) : eps[0];
      let url: string | null = null;
      if (want !== undefined && eps.includes(want)) {
        url = extractHls(await fetchPage(`${base}/watch/${slug}/episode-${want}/`));
      }
      url ??= extractHls(watchHtml);
      return { streams: url ? [{ url, kind: "hls" as const }] : [] };
    },
    async search(q, page, size) {
      const items = await apiList(`search=${encodeURIComponent(q.slice(0, 100))}`, page, size);
      return { items, pagination: pageOf(items.length, page, size) };
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
