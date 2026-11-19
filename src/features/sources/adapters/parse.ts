/**
 * 轻量 HTML 解析助手（Muse 2026-11-19 根治包）：正则级解析，
 * WebView 与 Node 契约测试环境都能跑（不依赖 DOMParser）。
 * 只做模板需要的四件事：锚点枚举、图片提取、meta 提取、m3u8 提取。
 */

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

export interface Anchor { href: string; inner: string; titleAttr: string }

/* 属性引号双形态（Muse 2026-11-19 fix321-F2）：真站复核发现
 * PornPics /recent/ 的锚点与 img 全用单引号属性，旧正则只认双引号
 * → 条目整体不可见。以下提取一律双/单引号通吃（反向引用钉住配对）。 */
export function findAnchors(html: string): Anchor[] {
  const out: Anchor[] = [];
  const re = /<a\b[^>]*\bhref=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const openTag = m[0].slice(0, m[0].indexOf(">") + 1);
    const title = /\btitle=(["'])([^"']*)\1/i.exec(openTag)?.[2] ?? "";
    out.push({ href: decodeEntities(m[2]), inner: m[3], titleAttr: decodeEntities(title) });
  }
  return out;
}

export function firstImgSrc(fragment: string): string {
  const m = /<img\b[^>]*\b(?:data-src|data-original|src)=(["'])([^"']+)\1/i.exec(fragment);
  return m ? decodeEntities(m[2]) : "";
}

export function imgAlt(fragment: string): string {
  const m = /<img\b[^>]*\balt=(["'])([^"']*)\1/i.exec(fragment);
  return m ? decodeEntities(m[2]) : "";
}

export function allImgSrcs(html: string): string[] {
  const out: string[] = [];
  const re = /<img\b[^>]*\b(?:data-src|data-original|src)=(["'])([^"']+)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(decodeEntities(m[2]));
  return out;
}

export function metaContent(html: string, property: string): string {
  const re = new RegExp(`<meta\\b[^>]*\\b(?:property|name)="${property}"[^>]*\\bcontent="([^"]*)"`, "i");
  const re2 = new RegExp(`<meta\\b[^>]*\\bcontent="([^"]*)"[^>]*\\b(?:property|name)="${property}"`, "i");
  return decodeEntities(re.exec(html)?.[1] ?? re2.exec(html)?.[1] ?? "");
}

/** 还原嵌在 JS/JSON 里的转义 URL（\/ 与 &amp;），供流地址提取前预处理。 */
export function unescapeUrlText(html: string): string {
  return html.replace(/\\\//g, "/").replace(/&amp;/g, "&").replace(/\\u0026/g, "&");
}

export function extractM3u8(html: string): string | null {
  const m = /https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/i.exec(unescapeUrlText(html));
  return m ? m[0] : null;
}

/**
 * mp4 直链兜底（KVS 系站点的 video_url / <source> 形态）：收集全部候选，
 * 滤掉预览/时间轴缩略类，按文件名画质标记 1080>720>480 优先，否则取首个。
 */
export function extractMp4(html: string): string | null {
  const text = unescapeUrlText(html);
  const all = [...text.matchAll(/https?:\/\/[^\s"'<>\\]+?\.mp4(?:\?[^\s"'<>\\]*)?/gi)]
    .map((m) => m[0])
    .filter((u) => !/preview|timelines/i.test(u));
  if (!all.length) return null;
  for (const q of ["1080", "720", "480"]) {
    const hit = all.find((u) => u.includes(q));
    if (hit) return hit;
  }
  return all[0];
}

export function extractIframeSrc(html: string): string | null {
  const m = /<iframe\b[^>]*\bsrc="([^"]+)"/i.exec(html);
  return m ? decodeEntities(m[1]) : null;
}

export function pageOf(total: number, page: number, size: number): { page: number; pages: number; size: number; total: number } {
  return { page, pages: size > 0 ? Math.max(1, Math.ceil(total / size)) : 1, size, total };
}
