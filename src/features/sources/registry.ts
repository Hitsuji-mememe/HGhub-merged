/**
 * 内置源注册表（Muse 2026-11-19 根治包·多源线 条目2；2026-11-19
 * 用户新口径修订：保留＋全目录导入）。
 *
 * 构成：命名源 24（正式 16 + 探路 5 + myfans 预览 + FC2 用户点名
 * ＋黑料网 fix321-F2b 自目录导入毕业）＋目录导入源（catalog.ts，
 * Hentai-Park 目录机械导入、单独成文）。
 *
 * 成熟度口径（诚实标注，2026-11-19 真站实测后更新）：
 * - 黄果 stable：仓内既有 native 通道、现行生产源；
 * - 正式源逐源真站实测（每源 ≤3 页：列表+详情+流形态）：列表/详情/流
 *   三段全通的标 stable；只通一段或取流未证的标 probe 并在 note 写卡点；
 *   站点不可达/被墙的标 blocked 并在 note 写证据；
 * - blocked 保留口径（用户 2026-11-19 定）：blocked 源 enabled=true
 *   保留在切换列表可见、标「暂不可用」，点开为诚实提示页、不拉数据、
 *   不假数据；远程清单仍可 enabled=false 整体下线（熔断位不变）；
 * - 运行时取页通道（Rust 通用取页命令）已接入，见 adapters/fetchPage.ts；
 * - 探路 5：2026-11-19 探测实测全降级（tools/source-probe/results.md），enabled=false、不在列表；
 * - myfans preview：仅预览专区单列，不入正式源。
 */
import type { SourceDef } from "./types.ts";
import { CATALOG_SOURCES } from "./catalog.ts";

const NO_CAPS = { search: false, episodes: false, hevc: false, comments: false };
const HLS_CAPS = { search: true, episodes: false, hevc: false, comments: false };
const PROBE_NET = { mode: "probe-required" } as const;

export const NAMED_SOURCES: SourceDef[] = [
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
    adapter: { template: "hls-site", params: { listPath: "/home", itemLinkPattern: "/v/", detailPath: "/v/{id}", streamUrlTemplate: "/api/hls/{id}" } },
    baseUrls: ["https://rou.video"],
    enabled: true, order: 20, maturity: "probe",
    capabilities: HLS_CAPS, network: PROBE_NET, note: "真站复核（2026-11-19 fix321-F2，本机出口参考）：根路径为 18+ 年龄门无条目、列表在 /home、条目锚点为 /v/<id>（卡片含 img 与标题文本），模板已按真站校准（旧 /?page= + /video/ 与真站结构完全不符、恒解析为空）、真站结构夹具解析出条目；详情页 SSR 无流地址（<video> 无 src、走站内 API 未定位）→ 列表已通、取流未证，仍 probe。fix321-F2b 取流校准：站内流端点已定位——GET /api/v/<id> 详情 API 与 /api/hls/<id> 站内 HLS 代理端点（Hentai-Park rouvideo 插件 videos() 与真站前端 chunk 双证据），resolve 改走 streamUrlTemplate 拼 /api/hls/<id>、不回详情页找 m3u8；住宅出口四级验收全通（source-verify-20261119），App 侧未真机验 → 代码就绪未验证、仍 probe",
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
    capabilities: HLS_CAPS, network: PROBE_NET, note: "真站实测（2026-11-19）：首页 SSR 解析 68 条（/browse 是品牌/标签索引页、已改走首页）；详情页 SSR 无 m3u8/mp4、流走站内 api/v11 内部接口（页面见 search_hvs/api_base_url 痕迹）未验证 → probe；残留：分页路径与取流接口。fix321-F2 本机复核（本机出口参考）：首页锚点 /videos/hentai/<slug> 与现模板一致、真站结构夹具解析出条目，列表结构无问题；真机取页失败在本机出口未复现（本机 200），属出口/取页层差异、非解析问题。fix321-F2b 取流深查：取流链结构已定位（Hentai-Park hanime 插件证据）——guest API（guest.freeanimehentai.net/api/v11）＋播放器 handshake：先取 ct.hanime.tv CSRF 令牌，再以 AES-256-GCM 加密信封 POST auth.hanime.tv/api/v11/handshake（x-signature 签名头），响应经 x-token 头回加密信封解密得 /hls/<画质>/ 流表；本仓取页契约仅 GET 且 Origin/签名头不在放行列 → 结构已明、通道不通，本批不接；住宅出口验收首页/列表通、第 4 级未确认到播放源（未确认，不排除验收手段局限）→ 维持 probe",
  },
  {
    id: "swag", displayName: "SWAG", kind: "video", category: "video",
    adapter: { template: "swag-api", params: {} },
    baseUrls: ["https://swag.live", "https://api.swag.live"],
    enabled: true, order: 25, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "fix321-F2b 校准（推翻旧定性）：旧 note「API 须带登录会话、无免登录通道」系机房出口结论，已被住宅出口四级验收全通（source-verify-20261119）＋本机出口实测推翻——免登录数据通道已定位并接通：api.swag.live/feeds/shorts_curated（302 跳规范 feed 后 200、JSON 数组）＋逐条 /messages/<id> 补标题/封面（metadata.thumbnail_url 挂 public.swag.live），只收免费短视频（sfw=false/type=short/unlockPrice=0），结构据 Hentai-Park swag_shortvideo 插件、本机实测互证，夹具解析出条目；流为 AES-128 加密 HLS（清单 key URI 为 mock.url 占位、真钥须带 X-Client-ID/X-Session-ID 会话头向 API 换取并重写清单）超本仓播放栈 → resolve 诚实为空、取流未证；App 侧未真机验 → 代码就绪未验证、仍 probe。fix321-F2 旧复核（SSR 无条目锚点、解析为空落显式失败态）仍成立于 HTML 通道、与 API 通道并存记录",
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
    adapter: { template: "redgifs-api", params: {} },
    baseUrls: ["https://www.redgifs.com", "https://api.redgifs.com"],
    enabled: true, order: 27, maturity: "probe",
    capabilities: HLS_CAPS, network: PROBE_NET, note: "fix321-F2b 校准：官方 API 令牌链已接通——GET api.redgifs.com/v2/auth/temporary 取匿名临时令牌（本机实测 200 发令牌）→ Bearer 调 /v2/gifs/search（列表）与 /v2/gifs/<id>（详情/流，urls.hd 优先 mp4），结构据 Hentai-Park redgifs 插件、夹具解析出条目与流；取页契约卡点已解：Rust source_fetch 对 Authorization 改为仅 api.redgifs.com origin 定向放行（匿名临时令牌、非用户凭据；其余 origin 仍丢弃，见 src-tauri/src/api/source.rs）。残留：本机出口带令牌调 search 仍 401，响应体明示 WrongSender（令牌与签发方绑定、本机代理出口 IP 轮换使签发与调用不同源）——App 内签发与调用同出口不触发此限；住宅出口四级验收全通（source-verify-20261119）证明站与令牌链在住宅网络成立；App 侧未真机验 → 代码就绪未验证、仍 probe",
  },
  {
    id: "rule34video", displayName: "Rule34Video", kind: "video", category: "video",
    adapter: { template: "hls-site", params: { listPath: "/latest-updates/{page}/", itemLinkPattern: "/video/", detailPath: "/video/{id}/" } },
    baseUrls: ["https://rule34video.com"],
    enabled: true, order: 28, maturity: "stable",
    capabilities: HLS_CAPS, network: PROBE_NET, note: "真站实测（2026-11-19）：/latest-updates/1/ 解析 23 条、详情 KVS 播放器配置含 360–1080p 多档 mp4 直链（get_file、带 acctoken）、解析层取最高档离线复验通过",
  },
  {
    id: "fc2", displayName: "FC2", kind: "video", category: "video",
    adapter: { template: "hls-site", params: { listPath: "/ranking/article/weekly?page={page}", itemLinkPattern: "/article_search.php?id=", detailPath: "/article/{id}/" } },
    baseUrls: ["https://adult.contents.fc2.com"],
    enabled: true, order: 29, maturity: "probe",
    capabilities: HLS_CAPS, network: PROBE_NET, note: "fix321-F2b 校准（普通视频源待遇，用户定性 kind/category=video、不单独成档）：按真站结构校准——列表=销量榜 /ranking/article/weekly（本机实测 200、卡片锚点 /article_search.php?id=<id>、h3 标题＋缩略图，夹具解析出条目）、详情=作品页 /article/<id>/（本机实测 200、标题/样品图可达）；与目录 metadataOnly 定性对账：住宅出口四级验收全通指站与作品页可达成立，但 FC2 为 PPV 付费作品、无免费流形态（插件 catalog-fc2 同口径：只有排行榜＋作品资料、无 videos 段）→ resolve 诚实为空；App 侧未真机验 → 代码就绪未验证、仍 probe",
  },
  {
    id: "51chigua", displayName: "51吃瓜网", kind: "post", category: "posts",
    adapter: { template: "chigua", params: { listPath: "/page/{page}/", itemLinkPattern: "/archives/", detailPath: "/archives/{id}" } },
    baseUrls: ["https://51cg1.com"],
    enabled: true, order: 30, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "fix321-F2b 校准解 blocked：旧域名 51chigua.com 已停放（原 blocked 证据仍成立于旧域名）；现行域名 51cg1.com（与远程清单 v2 同口径）住宅出口四级验收全通（source-verify-20261119）＋本机出口三段实测——首页 post-card 列表（/archives/<id>/、h2 标题、x-bg-loader-url 封面）解析出条目、详情 DPlayer data-config 内嵌 m3u8 可取流（结构据 Hentai-Park feed51cg 插件、本机抓取互证）；分页按真站 /page/<n>/ 校准（旧 /?page= 未按真站核）；App 侧未真机验 → 代码就绪未验证、probe（非 blocked 呈现）",
  },
  {
    id: "feedheiliao", displayName: "黑料网", kind: "post", category: "posts",
    adapter: { template: "chigua", params: { listPath: "/page/{page}/", itemLinkPattern: "/archives/", detailPath: "/archives/{id}" } },
    baseUrls: ["https://heiliao.com", "https://www.heiliao88.com"],
    enabled: true, order: 32, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "fix321-F2b 自目录导入毕业为命名源并启用（与远程清单 v2 同口径：heiliao.com＋镜像 heiliao88.com、enabled=true）：启用依据三段齐——列表 video-item 卡片（/archives/<id>/、h3 标题、z-image-loader-url 封面）本机实测解析出条目、详情 h1.detail-title＋DPlayer 内嵌 m3u8 本机实测可取流（结构据 Hentai-Park feedheiliao 插件、本机抓取互证）、住宅出口四级验收全通（source-verify-20261119）；App 侧未真机验 → 代码就绪未验证、probe",
  },
  {
    id: "meiridasai", displayName: "每日大赛", kind: "post", category: "posts",
    adapter: { template: "chigua", params: { listPath: "/?page={page}", itemLinkPattern: "/archives/", detailPath: "/archives/{id}" } },
    baseUrls: ["https://meiridasai.com"],
    enabled: true, order: 31, maturity: "blocked",
    capabilities: NO_CAPS, network: PROBE_NET, note: "真站实测 blocked（2026-11-19）：apex 与 www 均返回 Cloudflare 525（源站 SSL 握手失败、16 字节错误体）；吃瓜模板保留、源站恢复后改判",
  },
  {
    id: "xiuren", displayName: "秀人网", kind: "image", category: "image",
    adapter: { template: "wp-rest", params: { restBase: "/wp-json/wp/v2", listPath: "/posts" } },
    baseUrls: ["https://xiuren.com"],
    enabled: true, order: 40, maturity: "blocked",
    capabilities: { search: true, episodes: false, hevc: false, comments: false },
    network: PROBE_NET, note: "真站实测 blocked（2026-11-19）：xiuren.com 首页与 /wp-json/wp/v2/posts 均连接失败（HTTP status 0、本机非中国出口不可达、疑地域限制）；WP REST 模板保留、换可达出口复测可改判",
  },
  {
    id: "pornpics", displayName: "PornPics", kind: "image", category: "image",
    adapter: { template: "hls-site", params: { listPath: "/recent/", itemLinkPattern: "/galleries/", detailPath: "/galleries/{id}/" } },
    baseUrls: ["https://www.pornpics.com"],
    enabled: true, order: 41, maturity: "probe",
    capabilities: HLS_CAPS, network: PROBE_NET, note: "真站复核（2026-11-19 fix321-F2，本机出口参考）：旧判有误——首页确为分类索引无图集，但 /recent/ SSR 有图集 tile：单引号属性锚点 /galleries/<slug>-<id>/（img alt 为空、标题靠 slug 还原）；旧模板三处不符（列表路径 /、图案 /gallery/、解析只认双引号）已全修，解析层支持单引号属性与 slug 标题兜底、真站结构夹具解析出图集；图集详情页本机可达（17 图）未逐图验 → 仍 probe。fix321-F2b 追加（解析不动）：住宅出口验收 www/裸域/刷新三次均 DNS 层不可达（source-verify-20261119）——站点死亡还是住宅 DNS 过滤未定，与本机出口可达结论并存记录；maturity 维持 probe",
  },
  {
    id: "cosplaytele", displayName: "CosplayTele", kind: "image", category: "image",
    adapter: { template: "wp-rest", params: { restBase: "/wp-json/wp/v2", listPath: "/posts" } },
    baseUrls: ["https://cosplaytele.com"],
    enabled: true, order: 42, maturity: "stable",
    capabilities: HLS_CAPS, network: PROBE_NET, note: "真站实测（2026-11-19）：本站为 WP 站、/wp-json/wp/v2/posts 列表实测可达、详情正文实测 103 张图（图集型、wp-rest detail.images 承接）；原 HTML slug 列表参数作废",
  },
  {
    id: "danbooru", displayName: "Danbooru", kind: "image", category: "image",
    adapter: { template: "danbooru-api", params: { listPath: "/posts.json" } },
    baseUrls: ["https://danbooru.donmai.us"],
    enabled: true, order: 43, maturity: "blocked",
    capabilities: { search: true, episodes: false, hevc: false, comments: false },
    network: PROBE_NET, note: "真站实测 blocked（2026-11-19）：/posts.json 以 iOS 与桌面两种 UA 均返回 403 Cloudflare「Just a moment」challenge 页（本机出口 IP 被拦）；danbooru-api 适配器已就绪、换出口复测通过即可升 stable",
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
    note: "探路降级：代理出口 Cloudflare 403 / 传输中断（tools/source-probe/results.md）。fix321-F2b 据实更新（本批撤下施工、只记状态）：住宅出口四级验收全通（source-verify-20261119）——站点可用、旧 403 系机房/代理出口定性；本站有公开 API 形态（api.iwara.tv，插件 iwara.js 有结构证据），但本仓尚无适配器（template=none）、未启用，待单独立项校准",
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

/** 内置注册表全量 = 命名源 + 目录导入源（catalog.ts）。远程清单按
 * id 覆盖 enabled/baseUrls 的口径对两部分同等生效：目录源启用、
 * 下线、改域名都走清单，不必重出包。 */
export const BUILTIN_SOURCES: SourceDef[] = [...NAMED_SOURCES, ...CATALOG_SOURCES];

export function getBuiltinRegistry(): SourceDef[] {
  return [...BUILTIN_SOURCES].sort((a, b) => a.order - b.order);
}

export function sourcesForCategory(category: SourceDef["category"], list: SourceDef[] = getBuiltinRegistry()): SourceDef[] {
  return list.filter((s) => s.category === category && s.enabled);
}

/** 频道-源映射（Muse 2026-11-19 fix321-F2，真机首验「大量不可用」
 * 根因之一）：频道页此前对所有频道都列全量 video 源——短剧频道把
 * XVideos/Hanime/SWAG 等无短剧品类的源也列成切源片，点进去必然
 * 空/失败。映射只按注册表既有字段判定（category/kind/
 * capabilities），不按源名列名单：
 * - 短剧（ai-duanju）：须 video 分类且 capabilities.episodes=true
 *   （有分集/连续剧集结构才算有短剧品类映射）；当前无外部源满足，
 *   该频道切源列表只剩原生黄果——如实无映射，不拿普通视频源充数；
 * - 视频（original）：video 分类的全部已启用源；
 * - 其余 cate 无外部源映射，返回空（调用方回落原生源）。 */
export function sourcesForChannel(cate: string, list: SourceDef[] = getBuiltinRegistry()): SourceDef[] {
  if (cate === "ai-duanju") {
    return list.filter((s) => s.enabled && s.category === "video" && s.capabilities.episodes);
  }
  if (cate === "original") return sourcesForCategory("video", list);
  return [];
}

export function firstEnabledSource(category: SourceDef["category"], list?: SourceDef[]): SourceDef | null {
  return sourcesForCategory(category, list)[0] ?? null;
}
