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
- 内嵌播放器：[`src/features/playback/Player.tsx`](../../src/features/playback/Player.tsx)
  的 `Player`，以及 `PlayerControls.tsx`、`PlaybackLock.tsx`、`PlaybackProgress.tsx`。
- 恢复与时钟：[`hlsRecovery.ts`](../../src/features/playback/hlsRecovery.ts) 的
  `createHlsRecovery`；[`playbackClock.ts`](../../src/features/playback/playbackClock.ts)
  的 `createPlaybackClock`；[`usePlaybackActivity.ts`](../../src/features/playback/usePlaybackActivity.ts)、
  [`useProxyPlaybackRecovery.ts`](../../src/features/playback/useProxyPlaybackRecovery.ts)。
- 输入与传输：[`useSeekInput.ts`](../../src/features/playback/useSeekInput.ts)、
  [`useInlinePlayerFullscreen.tsx`](../../src/features/playback/useInlinePlayerFullscreen.tsx)、
  [`mediaTransport.ts`](../../src/features/playback/mediaTransport.ts)、
  [`mediaErrors.ts`](../../src/features/playback/mediaErrors.ts)。
- 后端传输：[`src-tauri/src/ios_media_http.rs`](../../src-tauri/src/ios_media_http.rs)、
  [`src-tauri/src/linux_http.rs`](../../src-tauri/src/linux_http.rs)、
  [`src-tauri/src/media/mod.rs`](../../src-tauri/src/media/mod.rs)、
  [`src-tauri/src/media/response.rs`](../../src-tauri/src/media/response.rs)、
  [`src-tauri/src/media/hls.rs`](../../src-tauri/src/media/hls.rs)、
  [`src-tauri/src/media/segment.rs`](../../src-tauri/src/media/segment.rs)。

## 主运行时路径

1. Feed 通过 `api.play(id, ep)` 取得 `streams.main` 或旧字段 `video_url`；
   `preferHevc` 且存在 `streams.hevc` 时优先 HEVC。播放器拿到的是上游 m3u8，
   通过 `playbackSource` 转成 `${LOCAL}/hls?u=...`；已经是 `/hls`、`/seg` 的本地地址
   不会被重复包裹。
2. `VideoSurface` 在 `Hls.isSupported()` 且不是直通 `/seg` 时创建 hls.js；
   否则进入原生 `<video>`。iOS 原生传输调用 `media_http_origin`，把能力前缀拼到
   `127.0.0.1` 的 `/hls`/`/seg` 路由；Linux 的 `LOCAL` 固定为
   `http://127.0.0.1:17650`，由 GStreamer 直接取 HLS。
3. hls.js 使用 `autoStartLoad: false`，在 `MANIFEST_PARSED` 后按
   `startPosition`/`resume` 调 `startLoad`。`FRAG_BUFFERED` 清空恢复计数和错误；
   `ERROR` 只把 fatal network/media 交给 `createHlsRecovery`。
4. `usePlaybackActivity` 在页面失活时暂停并 `stopLoad()`，在重新激活时按
   `wanted` 恢复；`play()` 的 Promise 返回后会再次检查页面是否仍激活。
5. seek 有两种入口：桌面 `useSeekInput`/`PlayerControls`，移动端
   `useSeekInput`/进度条手势。指针移动只预览，松手提交一次；
   `VideoSurface.seek` 把目标夹到 `duration - 0.15`（避免 iOS 片尾卡死），
   通知 hls `startLoad(target)`，写入 `currentTime`，原本在播放才续播。
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
  “之前自动播放过”强行继续。
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
- 单一控制层（蓝图 P1，2026-11-18）：移动端视频条目的信息与操作只属于
  一层——顶栏（返回 / 集数定位 / 静音 / 搜索）+ 底部（剧名·集数与时间
  行 / 可拖进度条 / 操作行：上一集 | 选集 | 暂停/播放（底部中央 52px）
  | 下一集 | 内容 | 倍速指示），同显同隐。画面中央不放暂停钮（观看区 +
  单手够不到；8275a16 中央大钮回退），暂停双路径 = 双击 + 底部中央钮。
  真实全屏的退出由顶栏返回承担（与硬件返回同序：先退全屏、再回上一
  页/浏览页）；独立退出钮、全屏底栏、独立全屏进度条、普通模式信息块
  （视频部分）至此合并回退，图文帖保留原信息块。控件隐藏时只留细进度
  条贴底（全呈现态一致）。
- 播放器即首页 + 开场默认沉浸（蓝图 P0，2026-11-18）：移动端 home 页签即
  播放面，App 不在其上显示页签栏、底部不留页签栏高度（搜索/分类/我的
  是播放器之外的浏览页，经控制层返回/搜索到达）；每集首次真正起播时
  Feed 自动收起控件一次（`immersedKeyRef` 守卫，同集 seek/恢复不重复），
  默认态只有视频 + fsUi 细进度线。
- 竖屏即全屏呈现（2026-11-18 用户裁定）：移动端竖屏视频源（`fsUi`）在 Feed
  直接以全屏那套控件/底栏/细进度线呈现，不需手动点全屏、不产生进入/退出
  步骤，退出钮不出现（无进入即无退出语义）；真实 `fs` 的滚动锁定、方向
  请求、分节隐藏不变。`fsUi` 显隐与 `clean` 镜像（App 页签带随之让位），
  底栏底距随 `bottomInset` 让位不叠层。横屏源维持手动进/退全屏。
  CSS 旋转舞台（`.fs-landscape`）上
  的横拖定位/上下划切集/长按都先经 `stageXY` 把屏幕坐标换算回舞台坐标；
  长按为固定 2x 临时加速、松手恢复原速，无换挡、无锁定（2026-11-18 真机
  裁定回 2.1.5 定版，换挡属多余复杂）
- 左边缘返回（2026-11-18 补）：左 20px 起手优先给返回手势，方向判定用屏幕
  坐标（旋转舞台下与舞台坐标分离），右滑占优锁定、过 64px 执行；边缘起手
  不许 scrub/pan/hold 抢占，未成手势的拖动吞掉、轻点仍作单击。执行顺序与
  硬件返回同序：关面板 → 退全屏 → context 的 onBack。面板以 Sheet 呈现时
  手势落在弹层，由 `DialogFrame` 自己认同一套边缘右滑关闭。
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
- hls.js 配置禁用 interstitials/content steering，`preferManagedMediaSource:false`；
  iOS 关闭 worker。媒体层还会移除 playlist 中可派生请求的 URI 字段。
- iOS AVFoundation 不能读 `hg://`，所以只通过 `ios_media_http` 的临时 loopback
  capability 提供 `/hls` 与 `/seg`；不支持 `/img`，也不把该端口暴露成通用代理。
- Linux WebKitGTK 没有 MediaSource 时由 GStreamer 播 HLS；`linux_http` 绑定失败时
  播放会失败而不是静默切到自定义协议。端口必须和 `src/shared/api/api.ts` 的 `LOCAL` 常量一致。
- 原生错误不会无限重试：`mediaErrorMessage` 只给用户可理解的
  network/decode/unsupported 提示；手动重试通过 proxy retry 重建媒体连接。

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
