/**
 * 内置源注册表（Muse 2026-11-19 根治包·多源线 条目2）。
 * 名单已冻结（正式 16 + 探路 5 + myfans 预览），不许增删。
 *
 * 成熟度口径（诚实标注，2026-11-19 真站实测后更新）：
 * - 黄果 stable：仓内既有 native 通道、现行生产源；
 * - 正式源逐源真站实测（每源 ≤3 页：列表+详情+流形态）：列表/详情/流
 *   三段全通的标 stable；只通一段或取流未证的标 probe 并在 note 写卡点；
 *   站点不可达/被墙的标 blocked 并在 note 写证据、enabled=false；
 * - 运行时取页通道（Rust 通用取页命令）由并行线接入，见 adapters/fetchPage.ts；
 * - 探路 5：2026-11-19 探测实测全降级（tools/source-probe/results.md），enabled=false；
 * - myfans preview：仅预览专区单列，不入正式源。
 */
import type { SourceDef } from "./types.ts";

const NO_CAPS = { search: false, episodes: false, hevc: false, comments: false };
const HLS_CAPS = { search: true, episodes: false, hevc: false, comments: false };
const PROBE_NET = { mode: "probe-required" } as const;

export const BUILTIN_SOURCES: SourceDef[] = [
  {
    id: "huangguo", displayName: "黄果", kind: "mixed", category: "posts",
    adapter: { template: "native-huangguo" },
    baseUrls: ["https://huangguoai.com"],
    enabled: true, order: 10, maturity: "stable",
    capabilities: { search: true, episodes: true, hevc: true, comments: true },
    network: { mode: "native" },
    note: "现行生产源：帖子板块 remen-chigua + 视频线路 /api，包既有 api 调用不重写",
  },
  {
    id: "rouvideo", displayName: "肉视频", kind: "video", category: "video",
    adapter: { template: "hls-site", params: { listPath: "/?page={page}", itemLinkPattern: "/video/", detailPath: "/video/{id}" } },
    baseUrls: ["https://rou.video"],
    enabled: true, order: 20, maturity: "probe",
    capabilities: HLS_CAPS, network: PROBE_NET, note: "真站实测（2026-11-19）：入口为 18+ 年龄门页（按钮指向 /home），主 JS 两 chunk 内无数据 API 路径、门页 HTML 无条目；列表须自 /home 起爬、数据接口未定位 → probe",
  },
  {
    id: "91video", displayName: "91视频", kind: "video", category: "video",
    adapter: { template: "hls-site", params: { listPath: "/index.php?page={page}", itemLinkPattern: "/view_video.php", detailPath: "/view_video.php?viewkey={id}" } },
    baseUrls: ["https://91porn.com"],
    enabled: true, order: 21, maturity: "stable",
    capabilities: HLS_CAPS, network: PROBE_NET, note: "真站实测（2026-11-19）：过 18+ 声明页后 index.php 列表解析 24 条、详情页 <source> mp4 直链（ccm.91p52.com）可提取；分页 ?page= 为该站经典参数、未逐页验",
  },
  {
    id: "pornhub", displayName: "Pornhub", kind: "video", category: "video",
    adapter: { template: "hls-site", params: { listPath: "/video?page={page}", itemLinkPattern: "/view_video.php", detailPath: "/view_video.php?viewkey={id}" } },
    baseUrls: ["https://www.pornhub.com"],
    enabled: true, order: 22, maturity: "stable",
    capabilities: HLS_CAPS, network: PROBE_NET, note: "真站实测（2026-11-19）：/video?page=1 列表可解析、详情 mediaDefinitions JSON 含多档 HLS master.m3u8（\\/ 转义形态、解析层已还原复验）；详情页含年龄/登录提示文案但内容与流均免登录可达",
  },
  {
    id: "xvideos", displayName: "XVideos", kind: "video", category: "video",
    adapter: { template: "hls-site", params: { listPath: "/", itemLinkPattern: "/video.", detailPath: "/video.{id}" } },
    baseUrls: ["https://www.xvideos.com"],
    enabled: true, order: 23, maturity: "stable",
    capabilities: HLS_CAPS, network: PROBE_NET, note: "真站实测（2026-11-19）：新版条目 URL 形态 /video.<hash>/slug、首页解析 60 条、详情 setVideoHLS 实测 m3u8（另有 setVideoUrlHigh/Low mp4）；旧列表参数 /?k=&p= 返回 500 已弃；分页路径未验、当前 listPath 只出首页",
  },
  {
    id: "hanime-tv", displayName: "Hanime.tv", kind: "video", category: "video",
    adapter: { template: "hls-site", params: { listPath: "/", itemLinkPattern: "/videos/hentai/", detailPath: "/videos/hentai/{id}" } },
    baseUrls: ["https://hanime.tv"],
    enabled: true, order: 24, maturity: "probe",
    capabilities: HLS_CAPS, network: PROBE_NET, note: "真站实测（2026-11-19）：首页 SSR 解析 68 条（/browse 是品牌/标签索引页、已改走首页）；详情页 SSR 无 m3u8/mp4、流走站内 api/v11 内部接口（页面见 search_hvs/api_base_url 痕迹）未验证 → probe；残留：分页路径与取流接口",
  },
  {
    id: "swag", displayName: "SWAG", kind: "video", category: "video",
    adapter: { template: "hls-site", params: { listPath: "/?page={page}", itemLinkPattern: "/video/", detailPath: "/video/{id}" } },
    baseUrls: ["https://swag.live"],
    enabled: true, order: 25, maturity: "probe",
    capabilities: HLS_CAPS, network: PROBE_NET, note: "真站实测（2026-11-19）：首页与 /video 页 SSR 均无条目锚点（Nuxt 客户端渲染、无 m3u8）、api.swag.live 需登录态；无免登录列表/流证据 → probe",
  },
  {
    id: "fyptt", displayName: "Fyptt", kind: "video", category: "video",
    adapter: { template: "wp-rest", params: { restBase: "/wp-json/wp/v2", listPath: "/posts" } },
    baseUrls: ["https://fyptt.to"],
    enabled: true, order: 26, maturity: "stable",
    capabilities: HLS_CAPS, network: PROBE_NET, note: "真站实测（2026-11-19）：本站为 WP 站、/wp-json/wp/v2/posts 列表与详情实测可达；正文嵌 fypttstr.php 播放器 iframe、其实测含 mp4 直链（stream.fyptt.to、令牌时效内有效）、wp-rest resolve 已支持 iframe 跟进",
  },
  {
    id: "redgifs", displayName: "RedGifs", kind: "video", category: "video",
    adapter: { template: "hls-site", params: { listPath: "/?page={page}", itemLinkPattern: "/watch/", detailPath: "/watch/{id}" } },
    baseUrls: ["https://www.redgifs.com"],
    enabled: true, order: 27, maturity: "probe",
    capabilities: HLS_CAPS, network: PROBE_NET, note: "真站实测（2026-11-19）：官网为 SPA 壳、SSR 无条目；官方 API 实测 /v2/auth/temporary 返回 200 发临时令牌、但 /v2/gifs/search 带令牌仍 401，且 fetchPage 契约不支持 Authorization header——须取页契约支持 header（或令牌注入）后才可接 → probe",
  },
  {
    id: "rule34video", displayName: "Rule34Video", kind: "video", category: "video",
    adapter: { template: "hls-site", params: { listPath: "/latest-updates/{page}/", itemLinkPattern: "/video/", detailPath: "/video/{id}/" } },
    baseUrls: ["https://rule34video.com"],
    enabled: true, order: 28, maturity: "stable",
    capabilities: HLS_CAPS, network: PROBE_NET, note: "真站实测（2026-11-19）：/latest-updates/1/ 解析 23 条、详情 KVS 播放器配置含 360–1080p 多档 mp4 直链（get_file、带 acctoken）、解析层取最高档离线复验通过",
  },
  {
    id: "51chigua", displayName: "51吃瓜网", kind: "post", category: "posts",
    adapter: { template: "chigua", params: { listPath: "/?page={page}", itemLinkPattern: "/archives/", detailPath: "/archives/{id}" } },
    baseUrls: ["https://51chigua.com"],
    enabled: true, order: 30, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "吃瓜模板实例化；未真站实测",
  },
  {
    id: "meiridasai", displayName: "每日大赛", kind: "post", category: "posts",
    adapter: { template: "chigua", params: { listPath: "/?page={page}", itemLinkPattern: "/archives/", detailPath: "/archives/{id}" } },
    baseUrls: ["https://meiridasai.com"],
    enabled: true, order: 31, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "吃瓜模板实例化；未真站实测",
  },
  {
    id: "xiuren", displayName: "秀人网", kind: "image", category: "image",
    adapter: { template: "wp-rest", params: { restBase: "/wp-json/wp/v2", listPath: "/posts" } },
    baseUrls: ["https://xiuren.com"],
    enabled: true, order: 40, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false, comments: false },
    network: PROBE_NET, note: "WP REST 模板实例化；未真站实测",
  },
  {
    id: "pornpics", displayName: "PornPics", kind: "image", category: "image",
    adapter: { template: "hls-site", params: { listPath: "/?page={page}", itemLinkPattern: "/gallery/", detailPath: "/gallery/{id}/" } },
    baseUrls: ["https://www.pornpics.com"],
    enabled: true, order: 41, maturity: "probe",
    capabilities: HLS_CAPS, network: PROBE_NET, note: "通用图集模板实例化；未真站实测",
  },
  {
    id: "cosplaytele", displayName: "CosplayTele", kind: "image", category: "image",
    adapter: { template: "hls-site", params: { listPath: "/page/{page}/", itemLinkPattern: "/cosplay/", detailPath: "/cosplay/{id}/" } },
    baseUrls: ["https://cosplaytele.com"],
    enabled: true, order: 42, maturity: "probe",
    capabilities: HLS_CAPS, network: PROBE_NET, note: "通用图集模板实例化；未真站实测",
  },
  {
    id: "danbooru", displayName: "Danbooru", kind: "image", category: "image",
    adapter: { template: "danbooru-api", params: { listPath: "/posts.json" } },
    baseUrls: ["https://danbooru.donmai.us"],
    enabled: true, order: 43, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false, comments: false },
    network: PROBE_NET, note: "公开 API 实例化；未真站实测",
  },
  /* ── 探路 5：2026-11-19 探测全降级，enabled=false、不写适配器 ── */
  {
    id: "jabletv", displayName: "JableTV", kind: "video", category: "video",
    adapter: { template: "none" }, baseUrls: ["https://jable.tv"],
    enabled: false, order: 50, maturity: "probe", capabilities: NO_CAPS, network: PROBE_NET,
    note: "探路降级：代理出口 Cloudflare 403 challenge（tools/source-probe/results.md）",
  },
  {
    id: "missav", displayName: "MissAV", kind: "video", category: "video",
    adapter: { template: "none" }, baseUrls: ["https://missav.ws"],
    enabled: false, order: 51, maturity: "probe", capabilities: NO_CAPS, network: PROBE_NET,
    note: "探路降级：代理出口 Cloudflare 403 / 连接中断（tools/source-probe/results.md）",
  },
  {
    id: "tikporn", displayName: "Tik.porn", kind: "video", category: "video",
    adapter: { template: "none" }, baseUrls: ["https://tik.porn"],
    enabled: false, order: 52, maturity: "probe", capabilities: NO_CAPS, network: PROBE_NET,
    note: "探路降级：代理出口 Cloudflare 403 Attention Required（tools/source-probe/results.md）",
  },
  {
    id: "hanime1", displayName: "Hanime1", kind: "video", category: "video",
    adapter: { template: "none", params: {} }, baseUrls: ["https://hanime1.me"],
    enabled: false, order: 53, maturity: "probe", capabilities: NO_CAPS,
    network: { mode: "probe-required", needsNonJpExit: true },
    note: "探路降级：封日本 IP 之外，代理（非日本）出口同样被 Cloudflare 403 拦截（tools/source-probe/results.md）",
  },
  {
    id: "iwara", displayName: "Iwara", kind: "video", category: "video",
    adapter: { template: "none" }, baseUrls: ["https://www.iwara.tv"],
    enabled: false, order: 54, maturity: "probe", capabilities: NO_CAPS, network: PROBE_NET,
    note: "探路降级：代理出口 Cloudflare 403 / 传输中断（tools/source-probe/results.md）",
  },
  /* ── 预览专区（单列，不入正式源） ── */
  {
    id: "myfans", displayName: "myfans（仅预览）", kind: "mixed", category: "preview",
    adapter: { template: "preview-only" },
    baseUrls: ["https://myfans.jp"],
    enabled: true, order: 90, maturity: "preview",
    capabilities: NO_CAPS, network: PROBE_NET,
    note: "仅公开预览、完整内容回原站付费；条目一律标注「仅预览」",
  },
];

export function getBuiltinRegistry(): SourceDef[] {
  return [...BUILTIN_SOURCES].sort((a, b) => a.order - b.order);
}

export function sourcesForCategory(category: SourceDef["category"], list: SourceDef[] = getBuiltinRegistry()): SourceDef[] {
  return list.filter((s) => s.category === category && s.enabled);
}

export function firstEnabledSource(category: SourceDef["category"], list?: SourceDef[]): SourceDef | null {
  return sourcesForCategory(category, list)[0] ?? null;
}
