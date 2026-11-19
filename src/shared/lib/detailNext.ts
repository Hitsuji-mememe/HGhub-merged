/** 详情页「下一条/下一集」手势通道（Muse 2026-11-19 fix2.1 批四#12）。
 *
 * 栈内 Feed 在 context 模式且 active 时注册自身（语义与桌面控制层
 * onNext 一致：有下一集先切集、否则切下一条作品）；App 链式手势
 * 只在「栈顶为 feed 页 + 非全屏 + 起手在详情信息区 + 非进度条区」
 * 的左划时调用本通道。单例注册表与 back.ts 同模式：注册方卸载/
 * 失活即注销，调用方拿不到处理器时按未消费处理（左划无动作）。 */
type Handler = () => boolean;

let handler: Handler | null = null;

export function setDetailNextHandler(h: Handler | null) {
  handler = h;
}

/** 返回 true 表示已消费（已切到下一集/下一条）。 */
export function runDetailNext(): boolean {
  try { return handler ? handler() : false; } catch { return false; }
}
