# 存储与偏好

## 责任与边界

存储子系统负责浏览器 `localStorage` 的键、旧键迁移、本地资料库（收藏/点赞/关注/观看记录）、
作用域常量、内容偏好和清缓存语义；Rust 侧负责应用数据目录里的 `session.json`、`line.json`、
`proxy.json`、`security.json` 和诊断日志开关。它不负责媒体内存缓存的实现（见
[network-proxy-media.md](network-proxy-media.md)）。账号体系已于 3.3.0 拆除：前端无登录态、
无远端同步、无分桶，资料库纯本地；Rust 侧 `session.rs` 本线未动。

运行期只写 `hghubx_*`。旧键只用于升级迁移，且必须先确认新值已成功写入，才能删除旧值。

## 事实来源

- 键与迁移：[`src/shared/storage/storage.ts`](../../src/shared/storage/storage.ts) 的 `STORAGE_KEYS`（`app`、`swipeEp`、
  `theme`、`autoLine`）、`LEGACY_KEYS`、`StorageKey`、`readStorage()`。
- 内容偏好：[`src/shared/model/contentPreferences.ts`](../../src/shared/model/contentPreferences.ts) 的
  `CONTENT_PREFERENCES_KEY`、`MAX_BLOCKED_TAGS`、`MAX_TAG_LENGTH`、`normalizeTag()`、
  `normalizePreferences()`、`readPreferences()`、`tagIndex()`、`blockReason()`、`update()`、
  `useContentPreferences()`。
- 本地资料库：[`src/shared/model/localLibrary.ts`](../../src/shared/model/localLibrary.ts) 的 `LOCAL_SCOPE`、
  `LibraryData`、`pickLibraryData()`、`sanitizeLibraryData()`、`mergeLibraryData()`、
  `absorbLegacyAccounts()`、`clearAbsorbedLegacyAccounts()`、`useLocalLibrary()`（`setCollected()`、
  `addHistory()`、`clearHistory()`）；旧分桶键 `LEGACY_ACCOUNTS_KEY`（`hghubx_accounts_v1`）
  只在启动吸收时读、合并落盘验证后删。
- 应用偏好：[`src/shared/model/store.tsx`](../../src/shared/model/store.tsx) 的 `Persist`、`DEFAULTS`、
  `normalizeHistory()`、`loadPersist()`、`readThemePreference()`、`LS`、
  `STORAGE_KEYS.theme`/`autoLine`。
- 会话：已删除（fix3311/registry-cleanup，见文末同批注记）——原
  `src-tauri/src/session.rs` 的 `Session`/`SessionStore` 及其
  `bind()`/`token()`/`snapshot()`/`rebase_if_trusted()`/`persist()` 等全数退役。
- 清缓存：[`src-tauri/src/api/platform.rs`](../../src-tauri/src/api/platform.rs) 的
  `cache_clear`；[`src-tauri/src/cache.rs`](../../src-tauri/src/cache.rs) 的
  `CacheClearReport`、`clear_web_cache()`、`safe_cache_types()`。
- 迁移回归：[`scripts/test-storage-migration.mjs`](../../scripts/test-storage-migration.mjs)、
  [`tests/storage-migration.tsx`](../../tests/storage-migration.tsx)。

## 主运行时路径

| 运行期键 | 旧键 | 内容 |
| --- | --- | --- |
| `hghubx_app_v1` | `hghub_app_v1` | 本机偏好、收藏、关注、观看记录、搜索历史、音量、`muteOnStartup`、`swipeEp`、`preferHevc`、`fsIdleSecs` |
| `hghubx_swipe_ep_v2` | `hghub_swipe_ep_v2` | 上下划切集的一次性迁移标记 |
| `hghubx_theme` | `hghub_theme` | `light`/`dark`/`system` |
| `hghubx_auto_line` | `hg.autoLine` | 自动选线开关 |
| `hghubx_usage_agreement` | — | 使用协议版本与签署时间 |
| `hghubx_mobile_hold_guide_v1` | — | 移动端首次长按倍速教程已读标记 |
| `hghubx_tv_display_v1` | `hghubx.tv.display.v1` | TV 端缩放、过扫描与减少动效设置 |
| `hghubx_tv_playback_v1` | `hghubx-tv-playback-v1` | TV 端连播、倍速与编码偏好 |
| `CONTENT_PREFERENCES_KEY` | — | 屏蔽标签、暂停过滤、隐藏无标签内容 |
| `hghubx_accounts_v1` | — | 旧版按 `[origin, user.id]` 分桶的账号本地副本；3.3.0 起只在启动时被吸收进 `hghubx_app_v1`，合并落盘验证后删除，运行期无读写方 |

应用数据目录还保存 `session.json`（会话）、`line.json`（v2 线路）、`proxy.json`（代理）、
`security.json`（严格模式）和可选的 `playback-diagnostics.json`（诊断开关）；它们由 Rust
对应的 `bind()`/`set()` 管理，不经过 `localStorage`。

1. `readStorage(key)` 先读新键。新键存在时尝试删除对应旧键；删除失败只留到下次启动重试，不影响
   读取。新键不存在时读旧键，成功 `setItem` 并回读一致后才 `removeItem`；配额不足或禁止写入时
   保留旧键并返回旧值。任何异常返回 `null`，让调用方使用默认值。
2. `loadPersist()` 从 `STORAGE_KEYS.app` 读取应用状态（收藏、观看记录、搜索历史、音量、静音、
   `swipeEp`、`preferHevc`），用 `DEFAULTS` 合并并 `normalizeHistory()` 升级旧的 `number[]`
   观看记录。`swipeEp` 已按 2026-11-18 用户真机裁定恒为 false（竖滑恒切
   作品、绝不切集）：`DEFAULTS` 与 `loadPersist()` 恒 false、setter 恒写
   false，原一次性迁移（旧 false 视为未显式关闭）废止；`loadPersist()`
   仍保留对 `STORAGE_KEYS.swipeEp` 的一读，只为履行存储不变量 7 的
   旧键清理（读时复制到新键并删旧键）。
3. 主题偏好单独存 `STORAGE_KEYS.theme`（`light`/`dark`/`system`）。启动时先应用已保存主题，
   再根据 `prefers-color-scheme` 解析 `system`；解析结果不覆盖偏好本身。写主题失败只忽略，
   不阻塞界面。
4. 内容偏好存在 `CONTENT_PREFERENCES_KEY`，结构是
   `{blockedTags, paused, hideUntagged}`。`normalizeTag()` 只做 trim、压缩空白和小写化，
   不做模糊匹配；最多 200 个标签、单个 64 字符。读取失败/JSON 损坏 → 全空偏好；写入失败 →
   本次内存偏好仍生效，同时把 `storageError` 暴露给 `PreferenceStorageNotice`，重启可能回退。
5. 本地资料库（3.3.0 账号体系拆除后）：收藏/点赞/关注/观看记录只存本机，随 `store.tsx`
   的 `Persist` 写 `STORAGE_KEYS.app`，无远端同步、无登录态、无分桶。作用域判别成分
   收敛为常量 `LOCAL_SCOPE`（`local`），详情、标签门、播放和动作 key 形如
   `${scope}:${lineEpoch}:...`，代次判别只剩 `lineEpoch`。收藏即本地真值，不存在
   “状态未知”：空数组就是还没有收藏（旧 `favoritesKnown` 三态随同步一并删除）。
5b. 外部源快照侧表（fix334/L3 G4）：资料库的收藏/历史集合只存数字 id，
   外部条目经 `hashExternalId(`${sourceId}:${externalId}`)` 桥接成数字
   id（与 sources 的 mapToVideoCard/mapToPost 同串、不可逆）。回访所需
   的最小快照存 `LibraryData.extRefs`（同一 Persist 键的新可选字段，
   无新键、无迁移、继承 `LOCAL_SCOPE`）：`{sourceId, externalId, kind:
   video|post|image, title, cover, epCount?}`，key＝桥接哈希。写入只经
   `localLibrary` 的 `setExternalCollected`/`addExternalHistory`（快照与
   收藏/历史同一次落盘）；`sanitizeLibraryData` 只保留 key 与重算哈希
   相等∧形状合法∧仍被 favs/postFavs/history/localHistory 任一引用
   的行，孤儿修剪只在 sanitize/merge/persist 三处、同一判据。外部历史
   行恒 `t=0/dur=0`：外部「续播」只恢复到集（ep）、不到秒。旧数据无
   `extRefs` 读入归一为空表、其余字段逐字不变；旧版读新数据忽略该
   字段（外部 id 在旧版 Profile 落诚实加载失败，不丢原生数据）。
   快照只作呈现与回访寻址，源现状以回访落点的 surfaces 派生为准。
6. 升级吸收：旧版登录用户的资料库只在 `hghubx_accounts_v1` 分桶里，形状
   `{version:1, accounts:{[JSON.stringify([origin, userId])]: data}}`。`loadPersist()`
   经 `absorbLegacyAccounts()` 把全桶幂等合并进本机资料库（history 逐行时间戳仲裁、
   集合并集、`likeEpisodes` 按 `(video_id, ep)` 去重；旧 `dirtyHistory` 只是未上传标记、
   进度本体在 history 行内，合并 history 即保全）。合并结果先写 `hghubx_app_v1` 并
   回读验证、成功才删旧键（不变量 7）；写失败保留旧键，下次启动重吸收，本次内存
   数据已合并。屏蔽设置键与吸收无关、不被触碰。
7. `SessionStore` 把 `{origin, token, user, revision}` 写入应用数据目录的 `session.json`。
   旧版本没有 `origin`，反序列化后 `token()`/`snapshot()` 不会把它分配给当前线路，升级后必须
   重新登录。`revision` 是进程内代次，不落盘；同 token 重新登录也会推进 revision。
8. `cache_clear` 先清 `media::clear_caches()`（封面、播放列表、Key、分片内存缓存），再由
   `clear_web_cache()` 清平台 WebView 缓存。Linux 只清 `MEMORY_CACHE`、`DISK_CACHE`、
   `OFFLINE_APPLICATION_CACHE`，明确排除 cookies、localStorage、sessionStorage、IndexedDB、
   service worker 和 HSTS；其他平台没有选择性 API，只清应用内内存缓存，`webCache=false`。

## 状态转换

- 旧键 → 新键：读取旧值 → 写新键 → 回读一致 → 删除旧键；写/回读失败 → 保留旧键，继续返回旧值。
- 偏好：读取 → normalize → 内存快照 + revision；编辑 → 写 localStorage → 成功则更新快照；
  失败则仍更新快照并设置 `storageError`；storage 事件只接受本键或 `key=null`。
- 升级吸收：启动读到 `hghubx_accounts_v1` → 全桶合并 → 写 `hghubx_app_v1` → 回读一致 →
  删旧键；写/回读失败 → 保留旧键，下次启动重吸收（幂等，不产生重复）。
- 清历史：确认 → 增加 `clearVersion`（清空前渲染出的 `addHistory` 闭包作废）→
  本地写空数组；无远端删除。
- 清缓存：媒体内存缓存 → 平台缓存报告；不改资料库、收藏、历史、会话、线路、代理或主题。

## 约束与失败行为

- 本地资料库无远端来源，不存在“同步未完成”式未知态；收藏空数组即还没有收藏。
  存储读取失败的兜底路径与迁移回归的 read/write/remove 失败场景一致：保留旧数据、
  不用默认值落盘冲掉原值。
- 迁移先写新键，再清旧键。写入失败/配额不足/隐私模式禁止存储时保留旧数据；不能用“清空后重试”
  掩盖失败。
- 不覆盖用户显式设置：默认值只在读取不到时使用；一次性迁移必须有独立标记，不能每次启动都
  把用户的 `false` 改回 `true`。
- `scope`（恒 `LOCAL_SCOPE`）与 `lineEpoch` 必须一起进入异步结果校验；旧线路代次的
  返回不能写进当前状态。账号维度已拆除，不再有跨账号串写面。
- 会话 token 绑定 origin 和 revision。`token()`/`user()`/`snapshot()` 按 origin 精确匹配；
  唯一跨 origin 通道是 `rebase_if_trusted()`——仅当旧新两端都是固定线路或本进程发布页确认的
  可信镜像时改写 origin（revision 递增并落盘），否则切线路仍 `SessionStore.clear()`。
  旧 `session.json` 没有 origin 时不得猜归属，也不参与 rebase。
- 清缓存不能调用 `clear_all_browsing_data`；它会连 cookies/localStorage 一起删，导致登录和
  偏好丢失。非 Linux 平台宁可只清内存缓存，也不做全量清理。
- 本地写入失败要可见（偏好提示），不能静默显示“已保存”。
- 日志和错误提示不输出 token、收藏内容或完整存储值。

## 验证命令

```sh
node scripts/test-storage-migration.mjs
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

`test-storage-migration` 覆盖旧键、写/删失败、损坏 JSON、一次性 swipe 迁移与 3.3.0
账号分桶吸收（两桶合并逐项对账、写失败保留旧键、屏蔽键不动、重启幂等）。
这些是本地 fixture，不证明真实上游接口返回结构；真实接口变化需另加 fixture。

---

**fix3311/registry-cleanup（2026-11-21）会话本体删除**：`src-tauri/src/session.rs`
（`Session`/`SessionStore`）、`session.json` 落盘与启动恢复、`Api.session` 热路径、
`app_boot` 的 `user`/`logged_in` 状态面（键保留、恒 null/false，不变量 8 形状不变）、
诊断 `session_persist` 字段，已整体删除；同批删 `api/account.rs`、`api/interact.rs`
共 12 个 Tauri 命令。依据：账号体系 3.3.0 已拆除、用户恒游客——12 命令在 TS 侧零
调用点、会话唯一写入口（登录/注册的 `set_if_revision`）随之不可达，`bind()` 恢复是
唯一残余填充路径且其文件只由已不可达的 persist 写入；游客请求链恒不带凭据，新树
`Api::get/post` 恒以 None 调 `edge`，与旧树会话恒空时线上行为逐字一致。旧树
`session::` 14 个单元测试（含落盘/恢复实证）在删前实跑全过、记录在案；新树以全套
门禁同绿＋残留 grep 零为验收。存量设备上若有 3.3.0 前遗留的 `session.json`，新版
不再读取、不再写入，文件原地失效（不主动删除）。上文各节对会话的描述为删除前史。
