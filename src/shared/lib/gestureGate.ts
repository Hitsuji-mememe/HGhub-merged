/**
 * 边缘返回手势的统一门控常量与纯判定（全 App 唯一判定源，
 * fix330/gesture-back 一致性批，Muse 2026-11-19）。
 *
 * 3.3.0 之前全 App 三套边缘返回判定各行其是：壳层链全屏任意位置
 * 布防（72px／锥角 1.8，见 fix330 首轮收紧前的 gestureChain）、
 * Feed 播放面自带一套（20/22px 起手、28px／1.5 锥角锁定、64px
 * 触发）、DialogFrame 自带一套（20/22px、64px／1.5，且无内容豁免、
 * guide 类弹层干脆没有手势）——同一手势在不同面触发条件互不相同，
 * 用户真机实报「不单单是误触，而且有很多地方它压根不生效，两个
 * 极端」。本批定版：判定只此一处，触发只剩壳层链一处（src/app/
 * gestureChain.ts 消费本模块，监听挂 #root 覆盖 portal 弹层），
 * 动作经 shared/lib/back.ts 的 runBack 注册制分发、与硬件返回键／
 * Escape 完全同序。Feed 播放面只保留起点归属（边缘起手不 scrub/
 * pan/hold），不再自行判定或触发返回；DialogFrame 不再自带指针
 * 边缘关闭（其 runBack 登记保留，那是动作侧、不是判定侧）。
 */

/** 边缘起始区宽度（px，左右缘同值）。 */
export const GESTURE_EDGE_PX = 24;
/** 距离门：终点横向净位移下限（px）。 */
export const GESTURE_MIN_DX = 72;
/** 方向角门：|dx| 须 ≥ |dy| × 本值（2.5 ≈ 22° 锥角）。 */
export const GESTURE_CONE = 2.5;
/** 过程方向锁的认领距离：纵向位移先过此值才谈占优（抖动不认领）。 */
export const GESTURE_CLAIM_DY = 24;

/** 过程方向锁谓词（壳层链 glue 的 passive touchmove 采样口径）：
 * 自起点位移纵向分量已过认领距离、且纵向占优 → 本次触摸已被页面
 * 滚动认领，终点净位移不再翻案。横向占优或未过认领距离（指尖
 * 抖动）不认领。监听全程 passive，触发前不劫持页面滚动。 */
export function gestureVerticalClaim(dx: number, dy: number): boolean {
  return Math.abs(dy) >= GESTURE_CLAIM_DY && Math.abs(dy) > Math.abs(dx);
}

/** 边缘返回判定（双缘同义）：左缘起手向右、或右缘起手向左，位移
 * 过距离门与方向角门即成立；非边缘起手永不成立。右缘左滑同为
 * 返回是 2026-11-18 第 10 项裁定（用户直觉方向），此前只有 Feed
 * 面与 DialogFrame 有、本链栈页没有——本批起全 App 统一。 */
export function decideEdgeBack(dx: number, dy: number, fromLeftEdge: boolean, fromRightEdge: boolean): boolean {
  if (Math.abs(dx) < GESTURE_MIN_DX || Math.abs(dx) < Math.abs(dy) * GESTURE_CONE) return false;
  return dx > 0 ? fromLeftEdge : fromRightEdge;
}
