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
   总览空区隐藏（fix330/ui-fixes，用户裁定）：分区「已尝试∧非加载∧无错误∧条目为 0」时整区不渲染（含视频区），谓词单点 `src/features/category/overviewSections.ts` 的 `contentSectionVisible`；频道区 attempted 取 errors 落痕（loadPreview 起始即写），吃瓜区黄果模式走 posts 状态、外部源 browse 模式经 `SourcePosts` 的 `onSettledEmpty` 回报（首批已结∧空），图片区无已启用源时整区不渲染。加载中/未尝试/出错一律保持可见（错误态与重试入口不被整洁吞掉）；blocked/pending 诚实提示不是内容区、恒可见。契约 `overviewSections.contract.test.ts`。
   里番面接线（fix330-riban-surfaces，3.3.0 真机首验复报）：视频品类四源（hanime-api/iwara-api/hanime1/hentaihaven-api 模板）在总览缺席——总览此前只有图片区有源入口列示、吃瓜区有源切换器，视频品类只能先进「视频」频道页再切源片到达（注册表已启用≠浏览面已接通在视频面的复发，与清单 v2 将其中三源置 enabled=false 无关、纯属区段缺席）。现总览新增「视频源」区：与图片区同列示口径（`sourcesForCategory("video", activeSources)`、probe 带「未实测」标、空集整区不渲染），点开推 `cate="video:<源id>"` 深链（与 `image:<源id>` 同约定、不新增路由 kind），`ChannelPage` 专属分支经 `SourceBrowse` 取数、源缺失/blocked 走诚实提示，原生频道加载 effect 对 `video:` 前缀同样跳过。详情面：搜索副本加载核抽为纯模块 `src/features/search/copyLoader.ts`（`loadSearchCopy`，依赖注入、Search 只组装生产依赖），video/drama 分支改先走适配器 `detail` 段（缓存复用、失败降级不阻断取流）再 `resolve`——此前直调 resolve、单副本时详情面 detail 恒 undefined（描述/分集全缺），且失败只能落在从未被探过的 resolve 段。逐 seam 普查结论：App 内路径（结果卡→openMerged→openExternal→loadWithFallback→加载核→createAdapter→detail/resolve；main.tsx 注入；Rust source_fetch/source_post 注册与白名单）无断点，002 适配器本机真实网络 list/detail/resolve 全通；真机失败段收窄在 resolve 独有三段（ct 域 GET/WebCrypto/auth 域 POST＋设备出口），F7 自检只探 list+detail 不探 resolve——该缺口待后续自检扩探针解决，本批不冒充已修。契约 `fix330-riban-surfaces.contract.test.ts`（category/search 两份，四源逐源场景＋列示口径，基线旧红）；接线清单 fix330-riban-* 三条。
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
- 封面状态机（同批）：`ImageLoad` 状态 loading→decoded→displayed 或
  failed(reason)（http/timeout/decode 分因），每 attempt 20s 超时，
  src 变化自动重试；失败计数与分页证据同节进诊断报告。fix2.1 修正
  超时起算点：attempt 计时自「实际加载开始」（进入视口预热区
  rootMargin 600px、eager 图为挂载时）起算——img 是 lazy，视口外
  根本不发请求，旧实现自挂载起算会把离屏封面的 attempt 依次烧光、
  回滚进来只见永久失败占位。
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
- 图集查看器形态（3.2.1 fix321-F6，2026-11-19 用户实报图片太小）：图集查看统一走共用 `AlbumViewer`（`src/features/sources/AlbumViewer.tsx`，SourceGallery 与搜索图片详情同治）——舞台填满可用高度（SourceGallery 为 fixed 覆满视口、搜索详情页内 h-full）、图片 contain 贴边、无写死比例盒子与上下张按钮行；标题/计数/返回/关闭/缩略图条收进悬浮层（静止 3s 自动淡出、中央点按显隐、左右点按与横滑翻页、缩略图点选跳张且当前张高亮定位），index 受控于调用方单份状态。手势归属（fix322/gallery，2026-11-19 用户实报 146 张图集条划不动）：悬浮层的 touch 事件一律 stopPropagation、与舞台横滑完全隔离，缩略图条本体 `touch-action: pan-x` 走原生横滚快速定位；舞台 touchcancel 清手势起点。几何与条手势由 `scripts/test-layout.mjs` gallery 场景守门（舞台占可用区 ≥98%＋源码层无 4/5 写死盒＋146 张条场景：条上横拖不翻页/快划大位移/尾部点选/翻页后跟随可见）。快速滑动不消失（fix330/ui-fixes，2026-11-19 用户真机实报「图片预览滑的快了会直接消失隐藏」）：双机制根治——(1) 舞台窗口化：只挂当前张±1 三帧（`data-album-frame` 按 index 定 key、仅当前张不透明），邻图随挂载预取，旧单 `Img` 以 src 为 key 逐张重挂在慢图源下快翻张张空白；(2) chrome 活动续命：淡出计时新增活动依赖——缩略图条 `onScroll` 与悬浮层 touch 经 `pokeChrome`（500ms 节流）重置计时，旧计时只挂呼出/切张，条上划找图满 3s 整层在指下淡出。夹具：layout gallery 条场景⑤（条上持续活动跨 3s 闲置窗 chrome 仍可见、停手恢复淡出）＋新场景 gallery-fast-swipe（图源延迟 900ms 下连翻 6 张，落点窗口三帧在场＋邻图请求已发；两场景旧码均红）。沉浸式安全区（fix330/gallery-viewer，2026-11-19 真机实报全屏 chrome 与状态栏重叠）：AlbumViewer 新增 immersive 模式——chrome 内边距按 --sat/--sab/--sal/--sar 让位，fixed 宿主 SourceGallery 传入、搜索详情页内嵌不传（宿主页已处理、免双重让位）；舞台本体不让位保持全幅。缩略图随可见性加载（同线，真机实报全条除当前张外全 HG 占位）：条内缩略图改以条本体为 root 的 IO 闩锁（nearThumbs，进窗含 600px 预取边距才挂 Img 且 eager 取图、闩锁常驻，窗外只占位不发请求不起时钟）；根因是全量 lazy 挂载下浏览器取图窗口（条滚动口）与 Img attempt 时钟窗口（主视口 IO）脱节、且 load effect 重跑会重置 settled 把已加载图误判超时烧光 attempt——Img 侧同步加对账（`settleOkFromDom`：起算前与 timeout 裁决前先核 DOM img 真实状态）。夹具：layout gallery-safe-area（注入 --sat 47/--sab 34 断言顶栏/底条不侵入系统带）＋gallery-strip-load（126 张断言挂图数有界、远端未请求、滚动后尾部出图），两场景旧码均红；WebKit 探针另证已加载图跨 20s 无误烧重拉。
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
- Hanime 取流握手 403 定性＋分段留痕（3.3.2 fix331-hanime-403，2026-11-20）：3.3.1 真机详情已通、点播放报握手 403（CSRF 段已过、auth 域 POST 被拒），且该失败发生在诊断会话内而导出零记录（POST 接缝无取页埋点、GET 侧记录按 baseUrls host 归属错位、自检为旧账）。定性（本机 VM 出口对照）：经适配器本体复刻生产形态全链仍通（3 档流）；HTTP 头层变异矩阵（UA 三变体/头序反转/Accept 两形态/Accept-Language/Accept-Encoding/HTTP2）全部通过，唯一敏感点为 Origin 与 Referer 双缺失 → 401（固定码 UA1，属协议校验、与 403 不同类，且 App 恒带双头）；再以与生产同版本 reqwest 0.12.28＋rustls 0.23.46 实发同一份握手材料 → 200 且回 x-token，TLS 指纹在本机出口同样不被拒。裁定：请求形态因素（HTTP 层＋TLS 层）在本机不可证、权重移至设备出口因素（设备会话网络基线健康：ok_proxy/line-01 568ms/3.5MB/s，GET 段同出口均通、独 POST 被拒，形态与「敏感端点按出口 IP 地区/信誉拒」相容；同系 hanime1.me 封日本 IP 为在案记录、hanime.tv 本体无此记录，地区说为推断、待用户换节点对照回收）。处置：①resolve 三段（csrf/handshake/decode）失败经 `traceResolveFailure` 落 `source.resolve_fail` 留痕（稳定编号＋段名＋固定错误码＋HTTP 状态＋尝试序，纯函数 `resolveFailureEventData` 组装、键集合封闭、无敏感值位置），下次真机失败在导出中可定位到段；②握手 403 的用户文案带出口提示（「站点拒绝了当前网络出口，切换线路或节点后重试」），非 403 维持裸状态；③不引入任何绕过站点访问控制的手段（不仿浏览器指纹、不改协议头集合），`needsNonJpExit` 无生产消费者、仅为记录标记，本线不动注册表。证据 `~/workspace/hghub/fix331/evidence/hanime-403.md`，契约同 `fix330-hanime-api.contract.test.ts`（留痕组装定值＋终局 403/500 文案）。
- 保留源接通批·新适配器线（3.3.0 fix330，2026-11-19）：Iwara/Hanime1 自探路保留转专用适配器启用、HentaiHaven 自目录导入毕业为命名源并启用——`iwara-api`（api.iwara.tv：/videos 列表 0 基分页、/search 搜索、/video/<id> 详情、fileUrl＋X-Version 签名取流多档 mp4；签名头经 Rust `source_fetch` 仅对 files/filesq.iwara.tv 两 host 定向放行 `X_VERSION_SCOPED_ORIGINS`，同 RedGifs Authorization 定向先例）、`hanime1`（HTML：/search 列表与搜索同端点、/watch 详情、watch/download 页 <source size>/data-url 多档 mp4 取最高档；`needsNonJpExit` 保留）、`hentaihaven-api`（/api/manga/ 目录与搜索 JSON、/watch/<slug>/ 详情与 episode 分集、集页 ld+json VideoObject contentUrl 取 HLS）。三源 `capabilities.search` 据实为真（站点均有搜索接口）→ 搜索扇出名单 7→10 源（`multiSourceSearch` 的 SEARCH_TEMPLATES 同步纳入三模板）；取页白名单模板声明新增 iwara-api 三 origin（API＋两文件 host，与适配器回落常数共用同一出处）。结构依据为 Hentai-Park 公开插件的协议事实（只借协议/结构、代码原创），夹具为按声明形态构造的合成样本；三源 maturity 均 probe（住宅验收：Iwara/Hanime1 四级全通在案、HentaiHaven 两级筛查在案；本机机房出口三源均 CF 403、与住宅结论分开记录；App 未真机验不上调）。证据 `~/workspace/hghub/fix330/evidence/new-adapters.md`，契约 `fix330-new-adapters.contract.test.ts`。- 源健康自检（3.2.1 fix321-F7，2026-11-19 新立项）：`src/features/sources/healthCheck.ts`——诊断「源总览」里没被用户点开过的源永远是「未发生」，行不行此前只能靠外部逐站人工验（验的是浏览器环境、不是 App 取页链）。自检替代之：启动后延迟 90s 静默开轮、分片错峰（每片 3 源、片间 45s），对全部已启用源（未启用/blocked/preview/none 与 preview-only 模板不探，blocked 按 maturity 排除）用其自身适配器走生产取页链（模板经 fetchPage→Rust `source_fetch`＋当前线路，原生黄果经既有 api 通道），每源硬预算 2 请求（列表 1 页＋有条目时详情 1 条，不取流）。结果逐源落盘 `hghubx_source_selfcheck_v1`（源 id/时刻/列表成败＋条目数/详情三态/失败形态/请求数，不记 URL/查询），TTL 24h 内不重探（一天最多一轮全量、跨重启算新鲜度）。呈现只进诊断两条路径且口径分清：导出 `sourceHealthLines()` 尾加自检行组（汇总＋稳定编号逐源行）、App 内明细 `sourceHealthDetailLinesInApp()` 每行并入自检段——均标「最近自检」口径，与「本会话取页」三态并存不互盖；无结果计「未自检」不冒充未发生。失败形态与取页健康同源（`adapters/fetchErrorClassify.ts` 的 `classifyFetchError` 为唯一出处，fetchHealth 再导出）：网络不可达/超时/校验拒绝/响应过大归「网络类」、HTTP 状态单列、`SourceParseEmptyError` 记「解析为空」、详情步未分类失败记「详情失败」，列表与详情分开记、详情失败不翻列表结论。红线：静默（无弹窗/角标/任何用户可见打扰）、只记观测不自动处置（不改任何源启用/成熟度）、调度在 `main.tsx` 启动装配注册且纯旁路（异常不影响启动与使用）。契约 `fix321-f7.contract.test.ts`（调度注册/结果进诊断/预算与资格，适配器经注入接缝隔离、不访问上游网络）。
- 清单参数下发（3.2.1 fix321-F8，2026-11-19 新立项「适配器抗失效」）：`src/features/sources/adapterParams.ts`＋`manifest.ts`——hls-site 模板源（内置注册表 32 源）的模板参数可由远程清单声明式下发、免发版热修站点改结构/改域名。清单条目扩展可选 `adapterParams`＋`paramsVersion`（per-source 整数）＋条目级 `minAppVersion`（高于当前 App 版本仅参数不应用）；可下发字段冻结为模板现行 params 字段 `listPath`/`itemLinkPattern`/`detailPath`（取流提取是 parse.ts 固定正则、无参数字段，不设下发字段；baseUrls 走既有通道归入本机制口径）。schema 在 `validateManifest` 内逐条目校验（相对路径形态/长度上限/禁 javascript:、data: 等危险形态）：参数非法只丢该条目参数、整份清单与 enabled/baseUrls 覆盖照常（与既有整份丢弃口径的差异及理由见 adapterParams.ts 文件头⑤）。`applyManifest` 仅对 hls-site 源把校验过的参数覆盖到生效 def 的 `adapter.params`（createAdapter 读生效 def 即得新参数、对适配器透明），不触碰 enabled/maturity、名单冻结不变；覆盖同时落盘已应用快照 `hghubx_adapter_params_v1`（{sourceId, paramsVersion, params, appliedAt, 内置参数 FNV-1a 指纹, status}）。应用后验证与自动回滚：`main.tsx` 在注册表落定后调 `verifyAppliedAdapterParams`（接缝注入 healthCheck 的 `runSourceSelfCheck`，不另写取页），pending 源逐源自检——应用前自检为好/未知且应用后列表失败（含解析为空）→ `revertActiveSourceParams` 回滚内置参数＋记 rejected 版本（同 paramsVersion 不再重复应用、防抖动循环）；自检通过或应用前已坏（非本次变坏）→ 确认 applied。F7 联动定性：纯函数 `classifySourceFault` 给失败源标故障类——hls-site 且失败形态属解析为空/列表 HTTP 状态/baseUrl 不可达（网络类）→「参数可热修」，其余（非 hls-site 模板、详情步失败、未分类失败）→「需发版」；`registryDiag` App 内明细行呈现「参数来源：清单 vN／已回滚」段与故障类标注。红线：只许声明式参数、绝无远程代码执行；不放宽 https 起点/scheme/CSP 校验；应用/回滚全程静默、只进诊断。wp-rest/chigua 模板本批不扩（参数形态不同，留后续批次）。契约 `fix321-f8.contract.test.ts`（schema/应用生效/回滚/故障分类，清单与自检均经注入接缝、不访问上游网络）；顺手修正：`manifest.ts` 的 `FALLBACK_APP_VERSION` 与 package.json 同步为 3.2.1。
- 吃瓜帖外部源浏览面接通（3.3.0 接通批·吃瓜线，2026-11-19）：此前唯独 posts 分类未接浏览组件——Posts 页与分类总览对一切非黄果源无条件 `SourcePendingNotice`、适配器从未被调用，已启用源（如黑料网）真机点开恒提示页（根因与 maturity/capabilities 无关）。现判定收敛为 `src/features/sources/postsRoute.ts` 的 `resolvePostsBrowse`（黄果→native、blocked/缺失→blocked 诚实提示、其余已启用→browse），Posts 页（全量）与分类总览（compact 预览）共用；browse 经 `SourcePosts` 走适配器 list/detail/resolve 真实渲染（详情先文后视频、点了才播，与原生 PostDetail 的 D2 口径一致）。同批：每日大赛解 blocked（主域换 www.mrds66.com 与清单 v3 一致、listPath 按真站校准为 /page/{page}/、maturity 改判 probe）；chigua 模板搜索按源校准——`params.searchPath`（51吃瓜/每日大赛实证 /search/{q}/{page}/、caps.search 据实 true 进扇出；模板默认 /?s=&paged= 形不变、未声明源不受影响），黑料网经实证无 GET 搜索段（三种形态均返回关键词不变页）caps.search 维持 false；黑料网详情正文容器 editormd-preview 已入 chigua 模板正文捕获（旧两式恒空）。契约 `fix330-chigua.contract.test.ts`，证据 `~/workspace/hghub/fix330/evidence/chigua.md`。
- 吃瓜正文图载体与基址修复（3.3.1 fix330/post-images，2026-11-19，证据 `~/workspace/hghub/fix330/evidence/post-images.md`）：3.3.0 真机三源帖子正文可开但图全破——真站正文图真实地址在主题/插件懒加载载体属性上（z-image-loader-url/x-image-loader-url/data-image-zoom/data-xkrkllgl），src 常为相对占位；正文清洗链（`src/shared/lib/html.ts`）旧候选链不认载体（先被 DOMPurify 输入白名单删、无 src 图整张移除），且相对地址一律按黄果站补全错源。现 proxyImages 候选链按「经典懒加载 data-* → loader 载体 → src 垫底」提取，载体属性只进两道清洗的输入白名单（提取后移除、不进最终输出白名单）；sanitizeHtml 新增可选 base（外部源由 SourcePosts 传详情页 href 作相对地址补全基址，原生消费方不传、默认原生站不变），正文链接点击 handleArticleClick 同步吃 base。夹具 `tests/html-security.ts` 两用例基线红、修复后全页 33/33 绿。
- 吃瓜正文提取—重构（3.3.1 fix330/reader，2026-11-19，用户 23:59 裁定「只看有用的、废话广告全砍」，证据 `~/workspace/hghub/fix330/evidence/reader.md`）：SourcePosts 正文不再走 sanitizeHtml 整页清洗渲染，改经 `src/features/sources/articleBlocks.ts` 的 `extractArticleBlocks` 从 detail.contentHtml 按文档顺序提取内容块（文本段落／图片）原生重渲染（article-body 既有样式）——广告位/假按钮/导航/评论/相关推荐/分享件在提取层不入块（非正文元素整棵跳过＋类名段精确匹配的垃圾容器排除，类名误包正文时有不按类名重走的保底）；段级过滤只杀高置信垃圾（防走失/地址发布、下载 App 引导、扫码进群、整段 CTA/裸域名行、≤48 字短段的加群引导、与标题/正文精确重复段），长叙事等形似正文一律保留（夹具反例守门）。图片地址解析收敛为 html.ts 的 `articleImageSrc` 单一出处（proxyImages 与提取层共用，候选链＋安全门＋基址口径一致、地址集合夹具钉死相等），渲染仍走本地 /img 路由。降级链：提取到块→块渲染；located（定位到内容）但全被过滤→显 detail 简介；未 located（结构未知）→维持 sanitizeHtml 旧渲染。元信息（标题等）沿用 detail 数据、正文内链接不渲染为锚点，回源走页脚「查看原文」（openSafeLink 打开 detail.href）。sanitizeHtml 本身保留：其余消费方＝原生 Panels 的 ArticlePanel、原生 Posts 的 PostDetail（均不传 base、行为不变），SourcePosts 仅在降级路径消费。夹具 `tests/article-reader.ts`（三源形态＋反例＋安全门共 12 例，基线无提取层为红、修复后全绿；html-security 仍 33/33）。
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
