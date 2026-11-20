/**
 * fix336/ui-fixes 契约（Muse 2026-11-20；本线任务书即维护者对
 * 新增测试的授权，AGENTS 不变量 11）。
 * 运行：node src/features/category/fix336-ui-fixes.contract.test.ts
 *
 * 依据（真机/用户原话/调查定案，fix336/investigation-336.md）：
 * ①相册双标题栏＋底部导航漏出只发生在搜索宿主（用户 18:40 亲
 * 口确认「从搜索界面再打开图片」时发生），源内宿主全屏正常；
 * ②DiscoveryBar 标签墙碍读（用户亲口），WP 源 24 分类＋24 标签
 * 平铺且标签前段与分类大量同名（大小写差异型，如 XiuRen/
 * Xiuren）；③分类总览逻辑重定为用户亲定：总览只留短剧/视频/
 * 吃瓜/图片四频道行、源不外露、删「视频源」分组、图片进频道
 * 页 chips 切源；④视频频道原生空壳 chip 退场（调查任务二定
 * 案：上游确认端点 410 下线、频道恒空），默认落外部源。
 * ⑤（fix337/album-chrome 续记，本线任务书即维护者对新增断言
 * 的授权）：3.3.6 真机复报——搜索宿主打开图集，底部缩略图条
 * 被壳底栏胶囊压住下半截。定案：底栏 .ios-mobile-nav 为 z-50
 * 根层同级；查看器覆层嵌在搜索详情层（absolute z-30）的层叠
 * 上下文内，覆层自身 z-40 只在上下文内有效、提层级出不去
 * （3.3.6 只盖住了同上下文内的详情页头）；源内宿主只活在栈
 * 页（底栏不渲染）故从不暴露。修法与 fs/clean 同口径：查看
 * 器在场期间宿主持有 store 底栏让位标记、整栏不渲染。
 *
 * 覆盖：
 * (A) defaultSourceId 落点真值表（记忆优先/无记忆首源/记忆源
 *     不在候选回落首源/空候选 undefined）；
 * (B) dedupeTagOptions 真值表（规范化同名剔除：label/value 双
 *     路、trim＋不分大小写；已选标签保留；无分类不剔除）；
 * (C) surfaces 频道名单定点（channel-image 成员＝已启用图片
 *     源、channel-video 成员＝外部四源、原生×视频频道声明出
 *     局；完备性全遍历在 fix334-surfaces 契约）；
 * (D) 生产接线文本断言：两宿主相册同形态（fixed 覆盖＋
 *     immersive）、DiscoveryBar 收敛接线（去重消费/展开开关/
 *     单行横滑与展开平铺两形态）、总览四行派生与计数、图片频
 *     道分支与视频频道恒走外部源分支；
 * (E) 底栏让位接线（fix337/album-chrome）：store 持有标记＋App
 *     渲染条件含标记＋bottomInset 不掺入（被盖页布局不移位）、
 *     两宿主持有/释放成对、搜索宿主持有条件与覆层渲染条件同源；
 * (F) 单图模型画廊组装（fix337/008-detail）：assembleAlbumGallery
 *     真值表（成立三条件/点开位以 detail 图为准/无大图条目不入
 *     集）＋SourceGallery 消费与当前条目跟随接线。两线同名 (E)
 *     于集成时由本线改 (F)（fix337-integration 对账）。
 * 旧码（@17f6bca）上：defaultSourceId/dedupeTagOptions/
 * channel-image 均不存在（导入即红），总览/宿主/频道文本断言
 * 亦全红——修复回归钉的既定证伪形态。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry, sourcesForCategory } from "../sources/registry.ts";
import { defaultSourceId } from "../sources/selectedSource.ts";
import { dedupeTagOptions, normalizeDiscoveryName } from "../sources/discoveryOptions.ts";
import { routeForSurface, sourcesForSurface } from "../sources/surfaces.ts";
import { assembleAlbumGallery } from "../sources/albumGallery.ts";
import type { SourceItem } from "../sources/types.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const R1 = getBuiltinRegistry();
const ctx = { active: R1, builtin: R1 };

/* ── (A) 频道初始落点 ── */
{
  const candidates = sourcesForCategory("image", R1);
  assert.ok(candidates.length >= 3, "夹具前提：已启用图片源 ≥3");
  const [first, second, third] = candidates;
  assert.equal(defaultSourceId(candidates, {}), first.id, "无记忆 → 候选首个（首个可用源）");
  assert.equal(defaultSourceId(candidates, { [second.id]: 100 }), second.id, "有记忆 → 最近打开源");
  assert.equal(defaultSourceId(candidates, { [second.id]: 100, [third.id]: 50 }), second.id, "多条记忆 → 最近者");
  assert.equal(defaultSourceId(candidates, { [third.id]: 200, [second.id]: 100 }), third.id, "记忆按时刻比、不按候选序");
  assert.equal(defaultSourceId(candidates, { "not-a-candidate": 999 }), first.id, "记忆源不在候选（已停用/下线）→ 回落首源");
  assert.equal(defaultSourceId(candidates, { [first.id]: 0 }), first.id, "时刻 0 不算记忆 → 首源");
  assert.equal(defaultSourceId(candidates, { [second.id]: 100, [third.id]: 100 }), second.id, "同时刻并列 → 候选序在前者");
  assert.equal(defaultSourceId([], { [first.id]: 100 }), undefined, "候选为空 → undefined（调用方落诚实空态）");
}

/* ── (B) 标签与分类同名剔除 ── */
{
  const opt = (value: string, label: string) => ({ value, label });
  assert.equal(normalizeDiscoveryName("  XiuRen "), "xiuren", "规范化＝trim＋小写");
  const cats = [opt("xiuren", "XiuRen"), opt("23", "Hot Girl")];
  const tags = [opt("xiuren", "Xiuren"), opt("7", "hot girl"), opt("9", "长腿"), opt("XIUREN", "别名")];
  assert.deepEqual(dedupeTagOptions(cats, tags).map((o) => o.value), ["9"],
    "value 撞名（不分大小写）与 label 撞名都剔除、只留不同名");
  assert.deepEqual(dedupeTagOptions(cats, tags, "7").map((o) => o.value), ["7", "9"],
    "已选中的同名标签保留（防筛选悬空、点掉后不再回来）");
  assert.deepEqual(dedupeTagOptions([], tags).map((o) => o.value), tags.map((o) => o.value),
    "无分类选项 → 标签原样不剔除");
  assert.deepEqual(dedupeTagOptions(cats, []), [], "无标签 → 空");
}

/* ── (C) 频道名单派生定点 ── */
{
  assert.deepEqual(sourcesForSurface("channel-image", R1).map((d) => d.id),
    ["xiuren", "cosplaytele", "danbooru", "pixibb", "nudecosplay", "yandere", "konachan",
      /* 断言适配（fix338/realphoto-add）：真人图片新源 everia/
       * xsnvshen 启用入册、按注册表序居末（order 122/123）。 */
      "everia", "xsnvshen"],
    "图片频道名单＝已启用图片源（注册表序）");
  assert.deepEqual(sourcesForSurface("channel-video", R1).map((d) => d.id),
    ["hanime-tv", "hanime1", "iwara", "hentaihaven"],
    "视频频道名单＝已启用外部视频源（原生不在名单）");
  const native = R1.find((s) => s.id === "huangguo")!;
  assert.deepEqual(routeForSurface("channel-video", native, ctx),
    { kind: "not-applicable", declaration: "native-not-in-video-channel" },
    "原生×视频频道＝空壳退场声明出局");
  assert.deepEqual(routeForSurface("channel-drama", native, ctx), { kind: "native" },
    "原生×短剧频道不受影响（仍走原生面）");
}

/* ── (D) 生产接线 ── */
{
  /* 相册两宿主同形态：fixed 顶层覆盖＋immersive＋同一返回落点。 */
  const search = read("../search/Search.tsx");
  const imgBranchAt = search.indexOf('if (merged.kind === "image") {');
  assert.ok(imgBranchAt >= 0, "Search 图片详情分支在位");
  const imgBranch = search.slice(imgBranchAt, imgBranchAt + 2600);
  assert.ok(imgBranch.includes('className="fixed inset-0 z-40 bg-black"'), "搜索宿主以 fixed 顶层覆盖呈现相册（盖住详情页头与壳导航）");
  assert.ok(imgBranch.includes("immersive"), "搜索宿主传 immersive（安全区让位与源内宿主一致）");
  assert.ok(imgBranch.includes("onBack={closeExtDetail}"), "搜索宿主返回落点不变（closeExtDetail）");
  const gallery = read("../sources/SourceGallery.tsx");
  assert.ok(gallery.includes('className="fixed inset-0 z-40 bg-black"'), "源内宿主 fixed 覆盖形态不回归");
  assert.ok(gallery.includes("immersive"), "源内宿主 immersive 不回归");

  /* DiscoveryBar 收敛接线。 */
  const bar = read("../sources/DiscoveryBar.tsx");
  assert.ok(bar.includes("dedupeTagOptions(categoryOptions, all, disc.tag)"), "标签行消费同名剔除（分类集＋已选保留）");
  assert.ok(bar.includes("aria-expanded={expanded}"), "展开入口带 aria-expanded（展开才全量平铺）");
  assert.ok(bar.includes("flex-nowrap") && bar.includes("overflow-x-auto"), "默认形态＝单行横滑");
  assert.ok(bar.includes("flex-wrap"), "展开形态＝全量平铺（flex-wrap）");
  assert.ok(bar.includes("TAXONOMY_CHIP_LIMIT"), "Top-N 上限口径不变");

  /* 总览四行：行集单一派生＋计数＝行数＋图片行进频道页。 */
  const category = read("./Category.tsx");
  assert.ok(category.includes("const sectionCount = overviewRows.length"), "页头计数＝频道行集长度（无手算偏移）");
  assert.ok(category.includes('push({ kind: "channel", cate: "image", name: "图片" })'), "图片行进图片频道页（cate=image）");
  assert.ok(!category.includes('aria-label="视频源"'), "总览无「视频源」分组");
  assert.ok(!category.includes("imageRowSources") && !category.includes("videoRowSources"), "总览无图片/视频源行名单消费");

  /* 图片频道分支：chips 切源＋记忆落点＋blocked 诚实提示。 */
  assert.ok(category.includes('if (cate === "image")'), "ChannelPage 有图片频道分支（与 image:<id> 深链分开）");
  assert.ok(category.includes('sourceOptionsForCategory("image")'), "图片频道 chips 名单经品类派生");
  assert.ok(category.includes('ariaLabel="图片数据源切换"'), "图片频道切换器在位（与视频频道同形态）");
  assert.ok(category.includes("defaultSourceId("), "频道初始落点经记忆口径派生（图片/视频共用）");
  assert.ok(category.includes("SourceGallery def={imageChannelSource}"), "图片频道经 SourceGallery 取数");

  /* 视频频道：默认即外部源、不存在能点到的恒空入口。 */
  assert.ok(category.includes('cate === "original" || effectiveChannelSourceId !== nativeId'), "视频频道恒走外部源分支");
  assert.ok(category.includes("暂无可用视频源"), "无外部源时落诚实空态（不回落原生空壳）");
  assert.ok(!category.includes("api.originalVideos"), "原生视频取数臂已退场");
  assert.ok(!category.includes("partitionCardsByResolvedKind(rawItems"), "原生视频品类分组已退场");

  /* 深链保留（资料库回访生产者 Profile 仍在用）。 */
  assert.ok(category.includes('cate.startsWith("image:")') && category.includes('cate.startsWith("video:")'),
    "image:<id>/video:<id> 深链分支保留");
}

/* ── (E) 图集在场时底栏让位（fix337/album-chrome） ── */
{
  const store = read("../../shared/model/store.tsx");
  assert.ok(store.includes("tabBarHeld: boolean"), "store 暴露底栏让位标记（类型在册）");
  assert.ok(store.includes("setTabBarHeld"), "store 暴露底栏让位 setter");
  const app = read("../../app/App.tsx");
  assert.ok(app.includes('{!fs && !clean && !tabBarHeld && stack.length === 0 && tab !== "home" && <TabBar />}'),
    "TabBar 渲染条件含让位标记（与 fs/clean 同列：持有即整栏不渲染，其余条件逐字不变）");
  assert.ok(app.includes('const bottomInset = fs || clean || tab === "home" ? 0 : 74'),
    "bottomInset 派生不掺让位标记（被盖页布局不移位、关图集后底栏回原位）");
  const search = read("../search/Search.tsx");
  assert.ok(search.includes('extDetail.data.merged.kind === "image"'), "搜索宿主持有条件含 ready∧图片（与覆层渲染条件同源）");
  assert.ok(search.includes("setTabBarHeld(true)") && search.includes("setTabBarHeld(false)"),
    "搜索宿主持有/释放成对（effect cleanup 释放）");
  const gallery = read("../sources/SourceGallery.tsx");
  assert.ok(gallery.includes("setTabBarHeld(true)") && gallery.includes("setTabBarHeld(false)"),
    "源内宿主同一持有/释放不变量（栈页上底栏本不渲染、持有为空转无害）");
}

/* ── (F) 单图模型画廊组装（fix337/008-detail；集成时由 (E) 改名 (F)；3.3.6 真机实报
 * booru 家族 008/014/016 详情只有一张图）──
 * 家族模型定案：单帖单图——detail 恒 1 图是模型事实、非聚合丢
 * 图（生产路径实拉：图集源 detail 50–103 图、同批 booru 三源恒
 * 1）。正确形态＝查看器以已加载列表为画廊沿帖前后翻：组装只在
 * 「detail 恰 1 图 ∧ 已加载条目自带大图（largeImage）≥2 ∧ 点开
 * 条目在列」时成立，点开条目本位以 detail 图为准（权威），其余
 * 以列表自带大图；任一条件不满足回 null、宿主维持现行单册形态
 * （图集源 detail 多图永不触发、行为逐字不变）。 */
{
  const item = (id: string, largeImage?: string): SourceItem => ({
    sourceId: "danbooru", externalId: id, title: `t-${id}`, cover: `https://cdn.example.com/p${id}.jpg`,
    href: "", tags: [], ...(largeImage ? { largeImage } : {}),
  });
  const a = item("1", "https://cdn.example.com/l1.jpg");
  const b = item("2", "https://cdn.example.com/l2.jpg");
  const c = item("3", "https://cdn.example.com/l3.jpg");
  const bare = item("9");

  const asm = assembleAlbumGallery([a, b, c], b, ["https://cdn.example.com/detail-b.jpg"]);
  assert.ok(asm, "三条自带大图＋点开居中 → 组装成立");
  assert.deepEqual(asm.images, ["https://cdn.example.com/l1.jpg", "https://cdn.example.com/detail-b.jpg", "https://cdn.example.com/l3.jpg"],
    "画廊＝列表序，点开位以 detail 图为准、邻帖以自带大图");
  assert.equal(asm.index, 1, "起始 index＝点开条目在画廊中的位置");
  assert.deepEqual(asm.items.map((x) => x.externalId), ["1", "2", "3"], "画廊条目集与图片一一对应（标题/收藏随当前条目）");

  assert.equal(assembleAlbumGallery([a, b, c], b, ["x", "y"]), null, "detail 多图（图集源）→ 不组装、维持单册");
  assert.equal(assembleAlbumGallery([a, b, c], b, []), null, "detail 无图 → 不组装（宿主走既有错误态）");
  assert.equal(assembleAlbumGallery([a, b, c], bare, ["x"]), null, "点开条目不在已加载列表 → 不组装");
  assert.equal(assembleAlbumGallery([a, bare], a, ["x"]), null, "自带大图条目不足 2 → 不组装（无可翻之邻）");
  const mixed = assembleAlbumGallery([a, bare, c], c, ["https://cdn.example.com/detail-c.jpg"]);
  assert.ok(mixed, "混合列表（个别条目无大图）→ 只以自带大图条目组装");
  assert.deepEqual(mixed.items.map((x) => x.externalId), ["1", "3"], "无大图条目不入画廊（不以 preview 充大图、不降质）");
  assert.equal(mixed.index, 1, "混合组装 index 按入选条目计");

  const gallery = read("../sources/SourceGallery.tsx");
  assert.ok(gallery.includes("assembleAlbumGallery"), "SourceGallery 打开相册时消费画廊组装（单图模型以列表为画廊）");
  assert.ok(gallery.includes("album.galleryItems"), "查看态当前条目随 index 在画廊条目集内跟随（标题/收藏不钉死在点开条目）");
}

console.log("fix336-ui-fixes.contract: all assertions passed");
