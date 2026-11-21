/**
 * 内置源注册表（Muse 2026-11-19 根治包·多源线 条目2；2026-11-19
 * 用户新口径修订：保留＋全目录导入）。
 *
 * 构成：命名源 9＋目录导入源 5（catalog.ts；fix330 接通批
 * HentaiHaven 自目录毕业、Hanime1/Iwara 接通启用；fix335/g-sources
 * 摘 PornPics、目录加 Konachan 并启用 yandere；fix338/registry-cut
 * 再摘三源后总数 17→14，见下方 3.3.8 摘除注记）。
 * 2026-11-19 20:22 用户产品瘦身定版（3.2.2 集成批执行）：定位收窄为
 * 短剧为主、吃瓜其次、图片顺带、视频只留里番——普通视频源全部、
 * myfans 预览专区与其余停用杂源已自注册表摘除（App 内不得出现；
 * 适配器源码留仓不删，远程清单 v3 同步只含保留源）。保留集：黄果、
 * 51吃瓜网、黑料网、每日大赛、秀人网、CosplayTele、Danbooru、
 * PornPics、目录图片类（PixiBB/NudeCosplay/yande.re/Gelbooru/Pixiv）、
 * Hanime.tv、Hanime1、Iwara、HentaiHaven。
 * 2026-11-19 21:51 用户裁定追加摘除：Rule34Video 自注册表删除
 * （fix330/ui-fixes 线执行；清单 v3 同步已摘、applyManifest 只覆盖
 * 内置条目不新增，远程清单残留同 id 条目不会把已删源加回来；
 * hls-site 适配器模板留仓不删，与既有瘦身口径一致）。
 * 2026-11-20 fix335/g-sources 追加摘除：PornPics 自注册表删除
 * （用户裁定退役：站方无分页、库存恒 20 册且单册最薄，审计
 * fix335/audit-007-inventory.md；清单 v4 同步已摘；hls-site 适配
 * 器模板留仓不删，与既有瘦身口径一致）。
 * 2026-11-20 fix338/registry-cut（3.3.8）追加摘除三源（用户定案：
 * 留在 App 里的必须保证能看、保证不了就删）：Danbooru（用户裁
 * 定单图帖不算资源、删除已定）、HentaiHaven（3.3.7 真机点播全
 * 灭、真播放需新开加密 POST 通道、调查裁定不值得搭，见
 * fix338/investigation-338.md）、Konachan（CF JS 验证拦非浏览
 * 器客户端、无解）。清单 v5 同步已摘（仓外 remote-manifest）。
 * 本批新口径（用户 23:26 结构精简授权，supersede 上文各批「适
 * 配器留仓」口径、仅限本轮删除牵连面）：被删源独占的适配器与
 * 专属接线同批删码（hentaihaven-api 模板全删、Danbooru 专属排
 * 序预设与发现登记删）；共享模板/机制被保留源复用的只摘注册
 * （danbooru-api 模板由 yandere/gelbooru 共用、单图组装画廊由
 * yandere 继续承接，均保留）。盘点与证据 fix338/evidence/
 * registry-cut.md。
 * 2026-11-21 fix339/registry-cut-2（3.3.9）追加摘除三源：Hanime1/
 * Iwara（3.3.8 一轮修复后真机仍不可播——清单取数段 dns_error，
 * 用户 23:25 定案＋一轮制整组删、无第三轮，定案证据
 * fix338/evidence/device-export-338-analysis.md）与 yandere
 * （目录源，用户确认与 Danbooru 同为单图帖模型、同标准删）。
 * 内置终态 13 源（命名 9＋目录 4）、启用 11；视频频道只剩
 * Hanime.tv 一源（频道构成全由注册表派生、无空分组）。
 * 独占牵连同批删码：hanime1/iwara-api 两模板本体、Iwara 签名
 * SHA-1 实现与双盐、Rust X-Version 定向放行、IWARA origin 常量
 * 与取页白名单声明、发现/选集登记、专属夹具 7 件。danbooru-api
 * 模板与组装画廊保留（目录源 gelbooru 同模板在册承接、只摘
 * yandere 注册）。清单 v6 同步已摘（仓外 remote-manifest）。
 * 盘点与证据 fix339/evidence/registry-cut-2.md。
 * 2026-11-21 fix3310/video-add-2（3.3.10）试装恢复＋补位：009/010
 * 按用户同日授权试装一轮——两源当年双墙（清单主机连接墙＋file
 * 流无播放腿），播放腿已由 fix3310/file-playback-leg 补齐，本批
 * 以 fix338 集成树 @7769c90 原样恢复两适配器与全部独占牵连面
 * （签名链/工厂/白名单/发现选集登记/Rust X-Version 放行/夹具/
 * 契约/wiring），注册为试装条目：新探针（协议 v4）走真实播放
 * 路径先验、真机点播过关才正式回归，不过删回。新增 020/021 两
 * 视频源（候选 fix339/evidence/video-candidates.md 播放级实证）：
 * 020＝wp-rest＋JW file: 小解析（opt-in 参数 jwFile），021＝
 * wp-rest 逐字同形。内置终态 17 源、启用 15；清单 v7 同步
 * （仓外 remote-manifest）。证据 fix3310/evidence/video-add-2.md。
 * 自检纪元 5／协议 v4 均不 bump：本批探针步骤零变更（v4 为腿线
 * bump）；009/010 在纪元 5 下无已存结果（摘除后未探过、≤4 的旧
 * 结果已被纪元 5 整批作废），020/021 为新 id 无旧结果，保留源
 * 切片与判定语义不变（jwFile 为 def opt-in、未声明源行为不变）。
 * 2026-11-21 fix3311/registry-cleanup（3.3.11）009 试装判删回：
 * 009 真机协议 v4 探针取流段网络类失败（列表/详情可达、取流连
 * 接段死，与 3.3.8 连接墙同族；同批 010 探针通过、非腿/探针通
 * 病），按试装规则（用户 11:14 定）删回——只摘 009：注册条目、
 * hanime1 模板本体与排序值表、工厂/探针工厂分发、发现/选集登
 * 记、取页白名单空声明、专属夹具 4 件、专属 wiring 1 条同批删
 * 码；010 不连坐（其签名链、Rust X-Version 定向放行、iwara-api
 * 模板与三 origin 声明逐字不动）。内置终态 16 源、启用 14；
 * 清单 v8 同步已摘（仓外 remote-manifest）。自检纪元/协议不
 * bump：摘除不改变保留源取页/解析与逐源切片（fix339 先例）。
 * 证据 fix3311/evidence/registry-cleanup.md。
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
 * - 里番接通（fix330，2026-11-19）：Hanime1/Iwara/HentaiHaven 三源
 *   已写专用适配器并启用（逐源依据见各条目 note 与
 *   fix330/evidence/new-adapters.md），maturity 均 probe。
 */
import type { SourceDef } from "./types.ts";
import { CATALOG_SOURCES } from "./catalog.ts";

const NO_CAPS = { search: false, episodes: false, hevc: false };
const HLS_CAPS = { search: true, episodes: false, hevc: false };
/** 吃瓜帖源已接搜索段时的 caps（3.3.0 接通批：逐源按真站搜索形态实证后声明） */
const POST_SEARCH_CAPS = { search: true, episodes: false, hevc: false };
const PROBE_NET = { mode: "probe-required" } as const;

export const NAMED_SOURCES: SourceDef[] = [
  {
    id: "huangguo", displayName: "黄果", kind: "mixed", category: "posts",
    adapter: { template: "native-huangguo" },
    baseUrls: ["https://huangguoai.com"],
    enabled: true, order: 10, maturity: "stable",
    capabilities: { search: true, episodes: true, hevc: true },
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
    id: "51chigua", displayName: "51吃瓜网", kind: "post", category: "posts",
    adapter: { template: "chigua", params: { listPath: "/page/{page}/", itemLinkPattern: "/archives/", detailPath: "/archives/{id}", searchPath: "/search/{q}/{page}/", cardContainer: "article", announcementCats: ["往期活动"], contestCat: "每日大赛", contestTitlePrefix: "每日大赛之【", staffVerify: { maxBodyChars: 100000, maxBodyImages: 26 }, categoryPath: "/category/{slug}/{page}/", discoveryCategories: [{ slug: "wpcz", name: "今日吃瓜每日更新" }, { slug: "cbdj", name: "AI成人短剧热播推荐" }, { slug: "whhj", name: "网黄合集" }, { slug: "mrdg", name: "吃瓜榜单", rank: true }, { slug: "qghj", name: "瓜友点播" }, { slug: "rdsj", name: "热门大瓜", rank: true, hot: true }, { slug: "bkdg", name: "必看大瓜" }, { slug: "ysyl", name: "成人视频" }, { slug: "lldd", name: "伦理道德" }, { slug: "gcjq", name: "国产视频" }, { slug: "thjx", name: "探花精选" }, { slug: "xsxy", name: "学生校园" }, { slug: "whhl", name: "网红黑料" }, { slug: "snsn", name: "骚男骚女" }, { slug: "whmx", name: "明星爆料" }, { slug: "hwcg", name: "海外吃瓜" }, { slug: "rrcg", name: "人人吃瓜" }, { slug: "ldcg", name: "领导干部" }, { slug: "jpll", name: "软萌甜妹" }, { slug: "sjb", name: "竞技吃瓜" }, { slug: "qubk", name: "吃瓜看戏" }, { slug: "dcbq", name: "擦边撩骚" }, { slug: "zzs", name: "性爱技巧" }, { slug: "cgxw", name: "吃瓜新闻" }, { slug: "51djc", name: "51原创短剧" }, { slug: "yczq", name: "原创博主" }] } },
    baseUrls: ["https://51cg1.com"],
    enabled: true, order: 30, maturity: "probe",
    capabilities: POST_SEARCH_CAPS, network: PROBE_NET, note: "fix321-F2b 校准解 blocked：旧域名 51chigua.com 已停放（原 blocked 证据仍成立于旧域名）；现行域名 51cg1.com（与远程清单 v2 同口径）住宅出口四级验收全通（source-verify-20261119）＋本机出口三段实测——首页 post-card 列表（/archives/<id>/、h2 标题、x-bg-loader-url 封面）解析出条目、详情 DPlayer data-config 内嵌 m3u8 可取流（结构据 Hentai-Park feed51cg 插件、本机抓取互证）；分页按真站 /page/<n>/ 校准（旧 /?page= 未按真站核）；App 侧未真机验 → 代码就绪未验证、probe（非 blocked 呈现）。3.3.0 接通批（2026-11-19）：浏览面经 SourcePosts 接线；搜索段接线——真站搜索形态 /search/{q}/{page}/（站内 search.js buildSearchUrl 与 /?s= 重写互证、paged 参数被重写吞掉故不走模板默认形），本机出口实证搜索真出条目且第 2 页条目集与第 1 页不同、列表/详情/取流经生产适配器对实抓页解析通过（四级齐）；caps.search 据实改 true。3.3.5 fix335/b-purify 启用详情层异步验杀（params.staffVerify）：置顶招募型站务帖为无标题/无分类词元的异形卡、列表层判据无信号；详情量测（2026-11-20 本机实拉，生产量法）——招募/站务 3 帖 eps 恒 0、正文图 3–23、正文 2132–3558 字，内容 11 帖 eps 恒 1、正文图 30–44、正文 1941–2323 字。字数与内容重叠不承重（阈值置 100000），判据实效＝eps=0∧正文图≤26（图空带 24–29 取 26）；用户截图招募卡 274838（3558 字/图 23/eps 0）按判据撤下，审计预估图≤6 被其实测 23 图证伪后按扩样校准。残余同形风险与 feedheiliao 同类：无流∧图≤26 的真内容帖在量测样本内不存在。证据 fix335/evidence/b-purify.md",
  },
  {
    id: "feedheiliao", displayName: "黑料网", kind: "post", category: "posts",
    adapter: { template: "chigua", params: { listPath: "/page/{page}/", itemLinkPattern: "/archives/", detailPath: "/archives/{id}", cardContainer: "video-item", staffVerify: { maxBodyChars: 890, maxBodyImages: 3 }, categoryPath: "/{slug}/page/{page}/", discoveryCategories: [{ slug: "hlcg", name: "最新黑料" }, { slug: "youliao", name: "有料局" }, { slug: "jrrs", name: "今日热瓜" }, { slug: "lsdg", name: "经典黑料" }, { slug: "xycg", name: "校园黑料" }, { slug: "ysdj", name: "成人短剧" }, { slug: "fczq", name: "反差专区" }, { slug: "whhl", name: "网红黑料" }, { slug: "mxcw", name: "明星丑闻" }, { slug: "mrds", name: "每日大赛" }, { slug: "ycsq", name: "原创社区" }, { slug: "djbl", name: "独家爆料" }, { slug: "yqby", name: "有求必应" }, { slug: "ttsq", name: "推特社区" }, { slug: "shxw", name: "社会新闻" }, { slug: "jqxs", name: "黑料小说" }, { slug: "thzq", name: "探花专区" }, { slug: "whhj", name: "网黄合集" }, { slug: "cpcd", name: "厕拍抄底" }, { slug: "gchl", name: "官场爆料" }, { slug: "qqqw", name: "全球奇闻" }, { slug: "ttzz", name: "成人动漫" }, { slug: "hlkt", name: "黑料课堂" }, { slug: "hlbg", name: "黑料爆改" }, { slug: "syzy", name: "深夜综艺" }, { slug: "sjb", name: "体育直播" }, { slug: "mrrb", name: "日榜黑料", rank: true }, { slug: "zbjx", name: "周榜精选", rank: true }, { slug: "ybrg", name: "月榜热瓜", rank: true }, { slug: "jqrm", name: "热门黑料", rank: true, hot: true }] } },
    baseUrls: ["https://heiliao.com", "https://www.heiliao88.com"],
    enabled: true, order: 32, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET, note: "fix321-F2b 自目录导入毕业为命名源并启用（与远程清单 v2 同口径：heiliao.com＋镜像 heiliao88.com、enabled=true）：启用依据三段齐——列表 video-item 卡片（/archives/<id>/、h3 标题、z-image-loader-url 封面）本机实测解析出条目、详情 h1.detail-title＋DPlayer 内嵌 m3u8 本机实测可取流（结构据 Hentai-Park feedheiliao 插件、本机抓取互证）、住宅出口四级验收全通（source-verify-20261119）；App 侧未真机验 → 代码就绪未验证、probe。3.3.0 接通批（2026-11-19）：真机点开仍是提示页的根因＝posts 分类从未接浏览组件（Posts/分类总览对非黄果源无条件提示、与 maturity 无关），已接 SourcePosts 浏览面（postsRoute browse）；详情正文容器 editormd-preview 已入 chigua 模板捕获（旧两式恒空）；搜索无段属实——本机出口实证 /search/<词>/、/?s=、/index/search 三种 GET 形态均返回关键词不变页（无意义词与常用词响应同量级、条目集恒定），站点搜索为前端驱动、无 GET 搜索段可接，caps.search 维持 false、不进扇出。3.3.3 fix333/promo-004：卡内站务推广帖列表层无分类/作者信号、组合判据不存在（promo-filter 线停工证据），改走详情层异步验杀——params.staffVerify 声明阈值（正文≤890 字∧episodes=0 判站务型、列表先渲染后台逐条验、判定落盘每帖只验一次；活动投票帖 1744 字＋有流按用户裁定保留），实现 promoVerify.ts、证据 fix333/evidence/promo-004.md。3.3.3 M8 判据收紧：165 条已分类帖逐条实跑详情全量量测，站务三连正文 <img> 恒 1、内容帖全部 ≥7（适配器 images 字段被模板图污染不可用），判据加第三重合取正文图片数≤3、判据版本 v2（旧缓存整域失效）；短正文带图真帖自此按构造存活，证据 fix333/evidence/m8-staff-criteria.md",
  },
  {
    id: "meiridasai", displayName: "每日大赛", kind: "post", category: "posts",
    adapter: { template: "chigua", params: { listPath: "/page/{page}/", itemLinkPattern: "/archives/", detailPath: "/archives/{id}", searchPath: "/search/{q}/{page}/", cardContainer: "article", announcementCats: ["主题大赛"], staffVerify: { maxBodyChars: 100000, maxBodyImages: 18 }, categoryPath: "/category/{slug}/{page}/", discoveryCategories: [{ slug: "mrds", name: "每日大赛" }, { slug: "rstt", name: "热搜吃瓜", rank: true, hot: true }, { slug: "xazd", name: "校园学生" }, { slug: "blyp", name: "必撸大赛" }, { slug: "fctg", name: "反差泄密" }, { slug: "mhds", name: "网红黑料" }, { slug: "lqdp", name: "猎奇重口" }, { slug: "jdsj", name: "AV看片" }, { slug: "mxwh", name: "明星大赛" }, { slug: "smdh", name: "动漫之家" }, { slug: "dypd", name: "影视国漫" }, { slug: "mtds", name: "cos写真" }, { slug: "ysds", name: "声控ASMR" }, { slug: "czds", name: "寸止挑战" }, { slug: "hjds", name: "混剪PMV" }, { slug: "tgds", name: "原创投稿" }, { slug: "omjp", name: "欧美精品" }, { slug: "qwcs", name: "全网参赛" }, { slug: "aijc", name: "AI剧场" }] } },
    baseUrls: ["https://www.mrds66.com", "https://meiridasai.com"],
    enabled: true, order: 31, maturity: "probe",
    capabilities: POST_SEARCH_CAPS, network: PROBE_NET, note: "3.3.0 接通批（2026-11-19）解 blocked：旧主域 meiridasai.com 本机出口复测仍 Cloudflare 525（原 blocked 证据于旧域仍成立、留作次选）；备用镜像 www.mrds66.com（与远程清单 v3 同口径、在前）住宅出口四级验收全通（source-verify-20261119）＋本机出口四级实证——首页 200、列表 post-card（/archives/<id>/）按 /page/{page}/ 校准（旧 /?page= 作废）经生产适配器解析出条目、详情正文＋m3u8 取流解析通过、搜索 /search/{q}/{page}/ 真出条目且分页有效（无意义词落 /search-empty/ 真空页）；浏览面经 SourcePosts 接线；App 侧未真机验 → probe。3.3.5 fix335/b-purify 启用详情层异步验杀（params.staffVerify）：置顶公告卡 3 张（网址说明型 47559/招募 193721/合作计划 161308）为无 h2、无分类词元的异形卡，L1 词元判据结构性不可达；详情量测（2026-11-20 本机实拉，生产量法）——公告 3 帖 eps 恒 0、正文图 15–16、正文 1335–3566 字，内容 19 帖 eps 恒 1、正文图 21–42、正文 1000–1398 字。审计预估 {≈900 字,≈6 图} 被实测双双证伪（公告字数与图数均越界），校准为字数不承重（阈值置 100000）∧正文图≤18（图空带 17–20 取 18），判据实效＝eps=0∧正文图≤18。残余同形风险与 feedheiliao 同类：无流∧图≤18 的真内容帖在量测样本内不存在。证据 fix335/evidence/b-purify.md",
  },
  {
    id: "xiuren", displayName: "秀人网", kind: "image", category: "image",
    adapter: { template: "wp-rest", params: { restBase: "/wp-json/wp/v2", listPath: "/posts" } },
    baseUrls: ["https://xiuren.biz", "https://xiuren.com"],
    enabled: true, order: 40, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false },
    network: PROBE_NET, note: "fix330 图片线解 blocked＋校准（2026-11-19）：生效域名改 xiuren.biz 在前（远程清单 v3 同口径）——xiuren.com 住宅三轮＋本机均 DNS 不可达（source-verify-20261119 第一至三轮）；xiuren.biz 本机出口四级实证全通（首页 200、/wp-json/wp/v2/posts 200 真条目、详情 200、图集出图 206）＋搜索端点 200 有结果（证据 fix330/evidence/images.md）；wp-rest 适配器按 .biz 实抓校准（参数不变、形态与模板一致）；App 侧未真机验 → probe（非 blocked 呈现）",
  },
  {
    id: "cosplaytele", displayName: "CosplayTele", kind: "image", category: "image",
    adapter: { template: "wp-rest", params: { restBase: "/wp-json/wp/v2", listPath: "/posts" } },
    baseUrls: ["https://cosplaytele.com"],
    enabled: true, order: 42, maturity: "stable",
    capabilities: HLS_CAPS, network: PROBE_NET, note: "真站实测（2026-11-19）：本站为 WP 站、/wp-json/wp/v2/posts 列表实测可达、详情正文实测 103 张图（图集型、wp-rest detail.images 承接）；原 HTML slug 列表参数作废",
  },
  {
    id: "iwara", displayName: "Iwara", kind: "video", category: "video",
    adapter: { template: "iwara-api", params: {} }, baseUrls: ["https://www.iwara.tv", "https://api.iwara.tv"],
    enabled: true, order: 54, maturity: "probe", capabilities: HLS_CAPS, network: PROBE_NET,
    note: "fix330 接通批启用：专用 API 适配器（api.iwara.tv /videos 列表、/search 搜索段、/video/<id> 详情、fileUrl＋X-Version 签名取流，结构据公开插件 iwara.js 协议事实＋解析夹具实证）；住宅出口四级验收全通在案（source-verify-20261119，引存档）；本机机房出口为 CF 403（出口形态、非站点结论）；App 侧未真机验 → probe。【fix3310/video-add-2 试装恢复 2026-11-21】同 009 试装口径：3.3.9 删除批删码、本批原样恢复（含签名链与 Rust X-Version 定向放行），过关才回归、不过删回",
  },
  {
    id: "everia", displayName: "Everia", kind: "image", category: "image",
    adapter: { template: "wp-rest", params: { restBase: "/wp-json/wp/v2", listPath: "/posts" } },
    baseUrls: ["https://everia.club"],
    enabled: true, order: 122, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false },
    network: PROBE_NET, note: "fix338/realphoto-add 新增（2026-11-20）：真人图片候选准入 C1（候选调查 fix338/evidence/realphoto-candidates.md §三）——与 006/007/012/013 逐字同形 wp-rest（/wp-json/wp/v2/posts，本机出口实证：列表 200、x-wp-total 50800、详情帖图集各 120 张、图床无 Referer 直拉魔数真图、搜索端点 200 真结果），模板实例化零新适配器代码；编号 018（注册表位置号，order 122 置末）；App 侧未真机验 → probe",
  },
  {
    id: "xsnvshen", displayName: "秀色女神", kind: "image", category: "image",
    adapter: { template: "hls-site", params: { listPath: "/album/?p={page}", itemLinkPattern: "/album/", itemLinkRegex: "^/album/\\d+$", detailPageParam: "p", detailImagePattern: "/album/\\d+/{id}/\\d+\\.jpg" } },
    baseUrls: ["https://www.xsnvshen.com"],
    enabled: true, order: 123, maturity: "probe",
    capabilities: NO_CAPS, network: PROBE_NET,
    note: "fix338/realphoto-add 新增（2026-11-20）：真人图片候选准入 C2（候选调查 fix338/evidence/realphoto-candidates.md §三）——hls-site 锚点骨架按校准点落地：列表 /album/?p={page}（导航末页 1800）；itemLinkRegex 收紧条目形态（裸子串 /album/ 会误收分类页/隐藏空锚/分页锚，实测 132 vs 真卡 25）；详情服务端分页 ?p=N 每页 10 张、detailPageParam 逐页组装整册＋detailImagePattern 只留本册全尺寸图（内容区混排他人图集缩略图 40 张须滤）；图床 img.xsnvshen.com 防盗链判据＝Referer 须本站域且路径以 /album/ 开头（无 Referer/根 Referer 均 403、本批实测矩阵），详情图经 /img 的 p= 参数带详情页 Referer 进候选链（见 net/edge.rs）；搜索未验 caps.search 维持 false；编号 019（order 123 置末）；App 侧未真机验 → probe",
  },
  {
    id: "hentaigasm", displayName: "HentaiGasm", kind: "video", category: "video",
    adapter: { template: "wp-rest", params: { restBase: "/wp-json/wp/v2", listPath: "/posts", jwFile: true } },
    baseUrls: ["https://hentaigasm.com"],
    enabled: true, order: 124, maturity: "probe",
    capabilities: { search: false, episodes: false, hevc: false },
    network: PROBE_NET, note: "fix3310/video-add-2 新增（2026-11-21）：视频候选准入 V1（候选调查 fix339/evidence/video-candidates.md，播放级实证）——wp-rest 列表/详情与 018 同模板；流地址在正文 JW Player setup 的 file: 字段（hgasm2.com MP4 直链、文件名含空格），经 opt-in 参数 jwFile 走 parse.ts 小解析提取、封面回落 JW image:（hgasm1.com）；全链非 CF（主站 Apache＋文件域 nginx 直连、无令牌无挑战）；内容以 Raw（无字幕）为主、单档无多画质；搜索未验 caps.search 维持 false；编号 020（order 124）；流走 kind=file 新播放腿（fix3310/file-playback-leg），App 侧未真机验 → probe",
  },
  {
    id: "hentaiplay", displayName: "HentaiPlay", kind: "video", category: "video",
    adapter: { template: "wp-rest", params: { restBase: "/wp-json/wp/v2", listPath: "/posts", yoastCover: true } },
    baseUrls: ["https://hentaiplay.net"],
    enabled: true, order: 125, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false },
    network: PROBE_NET, note: "fix3310/video-add-2 新增（2026-11-21）：视频候选准入 V2（候选调查 fix339/evidence/video-candidates.md，播放级实证）——wp-rest 与 018 逐字同形、零新适配器代码：content.rendered 直含 hentaiplanet.info MP4 直链（stock extractMp4 命中）、搜索端点实拉 20 条真结果 caps.search=true；封面订正（fix3312/cover-021，2026-11-21）：接线时「封面不在 REST 载荷内」只查了正文/excerpt 的 <img>——逐 key 穷尽复核实证封面一直在载荷内：yoast_head_json.twitter_image 直载封面 URL（与 featured_media 同一文件、详情页 twitter:image 同值；站点无 og:image），经 yoastCover opt-in 在 toItem 封面链末位回落消费、列表一次取数可得，实测三页 60 帖 59 帖有值；Yoast 个别帖不发该字段（约 1/60）如实留空、不合成地址；主站 CF 前置仅取页面、文件域 Apache 非 CF（与 009/010 死因结构不同）；英文字幕、单档无多画质；编号 021（order 125）；流走 kind=file 新播放腿，App 侧未真机验 → probe",
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
