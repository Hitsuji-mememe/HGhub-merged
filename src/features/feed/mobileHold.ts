export const HOLD_DELAY_MS = 380;
/** 长按加速档位：右滑升档、左滑降档，最低 2x。 */
export const HOLD_SPEED_STEPS = [2, 3, 4, 6];
/** 每累计横向滑动 80px 换一档（增量累计，来回滑可升可降）。 */
export const HOLD_STEP_DISTANCE = 80;
export type HoldMenuBounds = { left: number; top: number; size: number };
export type HoldRotation = 0 | 90;
export type HoldRect = { left: number; top: number; width: number; height: number };

/** Invert the player's clockwise CSS rotation. Native landscape is already in
 * player coordinates and uses rotation=0. Use this for both gestures and guides.
 */
export function getHoldPoint(clientX: number, clientY: number, rect: HoldRect, rotation: HoldRotation = 0) {
  return rotation === 90
    ? { x: clientY - rect.top, y: rect.left + rect.width - clientX, width: rect.height, height: rect.width }
    : { x: clientX - rect.left, y: clientY - rect.top, width: rect.width, height: rect.height };
}
/** 一次长按内的换挡状态：当前档位 + 增量滑动余量。 */
export type HoldSpeed = { rate: number; lastX: number; travel: number };

/** 累计横向增量；跨过一档时更新档位并震动一次，返回新档位，否则返回 null。 */
export function shiftHoldSpeed(s: HoldSpeed, x: number): number | null {
  if (!Number.isFinite(x)) return null;
  s.travel += x - s.lastX;
  s.lastX = x;
  const steps = Math.trunc(s.travel / HOLD_STEP_DISTANCE);
  if (!steps) return null;
  s.travel -= steps * HOLD_STEP_DISTANCE;
  const i = HOLD_SPEED_STEPS.indexOf(s.rate);
  const next = HOLD_SPEED_STEPS[Math.min(HOLD_SPEED_STEPS.length - 1, Math.max(0, i + steps))];
  if (next === s.rate) { s.travel = 0; return null; }
  s.rate = next;
  try { navigator.vibrate?.(15); } catch { /* ignore */ }
  return next;
}

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

