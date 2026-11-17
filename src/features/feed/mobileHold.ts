export const HOLD_DELAY_MS = 380;
export const HOLD_LOCK_DISTANCE = 64;
export type HoldZone = "fast" | "slow" | "menu";
export type HoldMenuBounds = { left: number; top: number; size: number };

/* 长按换挡（shiftHoldSpeed/HOLD_SPEED_STEPS 等）已于 2026-11-18 删除：
   用户真机裁定换挡属多余复杂，长按回固定 2x、松手恢复（2.1.5 定版）。 */

/** 舞台坐标：CSS rotate(90deg) 时屏幕 dy=舞台 dx、屏幕 dx=-舞台 dy，其余情况原样。 */
export function stageXY(rotated: boolean, dx: number, dy: number): [number, number] {
  return rotated ? [dy, -dx] : [dx, dy];
}

const dimension = (value: number) => Number.isFinite(value) && value > 0 ? value : 0;

/** CSS-pixel square shared by hit testing and the first-visit guide. */
export function getHoldMenuBounds(width: number, height: number): HoldMenuBounds {
  const w = dimension(width), h = dimension(height);
  const short = Math.min(w, h);
  const size = Math.min(short, 112, Math.max(80, short * 0.26));
  return { left: (w - size) / 2, top: (h - size) / 2, size };
}

/** x/y are relative to the visible touch rectangle, including in landscape. */
export function getHoldZone(x: number, y: number, width: number, height: number): HoldZone {
  const w = dimension(width), h = dimension(height);
  if (!w || !h || !Number.isFinite(x) || !Number.isFinite(y)) return "menu";
  const { left, top, size } = getHoldMenuBounds(w, h);
  if (x >= left && x <= left + size && y >= top && y <= top + size) return "menu";
  return x / w - y / h >= 0 ? "fast" : "slow";
}
