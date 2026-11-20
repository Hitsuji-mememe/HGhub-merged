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
 * - 3.3.2（reader-filter2）补真机漏杀形态，判据全为结构特征、
 *   不引用任何真实站名/域名（形态普查＝三源各抽 3 帖，见证据报告）：
 *   ⑦SEO 关键词墙——整段由空格分隔的短词元堆砌、无句读（详见
 *   isKeywordWall），含 <br> 分行的行组形态（成组判读）与 # 标签
 *   墙变体（isHashtagWall）；⑧地址发布块——带标签的 URL/邮箱行
 *   组，成组杀伤（连续短行成组＋组内联系点/标签占比），及整块合
 *   并形态的单段判读（isAddressPublishBlock）；附带「播放异常→用
 *   官方 App」式 CTA 的窄判据（isPlaybackAppCta）；⑨头部模板块
 *   ——同源跨帖雷同的整块站务模板按块处理（详见
 *   headTemplateIndices，边界＝第一个正文段）；⑩超短行行组（分类导航名单，
 *   groupJunkIndices 内）；站务残行整行判据（isBoilerplateLine）。
 * - 3.3.3（reader3）补 3.3.2 真机验收两帖漏杀形态，判据仍全为结构
 *   形态（证据 fix333/evidence/reader3.md）：⑪编号问答块——模板小
 *   节头＋Qn/An 编号交替 ≥2 对整组杀（无编号访谈问答、单对问答为
 *   反例）；⑫尾部模板区——正文之后出现模板小节头（热门吃瓜/重磅
 *   热瓜/温馨提示/重要提示等栏目名）且其后无叙事续段、且有旁证行
 *   时，自小节头起文本块整区杀（图片保留；中段提示＋叙事续段为
 *   反例）；⑬显式标签关键词墙（「关键词：」＋词墙廓形，阈值较
 *   ⑦宽——显式标签本身即元数据证据）；⑭下载 CTA 短行（「点击」
 *   起头＋下载/安装＋全行无句读的整行句式）。容器层同批补：标签
 *   簇容器（tags/keywords 段＋itemprop="keywords"，两源同构）与
 *   公告选项卡容器（content-tabs 整 token）整棵排除。
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
  /* reader3：标签簇容器段——两源同构的 <div class="tags"><div
   * class="keywords" itemprop="keywords"> 锚点簇（004 形态为
   * article-tags>tags），渲染成无空格关键词拼接行挂在正文尾部；
   * 段精确匹配只命中类名里独立成段的 tags/keywords，正文容器类名
   * 无此二段。 */
  "tags", "keywords",
]);

/* 整 token 命中的垃圾容器类名（不切段）：公告选项卡——005 尾部整
 * 块模板（重磅热瓜/温馨提示/官方网址/福利导航）所在的主题组件
 * 容器，两源页面均有此组件（reader3 普查）。切段匹配会把
 * content/tabs 误扩到无关容器，故只认整 token。 */
const JUNK_CLASS_TOKENS = new Set(["content-tabs"]);

const JUNK_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search"]);

function isJunkContainer(el: Element): boolean {
  const role = el.getAttribute("role");
  if (role && JUNK_ROLES.has(role.toLowerCase())) return true;
  /* SEO 关键词簇的语义标记（reader3）：itemprop="keywords" 的元素
   * 按定义即关键词元数据，不是正文。 */
  if ((el.getAttribute("itemprop") ?? "").toLowerCase() === "keywords") return true;
  const names = `${el.getAttribute("class") ?? ""} ${el.id ?? ""}`.toLowerCase();
  for (const token of names.split(/\s+/)) {
    if (JUNK_CLASS_TOKENS.has(token)) return true;
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

/* ── 3.3.2 新增判据的公共结构特征（reader-filter2） ── */

/* 句读计数：中文句末标点恒计；英文句末标点只计「后随空白/行尾」的
 * （域名、小数里的 "." 后随字母数字，不计）。 */
function sentencePunctCount(text: string): number {
  return (text.match(/[。！？；]/g)?.length ?? 0) + (text.match(/[.!?;](?=\s|$)/g)?.length ?? 0);
}
function commaCount(text: string): number {
  return (text.match(/[，、]/g)?.length ?? 0) + (text.match(/,(?=\s)/g)?.length ?? 0);
}

interface TokenProfile { tokens: string[]; avg: number; max: number }
function tokenProfile(text: string): TokenProfile {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const total = tokens.reduce((n, t) => n + t.length, 0);
  return {
    tokens,
    avg: tokens.length ? total / tokens.length : 0,
    max: tokens.reduce((m, t) => Math.max(m, t.length), 0),
  };
}

/* 词元墙廓形：≥minTokens 个空格分隔词元、平均长 ≤6、最长 ≤12、
 * 全段零句读、逗号至多 1 个。 */
function isTokenWallShape(text: string, minTokens: number): boolean {
  if (sentencePunctCount(text) > 0 || commaCount(text) > 1) return false;
  const p = tokenProfile(text);
  return p.tokens.length >= minTokens && p.avg <= 6 && p.max <= 12;
}

/* ⑦ SEO 关键词墙（整段形态）：一整段关键词堆砌——词元分隔密度高
 * （≥10 个词元、平均长 ≤6）、句读缺失（零句末标点、逗号至多 1）、
 * 总长 ≥40。误伤分析：中文叙事不以空格分词，整段恒为个位数词元、
 * 且带句读，两道条件独立挡之；英文正文句末标点计入句读同样挡之。
 * 已知残余：无句读的英文词表/名单行可能误伤（多为附属内容）；与
 * 正文同段混排、或以顿号/逗号分隔的词墙漏杀——只漏不误，不为凑
 * 全杀放宽阈值（报告残余项）。 */
function isKeywordWall(text: string): boolean {
  return text.length >= 40 && isTokenWallShape(text, 10);
}

/* 联系点：完整 URL、裸域名（TLD 白名单与 BARE_URL_RE 同口径并补
 * 常见引流后缀）、邮箱。计数前先摘邮箱，避免邮箱域名被重复计。 */
const CONTACT_URL_RE = /https?:\/\/[^\s]+|[\w-]+(\.[\w-]+)*\.(com|net|org|cn|xyz|top|vip|cc|io|me|tv|app|info|site|online|club|pro|icu|live|one)([/:?#][^\s]*)?/gi;
const CONTACT_EMAIL_RE = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
function contactCount(text: string): number {
  const emails = text.match(CONTACT_EMAIL_RE) ?? [];
  const rest = text.replace(CONTACT_EMAIL_RE, " ");
  return emails.length + (rest.match(CONTACT_URL_RE)?.length ?? 0);
}

/* 地址发布标签词表（发布口径的栏目词，非任何站名）：用于「标签：」
 * 计数与行首标签判定。 */
const PUBLISH_LABELS = "国内|海外|永久|邮箱|邮件|地址|发布页|发布|官网|主页|备用|最新|大陆|app";
const LABEL_COLON_RE = new RegExp(`(${PUBLISH_LABELS})\\s*[：:]`, "gi");
/* 行首标签只认前缀本身（「国内地址 https://…」式标签与值同行、标签
 * 后不跟冒号）；单独命中不杀，只作成组/成块判读的标签证据。 */
const LABEL_START_RE = new RegExp(`^(${PUBLISH_LABELS})`, "i");
function labelColonCount(text: string): number {
  return text.match(LABEL_COLON_RE)?.length ?? 0;
}
/* 行首标签：容忍行首 emoji/符号/空白前缀（发布行恒带此类装饰）。 */
function hasPublishLabelStart(text: string): boolean {
  return LABEL_START_RE.test(text.replace(/^[\s\p{P}\p{S}]+/u, ""));
}

/* ⑧ 地址发布块（单块形态）：发布行组被源站写进同一段、提取时空白
 * 折叠成一整块——≥2 个联系点＋≥2 处「标签：」＋无句末标点（。；！；
 * CTA 行的「？」不在排除内）。带完整句子的科普/导航段恒有句号、
 * 且无「标签：」连发，两道条件独立挡之（夹具反例钉死）。 */
function isAddressPublishBlock(text: string): boolean {
  if (/[。；！]/.test(text)) return false;
  return contactCount(text) >= 2 && labelColonCount(text) >= 2;
}

/* 「播放异常？刷新或使用 XX APP」式 CTA：播放故障词＋处置动词＋
 * app 三件同现于 ≤60 字短行才杀。纯叙事吐槽（抱怨某 app 老是播放
 * 失败）无处置动词、不杀（夹具反例钉死）。 */
const PLAYBACK_FAIL_RE = /播放异常|无法播放|播放失败/;
const PLAYBACK_CTA_VERB_RE = /刷新|使用|请用|改用|换用|下载|安装/;
function isPlaybackAppCta(text: string): boolean {
  return text.length <= 60 && PLAYBACK_FAIL_RE.test(text)
    && PLAYBACK_CTA_VERB_RE.test(text) && /app/i.test(text);
}

/* 标签墙：以 # 分隔的标签堆砌行（「关键词：#甲 #乙 …」形态）——
 * # 记号 ≥5 个、无句末标点、标签文字占全行 ≥40%。正文引用一两个
 * 话题标签不会成墙；带完整句子的段落有句号、独立挡之。 */
function isHashtagWall(text: string): boolean {
  if ((text.match(/#/g)?.length ?? 0) < 5) return false;
  if (/[。！？]/.test(text)) return false;
  const tagChars = (text.match(/#[^#\s]+/g) ?? []).reduce((n, t) => n + t.length, 0);
  return tagChars >= text.length * 0.4;
}

/* 站务残行（普查实证的整行形态，均为模板原句、无叙事价值）：
 * 播放器占位文本、浏览器推荐行、版权声明、最后编辑于、官方公告行、
 * 分享提示/分享控件残字。判据都锚定整行或行首，长叙事不命中。 */
const PLAYER_PLACEHOLDER_RE = /^播放器加载中[.。…·\s]*$/;
const BROWSER_TIP_RE = /推荐[^\s，。；]{0,32}浏览器/;
const COPYRIGHT_RE = /^版权声明\s*[:：]/;
const EDIT_DATE_RE = /^最后编辑于\s*[:：]/;
const SHARE_TIP_RE = /复制(最新)?(网址|链接)[^\s，。；]{0,10}浏览器打开/;
const SHARE_UI_RE = /点击复制文章链接|复制成功[，,].{0,6}发给/;
function isBoilerplateLine(text: string): boolean {
  const t = text.trim();
  if (PLAYER_PLACEHOLDER_RE.test(t)) return true;
  if (COPYRIGHT_RE.test(t) || EDIT_DATE_RE.test(t)) return true;
  if (/^官方公告/.test(t)) return true;
  if (/谨防假冒/.test(t) && /(收藏|官方地址)/.test(t)) return true;
  if (SHARE_TIP_RE.test(t) || SHARE_UI_RE.test(t)) return true;
  if (t.length <= 48 && BROWSER_TIP_RE.test(t)) return true;
  return false;
}

/* ── 3.3.3 新增判据（reader3，证据 fix333/evidence/reader3.md） ── */

/* ⑬ 显式标签关键词墙：「关键词：/标签：」起头＋词墙廓形。显式标
 * 签本身即元数据证据，故词元阈值较 ⑦ 宽（≥5 词元、平均 ≤8、最
 * 长 ≤14，容 004 实测的长复合词）；但仍要求余下部分零句读、逗号
 * 至多 1——带句读的同名起头句是叙述（「关键词：效率。他用整整一
 * 个下午……」），由句读条件独立挡之（夹具反例钉死）。 */
const KEYWORD_LABEL_RE = /^(关键词|关键字|标签)\s*[:：]\s*/;
function isLabeledKeywordWall(text: string): boolean {
  const t = text.trim();
  const m = KEYWORD_LABEL_RE.exec(t);
  if (!m) return false;
  const rest = t.slice(m[0].length);
  if (sentencePunctCount(rest) > 0 || commaCount(rest) > 1) return false;
  const p = tokenProfile(rest);
  return p.tokens.length >= 5 && p.avg <= 8 && p.max <= 14;
}

/* ⑭ 下载 CTA 短行句式：「点击」起头、含下载/安装、全行（除至多
 * 一个尾随终止符）无任何句读逗号、总长 ≤40——整行就是一句按钮
 * 文案（005 实测「点击可下载完整版视频！」）。叙事句以「点击」
 * 起头时恒带逗号/句号展开后续（「点击了下载按钮，他发现……」），
 * 由无句读条件独立挡之（夹具反例钉死）；裸「点击下载」由
 * CTA_LINE_RE 既有覆盖，本条补带宾语的形态。 */
function isDownloadCtaLine(text: string): boolean {
  const t = text.trim();
  if (t.length > 40 || !/^点击/.test(t) || !/(下载|安装)/.test(t)) return false;
  const core = t.replace(/[!！。]$/, "");
  return !/[，。；、！？!?；]/.test(core);
}

/* ⑪ 编号问答块：Qn：/An：编号严格递增、问答交替、≥2 对成块——
 * 站点 SEO 问答模板的固定句法（003 两帖实测，问句复述帖名、答句
 * 复述正文，无独立信息）。无编号的访谈问答（Q：/A：）是正文体
 * 裁、单对编号问答（测验/互动）不成模板，两者均为反例（夹具钉
 * 死）。块首若紧贴 FAQ 类小节头（常见问题解答/常见疑问解答/问题
 * 解答/FAQ，≤16 字）连带杀——小节头本身是模板栏目名，非叙事。 */
const FAQ_Q_RE = /^Q\s*(\d+)\s*[:：]/i;
const FAQ_A_RE = /^A\s*(\d+)\s*[:：]/i;
const FAQ_HEADING_RE = /常见(问题|疑问)解答|问题解答|FAQ/i;
function faqIndices(blocks: ArticleBlock[]): Set<number> {
  const kill = new Set<number>();
  let i = 0;
  while (i < blocks.length) {
    const head = blocks[i];
    const qm = head.type === "text" ? FAQ_Q_RE.exec(head.text.trim()) : null;
    if (!qm) { i++; continue; }
    let expect = Number(qm[1]);
    let pairs = 0;
    let j = i;
    const run: number[] = [];
    for (;;) {
      const bq = blocks[j];
      const mq = bq && bq.type === "text" ? FAQ_Q_RE.exec(bq.text.trim()) : null;
      if (!mq || Number(mq[1]) !== expect) break;
      const ba = blocks[j + 1];
      const ma = ba && ba.type === "text" ? FAQ_A_RE.exec(ba.text.trim()) : null;
      if (!ma || Number(ma[1]) !== expect) break;
      run.push(j, j + 1);
      pairs++;
      expect++;
      j += 2;
    }
    if (pairs >= 2) {
      run.forEach((k) => kill.add(k));
      const prev = blocks[i - 1];
      if (prev && prev.type === "text" && prev.text.trim().length <= 16
        && FAQ_HEADING_RE.test(prev.text)) kill.add(i - 1);
      i = j;
    } else i++;
  }
  return kill;
}

/* ⑫ 尾部模板区：站点在正文之后追加的固定栏目区（小节头＋他帖推
 * 广标题/CTA/官方网址/导航行成片出现，003/004/005 三源实测同构）。
 * 触发＝文本块剥掉首尾装饰（emoji/符号/空白）后恰为模板栏目名、
 * 原文 ≤14 字。守门三道：(a) 触发点之前已有正文段；(b) 触发点及
 * 之后无叙事续段（≥50 字且带 ≥2 句读或 ≥1 逗号——作者中段写
 * 「温馨提示」小节、其后成段续写正文的形态由此整区保留，夹具反
 * 例钉死；004 实测的跨帖推广长句只有空格分词＋单个尾随叹号，不
 * 构成叙事续段）；(c) 区内除触发行外至少一行旁证（另一栏目名/
 * 模板信号/已判垃圾/联系点/推广长句廓形）。只杀文本块，图片保
 * 留（区尾图片归属不明时只漏不误）。 */
const TAIL_SECTION_LABELS = new Set([
  "热门吃瓜", "重磅热瓜", "温馨提示", "重要提示", "官方公告",
  "相关推荐", "猜你喜欢", "热门推荐", "精彩推荐",
]);
function stripDecor(s: string): string {
  return s.replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "");
}
function isTailSectionTrigger(b: ArticleBlock): boolean {
  if (b.type !== "text") return false;
  const t = b.text.trim();
  return t.length <= 14 && TAIL_SECTION_LABELS.has(stripDecor(t));
}
function isNarrativeContinuation(text: string): boolean {
  if (text.length < 50 || isJunkText(text)) return false;
  return sentencePunctCount(text) >= 2 || commaCount(text) >= 1;
}
/* 推广长句廓形（仅作尾部区旁证，不单独杀）：≥40 字、≥8 个空格分
 * 词、平均 ≤9、逗号为零、句读至多 1——标题短语串烧的名单句法，
 * 与带逗号展开的叙事句异形。 */
function isPromoBlurbShape(text: string): boolean {
  if (text.length < 40 || commaCount(text) > 0 || sentencePunctCount(text) > 1) return false;
  const p = tokenProfile(text);
  return p.tokens.length >= 8 && p.avg <= 9 && p.max <= 14;
}
function tailTemplateIndices(blocks: ArticleBlock[]): Set<number> {
  const kill = new Set<number>();
  let start = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (isTailSectionTrigger(blocks[i])) { start = i; break; }
  }
  if (start < 0) return kill;
  const hasBodyBefore = blocks.slice(0, start)
    .some((b) => b.type === "text" && isBodyLike(b.text));
  if (!hasBodyBefore) return kill;
  let corroborated = false;
  for (let i = start; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type !== "text") continue;
    if (isNarrativeContinuation(b.text)) return kill;
    if (i > start && (isTailSectionTrigger(b) || isTemplateSignal(b.text)
      || isJunkText(b.text) || contactCount(b.text) > 0 || isPromoBlurbShape(b.text))) {
      corroborated = true;
    }
  }
  if (!corroborated) return kill;
  for (let i = start; i < blocks.length; i++) {
    if (blocks[i].type === "text") kill.add(i);
  }
  return kill;
}

/* 地址发布行廓形（成组判读的成员资格）：短行（≤80 字）且带联系
 * 点/行首标签/播放 CTA/整段 CTA 之一。成员资格本身不杀，杀伤由
 * 组级占比决定。 */
function isPublishLine(text: string): boolean {
  if (text.length > 80) return false;
  return contactCount(text) > 0 || hasPublishLabelStart(text)
    || isPlaybackAppCta(text) || CTA_LINE_RE.test(text.trim());
}

/* 连续文本块上按成员资格切行组（图片块与非成员块打断连续性）。 */
function consecutiveRuns(blocks: ArticleBlock[], member: (text: string) => boolean): number[][] {
  const runs: number[][] = [];
  let cur: number[] = [];
  const close = () => { if (cur.length) runs.push(cur); cur = []; };
  blocks.forEach((b, i) => {
    if (b.type === "text" && member(b.text)) cur.push(i);
    else close();
  });
  close();
  return runs;
}

/* 正文段廓形：第一个「正文段」是头部模板块的右边界——够长、有
 * 句读、且本身不是已判垃圾段。列表体帖子的短行正文不算正文段，
 * 故头部判读只覆盖「模板在前、叙事在后」的实证形态。 */
function isBodyLike(text: string): boolean {
  return text.length >= 50 && sentencePunctCount(text) >= 1 && !isJunkText(text);
}

/* 模板信号：已判垃圾段、发布行、带「标签：」、以冒号结尾的标签行
 * （值在下一行）、站务提示词行——任一成立即为模板块的信号行。 */
const BOILERPLATE_SIGNAL_RE = /最新地址|永久地址|海外地址|国内地址|备用地址|官方公告|温馨提示|重要提示|推荐浏览器/;
function isTemplateSignal(text: string): boolean {
  return isJunkText(text) || isPublishLine(text) || labelColonCount(text) > 0
    || /[：:]\s*$/.test(text.trim()) || BOILERPLATE_SIGNAL_RE.test(text);
}
/* 模板块成员：词墙任意长；其余须 ≤80 字且（是信号行或 ≤40 字的
 * 短填充行——模板里的纯值行/提示行靠填充资格入组）。 */
function isTemplateish(text: string): boolean {
  if (isKeywordWall(text)) return true;
  if (text.length > 80) return false;
  return isTemplateSignal(text) || text.length <= 40;
}

/* ⑨ 头部模板块（独立一类，按块处理）：三源普查实证——站点给每篇
 * 帖头部预置整块站务模板（地址发布＋关键词墙＋站务话术成块），同
 * 源各帖逐字雷同，但逐帖内部形态不一（标签与值同行／交替分行／
 * 前置图片带与词墙），逐段规则必然漏行（值行被裸域名规则杀后只
 * 剩孤儿标签行组即其残形）。判读：只扫第一个正文段之前的区域，
 * 找连续的模板成员行组——≥4 行成组、组内 ≥2 行带联系点、≥3 行
 * 为信号行 → 从首个信号行到末个信号行整段杀（信号间的填充行连
 * 带，组外缘的纯填充行如元信息行保留）。与正文的边界＝第一个
 * 正文段（isBodyLike）；正文段之后一律不扫（尾部模板只靠逐行规
 * 则，残余如实记录——列表体正文与尾部模板同为短行区，全域成组
 * 判读会误吞列表体正文，普查中已实证此险，不做）。 */
function headTemplateIndices(blocks: ArticleBlock[]): Set<number> {
  const kill = new Set<number>();
  let regionEnd = blocks.length;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "text" && isBodyLike(b.text)) { regionEnd = i; break; }
  }
  const region = blocks.slice(0, regionEnd);
  for (const run of consecutiveRuns(region, isTemplateish)) {
    if (run.length < 4) continue;
    const texts = run.map((i) => (region[i] as { text: string }).text);
    if (texts.filter((t) => contactCount(t) > 0).length < 2) continue;
    const sig = run.filter((_, k) => isTemplateSignal(texts[k]) || isKeywordWall(texts[k]));
    if (sig.length < 3) continue;
    for (let i = sig[0]; i <= sig[sig.length - 1]; i++) {
      if (region[i].type === "text") kill.add(i);
    }
  }
  return kill;
}

/* ⑩ 超短行行组（分类导航/栏目名单形态）：≥10 行连续、每行 ≤6
 * 字、无句读无联系点、非标题块 → 整组杀。阈值取 ≥10 是为与八行
 * 律诗、福利清单等短行正文拉开距离；带标点的短行组（对白、诗
 * 行）与标题行组（章节目录）由句读/标题资格独立挡之（夹具反例
 * 钉死）。单行/短组超短行（栏目名单残行等）只漏不误。 */
function isUltraShortLine(b: ArticleBlock): boolean {
  if (b.type !== "text" || b.heading) return false;
  const t = b.text.trim();
  return t.length <= 6 && sentencePunctCount(t) === 0 && contactCount(t) === 0;
}

/* 成组判读（⑧ 行组形态＋⑦ 分行形态＋⑨ 头部模板块＋⑩ 超短行
 * 行组），返回要杀的块下标：
 * - 地址发布行组：≥3 行成组、组内 ≥2 行带联系点、≥1 行带行首标签
 *   → 整组杀（逐行判会漏掉无联系点的 CTA 行、且单行「标签＋URL」
 *   不命中任何既有整行规则）。人物对白式短句连排无联系点无标签，
 *   不成组（夹具反例钉死）。
 * - 词墙行组：≥2 行同为词元墙廓形（每行 ≥5 词元）、全组合计 ≥12
 *   词元 → 整组杀（<br> 分行的词墙，每行单独都不满整段门槛）。
 * 行组被图片块隔开的形态不在覆盖内（残余漏杀，报告标注）。 */
function groupJunkIndices(blocks: ArticleBlock[]): Set<number> {
  const kill = new Set<number>();
  for (const run of consecutiveRuns(blocks, isPublishLine)) {
    if (run.length < 3) continue;
    const texts = run.map((i) => (blocks[i] as { text: string }).text);
    if (texts.filter((t) => contactCount(t) > 0).length >= 2
      && texts.some((t) => hasPublishLabelStart(t))) {
      run.forEach((i) => kill.add(i));
    }
  }
  for (const run of consecutiveRuns(blocks, (t) => isTokenWallShape(t, 5))) {
    if (run.length < 2) continue;
    const total = run.reduce((n, i) => n + tokenProfile((blocks[i] as { text: string }).text).tokens.length, 0);
    if (total >= 12) run.forEach((i) => kill.add(i));
  }
  headTemplateIndices(blocks).forEach((i) => kill.add(i));
  /* ⑪ 编号问答块、⑫ 尾部模板区（reader3）：各自带守门，命中即整
   * 组/整区并入杀集。 */
  faqIndices(blocks).forEach((i) => kill.add(i));
  tailTemplateIndices(blocks).forEach((i) => kill.add(i));
  /* ⑩ 的行组按块（非文本）资格切分，单独走一遍块序列。 */
  let cur: number[] = [];
  const closeRun = () => {
    if (cur.length >= 10) cur.forEach((i) => kill.add(i));
    cur = [];
  };
  blocks.forEach((b, i) => { if (isUltraShortLine(b)) cur.push(i); else closeRun(); });
  closeRun();
  return kill;
}

function isJunkText(text: string): boolean {
  if (LOST_PROOF_RE.test(text)) return true;
  if (APP_GUIDE_RE.test(text)) return true;
  if (SCAN_GUIDE_RE.test(text)) return true;
  if (isPlaybackAppCta(text)) return true;
  if (isKeywordWall(text)) return true;
  if (isHashtagWall(text)) return true;
  if (isBoilerplateLine(text)) return true;
  if (isAddressPublishBlock(text)) return true;
  if (isLabeledKeywordWall(text)) return true;
  if (isDownloadCtaLine(text)) return true;
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
  /* 成组判读先行标杀（地址发布行组/词墙行组），再走逐段判读与去重。 */
  const groupJunk = groupJunkIndices(blocks);
  const seen = new Set<string>();
  const titleKey = title ? dedupeKey(title) : "";
  const out: ArticleBlock[] = [];
  blocks.forEach((b, i) => {
    if (groupJunk.has(i)) return;
    if (b.type === "image") { out.push(b); return; }
    const key = dedupeKey(b.text);
    if (key.length >= 4) {
      if (titleKey && key === titleKey) return;
      if (seen.has(key)) return;
      seen.add(key);
    }
    if (isJunkText(b.text)) return;
    out.push(b);
  });
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
