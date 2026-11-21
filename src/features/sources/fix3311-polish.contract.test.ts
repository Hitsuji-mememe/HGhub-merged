/**
 * fix3311/polish 契约（Muse 2026-11-21；本批任务书即维护者对新增
 * 测试的授权，不变量 11）：
 * 运行：node src/features/sources/fix3311-polish.contract.test.ts
 *
 * 立项（审计两份：fix3311/evidence/holistic-polish-audit.md §6/§3/§7
 * 与 fix339/evidence/image-experience-audit.md §1.4/§1.5/§1.6/§2.3）：
 * (a) P1——Profile 以 key={lineEpoch} 整体重挂，切线后页签/分段/
 *     展开/滚动全重置（旧码切线后页签必回「收藏」）；修法为 UI 状
 *     态上提未 key 化外层、内容区只余取数缓存随代次丢弃。断言钉外
 *     层不再以 lineEpoch 为 key 且状态定义落在外层。
 * (b) P2——SourcePosts 详情无阅读进度条（原生 PostDetail 有）；
 *     断言钉 SourcePosts 出现 role="progressbar" 阅读进度条且滚动
 *     容器为详情滚动体（原生同款口径）。
 * (c) G1——播放错误呈现两样式：Feed 居中卡「视频暂时无法加载＋详
 *     情小字＋重试」、内嵌 Player 左上角小横幅裸串；断言钉共用组
 *     件 PlaybackErrorCard 两面各消费一次、Feed 不再内联旧卡、
 *     Player 不再内联旧横幅。
 * (d) 图片便宜件——①SourceGallery 网格 MediaCard 补传
 *     surface="source-list"（SourcePosts 已传 source-posts）；
 *     ②AlbumViewer 当前帧终局失败可点按重试＋弱提示（Img 的
 *     onFinalFail 上报＋albumRetryNonce 换 key 重走 attempt）；
 *     ③舞台窗口 ±1→±2（切片 idx-2..idx+3）；④openAlbum 封面先行
 *     开册（AlbumState partial 态：列表封面即刻 ready、detail 落
 *     地后同 seq 原位补全 images/partial 清除）。
 * (e) 查看器缩放——纯函数 albumZoom（双击锚点放大/pinch 倍率钳
 *     制/平移钳制/缩放归属判定）行为断言＋AlbumViewer 接线断言
 *     （旧码全文件无 pinch/scale 路径）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ALBUM_ZOOM_DOUBLE_TAP, ALBUM_ZOOM_IDENTITY, ALBUM_ZOOM_MAX,
  albumDoubleTapZoom, albumPanBy, albumPinchZoom, albumZoomOwnsGesture, clampAlbumPan,
} from "./albumZoom.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* ── (a) P1 Profile 切线状态保位 ── */
{
  const profile = read("../account/Profile.tsx");
  const outer = profile.slice(0, profile.indexOf("function ProfileContent"));
  assert.equal((profile.match(/key=\{lineEpoch\}/g) ?? []).length, 1, "lineEpoch 键全文件只剩一处（不再有包裹整页的 key 化容器）");
  assert.ok(/<ProfileContent[^>]*key=\{lineEpoch\}/.test(profile), "仅取数内容层保留 lineEpoch 代次键（key 只留在内容区）");
  assert.ok(outer.includes('useState<"fav" | "history">'), "页签 state 位于 ProfileContent 之外的外层组件");
  assert.ok(outer.includes("useState<ProfileLimits>({ favVideo: 12"), "展开上限 state 同样上提外层");
}

/* ── (b) P2 SourcePosts 阅读进度条 ── */
{
  const posts = read("./SourcePosts.tsx");
  assert.ok(posts.includes('role="progressbar"') && posts.includes('aria-label="阅读进度"'), "SourcePosts 详情带阅读进度条（原生 PostDetail 同口径）");
  assert.ok(posts.includes("detailScrollRef"), "进度条由详情滚动容器驱动");
}

/* ── (c) G1 播放错误呈现统一 ── */
{
  const card = read("../playback/PlaybackErrorCard.tsx");
  assert.ok(card.includes("视频暂时无法加载"), "共用错误卡主文案为 Feed 定版文案");
  const feed = read("../feed/Feed.tsx");
  assert.ok(feed.includes("<PlaybackErrorCard"), "Feed 消费共用错误卡");
  assert.ok(!feed.includes("<span>视频暂时无法加载</span>"), "Feed 不再内联旧居中卡文案");
  const player = read("../playback/Player.tsx");
  assert.ok(player.includes("<PlaybackErrorCard"), "内嵌 Player 消费共用错误卡");
  assert.ok(!player.includes('max-w-[80%] rounded bg-black/70'), "Player 不再内联旧左上小横幅");
}

/* ── (d) 图片便宜件 ── */
{
  const gallery = read("./SourceGallery.tsx");
  assert.ok(gallery.includes('surface="source-list"'), "网格 MediaCard 补传 surface=source-list（失败留痕分面）");
  assert.ok(gallery.includes('phase: "ready"; item: SourceItem; images: string[]; index: number; partial?: boolean'), "AlbumState ready 带 partial 态（封面先行开册）");
  assert.ok(gallery.includes("partial: true"), "openAlbum 以列表封面先行开册");
  const viewer = read("./AlbumViewer.tsx");
  assert.ok(viewer.includes("idx - 2") && viewer.includes("idx + 3"), "舞台窗口扩为 ±2 帧");
  assert.ok(viewer.includes("onFinalFail"), "查看器消费 Img 终局失败上报（失败帧点按重试）");
  assert.ok(viewer.includes("albumRetryNonce"), "失败重试经 nonce 换 key 重走 attempt");
  const ui = read("../../shared/ui/ui.tsx");
  assert.ok(ui.includes("onFinalFail?: () => void"), "Img 契约新增 onFinalFail 可选上报（缺省行为不变）");
}

/* ── (e) 缩放纯函数行为 ── */
{
  assert.equal(albumZoomOwnsGesture(ALBUM_ZOOM_IDENTITY), false, "未缩放时手势归既有横滑/点按");
  const z = albumDoubleTapZoom(ALBUM_ZOOM_IDENTITY, 0.25, 0.75);
  assert.ok(z && z.scale === ALBUM_ZOOM_DOUBLE_TAP && z.ax === 0.25 && z.ay === 0.75, "双击在点按锚点放大到定版倍率");
  assert.deepEqual(albumDoubleTapZoom(z!, 0.5, 0.5), ALBUM_ZOOM_IDENTITY, "缩放态双击还原恒等变换");
  const pinched = albumPinchZoom(ALBUM_ZOOM_IDENTITY, 100, 250, 0.5, 0.5);
  assert.equal(pinched.scale, 2.5, "pinch 按指距比放大");
  assert.equal(albumPinchZoom(ALBUM_ZOOM_IDENTITY, 100, 900, 0.5, 0.5).scale, ALBUM_ZOOM_MAX, "pinch 倍率钳到上限");
  assert.deepEqual(albumPinchZoom(ALBUM_ZOOM_IDENTITY, 100, 40, 0.5, 0.5), ALBUM_ZOOM_IDENTITY, "pinch 缩回 1 以下即复位恒等");
  assert.equal(albumZoomOwnsGesture(pinched), true, "缩放态手势归平移（翻页让行）");
  const panned = albumPanBy(pinched, 100, 0, 400, 800);
  assert.ok(panned.tx > 0 && panned.tx <= (0.5 * (pinched.scale - 1)) / pinched.scale + 1e-9, "平移按舞台分数叠加且不越钳制域");
  const clamped = clampAlbumPan({ scale: 2, ax: 0.5, ay: 0.5, tx: 99, ty: -99 });
  assert.ok(Math.abs(clamped.tx - 0.25) < 1e-9 && Math.abs(clamped.ty + 0.25) < 1e-9, "2x 居中锚点平移域为 ±0.25");
  assert.deepEqual(albumPanBy(ALBUM_ZOOM_IDENTITY, 50, 50, 400, 800), ALBUM_ZOOM_IDENTITY, "未缩放不许平移");
  const viewer = read("./AlbumViewer.tsx");
  assert.ok(viewer.includes("albumPinchZoom") && viewer.includes("albumDoubleTapZoom"), "AlbumViewer 接线缩放纯函数");
  assert.ok(viewer.includes('data-album-zoom'), "舞台变换落在当前帧（data-album-zoom 标记）");
}

console.log("fix3311-polish contract: all assertions passed");
