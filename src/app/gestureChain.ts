/**
 * 全局横向链式手势的起点分类与终点裁决（纯函数；App.tsx 只留 DOM
 * walk 与副作用胶水——pop 300ms 冷却、setTab/push/runDetailNext）。
 * 链序与方向口径见 App.tsx 手势段总注释（真机裁定：左划去下一级、
 * 右划回上一级；栈页右划一律 pop）。
 *
 * 祖先描述符由胶水自 touch 目标向上 walk 产出（不含 main 容器
 * 本身），与原 App.tsx 内联 walk 同序同义：hScrollable =
 * computed overflowX 为 auto/scroll 且 scrollWidth > clientWidth。
 */

export interface ChainAncestor {
  tagName?: string;
  role?: string | null;
  feedInfoZone?: boolean;
  feedScrubZone?: boolean;
  playerSurface?: boolean;
  hScrollable?: boolean;
}

export interface ChainStartContext {
  fs: boolean;
  loginOpen: boolean;
  tab: string;
  stackDepth: number;
  topKind?: string;
  clientX: number;
}

export interface ChainStart {
  blocked: boolean;
  inInfo: boolean;
  inScrub: boolean;
}

export function classifyChainStart(ancestors: ChainAncestor[], ctx: ChainStartContext): ChainStart {
  let blocked = ctx.fs || ctx.loginOpen;
  let inInfo = false;
  let inScrub = false;
  let onPlayerSurface = false;
  for (const n of ancestors) {
    if (n.feedInfoZone) inInfo = true;
    if (n.feedScrubZone) inScrub = true;
    if (n.playerSurface) onPlayerSurface = true;
    if (!blocked) {
      if (n.tagName === "INPUT" || n.tagName === "TEXTAREA" || n.role === "dialog") blocked = true;
      else if (n.hScrollable) blocked = true;
    }
  }
  /* 起点归属隔离（fix322/play，用户 3.2.1 真机实报）：播放器手势面
   * （data-player-surface）内的横拖就是 seek 本身（位移 ≥72 与链的
   * 方向锁天然重叠），旧仲裁只让行了左缘 24px，面内中部起手的 seek
   * 被链 pop/切页签抢走——整个画面被划出去。面内手势（scrub/pan/
   * 边缘返回/点按）由 Feed 表面自理，本链整体不接管；进度条区
   * （data-feed-scrub-zone）起手同理归进度条（detailNext 本就要求
   * !inScrub，无行为损失）。与图集 AlbumViewer 的定版口径一致：
   * 手势按起点归属隔离、互不抢夺。 */
  if (onPlayerSurface || inScrub) blocked = true;
  // 播放器左缘起手归边缘返回手势，本链只接中部
  if (ctx.tab === "home" && ctx.stackDepth === 0 && ctx.clientX <= 24) blocked = true;
  // 栈内 Feed 页同理：左缘起手归 Feed 自己的边缘返回，避免双 pop
  if (ctx.topKind === "feed" && ctx.clientX <= 24) blocked = true;
  return { blocked, inInfo, inScrub };
}

export type ChainAction =
  | { type: "pop" }
  | { type: "detailNext" }
  | { type: "tab"; tab: "home" | "search" | "category" | "profile" }
  | { type: "pushSettings" }
  | null;

export function decideChainSwipe(
  start: ChainStart,
  dx: number,
  dy: number,
  ctx: { tab: string; topKind?: string },
): ChainAction {
  if (start.blocked) return null;
  if (Math.abs(dx) < 72 || Math.abs(dx) < Math.abs(dy) * 1.8) return null;
  const right = dx > 0;
  if (ctx.topKind !== undefined) {
    if (right) return { type: "pop" };
    if (ctx.topKind === "feed" && start.inInfo && !start.inScrub) return { type: "detailNext" };
    return null;
  }
  if (ctx.tab === "home") return right ? null : { type: "tab", tab: "search" };
  if (ctx.tab === "search") return { type: "tab", tab: right ? "home" : "category" };
  if (ctx.tab === "category") return { type: "tab", tab: right ? "search" : "profile" };
  if (ctx.tab === "profile") return right ? { type: "tab", tab: "category" } : { type: "pushSettings" };
  return null;
}
