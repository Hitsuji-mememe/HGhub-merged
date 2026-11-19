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
import { allImgSrcs, extractIframeSrc, extractM3u8, extractMp4, findAnchors, firstImgSrc, imgAlt, metaContent, pageOf, stripTags } from "./parse.ts";

export const TEMPLATE_IDS = ["native-huangguo", "chigua", "wp-rest", "hls-site", "danbooru-api", "preview-only", "none"] as const;

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
    const title = a.titleAttr || imgAlt(a.inner) || stripTags(a.inner) || titleFromHref(href);
    if (!title) continue;
    items.push({ sourceId, externalId: href, title, cover: absUrl(base, firstImgSrc(a.inner)), href, tags: [] });
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
