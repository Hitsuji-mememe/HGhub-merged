/** 全局返回拦截：面板等临时层优先消费，未消费则走导航栈。 */
type Handler = () => boolean;
export type RegisterStartupBack = (handler: () => void) => () => void;

let handler: Handler | null = null;
const overlays: { handle: Handler }[] = [];

// The launch overlay owns back while it covers an already-mounted App: back skips
// the reveal (LaunchAnimation's own listener) and must not navigate beneath it.
// Reference-counted so StrictMode's mount→cleanup→mount keeps the gate held;
// each release closure is idempotent.
let startupHolds = 0;
export function holdBackForStartup(): () => void {
  startupHolds += 1;
  let released = false;
  return () => { if (!released) { released = true; startupHolds = Math.max(0, startupHolds - 1); } };
}

/** 启动门持有中（开场动画/协议层覆盖已挂载的 App）：手势层据此
 * 整体让行——runBack 在持有期只消费不分发，前进类手势动作不经
 * runBack，须由手势 glue 显式查此探针（fix330/gesture-back）。 */
export function backHeldByStartup(): boolean {
  return startupHolds > 0;
}

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
  // Startup gate: consume without touching overlays or the page handler, so the
  // App mounted behind the launch overlay stays put until the reveal is done.
  if (startupHolds > 0) return true;
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
