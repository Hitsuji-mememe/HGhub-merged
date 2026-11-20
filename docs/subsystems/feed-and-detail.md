# Feed 与详情

## 责任与边界

Feed 负责列表播放页的条目位置、详情/帖子读取、标签门、详情/评论/选集面板、
相关推荐和动作上下文；详情子组件只消费已经归一化的 `Detail`/`Post` 数据。
播放器的媒体生命周期、seek 和 HLS 恢复归 [playback.md](playback.md)；
线路、代理、账号凭据分别归各自的子系统页。

## 事实来源

- [`src/features/feed/Feed.tsx`](../../src/features/feed/Feed.tsx)：`requestPlay`、
  `useFeedDetails` 的调用、`tagKey`/`permissionKey`、`effectiveVideoIds`、
  `details`/`posts`、`relatedByVideo`、`actionContext`；视口/手势/动作与界面覆盖层
  均在 `Feed.tsx` 本体内（合并版定版单体实现）。注：上游 v2.2.0 重发版曾把这部分
  抽为 `useFeedViewport.ts`、`useFeedTouchGestures.ts`、`useFeedActions.ts`、
  `FeedItemChrome.tsx`、`FeedPlayerShellChrome.tsx`，跟版合并（Muse 2026-11-18）
  未吸收该重构（与定版语义正面冲突），五文件已删除，勿再引用。
- [`src/features/feed/useFeedDetails.ts`](../../src/features/feed/useFeedDetails.ts)：
  `detailRequests`、`requestDetail`、`effectiveVideoIds`、`detailsRef`。
- [`src/features/feed/Panels.tsx`](../../src/features/feed/Panels.tsx) 的
  `CommentsPanel`、`EpisodesPanel`、`ArticlePanel`；
  [`src/features/feed/VideoDetailsPanel.tsx`](../../src/features/feed/VideoDetailsPanel.tsx)。
- [`src/shared/model/store.tsx`](../../src/shared/model/store.tsx) 的 `lineEpoch` 和 `accountScope` 传递；
  [`src/shared/model/accountData.ts`](../../src/shared/model/accountData.ts) 的 `generation`；
  [`src/shared/model/contentPreferences.ts`](../../src/shared/model/contentPreferences.ts) 的 `blockReason`。
- 后端读取：[`src-tauri/src/api/feed.rs`](../../src-tauri/src/api/feed.rs)、
  [`src-tauri/src/api/video.rs`](../../src-tauri/src/api/video.rs)、
  [`src-tauri/src/api/interact.rs`](../../src-tauri/src/api/interact.rs)。

## 主运行时路径

1. Feed 使用 `api_feed`/分类/搜索/list page 传入的 `videoIds`，不自行重新请求列表。
   全局搜索（最终版 D3，`src/features/search/Search.tsx`＋`multiSourceSearch.ts`）：黄果视频/帖子与外部源扇出统一聚合——页签按内容种类封顶四类（视频/短剧/帖子/图片）、同类全源混排、跨源同标题合并保留全部副本；黄果条目仍以数值 id 经 `push({kind:"feed"})` 进 Feed（口径不变），外部条目在搜索页内经适配器 resolve/detail 呈现，不进 Feed。
   3.2.1 F1 同源去重口径：黄果不进扇出（`FANOUT_EXCLUDE_NATIVE`，原生视频＋帖子两路已完整覆盖，扇出 native 适配器只会重复 `api.searchPosts`）；聚合层同源重复必合并——同源同 ID 合并且副本按 `(sourceId, externalId)` 去重（不留假副本、`identityConfirmed` 保持 true）、同源同标题＋同封面合并，同源非重复仍独立；跨源合并仍走多信号置信门（≥3 合并、≥4 身份确认），不因同源口径削弱。渐进呈现 `onPartial` 传累计快照、呈现层每次经 `aggregateHits` 全量重聚合，跨批到达的重复同样在最终呈现层合并。
   fix322/play 修订（用户 3.2.1 真机裁定）：副本层与卡片层共用同一去重判定——同源 content 重复（同标题＋同封面、不同 ID）并卡后**不留第二副本**（F1 的「两 ID 副本各留一份」使详情「来源副本」出现同名双副本，作废），只留高优先第一份，`alsoOn` 不重名；判定次序改两遍扫描——同源判定（确定性：先 id 后 content，全簇）优先于跨源置信（概率性），逐簇混扫会让后到的一份被先建簇的置信匹配截走（双路到达的 publishedAt 完整度差异即可造成同一条目劈进两张卡）。契约 `fix321-f1.contract.test.ts` 已按新裁定修订并补跨源簇内重复与置信截胡两例。列表页口径：原生频道/发现列表走 `shared/lib/dedup.ts` 按 ID 去重；外部源列表的同名重复卡实例（Pornhub）随产品瘦身删源消解，剩余面无第二组装路径。
   扇出资格搜索段结构门（3.2.1 修复 F5 立三段齐全门；2026-11-19 20:48 用户裁定放宽、3.2.2 改判，`missingSearchSegments` 只判结构）：保留源具备搜索段（模板真有 search 方法＋`capabilities.search` 声明）且已启用即进扇出；`maturity` 验通状态与参数校准状态不在搜索入口预判（可播性后移详情/起播解析与线路故障转移，验通状态由 F7 自检与 maturity 标注如实呈现）；旧 `OFF_IDS`/`INCLUDE_OVERRIDE` 名单特例已退役。无搜索段源静默出局（不发请求、不记失败）、注册保留、频道浏览不受此限。注册表已按 2026-11-19 瘦身定版收口为 18 源（短剧为主、吃瓜其次、图片顺带、视频只留里番；普通视频/myfans/停用杂源摘除、适配器源码留仓），现行扇出名单恰为 8 源（黄果/Hanime.tv/Rule34Video/秀人网/CosplayTele/Danbooru/PixiBB/NudeCosplay，逐源口径见 `fix321-f5.contract.test.ts`；2026-11-19 fix330 图片线属实适配：PixiBB/NudeCosplay 实证启用新进、PornPics 搜索属实改 false 出局，见下方图片线条目）。
   分类浏览（`src/features/category/Category.tsx` 总览与频道页）与搜索共用同一性质判定（`src/shared/lib/contentKind.ts`，3.2.1 F4 线抽共用、搜索层只 re-export；fix322 起最终裁决为 `resolveHuangguoKind`，见下段）：有分集结构（`total_episodes`/`episode_count`＞1）的条目只归短剧——总览视频区只渲染 video 组、original 频道混入的 drama 组补入短剧区（按 id 去重）；「视频」频道页服务端分页 incoming 先剔 drama 组再入列表，`page`/`pages` 仍按服务端原值推进与终止（单页可见数可少于页大小、整页被滤光时靠哨兵/加载更多续翻下一服务端页，不提前到底）。此前浏览面按频道直渲染 original 列表，《警界之花》（3 集）同时出现在短剧与视频两区（用户实报）。
   搜索面同病（3.2.1 F4b 线）：通用搜索端点 `/api/search?type=video` 的载荷不下发剧集结构信号（字段缺失或恒 0；本地 Rust/前端三层审计无丢弃点、信号丢在上游响应本身，证据 `fix321/evidence/f4b/root-cause.md`），同 ID 条目在频道/详情里却有——判定函数在场也无信号可用、必然默认落视频（搜「御姐」视频页签混入同批 AI 短剧，用户实报）。搜索归类改走 `contentKind.searchKindForHuangguoVideo`（仍为唯一出处）：卡自带正计数信号直接判；信号缺失者由 Search 以条目 ID 查 `api.video` Detail 规范信号补判（`hgCanonicalSignals`，作用域＋线路代次进 key、并发 4、失败静默）；补判也无信号 → `unknown` 安全侧暂扣、不进任何页签（不默认落视频、不猜落短剧），补判到达后自动重归类。代价：详情不可达条目在搜索中暂不可见。
   归类标记线（fix322，3.2.1 真机复报）：结构判定上线后单集短剧仍漏进视频区——单集短剧与普通视频集数同形（1 集），结构信号本身不构成性质证据。上游实测（2026-11-19）：列表/搜索载荷全字段（25 键）无任何品类标记，显式标记只在 Detail 的 `tracking.drama_type_id`（上游官方分类表 `/api/site/categories/video`：24=短剧、25=漫剧 → 短剧；26=AI换脸、27=AI魔改 → 视频；`video_type` 恒 1 非标记）；抽样 17 条 Detail（集数 1..42）标记全部 24/25，锚点《我的怪力母狗》（id 13765，列表 1 集）Detail 标记 24。裁决优先级定版（`contentKind.resolveHuangguoKind`，全归类面唯一出处）：①显式标记（卡自带→canonical 补判）为准、结构不得推翻；②无标记时结构只在 ＞1 集方向决定性成立；③≤1 集且标记不可得 → `unknown` 暂扣、绝不默认落视频。补判接缝同步升级：规范信号一律经 `kindSignalOfDetail` 单点构造（集数＋tracking 标记——fix322 前三面补判只摘集数、标记在提取点被丢，是本 bug 的直接成因）；触发门 `needsCanonicalKindLookup`（无自带标记且集数 ≤1 才查，多集结构已定不查——其标记与结构一致有抽样支持，多集 26/27 为已知漏检边界）；浏览面一并接入补判（推翻 F4b 期「浏览面不走补判」旧结论：频道载荷集数是真的，但 ≤1 集本身歧义）——总览经 `useCanonicalKindSignals` 异步补判后以 `partitionCardsByResolvedKind` 分组（unknown 不渲染）、频道页每页 incoming 先 await 本页补判再只入 video 组（`kindFiltered` 计数口径随之含暂扣数）。代价：补判不可达的单集条目在归类面暂不可见（换归类正确性，承 F4b 安全侧）。
   频道页接缝再修订（fix330/ui-fixes，3.2.2 真机复报 device-verdict-322 #10）：fix322 的「频道页每页先 await 补判再入列表」在整页待判时把分页堵在 Detail 往返上（并发 4、单查 15s 超时、requested-once 失败永不重试），整页被滤光时哨兵只能以补判速度翻页——真机「已加载 0 部·4/13 页」持续转圈无终态。现改渲染期分组：原始页先落座（分页只受接口速度与服务端 pages 约束），补判由 effect 非阻塞触发、信号到达经 version 自增重算归位，呈现集在 render 期以同一符号 `partitionCardsByResolvedKind(rawItems, kindSignals.signalFor).video` 现算；上游耗尽（page≥pages）且呈现为空时落诚实终态「暂无已确认条目」，绝不空转。traceFeed page.success 不再记 kindFiltered（落座时信号未齐、计数只会是假数）。证伪夹具 `tests/list-lifecycle.tsx` channel-spin 场景（三页全无标记单集＋api_video 永不返回：旧实现驱动超时、新实现落终态），驱动 `scripts/test-list-lifecycle.mjs`。
   总览空区隐藏（fix330/ui-fixes，用户裁定）：分区「已尝试∧非加载∧无错误∧条目为 0」时整区不渲染（含视频区），谓词单点 `src/features/category/overviewSections.ts` 的 `contentSectionVisible`；频道区 attempted 取 errors 落痕（loadPreview 起始即写），吃瓜区黄果模式走 posts 状态、外部源 browse 模式经 `SourcePosts` 的 `onSettledEmpty` 回报（首批已结∧空），图片区无已启用源时整区不渲染。加载中/未尝试/出错一律保持可见（错误态与重试入口不被整洁吞掉）；blocked/pending 诚实提示不是内容区、恒可见。契约 `overviewSections.contract.test.ts`。（fix336/ui-fixes 已改：总览改四频道行后无数据驱动分区，谓词、`overviewSections.ts` 与其契约一并删除，见上方 fix336 段。）
   里番面接线（fix330-riban-surfaces，3.3.0 真机首验复报）：视频品类四源（hanime-api/iwara-api/hanime1/hentaihaven-api 模板）在总览缺席——总览此前只有图片区有源入口列示、吃瓜区有源切换器，视频品类只能先进「视频」频道页再切源片到达（注册表已启用≠浏览面已接通在视频面的复发，与清单 v2 将其中三源置 enabled=false 无关、纯属区段缺席）。现总览新增「视频源」区：与图片区同列示口径（`sourcesForCategory("video", activeSources)`、probe 带「未实测」标、空集整区不渲染），点开推 `cate="video:<源id>"` 深链（与 `image:<源id>` 同约定、不新增路由 kind），`ChannelPage` 专属分支经 `SourceBrowse` 取数、源缺失/blocked 走诚实提示，原生频道加载 effect 对 `video:` 前缀同样跳过。详情面：搜索副本加载核抽为纯模块 `src/features/search/copyLoader.ts`（`loadSearchCopy`，依赖注入、Search 只组装生产依赖），video/drama 分支改先走适配器 `detail` 段（缓存复用、失败降级不阻断取流）再 `resolve`——此前直调 resolve、单副本时详情面 detail 恒 undefined（描述/分集全缺），且失败只能落在从未被探过的 resolve 段。逐 seam 普查结论：App 内路径（结果卡→openMerged→openExternal→loadWithFallback→加载核→createAdapter→detail/resolve；main.tsx 注入；Rust source_fetch/source_post 注册与白名单）无断点，002 适配器本机真实网络 list/detail/resolve 全通；真机失败段收窄在 resolve 独有三段（ct 域 GET/WebCrypto/auth 域 POST＋设备出口），F7 自检只探 list+detail 不探 resolve——该缺口待后续自检扩探针解决，本批不冒充已修。契约 `fix330-riban-surfaces.contract.test.ts`（category/search 两份，四源逐源场景＋列示口径，基线旧红）；接线清单 fix330-riban-* 三条。（fix336/ui-fixes 已改：总览「视频源」区段退场，四源列示迁视频频道切源片、`video:<id>` 深链分支保留，见上方 fix336 段。）
   当前条目由 `position` 与 `effectiveVideoIds` 锚定；列表变化时优先保持正在播放的 id，
   找不到才取相邻可见项。
2. 详情读取走 `useFeedDetails.requestDetail(id)`。single-flight key 是
   `` `${accountScope}:${lineEpoch}:${id}` ``，最多保留 12 个进行中 Promise；
   成功结果放入组件内 `details: Record<number, Detail>`，失败不写入成功缓存。
3. 帖子读取走 `api.post(id)`，结果进入 `posts: Record<number, Post>`。Feed 的
   标签门、正文入口和播放界面从同一个 `Post` 归一化视图读取。
4. 标签门只在 `filtering` 时成为媒体闸门：
   `filtering = !preferences.paused && (blockedTags.length > 0 || hideUntagged)`。
   需要读取的候选是当前项以及前后各一项；普通模式只读当前项。
5. 标签门的键是 `` `${accountScope}:${lineEpoch}:${kind}:${id}` ``。
   `checked` 只在成功响应后置 true；`tagErrors` 保留可重试错误。
   失败不会把标签当成空数组；启用过滤时，读取失败继续阻止媒体请求。
6. `allowed = !filtering || (tagsReady && !blocked)`：普通模式直接允许；启用过滤时，
   必须成功读取标签且 `blockReason` 为空才允许。`allowed` 之前不请求播放地址；
   在首页被屏蔽时通过 `onBlocked` 跳过，在上下文播放页则关闭面板。
7. `requestPlay(id, episode)` 的 key 是
   `` `${accountScope}:${lineEpoch}:${id}:${episode}` ``，最多缓存 12 个 Promise。
   当前集开始播放后，才预取下一集的地址；下一部视频还要先通过详情/标签检查。
8. 评论面板使用 `api.comments` 或 `api.postComments`（仅短剧开放评论发送，帖子评论只读，
   不向短剧接口串写），选集使用当前 `detail.episodes`，
   详情面板显示作者/标签/相关推荐。桌面端停靠 `desktop-dock-panel`，移动端使用
   `Sheet`；面板本身不在 Feed 之外维护第二套详情缓存。抽屉纪律（蓝图 P2，
   2026-11-18 真机批改版）：移动端操作行只剩「选集」单入口、恒落选集页
   （蓝图双入口与落点/页签记忆已按用户极简裁定删除——详情/评论只在
   抽屉内点页签到达，重开必落选集）；详情页只留简介与元信息、无选集
   网格（选集只存在于选集页）；页签只准点按切换（不许横滑切页）；
   抽屉底为实心 #191B20（opacity 1、无 backdrop blur），且抽屉内文字
   色阶在子树作用域内配套钉死（正文 #F5F5F5、次级不低于 #A1A5AD，
   不随环境主题漂移）；打开抽屉不
   暂停、不重建播放器，关闭恢复原播放状态，选集点中即播并关抽屉。
   选集网格每行 5、热区 44px、当前集高亮，>30 集按 30 集一段分组
   （初始段落在当前集）。
9. 相关推荐只在 `panel === "detail"` 时调用 `api.related`，缓存键是
   `` `${lineEpoch}:${curId}` ``。它不是首播前的预取，避免和视频地址争网络。
10. 动作使用 `actionContext = { accountScope, lineEpoch, id, ep, kind }`。
    请求返回后，`actionIsCurrent()` 再比较这五个字段；旧账号/旧线路/旧集数的结果
    不弹 toast、不更新视觉反馈。动作 pending key 也带 `accountScope`。

## 状态转换

- 条目切换：更新 `position`/`renderIndex` → 清理标签菜单和面板 → 重置播放 key →
  按新 key 读取详情/标签 → 允许后才请求播放地址。
- 标签门：未读 → loading → `checked=true`（再按 `blockReason` 判断）或 `tagErrors`（显示重试）；
  启用过滤时依据结果放行媒体；设置或账号/线路变化会使旧键失效并重新判断。
- 过滤结果：`effectiveVideoIds` 先按 `checked`/`tagErrors`/`blockReason` 过滤；
  正在播放项被移除时锚定相邻项，避免列表突然跳回第一屏。
- 详情加载：`requestDetail` 进行中 → 成功写入 `details` 和 `detailsRef` →
  面板可见；失败保留已有对象，不把 `undefined` 写成“无标签”。
- 动作：用户点击 → pending → 成功更新本地收藏/喜欢/关注 → 若上下文仍匹配才反馈；
  失败只提示错误，不凭空翻转状态。

## 约束与失败行为

- `details`/`posts` 是 Feed 实例的局部状态，不是跨应用持久缓存；页面销毁后重新读取。
  这避免把旧标签或旧正文带进新会话，但也意味着返回 Feed 时可能重新请求。
- 详情读失败不能标记 `checked`，不能把 `tags` 当空数组；启用过滤时不能让播放器抢跑。
  标签门重试会删除对应 `tagErrors` 并增加 `proxyRetry`。
- `useFeedDetails.requestDetail` 的 key 按账号/线路隔离、去重进行中的请求，本身不校验响应
  是否仍可写入。详情/标签 effect 返回后检查组件仍挂载及 `actionContext` 的账号/线路；
  动作返回后另由 `actionIsCurrent()` 校验完整动作上下文，防止旧结果更新当前反馈。
- 标签过滤不是内容搜索：`normalizeTag` 只做大小写/空白归一，不做模糊匹配；
  未知标签按 `hideUntagged` 处理。
- 相关推荐不做后台无限预取；关闭详情面板或切换条目不会删除 `relatedByVideo` 中的旧键。
  缓存留在当前 Feed 实例，读取按 `lineEpoch:curId` 隔离，不把旧线路键当作当前结果。
- 评论/选集面板只在 `active` 且 `allowed` 时保持开放；被覆盖时关闭，不阻塞返回键
  或下层 Feed。
- 分页显式状态机（fix2 Batch A，2026-11-19）：`usePaginatedList` 是唯一分页
  实现（吃瓜/用户作品共用）——哨兵只提请求；同页禁并发（seq+代次丢迟到
  响应）；单请求 30s 超时释放 loading 锁并可重试；终止只认接口
  `pagination.pages`（回落链 pages→末页条数推断→空页，total 仅作诊断
  对照不作终止依据）；哨兵常驻渲染（错误态改文案不卸载）。手写分页页
  （频道/专题/标签）同口径：30s 超时（`withTimeout`）、pages 回落修正、
  哨兵去 err 门。请求/哨兵/失败全程经 `feedTrace` 证据环进诊断报告。
  fix2.1 补强：reset 成功后同样走预取调度（受 `MAX_AUTO_PREFETCH`
  上限约束）——首屏过矮时哨兵边沿在 reset 前已被消费，排除 reset
  会让短列表停在第一页；频道页换筛选时 pages 基线归 1，不再与旧
  筛选的 pages 取 max（响应缺 pages 时回落链按新基线算）；`feedTrace`
  事件全带 `list` 标识、`feedTraceSummary` 按列表隔离汇总，诊断报告
  逐列表输出，多列表同会话不再混算。
  3.2.2 集成批：全部分页信息流统一为接近底部自动加载——
  `usePaginatedList` 的 `filtering` 门已撤销（开标签屏蔽时哨兵与
  预取链曾被整体停用、只剩手点按钮，用户实报；连拉由
  `MAX_AUTO_PREFETCH`＋接口 pages 终止＋失败 3s 冷却兜底）；频道页
  与专题/标签页（Discover）的手写哨兵同去 filtering 门；源浏览/
  图集页（SourceBrowse/SourceGallery）与两处搜索结果（Search/
  InplaceSearch）补上哨兵自动续页，手点「加载更多」只在自动失败
  后作兜底出现。证伪夹具：`tests/list-lifecycle` 的 autoscroll/
  autofail 场景（`scripts/test-list-lifecycle.mjs` 驱动）。
  fix335/a-pagination（2026-11-20）：外部源列表的分页信号根治——
  此前除 002 外全部适配器的 `pagination` 只装本次取回条数
  （pageOf 口径、已取冒充总数），三套源 UI 以 page≥pages 停拉：
  006/008/011/012/009 第 1 页见底、003/004/005/010 第 2 页见底；
  HTML 型另有 slice 恒跳每页尾部卡片（005 每页漏 10/30）。现行
  信号契约（`adapters/templates.ts` 的 apiSignal/htmlSignal＋
  `adapters/parse.ts` 的 lastPageInNav）：真信号优先——HTML 导航
  末页（按 listPath 模板形状扫 href 取最大页码、窗口式导航自校
  正）、API 总数字段（iwara 的 count、redgifs 的 pages/total）；
  无真总数时满页推断（本页满额→暂报 page+1、不满→page、空页→
  page−1），推断的终止由三件套兜底：不满页收尾、第二页起空页
  按导航覆盖判前进/收尾、三套源 UI 的整页零新增终止（整页与已
  加载全重即以当前页为尾页）。HTML 型整页消费（UI 页与站方页
  1:1、删 slice）；第一页 0 卡仍抛 `SourceParseEmptyError`（未
  知不是空不变）。WP 系（006/008/013/014）：总量在 X-WP-Total
  响应头、取页通道只回正文不可达，故走满页推断；越界页恒回
  HTTP 400 `rest_post_invalid_page_number`（2026-11-20 对
  006/008 live 实证），page>1 撞 400 按越界收尾返空页、page=1
  的 400 仍如实抛错（残余风险：他因 400 会被误判到底，代价是
  少看尾页，权衡记于 templates.ts 注释）。三套源 UI 同步对齐：
  哨兵失败冷却 3s（对齐 ERROR_RETRY_COOLDOWN_MS；旧口径 err 一
  置位哨兵整体停摆已除），手点按钮只作失败兜底、到底文案不变；
  自动追加只向下生长列表、不写 scrollTop（滚动恢复归 D 线）。
  SWAG 逐条取数失败改计数留痕（`source.list_skip`，经
  resolveTrace 共享通道进诊断导出账本；成功路径不变）。适配器
  取页行为变更按 M7 纪律 bump `SELF_CHECK_ADAPTER_EPOCH` 至 2。
  证据：`~/workspace/hghub/fix335/evidence/a-pagination.md`（旧红
  harness、逐源信号表、故障注入三项双树实测）。
  fix335/a-album-guard（2026-11-20）：图集详情代次守卫——
  `SourceGallery.openAlbum` 此前是三套源 UI 里唯一无代次守卫的
  详情落点：await 后无条件 setAlbum，慢 detail 在切源/改开他册/
  加载中关闭后落地都会把旧相册覆层复活（A 线故障注入旁记）。
  现行口径：相册面独立 `albumSeq`（照 load 的 seq 形态、同
  SourceBrowse `epSeq` 一面一 seq 先例；与 load 共用会抢占其
  finally 的 busy 复位、闩死列表单飞），openAlbum 取 mySeq、
  落地前比对丢弃迟到响应；切源重置 effect 与全部关闭路径
  （closeAlbum：返回序登记/查看器 onBack/onClose/页内返回钮）
  先行 albumSeq++ 作废在飞请求。证据：
  `~/workspace/hghub/fix335/evidence/a-album-guard.md`（夹具三
  场景双树实测：切源复活/改开覆盖/关闭复活，旧红新绿）。
  fix335/detail-guard（2026-11-20）：详情代次守卫横扫收口——
  album-guard 登记的同病两落点（`SourceBrowse.openItem`、
  `SourcePosts.openItem`）与 Search 外部详情三入口
  （`openExternal`/`manualPick`/`switchCopy`）同型修复：各面
  独立 seq（Browse/Posts 为 `detailSeq`、Search 为
  `extDetailSeq`），打开取号、await 落地前比对丢弃；切源重置
  effect 与全部关闭路径（`closeDetail`/`closeExtDetail`：返回
  序登记、页头/相册返回钮、submit、输入清空）先行作废在飞
  请求。Search 候选两处经核实排除：`evaluateDetail` 只写按
  副本键的缓存与本地评估 Map、无状态落点；`copyLoader` 为纯
  函数、迟到写落对键缓存不碰 UI 状态——病灶是其三个调用方
  的 setExtDetail 落点，已逐个守卫。证据：
  `~/workspace/hghub/fix335/evidence/detail-guard.md`（夹具十
  场景双树实测＋正常路径回归：切副本/手选副本正常落定）。
  fix335/d-scroll（2026-11-20）：外部源三浏览面滚动恢复——三
  组件以分支整树替换实现详情，列表卸载期间宿主 scroller 内容
  高度塌缩、scrollTop 被浏览器钳 0，关闭详情后无人写回、返回
  恒落顶部（用户 14:12 真机实报，审计
  `fix335/audit-scroll-restore.md`：9 条返回路径中恰此 3 条不
  恢复，余 6 条靠栈页/页签保活或覆层并存天然恢复、不接入防双
  写）。现行口径：`src/shared/lib/useScrollKeeper.ts` 单一机制
  ——保存值按 key（面＋源 id，如 `gallery:<源id>`）存模块级
  Map；三组件打开详情/图集前 `captureScroll` 存宿主 scrollTop，
  回列表且数据就位后 layout effect 写回（照 PostDetail F9
  playScrollRef 先例：一帧 rAF 后仍小于目标才再写；高度不足时
  钳到可达位置静默接受，不报错不跳顶）。恢复域收窄：只认本实
  例 capture 过的 key，切面/切源（key 变）先行作废待恢复标记，
  def.id 变化的既有 reset 清零语义不变、保存值不串源。scroller
  由宿主下传：ChannelPage 图片/视频/频道外源三分支与 PostsPage
  非原生分支各持 ref 经 `scrollerRef` prop 传入；未传的形态
  （SourcePosts 分类总览 compact）恢复静默不生效。分页追加只
  向下生长、不触发写回（listReady 不翻转），已加载页数返回后
  不变。证据：`~/workspace/hghub/fix335/evidence/d-scroll.md`
  （夹具三面×三场景双树实测：旧码往返全落 0、新码精确回位、
  切源 B 从 0 起且只恢复 B 自己的位置）。
  fix335/f-discovery（2026-11-20）：源内发现维度——三浏览组件
  列表态顶部共用 `DiscoveryBar`（`SourcePosts` compact 不渲染），
  只渲染 `adapters/templateCapabilities.ts` 的 `discoverySpecFor`
  已登记维度（单一出处、未实证不登记、登记带证据与日期）。
  `list(page, size, disc?)` 的 disc 缺省＝各适配器现行写死行为
  逐字不变；分类进 `SourceItem.cats`、真标签才进 `tags`。登记
  全集：吃瓜三源栏目归档（注册表 params 的 categoryPath＋
  discoveryCategories 为栏目表唯一出处，003 登记 26/004 登记
  19/005 登记 30——公告存档栏目与 003 大赛征集栏目被推广过滤
  全覆盖、登记只会恒解析为空，不登记）；WP 四源 taxonomy
  （categories/tags 端点＋orderby/过滤参数，chips 只取 Top-24）；
  002 客户端重排（目录缓存内 brand 过滤/tag 过滤/views 排序）；
  008 三预设 order:rank/score/favcount（只登记 danbooru 本尊，
  同模板 gelbooru/yandere 未验不登记）；009 九个 sort 繁体原值
  （简体被站方静默回落默认序，适配器只认逐字命中）；010
  sort=views/likes/date；011 只 monthly/all（weekly/daily 被站
  方应用层拒绝、不登记、入参回落 monthly）。滚动恢复 key 扩为
  「面:源:disc 指纹」（`discFingerprint`，空 disc 时与 d-scroll
  逐字一致）：切换维度走重置 effect 重拉并置顶，位置只在同指
  纹内经详情往返恢复。自检降级：DiscoveryBar 经
  `classifySelfCheckResult` 派生，该源 down（列表段失败）时整
  条维度禁用并明示，订阅自检结果、恢复后自动可用；partial/
  unchecked/stale 不禁用。证据：
  `~/workspace/hghub/fix335/evidence/f-discovery.md`；契约
  `fix335-f-discovery.contract.test.ts`（登记表＋逐源行为＋缺省
  路径逐字对照＋指纹规范化）。
  fix335/e-category（2026-11-20）：分类总览索引化（设计
  `fix335/design-category-hub.md` 方案②，用户真机反馈纵深过大
  ＋样式不统一）——总览删全部预览段（频道横滑预览/吃瓜
  compact 预览与 loadPreview 取数链整链退场），频道行与图片/
  视频源行统一为同一索引行组件 `OverviewIndexRow`，点按 1 次
  进既有内页（ChannelPage/PostsPage/深链页）；总览四区名单
  改读 surfaces 派生 `sourcesForSurface`（overview-channels
  为原生恒在行、overview-posts 只供补探名单、overview-image-
  rows/overview-video-rows 为行集），不再本地拼装。总览分工
  自此只答「有哪些频道/源、状态如何」，内容与归类全归内页
  （性质分组的活面只剩频道页，`partitionCardsByResolvedKind`
  在总览的消费随预览退场）。吃瓜 show-batch 补探改挂索引行
  渲染处 `useSourceSelfCheckOnShow(postsRowSources)`（摘除即
  wiring 红，突变已验）；图片/视频行区批量补探原样保留。源
  行徽标仍读 healthCheck 单一派生、逐行与改版前同形；空区隐
  藏谓词 `contentSectionVisible` 保留给源行区（注册表同步派
  生以已结算口径＋计数消费）；页头「N 个频道」改按实际渲染
  派生（频道行 3＋可见行区数），废除旧手算。纵深（设计边际
  模型，夹具同集核对）：真机计数集 ≈3.67 屏 → ≈0.98 屏，
  注册表全启用 ≈1.56 屏封顶。连带收敛：ChannelPage 内 4 处
  原生 id 字面量（切源 state 初值/原生选项/回落/外源分支判
  定）改经 `surfaces.nativeSourceId()` 派生＋注册表 def 取名，
  Category.tsx 内原生 id 字面量清零（postsRoute 1 处与
  Posts.tsx 的 isNativeSource 本地定义 1 处不在本线范围、留
  集成清单）。证据：`~/workspace/hghub/fix335/evidence/e-category.md`。
  集成收敛（2026-11-20，第三阶段）：上列留集成清单两处已收——
  Posts.tsx 回落值与本地 isNativeSource 改经 `nativeSourceId()`；
  postsRoute 改用与 `surfaces.isNativeSource` 同式的模板判据
  （该模块被 surfaces 反向 import，不回引以免成环，同
  templateSegments 先例）。两处行为逐字不变。
  fix336/ui-fixes（2026-11-20，用户亲定分类逻辑重定＋真机三
  报）：分类面四件现行口径——①总览只留频道行：短剧/视频/吃
  瓜/图片四行由 `overviewRows` 单一数组派生、页头计数＝行数
  （恒 4）；图片/视频源行整区退场，源列示出处迁频道内页切换
  器 chips 与 `image:<id>`/`video:<id>` 深链（深链分支保留、
  资料库回访生产者 Profile 不变）。surfaces 同步：总览源行两
  面（overview-image-rows/overview-video-rows）删除、新增
  channel-image 面（与 channel-video 同构），面数 20→19；图
  片/视频源的 show-batch 补探与健康徽标随之迁各频道页的
  `SourceSwitcher`（挂载批量补探＋徽标同一派生），总览只剩吃
  瓜补探名单（overview-posts）一处消费。空区隐藏谓词
  `contentSectionVisible` 与 overviewSections.ts 随源行区退场
  删除（总览再无数据驱动分区）。②图片频道页：ChannelPage 新
  增 `cate="image"` 分支（与深链分支分开），页内
  `SourceSwitcher` chips 切已启用图片源（名单＝surfaces
  channel-image 面同源），默认落点经 `selectedSource.
  defaultSourceId`（最近打开记忆优先、无记忆落首个可用源；
  记忆信号即既有 `hghubx_source_last_view_v1`），blocked 源
  在 chips 挂徽标、点开落 `SourcePendingNotice`。③视频频道
  原生空壳退场：原生「视频」列表的上游确认端点已下线、频道
  恒空（调查 fix336/investigation-336.md 定案），切源 chips
  只列外部源、默认落首个可用外部源（同 defaultSourceId 记
  忆口径），无外部源落诚实空态；surfaces 的 channel-video×
  原生改声明 native-not-in-video-channel 出局。原生专属死分
  支同批清理：ChannelPage 的 `api.originalVideos` 取数臂、渲
  染期品类分组 `partitionCardsByResolvedKind`、「暂无已确认
  条目」确认门终态、ORIGINAL_CATES 子筛、归类补判钩子
  `useCanonicalKindSignals` 全删——性质判定/补判的活面自此
  只剩搜索两面（Search/useSearchResults），contentKind 纯函
  数保留（同源口径不变）；原生短剧/吃瓜面完全不动。站内搜
  索 scope="original" 入口随原生分支删除（InplaceSearch 的
  scope 通道保留）。④DiscoveryBar 收敛（用户实报标签墙碍
  读）：各维度行默认单行横滑（flex-nowrap＋overflow-x-auto）
  ＋整条「展开」入口（aria-expanded），展开才 flex-wrap 全
  量；标签维度经 `discoveryOptions.dedupeTagOptions` 剔除与
  分类同名条目（trim＋不分大小写、label/value 双路比对、已
  选中标签保留防悬空），Top-N 上限与 disc 规范化/指纹口径
  不变。⑤相册宿主同形态：Search 图片详情改 fixed inset-0
  z-40 顶层覆盖＋immersive（与 SourceGallery 逐字同形态），
  双标题栏/壳导航漏出根治；AlbumViewer 的 immersive 口径改
  为两宿主必传。契约 `fix336-ui-fixes.contract.test.ts`（落
  点/去重真值表＋频道名单＋两宿主与总览接线）；fix334-
  surfaces/fix330-riban-surfaces/fix321-f4/fix322-kind/
  fix321-accept-f4 五契约同步适配（退场断言在基线可红、活面
  覆盖不减）；证据 `~/workspace/hghub/fix336/evidence/ui-fixes.md`。
  fix337/008-detail（2026-11-20，3.3.6 真机三报）：①booru 家族
  （008/014/016，danbooru-api 模板）详情恒 1 图定案为单帖单图模
  型事实、非聚合丢图（生产路径实拉：图集型源 detail 50–103 图、
  家族三源恒 1）——正确形态是查看器以已加载列表为画廊：适配器
  toItem 新增条目自带大图 `SourceItem.largeImage`（列表载荷逐帖
  自带、与 detail 同口径 largeField 优先，旧实现只留 preview、
  大图在组装前被丢弃）；SourceGallery 打开相册时经纯函数
  `albumGallery.assembleAlbumGallery` 组装（detail 恰 1 图∧自带
  大图条目 ≥2∧点开条目在列才成立，点开位以 detail 图为准、无
  大图条目不以 preview 充数），AlbumState 带 galleryItems、当前
  条目随 index 跟随（标题/收藏作用于所见条目）；不成立维持单
  册形态，图集源行为逐字不变。搜索宿主同根已由 fix337/search-
  gallery 同批补齐：其「列表」是跨源合并簇，组装先经
  `searchGallery.assembleSearchGallery` 按点开副本所属源逐簇提取
  载体（取该源副本条目、非代表副本；同源同 id 只取首现；跨源
  条目绝不入集），判定/拼装仍走 `assembleAlbumGallery` 唯一出处；
  Search 三落点（openExternal/manualPick/switchCopy）共用组装应
  用点，成立时组装图集覆写 `ExtReady.images`（查看器仍只读
  data.images 单字段，与底栏让位条件同源）、galleryItems 供标题/
  收藏随当前条目跟随（源内宿主同语义），副本切换时 galleryItems
  与选集状态同列显式重算/剔除；不成立维持现行单册形态，图集源
  从搜索打开行为逐字不变。
  ②自检误报机制修（008 图片频道与 010 视频频道同报，跨频道系
  统性）：落盘失败结论与同路径真实成功长期并存——成因两点：
  (a) 指纹失效缺口：fix336 取页形态变更（Rust 取页链 UA）使探
  测结论整类翻转却未 bump 纪元（纪元旧口径只写 adapters/ 行
  为），3.3.5 时段失败结论（设备导出时间戳 18:24/18:35）在
  3.3.6 以纪元 2 指纹判新鲜；(b) 结论只被 TTL/指纹过期驱动、
  真实取数成功无任何推翻通道。现行口径：纪元补 bump 至 3 且覆
  盖面明列整条取页链（含 UA/指纹形态层）；新增成功推翻——三
  浏览面 list 成功经 `sourceHealth.noteSourceListSuccess` 发信
  号，落盘为列表段失败时 `healthCheck.
  reprobeSelfCheckOnListSuccess` 绕过新鲜度强制补探复核一次
  （结论仍只由探针产生：再失败如实保留、不拿浏览成功改写结
  果）。③source-016 真机 403 定案为源站 CF JS 验证拦非浏览器
  客户端（PC 浏览器同出口实测：先弹验证、约 10 秒自动通过后回
  JSON），非出口 IP 被封、非 App 代码问题；备用端点判别（本机
  生产路径实拉）：api 子域不存在、www 与主站同面、konachan.net
  为 safe-only 镜像（样本 rating 全 s、技术可解析但内容范围缩
  减且设备侧验证状态本机不可证）——不切注册表，处置（诚实标
  注/候选切换）归主线。证据 `~/workspace/hghub/fix337/
  evidence/008-detail.md`；契约 adapters（家族大图字段＋detail
  单图钉）／fix336-ui-fixes (E) 组装真值表／fix333-selfcheck-
  trigger (f) 推翻机制＋纪元钉，基线均先红。
- 封面状态机（同批）：`ImageLoad` 状态 loading→decoded→displayed 或
  failed(reason)（http/timeout/decode 分因），每 attempt 20s 超时，
  src 变化自动重试；失败计数与分页证据同节进诊断报告。fix2.1 修正
  超时起算点：attempt 计时自「实际加载开始」（进入视口预热区
  rootMargin 600px、eager 图为挂载时）起算——img 是 lazy，视口外
  根本不发请求，旧实现自挂载起算会把离屏封面的 attempt 依次烧光、
  回滚进来只见永久失败占位。
- 封面地址载体与空封面口径（Muse 2026-11-20 fix331/covers-header）：
  列表封面地址载体不止 img 属性与 loader 属性——个别源的卡片封面
  只存在于内联脚本调用的第一参数（`loadBannerDirect('<直址>', …)`，
  source-005 真站形态），`firstCoverSrc` 三级载体依次取（img 属性 →
  loader 属性 → 脚本直址，只认 http(s)）；三级全落空即无封面，
  `parseAnchorList` 不许再用 `absUrl(base, "")` 把空串补成站点根
  地址冒充封面（假地址经本地路由拉回 HTML 页、解码必失败、整屏
  终局占位——3.3.1 真机 source-005 整屏 HG 的根因）。证伪：
  `fix331-covers.contract.test.ts`＋真站形态夹具
  `fixtures/chigua-list-banner-script.html`；f5 契约里钉旧产物形态
  的一处断言已按新口径改写（断链裁定不变）。
- 卡内推广帖列表层过滤（Muse 2026-11-20 fix333/promo-filter）：
  混在帖子卡里的官方公告/活动征集/软文帖，单信号无区分力（普查
  `~/workspace/hghub/fix333/evidence/adpost-census.md`），改用站方
  分类学组合信号：卡片分类词元（`parse.ts` 的 `cardCategoryTokens`
  取 post-card-info 区裸 span 的分类清单、逐词元精确比对）命中源
  声明的公告类分类（params.announcementCats），或「分类＝大赛栏目
  （contestCat）∧ 标题为栏目公告框式（contestTitlePrefix 开头）」
  组合（栏目分类本身也装参赛内容帖、须叠框式才判）。
  `templates.ts` 的 `parseAnchorList` 可选 promo 参数由
  `htmlListAdapter` 从 params 组装、列表与搜索同口径；未声明的源
  零影响。已声明：51吃瓜（往期活动＋每日大赛框式）、每日大赛
  （主题大赛）；黑料网列表卡无分类字段、组合信号不存在，不实现
  （证据见 `~/workspace/hghub/fix333/evidence/promo-filter.md`）。
  主题变体坑：分类 span 的地标只认两形态公共祖先 post-card-info
  ——005 无 post-card-meta 包裹层，只认包裹层时判据恒不触发（真站
  同字节复测实证）。契约 `fix333-promo-filter.contract.test.ts`＋
  两源真站形态夹具；判定样本 495 卡内容误杀 0、真站 9 页同字节
  复测推广全杀（003 6/6、005 2/2）、内容误杀 0。
- 图片失败留痕段位（同批）：`Img` 可选 `surface` 段位（source-posts/
  source-browse/posts-native 等调用面自报），`feedTrace` 聚合按段位
  分桶（displayed/failed/byReason），逐图事件带包装前地址指纹
  （host#长度）与终局标记；诊断导出「Feed 分页与封面」节印段位分桶
  ＋最近终局失败逐图行（段位/指纹/形态/attempt/耗时档）——此前导出
  只有全局聚合，某面封面失败在诊断里等于不存在。与图集面共用同一
  image 事件口径，不另起格式。契约 `fix331-image-trace.contract.test.ts`。
  **fix333-m5 收敛（O1/O4）**：逐图呈现已收敛为单段——事件逐图行
  （最近 6 条、单耗时档）与 gallery-device 的明细环（最近 12 条、
  指纹/面/stage/attempt/总＋末次双档）在导出里双段并存、同一失败
  两副字段，易被误计为两批失败；现删事件逐图行，逐图留痕只走
  `imageFailures` 明细环一段（聚合计数行口径不变）。面中文标签收
  敛为 `feedTrace.imageSurfaceLabel` 唯一出处，六面齐全（source-
  posts/source-browse/posts-native/gallery/source-list/app），
  此前 gallery/source-list 两面在明细行露英文原名；未知面值回落
  原值。契约 `fix333-m5-diagnostics.contract.test.ts`（含 fix331-
  image-trace (3) 的改钉）。
- 外部源详情页头让位（同批）：频道页（ChannelPage）在 `video:` 与
  「频道内切外部源」两分支渲染外层页头，其内 SourceBrowse 详情自带
  内层页头——详情打开时外层必须让位（`onDetailOpenChange` 回报、
  ChannelPage 据此整块隐藏外层页头），否则双层页头双返回键同屏
  （3.3.1 真机图 1）。详情在本页内呈、非压栈页，让位归宿主。
  证伪：`scripts/test-channel-header.mjs` 页头层数断言（旧码红于
  详情态外层未让位）。
- 设备链模拟门（同批，验收口径）：封面类修复的通过证据须走
  `scripts/test-list-covers.mjs`——真实本地 /img 路由语义（上游
  20s/三试退避/终局 502/去重缓存）＋延迟注入四模型判别：代理量级
  延迟（600ms TTFB）＋并发＝零终局失败；瞬时 reset 型拒绝被路由
  三试＋Img 三试全数吸收（44% 重置率仍零终局失败）；持续拒绝
  （30s 惩罚窗）才穿透且终局失败全为 network（与 3.3.1 真机
  「45 终局失败全 network、零 timeout」签名一致）；上游悬挂则全
  timeout（反签名）。组件级/直连快网通过只算本地初验。
- 横向手势仲裁（fix2.1，fix322/play 修订，fix330/gesture-back 一致
  性批再修订）：App 链式手势优先级——输入/横滚区起手（整体不触
  发，弹层内同规则）> 播放器手势面/进度条区中部起手（fix322 新增
  让行）> 全屏中部 scrub 独占 > 单击/双击/长按（播放器表面内部
  仲裁）> 边缘返回 > 详情页左划下一条。起点分类与终点裁决在
  `src/app/gestureChain.ts`（纯函数＋契约测试），App.tsx 只留 DOM
  胶水；门控常量与边缘返回判定在 `src/shared/lib/gestureGate.ts`
  （全 App 唯一判定源）。fix322 根因：面内横拖 seek 的位移
  （≥72px）与链的方向锁天然重叠，旧仲裁只让行左缘 24px、且误判
  两者「不重叠」——栈内 Feed 页中部右划 seek 被 pop（整个画面划
  出去）、首页左划 seek 被切页签、进度条区起手只被 detailNext 的
  否定条件引用而不挡 pop。定版口径＝手势按起点归属隔离（与
  AlbumViewer 缩略图条同口径）：`data-player-surface`（Feed 手势
  面）或 `data-feed-scrub-zone` 中部起手时本链不接管、面内手势由
  Feed 表面自理；取舍：首页自视频区起手的链式切页签失效，离
  home 走顶栏/页签钮。左划下一条仅在栈顶 feed 页、起手落在详情
  信息区（`data-feed-info-zone`，视频控制层/图文帖信息块）且不在
  进度条区（`data-feed-scrub-zone`）时经 `detailNext` 通道触发，
  语义与桌面 onNext 一致（先下一集、后下一条）。
  fix330/gesture-back 一致性批（3.3.1，用户实报「不单单是误触，
  而且有很多地方它压根不生效，两个极端」）：此前全 App 三套边缘
  返回判定并存（本链全屏布防/72px/锥角 1.8、Feed 面内 20/22px+
  28px 锁定+64px 触发、DialogFrame 20/22px+64px 且无内容豁免、
  guide 类弹层没有），且本链监听挂 main 区、portal 弹层内触摸根
  本到达不了。定版：①判定一处——边缘锚（左右缘各 24px，双缘同
  义）＋距离门 72px＋锥角 2.5＋过程方向锁（途中纵向占优即被滚动
  认领），全部出自 gestureGate.ts；②触发一处——本链监听改挂
  React 根容器（#root），弹层（祖先含 role="dialog"）内触摸可
  达、只许返回动作；Feed 面与 DialogFrame 的自带判定已删（Feed
  只保留起点归属：边缘起手不 scrub/pan/hold、未成手势的边缘拖
  动吞掉；DialogFrame 只保留 runBack 动作登记，guide 类由此首
  次获得手势返回）；③动作同序——返回动作统一为
  `{ type:"back" }`，glue 走与硬件返回键/Escape 完全同序的分发
  （runBack 注册制 → 退全屏 → 文档全屏 → 退栈 300ms 冷却 → 回
  上一页签；手势不退出应用），InplaceSearch 等弹层由此先于退页
  被关闭（旧手势直 pop 与硬件序分叉消除）；④归属补齐——
  AlbumViewer 舞台边缘起手不翻页（与 Feed scrub 同口径，旧版频
  道页内边缘右滑翻页与 pop 同时成立；结构审计 C⑤ 点名），独立
  Player 面无横拖手势（seek 是 range 输入框、归输入豁免）不设
  标记。契约（gestureChain.contract.test.ts）按面覆盖误触组/
  失效组/正例组，基线证伪探针逐条旧红新绿见线报告。
  fix331/gesture-precedence（3.3.1 真机首验）：内嵌详情面（吃瓜
  帖子正文/外部视频详情/图集相册/搜索结果详情，组件局部状态原
  地渲染、不推 App 栈）对只读 topKind 的分类器不可见，曾被当
  页签根——左划落前进链、右划 back 在 glue 落穿到「回上一页
  签」，用户实报想退回列表却切去搜索页签。定版：①资格一处——
  back.ts 新增消费集合探针 `backConsumerActive()`（弹层登记∨
  页 handler 在册，与 runBack 同源），glue 起手采样为
  `nestedBack`，在 decideChainSwipe 与 topKind 同权进栈页分
  支：嵌套面双缘返回、前进链与回上一页签只在页签根（栈空∧无
  嵌套层）成立，detailNext 仍只认栈顶 feed；②落点同源——四个
  嵌套面（SourcePosts/SourceBrowse/SourceGallery/Search 的
  extDetail）在层打开期间以 registerOverlayBack 登记「关本
  层」消费方（与弹层同一机制），硬件返回/Escape 同步受益；
  ③glue 落穿护栏——起手有嵌套资格而落点 runBack 未消费（竞
  态）时本次滑动作废，不落穿退宿主页/切页签。契约新增嵌套组
  6 例（旧码左划给 {tab} 证伪、根面正例逐字不变防误伤）。
  fix333/m6（3.3.2 清扫 P7 专项核查，死区证实并修）：横滚豁免旧
  版只问「有无溢出横滚祖先」——见 hScrollable 即整体封锁，不问
  它在这一拖的方向上还滚不滚得动：横滚条静止位（scrollLeft=0，
  切换器 chips 行的常态）上左缘右滑、滚到尽头时右缘左滑，该方
  向容量为零、横滚自身吞不下，本链又被挡，不返回也不切页签。
  定版：豁免按方向容量裁——glue 起手采样横滚祖先双向剩余量
  （scrollLeft 减小/增大空间，0.5px 容差），classify 并集为方向
  所有权（hScrollOwnsPos/Neg，任一横滚祖先还能吞该方向即归横
  滚，与浏览器滚动链向外传递同理），decide 分发前按方向查所
  有权：被认领的方向整拖归横滚，起手即尽头的方向交回本链正
  常裁决（返回/前进/detailNext 同口径）。边界：所有权起手采样、
  中途不重估——滚到一半才尽头的拖仍归横滚（原生链不中途交
  接）；容量字段缺省（旧描述符）按双向全豁免、不猜测放行。契
  约新增死区组 12 例（复现 6 例旧码全 null、新码逐条成立；对
  照 6 例豁免本义不变），证据 `fix333/evidence/m6-gesture-edge.md`。
- 右侧动作栏（2026-11-18 用户再裁定，恢复同日撤下的版本）：喜欢/收藏/
  评论三钮 + 计数沿上游原样回到移动端与桌面右侧栏——此前判「游客用不上」
  是错的，用户明确用得上。但不做常驻覆层：整栏跟随控制层显隐（移动端
  普通态 `!clean` / 全屏呈现态 `!idle`，桌面 `!clean`），呼出时出现、收起
  时一起消失。评论钮直达面板评论页签；详情仍收在面板页签（选集 | 详情
  | 评论，移动端底部 Sheet、桌面右侧 dock 同构），落点跟随入口语义、
  页签一按切换；桌面键盘 L/S 保留。
- 超分全自动（2026-11-18 用户裁定，取代同日「入口三处一致」）：播放界面
  （普通/全屏底栏/首页右侧栏/桌面 PlayerControls/帖子 Player）的超分入口
  全部撤下；档位由 `effectiveSrMode(srPref, 源宽, 源高)` 按每集源短边
  自动选（≤480 crisp、481–720 natural、>720 off，判据见 SuperResCanvas）。
  用户覆盖只剩设置页「播放」分组的 自动/关闭 两档（`store.srPref`，
  默认自动）；`store.srMode` 仅作旧配置兼容，播放路径不再读。
- 集数入口接线（2.1.2 定版，2026-11-18 修回）：集数/选集语义的入口一按直达
  选集网格，不穿详情面板中转。移动端普通模式底部「详情」与「第X集」是两个
  独立点击目标（单集时「第X集」降为纯文本）；详情只由详情语义入口打开，
  Sheet 落点由打开它的 `panel` 状态决定。全屏底栏与桌面右侧栏的「选集」钮
  同样直达 `episodes`。
- 移动端控制层的布局契约（蓝图 P1，2026-11-18，取代同日全屏底栏契约）：
  `@media(pointer:coarse)` 下 `.ios-button` 最小 44×44（`src/styles/ios.css`），
  一切宽度估算必须按 44px 而非类名里的 w-8/h-8。单一控制层（顶栏 + 底部
  信息/进度/操作行）的全部可点元素 ≥44px、暂停钮 52px；恢复入口 = 顶栏
  返回（全屏时先退全屏），恒在左上 44×44、不参与横排宽度竞争（独立退出
  钮与 54px 预留已随 P1 回退）。几何由 `scripts/test-layout.mjs` 按视口
  矩阵守门：横屏用例走手动进/退全屏验出口（返回）可达，竖屏用例走
  呈现态流程（独立退出钮负断言 + 同套几何探针）。

- 外部源浏览的频道映射与空态（3.2.1 fix321-F2，2026-11-19 真机首验
  「大量不可用」）：频道页切源片只列对该频道有真实品类映射的源
  （`registry.sourcesForChannel(cate)`，只按注册表 category/
  capabilities 字段判定：短剧频道须 video 分类且
  capabilities.episodes=true，当前无外部源满足、只剩原生黄果；
  「视频」频道列全部已启用 video 源；陈旧选择不跨频道生效）。
  浏览面（分类总览/频道/切源片）只显示已启用源，停用源只在
  诊断明细面（`registryDiag.sourceHealthDetailLinesInApp`）可见。
  适配器列表解析为空 ≠ 真空：HTML 锚点模板取到页却 0 条目抛
  `SourceParseEmptyError`，经 SourceBrowse/SourceGallery 既有 err
  通道落显式失败态＋重试；真空（结构化模板空数组）才显示
  「列表确为空」。解析层支持双/单引号属性，锚点无标题时以 href
  末段 slug 兜底（PornPics 图集形态）；肉视频列表按真站校准为
  /home + /v/<id>、PornPics 为 /recent/ + /galleries/（真站结构
  夹具 `adapters/fixtures/real-*.html`，契约
  `fix321-f2.contract.test.ts`）。
  hls-site 详情图片限定内容区（3.3.2 fix332-B1，独立证伪清扫
  新发现）：htmlDetail 整页采集会把页眉/页脚/登录区的站点样式
  图形混进图集（source-007 真站每册恒定 5 张）。现 hls-site 的
  detail 改走 `parse.ts` 的 `contentImgSrcs`：页面有内容区地标
  （<main> 元素或 id="main"/role="main" 容器）时只在地标内采集
  （同名标签深度扫描配平、顺序与重复保留），无地标或未配平时
  回落整页采集（旧行为逐字不变）。限定只挂 hls-site 的 detail
  路径：chigua 的 detail 不经此处（正文图走 contentHtml 提取
  链）、wp-rest/danbooru 的 images 本就来自内容载荷。真站三册
  实证：新集恰为旧集减 5 张样式（17→12/16→11/25→20、集合严
  格相等），契约 `fix332-b1.contract.test.ts`＋夹具
  `adapters/fixtures/hls-detail-gallery.html`。
- 列表层非帖锚点稳杀（3.3.3 fix333/list-noise，2026-11-20 用户
  裁定「清扫扩围到列表层」）：锚点模板整页扫描会把页面 chrome 的
  同形态锚点误收为条目——吃瓜三源普查 9 页实测（证据
  `fix333/evidence/adpost-census.md`）：003 页眉导航下拉 2 条恒居
  清单第 1/2 位、004 页脚站务组 9＋招募组 3 每页重复（p1 占
  44%）、005 为 0；容器内外零交叉。定版：源在注册表 params 声明
  `cardContainer`（003/005=article、004=video-item）时，
  `parseAnchorList` 只认 `parse.ts` 的 `findCardAnchors` 采集的
  卡片容器内锚点（同名标签深度扫描配平）；页面层广告卡由三路
  标记显式排除——ad-item/ssp-placement 容器整块、rel="sponsored"
  锚点、pgx-card 锚点（004 ssp 假卡实测标记），不再靠「外链不含
  条目模式」偶然挡住。template 区间内的容器走回填遍（004 的
  ssp 模板塞真卡克隆：整页时与渲染副本同 href 去重无差别，
  渲染副本缺席的摘录/变体里保住真卡，仓库夹具
  `real-heiliao-home.html` 形态）；容器采集为 0 时回落整页扫描
  （形态漂移不误报空列表，同 contentImgSrcs 地标回落先例）。
  未声明的源行为逐字不变。红线：不做卡内推广帖过滤、不做标题
  关键词规则（普查实测误伤率极高）；封面-only 真帖卡（无标题
  区、裸数字 id 兜底）经 detail 抽查证实为真帖、保留不杀。
  契约 `fix333-list-noise.contract.test.ts`＋夹具
  `adapters/fixtures/chigua-list-nav-footer.html`、
  `heiliao-list-footer-ssp.html`；真实 9 页新旧逐条 diff（消失
  恰为非帖集、保留集标题/封面/顺序逐字不变、005 零变化）证据
  在 `fix333/evidence/list-noise/`。
- 搜索面两件（3.3.3 残余清剿 M4，2026-11-20）：①扇出失败呈现
  （修清扫 P4）——此前 Search 只消费 `fanoutSearch` 的 hits、
  failures 仅经 onFailure 落 `search.source_fail` 日志痕，UI 零
  呈现：部分源失败看不出结果不完整、全部发起源失败与「无结
  果」不可区分。现扇出落定后经 `multiSourceSearch.ts` 的
  `summarizeFanoutFailures` 汇总入 state：分母只计实际发起搜
  索的源（searched ∪ 失败源；无搜索段/未启用的静默出局不入
  分母、不记失败，searchPolicyFor 既定口径不变），部分失败在
  结果区上方一行点名失败源（注册表显示名）＋计数＋重试、全
  部失败走 alert 行且空态换「外部来源搜索全部失败」文案＋重
  试搜索；黄果通道失败行口径不变。②容器判据搜索页采样——
  生产适配器实跑 003/004/005 搜索页各 3 个词条页（同字节交
  叉核对）：003 每页模式锚点 27＝容器内 25＋容器外 2（恰为普
  查导航非帖组、条目内 0）、004 模式锚点 27＝容器内 15＋页脚
  12（条目内 0；且三词条返回同字节页，印证其无 GET 搜索段、
  caps.search=false 的既有口径）、005 容器外模式锚点 0；三源
  漏入 0、真帖误杀 0（005 未入列的容器内锚点逐条归因推广过
  滤的公告类分类命中、属设计内剔除）。搜索页与列表页同构、
  判据无需改动；契约 `fix333-m4.contract.test.ts` 以列表同批
  夹具驱动 search 路径钉同排除集，采样原始页与逐条核对在
  `fix333/evidence/m4-search/`。
- 图集查看器形态（3.2.1 fix321-F6，2026-11-19 用户实报图片太小）：图集查看统一走共用 `AlbumViewer`（`src/features/sources/AlbumViewer.tsx`，SourceGallery 与搜索图片详情同治）——舞台填满可用高度（SourceGallery 为 fixed 覆满视口、搜索详情页内 h-full）、图片 contain 贴边、无写死比例盒子与上下张按钮行；标题/计数/返回/关闭/缩略图条收进悬浮层（静止 3s 自动淡出、中央点按显隐、左右点按与横滑翻页、缩略图点选跳张且当前张高亮定位），index 受控于调用方单份状态。手势归属（fix322/gallery，2026-11-19 用户实报 146 张图集条划不动）：悬浮层的 touch 事件一律 stopPropagation、与舞台横滑完全隔离，缩略图条本体 `touch-action: pan-x` 走原生横滚快速定位；舞台 touchcancel 清手势起点。几何与条手势由 `scripts/test-layout.mjs` gallery 场景守门（舞台占可用区 ≥98%＋源码层无 4/5 写死盒＋146 张条场景：条上横拖不翻页/快划大位移/尾部点选/翻页后跟随可见）。快速滑动不消失（fix330/ui-fixes，2026-11-19 用户真机实报「图片预览滑的快了会直接消失隐藏」）：双机制根治——(1) 舞台窗口化：只挂当前张±1 三帧（`data-album-frame` 按 index 定 key、仅当前张不透明），邻图随挂载预取，旧单 `Img` 以 src 为 key 逐张重挂在慢图源下快翻张张空白；(2) chrome 活动续命：淡出计时新增活动依赖——缩略图条 `onScroll` 与悬浮层 touch 经 `pokeChrome`（500ms 节流）重置计时，旧计时只挂呼出/切张，条上划找图满 3s 整层在指下淡出。夹具：layout gallery 条场景⑤（条上持续活动跨 3s 闲置窗 chrome 仍可见、停手恢复淡出）＋新场景 gallery-fast-swipe（图源延迟 900ms 下连翻 6 张，落点窗口三帧在场＋邻图请求已发；两场景旧码均红）。沉浸式安全区（fix330/gallery-viewer，2026-11-19 真机实报全屏 chrome 与状态栏重叠）：AlbumViewer 新增 immersive 模式——chrome 内边距按 --sat/--sab/--sal/--sar 让位，fixed 宿主 SourceGallery 传入、搜索详情页内嵌不传（宿主页已处理、免双重让位）；舞台本体不让位保持全幅。缩略图随可见性加载（同线，真机实报全条除当前张外全 HG 占位）：条内缩略图改以条本体为 root 的 IO 闩锁（nearThumbs，进窗含 600px 预取边距才挂 Img 且 eager 取图、闩锁常驻，窗外只占位不发请求不起时钟）；根因是全量 lazy 挂载下浏览器取图窗口（条滚动口）与 Img attempt 时钟窗口（主视口 IO）脱节、且 load effect 重跑会重置 settled 把已加载图误判超时烧光 attempt——Img 侧同步加对账（`settleOkFromDom`：起算前与 timeout 裁决前先核 DOM img 真实状态）。夹具：layout gallery-safe-area（注入 --sat 47/--sab 34 断言顶栏/底条不侵入系统带）＋gallery-strip-load（126 张断言挂图数有界、远端未请求、滚动后尾部出图），两场景旧码均红；WebKit 探针另证已加载图跨 20s 无误烧重拉。（fix336/ui-fixes 已改：搜索宿主的「页内 h-full 内嵌＋不传 immersive」形态作废——真机实报双标题栏＋壳底部导航漏出，改 fixed 覆满视口＋传 immersive、与 SourceGallery 逐字同形态，「宿主页已处理安全区、免双重让位」的旧假设一并作废，见上方 fix336 段。）
- 外部源按真站校准第二轮（3.2.1 fix321-F2b，住宅出口四级验收推翻
  机房定性后）：肉视频取流走站内端点模板 `streamUrlTemplate`
  （/api/hls/<id>，resolve 不回详情页找 m3u8）；SWAG/RedGifs 改走
  API 模板（`swag-api`：api.swag.live 免登录 feeds/messages，流为
  AES 加密 HLS 超播放栈、resolve 诚实为空；`redgifs-api`：官方
  匿名临时令牌＋Bearer，Rust `source_fetch` 对 Authorization 仅
  api.redgifs.com origin 定向放行）；FC2 按销量榜＋作品页以普通
  视频源校准（PPV 无免费流）；51吃瓜换域名 51cg1.com 解 blocked；
  黑料网自目录导入毕业为命名源并启用（三段证据齐＋住宅四级
  全通）；Hanime 取流 handshake（POST＋AES-GCM 信封）超 GET-only
  取页契约、维持 probe 并 note 写明；解析层标题优先 h2/h3、封面
  兜底 x-bg-loader-url/z-image-loader-url。全部源 App 侧未真机验，
  状态最高「代码就绪未验证」（契约 `fix321-f2b.contract.test.ts`，
  证据 `~/workspace/hghub/fix321/evidence/f2b/`）。
- 图片线逐源定级与实体解码（3.3.0 fix330 图片线，2026-11-19，证据 `~/workspace/hghub/fix330/evidence/images.md`，契约 `fix330-images.contract.test.ts`）：秀人网解 blocked——生效域名改 xiuren.biz（.com 住宅/本机均 DNS 不可达），本机出口四级实证全通＋wp-rest 搜索端点实证，改判 probe；Danbooru 翻案 probe——住宅四级全通在案、旧 blocked 系机房出口 CF 假象（本机复核仍 403，两出口事实分开记）；目录图片源逐源定级——PixiBB/NudeCosplay 本机四级全通＋住宅两级存档、启用 probe 且 search 属实 true，Gelbooru（模板端点 404、dapi 匿名 401）/yande.re（住宅 DNS 失效、模板路径 404）/Pixiv（环境拦截＋需登录排除）维持未启用；PornPics 本机四级全通、住宅协议层失败（ERR_HTTP2_PROTOCOL_ERROR），维持 probe 不标 stable，且模板搜索两形态实证不可用（/?s= 跳首页、/search/?q= 404）、`capabilities.search` 属实改 false（扇出名单随之 7→8：出 PornPics、进 PixiBB/NudeCosplay）。实体解码单点：`adapters/parse.ts` 的 `decodeEntities` 重写为单遍通用解码（十进制含前导零/十六进制数字实体＋常用命名实体，防二次解码），全部模板的标题/简介文本路径经此一处（wp-rest 标题/简介、hls-site 锚点与 og 字段、chigua 同骨架），`titleFromHref` 补接同点；正文 `contentHtml` 以 HTML 渲染（DOMPurify）由浏览器原生解码、不走文本路径。
- 图片源增减与 moebooru 校准（3.3.5 fix335/g-sources，2026-11-20，证据 `~/workspace/hghub/fix335/evidence/g-sources.md`）：PornPics 按用户裁定退役摘除注册表（站方无分页、库存恒 20 册且单册最薄，审计 `fix335/audit-007-inventory.md`；hls-site 适配器模板留仓不删，surfaces 的模板级声明 `search-unusable-hls-site` 由合成 def 承接触发）；yandere 与新增 Konachan（order 105）同族 moebooru、本机出口实证（列表/详情/标签搜索段）后启用 probe——`createDanbooruAdapter` 加参数驱动校准：`detailPath`（{id} 占位、响应对象或单元素数组归一化取首）/`postPath`/`tagsField`/`previewField`/`largeField`，未声明源（danbooru 本体）逐字走默认形态；两源 `capabilities.search` 据实 true 进搜索扇出（名单 12→14）。注册表构成变为命名源 11＋目录源 6、总数仍 17；清单修订版 v4（minAppVersion 3.3.5）已备于 `~/workspace/hghub/remote-manifest/sources-manifest-v4.json`、未部署。两源住宅出口复测未做成、App 侧未真机验，maturity 维持 probe 不上调。
- 取页白名单派生（3.2.1 fix321-F2c，验收 D 缺口 G1 根治）：Rust
  `source_fetch` 的 origin 白名单全仓只在 `features/sources/allowlist.ts`
  的 `sourceFetchAllowlistOrigins` 一处派生，`main.tsx` 推送时只消费
  派生结果。派生集合＝已启用 ∧ 非 blocked ∧ 经 fetchPage 取页的源，
  每源贡献 active baseUrls ∪ 模板声明 origin（`adapters/fetchOrigins.ts`
  的 `TEMPLATE_FETCH_ORIGINS`：swag-api→api.swag.live、redgifs-api→
  api.redgifs.com，与适配器回落常数共用同一出处）——远程清单整组
  替换 baseUrls 只写根域时，模板声明 origin 不被削掉；未启用/blocked
  源的 origin 不放行（契约 `fix321-f2c.contract.test.ts`，证据
  `~/workspace/hghub/fix321/evidence/f2c/`）。验收缺口文件
  `fix321-f2-accept-gaps.contract.test.ts` 已改绑本派生（初版在测试
  内复刻旧 main.tsx 内联拼装、生产迁移后永久假红，fix321-G1 线
  2026-11-19 修订）：以仓外真实清单 v1/v2 两落定实跑两源适配器、
  断言请求 origin ⊆ 生产白名单，G1 全绿；该文件余下红为 G2 部署
  面（已部署 v1 的 51吃瓜域名/黑料网启用态与内置口径不一致），
  待清单 v2 上架闭合、非代码面。清单 v2 的 swag/redgifs 条目数据
  侧补齐（baseUrls 补 API origin）见
  `~/workspace/hghub/fix321/evidence/g1/manifest-v2-patch.md`。
- Hanime 官方 API 接通（3.3.0 fix330-hanime-api，2026-11-19）：hanime-tv 换 `hanime-api` 模板（`adapters/hanimeApi.ts`）——列表/搜索/详情走 guest API 全量目录（guest.freeanimehentai.net/api/v11/search_hvs，无签名纯 GET、客户端排序/过滤/切片、进程内缓存 15 分钟；目录实测 4.5MB 超全局取页上限，Rust 对该 (origin, path) 定向放宽至 12MB、其余仍 4MB）；播放走站点官方握手（ct 取 CSRF → AES-256-GCM 信封 POST auth 域 handshake、web2 签名、x-token 回信封解密出 /hls 流表）。通道定性三维分判（方法/请求头/响应头）：原 GET-only 取页契约三处不通，经 Rust 新命令 `source_post` 定向扩展打通——仅 auth.hanime.tv 一个 origin、固定头名单、仅回 x-token 一个响应头、请求体 ≤64KB，GET 契约与全局头白名单/CSP 不变（先例＝RedGifs Authorization 定向放行）；前端接缝 `adapters/fetchPost.ts` 与 GET 的 fetchPage 分离，main.tsx 一处注入。模板登记三处齐全：fetchOrigins 三 origin 声明（F2c 派生入白名单）、扇出结构门 SEARCH_TEMPLATES、工厂分发。协议级实证（本机机房出口）：目录/CSRF/握手均 200、流表 3 档、HLS 清单 200 #EXTM3U；App 侧未真机验、maturity 维持 probe（契约 `fix330-hanime-api.contract.test.ts`，证据 `~/workspace/hghub/fix330/evidence/hanime-api.md`）。
- Hanime 取流握手 403 定性＋分段留痕（3.3.2 fix331-hanime-403，2026-11-20）：3.3.1 真机详情已通、点播放报握手 403（CSRF 段已过、auth 域 POST 被拒），且该失败发生在诊断会话内而导出零记录（POST 接缝无取页埋点、GET 侧记录按 baseUrls host 归属错位、自检为旧账）。定性（本机 VM 出口对照）：经适配器本体复刻生产形态全链仍通（3 档流）；HTTP 头层变异矩阵（UA 三变体/头序反转/Accept 两形态/Accept-Language/Accept-Encoding/HTTP2）全部通过，唯一敏感点为 Origin 与 Referer 双缺失 → 401（固定码 UA1，属协议校验、与 403 不同类，且 App 恒带双头）；再以与生产同版本 reqwest 0.12.28＋rustls 0.23.46 实发同一份握手材料 → 200 且回 x-token，TLS 指纹在本机出口同样不被拒。裁定：请求形态因素（HTTP 层＋TLS 层）在本机不可证、权重移至设备出口因素（设备会话网络基线健康：ok_proxy/line-01 568ms/3.5MB/s，GET 段同出口均通、独 POST 被拒，形态与「敏感端点按出口 IP 地区/信誉拒」相容；同系 hanime1.me 封日本 IP 为在案记录、hanime.tv 本体无此记录，地区说为推断、待用户换节点对照回收）。处置：①resolve 三段（csrf/handshake/decode）失败经 `traceResolveFailure` 落 `source.resolve_fail` 留痕（稳定编号＋段名＋固定错误码＋HTTP 状态＋尝试序，纯函数 `resolveFailureEventData` 组装、键集合封闭、无敏感值位置），下次真机失败在导出中可定位到段；②握手 403 的用户文案带出口提示（「站点拒绝了当前网络出口，切换线路或节点后重试」），非 403 维持裸状态；③不引入任何绕过站点访问控制的手段（不仿浏览器指纹、不改协议头集合），`needsNonJpExit` 无生产消费者、仅为记录标记，本线不动注册表。证据 `~/workspace/hghub/fix331/evidence/hanime-403.md`，契约同 `fix330-hanime-api.contract.test.ts`（留痕组装定值＋终局 403/500 文案）。**fix333-m5 补齐（P5）**：留痕落点抽共享 `adapters/resolveTrace.ts`（组装纯函数与 trace 同居一处，hanimeApi 改为调用＋再导出、四源同口径）；010 hanime1（watch/download/decode）、011 iwara-api（detail/fetch/decode）、012 hentaihaven-api（watch/episode/decode）三源 resolve 已补段级留痕——段取数失败按段记固定码＋HTTP 状态（可提取时）、终局无流同落一条 decode 留痕，010 下载页回落失败原为静默吞掉、现留痕后仍按 watch 页结论走（行为不变）。诊断导出新增「取流失败留痕」节（`resolveFailLines.resolveFailSectionLines` 消费全量解析日志成行：编号/中文段名/固定码/状态/尝试序/时刻、最近 12 条＋全量计数），不再只躺导出尾部 8000 字符日志原文（长会话会被尾段截断挤出）；旧导出文本仍为同一事件的原文形态、含义不变。契约 `fix333-m5-diagnostics.contract.test.ts`。
- 保留源接通批·新适配器线（3.3.0 fix330，2026-11-19）：Iwara/Hanime1 自探路保留转专用适配器启用、HentaiHaven 自目录导入毕业为命名源并启用——`iwara-api`（api.iwara.tv：/videos 列表 0 基分页、/search 搜索、/video/<id> 详情、fileUrl＋X-Version 签名取流多档 mp4；签名头经 Rust `source_fetch` 仅对 files/filesq.iwara.tv 两 host 定向放行 `X_VERSION_SCOPED_ORIGINS`，同 RedGifs Authorization 定向先例）、`hanime1`（HTML：/search 列表与搜索同端点、/watch 详情、watch/download 页 <source size>/data-url 多档 mp4 取最高档；`needsNonJpExit` 保留）、`hentaihaven-api`（/api/manga/ 目录与搜索 JSON、/watch/<slug>/ 详情与 episode 分集、集页 ld+json VideoObject contentUrl 取 HLS）。三源 `capabilities.search` 据实为真（站点均有搜索接口）→ 搜索扇出名单 7→10 源（`multiSourceSearch` 的 SEARCH_TEMPLATES 同步纳入三模板）；取页白名单模板声明新增 iwara-api 三 origin（API＋两文件 host，与适配器回落常数共用同一出处）。结构依据为 Hentai-Park 公开插件的协议事实（只借协议/结构、代码原创），夹具为按声明形态构造的合成样本；三源 maturity 均 probe（住宅验收：Iwara/Hanime1 四级全通在案、HentaiHaven 两级筛查在案；本机机房出口三源均 CF 403、与住宅结论分开记录；App 未真机验不上调）。证据 `~/workspace/hghub/fix330/evidence/new-adapters.md`，契约 `fix330-new-adapters.contract.test.ts`。- 源健康自检（3.2.1 fix321-F7，2026-11-19 新立项）：`src/features/sources/healthCheck.ts`——诊断「源总览」里没被用户点开过的源永远是「未发生」，行不行此前只能靠外部逐站人工验（验的是浏览器环境、不是 App 取页链）。自检替代之：启动后延迟 90s 静默开轮、分片错峰（每片 3 源、片间 45s），对全部已启用源（未启用/blocked/preview/none 与 preview-only 模板不探，blocked 按 maturity 排除）用其自身适配器走生产取页链（模板经 fetchPage→Rust `source_fetch`＋当前线路，原生黄果经既有 api 通道），每源硬预算 2 请求（列表 1 页＋有条目时详情 1 条，不取流）。结果逐源落盘 `hghubx_source_selfcheck_v1`（源 id/时刻/列表成败＋条目数/详情三态/失败形态/请求数，不记 URL/查询），TTL 24h 内不重探（一天最多一轮全量、跨重启算新鲜度）。呈现只进诊断两条路径且口径分清：导出 `sourceHealthLines()` 尾加自检行组（汇总＋稳定编号逐源行）、App 内明细 `sourceHealthDetailLinesInApp()` 每行并入自检段——均标「最近自检」口径，与「本会话取页」三态并存不互盖；无结果计「未自检」不冒充未发生。失败形态与取页健康同源（`adapters/fetchErrorClassify.ts` 的 `classifyFetchError` 为唯一出处，fetchHealth 再导出）：网络不可达/超时/校验拒绝/响应过大归「网络类」、HTTP 状态单列、`SourceParseEmptyError` 记「解析为空」、详情步未分类失败记「详情失败」，列表与详情分开记、详情失败不翻列表结论。红线：静默（无弹窗/角标/任何用户可见打扰）、只记观测不自动处置（不改任何源启用/成熟度）、调度在 `main.tsx` 启动装配注册且纯旁路（异常不影响启动与使用）。契约 `fix321-f7.contract.test.ts`（调度注册/结果进诊断/预算与资格，适配器经注入接缝隔离、不访问上游网络）。**2026-11-20 fix331/source-reliability 修订（用户裁定源可靠性为重中之重；设备数据坐实：3.3.1 真机会话内自检零刷新、结果停在前一日，且本会话真实发生的取流段 403 在诊断里零记录）**：①探活补全链——每源硬预算 2→3，视频类详情可达后抽同 1 条目续探 1 次取流（只取流不播放、零流记失败），posts 正文段与 image 图集段复用详情响应判定（正文 HTML/图集为空记解析为空、不另发请求）；结果新增末段三字段＋探测时版本指纹（清单版本＋App 版本——适配器随 App 换代，旧版本探得的结果如旧抓页路线时代的失败同样判过期），旧格式结果落盘读入即丢弃（按新全链口径等于没探过）。②状态单一派生——`healthCheck.classifySelfCheckResult` 四态（未自检/可用＝全链通/部分可用＝注明死段/不可用＝列表即死）＋过期标记（超 TTL 24h、清单版本已变或 App 已换代任一成立），全 App 只此一处：展示面徽标（`sourceHealthBadgeText`：探过读派生、未探回落静态 maturity 作底）、诊断行组四态计数与明细状态整句、补探触发共用之；审计 D-3 的「未实测 vs 自检成功」双轨就此收口。③展示面消费——`SourceSwitcher` 与分类总览图片/视频源行改读派生并经 `sourceHealth.ts` 的 `useSourceHealthResults` 订阅落盘通知（探完即刷新标签）；进入浏览面（SourceBrowse/SourcePosts/SourceGallery）时结果缺失/过期/版本不符经 `ensureSourceSelfCheck` 单源后台补探（在飞去重），全量调度的清单竞态由此兜底。④诊断对齐——导出行组「未自检」分母只计自检合格源（`selfCheckEligible` 过滤，未启用/blocked/preview 不入分母）；取页归属改多 host 认领（审计 C④：每源全部 baseUrls∪模板声明 origin 的 host 集合、多记录取最近一条，`countFetchStates` 同步改 host 集合口径），source-002/011/004/005 的记录不再错位成「未发生/未归属」。契约 `fix331-reliability.contract.test.ts`（补全链/旧格式丢弃/四态与徽标对号/补探触发/诊断四态计数＋接线文本断言）；F7/F8/F3b 契约夹具同步适配新结果格式与计数签名（口径不变、覆盖不降）。**2026-11-20 fix333/selfcheck-trigger 补触发面（3.3.2 真机验收：总览 source-009 仍挂「未实测」）**：fix331 的补探只挂三浏览面且只探当前选中源，用户看状态的总览行与切换器只订阅派生、从不触发——刚升级（指纹含 App 版本、旧结果全失效）或从未点开过的源在总览长挂「未实测」，与「未实测长期挂着」的核心痛点正面冲突。现展示面挂载时对本面展示的源批量补探：`healthCheck.ensureSourcesSelfCheck` 与单源补探共用 `launchTopUp` 核心（判定 `selfCheckNeedsProbe`/在飞去重/资格/每源 ≤3 请求预算全同，不另起调度），额外纪律是串行节制——名单内逐个启动并等落盘才探下一个、多个展示面同挂载经模块级链依次排队，任一时刻至多 1 个补探在飞，进页面不打满请求，后到批次按新鲜口径自然跳过；触发钩子 `sourceHealth.ts` 的 `useSourceSelfCheckOnShow`（按 id 集合触发、现查 active 注册表拿最新 def），接线两处：分类总览图片/视频源行（Category）、`SourceSwitcher` 本体（总览吃瓜区/频道页/帖子页的切换器同覆盖；频道页除切换器外无徽标展示面，其外部源分支挂 SourceBrowse 时单源补探照旧）。补探仍为后台旁路：不阻塞渲染、不改四态口径，结果落盘经订阅即时刷新徽标。契约 `fix333-selfcheck-trigger.contract.test.ts`（批量触发/串行 maxActive=1/落盘脱离未自检/新鲜与不合格零调用/指纹不符重探/与单源在飞去重＋接线文本断言；基线红：批量入口导出缺失）。**fix333-m5 口径标注（O2）**：结果 `requests` 字段的唯一定义＝适配器调用数（列表/详情/取流各计 1，≤ 硬预算 3），不是 HTTP 请求数——一次调用内可含多次 HTTP（002 取流含 CSRF 取令牌 GET＋握手 POST 共 2 次、计 1；010 取流含详情页＋下载页两取、计 1），旧呈现裸称「请求数」与真实网络量对不上。现呈现恒带标注：单源段（`selfCheckSegmentText`）段尾缀「请求 N 次（适配器调用口径）」，导出汇总行（`selfCheckDiagLines`）带口径定义句；计数本身不变（仍为引擎三调用点结构计数）。契约 `fix333-m5-diagnostics.contract.test.ts`。**2026-11-20 fix333/m7-selfcheck 修订（M7 补探排序＋M9 指纹分维度）**：①排序——批量补探启动序改经 `healthCheck.orderTopUpCandidates`（当前面选中源最先、最近打开过的源次之按时刻倒序、其余注册表序），全量失效时用户正在看的源先刷新；「最近打开」信号由此新建：浏览面钩子 `useSourceSelfCheckOnView` 进入时经 `recordSourceView` 落盘 `hghubx_source_last_view_v1`（源 id→时刻，跨重启成立），切换器经 `useSourceSelfCheckOnShow(defs, value)` 把当前选中值透传为排序信号；串行/去重/每源 ≤3 预算与单源即时触发不变，全量轮次计划仍按注册表序（无人值守调度）。②指纹分维度——结果指纹由「清单版本＋App 版本」两维改三维（`selfCheckFingerprintFor`）：自检协议版本 `SELF_CHECK_PROTOCOL_VERSION`（探测步骤/段位/失败口径变更才 bump，现行 v1＝fix331 全链口径）、适配器纪元 `SELF_CHECK_ADAPTER_EPOCH`（适配器取页/解析行为变更才 bump，**升版纪律：改 adapters/ 下取页/解析行为必须同步 bump 本常量**，纯 UI/文案变更不许 bump）、源切片 `selfCheckSourceScope`（该源模板/基址/生效参数/品类/取页模式的 FNV-1a，清单热改只作废被改的那一个源）；过期判定＝超 TTL 或三维任一不符，`classifySelfCheckResult`/`sourceHealthBadgeText`/`selfCheckStatusText`/`selfCheckDiagLines` 签名收敛为 (结果, def, now)。③旧指纹迁移——全链旧格式结果首次读入逐条判定（`migrateLegacyResult`）：同 App 版本∧同清单版本者按现行三维认定、保持新鲜（协议按 v1、纪元按现行、同清单即切片未变）；任一不符者给哨兵指纹（纪元 0/切片空串）判过期但不丢弃、待补探刷新；无末段的远古格式仍按 fix331 口径丢弃。契约 `fix333-m7-selfcheck.contract.test.ts`（排序与预算/打开记录落盘与重启读回/指纹三维逐维作废与文案类变更保留/迁移三形态；基线红：新导出缺失）；F7/reliability/selfcheck-trigger/F8 契约夹具同步适配新指纹字段（口径不变、覆盖不降）。**2026-11-20 fix335/selfcheck-paging 修订（分页信号一致性抽查）**：自检此前只验第 1 页——分页信号说谎（站方忽略页码恒回同一页、导航末页虚报、第 2 页不可达/为空）时列表段照样全绿、用户翻页才撞见。现列表成功后按同一 Paged 信号（pages＞当前页，与三套 UI 停拉判据同口径）多取第 2 页一页核对：不可达按取页同源形态记、为空记解析为空、与第 1 页条目集全同（externalId 集）记其他，部分重叠（置顶类合法重复）不算全同；信号称单页标不适用（na）不多取页、不冒充通过。结果新增 paging/pagingFailure 两字段，抽查失败经 classifySelfCheckResult 降级部分可用（段名「分页」）、不翻列表/详情/末段结论，诊断逐源行明示「分页抽查失败」/「分页抽查不适用（单页）」。协议配套：SELF_CHECK_PROTOCOL_VERSION 1→2、每源硬预算 3→4（多取的恰是抽查这 1 页）；v1 结果按指纹不符过期补探，落盘旧结果缺本段字段读入归一 skipped（pagingFieldsOf）、不丢弃。F 线联动不变：DiscoveryBar 只认 down 禁用，分页失败派生 partial、不误伤维度可用性。契约 `fix335-selfcheck-paging.contract.test.ts`（说谎三形态/正常多页/部分重叠/单页不适用/列表失败跳过/预算计数/落盘归一与迁移；基线红：引擎不取第 2 页）；wiring 新增 fix335-selfcheck-paging-probe 一条；F7/reliability/selfcheck-trigger/F8/m5 契约夹具同步适配新字段与预算常量（口径不变、覆盖不降）。**2026-11-20 fix336 集成裁定（分类判序）**：线 A 本机实拉三源（source-009/010/011）列表失败的错误原文均为 `Error: HTTP 403 Forbidden`（响应完整到达的干净 403），自检却呈现「网络类」——根因是 `classifyFetchError` 判序中校验拒绝规则（含词元 forbidden）排在 HTTP 状态规则之前，403 的原因短语先命中校验拒绝再归并网络类。现判序定版：HTTP 状态码先判、其余词元后判（状态码是响应已到达的硬证据；校验拒绝的真实错误串在发请求前产生、不含状态码，不受影响）；连接级错误仍判网络不可达→网络类，校验拒绝仍归网络类（口径不变）。契约 `fix336-error-classify.contract.test.ts`（403/404/503 真值＋连接级/DNS 真值＋校验拒绝防过修真值；基线红于 403 断言）。三源在本机沙箱出口下新 UA 仍回此 403（出口 IP 维度拒绝与 UA 变量本地不可分），分类修复只正判读、不构成三源已通的证据，真机定案待 3.3.6 回收取页观测节。
- 清单参数下发（3.2.1 fix321-F8，2026-11-19 新立项「适配器抗失效」）：`src/features/sources/adapterParams.ts`＋`manifest.ts`——hls-site 模板源（内置注册表 32 源）的模板参数可由远程清单声明式下发、免发版热修站点改结构/改域名。清单条目扩展可选 `adapterParams`＋`paramsVersion`（per-source 整数）＋条目级 `minAppVersion`（高于当前 App 版本仅参数不应用）；可下发字段冻结为模板现行 params 字段 `listPath`/`itemLinkPattern`/`detailPath`（取流提取是 parse.ts 固定正则、无参数字段，不设下发字段；baseUrls 走既有通道归入本机制口径）。schema 在 `validateManifest` 内逐条目校验（相对路径形态/长度上限/禁 javascript:、data: 等危险形态）：参数非法只丢该条目参数、整份清单与 enabled/baseUrls 覆盖照常（与既有整份丢弃口径的差异及理由见 adapterParams.ts 文件头⑤）。`applyManifest` 仅对 hls-site 源把校验过的参数覆盖到生效 def 的 `adapter.params`（createAdapter 读生效 def 即得新参数、对适配器透明），不触碰 enabled/maturity、名单冻结不变；覆盖同时落盘已应用快照 `hghubx_adapter_params_v1`（{sourceId, paramsVersion, params, appliedAt, 内置参数 FNV-1a 指纹, status}）。应用后验证与自动回滚：`main.tsx` 在注册表落定后调 `verifyAppliedAdapterParams`（接缝注入 healthCheck 的 `runSourceSelfCheck`，不另写取页），pending 源逐源自检——应用前自检为好/未知且应用后列表失败（含解析为空）→ `revertActiveSourceParams` 回滚内置参数＋记 rejected 版本（同 paramsVersion 不再重复应用、防抖动循环）；自检通过或应用前已坏（非本次变坏）→ 确认 applied。F7 联动定性：纯函数 `classifySourceFault` 给失败源标故障类——hls-site 且失败形态属解析为空/列表 HTTP 状态/baseUrl 不可达（网络类）→「参数可热修」，其余（非 hls-site 模板、详情步失败、未分类失败）→「需发版」；`registryDiag` App 内明细行呈现「参数来源：清单 vN／已回滚」段与故障类标注。红线：只许声明式参数、绝无远程代码执行；不放宽 https 起点/scheme/CSP 校验；应用/回滚全程静默、只进诊断。wp-rest/chigua 模板本批不扩（参数形态不同，留后续批次）。契约 `fix321-f8.contract.test.ts`（schema/应用生效/回滚/故障分类，清单与自检均经注入接缝、不访问上游网络）；顺手修正：`manifest.ts` 的 `FALLBACK_APP_VERSION` 与 package.json 同步为 3.2.1。
- 吃瓜帖外部源浏览面接通（3.3.0 接通批·吃瓜线，2026-11-19）：此前唯独 posts 分类未接浏览组件——Posts 页与分类总览对一切非黄果源无条件 `SourcePendingNotice`、适配器从未被调用，已启用源（如黑料网）真机点开恒提示页（根因与 maturity/capabilities 无关）。现判定收敛为 `src/features/sources/postsRoute.ts` 的 `resolvePostsBrowse`（黄果→native、blocked/缺失→blocked 诚实提示、其余已启用→browse），Posts 页（全量）与分类总览（compact 预览）共用；browse 经 `SourcePosts` 走适配器 list/detail/resolve 真实渲染（详情先文后视频、点了才播，与原生 PostDetail 的 D2 口径一致）。同批：每日大赛解 blocked（主域换 www.mrds66.com 与清单 v3 一致、listPath 按真站校准为 /page/{page}/、maturity 改判 probe）；chigua 模板搜索按源校准——`params.searchPath`（51吃瓜/每日大赛实证 /search/{q}/{page}/、caps.search 据实 true 进扇出；模板默认 /?s=&paged= 形不变、未声明源不受影响），黑料网经实证无 GET 搜索段（三种形态均返回关键词不变页）caps.search 维持 false；黑料网详情正文容器 editormd-preview 已入 chigua 模板正文捕获（旧两式恒空）。契约 `fix330-chigua.contract.test.ts`，证据 `~/workspace/hghub/fix330/evidence/chigua.md`。
- 选中源被清单停用时的诚实呈现（3.3.3 fix333-P2，结构审计 G5 修根）：此前 Posts 页与分类总览吃瓜区以 `sourcesForCategory(...).find(id)` 取选中源、无回落校验，源不在 active 表时 `resolvePostsBrowse(undefined)` 判 "blocked"、提示谎称「本分类的外部源浏览页尚未接通」，页头回落显示内部 id 原文；图片/视频深链页同型（缺失时 maturity 强制 "blocked" 落错分支、页头回落 id）。现选中态唯一派生为 `src/features/sources/selectedSource.ts` 的 `resolveSelectedSource`（三态 active/disabled/gone，判定只认调用方给的 active 表，内置查表只给已知源找回显示名），吃瓜全量/总览、图片深链、视频深链、频道外源五面共用：disabled/gone 落 `SourcePendingNotice` 新的停用分支（「该源已被清单停用…请切换到其他源」）、页头与提示一律读显示名 label，内部 id 永不进文案；pending 原口径逐字保留。（fix333-M3 拆分残余：disabled 与 gone 此前共用停用一句、对已删源字面不实，现两态各一份文案——gone 为「该源已被移除…（已下线）」、不冒充清单停用；五面调用点改传三态 `selectedKind`、不再压成布尔，详见下方 M3 条目。）未做：不自动回落选中态（停用值得用户知道，是否回落另议）。契约 `fix333-p2.contract.test.ts`（旧码跑红：模块未建；内置未启用源一例曾在旧签名下跑出 gone，修法见 selectedSource.ts 文件头），证据 `~/workspace/hghub/fix333/evidence/p2-fix.md`；接线清单 fix333-p2-disabled-notice 一条。
- 守卫与文案小修打包（3.3.3 fix333-M3，2026-11-20，证据 `~/workspace/hghub/fix333/evidence/m3-guards-copy.md`，契约 `fix333-m3.contract.test.ts`）：①清扫 P3——wp-rest/danbooru 的 list/search 加 JSON 形状守卫 `parseJsonArray`：真 [] 是上游明示真空、正常返回空列表（不抛错、自检不记失败），非数组/非 JSON 的形状漂移抛 `SourceParseEmptyError`（此前 [] 与漂移不可分、非数组抛 TypeError 裸奔，基线实测证伪）；界面空态文案「解析不到条目时已按加载失败处理」对 JSON 模板由此成立。②B1 复验记账——`contentImgSrcs` 加空集守卫：地标深度扫描被地标内 script 字符串里的同名闭标签提前截断、限定采集为空集时回落整页采集（与无地标回落同口径、最坏退化为 B1 前行为）；007 现行页型不可达、属预防性守卫，合成形态钉入契约（基线旧码对该形态返回 []）。③清扫 P9——模板段事实收口单一派生：`adapters/templateSegments.ts` 以探针 def 逐模板实例化、按方法存在性派生 `templateHasSearch`/`templateHasAdapter`，`multiSourceSearch.missingSearchSegments` 只消费派生（手抄副本集合 SEARCH_TEMPLATES/DETAIL_PLAY_TEMPLATES 删除）；detail/resolve 类型必填、适配器存在即两段皆在；preview-only 的 play 缺失属产品口径（resolve 明确拒绝）单独分叉不变；native-huangguo 工厂包 Tauri api 通道不可探针，其 search 事实在 templateSegments 按现状声明、由契约对 nativeHuangguo.ts 源码逐字钉死；探针与 index.ts 工厂分发的 parity、注册表 caps.search=true 与模板实有 search 的一致性均入契约（新模板接通漏登记任一侧即红）。④P2 残余文案拆分见上方 P2 条目注。⑤P6 为证据文档订正（`fix330/evidence/device-verdict-330.md` 编号映射行 004/005 按代码 order 排序口径订正＋一行注记、结论不动），不在本页展开。
- 吃瓜正文图载体与基址修复（3.3.1 fix330/post-images，2026-11-19，证据 `~/workspace/hghub/fix330/evidence/post-images.md`）：3.3.0 真机三源帖子正文可开但图全破——真站正文图真实地址在主题/插件懒加载载体属性上（z-image-loader-url/x-image-loader-url/data-image-zoom/data-xkrkllgl），src 常为相对占位；正文清洗链（`src/shared/lib/html.ts`）旧候选链不认载体（先被 DOMPurify 输入白名单删、无 src 图整张移除），且相对地址一律按黄果站补全错源。现 proxyImages 候选链按「经典懒加载 data-* → loader 载体 → src 垫底」提取，载体属性只进两道清洗的输入白名单（提取后移除、不进最终输出白名单）；sanitizeHtml 新增可选 base（外部源由 SourcePosts 传详情页 href 作相对地址补全基址，原生消费方不传、默认原生站不变），正文链接点击 handleArticleClick 同步吃 base。夹具 `tests/html-security.ts` 两用例基线红、修复后全页 33/33 绿。
- 吃瓜正文提取—重构（3.3.1 fix330/reader，2026-11-19，用户 23:59 裁定「只看有用的、废话广告全砍」，证据 `~/workspace/hghub/fix330/evidence/reader.md`）：SourcePosts 正文不再走 sanitizeHtml 整页清洗渲染，改经 `src/features/sources/articleBlocks.ts` 的 `extractArticleBlocks` 从 detail.contentHtml 按文档顺序提取内容块（文本段落／图片）原生重渲染（article-body 既有样式）——广告位/假按钮/导航/评论/相关推荐/分享件在提取层不入块（非正文元素整棵跳过＋类名段精确匹配的垃圾容器排除，类名误包正文时有不按类名重走的保底）；段级过滤只杀高置信垃圾（防走失/地址发布、下载 App 引导、扫码进群、整段 CTA/裸域名行、≤48 字短段的加群引导、与标题/正文精确重复段），长叙事等形似正文一律保留（夹具反例守门）。图片地址解析收敛为 html.ts 的 `articleImageSrc` 单一出处（proxyImages 与提取层共用，候选链＋安全门＋基址口径一致、地址集合夹具钉死相等），渲染仍走本地 /img 路由。降级链：提取到块→块渲染；located（定位到内容）但全被过滤→显 detail 简介；未 located（结构未知）→维持 sanitizeHtml 旧渲染。元信息（标题等）沿用 detail 数据、正文内链接不渲染为锚点，回源走页脚「查看原文」（openSafeLink 打开 detail.href）。sanitizeHtml 本身保留：其余消费方＝原生 Panels 的 ArticlePanel、原生 Posts 的 PostDetail（均不传 base、行为不变），SourcePosts 仅在降级路径消费。夹具 `tests/article-reader.ts`（三源形态＋反例＋安全门共 12 例，基线无提取层为红、修复后全绿；html-security 仍 33/33）。
- 吃瓜正文段级过滤三轮（3.3.3 reader3，2026-11-20，证据 `~/workspace/hghub/fix333/evidence/reader3.md`）：3.3.2 真机验收两帖（003/005）仍有成片模板垃圾漏杀，按结构形态补四判据＋两容器：⑪编号问答块（模板小节头＋Qn/An 编号递增交替 ≥2 对整组杀；无编号访谈问答、单对问答为反例）；⑫尾部模板区（正文后出现模板栏目名小节头、其后无叙事续段、区内有旁证行→自小节头起文本块整区杀、图片保留；中段提示＋叙事续段整区保留为反例）；⑬显式标签关键词墙（「关键词：」＋宽阈值词墙廓形，句读守门）；⑭下载 CTA 短行（「点击」起头＋下载/安装＋全行无句读）；容器层补标签簇（tags/keywords 段＋itemprop="keywords"，两源同构）与公告选项卡（content-tabs 整 token）。同批封面：firstCoverSrc 补第四载体 z-bg-loader-url（003 列表两页 48 卡中 45 卡只有此载体、旧链返回空串；实测修复后两页 23/23、23/23 全解析）。红线复核：夹具 25→37 例（新正例旧码恰红 7、反例新旧双绿）、三源 9 帖新旧存活块对照零新增误杀（新增击杀逐块属目标垃圾类）；残余（区外合集推广行、去求瓜行、004 区前推广行）只漏不误、报告明列。
- 吃瓜正文段级过滤四轮（3.3.3 残余清剿 M2，2026-11-20，证据 `~/workspace/hghub/fix333/evidence/m2-reader-leaks.md`）：清 reader3 明列的五类只漏残余。walkBlocks 新增独占锚追踪（整块有效文本只出自同一 <a> 时记 soloHref，混源即作废）；⑮独占跨帖链接块（soloHref 指向 /archives/<他帖 id>/，帖 id 兼认详情地址的短形 /<id>）＋同名标题配对杀（按钮行名称核与 ±3 块内非叙事文本块公共前缀 ≥12 字，标题与按钮之间无其他文本块时封面图随单元杀）——合集推广单元（标题＋图＋按钮）与 004 区前推广标题行同判据覆盖；⑯插件图＋短标签行（图 src 解码后带 /plugins/ 段且紧随 ≤12 字无句读行，成对杀）；⑰无编号问答组仅在紧贴 FAQ 类小节头时连头杀（无头/非 FAQ 头的访谈问答仍保留）。④容器外标签簇、⑤单对问答与无编号不连续问答经 25 样本实测结案不设判据（零存活实例；最接近的文本廓形判据会命中榜单帖真标题行与站务帖正文行，测算见报告）。验收：25 样本（corpus 13＋新抓 12）新旧差分——新增击杀共 51 块，其中 50 块逐块归属五类目标、1 块为尾部区内与跨帖行同文的推广长句，正文新增击杀 0、新增存活 0；夹具 37→43 例（filter4 六例：正例旧红 3、组合反例旧红 1、纯反例双绿 2）。
- 吃瓜正文段级过滤五轮（3.3.3 清扫修复 sweep-fixes，2026-11-20，证据 `~/workspace/hghub/fix333/sweep-report-333.md` 坏-1/潜-1、`~/workspace/hghub/fix333/evidence/sweep-fixes.md`）：清扫定性的两处判据边界。⑧成组判读对单行垃圾行透明化——地址发布组内交插的样板行（组头「…最新地址」、指令行「获取最新地址 …」）本身即被逐行判据所杀，旧码在未过滤的原始块流上成组、被打断成 1＋2 碎段后整组存活（App 004 帖 202663）；改动限 groupJunkIndices 一处：成员资格与组级门槛（≥3 行、≥2 联系点、≥1 行首标签）不变，isJunkText 命中行不入组、不断组，普通正文行与图片块照旧打断（反例钉死），单行判据集不扩大。⑫旁证廓形 isPromoBlurbShape 的最长词元上限 14→18——App 005 帖 126027 尾部串烧长句最长词元恰 18 字、旧上限使旁证单项落空、安全门整区回退；仅旁证放宽（本函数不单独杀），守门 (a)(b) 与其余廓形参数（≥40 字、≥8 词元、平均 ≤9、逗号 0、句读 ≤1）不动，带逗号行与 >18 词元行仍不构成旁证（反例钉死）。验收：夹具 43→47 例（filter5 四例：正例旧红 2、反例双绿 2）；25 样本新旧差分——变化仅 5 帖、新增击杀 10 块全属目标形态（202663 地址组 3 块；126027 与同源 124989/125503 的站点固定尾部模板各 2 块、126026 尾部小节头 1 块），正文新增击杀 0、新增存活 0。
- 吃瓜正文段级过滤补强（3.3.2 reader-filter2，2026-11-20，证据 `~/workspace/hghub/fix331/evidence/reader-filter2.md`）：3.3.1 真机首验发现正文头部两类垃圾整段漏杀，三源各抽 3 帖普查后按形态分类补判据（全为结构特征、不引用真实站名/域名）：⑦SEO 关键词墙（空格分隔短词元堆砌＋零句读，整段/分行成组/# 标签墙三形态）；⑧地址发布块（带标签 URL/邮箱行组，成组杀伤＋整块合并单段判读＋「播放异常→用 App」CTA 窄判据）；⑨头部模板块独立成类按块处理——同源跨帖逐字雷同的整块站务模板（地址发布＋词墙＋站务话术），只扫第一个正文段（≥50 字、有句读、本身非垃圾）之前的区域，连续模板成员行组（≥4 行、≥2 行带联系点、≥3 信号行）从首个到末个信号行整段杀，组外缘纯填充行（元信息）保留；正文段之后不扫（尾部模板与列表体正文同为短行区、全域成组会误吞列表体，普查实证此险）；⑩超短行行组（≥10 行连续、每行 ≤6 字、无句读无联系点、非标题＝分类导航名单）；站务残行整行判据（播放器占位/浏览器推荐/版权声明/最后编辑于/官方公告/分享提示与控件残字）。红线不变：既有反例零回归（夹具 12→25 例，新增正例旧码恰红 8、反例新旧双绿），真实 9 帖新旧存活段对照入证据报告；已知残余（尾部推广标题行/单行词墙/无标点拼接词串/孤儿标签行等）只漏不误、报告明列。
- 吃瓜详情排版（最终版 D2 线，2026-11-19，用户实报）：`PostDetail`
  先文后视频——标题/元信息/标签/动作行/介绍正文在前，播放器区
  （`data-post-media`）移到正文之后；仍是点了才播（分段只解析备好、
  海报点击才 `setPlay`，排版调整不改变装载时机）。播放封面 Button
  必须带 `rounded-none`：`.ios-button` 全局胶囊圆角（999px）会被
  `.ios-image{border-radius:inherit}` 继承并经 `overflow:hidden`
  把封面裁成大椭圆（黑边圆罩，用户实报 bug）；回归脚本
  `scripts/test-post-detail.mjs`（夹具 `tests/post-detail`）断言
  DOM 顺序、未点击零视频装载、封面框计算圆角 0px。
- 吃瓜详情点播稳定性（3.2.1 F9 线，2026-11-19，用户实报点播放跳顶＋
  起播卡 0:01）：`PostDetail` 加载 effect 的整页重置（scrollTo(0,0)/
  清播放/清分段）只许由帖子 id 变化触发（`shouldResetPostForNav`）；
  lineEpoch/accountScope 变化只刷新数据与分段，滚动、播放态全保留。
  点播瞬间记滚动值，play 翻真后漂移则一帧内恢复
  （`restorePostScrollAfterPlay`，静默无焦点动作）。加载判读埋点
  `post_detail.load`（nav_reset/line_epoch/was_playing/scroll_top）。
  回归 `scripts/test-post-detail-playback.mjs`（夹具
  `tests/post-detail-f9`，hls.js 引擎面；iOS 原生引擎面属真机判读）。

- 站务推广帖异步验杀（fix333/promo-004，2026-11-20；Muse）：source-004
  列表卡只有标题/封面，推广帖（站务组）在列表层无可分信号（promo-filter
  线停工证据），故不拦在列表层：`SourcePosts` 先正常渲染，后台经
  `promoVerify.ts` 对未验过的卡逐条抓详情验真伪——正文字数 ≤890
  ∧ episodes=0 ∧ 正文图片数 ≤3 三重合取判站务型，就地从列表撤下；
  活动壳＋真内容的帖（1744 字/episodes=1）按判据存活。图片数合取
  为 M8 收紧（fix333/m8-staff-criteria）：165 条已分类帖逐条实跑
  详情全量量测，站务三连正文 <img> 恒 1、内容帖全部 ≥7（空带
  2–6 取 3），短正文带图真帖自此按构造存活；图片只数正文容器
  内的 <img>（`bodyImageCount`），适配器 images 字段含模板图不
  可用。判据参数在注册表该源 `params.staffVerify` 声明
  （maxBodyChars/maxBodyImages），作用域＝源＋判据版本＋两阈值，判定按帖 id 落盘
  （`hghubx_promo_verdicts_v1`，先写新键再清旧键；判据变自动失效、
  每帖只验一次）；并发 ≤3、网络失败不撤不缓存（下次挂载再验）。仅
  声明了 staffVerify 的源生效，列表全量与 compact 两形态同口径；
  搜索扇出不含本源（无 GET 搜索段），无搜索面。契约
  `fix333-promo-004.contract.test.ts`＋promo 样本回归
  （`~/workspace/hghub/fix333/evidence/promo-004/`）＋M8 全量量测
  回归（`~/workspace/hghub/fix333/evidence/m8/`，165 条真实量测
  三元组喂新判据恰撤三连、零误杀）。
  3.3.5 扩围（fix335/b-purify）：51chigua 与 meiridasai 同声明启
  用——两源站务帖同为置顶异形卡（无 h2 标题、无分类词元，L1 词
  元判据结构性不可达），详情量测（2026-11-20 本机实拉、生产量
  法）显示两源站务帖字数与内容重叠不可分，分离面只剩 eps 与正
  文图数：51chigua {maxBodyChars 100000 不承重, maxBodyImages
  26}（站务图 3–23、内容图 ≥30、内容 eps 恒 1；用户截图招募卡
  274838＝3558 字/图 23/eps 0 按判据撤下）、meiridasai
  {100000, 18}（公告图 15–16、内容图 ≥21；网址说明型公告 47559
  ＝1335 字/图 15/eps 0）。feedheiliao 现行 {890,3} 不动。审计
  预估参数（003 图≤6、004 {≈900,≈6}）被实测双双证伪——阈值只
  许由目标源实拉分布校准、不许跨源平移或凭小样本定版。003 的
  游戏推广/求瓜合集两卡详情信号与内容同形、按构造存活（机制边
  界，待裁定）；契约 `fix335-b-purify.contract.test.ts`＋证据
  `~/workspace/hghub/fix335/evidence/b-purify.md`。
- 标题链脚本字面根治（fix335/b-purify，2026-11-20）：`parse.ts`
  的 `stripTags` 只删标签不删元素内容，004 卡内封面脚本
  loadBannerDirect 在卡标题回退链落空时整段压平成标题、端上详
  情页头栏（用户真机实报，与封面第四载体同源同元素：数据路径
  当封面消费、正文路径 DOM 跳过、唯标题路径裸奔）。现 stripTags
  剥标签前整棵剔除 script/style/noscript/template 元素内容（未
  闭合开标签吞到串尾），全文本消费者一处受益、正常标题逐字不
  变；证伪＝夹具删 h2 变体旧码标题逐字＝脚本字面、新码回落
  slug，真实样本页差分仅脚本字面类改名、成员零增减。契约
  `fix335-b-purify.contract.test.ts`。

- 空壳卡标题兜底（fix333/M1，2026-11-20；Muse）：source-003 列表
  存在封面-only 卡（卡内无标题载体），`parseAnchorList` 标题链落
  `titleFromHref` 兜底、对 /archives/<纯数字 id>/ 产出裸数字 id 充
  标题；普查实证 4 例且 detail 抽查全是真帖（不许杀）。`SourcePosts`
  经 `titleFallback.ts` 仅对裸 id 标题卡（`isBareIdTitle`：标题纯
  数字 ∧ 等于自身 href 末段 id）后台抓详情回填真标题，与验杀共用
  detail 注入接缝且正交（验杀定存废、本 hook 叠标题）；真标题按帖
  落盘（`hghubx_title_fallback_v1`，作用域＝源 id＋兜底版本＋适配
  器模板，版本变自动失效、每帖只补一次）；并发 ≤3，抓取失败或
  detail 标题为空保留裸 id 显示、不撤卡不报错（下次挂载再试）。
  全量与 compact 两形态同口径。契约
  `fix333-m1-title-fallback.contract.test.ts`＋003 样本回归
  （`~/workspace/hghub/fix333/evidence/m1-title-fallback/`）。
  **搜索面接入（3.3.3 集成轮定夺，收口 M1 残余）**：搜索结果经
  `fanoutSearch` 扇出、不经 SourcePosts，原未覆盖；现 `Search.tsx`
  每源挂一个 `ExtTitleFallbackPump`（不渲染）调同一 hook（detail
  接缝同构造），覆盖集在 `aggregateHits` 聚合前按
  (sourceId, externalId) 叠加到扇出条目——MergedHit 展示标题取
  代表副本 item.title、合并标题信号同受益；覆盖集随 extHits 在
  submit 与两条清空路径同步重置。接线断言入 M1 契约 (6)。
- **结构批 L1：surfaces 派生模块影子落位（fix334，未出包）**：
  `src/features/sources/surfaces.ts` 把 21 个展示面 × 每源的路由
  裁定收成单一纯函数派生（`routeForSurface`／`sourcesForSurface`），
  输入＝active 注册表＋模板能力事实（`adapters/templateCapabilities.ts`
  单一出处：search＝探针∧caps、detailPlay＝探针、episodes 形态逐
  模板登记）＋P2 `resolveSelectedSource`；不适用一律引用声明表
  `SURFACE_DECLARATIONS` 的条目，不许散落硬编码。**本线只影子落
  位**：派生产出裁定但不替换任何面的现行判断，各面替换在 L2/L3
  接线时逐面做；`validateSurfaceDerivation`＋契约
  `fix334-surfaces.contract.test.ts` 对三组注册表状态（内置／清单
  v3 同形／合成变体）全面×全源断言完备性（漏格、browse 无适配
  器、伪造声明、两出口不一致、声明腐烂均抛错）。诊断面 M20
  （`sourceHealthDetailLinesInApp`）标注死面：无生产消费者、只余
  契约文本断言，清扫口径见 L1 报告。设计订正三条（声明 c 与自检
  事实矛盾、015 搜索资格、searchPath 口径）以码上事实为准，详见
  `~/workspace/hghub/fix334/evidence/l1-surfaces.md`。
- **结构批 L2：G3 多集选集消费者接线（fix334，未出包）**：外部源
  detail 的多集 episodes（字符串 externalId 形态）此前无消费者——
  全仓只有 App 011（hentaihaven）的 detail 产多集、resolve 已支持按集取流，用
  户打开多集条目却只能播第一集。本线补齐：纯函数模块
  `src/features/sources/episodes.ts`（`episodeChoices` 归一＋
  `episodeChoicesForSurface` 适用性派生：宿主面经 L1
  `routeForSurface` 路由∧模板能力事实 `episodes==="multi"`，不
  本地另判）＋轻量组件 `EpisodePicker.tsx`（内嵌可展开段，形态
  对齐原生选集面板：30 集分段、正/倒序、当前集高亮、44px 热
  区；展开期登记全局 back 先收起再关详情）＋两条路径接线：
  ①`SourceBrowse` openItem 改 detail 与 resolve 并发（detail 失
  败降级不阻断取流），选中集经 `adapter.resolve` 按集换流、Player
  scopeKey 随当前集变更防串集缓存；②`Search` 外部详情经
  `copyLoader.loadSearchCopy` 新增可选 `episodeExternalId` 透传
  （video/drama 按集 resolve），切集只在当前副本内换流。切集失
  败两面同口径：留当前集继续播＋页面明示失败，**不静默回落第
  一集冒充成功**；单集条目与不适用源详情行为逐字不变（无 detail
  请求增量之外的变化，选集区不渲染）。**caps 裁定（与设计 §3.1
  的翻 caps 指示相左、已明报）**：012 注册表
  `capabilities.episodes` 维持 false 不翻——该字段是短剧频道
  （ai-duanju）的品类映射门（`sourcesForChannel` 只认它，消费
  面 Category 切源名单＋SourceSwitcher），翻 true 会让里番分集
  源进短剧频道名单、且与 surfaces 声明 e（no-drama-mapping）及
  L1 契约「channel-drama 成员仅原生」冲突；集数产出事实以
  `templateCapabilities` 的 multi 为唯一出处，选集面不读 caps，
  两层分工在 registry note 与 templateCapabilities 文件头双处
  钉死。契约 `fix334-g3.contract.test.ts`（旧红：基线无
  episodes.ts 模块缺失；新绿六节含两路径接线文本断言与 caps
  分层守门），详见 `~/workspace/hghub/fix334/evidence/l2-g3.md`。
- **结构批 L3：G4 外部源收藏/历史接线（fix334，未出包）**：外部条
  目此前能播不能藏——收藏/历史只存 hashExternalId 桥接哈希（不
  可逆），Profile 靠原生 api 回查必失败。本线补齐：资料库加
  `extRefs` 快照侧表（同一 Persist 键新可选字段、无迁移，形状与
  修剪口径见 storage-and-preferences 子系统页 5b）；写入四面——
  `SourceBrowse` 详情头收藏钮＋Player `onPlaying` 首帧写历史
  （集数＝当前集 ordinal）、`SourcePosts` 详情头收藏钮（帖子不
  写历史＝原生 parity）、`SourceGallery` 经 AlbumViewer 顶栏动
  作槽注入收藏钮（kind=image 落 postFavs）、`Search` 外部详情
  页头收藏钮（kind 按 merged.kind 映射）＋视频/短剧播放写历史；
  读取一面——`Profile` 命中快照直接出卡（不调原生 api）、未命
  中仍走既有回查，点开经 `routeForSurface` 派生消费定落点
  （deeplink-video/image/posts-page）并带 `openExternalId` 直达
  对应条目（目标不在宿主首屏列表不强求）。`surfaces` library
  派生随之转正：外部已启用源＝browse（ProfileLibrary），L1 的
  g4-pending 在途声明删除。诚实边界：源停用/下线/blocked 后回
  访落既有 P2 三态提示页、不白屏；外部历史只恢复到集不到秒
  （行 t=0/dur=0）。契约 `fix334-library.contract.test.ts`（旧
  红：基线 localLibrary 无 externalHashId 等封装、library 派生
  ＝g4-pending；新绿七节含旧格式读入零变化与逐面接线文本断
  言），详见 `~/workspace/hghub/fix334/evidence/l3-g4.md`。
- **结构批 L4 集成：死面 M20 删除（fix334，3.3.4）**：诊断 App
  内明细面（`registryDiag.sourceHealthDetailLinesInApp`）自立项
  起无任何生产消费者（只有契约文本断言其存在），按 L1 的 D-4
  清扫口径整面删除：函数本体、surfaces 的 `diag-inapp` 声明条
  目与路由分支、wiring 三条明细消费条目（fix321-f7-diag-detail
  ／fix321-f8-diag-params／fix321-f8-diag-fault-class）、四份契
  约里指向它的接线断言（fix321-f2／f7／f8／fix331-reliability，
  其中 f2 的「诊断面保留全量源」改挂导出路径 sourceHealthLines，
  纯函数覆盖不减）。**面数落账：surfaces 21 → 20 面**，完备性契
  约以断言钉死（SURFACES.length＝20、无 diag-inapp、现存面无
  dead 标注）；诊断呈现只剩导出一条路径。如实记账：healthCheck
  的 `selfCheckStatusText` 与 adapterParams 的
  `adapterParamsSegmentText`／`classifySourceFault` 就此失去生产
  消费者（构建器与契约覆盖保留），去留留清扫裁定。集成报告
  `~/workspace/hghub/fix334/integration-report-334.md`。（清扫裁
  定＝删：三构建器已于 fix334 清扫修复线连同其专属契约自测一
  并删除、诊断导出行为不变，见
  `~/workspace/hghub/fix334/evidence/sweep-fixes.md`。）
- **结构批清扫修复：续播到集补实现（fix334，3.3.4）**：独立清扫
  证伪——L3 条目所称「外部历史只恢复到集」此前只有记录与卡面
  显示、无任何回访消费路径，Profile 点开历史恒回第一集（已
  坏-2）。本线补齐消费链：`Profile` 历史点开外部视频时带该行
  `ep`，经 Page/频道页新字段 `openExternalEp` 透传
  `SourceBrowse`，`openItem` 按 ordinal 取回 `choices[ordinal-1]`
  以既有选集/resolve 路径起播（设计 §4.4 机制，不另造路径）；
  单集与无 ep 记录条目行为不变，目标集缺位或取流失败回落默认
  集起播并明示「未能恢复到第 N 集」，不静默串集。口径自此与
  实现一致：外部续播只到集、不到秒（行 t=0/dur=0 不变）。契约
  `fix334-library.contract.test.ts` §7 逐环透传/消费形断言（旧
  红：全仓无 openExternalEp），详见
  `~/workspace/hghub/fix334/evidence/sweep-fixes.md`。
- **最终版 C 呈现：外部详情播放器同规格化＋搜索帖子副本正文全文
  （fix335/c-presentation，3.3.5）**：外部详情是宿主页内嵌态、继
  承页级边距（`--ios-page-inset` 18pt/侧）再叠详情自带 `px-4`，
  且视频面从未对齐原生定高容器——`SourceBrowse` ready 块与
  `Search` 外部详情 video/drama 分支各写一份 `px-4`＋
  `w-full aspect-video`，真机实得 325×183pt 小格子（原生帖子详
  情 393×409pt、`SourcePosts` 357×409pt）。现两处同治（抄
  `SourcePosts` 现成先例，不新造规格）：Player 脱 `px-4`、套
  `relative w-full bg-black`＋`height: min(48vh, 420px)` 定高容
  器、className 改 `w-full h-full`，实得 357×409pt 与
  `SourcePosts` 一致；注记/选集/简介留 `px-4` 块内，Player 本
  体与全屏 hook 不动，scopeKey/选集/守卫落点逐字不变。宿主页边
  距的最后 36pt 差（可选负边距补偿）本批不做：SourceBrowse 详
  情根与页头同根、Search 详情层多 phase 共用容器，补偿会改页
  头对齐与各 phase 宽度一致性，留主线裁定（审计
  `~/workspace/hghub/fix335/audit-player-size.md` 可选 (a)）。
  同批 S2：`Search` 帖子副本此前只消费 detail 的
  cover/description/images、`contentHtml` 在手不渲染——现接
  `SourcePosts` 同一提取—重构链（`extractArticleBlocks` 判据/
  过滤单一出处）：提取到块→article-body 块渲染（块按文档序含
  正文图、图片纵列只在降级路径保留）；定位到内容但段级全杀→
  显简介；提取不到→`sanitizeHtml` 旧渲染（外链经
  `handleArticleClick`＋本页 `openSafeLink`，与正身同实现）；
  再无→简介。证据 `~/workspace/hghub/fix335/evidence/c-presentation.md`
  （scratch 结构夹具改前 7/7、改后断言在旧树 8 红/新树 14/14）。

## 验证命令

```sh
pnpm build
pnpm test:smoke
pnpm test:api-loading
pnpm test:layout
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

`test:smoke` 当前包含 `api-loading`、`storage-migration`、`line-selection`、
`diagnostic-copy`。浏览器 fixture 使用 mock Tauri IPC 且阻断外部请求，
不能证明真实上游的正文结构或账号接口；真实接口变化需要另加网络隔离的 fixture 或手动验证。
