/**
 * 目录导入源（Muse 2026-11-19 根治包·多源线，机械生成、勿手改）。
 * 生成器：tools/source-import/generate_catalog.py（Hentai-Park 目录
 * 元数据机械提取：名称/入口/类别；只搬事实不搬代码，AGPL 干净室）。
 * 口径：全部 maturity=probe、enabled=false（注册保留，远程清单可
 * 按 id 启用/改域名，不必重出包）；note 均为「目录导入·未实测」，
 * 模板参数为通用骨架、未按真站校准——不许据此声称验通。
 * 2026-11-19 瘦身定版（3.2.2 集成批）：只保留图片类 5 源＋里番
 * HentaiHaven，其余目录源已摘除（生成器产物、本注记后补说明，
 * 条目本体未手改）。
 */
import type { SourceDef } from "./types.ts";

const NO_CAPS = { search: false, episodes: false, hevc: false, comments: false };
const PROBE_NET = { mode: "probe-required" } as const;

/* 黑料网（feedheiliao）已于 fix321-F2b 自目录导入毕业为命名源
 * （registry.ts NAMED_SOURCES：三段结构证据齐＋住宅四级全通、启用），
 * 本表不再保留其条目，避免同 id 双注册。 */
export const CATALOG_SOURCES: SourceDef[] = [
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
    id: "pixiv", displayName: "Pixiv", kind: "image", category: "image",
    adapter: { template: "wp-rest", params: {"restBase": "/wp-json/wp/v2", "listPath": "/posts"} },
    baseUrls: ["https://www.pixiv.net"],
    enabled: false, order: 121, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "目录导入·未实测（Hentai-Park 目录，2026-11-19）：插画与漫画社区，支持个性化推荐、排行、搜索和多页原图阅读；模板参数为通用骨架、未按真站校准",
  },
];
