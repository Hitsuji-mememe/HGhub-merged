/**
 * fix334 结构批 L3 契约：G4 外部源收藏/历史接线（extRefs 快照侧表）。
 * 运行：node src/features/sources/fix334-library.contract.test.ts
 *
 * 背景（设计 ~/workspace/hghub/fix334/design-g3g4-surfaces.md §4）：
 * 外部条目进资料库只存 hashExternalId 桥接哈希（不可逆），Profile 靠
 * 原生 api 回查外部条目必失败——收藏/历史「存得进、回不来」。本线在
 * 同一 Persist 键内加 extRefs 快照侧表（新可选字段、无新键、无迁移、
 * 继承 LOCAL_SCOPE），写入面（SourceBrowse/SourcePosts/SourceGallery/
 * Search）与读取面（Profile）同批接通。本契约守：
 * ①桥接哈希口径（组合串 `${sourceId}:${externalId}`、跨源不撞）；
 * ②sanitize 只保留 key 与重算哈希相等∧形状合法∧仍被引用（收藏/
 * 历史集合）的行——孤儿修剪只在此一处与合并一处发生；
 * ③升级兼容：旧格式（无 extRefs）读入零变化、不报错；
 * ④写入纯函数形态：收藏按 kind 落 favs/postFavs 并同写快照、取消
 * 收藏快照随孤儿修剪消失；历史行 t=0/dur=0、集数＝写入时 ordinal
 * （外部「续播」只恢复到集、不到秒，见 storage 子系统页）；
 * ⑤surfaces library 派生转正（外部已启用源＝browse/ProfileLibrary，
 * 替代 L1 的 g4-pending 在途声明）；
 * ⑥逐面接线文本断言（四写入面＋Profile 快照出卡＋store 暴露）。
 *
 * 诚实边界：本契约证明侧表口径与接线在场，不证明源站活着（F7 自检
 * 的事），也不证明真机观感（用户真机验收的事）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hashExternalId, type SourceItem } from "./types.ts";
import { getBuiltinRegistry } from "./registry.ts";
import { routeForSurface, sourcesForSurface, type SurfaceContext } from "./surfaces.ts";

const lib = await import("../../shared/model/localLibrary.ts");
const srcText = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const videoItem: SourceItem = {
  sourceId: "hanime-tv", externalId: "fixture-video-001",
  title: "夹具视频", cover: "https://img.example/cover-v.jpg",
  href: "https://hanime.tv/watch/fixture-video-001", tags: [],
};
const postItem: SourceItem = {
  sourceId: "51chigua", externalId: "fixture-post-001",
  title: "夹具帖子", cover: "https://img.example/cover-p.jpg",
  href: "https://51cg1.com/post/fixture-post-001", tags: [],
};
const imageItem: SourceItem = {
  sourceId: "xiuren", externalId: "fixture-album-001",
  title: "夹具图集", cover: "https://img.example/cover-i.jpg",
  href: "https://xiuren.biz/album/fixture-album-001", tags: [],
};
const videoHash = hashExternalId("hanime-tv:fixture-video-001");
const postHash = hashExternalId("51chigua:fixture-post-001");
const imageHash = hashExternalId("xiuren:fixture-album-001");
const videoRef = {
  sourceId: "hanime-tv", externalId: "fixture-video-001", kind: "video" as const,
  title: "夹具视频", cover: "https://img.example/cover-v.jpg", epCount: 12,
};

/* ══ 0. 桥接哈希口径 ══ */
assert.equal(typeof lib.externalHashId, "function", "L3 须在 localLibrary 暴露 externalHashId（封装内算哈希，设计 §4.3）");
assert.equal(lib.externalHashId(videoItem), videoHash, "externalHashId＝hashExternalId(`${sourceId}:${externalId}`)");
assert.notEqual(
  lib.externalHashId({ ...videoItem, sourceId: "iwara" }), videoHash,
  "跨源同 externalId 不撞（组合串含 sourceId）",
);

/* ══ 1. 升级兼容：旧格式（无 extRefs）读入零变化 ══ */
{
  const legacy = {
    likes: [3], favs: [7], follows: [], history: [{ id: 7, ep: 2, t: 30, dur: 90, at: 1000 }],
    postLikes: [], postFavs: [9], localHistory: [7],
  };
  const s = lib.sanitizeLibraryData(legacy);
  assert.deepEqual(s.extRefs, {}, "旧数据无 extRefs → 归一为空侧表");
  assert.deepEqual(s.favs, [7], "旧收藏不丢");
  assert.deepEqual(s.postFavs, [9], "旧帖子收藏不丢");
  assert.deepEqual(s.history, legacy.history, "旧历史行逐字不变");
  const picked = lib.pickLibraryData(s);
  assert.deepEqual(picked.extRefs, {}, "pick 带出空侧表（旧版读新数据忽略该字段即可）");
}

/* ══ 2. sanitize：哈希不符/形状非法/孤儿三类行全丢，合法行留 ══ */
{
  const orphanItem = { ...videoItem, externalId: "fixture-orphan-001" };
  const orphanHash = hashExternalId("hanime-tv:fixture-orphan-001");
  const dirty = {
    likes: [], favs: [videoHash], follows: [], history: [], postFavs: [],
    extRefs: {
      [videoHash]: videoRef,
      /* key 与内容重算哈希不符（串源/损坏）→ 丢 */
      [videoHash + 1]: { ...videoRef, externalId: "fixture-video-002" },
      /* key 自洽但无任何收藏/历史集合引用（孤儿）→ 修剪 */
      [orphanHash]: { ...videoRef, externalId: "fixture-orphan-001" },
      /* 形状非法（kind 越界）→ 丢；借 postHash 槽位（在 postFavs 引用内） */
    },
  };
  const withBadKind = {
    ...dirty, postFavs: [postHash],
    extRefs: { ...dirty.extRefs, [postHash]: { ...videoRef, sourceId: "51chigua", externalId: "fixture-post-001", kind: "bogus" } },
  };
  const s = lib.sanitizeLibraryData(withBadKind as never);
  assert.deepEqual(Object.keys(s.extRefs ?? {}), [String(videoHash)], "sanitize 后只剩 key 自洽∧合法∧被引用的行");
  assert.deepEqual(s.extRefs?.[videoHash], videoRef, "合法快照逐字保留");
}

/* ══ 3. merge：侧表按 key 并集、target 胜、合并后仍修剪 ══ */
{
  const target = {
    likes: [], favs: [videoHash], follows: [], history: [], postFavs: [],
    extRefs: { [videoHash]: { ...videoRef, title: "新标题" } },
  };
  const previous = {
    likes: [], favs: [], follows: [], history: [], postFavs: [postHash],
    extRefs: {
      [videoHash]: videoRef,
      [postHash]: { sourceId: "51chigua", externalId: "fixture-post-001", kind: "post", title: "夹具帖子", cover: "https://img.example/cover-p.jpg" },
    },
  };
  const merged = lib.mergeLibraryData(target as never, previous as never);
  assert.equal(merged.extRefs?.[videoHash]?.title, "新标题", "同 key 冲突 target 胜");
  assert.equal(merged.extRefs?.[postHash]?.kind, "post", "previous 独有行并入");
  assert.deepEqual(merged.postFavs, [postHash], "集合并集不变");
}

/* ══ 4. 收藏写入纯函数：落对集合＋同写快照＋取消即修剪 ══ */
assert.equal(typeof lib.applyExternalCollected, "function", "L3 须暴露 applyExternalCollected 纯函数（hook 薄封装其上）");
{
  const empty = lib.sanitizeLibraryData(undefined);
  const favVideo = lib.applyExternalCollected(empty, "video", videoItem, true, 12);
  assert.ok(favVideo.favs.includes(videoHash), "video 收藏落 favs（哈希 id）");
  assert.deepEqual(favVideo.extRefs[videoHash], videoRef, "收藏同写快照（kind/title/cover/epCount）");
  /* 落盘往返：pick→sanitize 后快照仍在（Profile 读回的形态）。 */
  const roundTrip = lib.sanitizeLibraryData(lib.pickLibraryData(favVideo));
  assert.deepEqual(roundTrip.extRefs[videoHash], videoRef, "落盘往返快照不丢");
  const unfav = lib.applyExternalCollected(favVideo, "video", videoItem, false);
  assert.ok(!unfav.favs.includes(videoHash), "取消收藏出 favs");
  assert.deepEqual(unfav.extRefs, {}, "取消收藏且无历史引用 → 快照孤儿修剪");

  const favPost = lib.applyExternalCollected(empty, "post", postItem, true);
  assert.ok(favPost.postFavs.includes(postHash), "post 收藏落 postFavs");
  assert.equal(favPost.extRefs[postHash]?.kind, "post");
  const favImage = lib.applyExternalCollected(empty, "image", imageItem, true);
  assert.ok(favImage.postFavs.includes(imageHash), "image 收藏落 postFavs（与帖子同格，kind 区分）");
  assert.equal(favImage.extRefs[imageHash]?.kind, "image");
}

/* ══ 5. 历史写入纯函数：t=0/dur=0、集数＝ordinal、快照同写 ══ */
assert.equal(typeof lib.applyExternalHistory, "function", "L3 须暴露 applyExternalHistory 纯函数");
{
  const empty = lib.sanitizeLibraryData(undefined);
  const h1 = lib.applyExternalHistory(empty, videoItem, 2, 12);
  const row = h1.history.find((r) => r.id === videoHash);
  assert.ok(row, "历史行以哈希 id 落 history");
  assert.equal(row.ep, 2, "历史行集数＝写入时 ordinal");
  assert.equal(row.t, 0, "外部历史行 t=0（续播只到集不到秒）");
  assert.equal(row.dur, 0, "外部历史行 dur=0");
  assert.ok(h1.localHistory.includes(videoHash), "localHistory 同步标记");
  assert.equal(h1.extRefs[videoHash]?.kind, "video", "历史写入同写快照");
  const h2 = lib.applyExternalHistory(h1, videoItem, 3);
  assert.equal(h2.history.find((r) => r.id === videoHash)?.ep, 3, "换集再记一行新集数");
  assert.equal(h2.history.filter((r) => r.id === videoHash).length, 1, "同 id 历史只一行");
  /* 先收藏后历史：快照仍是一行、两边引用都在。 */
  const both = lib.applyExternalHistory(lib.applyExternalCollected(empty, "video", videoItem, true, 12), videoItem, 1);
  assert.ok(both.favs.includes(videoHash) && both.history.some((r) => r.id === videoHash), "收藏∩历史同 id 共存");
  const unfavKeepHistory = lib.applyExternalCollected(both, "video", videoItem, false);
  assert.ok(unfavKeepHistory.extRefs[videoHash], "取消收藏但历史仍引用 → 快照保留");
  /* 集序位 0＝未知（episodeOrdinal 口径：externalId 不在 choices
   * 内回 0、不冒充第一集）不得整行静默吞：按未提供集数处理——
   * 历史行与快照照常写入，无原行回 1、有原行保留原集数（与原生
   * 共用的 historyRowState 口径）。此为 fix334 清扫已坏-1 的放大
   * 器（§4 记账 2），断言由清扫修复线任务书授权。 */
  const unknownEp = lib.applyExternalHistory(empty, videoItem, 0, 12);
  const unknownRow = unknownEp.history.find((r) => r.id === videoHash);
  assert.ok(unknownRow, "ordinal=0（未知）时历史行照常写入、不静默吞");
  assert.equal(unknownRow.ep, 1, "无原行时集数回 1（historyRowState 既有口径）");
  assert.equal(unknownEp.extRefs[videoHash]?.kind, "video", "ordinal=0 时快照同写");
  const keepEp = lib.applyExternalHistory(h2, videoItem, 0);
  assert.equal(keepEp.history.find((r) => r.id === videoHash)?.ep, 3, "有原行时 ordinal=0 保留原集数、不回落不吞行");
}

/* ══ 6. surfaces library 派生转正（替代 g4-pending 在途声明） ══ */
{
  const R1 = getBuiltinRegistry();
  const ctx: SurfaceContext = { active: R1, builtin: R1 };
  const byId = (id: string) => R1.find((d) => d.id === id)!;
  assert.deepEqual(routeForSurface("library", byId("hanime-tv"), ctx),
    { kind: "browse", component: "ProfileLibrary" }, "002×M17 G4 已接通（extRefs 回访）");
  assert.deepEqual(routeForSurface("library", byId("huangguo"), ctx), { kind: "native" }, "001×M17 原生不变");
  assert.deepEqual(routeForSurface("library", byId("gelbooru"), ctx),
    { kind: "not-applicable", declaration: "not-enabled" }, "未启用源×M17 仍显式不适用");
  const members = sourcesForSurface("library", R1).map((d) => d.id);
  assert.ok(members.includes("hanime-tv") && members.includes("51chigua") && members.includes("xiuren"),
    "M17 成员含已启用外部源（帖/视频/图集）");
  /* 适配（fix335/g-sources）：yandere/konachan 已启用进成员；未启用例改挂 gelbooru/pixiv。 */
  assert.ok(members.includes("yandere") && members.includes("konachan"), "M17 成员含新启用图片源（fix335/g-sources）");
  assert.ok(!members.includes("gelbooru") && !members.includes("pixiv"), "M17 成员不含未启用源");
}

/* ══ 7. 逐面接线文本断言 ══ */
{
  const browse = srcText("./SourceBrowse.tsx");
  assert.ok(browse.includes("setExternalCollected"), "SourceBrowse 详情头收藏钮接 setExternalCollected");
  assert.ok(browse.includes("addExternalHistory"), "SourceBrowse 播放写外部历史");
  assert.ok(browse.includes("onPlaying"), "SourceBrowse 历史写入挂 Player onPlaying 首帧");
  assert.ok(browse.includes("openExternalId"), "SourceBrowse 消费回访 openExternalId");
  const posts = srcText("./SourcePosts.tsx");
  assert.ok(posts.includes("setExternalCollected"), "SourcePosts 详情头收藏钮接 setExternalCollected");
  assert.ok(posts.includes("openExternalId"), "SourcePosts 消费回访 openExternalId");
  const gallery = srcText("./SourceGallery.tsx");
  assert.ok(gallery.includes("setExternalCollected"), "SourceGallery 收藏钮接 setExternalCollected");
  assert.ok(gallery.includes("openExternalId"), "SourceGallery 消费回访 openExternalId");
  const search = srcText("../search/Search.tsx");
  assert.ok(search.includes("setExternalCollected"), "Search 外部详情收藏钮接 setExternalCollected");
  assert.ok(search.includes("addExternalHistory"), "Search 外部详情播放写外部历史");
  const profile = srcText("../account/Profile.tsx");
  assert.ok(profile.includes("extRefs"), "Profile 读 extRefs 快照出卡");
  assert.ok(profile.includes("routeForSurface"), "Profile 回访路由经 surfaces 派生消费");
  assert.ok(profile.includes("openExternalId"), "Profile 点开外部卡带 openExternalId 直达");
  /* 续播到集回访链（fix334 清扫已坏-2：此前 ep 只记录与显示、
   * 回访无路径消费，点开恒回第一集而文档已按已交付宣称——本段
   * 逐环钉透传/消费形，断言由清扫修复线任务书授权）：历史行 ep
   * 经 Profile→Page→App→ChannelPage 透传 SourceBrowse，openItem
   * 按 ordinal 取回目标集起播（设计 §4.4 机制）。 */
  assert.ok(profile.includes("openExternal(ref, progress?.ep)"), "Profile 历史点开外部视频带记录集数");
  assert.ok(profile.includes("openExternalEp: startEp"), "Profile push 频道页带 openExternalEp");
  const app = srcText("../../app/App.tsx");
  assert.ok(app.includes("openExternalEp={page.openExternalEp}"), "App 装配透传 openExternalEp 到频道页");
  const category = srcText("../category/Category.tsx");
  assert.ok(category.includes("openExternalEp={openExternalEp}"), "ChannelPage 透传 openExternalEp 到 SourceBrowse");
  assert.ok(browse.includes("openExternalEp?: number"), "SourceBrowse 声明 openExternalEp 入参");
  assert.ok(browse.includes("openItem(target, openExternalEp)"), "SourceBrowse 回访消费 openExternalEp 起播");
  assert.ok(browse.includes("[wantEp - 1]") && browse.includes("adapter.resolve(target.externalId)"), "SourceBrowse 按 ordinal 取回目标集 resolve");
  const store = srcText("../../shared/model/store.tsx");
  assert.ok(store.includes("setExternalCollected") && store.includes("addExternalHistory") && store.includes("extRefs"),
    "store 暴露 extRefs＋两封装");
  const library = srcText("../../shared/model/localLibrary.ts");
  assert.ok(library.includes("extRefs"), "localLibrary 落 extRefs 侧表");
}

console.log("fix334-library contract OK");
