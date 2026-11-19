# 播放

## 责任与边界

播放子系统负责把 `api_play`/帖子播放接口返回的媒体地址变成一个可播放的
`<video>`：选择 hls.js 或原生播放、管理播放/暂停意图、HLS 恢复、seek、播放时钟、
全屏/画中画、观看进度和本地媒体传输。它同时服务首页/列表里的 Feed 播放器和吃瓜详情的
内嵌 `Player`。

不在这里负责：详情和标签门的请求策略（见 [feed-and-detail.md](feed-and-detail.md)）、
上游线路选择与凭据（见 [upstream-lines.md](upstream-lines.md)）、网络代理与媒体字节
校验（见 [network-proxy-media.md](network-proxy-media.md)）。播放器只消费已经通过
作用域/标签检查的地址。

## 事实来源

- Feed 调用方：[`src/features/feed/Feed.tsx`](../../src/features/feed/Feed.tsx) 中的
  `requestPlay`、`playKey`、`playGuard`、`isCurrentPlayback`、`onTimeTick`、
  `onDurationTick`、`resumeRef`、`enterFs`/`exitFs`、`keepAlive`。
- Feed 播放内核：[`src/features/playback/VideoSurface.tsx`](../../src/features/playback/VideoSurface.tsx)
  的 `VideoSurface`、`VideoHandle.seek`、`reportSize`、`handleVideoError`。
- 共用播放内核（最终版 A 线收敛）：[`src/features/playback/usePlaybackKernel.ts`](../../src/features/playback/usePlaybackKernel.ts)
  的 `usePlaybackKernel`——VideoSurface 与 Player 共用一份：诊断登记/注销、活动层
  消费、全局 playing 置位、PlaybackFacts 发布、HLS 分片吞吐回写（按当前线路 base
  记账）、SR 密度采样接入、append 看门狗接线、首分片 rendition 与呈现档/降档计数。
  两面只留渲染与控件差异；Player 经此获得 facts 发布与吞吐回写（此前只有
  VideoSurface 有，GPT 复审 P2-09）。HLS 观察经内核以代次捕获 trace
  （`captureTrace`）登记：换源后旧 HLS 实例的迟到事件按起源代次被账本拒收并计
  droppedLate，不记成新代次（P2-08）。
- 内嵌播放器：[`src/features/playback/Player.tsx`](../../src/features/playback/Player.tsx)
  的 `Player`，以及 `PlayerControls.tsx`、`PlaybackLock.tsx`、`PlaybackProgress.tsx`。
- 恢复与时钟：[`hlsRecovery.ts`](../../src/features/playback/hlsRecovery.ts) 的
  `createHlsRecovery`；[`playbackClock.ts`](../../src/features/playback/playbackClock.ts)
  的 `createPlaybackClock`；[`usePlaybackActivity.ts`](../../src/features/playback/usePlaybackActivity.ts)、
  [`useProxyPlaybackRecovery.ts`](../../src/features/playback/useProxyPlaybackRecovery.ts)。
- 输入与传输：[`useSeekInput.ts`](../../src/features/playback/useSeekInput.ts)、
  [`useInlinePlayerFullscreen.tsx`](../../src/features/playback/useInlinePlayerFullscreen.tsx)、
  [`src/shared/lib/fullscreen.ts`](../../src/shared/lib/fullscreen.ts)、
  [`mediaTransport.ts`](../../src/features/playback/mediaTransport.ts)、
  [`mediaErrors.ts`](../../src/features/playback/mediaErrors.ts)。
- 后端传输：[`src-tauri/src/ios_media_http.rs`](../../src-tauri/src/ios_media_http.rs)、
  [`src-tauri/src/linux_http.rs`](../../src-tauri/src/linux_http.rs)、
  [`src-tauri/src/media/mod.rs`](../../src-tauri/src/media/mod.rs)、
  [`src-tauri/src/media/response.rs`](../../src-tauri/src/media/response.rs)、
  [`src-tauri/src/media/hls.rs`](../../src-tauri/src/media/hls.rs)、
  [`src-tauri/src/media/segment.rs`](../../src-tauri/src/media/segment.rs)。

## 主运行时路径

1. Feed 通过 `api.play(id, ep)` 取得 `streams.main`、旧字段 `video_url`，或仅存在 HEVC 时的
   `streams.hevc`/`video_url_hevc` 回退；`preferHevc` 且存在 `streams.hevc` 时优先 HEVC。播放器拿到的是上游 m3u8，
   通过 `playbackSource` 转成 `${LOCAL}/hls?u=...`；已经是 `/hls`、`/seg` 的本地地址
   不会被重复包裹。
2. `VideoSurface` 在 `Hls.isSupported()` 且不是直通 `/seg` 时创建 hls.js；
   否则进入原生 `<video>`。iOS 原生传输调用 `media_http_origin`，把能力前缀拼到
   `127.0.0.1` 的 `/hls`/`/seg` 路由；Linux 的 `LOCAL` 固定为
   `http://127.0.0.1:17650`，由 GStreamer 直接取 HLS。
3. hls.js 使用 `autoStartLoad: false`，在 `MANIFEST_PARSED` 后按
   `startPosition`/`resume` 调 `startLoad`。`FRAG_BUFFERED` 清空恢复计数和错误；
   `ERROR` 只把 fatal network/media 交给 `createHlsRecovery`。
4. `usePlaybackActivity` 在页面失活时暂停并 `stopLoad()`（处于画中画 `pictureInPictureElement`
   时保持播放，退出画中画且页面仍失活时再暂停），在重新激活时按 `wanted` 与 `startPosition`
   恢复；`play()` 的 Promise 返回后会再次检查页面是否仍激活。
5. seek 有两种入口：桌面 `useSeekInput`/`PlayerControls`，移动端
   `useSeekInput`/进度条手势。指针移动只预览，松手提交一次；
   `VideoSurface.seek` 把目标夹到 `duration - 0.15`（避免 iOS 片尾卡死），
   通知 hls `startLoad(target)`，写入 `currentTime`，原本在播放才续播。
   seek 手势仲裁（最终版 B2 线追加，用户实报「拖进度条极易误触别的
   界面」）：三处 seek 输入的有效触控高度一律 ≥28px（Feed 两处 scrub
   区、桌面 `.desktop-seek`、帖子 `.hg-range`；视觉轨道不变）。共享层
   `useSeekInput` 出仲裁：指针位移过 3px（moved 阈值）即 scrub 成立，
   经 `onInteraction` 发 `scrubstart/scrubend(drag)` 并以 `scrubbing`
   态对外，两宿主消费同一份；拖动结束后 500ms 内的 click 由共享层
   吞掉（无位移点击不吞），不许冒泡触发宿主显隐/播放切换。Feed 移动
   进度条（阈值 8px）起手即取消挂起的单击显隐判定（250ms 窗），区内
   capture＋stopPropagation＋touchAction:none 使竖向超阈也不转交切
   作品/滚动；拖动后的尾随 click 由区自身吞掉。仲裁全程静默：独占锁
   不产生任何可见提示（`is-scrubbing` 只作宿主状态钩子）。Feed 主手
   势面阈值不变：横拖定位 |dx|>14 且占优、竖滑 |dy|>14 进 pan／抬手
   |dy|>56 切作品、长按 380ms。
6. 播放时钟是外部 store：`onTime` 只 `publish` 时钟，进度组件
   `PlaybackProgress`/`PlaybackTime` 用 `useSyncExternalStore` 重绘，避免整个 Feed
   每 250ms 重渲染。Feed 每 5 秒把观看进度通过 `addHistory` 落盘，卸载时再补一次。
7. `hg:proxy-changed` 会触发 `useProxyPlaybackRecovery.retry`：保存
   `src/time/playing/rate`，增加 revision，在同一 `video` 元素上重建 HLS/原生媒体连接；
   收到 metadata/data 后恢复位置、倍速与播放意图，期间用户显式暂停则保持暂停。

## 状态转换

- `src` 变化：清理旧 HLS/原生连接 → 清空尺寸和错误 → `waiting` →
  manifest/metadata → `playing`、`paused` 或 `error`。
- HLS 故障：fatal network/media → `pending` → 250ms × (attempt+1) 后尝试 →
  成功缓冲回到正常；第 4 次后交给 `onFatal`。非 network/media fatal 立即结束。
- 页面失活：`active=false` → 暂停 + `stopLoad()`；被标签门/教程覆盖也走同一条
  active 边界，不启动后台恢复。
- 页面恢复：只有 `wanted=true` 才恢复；原生控件造成的暂停也要被记住，不能凭
  “之前自动播放过”强行继续。原生暂停的写回由活动层 pause 事件监听承担
  （最终版 B 线 P1-02）：我方 pause 先计数、监听按数消费，未被消费的
  pause 事件（PiP/系统控件/iOS 原生全屏）一律写回 wanted=false＋
  pauseKind=user（trace `pause.request` source=native_controls）；换源
  拆除型暂停（currentSrc 空/readyState=0）不表态。回归见
  playback-engines FIN-B1 组。
- 松手剖面（最终版 B 线）：ratechange 退出 ≥2x 域起，Feed 剖面器
  （holdJank.createHoldReleaseProfiler）收齐首帧呈现与 SR 重接管
  时刻后落 `hold.release_profile` 分段耗时。松手帧口径（fix322/sr
  线，2026-11-19）：B 线的 releaseSkip（松手首帧让行一帧 SR 处理）
  已移除——WebGPU 画布是不透明覆盖层，视频本体在画布之下不可见，
  让行只把画布更新推迟一个 rVFC 周期、且与速率切换后帧队列重定时
  的延迟在松手帧上叠加；现行松手不跳帧、首个 1x 帧照常处理。
  SR 呈现时刻口径同步改正：旧实现在 processFrame 同步返回（＝命令
  提交）时即记 present，GPU 侧停顿对剖面不可见；现由引擎完成回调
  `onFrameDone`（onSubmittedWorkDone 落定）在工作完成时以 doneAt
  记 present（提交归属按在飞帧的提交时刻与最近松手时刻比对）。
  报告长按松手分组节除桶计数外印最近 3 条剖面分段值与两桶尾窗
  最大帧间隔（post_max_gap_ms），判读不依赖账本尾段导出。回归见
  `fix322-sr-release.contract.test.ts`。
  判别力与补字段（最终版 B3 线）：剖面行与 `hold.jank` 行必带
  `sr_engaged` 显式布尔＋`pipeline`（SrCanvas 在管线切换点经
  noteHoldPipelineState 登记；用户侧无手动引擎开关、做不了 A/B，
  判读只认显式字段不靠 SR 段 null 推断）；剖面行另带 rVFC
  metadata（rvfc_media_time/presented_frames/expected_display_time）、
  主线程长任务聚合（longtask_*，不支持记 null）、Feed/SR 组件面龄
  与窗口内重挂/卸载、HLS 实例 ID 与窗口内重建标志。聚合口径＝
  holdJank.summarizeHoldEvents（engaged/bypass 两桶，无显式布尔
  不入桶）。回归见 playback-engines HP/HP2 组。报告汇总节的数据源
  钉死为事件账本保留窗全集（`ledgerSnapshot().events`，3.2.1 F3 线）：
  hold.* 只落账本，播放日志是另一套存储且落盘名带 `web.` 前缀、
  聚合器精确匹配不上——改喂日志即恒 0（3.2.0 真机实锤）；回归见
  `fix321-f3-hold-summary.contract.test.ts`。
- 代理恢复落点（最终版 B3 线，裁定条目 4）：useProxyPlaybackRecovery
  的 pending 快照在存续期间跟随用户 seek——元素 seeking 事件把
  快照 time 更新为最新 seek 目标，restore 落点以用户最新位置为
  准、快照只作无 seek 时兜底（trace `proxy.snapshot_seek`）；暂停
  意愿仍由 restore 读活状态（Hark P0 口径不变）。HLS 恢复
  （hlsRecovery）执行时读活时钟、无位置快照，不在此列。回归见
  playback-engines FIN-B3 组。
- seek：preview → commit → `seeking` → `seeked`/`playing`；拖动取消、
  页面失活或换源不会提交旧目标。
- 控件闲置隐藏（`src/features/feed/fsIdle.ts`）：桌面 2.8s（键盘聚焦控件时不隐藏）；
  移动全屏呈现（fs/fsUi）按设置 `fsIdleSecs`（`hghubx_app_v1` 内，0/3/5/10 秒）：
  2026-11-18 用户重新裁定解硬，默认 3 秒（与官方一致，此前写死 0 作废）、
  仅播放中生效——暂停时清计时强制可见、触发瞬间再查暂停态，暂停永不被
  自动隐藏；自动隐藏只是兜底，单击随时可即时收起/呼出。移动端单击/双击判定
  （2026-11-18 用户改派定版，判定结构与上游 v2.2.0 `lastTapRef` 同位）：
  单击视频区只切换控件显隐（普通态 `clean`、全屏呈现态 `idle`），但延迟
  250ms 判定窗口到期才执行——第一击只快照显隐并起计时、不做任何变更；
  窗口内第二击到达判双击：取消待执行显隐（显隐从未变过，天然无闪烁）、
  恢复快照兜底、改判切换暂停/播放且不碰显隐。绝不用「先翻显隐、第二击
  再翻回来」的实现（中间态真实渲染 = 闪烁）。暂停/播放双路径并存：
  双击画面 + 显性钮（底栏播放钮、中央大钮），各自单义。暂停时控件锁定
  可见：单击（延迟到期后）不隐藏、也不恢复播放。桌面不走此模型
  （hover/闲置照旧）。
- 视觉基线（蓝图 P5，2026-11-18，GPT 第八节）：播放面纯黑底（既有）；
  控制层表面 #15171B 约 90%（顶/底渐变），主字 #F5F5F5、次字
  #A1A5AD，进度填充白 / 轨道白 30%（含细线）；播放抽屉面板 #191B20、
  圆角 24pt、入场 240ms（仅作用于播放抽屉，不动全局 Sheet 主题）；
  控制层入场 140ms 淡入（`hg-chrome-in`；隐侧为卸载即时——常驻挂载
  与几何负断言冲突，属已知偏离）；触控 ≥44pt 与图标尺寸分离为既有
  纪律。切集不等待动画。
- 自动化收口（蓝图 P4，2026-11-18）：倍速全局记忆——`store.rate`
  持久化，Feed 与帖子播放器同源（两处本地 useState 回退）；续播多点
  保存——5 秒节流之外，暂停 / 切后台（visibilitychange）/ 离开页面 /
  切集（pickEp 同步刷）四点即时落盘，守卫与原卸载兜底完全一致
  （`useProgressFlush`）；线路维持自动切换 + 有限重试后明确错误
  （错误层文案 + 重试钮），手动线路入口只在设置页 LinePicker，播放面
  不设。静音恒开、片尾自动下一集且不自动播下一部剧为既有定版，未动。
- 横屏源呈现与轻提示（蓝图 P3，2026-11-18；同日真机批改版）：横屏源在
  竖屏容器内恒 `contain` 不裁切（原 portraitFit 铺满/适应切换回退，
  手动缩放仍可裁）；进横屏只有一个入口——操作行右端的全屏钮（横屏源
  时出现），自动旋转已彻底取消：P3 的偏好记忆（`hghub_land_pref`）与
  按集自动进逻辑全删（滑到横屏源被自动转横屏是骚扰，用户真机裁定）。
  `LandHint` 只剩指路：首个横屏条目出现一次（`hghub_land_hint_seen`），
  位置与全屏钮同位（底栏上方右侧），永不代为旋转。进横屏复用同一播放
  元素，不重置进度。
- 单一控制层（蓝图 P1，2026-11-18；同日真机批改版）：移动端视频条目的
  信息与操作只属于一层——顶栏（返回 / 集数定位 / 静音 / 收藏 / 搜索）+
  底部（剧名·集数与时间行 / 热度只读行（赞·藏·评，万级口径）/ 可拖
  进度条 / 操作行：上一集 | 选集 | 暂停/播放（底部中央 52px）| 下一集
  | 倍速 | 全屏（仅横屏源）），同显同隐。右栏（喜欢/收藏/评论覆层）
  已整体撤销：喜欢删除、收藏移入顶栏星钮、评论只从抽屉评论页到达，
  三数字降为只读热度指标（判断热门程度用，不做按钮）。画面中央不放
  暂停钮（观看区 + 单手够不到；8275a16 中央大钮回退），暂停双路径 =
  双击 + 底部中央钮。真实全屏的退出由顶栏返回承担（与硬件返回同序：
  先退全屏、再回上一页/浏览页）；独立退出钮、全屏底栏、独立全屏进度
  条、普通模式信息块（视频部分）至此合并回退，图文帖保留原信息块。
  控件隐藏时只留细进度条贴底（全呈现态一致）。暂停不锁显：单击在
  播放/暂停任一状态都只翻显隐，自动隐藏（fsIdle）仅播放中触发。
- 播放器即首页 + 开场默认沉浸（蓝图 P0，2026-11-18）：移动端 home 页签即
  播放面，App 不在其上显示页签栏、底部不留页签栏高度（搜索/分类/我的
  是播放器之外的浏览页：顶栏左上返回落分类页、搜索钮只开搜索页，
  浏览各页左上统一返回钮回播放器——出入口同位，2026-11-18 第9项）；
  每集首次真正起播时
  Feed 自动收起控件一次（`immersedKeyRef` 守卫，同集 seek/恢复不重复），
  默认态只有视频 + fsUi 细进度线。
- 竖屏即全屏呈现（2026-11-18 用户裁定）：移动端竖屏视频源（`fsUi`）在 Feed
  直接以全屏那套控件/底栏/细进度线呈现，不需手动点全屏、不产生进入/退出
  步骤，退出钮不出现（无进入即无退出语义）；真实 `fs` 的滚动锁定、方向
  请求、分节隐藏不变。`fsUi` 显隐与 `clean` 镜像（App 页签带随之让位），
  底栏底距随 `bottomInset` 让位不叠层。横屏源维持手动进/退全屏。
  CSS 旋转舞台（`.fs-landscape`）上
  的横拖定位/上下划切作品/长按都先经 `stageXY` 把屏幕坐标换算回舞台坐标；
  长按为固定 2x 临时加速、松手恢复原速，无换挡、无锁定（2026-11-18 真机
  裁定回 2.1.5 定版，换挡属多余复杂）
- 双边缘返回（2026-11-18 补，同日扩右缘）：左 20px 右滑与右 22px 左滑
  并存、语义一致（用户直觉方向为右缘左滑）。边缘起手优先给返回手势，
  方向判定用屏幕坐标（旋转舞台下与舞台坐标分离），向屏内滑占优锁定、
  过 64px 执行；边缘带与 scrub/pan/切条目起手区域互斥（带内起手永不
  进 scrub/pan/hold），未成手势的边缘拖动吞掉、轻点仍作单击。执行
  顺序与硬件返回同序：关面板 → 退全屏 → context 的 onBack。面板以
  Sheet 呈现时手势落在弹层，由 `DialogFrame` 自己认同一套双缘关闭。
- 竖滑语义（2026-11-18 真机纠正）：竖滑恒沿 feed 切作品（下一个/上一个
  条目），绝不在同一作品内换集；集内切换只走选集抽屉 / 上下集钮 /
  片尾自动。`swipeEp` 恒 false（见 storage-and-preferences）。
  （rotate(90deg)：舞台 dx=屏幕 dy、舞台 dy=-屏幕 dx），全屏 overlay 的 touch-action
  固定为 none，避免原生 pan-y 把视觉横滑取消掉。
- 媒体错误：hls fatal 显示 `type/details/status`，原生错误走
  `mediaErrorMessage`；手动重试走同一个 `useProxyPlaybackRecovery` 路径。

## 约束与失败行为

- HLS 每个连续故障期最多 4 次恢复。`MANIFEST_LOAD_ERROR` 与
  `MANIFEST_LOAD_TIMEOUT` 必须用 `loadSource(url)`，不能只 `startLoad`；
  其他网络错误用 `startLoad(currentTime)`；媒体错误先 `recoverMediaError()`，
  再 `startLoad(time)` 并恢复播放意图。
- 被覆盖的播放页保留 pending 错误，但不发请求；取消/销毁后计时器和 pending
  必须清空。没有这个边界，首页会同时为多张卡片恢复清单。
- 恢复排期不得被后续错误推迟（fix322/play）：同一故障期内新 fatal
  错误只更新 pending（待执行动作跟随最新错误，如分片错后清单错改
  走 loadSource），已排定的计时器保住原触发时刻。旧实现 error()
  无条件 cancelTimer 重排、attempts 只在触发时递增——错误间隔小于
  恢复延迟时恢复永不执行、4 次上限与 onFatal 永不达（饥饿型不
  收敛）；契约 `fix322-recovery.contract.test.ts`（假时钟错误洪流）。
- append 看门狗判死被门控吞掉必须留痕（fix322/play）：四道门——
  看门狗两臂意愿挂起（onGated）、接线层 onStall 的 stale_instance/
  paused_by_user/not_wanted 三道早退——统一经 traceGated 记
  `hls.append_stall_gated`（gate+state），只记账不改判死/挂起/复活
  行为。「用户可见卡死但诊断无 append_stall」不得再无声发生；
  夹具 playback-engines F14＋W5/W10/W11 钉住。
- hls.js 配置禁用 interstitials/content steering，`preferManagedMediaSource:false`；
  iOS 关闭 worker。媒体层还会移除 playlist 中可派生请求的 URI 字段。
- iOS AVFoundation 不能读 `hg://`，所以只通过 `ios_media_http` 的临时 loopback
  capability 提供 `/hls` 与 `/seg`；不支持 `/img`，也不把该端口暴露成通用代理。
- Linux WebKitGTK 没有 MediaSource 时由 GStreamer 播 HLS；`linux_http` 绑定失败时
  播放会失败而不是静默切到自定义协议。端口必须和 `src/shared/api/api.ts` 的 `LOCAL` 常量一致。
- 原生错误不会无限重试：`mediaErrorMessage` 只给用户可理解的
  network/decode/unsupported 提示；手动重试通过 proxy retry 重建媒体连接。
- 超分双管线（fix2 Batch C，2026-11-19）：呈现层由 `SrCanvas` 唯一选引擎——
  WebGPU 模型超分（Anime4K CNN S 档：Restore Soft S + Upscale x2 S，
  `webgpuSr.ts` 计算管线）或 WebGL 锐化档（`SuperResCanvas`），两者互斥
  不叠加。模型超分默认关闭（`SR_MODEL_DEFAULT_ENABLED=false`）：采纳门
  三条（帧预算/画质实测/10 分钟稳定）中画质门仅部分过（文字/边缘提升
  可辨、纹理未达同级），按用户口径不转默认，作实验路径保留；探针 v2
  （`srProbe.ts`，内置 720p/1080p 固定测试片、双纹理路径实测）照常在
  诊断中测量与报告，翻转开关后即按探针门条件式启用。引擎死亡
  （device lost/未捕获错误）走会话级闩锁永久回退锐化档，不重试不打扰。
  fix2.1 可靠性补强：死亡路径收敛为引擎内 `failFatally` 单一出口
  （lost/未捕获错误/`processFrame` 同步异常/成本停用四路同处理：
  dead 置位 + lastError + onLost 只回调一次；`ensureTextures` 纳入
  异常边界）；`create()` 失败路径销毁已建 device；`WebGpuSrCanvas`
  暂停时停止逐帧处理（保留最后一帧，seek 跳变补一帧）；探针等帧
  加 3s 超时、整场 90s 总预算，探针视频加载失败自清理元素。
  根治包长按补强（2026-11-19）：WebGL 档的帧成本记账收敛为纯记账器
  `createSrPerfTracker`（SuperResCanvas）——≥2x 域（长按 hold 或定档
  ≥2x）内隔帧绘制不变，但成本样本一律不入判档窗口，退出该域时清掉
  未满窗口与升档连击；窗口永不跨速率域混采，降/升档阶跃不可能由
  长按数据触发、也不落在松手帧前后（回归：playback-engines U3 组）。
- 诊断＝全量飞行记录仪（2026-11-19 根治包收口，用户定版）：设计目标是
  「未知问题可回溯」，不是已知问题清单。统一时间线＝`playback_log`
  （JSONL 落盘、pid 分段、2MB 轮转）＋事件账本（会话内最近 512 条）：
  播放/选线（`line.*`）/超分（`sr.*`）/源取页（`source.fetch`，按 host
  记成败·错误类别·耗时）/缓存作用域失效（`cache.scope_clear`）/导航
  （`navigation.change`）/页面与错误（`app.*`）全域入线；高频聚合量
  （缓存命中/淘汰、双账本 EWMA、熔断、取页计数）走状态快照不入流水。
  报告（`diagnosticReport.ts`）头印原则与留存范围、口径自检置顶，
  正文含状态快照节与选线近 5 轮。新增子系统必须接入统一时间线
  （事件或快照）才算完成——模块化验收项。
  汇总层逐节对账（2026-11-19 3.2.1 F3b 线）：报告各汇总节必须与原始
  记录同源同口径——流水选段经 `flowSegments.selectFlowSegment` 取最新
  含 `source.load` 的 pid 段（不绑最后一行 pid，尾段混入他 pid 行/
  轮转/导出裁剪时不塌缩成无记录）；报告与全量导出读日志前先
  `flushPlaybackLog()`（不读未落盘的过期快照）；日志无完整段时结论/
  流水/降级三处与事件账本交叉核对（`ledgerPlaybackEvidence`），账本
  有播放/卡死即按日志状态明示体系写清通道状态，不许假报无记录/未
  发生；源总览取页计数走 `fetchCounts.countFetchStates`，成功/失败/
  未发生/记录缺失四计数之和恒等于源总数。回归见
  `fix321-f3b-diagnostic-summary.contract.test.ts`。
  档位事实行（2026-11-19 3.3.0 批诊断档位线）：含播放证据（facts/
  流水/账本任一）的报告必含独立「档位：」行（`levelFacts.ts` 的
  `formatLevelFactsLine` 唯一拼装口径）——档数 N、当前档序号、最高档
  分辨率/码率三要素逐项呈现，缺失项标「未知」＋缺失来源，不许只作
  「超分：」行条件后缀静默省略。采集侧：`observeFirstRendition` 在
  同一首分片触发点附带 levels 末位（最高档）参数，内核同步登记结构
  化 `PlaybackFacts.levelFacts`（两播放面共用 attachHls；原生引擎标
  不可控来源）；纯观测补强，不改 ABR/选档与 SR 判档。回归见
  `fix330-diag-levels.contract.test.ts`。

## 验证命令

```sh
pnpm build
pnpm test:playback --scenarios seek,legacy,lifecycle,gesture,proxy,portrait-fit,ios-native,recovery,review,tv
node scripts/test-ios-native-media.mjs
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

`pnpm test:playback` 使用本地 HLS fixture，需要 FFmpeg 和 Chromium；它不能替代
iOS WKWebView、Android WebView、Linux GStreamer 的实机矩阵。`test:ios-native-media`
检查前端传输契约，不证明真机 AVFoundation 已通过。上述命令是验证入口，不代表本轮已经运行。
