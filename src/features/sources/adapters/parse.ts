/**
 * 轻量 HTML 解析助手（Muse 2026-11-19 根治包）：正则级解析，
 * WebView 与 Node 契约测试环境都能跑（不依赖 DOMParser）。
 * 只做模板需要的四件事：锚点枚举、图片提取、meta 提取、m3u8 提取。
 */

/* 命名实体表（fix330 图片线补全）：只收真站标题/简介里常见的标点与
 * 符号类；数字实体（十进制/十六进制）走通用解码，不逐个列表。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", middot: "·",
  bull: "•", deg: "°", copy: "©", reg: "®", trade: "™",
  times: "×", divide: "÷", plusmn: "±", frac12: "½", iexcl: "¡", iquest: "¿",
};

/** HTML 实体解码（共用解析层单点，fix330 图片线补全）：旧实现只认
 * &#39; 等少数形态，真站标题/简介里的 &#039;（前导零）、&#8217;、
 * &#x27;、&hellip; 等全部原样漏进界面（用户实报详情简介出现
 * &#039;）。现单遍扫描：十进制（含前导零）/十六进制数字实体通用
 * 解码＋命名实体查表；单遍替换保证 &amp;#039; 只解一层、不二次
 * 解码；未知实体与无分号裸 & 原样保留。全部模板的标题/简介/正文
 * 文本路径（stripTags/findAnchors/imgAlt/headingText/metaContent/
 * firstImgSrc/allImgSrcs/extractIframeSrc）都经此一处。 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#(?:x|X)[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const n = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
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

/** 卡片标题语义元素（Muse 2026-11-19 fix321-F2b）：真站卡片普遍把
 * 标题放在 h2/h3 里（肉视频 h3、FC2 榜单 h3、51吃瓜 h2、黑料网
 * h3.title），整卡 stripTags 会把排名/作者/评分一并拼进标题；
 * 锚点标题优先取首个 h2/h3 文本。 */
export function headingText(fragment: string): string {
  const m = /<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i.exec(fragment);
  return m ? stripTags(m[1]) : "";
}

/** 封面兜底（fix321-F2b）：部分真站卡片不用 <img> 承封面——51吃瓜
 * post-card 背景在 div 的 x-bg-loader-url、黑料网 video-item 封面在
 * img 的 z-image-loader-url（无 src）；img 系属性取不到时按这两种
 * 懒加载属性兜底。
 * 第三载体（Muse 2026-11-20 fix331/covers-header，3.3.1 真机首验
 * 问题①）：source-005 卡片封面不在任何属性上，只由内联脚本调用
 * loadBannerDirect('<直址>', '', el, ...) 的第一字符串参数承载
 * （2026-11-20 本机抓真站列表页实测形态）；前两级落空时按此兜底。
 * 只认 http(s) 直址、单双引号通吃。 */
export function firstCoverSrc(fragment: string): string {
  const img = firstImgSrc(fragment);
  if (img) return img;
  const m = /\b(?:x-bg-loader-url|z-image-loader-url)=(["'])([^"']+)\1/i.exec(fragment);
  if (m) return decodeEntities(m[2]);
  const s = /\bloadBannerDirect\(\s*(["'])(https?:\/\/[^"']+)\1/i.exec(fragment);
  return s ? decodeEntities(s[2]) : "";
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
