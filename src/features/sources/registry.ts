/**
 * 内置源注册表（Muse 2026-11-19 根治包·多源线 条目2；2026-11-19
 * 用户新口径修订：保留＋全目录导入）。
 *
 * 构成：命名源 12＋目录导入源 6（catalog.ts）。
 * 2026-11-19 20:22 用户产品瘦身定版（3.2.2 集成批执行）：定位收窄为
 * 短剧为主、吃瓜其次、图片顺带、视频只留里番——普通视频源全部、
 * myfans 预览专区与其余停用杂源已自注册表摘除（App 内不得出现；
 * 适配器源码留仓不删，远程清单 v3 同步只含保留源）。保留集：黄果、
 * 51吃瓜网、黑料网、每日大赛、秀人网、CosplayTele、Danbooru、
 * PornPics、目录图片类（PixiBB/NudeCosplay/yande.re/Gelbooru/Pixiv）、
 * Hanime.tv、Hanime1、Iwara、Rule34Video、HentaiHaven。
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
 * - 探路保留 2（Hanime1/Iwara，里番）：探测降级、enabled=false、
 *   无适配器，待保留源接通批立项校准后启用。
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
    id: "hanime-tv", displayName: "Hanime.tv", kind: "video", category: "video",
    adapter: { template: "hanime-api", params: {} },
    baseUrls: ["https://hanime.tv"],
    enabled: true, order: 24, maturity: "probe",
    capabilities: HLS_CAPS, network: PROBE_NET, note: "3.3.0 接通批（fix330-hanime-api）：换 hanime-api 模板走站点官方 API v11（协议据 Hentai-Park 公开插件原文＋本机实测对账）。列表/搜索/详情＝guest API 全量目录 GET guest.freeanimehentai.net/api/v11/search_hvs（无签名、无服务端分页、客户端排序/过滤/切片；实测 HTTP 200、3474 条、4.5MB——Rust 取页对该 (origin,path) 定向放宽上限至 12MB、全局 4MB 不变）；详情目录未收录时回落详情页 og 元信息。播放＝握手链：ct.hanime.tv 取 CSRF → AES-256-GCM 信封（密钥/签名为公开协议常数）POST auth.hanime.tv/api/v11/handshake（x-signature web2 签名头）→ x-token 响应头回信封解密得 /hls/<画质>/ 流表。通道定性（复核旧 F2b 结论属实）：原 GET-only 取页三处不通（POST 方法无入口/签名头被 filter_source_headers 丢弃/响应头不可见）→ 本批以 Rust source_post 定向扩展打通（仅 auth.hanime.tv origin＋固定头名单＋仅回 x-token 一个响应头，GET 契约与全局白名单不变）。协议级实证（2026-11-19 本机机房出口）：目录/CSRF/握手三端点均 200、流表 3 档、HLS 清单 200 且 #EXTM3U 形态合法；App 侧未真机验 → 代码就绪未验证、维持 probe",
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
  /* ── 探路保留 2（里番）：探测降级，enabled=false、不写适配器 ── */
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
