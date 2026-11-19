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
   扇出资格三段齐全门（3.2.1 修复 F5，`missingSearchSegments`）：外部源只有搜索＋详情＋取流三段都有真实现（模板可实例化＋`capabilities.search`＋`maturity=stable` 验通标记＋非未校准骨架）才进扇出；分层总表的 `INCLUDE_OVERRIDE` 只能在三段齐全者中生效、不得绕过。缺段源静默出局（不发请求、不记失败）、注册保留、频道浏览不受此限。现行扇出名单恰为三段验通 7 源（黄果/91视频/Pornhub/XVideos/Fyptt/Rule34Video/CosplayTele）；Shorties 等 13 源因缺段移出（逐源缺段见 `fix321-f5.contract.test.ts`）。
   分类浏览（`src/features/category/Category.tsx` 总览与频道页）与搜索共用同一性质判定（`src/shared/lib/contentKind.ts` 的 `kindForHuangguoVideo`/`partitionCardsByKind`，3.2.1 F4 线抽共用、搜索层只 re-export）：有分集结构（`total_episodes`/`episode_count`＞1）的条目只归短剧——总览视频区只渲染 video 组、original 频道混入的 drama 组补入短剧区（按 id 去重）；「视频」频道页服务端分页 incoming 先剔 drama 组再入列表，`page`/`pages` 仍按服务端原值推进与终止（单页可见数可少于页大小、整页被滤光时靠哨兵/加载更多续翻下一服务端页，不提前到底）。此前浏览面按频道直渲染 original 列表，《警界之花》（3 集）同时出现在短剧与视频两区（用户实报）。
   搜索面同病（3.2.1 F4b 线）：通用搜索端点 `/api/search?type=video` 的载荷不下发剧集结构信号（字段缺失或恒 0；本地 Rust/前端三层审计无丢弃点、信号丢在上游响应本身，证据 `fix321/evidence/f4b/root-cause.md`），同 ID 条目在频道/详情里却有——判定函数在场也无信号可用、必然默认落视频（搜「御姐」视频页签混入同批 AI 短剧，用户实报）。搜索归类改走 `contentKind.searchKindForHuangguoVideo`（仍为唯一出处）：卡自带正计数信号直接判；信号缺失者由 Search 以条目 ID 查 `api.video` Detail 规范信号补判（`hgCanonicalSignals`，作用域＋线路代次进 key、并发 4、失败静默）；补判也无信号 → `unknown` 安全侧暂扣、不进任何页签（不默认落视频、不猜落短剧），补判到达后自动重归类。代价：详情不可达条目在搜索中暂不可见。浏览面不走补判（频道载荷信号齐全、0 集即真无分集）。
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
- 封面状态机（同批）：`ImageLoad` 状态 loading→decoded→displayed 或
  failed(reason)（http/timeout/decode 分因），每 attempt 20s 超时，
  src 变化自动重试；失败计数与分页证据同节进诊断报告。fix2.1 修正
  超时起算点：attempt 计时自「实际加载开始」（进入视口预热区
  rootMargin 600px、eager 图为挂载时）起算——img 是 lazy，视口外
  根本不发请求，旧实现自挂载起算会把离屏封面的 attempt 依次烧光、
  回滚进来只见永久失败占位。
- 横向手势仲裁（fix2.1）：App 链式手势五级优先级——输入/横滚区 >
  全屏 scrub 独占 > 单击/双击/长按（播放器表面内部仲裁）> 栈页右划
  pop（300ms 冷却防连退）> 详情页左划下一条。左划下一条仅在栈顶
  feed 页、起手落在详情信息区（`data-feed-info-zone`，视频控制层/
  图文帖信息块）且不在进度条区（`data-feed-scrub-zone`）时经
  `detailNext` 通道触发，语义与桌面 onNext 一致（先下一集、后下一条）。
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
- 图集查看器形态（3.2.1 fix321-F6，2026-11-19 用户实报图片太小）：图集查看统一走共用 `AlbumViewer`（`src/features/sources/AlbumViewer.tsx`，SourceGallery 与搜索图片详情同治）——舞台填满可用高度（SourceGallery 为 fixed 覆满视口、搜索详情页内 h-full）、图片 contain 贴边、无写死比例盒子与上下张按钮行；标题/计数/返回/关闭/缩略图条收进悬浮层（静止 3s 自动淡出、中央点按显隐、左右点按与横滑翻页、缩略图点选跳张且当前张高亮定位），index 受控于调用方单份状态。几何由 `scripts/test-layout.mjs` gallery 场景守门（舞台占可用区 ≥98%＋源码层无 4/5 写死盒）。
- 源健康自检（3.2.1 fix321-F7，2026-11-19 新立项）：`src/features/sources/healthCheck.ts`——诊断「源总览」里没被用户点开过的源永远是「未发生」，行不行此前只能靠外部逐站人工验（验的是浏览器环境、不是 App 取页链）。自检替代之：启动后延迟 90s 静默开轮、分片错峰（每片 3 源、片间 45s），对全部已启用源（未启用/blocked/preview/none 与 preview-only 模板不探，blocked 按 maturity 排除）用其自身适配器走生产取页链（模板经 fetchPage→Rust `source_fetch`＋当前线路，原生黄果经既有 api 通道），每源硬预算 2 请求（列表 1 页＋有条目时详情 1 条，不取流）。结果逐源落盘 `hghubx_source_selfcheck_v1`（源 id/时刻/列表成败＋条目数/详情三态/失败形态/请求数，不记 URL/查询），TTL 24h 内不重探（一天最多一轮全量、跨重启算新鲜度）。呈现只进诊断两条路径且口径分清：导出 `sourceHealthLines()` 尾加自检行组（汇总＋稳定编号逐源行）、App 内明细 `sourceHealthDetailLinesInApp()` 每行并入自检段——均标「最近自检」口径，与「本会话取页」三态并存不互盖；无结果计「未自检」不冒充未发生。失败形态与取页健康同源（`adapters/fetchErrorClassify.ts` 的 `classifyFetchError` 为唯一出处，fetchHealth 再导出）：网络不可达/超时/校验拒绝/响应过大归「网络类」、HTTP 状态单列、`SourceParseEmptyError` 记「解析为空」、详情步未分类失败记「详情失败」，列表与详情分开记、详情失败不翻列表结论。红线：静默（无弹窗/角标/任何用户可见打扰）、只记观测不自动处置（不改任何源启用/成熟度）、调度在 `main.tsx` 启动装配注册且纯旁路（异常不影响启动与使用）。契约 `fix321-f7.contract.test.ts`（调度注册/结果进诊断/预算与资格，适配器经注入接缝隔离、不访问上游网络）。
- 清单参数下发（3.2.1 fix321-F8，2026-11-19 新立项「适配器抗失效」）：`src/features/sources/adapterParams.ts`＋`manifest.ts`——hls-site 模板源（内置注册表 32 源）的模板参数可由远程清单声明式下发、免发版热修站点改结构/改域名。清单条目扩展可选 `adapterParams`＋`paramsVersion`（per-source 整数）＋条目级 `minAppVersion`（高于当前 App 版本仅参数不应用）；可下发字段冻结为模板现行 params 字段 `listPath`/`itemLinkPattern`/`detailPath`（取流提取是 parse.ts 固定正则、无参数字段，不设下发字段；baseUrls 走既有通道归入本机制口径）。schema 在 `validateManifest` 内逐条目校验（相对路径形态/长度上限/禁 javascript:、data: 等危险形态）：参数非法只丢该条目参数、整份清单与 enabled/baseUrls 覆盖照常（与既有整份丢弃口径的差异及理由见 adapterParams.ts 文件头⑤）。`applyManifest` 仅对 hls-site 源把校验过的参数覆盖到生效 def 的 `adapter.params`（createAdapter 读生效 def 即得新参数、对适配器透明），不触碰 enabled/maturity、名单冻结不变；覆盖同时落盘已应用快照 `hghubx_adapter_params_v1`（{sourceId, paramsVersion, params, appliedAt, 内置参数 FNV-1a 指纹, status}）。应用后验证与自动回滚：`main.tsx` 在注册表落定后调 `verifyAppliedAdapterParams`（接缝注入 healthCheck 的 `runSourceSelfCheck`，不另写取页），pending 源逐源自检——应用前自检为好/未知且应用后列表失败（含解析为空）→ `revertActiveSourceParams` 回滚内置参数＋记 rejected 版本（同 paramsVersion 不再重复应用、防抖动循环）；自检通过或应用前已坏（非本次变坏）→ 确认 applied。F7 联动定性：纯函数 `classifySourceFault` 给失败源标故障类——hls-site 且失败形态属解析为空/列表 HTTP 状态/baseUrl 不可达（网络类）→「参数可热修」，其余（非 hls-site 模板、详情步失败、未分类失败）→「需发版」；`registryDiag` App 内明细行呈现「参数来源：清单 vN／已回滚」段与故障类标注。红线：只许声明式参数、绝无远程代码执行；不放宽 https 起点/scheme/CSP 校验；应用/回滚全程静默、只进诊断。wp-rest/chigua 模板本批不扩（参数形态不同，留后续批次）。契约 `fix321-f8.contract.test.ts`（schema/应用生效/回滚/故障分类，清单与自检均经注入接缝、不访问上游网络）；顺手修正：`manifest.ts` 的 `FALLBACK_APP_VERSION` 与 package.json 同步为 3.2.1。
- 吃瓜详情排版（最终版 D2 线，2026-11-19，用户实报）：`PostDetail`
  先文后视频——标题/元信息/标签/动作行/介绍正文在前，播放器区
  （`data-post-media`）移到正文之后；仍是点了才播（分段只解析备好、
  海报点击才 `setPlay`，排版调整不改变装载时机）。播放封面 Button
  必须带 `rounded-none`：`.ios-button` 全局胶囊圆角（999px）会被
  `.ios-image{border-radius:inherit}` 继承并经 `overflow:hidden`
  把封面裁成大椭圆（黑边圆罩，用户实报 bug）；回归脚本
  `scripts/test-post-detail.mjs`（夹具 `tests/post-detail`）断言
  DOM 顺序、未点击零视频装载、封面框计算圆角 0px。

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
