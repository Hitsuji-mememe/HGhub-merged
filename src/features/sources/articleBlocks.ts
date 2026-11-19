/**
 * 吃瓜正文提取—重构（Muse 2026-11-19 fix330/reader，用户 23:59
 * 裁定「只看有用的、废话和广告都砍掉」后的主线做法）：posts 正文
 * 不再走 sanitizeHtml 整页清洗渲染，而是从适配器 detail 已给的
 * contentHtml（chigua 模板已定位的正文容器内容）按文档顺序提取
 * 内容块——文本段落／图片——由 SourcePosts 用 App 阅读版式原生
 * 重渲染。广告位、假按钮、导航、评论区、相关推荐、分享件与站长
 * 样式垃圾不是「清洗时删」，是提取时根本不入块。
 *
 * 提取口径（保守，红线＝不误删正文）：
 * - 结构层：脚本/样式/播放器/表单/按钮/导航等非正文元素整棵跳过；
 *   类名/id 命中垃圾段（广告/分享/推荐/评论/下载/导航等，按 [-_/]
 *   切段精确匹配、不用子串，避免误伤 post-content 等正文类名）的
 *   容器整棵不入块。提取不依赖容器类名、递归遍历全文；若类名排除
 *   把正文误包（如正文被 share 类容器包裹）导致首轮零块，自动以
 *   「不按类名排除」重走一遍保底——有正文就不会提取为空。
 * - 段级过滤（只杀高置信垃圾）：①防走失/地址发布类短语；②下载
 *   App 引导短语；③扫码进群类；④整段就是 CTA 文案或裸域名行；
 *   ⑤加群引导——只认 ≤48 字的短段（长叙事段出现群相关词是正文，
 *   不杀）；⑥与标题重复段、与正文重复段（归一化后精确去重，近似
 *   重复保留）。拿不准的一律保留。
 * - 图片：地址解析与整页清洗链共用 html.ts 的 articleImageSrc
 *   （同一候选链＋安全门＋基址补全，两条路径地址集合恒一致），
 *   渲染继续走本地 /img 路由，不新开通道。
 *
 * 返回 located＝是否在 HTML 里定位到任何内容块（哪怕全被段级
 * 过滤杀掉）：调用方据此降级——located 且块为空说明正文全是垃圾
 * 段，宁可显简介也不回旧渲染把垃圾端上来；未 located（结构未知、
 * 提取不到内容）才维持旧清洗渲染，如实降级不假空。
 */
import { articleImageSrc } from "../../shared/lib/html";

export type ArticleBlock =
  | { type: "text"; text: string; heading: boolean }
  | { type: "image"; src: string; alt: string };

export interface ArticleExtraction {
  blocks: ArticleBlock[];
  located: boolean;
}

/* 非正文元素：整棵不入块（播放器由帖子页单独呈现，不从正文里捡）。 */
const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "VIDEO", "AUDIO",
  "SOURCE", "TRACK", "FORM", "BUTTON", "INPUT", "SELECT", "TEXTAREA",
  "NAV", "ASIDE", "FOOTER", "HEADER", "SVG", "MATH", "OBJECT", "EMBED",
  "CANVAS", "LINK", "META", "TITLE", "MAP", "AREA",
]);

/* 块级元素：进入/离开都断段；行内元素只贡献文本。 */
const BLOCK_TAGS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "MAIN",
  "H1", "H2", "H3", "H4", "H5", "H6",
  "UL", "OL", "LI", "BLOCKQUOTE", "PRE",
  "TABLE", "THEAD", "TBODY", "TR", "TD", "TH",
  "FIGURE", "FIGCAPTION", "DL", "DT", "DD", "DETAILS", "SUMMARY", "ADDRESS",
]);

/* 垃圾容器类名段（按 [-_/] 切段后精确匹配）：广告位/推广、导航件、
 * 评论区、相关推荐、分享件、下载引导容器、弹窗/侧栏/登录注册/
 * 二维码/页眉页脚。正文类名（post-content、entry-content、
 * editormd-preview 等）的段不在此集，不会误伤。 */
const JUNK_SEGMENTS = new Set([
  "ad", "ads", "advert", "advertisement", "banner", "promo", "promotion", "sponsor", "sponsored",
  "nav", "navigation", "menu", "breadcrumb", "breadcrumbs", "pagination", "pager", "prev", "next", "toolbar",
  "comment", "comments", "reply", "replies", "respond",
  "related", "recommend", "recommended", "guess",
  "share", "shares", "social",
  "download", "popup", "popover", "modal", "sidebar", "widget", "widgets",
  "login", "register", "signup", "qrcode", "qr", "footer", "header", "copyright",
]);

const JUNK_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search"]);

function isJunkContainer(el: Element): boolean {
  const role = el.getAttribute("role");
  if (role && JUNK_ROLES.has(role.toLowerCase())) return true;
  const names = `${el.getAttribute("class") ?? ""} ${el.id ?? ""}`.toLowerCase();
  for (const token of names.split(/\s+/)) {
    for (const seg of token.split(/[-_/]+/)) {
      if (seg && JUNK_SEGMENTS.has(seg)) return true;
    }
  }
  return false;
}

/** 文档顺序遍历：文本攒进当前段、块级边界与 <br> 断段、图片独立成块。 */
function walkBlocks(root: ParentNode, base: string | undefined, skipJunkClass: boolean): ArticleBlock[] {
  const blocks: ArticleBlock[] = [];
  let buf = "";
  let bufHeading = false;
  const flush = () => {
    const text = buf.replace(/\s+/g, " ").trim();
    if (text) blocks.push({ type: "text", text, heading: bufHeading });
    buf = "";
    bufHeading = false;
  };
  const visit = (node: Node, headingCtx: boolean): void => {
    if (node.nodeType === 3) {
      if (!buf.trim() && headingCtx) bufHeading = true;
      buf += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return;
    if (skipJunkClass && isJunkContainer(el)) return;
    if (tag === "BR") { flush(); return; }
    if (tag === "IMG") {
      flush();
      const src = articleImageSrc(el, base);
      if (src) blocks.push({ type: "image", src, alt: (el.getAttribute("alt") ?? "").trim() });
      return;
    }
    const isBlock = BLOCK_TAGS.has(tag);
    const childHeading = headingCtx || /^H[1-6]$/.test(tag);
    if (isBlock) flush();
    for (const child of Array.from(el.childNodes)) visit(child, childHeading);
    if (isBlock) flush();
  };
  for (const child of Array.from(root.childNodes)) visit(child, false);
  flush();
  return blocks;
}

/* ── 段级高置信垃圾（拿不准不杀，逐条有夹具正反例） ── */
const LOST_PROOF_RE = /防走失|永久地址|最新地址|地址发布|发布页|不迷路|永久域名|最新域名|收藏本站|本站地址/;
const APP_GUIDE_RE = /下载[^\s，。；]{0,3}app|app[^\s，。；]{0,3}下载|安装[^\s，。；]{0,3}app|官方app|本站app/i;
const SCAN_GUIDE_RE = /扫码(进群|加群|入群|下载|关注)/;
const GROUP_GUIDE_RE = /(加|进|入)(入)?[^\s，。；]{0,4}群|群号/;
const CTA_LINE_RE = /^(点击|立即|马上|点我|免费|直接)?\s*(下载|安装|打开|进入|观看|播放)\s*(app|应用|软件|客户端)?\s*(↓|»|>>|!|！|。)?$/i;
const BARE_URL_RE = /^(https?:\/\/)?(www\.)?[\w-]+(\.[\w-]+)*\.(com|net|org|cn|xyz|top|vip|cc|io|me|tv|app)(\/\S*)?$/i;

function isJunkText(text: string): boolean {
  if (LOST_PROOF_RE.test(text)) return true;
  if (APP_GUIDE_RE.test(text)) return true;
  if (SCAN_GUIDE_RE.test(text)) return true;
  const trimmed = text.trim();
  if (CTA_LINE_RE.test(trimmed)) return true;
  if (BARE_URL_RE.test(trimmed)) return true;
  /* 加群引导只认短段：长叙事段里出现「微信群/进群」是正文本身。 */
  if (text.length <= 48 && GROUP_GUIDE_RE.test(text)) return true;
  return false;
}

/** 去重键：抹掉空白与标点后精确比对（近似重复不合并，保守保留）。 */
const dedupeKey = (text: string) => text.replace(/[\s\p{P}\p{S}]+/gu, "");

function filterBlocks(blocks: ArticleBlock[], title?: string): ArticleBlock[] {
  const seen = new Set<string>();
  const titleKey = title ? dedupeKey(title) : "";
  const out: ArticleBlock[] = [];
  for (const b of blocks) {
    if (b.type === "image") { out.push(b); continue; }
    const key = dedupeKey(b.text);
    if (key.length >= 4) {
      if (titleKey && key === titleKey) continue;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    if (isJunkText(b.text)) continue;
    out.push(b);
  }
  return out;
}

/**
 * 从适配器 detail 的 contentHtml 提取内容块。
 * base＝详情页地址（相对图片地址补全基址，与清洗链同口径）；
 * title＝详情标题（正文首行与标题重复时去重用，取自 detail 数据、
 * 不从正文里猜）。
 */
export function extractArticleBlocks(
  html: string,
  opts: { base?: string; title?: string } = {},
): ArticleExtraction {
  if (!html) return { blocks: [], located: false };
  const doc = new DOMParser().parseFromString(html, "text/html");
  let raw = walkBlocks(doc.body, opts.base, true);
  /* 类名排除误包保底：首轮零块时不按类名排除重走，有正文不假空。 */
  if (!raw.length) raw = walkBlocks(doc.body, opts.base, false);
  if (!raw.length) return { blocks: [], located: false };
  return { blocks: filterBlocks(raw, opts.title), located: true };
}
