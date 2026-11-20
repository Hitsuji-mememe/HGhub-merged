/**
 * 全局横向链式手势的起点分类与终点裁决（纯函数；App.tsx 只留 DOM
 * walk 与副作用胶水）。门控常量与边缘返回判定在 shared/lib/
 * gestureGate.ts（全 App 唯一判定源）；本模块只负责把起点归属
 * （弹层/播放器面/横滚区等）与链序上下文（栈/页签）合成动作。
 *
 * 一致性定版（fix330/gesture-back 二轮，用户 3.3.0 真机实报「不
 * 单单是误触，而且有很多地方它压根不生效，两个极端」+「证明不
 * 了就删」裁定）：3.3.0 时全 App 三套边缘返回判定并存（本链、
 * Feed 面内自带、DialogFrame 自带，参数互不相同），且本链监听挂
 * main 区、portal 弹层内的触摸根本到达不了。本批统一为：
 * ①判定一处：边缘锚（左右缘各 GESTURE_EDGE_PX）＋距离门＋方向
 *   角门＋过程方向锁，全部出自 gestureGate.ts；Feed 面与
 *   DialogFrame 的自带判定已删除（Feed 只保留起点归属让行，
 *   DialogFrame 只保留 runBack 动作登记）。
 * ②触发一处：本链监听挂 React 根容器（#root），portal 弹层
 *   （Modal/Sheet/Guide/InplaceSearch，祖先带 role="dialog"）
 *   内的触摸同样到达；弹层内只许返回动作。
 * ③动作同序：返回动作 { type:"back" } 由 glue 走与硬件返回键/
 *   Escape 完全同序的分发（runBack 注册制 → 退全屏 → 文档全屏
 *   → 退栈 → 回上一页签；手势不退出应用），落点按上下文裁决、
 *   不在本模块写死——旧 { type:"pop" } 与页签后退动作就此合并。
 * ④豁免同一套（见 classifyChainStart）：输入框起手永不触发
 *   （弹层内同样适用）；横向可滚内容按方向容量豁免（fix333/m6：
 *   起手时该方向还滚得动才归横滚，起手即尽头交回本链——旧版见
 *   横滚祖先即整体封锁，静止位/尽头成死区，清扫 P7）；播放器手
 *   势面/进度条区中部起手归面内手势（seek/pan），边缘起手归本
 *   链返回；全屏中部不触发、边缘起手经返回序退全屏。
 * ⑤嵌套资格（fix331/gesture-precedence，3.3.1 真机首验推翻一
 *   角）：内嵌详情面（组件局部状态原地渲染、不推栈）对只读
 *   topKind 的分类器不可见，曾被当页签根领取前进链/back 落穿
 *   切页签。定版：资格判定一处——glue 起手时以 back.ts 的消费
 *   集合探针（backConsumerActive）采样 nestedBack，与 topKind
 *   同权进栈页分支；嵌套层自身的返回落点由其 runBack 登记保
 *   证（登记与判定同源，不许各面另报状态）。
 *
 * 祖先描述符由胶水自 touch 目标向上 walk 产出（止于根容器），
 * 与原 App.tsx 内联 walk 同序同义：hScrollable = computed
 * overflowX 为 auto/scroll 且 scrollWidth > clientWidth。
 */
import {
  GESTURE_EDGE_PX,
  GESTURE_MIN_DX,
  GESTURE_CONE,
  gestureVerticalClaim,
  decideEdgeBack,
} from "../shared/lib/gestureGate.ts";

/** 兼容既有消费方命名（App.tsx 胶水的过程方向锁采样）。 */
export const chainMoveVerticalClaim = gestureVerticalClaim;
export interface ChainAncestor {
  tagName?: string;
  role?: string | null;
  feedInfoZone?: boolean;
  feedScrubZone?: boolean;
  playerSurface?: boolean;
  hScrollable?: boolean;
  /** 横滚祖先的方向容量（glue 起手采样，仅 hScrollable 时读）：
   * CanConsumePos = scrollLeft 还能减小（吞得下 dx>0 的右拖）、
   * CanConsumeNeg = 还能增大（吞得下 dx<0 的左拖）。缺省＝双向
   * 都能吞（旧描述符口径，豁免全强度、旧行为不变）。 */
  hScrollCanConsumePos?: boolean;
  hScrollCanConsumeNeg?: boolean;
}

export interface ChainStartContext {
  fs: boolean;
  loginOpen: boolean;
  tab: string;
  stackDepth: number;
  topKind?: string;
  /** 嵌套返回资格（fix331/gesture-precedence）：起手时 back.ts 的
   * 返回消费集合非空（弹层登记或页 handler 在册）——当前最上层
   * 语义面是「某一级之下的嵌套层」（内嵌详情/相册/面板），不是
   * 页签根。资格与 topKind 同权，见 decideChainSwipe。 */
  nestedBack: boolean;
  clientX: number;
  viewportWidth: number;
}

export interface ChainStart {
  blocked: boolean;
  /** 起点位于弹层内（祖先含 role="dialog"）：只许返回动作。 */
  inOverlay: boolean;
  /** 嵌套返回资格（起手采样，见 ChainStartContext.nestedBack）：
   * 当前最上层语义面是嵌套层而非页签根，横滑按栈页同科裁决。 */
  nestedBack: boolean;
  inInfo: boolean;
  inScrub: boolean;
  /** 横滚方向所有权（fix333/m6）：classify 由横滚祖先容量并集得
   * 出——OwnsPos＝任一横滚祖先起手时还能吞右拖（dx>0），OwnsNeg
   * 同理（dx<0）。decide 分发前按方向查：被认领的方向整拖归横
   * 滚；无人认领（起手即尽头/无横滚祖先）才进链裁决。 */
  hScrollOwnsPos: boolean;
  hScrollOwnsNeg: boolean;
  fromLeftEdge: boolean;
  fromRightEdge: boolean;
  /** 过程方向锁：glue 在 touchmove 中以 chainMoveVerticalClaim
   * 置位；置位后本次触摸内链整体作废。classify 只给初值 false。 */
  scrollClaimed: boolean;
}

export function classifyChainStart(ancestors: ChainAncestor[], ctx: ChainStartContext): ChainStart {
  const fromLeftEdge = ctx.clientX <= GESTURE_EDGE_PX;
  const fromRightEdge = ctx.viewportWidth > 0 && ctx.clientX >= ctx.viewportWidth - GESTURE_EDGE_PX;
  const fromEdge = fromLeftEdge || fromRightEdge;
  /* 全屏：中部起手不触发（scrub 独占）；边缘起手经返回序退全屏
   * （旧版 fs 整体封锁、靠 Feed 面内自带手势退全屏，其判定已删，
   * 本链是唯一触发面）。登录层（字段保留，账号体系拆除后恒关）
   * 起手整体不接管。 */
  let blocked = ctx.loginOpen || (ctx.fs && !fromEdge);
  let inInfo = false;
  let inScrub = false;
  let onPlayerSurface = false;
  let inOverlay = false;
  let hScrollOwnsPos = false;
  let hScrollOwnsNeg = false;
  for (const n of ancestors) {
    if (n.feedInfoZone) inInfo = true;
    if (n.feedScrubZone) inScrub = true;
    if (n.playerSurface) onPlayerSurface = true;
    if (n.role === "dialog") inOverlay = true;
    /* 横滚豁免按方向容量累计（fix333/m6，清扫 P7）：旧版见横滚祖
     * 先即整体封锁，不问它在这一拖的方向上还滚不滚得动——横滚条
     * 静止位（scrollLeft=0，如切换器 chips 行）上右拖、或滚到尽头
     * 时左拖，该方向容量为零、横滚自身吞不下，本链又被 blocked
     * 挡住，不返回也不切页签（死区）。定版：所有权按方向取祖先
     * 容量并集（任一横滚祖先还能吞该方向即归横滚，与浏览器滚动
     * 链向外传递同理），decide 分发前按方向查所有权；容量缺省
     * （旧描述符）按双向都能吞＝全豁免，不猜测放行。 */
    if (n.hScrollable) {
      if (n.hScrollCanConsumePos ?? true) hScrollOwnsPos = true;
      if (n.hScrollCanConsumeNeg ?? true) hScrollOwnsNeg = true;
    }
    if (!blocked) {
      if (n.tagName === "INPUT" || n.tagName === "TEXTAREA") blocked = true;
    }
  }
  /* 起点归属隔离（fix322/play，用户 3.2.1 真机实报）：播放器手势面
   * （data-player-surface）中部起手的横拖就是 seek 本身（位移 ≥72
   * 与链的方向门天然重叠），本链不接管；进度条区（data-feed-
   * scrub-zone）起手同理归进度条。边缘起手是返回手势的领地：
   * 面内只做归属让行（不 scrub/pan/hold）、不再自行触发返回，
   * 本链接管并经统一返回序分发——旧版此处整体封锁再靠 Feed 自带
   * 手势代行（28px 锁定/64px 触发的另一套判定）就此消除。 */
  if ((onPlayerSurface || inScrub) && !fromEdge) blocked = true;
  return { blocked, inOverlay, nestedBack: ctx.nestedBack, inInfo, inScrub, hScrollOwnsPos, hScrollOwnsNeg, fromLeftEdge, fromRightEdge, scrollClaimed: false };
}

export type ChainAction =
  | { type: "back" }
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
  if (start.blocked || start.scrollClaimed) return null;
  if (Math.abs(dx) < GESTURE_MIN_DX || Math.abs(dx) < Math.abs(dy) * GESTURE_CONE) return null;
  /* 横滚方向所有权（fix333/m6）：本方向已被横滚祖先认领（起手时
   * 该方向尚有剩余量）→ 整拖归横滚，本链不裁；起手即尽头的方向
   * 无人认领，落回下方正常裁决（返回/前进/detailNext）。所有权
   * 起手采样、中途不重估：滚到一半才尽头的拖仍归横滚（原生滚动
   * 链同样不中途交接），只有起手即尽头才穿透——死区边界在此。 */
  if (dx > 0 && start.hScrollOwnsPos) return null;
  if (dx < 0 && start.hScrollOwnsNeg) return null;
  /* 弹层内只许返回动作（双缘同义），且落点由 runBack 最上层先
   * 消费；前进链在弹层内无义。豁免已在 classify 同一套规则内
   * 处理（弹层内的输入框/横滚区起手同样 blocked）。 */
  if (start.inOverlay) {
    return decideEdgeBack(dx, dy, start.fromLeftEdge, start.fromRightEdge) ? { type: "back" } : null;
  }
  if (dx > 0) {
    /* 右划＝返回（左缘锚）。落点不在本模块写死：栈页退栈、根页签
     * 回上一级、面板/弹层先行消费，全由 glue 的统一返回序按上下
     * 文裁决（与硬件返回同序）；链首 home 无可退时 glue 自然空转。 */
    return start.fromLeftEdge ? { type: "back" } : null;
  }
  if (ctx.topKind !== undefined || start.nestedBack) {
    /* 栈页/嵌套面左划：右缘起手＝返回（双缘同义，与 Feed 面/
     * DialogFrame 旧语义对齐、本链旧版独缺的一项）；否则仅栈顶
     * feed 页详情信息区左划＝下一条（detailNext，原语义定锚：
     * 信息区、非进度条区）。边缘返回优先于 detailNext。
     * 嵌套资格（fix331/gesture-precedence，3.3.1 真机首验）：内嵌
     * 详情（吃瓜帖子正文/外部视频详情/图集相册/搜索结果详情）只
     * 活在宿主组件局部状态里、不推 App 栈，topKind 对其恒为
     * undefined——3.3.1 时它们被当作页签根：左划落前进链、右划
     * back 在 glue 落穿到切页签，用户实报「想退回上一级却切去
     * 搜索页签」。定版：嵌套层经 runBack 登记获得返回语义后，
     * 其资格与栈页同权（nestedBack 由 glue 按 back.ts 消费集合
     * 探针采样）——凡语义上是「上一级之下」的面，返回高于切页
     * 签；前进链只在页签根（无栈页∧无嵌套层）成立。detailNext
     * 仍只认栈顶 feed，嵌套资格不冒领。 */
    if (decideEdgeBack(dx, dy, start.fromLeftEdge, start.fromRightEdge)) return { type: "back" };
    if (ctx.topKind === "feed" && start.inInfo && !start.inScrub) return { type: "detailNext" };
    return null;
  }
  /* 根页签左划＝前进链（右缘锚，去下一级/进设置）。资格前提：
   * 栈空∧无嵌套返回层（nestedBack 未置位），见上方嵌套资格注。 */
  if (!start.fromRightEdge) return null;
  if (ctx.tab === "home") return { type: "tab", tab: "search" };
  if (ctx.tab === "search") return { type: "tab", tab: "category" };
  if (ctx.tab === "category") return { type: "tab", tab: "profile" };
  if (ctx.tab === "profile") return { type: "pushSettings" };
  return null;
}
