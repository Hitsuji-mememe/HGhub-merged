import { LOCAL } from "../api/api";
import DOMPurify from "dompurify";
import { isStrictSecurity, setStrictSecurity } from "./securityMode";

export { isStrictSecurity, setStrictSecurity };

/** 站点根地址：正文里的相对路径要补全（原生正文的默认基址；
 * 外部源正文由调用方传详情页 URL 作基址，见 sanitizeHtml 的 base）。 */
const SITE = "https://huangguoai.com";

/** 校验调用方给的正文基址；不可用时回落原生站（原生消费方不传参）。 */
function pageBase(base?: string): string {
  if (base) {
    try {
      const u = new URL(base);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch { /* 落回默认 */ }
  }
  return SITE;
}

/* 正文图真实地址的载体属性（Muse 2026-11-19 fix330/post-images）：
 * 真站正文图普遍不用 src 承真实地址——主题/插件懒加载把地址放在
 * z-image-loader-url（51吃瓜/黑料网内容图，无 src 或相对占位 src）、
 * x-image-loader-url（同主题横幅）、data-image-zoom（黑料网，与 z- 同值）、
 * data-xkrkllgl（每日大赛图片插件固定名）上；解析层 parse.ts 的封面
 * 兜底早已认 z-/x-bg-loader-url，正文清洗链此前不认 → 地址先被
 * DOMPurify 白名单删、幸存的相对占位 src 再被按黄果站补全错源，
 * 3.3.0 真机三源正文图全破。候选顺序：经典懒加载 → loader 载体 →
 * src（src 常是占位，必须垫底）。 */
const IMG_SRC_CANDIDATES = [
  "data-src", "data-original", "data-lazy-src",
  "z-image-loader-url", "x-image-loader-url", "data-image-zoom", "data-xkrkllgl",
  "src",
] as const;

function isInternalWebviewHost(host: string): boolean {
  const h = host.replace(/\.+$/, "").toLowerCase();
  return h === "tauri.localhost" || h === "hg.localhost" || h === "ipc.localhost";
}

function isPrivateOrLocalHost(host: string): boolean {
  const h = host.replace(/\.+$/, "").toLowerCase();
  if (!h || isInternalWebviewHost(h)) return true;
  if (["localhost", "local", "internal", "home.arpa"].some((s) => h === s || h.endsWith(`.${s}`))) {
    return true;
  }
  if (h.startsWith("[") && h.endsWith("]")) {
    const v6 = h.slice(1, -1).toLowerCase();
    if (v6 === "::1" || v6 === "::" || v6.startsWith("fe80:") || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("::ffff:")) {
      return true;
    }
    return false;
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    ) {
      return true;
    }
  }
  return false;
}

/** 把各种写法的图片地址补成绝对地址；占位符（data:）返回空串 */
function abs(raw: string, strict = isStrictSecurity(), base: string = SITE): string {
  const s = (raw || "").trim();
  if (!s) return "";
  try {
    const url = new URL(s, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return "";
    if (isInternalWebviewHost(url.hostname)) return "";
    if (strict && isPrivateOrLocalHost(url.hostname)) return "";
    return url.href;
  } catch { return ""; }
}

/** 正文单图地址解析（Muse 2026-11-19 fix330/post-images 候选链，
 * fix330/reader 起与提取式阅读层共用同一出处）：按候选链取真实地址
 * （懒加载图真实地址常在 data-× 与 loader 载体上、src 只是占位垫底），
 * 过 abs() 的安全门与基址补全，返回走本地协议的最终 src；地址不可
 * 用（占位/非法/被安全门拒绝）返回空串。两条正文路径（整页清洗与
 * 提取重构）共用本函数，图片地址集合恒一致，不许在别处复刻候选链。 */
export function articleImageSrc(img: Element, base?: string, strict = isStrictSecurity()): string {
  let candidate = "";
  for (const attr of IMG_SRC_CANDIDATES) {
    const v = img.getAttribute(attr);
    if (v && v.trim()) { candidate = v; break; }
  }
  let raw = candidate.trim();
  const imgPrefix = `${LOCAL}/img?u=`;
  if (raw.startsWith(imgPrefix)) {
    try { raw = decodeURIComponent(raw.slice(imgPrefix.length)); } catch { raw = ""; }
  }
  const src = abs(raw, strict, pageBase(base));
  return src ? `${imgPrefix}${encodeURIComponent(src)}` : "";
}

/** 把正文里的图片换成走本地协议（带 Referer / 解密能力） */
function proxyImages(html: string, strict = isStrictSecurity(), base: string = SITE): string {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("img").forEach((img) => {
    const proxied = articleImageSrc(img, base, strict);
    if (!proxied) {
      img.remove();
      return;
    }
    img.setAttribute("src", proxied);
    img.removeAttribute("srcset");
    for (const attr of IMG_SRC_CANDIDATES) {
      if (attr !== "src") img.removeAttribute(attr);
    }
    img.removeAttribute("loading");
    img.setAttribute("loading", "lazy");
  });
  // 正文链接补全，避免点开指向本地
  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = (a.getAttribute("href") || "").trim();
    const full = abs(href, strict, base);
    if (full) {
      a.setAttribute("href", full);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    } else a.removeAttribute("href");
  });
  return doc.body.innerHTML;
}

const STRICT_TAGS = [
  "p", "div", "span", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "blockquote", "strong", "b", "em", "i", "u", "s", "del", "pre", "code",
  "a", "img", "figure", "figcaption", "table", "thead", "tbody", "tr", "th", "td",
];
const STRICT_INPUT_ATTR = [
  "href", "src", "alt", "title", "colspan", "rowspan", "start",
  "data-src", "data-original", "data-lazy-src",
  /* 正文图真实地址载体：必须活到 proxyImages 提取，提取后即被移除、
   * 不在 STRICT_FINAL_ATTR 中，不会进入最终输出（fix330/post-images）。 */
  "z-image-loader-url", "x-image-loader-url", "data-image-zoom", "data-xkrkllgl",
];
const STRICT_FINAL_ATTR = [
  "href", "src", "alt", "title", "colspan", "rowspan", "start", "target", "rel", "loading",
];
// 保留 DOMPurify 的安全 URL/普通属性值规则，并允许本应用的 macOS 图片协议。
const SAFE_FINAL_URI = /^(?:(?:https?|ftp|ftps|tel|mailto|callto|sms|cid|xmpp|matrix):|hg:\/\/localhost\/|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

/** 正文只接受所需 HTML 排版，不允许 SVG/MathML、事件、样式和可执行 URL。
 * base＝正文相对地址的补全基址（外部源传详情页 URL）；缺省原生站，
 * 原生消费方（Panels/Posts）不传参、行为不变。 */
export function sanitizeHtml(html: string, base?: string): string {
  // 不支持清洗器的旧 WebView 必须拒绝正文，不能回退为原样渲染。
  if (!html || !DOMPurify.isSupported) return "";
  const baseUrl = pageBase(base);
  if (!isStrictSecurity()) {
    const pre = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ["data-src", "data-original", "data-lazy-src", "z-image-loader-url", "x-image-loader-url", "data-image-zoom", "data-xkrkllgl"],
      ALLOWED_URI_REGEXP: SAFE_FINAL_URI,
    });
    const rewritten = proxyImages(pre, false, baseUrl);
    return DOMPurify.sanitize(rewritten, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ["target", "rel", "loading"],
      ALLOWED_URI_REGEXP: SAFE_FINAL_URI,
    });
  }
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: STRICT_TAGS,
    ALLOWED_ATTR: STRICT_INPUT_ATTR,
    ALLOWED_URI_REGEXP: SAFE_FINAL_URI,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORBID_TAGS: ["svg", "math"],
  });
  const rewritten = proxyImages(clean, true, baseUrl);
  // DOMPurify 作为进入 dangerouslySetInnerHTML 前的最后一步，避免二次解析引入差异。
  return DOMPurify.sanitize(rewritten, {
    ALLOWED_TAGS: STRICT_TAGS,
    ALLOWED_ATTR: STRICT_FINAL_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORBID_TAGS: ["svg", "math"],
    ALLOWED_URI_REGEXP: SAFE_FINAL_URI,
  });
}

/** 拦截正文内链接点击，防止 WebView 原地跳转或弹出无守卫新窗口 */
export function handleArticleClick(
  e: { target: EventTarget | null; preventDefault: () => void; stopPropagation: () => void },
  onOpenUrl?: (url: string) => void,
  base?: string,
): void {
  const el = e.target instanceof Element ? e.target.closest("a") : null;
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  const href = abs(el.getAttribute("href") || "", isStrictSecurity(), pageBase(base));
  if (href && onOpenUrl) onOpenUrl(href);
}
