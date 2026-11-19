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
import { REDGIFS_API_ORIGIN, SWAG_API_ORIGIN } from "./fetchOrigins.ts";
import { allImgSrcs, extractIframeSrc, extractM3u8, extractMp4, findAnchors, firstCoverSrc, firstImgSrc, headingText, imgAlt, metaContent, pageOf, stripTags } from "./parse.ts";

export const TEMPLATE_IDS = ["native-huangguo", "chigua", "wp-rest", "hls-site", "danbooru-api", "swag-api", "redgifs-api", "hanime-api", "preview-only", "none"] as const;

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
    return decodeURIComponent(seg).replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").replace(/\s+\d+$/, "").trim();
  } catch { return ""; }
}

/** 锚点列表解析（chigua 与 hls-site 共用）：href 含 itemLinkPattern 的锚点为条目。 */
function parseAnchorList(html: string, base: string, sourceId: string, itemLinkPattern: string): SourceItem[] {
  const seen = new Set<string>();
  const items: SourceItem[] = [];
  for (const a of findAnchors(html)) {
    if (!a.href.includes(itemLinkPattern)) continue;
    const href = absUrl(base, a.href);
    if (seen.has(href)) continue;
    seen.add(href);
    const title = a.titleAttr || headingText(a.inner) || imgAlt(a.inner) || stripTags(a.inner) || titleFromHref(href);
    if (!title) continue;
    items.push({ sourceId, externalId: href, title, cover: absUrl(base, firstCoverSrc(a.inner)), href, tags: [] });
  }
  return items;
}

async function htmlDetail(def: SourceDef, externalId: string): Promise<SourceDetail> {
  const base = def.baseUrls[0];
  const html = await fetchPage(absUrl(base, externalId));
  const title = metaContent(html, "og:title") || stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  const cover = metaContent(html, "og:image");
  const hasStream = extractM3u8(html) !== null || extractMp4(html) !== null;
  return {
    sourceId: def.id, externalId, title, cover: cover ? absUrl(base, cover) : "",
    href: absUrl(base, externalId), tags: [], description: metaContent(html, "description"),
    contentHtml: undefined, images: allImgSrcs(html).map((s) => absUrl(base, s)),
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
  return {
    sourceId: def.id,
    async list(page, size) {
      const base = def.baseUrls[0];
      const html = await fetchPage(absUrl(base, fill(listPath, { page })));
      const all = parseAnchorList(html, base, def.id, itemLinkPattern);
      /* 未知不是空（fix321-F2）：取到页却 0 条目 = 解析失败，显式抛错走列表层错误通道 */
      if (all.length === 0) throw new SourceParseEmptyError(def.id);
      const items = all.slice(0, size);
      return { items, pagination: pageOf(all.length, page, size) };
    },
    detail: (id) => htmlDetail(def, id),
    resolve: (id) => htmlResolve(def, id),
    async search(q, page, size) {
      const base = def.baseUrls[0];
      const html = await fetchPage(absUrl(base, `/?s=${encodeURIComponent(q)}&paged=${page}`));
      const all = parseAnchorList(html, base, def.id, itemLinkPattern);
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
      const bodyMatch = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html) ?? /<div\b[^>]*class="[^"]*(?:entry-content|post-content|article-content)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<footer|<aside)/i.exec(html);
      return { ...d, contentHtml: bodyMatch?.[1] };
    },
  };
}

/** (c) 通用 HLS 站骨架。 */
export function createHlsSiteAdapter(def: SourceDef): SourceAdapter {
  return htmlListAdapter(def);
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
