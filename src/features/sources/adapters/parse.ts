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

export function findAnchors(html: string): Anchor[] {
  const out: Anchor[] = [];
  const re = /<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const openTag = m[0].slice(0, m[0].indexOf(">") + 1);
    const title = /\btitle="([^"]*)"/i.exec(openTag)?.[1] ?? "";
    out.push({ href: decodeEntities(m[1]), inner: m[2], titleAttr: decodeEntities(title) });
  }
  return out;
}

export function firstImgSrc(fragment: string): string {
  const m = /<img\b[^>]*\b(?:data-src|data-original|src)="([^"]+)"/i.exec(fragment);
  return m ? decodeEntities(m[1]) : "";
}

export function imgAlt(fragment: string): string {
  const m = /<img\b[^>]*\balt="([^"]*)"/i.exec(fragment);
  return m ? decodeEntities(m[1]) : "";
}

export function allImgSrcs(html: string): string[] {
  const out: string[] = [];
  const re = /<img\b[^>]*\b(?:data-src|data-original|src)="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(decodeEntities(m[1]));
  return out;
}

export function metaContent(html: string, property: string): string {
  const re = new RegExp(`<meta\\b[^>]*\\b(?:property|name)="${property}"[^>]*\\bcontent="([^"]*)"`, "i");
  const re2 = new RegExp(`<meta\\b[^>]*\\bcontent="([^"]*)"[^>]*\\b(?:property|name)="${property}"`, "i");
  return decodeEntities(re.exec(html)?.[1] ?? re2.exec(html)?.[1] ?? "");
}

export function extractM3u8(html: string): string | null {
  const m = /https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/i.exec(html);
  return m ? m[0] : null;
}

export function pageOf(total: number, page: number, size: number): { page: number; pages: number; size: number; total: number } {
  return { page, pages: size > 0 ? Math.max(1, Math.ceil(total / size)) : 1, size, total };
}
