/** 全局返回拦截：面板等临时层优先消费，未消费则走导航栈。 */
type Handler = () => boolean;
export type RegisterStartupBack = (handler: () => void) => () => void;

let handler: Handler | null = null;
const overlays: { handle: Handler }[] = [];

/** Dialogs can nest; dismiss the newest overlay before a player panel or page. */
export function registerOverlayBack(h: Handler) {
  const entry = { handle: h };
  overlays.push(entry);
  return () => { const index = overlays.indexOf(entry); if (index !== -1) overlays.splice(index, 1); };
}

export function setBackHandler(h: Handler | null) {
  handler = h;
}

/** 返回消费集合非空探针（fix331/gesture-precedence）：任一弹层登记
 * 在册或页 handler 已登记，即存在一个排在壳层导航（退栈/切页签）
 * 之前消费返回的层——内嵌详情/相册/面板打开时其宿主据此获得
 * 「上一级之下」的返回语义。手势链 glue 在起手时采样本探针作
 * 资格判定（与 runBack 的消费集合严格同源、单一事实出处），
 * 不许各面另报状态造成判定与落点分叉。 */
export function backConsumerActive(): boolean {
  return overlays.length > 0 || handler !== null;
}

/** 返回 true 表示已被消费（不再退栈） */
export function runBack(): boolean {
  // A handler can synchronously unregister itself. Snapshot registrations to avoid
  // calling another handler twice or dismissing an overlay opened during this event.
  for (const entry of [...overlays].reverse()) {
    if (!overlays.includes(entry)) continue;
    try {
      if (entry.handle()) return true;
    } catch {
      // A failed dialog close must not navigate away from the page beneath it.
      return true;
    }
  }
  try { return handler ? handler() : false; } catch { return false; }
}
