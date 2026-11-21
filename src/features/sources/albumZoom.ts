/**
 * 图集查看器缩放纯函数（Muse 2026-11-21 fix3311/polish，图片审计
 * §2.3 真缺陷「查看器无缩放」）：把 AlbumViewer 的双指/双击缩放判
 * 定从组件里抽成纯函数，与仓库既有纯函数＋契约口径一致
 * （gestureChain 先例）——组件只做 DOM 胶水（监听/样式），判定全
 * 在此：双指距离比→目标倍率、双击点→锚点倍率、单指平移钳制。
 *
 * 坐标口径：锚点/平移一律用「舞台分数坐标」（相对舞台宽高的
 * 0..1 分数），与舞台实际像素尺寸无关；渲染变换由组件按
 * transform: translate(tx,ty) scale(s) 且 transform-origin 取锚点
 * 分数组合，锚点在缩放前后保持同位（双击放大点/双指中点不漂移）。
 */

/** 舞台变换状态：scale=1 即未缩放（fit 原形态）。 */
export type AlbumZoom = { scale: number; ax: number; ay: number; tx: number; ty: number };

export const ALBUM_ZOOM_IDENTITY: AlbumZoom = { scale: 1, ax: 0.5, ay: 0.5, tx: 0, ty: 0 };
/** 双击放大目标倍率（与系统相册同量级：双击进 2.5x、再击还原）。 */
export const ALBUM_ZOOM_DOUBLE_TAP = 2.5;
/** 双指缩放上限：防无限放大把单帧解码成本与手势数值推爆。 */
export const ALBUM_ZOOM_MAX = 4;
/** 双击判定：两次点按间隔与位移（舞台像素）上限。 */
export const ALBUM_DOUBLE_TAP_MS = 300;
export const ALBUM_DOUBLE_TAP_PX = 32;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * 平移钳制：缩放后的图按 transform-origin=锚点 渲染，tx/ty 是舞台
 * 分数平移。钳制域＝内容不许被拖出舞台：锚点侧可移 (1-ax)*(s-1)/s、
 * 对侧 ax*(s-1)/s（分数口径），即锚点越靠边、该侧余量越小。scale=1
 * 时恒归零（未缩放不许平移）。
 */
export function clampAlbumPan(z: AlbumZoom): AlbumZoom {
  if (z.scale <= 1) return { ...z, tx: 0, ty: 0 };
  const s = z.scale;
  return {
    ...z,
    tx: clamp(z.tx, -((1 - z.ax) * (s - 1)) / s, (z.ax * (s - 1)) / s),
    ty: clamp(z.ty, -((1 - z.ay) * (s - 1)) / s, (z.ay * (s - 1)) / s),
  };
}

/** 双击判定结果：命中返回目标变换，未命中返回 null（调用方走既有三分区/横滑口径）。 */
export function albumDoubleTapZoom(z: AlbumZoom, fx: number, fy: number): AlbumZoom | null {
  if (z.scale > 1) return ALBUM_ZOOM_IDENTITY;
  return clampAlbumPan({ scale: ALBUM_ZOOM_DOUBLE_TAP, ax: clamp(fx, 0, 1), ay: clamp(fy, 0, 1), tx: 0, ty: 0 });
}

/**
 * 双指缩放：以手势起始变换为基线、按当前/起始指距比算目标倍率，
 * 锚点取起始双指中点（舞台分数）。倍率夹 [1, MAX]；回到 1 即恒等
 * 变换（复位、翻页手势随之恢复）。
 */
export function albumPinchZoom(base: AlbumZoom, startDist: number, dist: number, midFx: number, midFy: number): AlbumZoom {
  if (startDist <= 0 || dist <= 0) return base;
  const scale = clamp(base.scale * (dist / startDist), 1, ALBUM_ZOOM_MAX);
  if (scale <= 1) return ALBUM_ZOOM_IDENTITY;
  return clampAlbumPan({ scale, ax: clamp(midFx, 0, 1), ay: clamp(midFy, 0, 1), tx: base.tx, ty: base.ty });
}

/** 缩放态单指平移：dx/dy 为舞台像素位移，换算分数后叠加并钳制。 */
export function albumPanBy(z: AlbumZoom, dxPx: number, dyPx: number, stageW: number, stageH: number): AlbumZoom {
  if (z.scale <= 1 || stageW <= 0 || stageH <= 0) return z;
  return clampAlbumPan({ ...z, tx: z.tx + dxPx / stageW, ty: z.ty + dyPx / stageH });
}

/**
 * 手势归属（缩放态互斥）：scale>1 时单指拖动归平移、横滑翻页与点
 * 按三分区整体让行（组件据此不 go/不切 chrome）；scale=1 时归既
 * 有横滑/点按口径。双指（touches≥2）恒归 pinch，与边缘返回链的
 * 单指判定不冲突。
 */
export function albumZoomOwnsGesture(z: AlbumZoom): boolean {
  return z.scale > 1;
}
