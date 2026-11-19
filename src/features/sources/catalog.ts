/**
 * 目录导入源（Muse 2026-11-19 根治包·多源线，机械生成、勿手改）。
 * 生成器：tools/source-import/generate_catalog.py（Hentai-Park 目录
 * 元数据机械提取：名称/入口/类别；只搬事实不搬代码，AGPL 干净室）。
 * 口径：全部 maturity=probe、enabled=false（注册保留，远程清单可
 * 按 id 启用/改域名，不必重出包）；note 均为「目录导入·未实测」，
 * 模板参数为通用骨架、未按真站校准——不许据此声称验通。
 */
import type { SourceDef } from "./types.ts";

const NO_CAPS = { search: false, episodes: false, hevc: false, comments: false };
const PROBE_NET = { mode: "probe-required" } as const;

export const CATALOG_SOURCES: SourceDef[] = [
  {
    id: "feedheiliao", displayName: "黑料网", kind: "post", category: "posts",
    adapter: { template: "chigua", params: {"listPath": "/?page={page}", "itemLinkPattern": "/archives/", "detailPath": "/archives/{id}"} },
    baseUrls: ["https://heiliao.com"],
    enabled: false, order: 100, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：吃瓜图文，支持分类、标签、搜索与视频；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "pixibb", displayName: "PixiBB", kind: "image", category: "image",
    adapter: { template: "wp-rest", params: {"restBase": "/wp-json/wp/v2", "listPath": "/posts"} },
    baseUrls: ["https://sexy.pixibb.com"],
    enabled: false, order: 101, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：Cosplay 与写真图集，支持推荐、分类与搜索；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "nudecosplay", displayName: "NudeCosplay", kind: "image", category: "image",
    adapter: { template: "wp-rest", params: {"restBase": "/wp-json/wp/v2", "listPath": "/posts"} },
    baseUrls: ["https://nudecosplay.biz"],
    enabled: false, order: 102, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：Cosplay 写真图集，支持总热门、月热门与周热门；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "yandere", displayName: "yande.re", kind: "image", category: "image",
    adapter: { template: "danbooru-api", params: {"listPath": "/posts.json"} },
    baseUrls: ["https://yande.re/"],
    enabled: false, order: 103, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：成人插画图库，支持评分排序、搜索与原图；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "gelbooru", displayName: "Gelbooru", kind: "image", category: "image",
    adapter: { template: "danbooru-api", params: {"listPath": "/posts.json"} },
    baseUrls: ["https://gelbooru.com/"],
    enabled: false, order: 104, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：成人美图画廊，支持评分排序、搜索与原图；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "hentaihaven", displayName: "HentaiHaven", kind: "video", category: "video",
    adapter: { template: "hls-site", params: {"listPath": "/?page={page}", "itemLinkPattern": "/video/", "detailPath": "/video/{id}"} },
    baseUrls: ["https://hentaihaven.xxx/"],
    enabled: false, order: 105, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：里番目录、搜索与 HLS 播放；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "av123", displayName: "123AV", kind: "video", category: "video",
    adapter: { template: "hls-site", params: {"listPath": "/?page={page}", "itemLinkPattern": "/video/", "detailPath": "/video/{id}"} },
    baseUrls: ["https://123av.com"],
    enabled: false, order: 106, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：JAV 视频，支持推荐、热门、搜索与 HLS 播放；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "supjav", displayName: "SupJav", kind: "video", category: "video",
    adapter: { template: "hls-site", params: {"listPath": "/?page={page}", "itemLinkPattern": "/video/", "detailPath": "/video/{id}"} },
    baseUrls: ["https://supjav.com"],
    enabled: false, order: 107, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：JAV 视频，支持热门、搜索与多线路播放；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "xhamster", displayName: "xHamster", kind: "video", category: "video",
    adapter: { template: "hls-site", params: {"listPath": "/?page={page}", "itemLinkPattern": "/video/", "detailPath": "/video/{id}"} },
    baseUrls: ["https://xhamster.com"],
    enabled: false, order: 108, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：综合成人视频，支持推荐、搜索和多清晰度播放；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "spankbang", displayName: "SpankBang", kind: "video", category: "video",
    adapter: { template: "hls-site", params: {"listPath": "/?page={page}", "itemLinkPattern": "/video/", "detailPath": "/video/{id}"} },
    baseUrls: ["https://spankbang.com"],
    enabled: false, order: 109, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：综合成人视频，支持推荐、搜索与多清晰度MP4；可能需浏览器确认；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "eporner", displayName: "Eporner", kind: "video", category: "video",
    adapter: { template: "hls-site", params: {"listPath": "/?page={page}", "itemLinkPattern": "/video/", "detailPath": "/video/{id}"} },
    baseUrls: ["https://www.eporner.com/"],
    enabled: false, order: 110, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：成人视频目录、搜索与多清晰度 MP4；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "thumbzilla", displayName: "Thumbzilla", kind: "video", category: "video",
    adapter: { template: "hls-site", params: {"listPath": "/?page={page}", "itemLinkPattern": "/video/", "detailPath": "/video/{id}"} },
    baseUrls: ["https://www.thumbzilla.com"],
    enabled: false, order: 111, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：成人视频，支持热门、搜索和多清晰度 MP4 播放；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "ixxx", displayName: "iXXX", kind: "video", category: "video",
    adapter: { template: "hls-site", params: {"listPath": "/?page={page}", "itemLinkPattern": "/video/", "detailPath": "/video/{id}"} },
    baseUrls: ["https://www.ixxx.com"],
    enabled: false, order: 112, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：综合成人视频搜索，常见来源优先原生播放，其他来源使用网页播放；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "tubesafari", displayName: "TubeSafari", kind: "video", category: "video",
    adapter: { template: "hls-site", params: {"listPath": "/?page={page}", "itemLinkPattern": "/video/", "detailPath": "/video/{id}"} },
    baseUrls: ["https://tubesafari.com"],
    enabled: false, order: 113, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：综合成人视频搜索，常见来源优先原生播放，其他来源使用网页播放；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "soop-shortvideo", displayName: "SOOP 短视频", kind: "video", category: "video",
    adapter: { template: "hls-site", params: {"listPath": "/?page={page}", "itemLinkPattern": "/video/", "detailPath": "/video/{id}"} },
    baseUrls: ["https://vod.sooplive.co.kr/"],
    enabled: false, order: 114, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：韩国性感舞蹈与比基尼短视频，按原站标签筛选；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "shorties", displayName: "Pornhub Shorties", kind: "video", category: "video",
    adapter: { template: "hls-site", params: {"listPath": "/?page={page}", "itemLinkPattern": "/video/", "detailPath": "/video/{id}"} },
    baseUrls: ["https://www.pornhub.com/shorties"],
    enabled: false, order: 115, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：竖屏短视频推荐，上下滑动连续播放；Pornhub 站内竖屏短视频分区，与命名源 Pornhub 同站、属其子集；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "popkontv-shortvideo", displayName: "PopkonTV 短视频", kind: "video", category: "video",
    adapter: { template: "hls-site", params: {"listPath": "/?page={page}", "itemLinkPattern": "/video/", "detailPath": "/video/{id}"} },
    baseUrls: ["https://www.popkontv.com/"],
    enabled: false, order: 116, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：韩国主播短视频，支持推荐、分页与 MP4 播放；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "fansly", displayName: "Fansly", kind: "video", category: "video",
    adapter: { template: "hls-site", params: {"listPath": "/?page={page}", "itemLinkPattern": "/video/", "detailPath": "/video/{id}"} },
    baseUrls: ["https://fansly.com/explore/foryou"],
    enabled: false, order: 117, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：匿名可看公开短视频；敏感内容需登录；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "huangdou", displayName: "黄豆短剧", kind: "video", category: "video",
    adapter: { template: "hls-site", params: {"listPath": "/?page={page}", "itemLinkPattern": "/video/", "detailPath": "/video/{id}"} },
    baseUrls: ["https://aihuangdou.com"],
    enabled: false, order: 118, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：AI短剧与漫剧，支持分类、排行、搜索和分集播放；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "drama91", displayName: "91短剧", kind: "video", category: "video",
    adapter: { template: "hls-site", params: {"listPath": "/?page={page}", "itemLinkPattern": "/video/", "detailPath": "/video/{id}"} },
    baseUrls: ["https://91crdjai.com"],
    enabled: false, order: 119, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：AI短剧、漫剧与视频，支持推荐、分类、搜索和分集播放；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "rouvideo-drama", displayName: "肉视频短剧", kind: "video", category: "video",
    adapter: { template: "hls-site", params: {"listPath": "/?page={page}", "itemLinkPattern": "/video/", "detailPath": "/video/{id}"} },
    baseUrls: ["https://rou.video/series"],
    enabled: false, order: 120, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：AI短剧，支持推荐、搜索和分集播放；肉视频站内短剧分区（rou.video/series），与命名源肉视频同站、属其子集；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "pixiv", displayName: "Pixiv", kind: "image", category: "image",
    adapter: { template: "wp-rest", params: {"restBase": "/wp-json/wp/v2", "listPath": "/posts"} },
    baseUrls: ["https://www.pixiv.net"],
    enabled: false, order: 121, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：插画与漫画社区，支持个性化推荐、排行、搜索和多页原图阅读；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "fanbox", displayName: "pixivFANBOX", kind: "mixed", category: "preview",
    adapter: { template: "preview-only" },
    baseUrls: ["https://www.fanbox.cc"],
    enabled: false, order: 122, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：创作者订阅，公开目录与封面预览；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "catalog-fanza", displayName: "FANZA", kind: "video", category: "video",
    adapter: { template: "hls-site", params: {"listPath": "/?page={page}", "itemLinkPattern": "/video/", "detailPath": "/video/{id}"} },
    baseUrls: ["https://video.dmm.co.jp/"],
    enabled: false, order: 123, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：排行榜与作品资料；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "catalog-mgs", displayName: "MGStage", kind: "video", category: "video",
    adapter: { template: "hls-site", params: {"listPath": "/?page={page}", "itemLinkPattern": "/video/", "detailPath": "/video/{id}"} },
    baseUrls: ["https://www.mgstage.com/"],
    enabled: false, order: 124, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：排行榜与作品资料；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "catalog-studios", displayName: "无码厂商", kind: "video", category: "video",
    adapter: { template: "hls-site", params: {"listPath": "/?page={page}", "itemLinkPattern": "/video/", "detailPath": "/video/{id}"} },
    baseUrls: ["https://www.1pondo.tv/"],
    enabled: false, order: 125, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：排行榜与作品资料；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "catalog-javmenu", displayName: "JavMenu", kind: "video", category: "video",
    adapter: { template: "hls-site", params: {"listPath": "/?page={page}", "itemLinkPattern": "/video/", "detailPath": "/video/{id}"} },
    baseUrls: ["https://javmenu.com/"],
    enabled: false, order: 126, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：排行榜与作品资料；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "metadata-javbus", displayName: "JavBus", kind: "video", category: "video",
    adapter: { template: "hls-site", params: {"listPath": "/?page={page}", "itemLinkPattern": "/video/", "detailPath": "/video/{id}"} },
    baseUrls: ["https://www.javbus.com/"],
    enabled: false, order: 127, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：作品资料与磁链；模板参数为通用骨架、未按真站校准",
  },
  {
    id: "metadata-javdb", displayName: "JavDB", kind: "video", category: "video",
    adapter: { template: "hls-site", params: {"listPath": "/?page={page}", "itemLinkPattern": "/video/", "detailPath": "/video/{id}"} },
    baseUrls: ["https://javdb.com/"],
    enabled: false, order: 128, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：作品资料与磁链；模板参数为通用骨架、未按真站校准",
  },
];
