/**
 * fix322/play 契约测试（Muse 2026-11-19）：手势按起点归属隔离——
 * 播放器手势面内的横拖 seek 全程不得触发全局链（pop/切页签），
 * 与 AlbumViewer 缩略图条同类病、同口径。用户真机实报（3.2.1）：
 * 播放器里往右划调进度，整个画面被划出去（栈页 pop）。
 * 运行：node src/app/gestureChain.contract.test.ts
 *
 * fix330/gesture-back 一轮扩展（用户 3.3.0 真机实报「滑动返回容易
 * 误触」）：旧链全屏任意位置布防、锥角 1.8 过松、只看终点净位移。
 * 收紧：边缘锚（返回类左缘/前进类右缘 24px）＋锥角 2.5＋过程方向
 * 锁（途中纵向占优即被滚动认领、整触摸作废）。误触组即此轮产物。
 *
 * fix330/gesture-back 二轮扩展（一致性批，用户追加实报「有很多地
 * 方它压根不生效，两个极端」＋「证明不了就删」裁定）：3.3.0 时全
 * App 三套边缘返回判定并存（本链、Feed 面内 20/22px+28px 锁定+
 * 64px 触发、DialogFrame 20/22px+64px 且无内容豁免、guide 类弹
 * 层没有），且本链监听挂 main 区、portal 弹层内触摸根本到达不
 * 了。定版统一：判定收敛 shared/lib/gestureGate.ts 一处、触发只
 * 剩本链一处（监听挂 #root 覆盖弹层）、返回动作合并为
 * { type:"back" } 由 glue 走与硬件返回键完全同序的统一返回序
 * （runBack → 退全屏 → 文档全屏 → 退栈 → 回上一页签；旧
 * { type:"pop" } 与页签后退动作就此合并，落点由 glue 按上下文
 * 裁决）。Feed 面/DialogFrame 的自带判定已删（Feed 只留起点归
 * 属让行）。失效组＝此前无手势/异规则的面在新实现上逐条成立
 * （基线 4cf7454 上逐条为 null，证伪探针实跑入线报告）；误触组
 * 与豁免组保证统一不以放松门控为代价。
 */
import assert from "node:assert/strict";
import { chainMoveVerticalClaim, classifyChainStart, decideChainSwipe, type ChainAncestor, type ChainStart, type ChainStartContext } from "./gestureChain.ts";

function swipe(ancestors: ChainAncestor[], ctx: Partial<ChainStartContext> & { clientX?: number }, dx: number, dy: number, opts?: { claimed?: boolean }) {
  const full: ChainStartContext = {
    fs: false, loginOpen: false, tab: "home", stackDepth: 0, topKind: undefined, nestedBack: false, clientX: 200, viewportWidth: 393, ...ctx,
  };
  const start: ChainStart = classifyChainStart(ancestors, full);
  if (opts?.claimed) start.scrollClaimed = true;
  return decideChainSwipe(start, dx, dy, { tab: full.tab, topKind: full.topKind });
}

const PLAIN: ChainAncestor[] = [{ tagName: "DIV" }, { tagName: "SECTION" }, { tagName: "MAIN" }];
const STAGE: ChainAncestor[] = [{ tagName: "DIV", playerSurface: true }, { tagName: "SECTION" }, { tagName: "MAIN" }];
const SCRUB: ChainAncestor[] = [{ tagName: "DIV", feedScrubZone: true }, { tagName: "DIV", feedInfoZone: true }, { tagName: "SECTION" }];
const INFO: ChainAncestor[] = [{ tagName: "DIV", feedInfoZone: true }, { tagName: "SECTION" }, { tagName: "MAIN" }];
/* 弹层内起点（Modal/Sheet/Guide/InplaceSearch 的共同形态：祖先含
 * role="dialog"；弹层经 portal 挂 #root 直下，监听挂 #root 后可达） */
const DIALOG: ChainAncestor[] = [{ tagName: "DIV" }, { tagName: "DIV", role: "dialog" }, { tagName: "DIV" }];
const DIALOG_SCROLL: ChainAncestor[] = [{ tagName: "DIV", hScrollable: true }, { tagName: "DIV", role: "dialog" }, { tagName: "DIV" }];
const DIALOG_INPUT: ChainAncestor[] = [{ tagName: "INPUT" }, { tagName: "DIV", role: "dialog" }, { tagName: "DIV" }];

/* ── 缺陷回归（fix322）：seek 横拖不得被外层链抢走 ── */
assert.equal(
  swipe(STAGE, { tab: "home", stackDepth: 1, topKind: "feed" }, 120, 10), null,
  "栈内 Feed 页播放面中部起手右划 seek（dx=120）：链不得返回（旧实现把整个画面划出去）",
);
assert.equal(
  swipe(STAGE, { tab: "home", stackDepth: 0 }, -120, 8), null,
  "首页播放面中部起手左划 seek（dx=-120）：链不得切去搜索页签",
);
assert.equal(
  swipe(SCRUB, { tab: "home", stackDepth: 1, topKind: "settings" }, 120, 6), null,
  "栈页进度条区中部起手右划拖进度（dx=120）：链不得返回",
);

/* ── 误触组：旧实现逐条触发、新实现逐条不触发 ── */
assert.equal(
  swipe(PLAIN, { tab: "home", stackDepth: 1, topKind: "settings", clientX: 200 }, 120, 10), null,
  "误触①栈页中部起手右划（dx=120）：旧实现 pop、新实现无边缘锚不触发",
);
assert.equal(
  swipe(PLAIN, { tab: "home", stackDepth: 1, topKind: "gallery", clientX: 180 }, 100, 6), null,
  "误触②图集页主图区中部起手右划翻上一张（dx=100）：旧实现 pop 抢走翻页、新实现不触发（舞台边缘归属另在 AlbumViewer 侧同口径让行）",
);
assert.equal(
  swipe(PLAIN, { tab: "home", stackDepth: 1, topKind: "settings", clientX: 10 }, 120, 55), null,
  "误触③左缘起手斜滑（dx=120,dy=55，过旧 1.8 锥角、未过新 2.5 锥角）：旧实现 pop、新实现不触发",
);
assert.equal(
  swipe(PLAIN, { tab: "search", stackDepth: 0, clientX: 200 }, -120, 5), null,
  "误触④搜索页中部起手左划：旧实现切去分类页签、新实现无右缘锚不触发",
);
assert.equal(
  swipe(PLAIN, { tab: "category", stackDepth: 0, clientX: 200 }, 120, 5), null,
  "误触⑤分类页中部起手右划：旧实现回搜索页签、新实现无左缘锚不触发",
);
assert.equal(
  swipe(PLAIN, { tab: "home", stackDepth: 1, topKind: "settings", clientX: 10 }, 140, 10, { claimed: true }), null,
  "误触⑥左缘起手但途中已被纵向滚动认领（终点 dx=140,dy=10）：旧实现只看终点净位移 pop、新实现过程方向锁作废",
);
assert.equal(
  swipe(DIALOG, { tab: "home", stackDepth: 1, topKind: "settings", clientX: 200 }, 120, 10), null,
  "误触⑦弹层内中部起手右划：弹层内同样只有边缘起手才许返回动作",
);
assert.equal(
  swipe(DIALOG_SCROLL, { tab: "home", stackDepth: 1, topKind: "settings", clientX: 10 }, 130, 8), null,
  "误触⑧弹层内横滚内容上边缘起手：横滑内容豁免在弹层内同样成立（DialogFrame 旧自带判定无此豁免、会误关弹层）",
);
assert.equal(
  swipe(DIALOG_INPUT, { tab: "search", stackDepth: 0, clientX: 10 }, 130, 8), null,
  "误触⑨弹层内输入框上边缘起手：输入豁免在弹层内同样成立",
);

/* ── 失效组：此前无手势/异规则的面，新实现逐条成立（基线逐条 null） ── */
assert.deepEqual(
  swipe(DIALOG, { tab: "home", stackDepth: 1, topKind: "settings", clientX: 10 }, 130, 8), { type: "back" },
  "失效①Modal/Sheet 内左缘右滑：基线链监听挂 main 区收不到 portal 触摸、只剩 DialogFrame 异规则（64px/1.5/无豁免）代行；新实现统一门控触发 back、由 runBack 关最上层弹层",
);
assert.deepEqual(
  swipe(DIALOG, { tab: "home", stackDepth: 0, fs: true, clientX: 10 }, 130, 8), { type: "back" },
  "失效②Guide 弹层（全屏播放器教练层）内左缘右滑：基线 guide 类被 DialogFrame 显式排除、无任何手势返回，且链被 fs+dialog 双重封锁；新实现触发 back",
);
assert.deepEqual(
  swipe(STAGE, { tab: "home", stackDepth: 1, topKind: "feed", clientX: 10 }, 130, 8), { type: "back" },
  "失效③栈内 Feed 面左缘右滑：基线链整体让行、靠 Feed 自带判定（28px 锁定/64px）代行；新实现由链统一触发 back（Feed 只做归属让行）",
);
assert.deepEqual(
  swipe(STAGE, { tab: "home", stackDepth: 0, fs: true, clientX: 10 }, 130, 8), { type: "back" },
  "失效④全屏 Feed 面左缘右滑退全屏：基线链被 fs 封锁、靠 Feed 自带判定代行；新实现触发 back、返回序中退全屏一步落点",
);
assert.deepEqual(
  swipe(PLAIN, { tab: "home", stackDepth: 1, topKind: "settings", clientX: 385 }, -130, 8), { type: "back" },
  "失效⑤普通栈页右缘左滑返回：基线本链独缺此项（只有 Feed 面/DialogFrame 有双缘），新实现双缘同义成立",
);
assert.deepEqual(
  swipe(STAGE, { tab: "home", stackDepth: 1, topKind: "feed", clientX: 385 }, -130, 8), { type: "back" },
  "失效⑥栈内 Feed 面右缘左滑：与⑤同一不变量（双缘同义不分面）",
);
assert.deepEqual(
  swipe(DIALOG, { tab: "search", stackDepth: 0, clientX: 10 }, 130, 8), { type: "back" },
  "失效⑦InplaceSearch（role=dialog 的页内搜索层）左缘右滑：基线被 role=dialog 整体挡死、手势返回会退整页而非先关搜索；新实现触发 back、runBack 先关搜索层（与硬件返回同序）",
);

/* ── 正例组：统一后各面正经边缘滑动仍稳定触发 ── */
assert.deepEqual(
  swipe(PLAIN, { tab: "home", stackDepth: 1, topKind: "settings", clientX: 8 }, 130, 40), { type: "back" },
  "正例①普通栈页左缘起手带轻微斜度右划（dx=130,dy=40，过 2.5 锥角）：仍触发 back（方向门不误杀正经边缘滑）",
);
assert.deepEqual(
  swipe(PLAIN, { tab: "search", stackDepth: 0, clientX: 10 }, 120, 5), { type: "back" },
  "正例②搜索页左缘右划：触发 back（落点＝回首页由 glue 返回序裁决，与硬件返回同序；旧动作 {tab:home} 已合并）",
);
assert.deepEqual(
  swipe(PLAIN, { tab: "home", stackDepth: 0, clientX: 385 }, -120, 5), { type: "tab", tab: "search" },
  "正例③链首右缘左划：仍去搜索页签（前进链不变）",
);
assert.deepEqual(
  swipe(PLAIN, { tab: "search", stackDepth: 0, clientX: 385 }, -120, 5), { type: "tab", tab: "category" },
  "正例④搜索页右缘左划：仍去分类页签",
);
assert.deepEqual(
  swipe(PLAIN, { tab: "profile", stackDepth: 0, clientX: 385 }, -120, 5), { type: "pushSettings" },
  "正例⑤我的页右缘左划：仍进设置（链序不变）",
);
assert.deepEqual(
  swipe(INFO, { tab: "home", stackDepth: 1, topKind: "feed", clientX: 200 }, -120, 10), { type: "detailNext" },
  "正例⑥栈顶 Feed 详情信息区中部左划：仍切下一条（detailNext 原语义定锚不变）",
);
assert.deepEqual(
  swipe(INFO, { tab: "home", stackDepth: 1, topKind: "feed", clientX: 385 }, -130, 8), { type: "back" },
  "正例⑦详情信息区右缘起手左滑：边缘返回优先于 detailNext（归属先于内容动作）",
);
assert.equal(
  swipe(PLAIN, { tab: "home", stackDepth: 1, topKind: "settings", clientX: 10 }, 60, 4), null,
  "正例⑧左缘起手短距离扫过（dx=60 未过 72 距离门）：不触发（距离门防回归）",
);

/* ── 既有豁免防回归 ── */
assert.equal(swipe(PLAIN, { tab: "home", stackDepth: 1, topKind: "settings", fs: true }, 120, 10), null, "全屏中部起手：链不触发（scrub 独占）");
assert.equal(
  swipe([{ tagName: "INPUT" }, { tagName: "DIV" }], { tab: "search", stackDepth: 0, clientX: 10 }, -120, 5), null,
  "输入框起手：链不触发",
);
assert.equal(
  swipe([{ tagName: "DIV", hScrollable: true }, { tagName: "DIV" }], { tab: "search", stackDepth: 0, clientX: 10 }, -120, 5), null,
  "横滚区起手：链不触发",
);
assert.equal(swipe(PLAIN, { tab: "home", stackDepth: 0, clientX: 200 }, 120, 5), null, "链首中部右划无动作");
assert.deepEqual(
  swipe(PLAIN, { tab: "home", stackDepth: 0, clientX: 10 }, 120, 5), { type: "back" },
  "链首左缘右滑：触发 back（glue 返回序只消费面板/全屏、无可退时空转；旧版恒无动作、面板开着时滑不掉）",
);
assert.equal(
  swipe(PLAIN, { tab: "home", stackDepth: 1, topKind: "settings", clientX: 10 }, 100, 80), null,
  "纵向占优位移（dx=100,dy=80 未过方向门）：链不触发",
);

/* ── 嵌套组（fix331/gesture-precedence，3.3.1 真机首验）：页签根
 * 面内嵌详情（分类总览 compact 吃瓜详情为典型：详情在组件局部状态
 * 里原地替换列表、宿主外层页头与切换器仍在屏、栈深 0）——3.3.1
 * 时分类器只认 App 栈 topKind，嵌套层不可见，左划落根面前进链、
 * 右划 back 在 glue 落穿到「回上一页签」，用户实报横滑切去搜索
 * 页签而非退回列表。定版：嵌套层经 runBack 登记获得返回语义后，
 * 链的资格判定以 nestedBack（back.ts 消费集合探针，glue 起手时
 * 采样）与 topKind 同权——嵌套面按栈页同科：双缘返回、前进链
 * 只在页签根（无栈页∧无嵌套层）成立。── */
assert.deepEqual(
  swipe(PLAIN, { tab: "category", stackDepth: 0, nestedBack: true, clientX: 385 }, -120, 5), { type: "back" },
  "嵌套①分类页签内嵌吃瓜详情右缘左滑：旧实现落根面前进链切去我的页签、新实现返回（落点由 runBack 先关详情层）",
);
assert.deepEqual(
  swipe(PLAIN, { tab: "category", stackDepth: 0, nestedBack: true, clientX: 10 }, 120, 5), { type: "back" },
  "嵌套②同面左缘右滑：触发 back（旧实现动作同为 back、但详情未登记时 glue 落穿切去搜索页签；登记＋资格同批落地后落点为关详情）",
);
assert.equal(
  swipe(PLAIN, { tab: "category", stackDepth: 0, nestedBack: true, clientX: 200 }, -120, 5), null,
  "嵌套③同面中部起手左划：不触发（嵌套资格不放松边缘锚，中部横滑仍归面内滚动/内容）",
);
assert.equal(
  swipe(PLAIN, { tab: "category", stackDepth: 0, nestedBack: true, clientX: 200 }, 120, 5), null,
  "嵌套④同面中部起手右划：不触发（同③，资格变化不产生中部布防）",
);
assert.deepEqual(
  swipe(INFO, { tab: "search", stackDepth: 0, nestedBack: true, clientX: 385 }, -130, 8), { type: "back" },
  "嵌套⑤搜索页签内嵌详情（信息区祖先形态）右缘左滑：旧实现切去分类页签、新实现返回；detailNext 只认栈顶 feed、嵌套资格不冒领",
);
assert.deepEqual(
  swipe(PLAIN, { tab: "category", stackDepth: 0, nestedBack: false, clientX: 385 }, -120, 5), { type: "tab", tab: "profile" },
  "嵌套⑥同面无嵌套层（真页签根）：前进链照旧成立——资格探针未置位时根面行为逐字不变，防误伤正例",
);

/* ── 死区组（fix333/m6，3.3.2 清扫 P7 专项核查）：横滚祖先旧版无条件
 * 整体封锁——分类器只问「有没有能溢出的横滚祖先」、不问「它在这一
 * 拖的方向上还滚不滚得动」。横滚条静止位（scrollLeft=0，如切换器
 * chips 行）上左缘右滑（返回手势）落进死区：横滚自身吞不下（已在
 * 起点）、本链又被 blocked 挡住，不返回也不切页签；滚到尽头时右缘
 * 左滑同理（栈页返回/页签根前进链双死）。定版：豁免按方向容量裁
 * ——glue 起手采样横滚祖先的双向剩余量（hScrollCanConsumePos/Neg），
 * classify 并集为方向所有权（hScrollOwnsPos/Neg），decide 在分发前
 * 按方向查所有权：该方向起手即尽头 → 仲裁权交回本链（与浏览器滚
 * 动链同理）；起手尚有余量 → 整拖归横滚（中途滚到尽头不中途交接，
 * 原生链同样如此）。旧描述符（无容量字段）＝双向全豁免、旧行为
 * 逐字不变。本组前六例在旧实现上逐条为 null（blocked）、即 P7 死
 * 区的契约复现；后六例为对照（豁免本该成立处新旧同为 null）。── */
const CHIPS_HEAD: ChainAncestor[] = [{ tagName: "DIV", hScrollable: true, hScrollCanConsumePos: false, hScrollCanConsumeNeg: true }, { tagName: "SECTION" }, { tagName: "MAIN" }];
const CHIPS_TAIL: ChainAncestor[] = [{ tagName: "DIV", hScrollable: true, hScrollCanConsumePos: true, hScrollCanConsumeNeg: false }, { tagName: "SECTION" }, { tagName: "MAIN" }];
const CHIPS_MID: ChainAncestor[] = [{ tagName: "DIV", hScrollable: true, hScrollCanConsumePos: true, hScrollCanConsumeNeg: true }, { tagName: "SECTION" }, { tagName: "MAIN" }];
const CHIPS_BARE: ChainAncestor[] = [{ tagName: "DIV", hScrollable: true }, { tagName: "SECTION" }, { tagName: "MAIN" }];
const DIALOG_CHIPS_HEAD: ChainAncestor[] = [{ tagName: "DIV", hScrollable: true, hScrollCanConsumePos: false, hScrollCanConsumeNeg: true }, { tagName: "DIV", role: "dialog" }, { tagName: "DIV" }];
const INFO_CHIPS_TAIL: ChainAncestor[] = [{ tagName: "DIV", feedInfoZone: true }, { tagName: "DIV", hScrollable: true, hScrollCanConsumePos: true, hScrollCanConsumeNeg: false }, { tagName: "SECTION" }];
const INFO_CHIPS_MID: ChainAncestor[] = [{ tagName: "DIV", feedInfoZone: true }, { tagName: "DIV", hScrollable: true, hScrollCanConsumePos: true, hScrollCanConsumeNeg: true }, { tagName: "SECTION" }];

assert.deepEqual(
  swipe(CHIPS_HEAD, { tab: "home", stackDepth: 1, topKind: "settings", clientX: 10 }, 130, 8), { type: "back" },
  "死区①chips 行静止位（scrollLeft=0）左缘右滑：横滚吞不下右拖、旧实现 blocked 死区；新实现仲裁权交回本链触发 back",
);
assert.deepEqual(
  swipe(CHIPS_TAIL, { tab: "home", stackDepth: 1, topKind: "settings", clientX: 385 }, -130, 8), { type: "back" },
  "死区②chips 行滚到尽头右缘左滑：横滚吞不下左拖、旧实现死区；新实现触发 back（双缘同义）",
);
assert.deepEqual(
  swipe(CHIPS_TAIL, { tab: "category", stackDepth: 0, clientX: 385 }, -120, 5), { type: "tab", tab: "profile" },
  "死区③页签根 chips 行尽头右缘左滑：旧实现前进链同样被 blocked 吞掉；新实现穿透成立前进链",
);
assert.deepEqual(
  swipe(CHIPS_HEAD, { tab: "home", stackDepth: 0, clientX: 10 }, 120, 5), { type: "back" },
  "死区④链首 chips 行静止位左缘右滑：与平坦面正例同义（触发 back、落点由返回序裁决），旧实现死区",
);
assert.deepEqual(
  swipe(DIALOG_CHIPS_HEAD, { tab: "home", stackDepth: 1, topKind: "settings", clientX: 10 }, 130, 8), { type: "back" },
  "死区⑤弹层内横滚行静止位左缘右滑：弹层内豁免同套方向容量——横滚吞不下时交回本链、由 runBack 关最上层弹层（与误触⑧的能吞情形对照）",
);
assert.deepEqual(
  swipe(INFO_CHIPS_TAIL, { tab: "home", stackDepth: 1, topKind: "feed", clientX: 200 }, -120, 10), { type: "detailNext" },
  "死区⑥详情信息区内横滚行尽头中部左划：左拖无主（横滚已尽头），按同方向所有权口径交回本链、detailNext 成立",
);
assert.equal(
  swipe(CHIPS_MID, { tab: "home", stackDepth: 1, topKind: "settings", clientX: 10 }, 130, 8), null,
  "死区对照①chips 行中段（双向有余量）左缘右滑：右拖归横滚吞入，链不触发（豁免本义不变）",
);
assert.equal(
  swipe(CHIPS_HEAD, { tab: "home", stackDepth: 1, topKind: "settings", clientX: 385 }, -130, 8), null,
  "死区对照②chips 行静止位右缘左滑：左拖正是横滚能吞的方向，链不触发（方向容量只放行吞不下的方向）",
);
assert.equal(
  swipe(CHIPS_TAIL, { tab: "home", stackDepth: 1, topKind: "settings", clientX: 10 }, 130, 8), null,
  "死区对照③chips 行尽头左缘右滑：右拖归横滚回滚吞入，链不触发",
);
assert.equal(
  swipe(CHIPS_BARE, { tab: "home", stackDepth: 1, topKind: "settings", clientX: 10 }, 130, 8), null,
  "死区对照④旧描述符（hScrollable 无容量字段）：按双向全豁免处理、旧行为逐字不变（容量缺省不许猜测放行）",
);
assert.equal(
  swipe(INFO_CHIPS_MID, { tab: "home", stackDepth: 1, topKind: "feed", clientX: 200 }, -120, 10), null,
  "死区对照⑤详情信息区内横滚行中段左划：左拖归横滚，detailNext 不冒领",
);
assert.equal(
  swipe(CHIPS_HEAD, { tab: "home", stackDepth: 1, topKind: "settings", clientX: 200 }, 130, 8), null,
  "死区对照⑥chips 行静止位中部起手右划：穿透只交回仲裁、不放松边缘锚——中部起手仍无动作",
);

/* ── 过程方向锁谓词（glue 的 touchmove 采样口径） ── */
assert.equal(chainMoveVerticalClaim(10, 30), true, "位移 30 且纵向占优：滚动认领");
assert.equal(chainMoveVerticalClaim(30, 10), false, "横向占优：不认领");
assert.equal(chainMoveVerticalClaim(5, 8), false, "未过认领距离（抖动区）：不认领");
assert.equal(chainMoveVerticalClaim(60, 30), false, "纵向位移虽大但未占优：不认领");

console.log("gestureChain.contract: all assertions passed");
