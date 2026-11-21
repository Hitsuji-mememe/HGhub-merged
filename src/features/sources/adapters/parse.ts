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

/* 脚本族元素（fix335/b-purify 根治）：script/style/noscript/template
 * 的内容是标签之间的文本、不是标签本身——旧 stripTags 只删标签，
 * 元素内容被压平成文本存活：004 列表卡内封面脚本 loadBannerDirect
 * 在卡标题回退链落到 stripTags 时整段漏成标题、端上详情页头栏
 * （真机实报＋夹具删 h2 变体复现，见 fix335/audit-004-leaks.md）。
 * 正文路径走 DOM＋SKIP_TAGS 天然免疫，漏口只在正则文本路径这一
 * 个单点，故在此整棵剔除元素内容、全消费者（标题链/headingText/
 * wp-rest 标题/详情标题等）一处受益；脚本族内容在任何形态下都不
 * 是合法标题/正文文本，无内容误伤面。未闭合的开标签按吞到串尾
 * 处理（截断 HTML 里其后不可能是合法文本）。 */
const SCRIPTY_ELEMENT_RE = /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const SCRIPTY_UNCLOSED_RE = /<(script|style|noscript|template)\b[^>]*>[\s\S]*$/gi;

export function stripTags(html: string): string {
  const cleaned = html.replace(SCRIPTY_ELEMENT_RE, " ").replace(SCRIPTY_UNCLOSED_RE, " ");
  return decodeEntities(cleaned.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

export interface Anchor { href: string; inner: string; titleAttr: string; rel: string; cls: string }

/* 属性引号双形态（Muse 2026-11-19 fix321-F2）：真站复核发现
 * PornPics /recent/ 的锚点与 img 全用单引号属性，旧正则只认双引号
 * → 条目整体不可见。以下提取一律双/单引号通吃（反向引用钉住配对）。
 * rel 与 class 一并采集（Muse 2026-11-20 fix333/list-noise）：
 * rel="sponsored" 与 class 的 pgx-card 都是广告位的显式标记，
 * 列表层显式排除要用它们定点识别。 */
export function findAnchors(html: string): Anchor[] {
  const out: Anchor[] = [];
  const re = /<a\b[^>]*\bhref=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const openTag = m[0].slice(0, m[0].indexOf(">") + 1);
    const title = /\btitle=(["'])([^"']*)\1/i.exec(openTag)?.[2] ?? "";
    const rel = /\brel=(["'])([^"']*)\1/i.exec(openTag)?.[2] ?? "";
    const cls = /\bclass=(["'])([^"']*)\1/i.exec(openTag)?.[2] ?? "";
    out.push({ href: decodeEntities(m[2]), inner: m[3], titleAttr: decodeEntities(title), rel: decodeEntities(rel), cls: decodeEntities(cls) });
  }
  return out;
}

export interface CardRegion { inner: string; adMarked: boolean; inTemplate: boolean }

function classTokens(openTag: string): string[] {
  const m = /\bclass=(["'])([^"']*)\1/i.exec(openTag);
  return m ? m[2].split(/\s+/).filter(Boolean) : [];
}

/** <template> 占据的字符区间（fix333/list-noise）：模板不渲染，区间
 * 内的卡片单列（回填遍）。闭合缺失时以下一个 <template> 开标签或
 * 页尾为界——真站摘录夹具里模板未配平（real-heiliao-home.html），
 * 按「未闭合即吞掉全页」处理会把摘录里的真卡全吞掉。 */
function templateSpans(html: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const re = /<template\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const close = html.indexOf("</template", re.lastIndex);
    const next = html.indexOf("<template", re.lastIndex);
    const end = Math.min(close === -1 ? html.length : close, next === -1 ? html.length : next);
    spans.push({ start: m.index, end });
  }
  return spans;
}

/** 卡片容器区域采集（Muse 2026-11-20 fix333/list-noise）：列表页的
 * 条目锚点只认卡片容器内的——吃瓜三源真站普查（9 页，证据
 * fix333/evidence/adpost-census.md）实测：容器外 /archives/ 锚点全是
 * 页眉导航下拉与页脚站务/招募（003 每页 2 条恒居清单首、004 每页
 * 12 条占 p1 的 44%），容器内锚点全是帖子卡，零交叉。容器形态按
 * 主题二选一：article（003/005 主题）或 class 含 video-item 整词的
 * div（004 主题）。自容器开标签起按同名标签深度扫描找配平闭合
 * （与 mainContentRegion 同法）；未配平则区域延至页尾（回落语义
 * 与内容区地标一致）。容器 class 含 ad-item 或 ssp-placement 整词
 * 的记 adMarked（页面层广告位，由调用方显式排除，不靠 href 模式
 * 偶然挡住）；容器落在 <template> 区间内的记 inTemplate（模板不
 * 渲染、内容单列，见 findCardAnchors 的两遍口径）。 */
export function cardContainerRegions(html: string, container: "article" | "video-item"): CardRegion[] {
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  const isContainer = (tag: string, open: string): boolean =>
    container === "article" ? tag === "article" : tag === "div" && classTokens(open).includes("video-item");
  const spans = templateSpans(html);
  const regions: CardRegion[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[1] === "/" || m[3] === "/") continue;
    const tag = m[2].toLowerCase();
    if (!isContainer(tag, m[0])) continue;
    const tokens = classTokens(m[0]);
    const adMarked = tokens.includes("ad-item") || tokens.includes("ssp-placement");
    const inTemplate = spans.some((sp) => m!.index >= sp.start && m!.index < sp.end);
    const innerStart = tagRe.lastIndex;
    const scan = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, "gi");
    scan.lastIndex = innerStart;
    let depth = 1;
    let end = html.length;
    let s: RegExpExecArray | null;
    while ((s = scan.exec(html)) !== null) {
      if (s[2] === "/") continue;
      if (s[1] === "/") { depth -= 1; if (depth === 0) { end = s.index; break; } }
      else depth += 1;
    }
    regions.push({ inner: html.slice(innerStart, end), adMarked, inTemplate });
    tagRe.lastIndex = end;
  }
  return regions;
}

/** 卡片容器内锚点（fix333/list-noise）：只收非广告容器内的锚点。
 * 显式排除三路（不再靠「外链不含条目模式」的偶然排除）：
 * ad-item / ssp-placement 容器整块、rel="sponsored" 锚点、
 * class 含 pgx-card 的锚点（004 广告位假卡的实测标记：ssp 模板
 * 的首锚点全为 pgx-card＋data-card、无一带条目 href）。
 * 两遍采集：渲染区容器优先，<template> 区间内的容器回填——004
 * 的 ssp 模板里除假卡外还塞着真卡克隆（真站 p1 实测：模板内
 * 卡片 id 14 个全部是渲染区卡片的克隆、零独有），整页时回填集
 * 与渲染集同 href 被去重吞掉、无差别；但页面摘录/变体里渲染
 * 副本缺席时只剩模板副本（仓库夹具 real-heiliao-home.html 即
 * 此形态），回填保住真卡不丢。容器形态与页面不匹配（采集为
 * 0）时返回空数组，是否回落整页由调用方按「未知不是空」的
 * 既有口径决定（同 contentImgSrcs 的地标回落先例）。 */
export function findCardAnchors(html: string, container: "article" | "video-item"): Anchor[] {
  const out: Anchor[] = [];
  const seen = new Set<string>();
  const collect = (regions: CardRegion[]) => {
    for (const r of regions) {
      if (r.adMarked) continue;
      for (const a of findAnchors(r.inner)) {
        if (a.rel.split(/\s+/).includes("sponsored")) continue;
        if (a.cls.split(/\s+/).includes("pgx-card")) continue;
        if (seen.has(a.href)) continue;
        seen.add(a.href);
        out.push(a);
      }
    }
  };
  const regions = cardContainerRegions(html, container);
  collect(regions.filter((r) => !r.inTemplate));
  collect(regions.filter((r) => r.inTemplate));
  return out;
}

/** 卡片分类词元（Muse 2026-11-20 fix333/promo-filter）：Mirages 系
 * post-card 的分类只以纯文本躺在 post-card-info 区的无属性 <span>
 * 里（逗号分隔的分类名清单，如「今日吃瓜, 往期活动」；作者/日期
 * span 都带 itemprop 属性、不在此列）。主题变体两形态：003 有
 * post-card-meta 包裹层、005 无包裹层分类 span 直挂 post-card-info
 * ——故地标取 post-card-info（两形态的公共祖先），不许只认包裹层
 * （005 真站复测实证：只认 post-card-meta 时 005 判据恒不触发）。
 * 提取裸 span 文本并按中英文逗号/顿号切分为词元（逐词元精确比
 * 对，子串不算命中——「往期活动」与「往期活动回顾」是两个词元）。
 * 无 post-card-info 或无裸 span 时返回空集（调用方据此不判，不猜）。 */
export function cardCategoryTokens(inner: string): string[] {
  const metaAt = inner.indexOf("post-card-info");
  if (metaAt < 0) return [];
  const region = inner.slice(metaAt, metaAt + 1200);
  const out: string[] = [];
  const re = /<span>([^<]+)<\/span>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(region)) !== null) {
    for (const t of m[1].split(/[,，、]/)) {
      const v = t.trim();
      if (v) out.push(v);
    }
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
 * 只认 http(s) 直址、单双引号通吃。
 * 第四载体（Muse 2026-11-20 fix333/reader3，3.3.2 真机验收）：source-003
 * 列表页卡片改用 z-bg-loader-url 承封面（2026-11-20 实测两页 48 卡
 * 中 45 卡只有此载体、旧链返回 ""；与 x-bg 同为该主题的背景懒加载
 * 属性族），并入同一级 loader 属性 alternation，优先级不变。 */
export function firstCoverSrc(fragment: string): string {
  const img = firstImgSrc(fragment);
  if (img) return img;
  const m = /\b(?:x-bg-loader-url|z-bg-loader-url|z-image-loader-url)=(["'])([^"']+)\1/i.exec(fragment);
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

/** 内容区地标的内层 HTML（Muse 2026-11-20 fix332-B1）：地标＝
 * <main> 元素或带 id="main"/role="main" 的容器（HTML 内容区语义
 * 标记、非某站类名）。自地标开标签起按同名标签深度扫描找配平
 * 闭合，返回其内层片段；无地标或未配平时返回 null（调用方回落
 * 整页）。正则级解析的既有上限同样适用（属性值含 >、脚本/注释
 * 内的同名标签字符串可扰动深度），扰动的最坏结果只是回落或
 * 边界偏移，不产生新形态数据。 */
function mainContentRegion(html: string): string | null {
  const tagRe = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const open = m[0];
    const isLandmark = tag === "main"
      || /\bid\s*=\s*(["'])main\1/i.test(open)
      || /\brole\s*=\s*(["'])main\1/i.test(open);
    if (!isLandmark || open.endsWith("/>")) continue;
    const innerStart = tagRe.lastIndex;
    const scan = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, "gi");
    scan.lastIndex = innerStart;
    let depth = 1;
    let s: RegExpExecArray | null;
    while ((s = scan.exec(html)) !== null) {
      if (s[2] === "/") continue;
      if (s[1] === "/") { depth -= 1; if (depth === 0) return html.slice(innerStart, s.index); }
      else depth += 1;
    }
    return null;
  }
  return null;
}

/** 内容区图片采集（fix332-B1）：整页采集会把页眉/页脚/登录区的
 * 站点样式图形（logo、合规徽标等界面资源）混进图集——pornpics
 * 真站详情页实测每册恒定混入 5 张、全在内容区地标之外，地标内
 * 43/43 张为内容图（含列表内 banner tile 的头像）。页面有内容区
 * 地标时只在地标内采集（顺序与重复保留、与 allImgSrcs 同口径）；
 * 无地标或未配平时回落整页采集，旧行为逐字不变。
 * 空集守卫（Muse 2026-11-20 fix333-M3，B1 独立复验记账）：地标
 * 深度扫描会被地标内 <script> 字符串里的同名闭标签提前截断，截断
 * 点恰在内容图之前时限定采集为空集——「被截断」与「内容区真无图」
 * 在正则级不可分，按「未知不是空」回落整页采集（与无地标回落同
 * 口径、最坏退化为 B1 前行为），不让图集静默归零。007 现行页型
 * 不可达（脚本不在地标内），属预防性守卫，合成形态由 fix333-m3
 * 契约钉死。 */
export function contentImgSrcs(html: string): string[] {
  const region = mainContentRegion(html);
  if (region === null) return allImgSrcs(html);
  const scoped = allImgSrcs(region);
  return scoped.length > 0 ? scoped : allImgSrcs(html);
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

/** 分页导航末页提取（Muse 2026-11-20 fix335/a-pagination）：HTML
 * 列表页的站方分页导航自带末页链接（吃瓜三源 2026-11-20 live 实测：
 * 003 导航含 /page/3230/、005 含 /page/2312/、004 含 /page/2045/，
 * 与站方自报总页数一致）——这是 HTML 模板唯一的总页数真信号，
 * 优先于任何条数推断。按列表/搜索路径模板的形状扫全部 href：
 * {page} 段收数字、其余占位（如 {q}）收单段，取命中页码最大值。
 * 导航只给窗口页码不给末页时，最大值是窗口尾——消费方到达该页后
 * 该页导航会给出更大的窗口尾，信号自校正，不会提前封顶。模板无
 * {page}（单页橱窗面）或无命中时返回 null，消费方回落推断口径。 */
export function lastPageInNav(html: string, pathTemplate: string): number | null {
  if (!pathTemplate.includes("{page}")) return null;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = pathTemplate.split(/(\{\w+\})/).map((seg) =>
    seg === "{page}" ? "(\\d+)" : seg.startsWith("{") ? "[^/\"'\\s]+" : esc(seg)).join("");
  const re = new RegExp(pattern);
  let max: number | null = null;
  const hrefRe = /href=(["'])([^"']+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    const hit = re.exec(m[2]);
    if (!hit) continue;
    const n = Number(hit[1]);
    if (Number.isFinite(n) && n >= 1 && (max === null || n > max)) max = n;
  }
  return max;
}
