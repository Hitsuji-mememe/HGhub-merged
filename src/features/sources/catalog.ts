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
 * 2026-11-19 fix330 图片线逐源定级（本注记后补说明）：图片类 5 源
 * 已逐源实抓定级、条目本体随之手改——pixibb/nudecosplay 有真列表
 * 证据启用（probe），gelbooru/yandere/pixiv 维持未启用并在 note
 * 记实证/排除结论（证据 fix330/evidence/images.md）；HentaiHaven
 * 属里番线、本线未动。
 * 条目本体未手改）。fix330 接通批（2026-11-19）：HentaiHaven 已
 * 毕业为命名源（见下方毕业注记），本表只剩图片类 5 源。
 * 2026-11-20 fix335/g-sources（本注记后补说明）：yandere 经可达性
 * 门复测＋danbooru 模板 moebooru 校准后启用（probe）；新增同族
 * konachan（order 105）同校准启用；本表 5→6 源（证据
 * fix335/evidence/g-sources.md）。 */
import type { SourceDef } from "./types.ts";

const NO_CAPS = { search: false, episodes: false, hevc: false, comments: false };
const PROBE_NET = { mode: "probe-required" } as const;

/* 黑料网（feedheiliao）已于 fix321-F2b 自目录导入毕业为命名源
 * （registry.ts NAMED_SOURCES：三段结构证据齐＋住宅四级全通、启用），
 * 本表不再保留其条目，避免同 id 双注册。 */
/* HentaiHaven 已于 fix330 接通批自目录导入毕业为命名源
 * （registry.ts NAMED_SOURCES：专用适配器 hentaihaven-api＋解析
 * 夹具实证、启用），本表不再保留其条目，避免同 id 双注册。 */
export const CATALOG_SOURCES: SourceDef[] = [
  {
    id: "pixibb", displayName: "PixiBB", kind: "image", category: "image",
    adapter: { template: "wp-rest", params: {"restBase": "/wp-json/wp/v2", "listPath": "/posts"} },
    baseUrls: ["https://sexy.pixibb.com"],
    enabled: true, order: 101, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false, comments: false }, network: PROBE_NET, note: "fix330 图片线定级（2026-11-19）：本机出口四级实证全通（/wp-json/wp/v2/posts 200 真条目、详情 200、图集、出图 200）＋搜索端点 200 有结果；住宅出口两级筛查正常在案（source-verify-20261119 第二轮 B 组）；wp-rest 参数按实抓校准无变更；App 侧未真机验 → 启用、probe（证据 fix330/evidence/images.md）",
  },
  {
    id: "nudecosplay", displayName: "NudeCosplay", kind: "image", category: "image",
    adapter: { template: "wp-rest", params: {"restBase": "/wp-json/wp/v2", "listPath": "/posts"} },
    baseUrls: ["https://nudecosplay.biz"],
    enabled: true, order: 102, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false, comments: false }, network: PROBE_NET, note: "fix330 图片线定级（2026-11-19）：本机出口四级实证全通（/wp-json/wp/v2/posts 200 真条目、详情 200、图集、出图 206）＋搜索端点 200 有结果；住宅出口两级筛查正常在案（source-verify-20261119 第二轮 B 组）；wp-rest 参数按实抓校准无变更；App 侧未真机验 → 启用、probe（证据 fix330/evidence/images.md）",
  },
  {
    id: "yandere", displayName: "yande.re", kind: "image", category: "image",
    adapter: { template: "danbooru-api", params: {"listPath": "/post.json", "detailPath": "/post.json?tags=id:{id}", "postPath": "/post/show/{id}", "tagsField": "tags", "previewField": "preview_url", "largeField": "jpeg_url"} },
    baseUrls: ["https://yande.re"],
    enabled: true, order: 103, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false, comments: false }, network: PROBE_NET, note: "fix335/g-sources（2026-11-20）：启用 probe——可达性门复测本机 VM 出口 /post.json 200 真条目、详情 /post.json?tags=id:{id} 单元素数组、标签搜索段实证，danbooru 模板 moebooru 校准落码；fix330 存档事实保留：2026-11-19 住宅出口 DNS 失效在案（source-verify-20261119 第二轮 B 组）、旧模板路径 /posts.json 404 已由校准解决；住宅出口复测未做成、App 侧未真机验（证据 fix335/evidence/g-sources.md）",
  },
  {
    id: "gelbooru", displayName: "Gelbooru", kind: "image", category: "image",
    adapter: { template: "danbooru-api", params: {"listPath": "/posts.json"} },
    baseUrls: ["https://gelbooru.com/"],
    enabled: false, order: 104, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "fix330 图片线定级（2026-11-19）：维持未启用——本机出口实抓：模板端点 /posts.json 404、站方 dapi（json/xml 两形态）匿名 401 需 API 凭证，无模板级真列表证据；住宅出口 HTML 两级筛查正常仅为页面级存档（source-verify-20261119 第二轮 B 组）、不构成 API 列表证据 → 不启用（证据 fix330/evidence/images.md）",
  },
  {
    id: "konachan", displayName: "Konachan", kind: "image", category: "image",
    adapter: { template: "danbooru-api", params: {"listPath": "/post.json", "detailPath": "/post.json?tags=id:{id}", "postPath": "/post/show/{id}", "tagsField": "tags", "previewField": "preview_url", "largeField": "jpeg_url"} },
    baseUrls: ["https://konachan.com"],
    enabled: true, order: 105, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false, comments: false }, network: PROBE_NET, note: "fix335/g-sources（2026-11-20）：新增启用 probe——与 yande.re 同族 moebooru，本机 VM 出口 /post.json 200 真条目、详情单元素数组、标签搜索段实证，danbooru 模板 moebooru 校准（.net 为 safe 镜像、只取 .com）；住宅出口复测未做成、App 侧未真机验（证据 fix335/evidence/g-sources.md）",
  },
  {
    id: "pixiv", displayName: "Pixiv", kind: "image", category: "image",
    adapter: { template: "wp-rest", params: {"restBase": "/wp-json/wp/v2", "listPath": "/posts"} },
    baseUrls: ["https://www.pixiv.net"],
    enabled: false, order: 121, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "fix330 图片线定级（2026-11-19）：维持未启用并按收录标准排除——环境拦截＋需登录（source-verify-20261119 第二轮 B 组存档口径）；本机出口复核首页 403；目录 wp-rest 参数为通用骨架、与站方形态无关，不校准、不启用（证据 fix330/evidence/images.md）",
  },
];
