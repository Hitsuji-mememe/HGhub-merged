/**
* 合并诊断报告（2026-11-18 收官批 D 项）：设置页只剩一个「诊断报告」入口，
* 取代原「网络诊断」行与整个「播放诊断」区（含日志开关——记录始终开启，
* 见 playbackDiagnostics.initPlaybackLog）。点开即生成：跑网络探测
* （net_diag，含分片测速 A/B）+ 固定线路延迟探测 + 取最近播放流水 +
* 当前线路/超分/源规格，拼成结论先行的纯文本，页面内预览、一键复制，
* 供维护者一次定位。
*
* 格式三段：
* ① 结论（网络定性 / 当前线路与各线延迟吞吐 / 最近播放卡点 / 会话降级）
* ② 硬数据（版本 / 平台 / 当前集源规格 / 选线现状）
* ③ 最近一次播放事件流水简表（resolve→manifest→range→append→
* buffered→playing 各步成败与耗时，截断至关键步）
*
* 任一数据源失败只降级对应段落，不拖垮整份报告。
*/

import { api, APP_VERSION, BUILD_STAMP, hostOf, platform} from "../api/api";
import { autoLineEnabled, lastPickRound} from "../network/autoLine";
import { nativeFallbackState} from "../../features/playback/mediaTransport";
import { playbackLogApi} from "./playbackDiagnostics";
import { readPlaybackFacts} from "./playbackFacts";
import { shortVerdict} from "./netDiagReport";
import { snapshot as ledgerSnapshot} from "./eventLedger";
import { formatGpuProbeLines, getCachedGpuProbe} from "./gpuProbe";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" &&!Array.isArray(v)? (v as Json): {});
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v)? v: null);
const str = (v: unknown): string => (typeof v === "string"? v: "");

type LogEntry = { event: string; ts: number; pid: number | null; data: Json};

function parseLog(text: string): LogEntry[] {
const out: LogEntry[] = [];
for (const line of text.split("\n")) {
const trimmed = line.trim();
if (!trimmed.startsWith("{")) continue;
try {
const raw = JSON.parse(trimmed) as Json;
const ts = Date.parse(str(raw.ts));
out.push({
event: str(raw.event),
ts: Number.isFinite(ts)? ts: 0,
pid: num(raw.pid),
data: obj(raw.data),
});
} catch { /* 半行/损坏行跳过 */}
}
return out;
}

/* 流水阶段定义（fix2 A4 起播口径统一，T0–T7 分段表）：事件名以真机
 * 日志为准（前端事件在文件中带 web. 前缀）。分段语义——
 * T0 请求起播＝source.load（分段起点，不入表）；T1 会话建立＝resolve；
 * T3 清单完成＝manifest；T4 首个有效分片＝range；T5 append 完成＝append；
 * 其后 buffered＝缓冲达标；T7 首帧呈现＝first_frame（无此信号时以
 * playing 为代理并在结论行标注）。T2 选线完成与 T6 解码首帧在现行
 * 事件体系里没有独立事件，不设假阶段——缺失阶段如实标「未记录」，
 * 不许拿相邻阶段冒充。全部阶段只在同一次播放分段内取首个命中，
 * 偏移同源同 t0，结论行起播＝T7−T0 可由分段偏移逐项加总核对。 */
const STAGES: { key: string; label: string; events: string[]}[] = [
{ key: "resolve", label: "resolve", events: ["web.play.resolve"]},
{ key: "manifest", label: "manifest", events: ["web.hls.manifest", "web.media.loadstart"]},
{ key: "range", label: "range", events: ["web.hlsFragLoaded", "media.range_fetch"]},
{ key: "append", label: "append", events: ["web.hls.buffer_appended"]},
{ key: "buffered", label: "buffered", events: ["web.hlsFragBuffered"]},
{ key: "playing", label: "playing", events: ["web.media.playing"]},
{ key: "first_frame", label: "首帧", events: ["web.media.first_frame"]},
];

type FlowResult = {
/** 一行流水简表，如 "resolve ✓ 12ms · manifest ✓ … · append ✗ 未达" */
table: string;
/** 卡点结论（已出画则为正常结论）。 */
verdict: string;
/** 起播耗时（T0→T7 首帧呈现；无首帧信号回落 playing 并以
 * startupBasis 标明，仍缺失时 null），供结论行引用。与逐次播放
 * 的 startupMs 同一定义、同一分段函数计算（fix2 A4 口径统一：
 * 此前结论行用 t0→buffered、逐次用 t0→首帧，两数同报告打架）。 */
startupMs: number | null;
/** 起播耗时的信号来源：first_frame＝实测首帧；playing＝代理回落；
 * null＝两者皆缺，结论行须标「统计不完整」，不许编数。 */
startupBasis: "first_frame" | "playing" | null;
/** 本进程（pid 相同）是否发生过 append 卡死/会话降级。 */
stalledThisSession: boolean;
fallbackThisSession: boolean;
/** 本会话自愈计数（整改 1）：只有布尔量会把「卡 1 次」和「卡 5 次全
 * 自愈」塌缩成同一行，频率被掩盖——计数入报告（GPT 审计新提、成立）。 */
stallCount: number;
rebuildCount: number;
fallbackCount: number;
/** 最近一次卡死的四状态分类（看门狗判死时记录），报告纠错的第一线索。 */
lastStallState: string | null;
/** 本会话超分帧成本降档次数（功耗/发热问题的代理指标）。 */
demoteCount: number;
/** 本会话实际切线次数与两轮确认待确认次数（线路乱跳的代理指标）。 */
lineSwitchCount: number;
confirmPendingCount: number;
/** 逐次播放结局（复审批 §6）：频繁切换场景下逐次成败不可被最后一次掩盖。 */
plays: PlayOutcome[];
/** 干净出画的起播中位数（恢复耗时不混入）；无干净样本时 null。 */
medianStartupMs: number | null;
/** 最慢的干净出画及其播放序号；无样本时 null。 */
slowest: { index: number; startupMs: number } | null;
};

/** 一次播放（一个 source.load 起）的最终结局。
 * unknown＝被下一次 load 打断且无卡死/降级/传输错误证据——无证据时
 * 不许推断「用户主动中止」（自查 C3：旧版一律洗成 aborted、系统性
 * 低估失败率），记 unknown、不入失败率；current＝最后一次尚无结论
 * 且无失败证据（真进行中）。有失败证据的最后一次定 failed，不许
 * 被「最后一段」身份盖成 current（自查 C5，fix2 A4 一并修）。 */
export type PlayOutcome = {
index: number;
outcome: "success" | "recovered" | "failed" | "unknown" | "current";
startupMs: number | null;
stalls: number;
fellBack: boolean;
};

export function analyzeFlow(entries: LogEntry[]): FlowResult | null {
const lastPid = entries.length? entries[entries.length - 1].pid: null;
const sessionEntries = lastPid == null? entries: entries.filter(e => e.pid === lastPid);
/* 流水与逐次共用同一套分段（fix2 A4）：旧版流水取全日志最后一次
 * load 起的 tail（不分进程/实例），逐次却按 pid 分段——同一份报告
 * 里 append 偏移可来自另一个实例，与 playing 互相打架（真机实锤：
 * 结论 90.1s vs 流水 playing 11688ms）。现统一：先按本进程
 * source.load 分段，流水只取最后一段，t0 同源。 */
const loadIdxsAll: number[] = [];
sessionEntries.forEach((e, i) => { if (e.event === "web.source.load") loadIdxsAll.push(i); });
if (!loadIdxsAll.length) return null;
const tail = sessionEntries.slice(loadIdxsAll[loadIdxsAll.length - 1]);
const t0 = tail[0].ts;
const stallEvents = sessionEntries.filter(e => e.event === "web.hls.append_stall");
const stalledThisSession = stallEvents.length > 0;
const fallbackThisSession = sessionEntries.some(e => e.event === "web.playback.fallback");
const stallCount = stallEvents.length;
/* attempt=0 的卡死触发了自愈重建、attempt=1 的触发了降级判定 */
const rebuildCount = stallEvents.filter(e => num(e.data.attempt) === 0).length;
const fallbackCount = sessionEntries.filter(e => e.event === "web.playback.fallback").length;
const lastStallState = stallEvents.length? str(stallEvents[stallEvents.length - 1].data.state) || null: null;
const demoteCount = sessionEntries.filter(e => e.event === "web.sr.perf_demote").length;
const lineSwitchCount = sessionEntries.filter(e => e.event === "web.line.pick" && e.data.switched === true).length;
const confirmPendingCount = sessionEntries.filter(e => e.event === "web.line.confirmPending").length;

/* 逐次播放切分（复审批 §6）：按 source.load 把本会话切成逐次播放，
 * 每次定一个结局（口径见 PlayOutcome）。起播耗时以首帧呈现
 * （media.first_frame）为准、无此信号回落 playing——playing 只是
 * 「能播」的代理判定，不冒充首帧（§6.2）。 */
const plays: PlayOutcome[] = [];
{
const loadIdxs = loadIdxsAll;
loadIdxs.forEach((li, k) => {
const seg = sessionEntries.slice(li, k + 1 < loadIdxs.length? loadIdxs[k + 1]: undefined);
const playingEv = seg.find(e => e.event === "web.media.playing");
const frameEv = seg.find(e => e.event === "web.media.first_frame");
const stalls = seg.filter(e => e.event === "web.hls.append_stall").length;
const fellBack = seg.some(e => e.event === "web.playback.fallback");
const hasError = seg.some(e => e.event === "web.source.transport_error");
const isLast = k === loadIdxs.length - 1;
let outcome: PlayOutcome["outcome"];
/* 结局判定序（fix2 A4 修自查 C5/C3）：失败证据优先于「最后一段」
 * 身份——旧序 isLast 先于 failed，真机刚失败完生成报告时那次失败
 * 恒被报成「进行中」；无证据中断记 unknown，不再推断主动中止。 */
if (playingEv || frameEv) outcome = stalls > 0? "recovered": "success";
else if (stalls > 0 || fellBack || hasError) outcome = "failed";
else if (isLast) outcome = "current";
else outcome = "unknown";
const startEv = frameEv?? playingEv;
plays.push({ index: k + 1, outcome, startupMs: startEv? Math.max(0, startEv.ts - seg[0].ts): null, stalls, fellBack });
});
}
const cleanPlays = plays.filter(p => p.outcome === "success" && p.startupMs!= null);
const cleanStarts = cleanPlays.map(p => p.startupMs as number).sort((a, b) => a - b);
const medianStartupMs = cleanStarts.length? cleanStarts[Math.floor(cleanStarts.length / 2)]: null;
const slowestPlay = cleanPlays.length? [...cleanPlays].sort((a, b) => (b.startupMs as number) - (a.startupMs as number))[0]: null;
const slowest = slowestPlay? { index: slowestPlay.index, startupMs: slowestPlay.startupMs as number }: null;

const reached = STAGES.map(stage => {
const hit = tail.find(e => stage.events.includes(e.event));
return {...stage, at: hit? hit.ts: null};
});
const furthestIdx = reached.reduce((acc, s, i) => (s.at!= null? i: acc), -1);
/* 阶段标记口径（2026-11-18 晚真机报告审计修正）：缺失阶段分两种——
   已越过它（更晚阶段已达）说明只是没记到该事件，标「— 未记录」，
   不打 ✗ 假警报（实测：出画成功仍报 resolve ✗）；真正卡点之后
   的阶段才标「✗ 未达」。playing 的偏移若远超起播尺度（>30s，多为
   加载后隔很久才起播/续播），只记成败不记 ms，避免 218081ms 这类
   数字被误读成起播耗时。起播耗时口径见下方 startupMs（fix2 A4）。 */
const parts = reached.map((s, i) => {
if (s.at == null) return `${s.label} ${i <= furthestIdx? "— 未记录": "✗ 未达"}`;
const off = Math.max(0, s.at - t0);
if (s.key === "playing" && off > 30000) return `${s.label} ✓`;
return `${s.label} ✓ ${off}ms`;
});
const furthest = [...reached].reverse().find(s => s.at!= null);
/* 起播耗时（fix2 A4 统一口径）：T0（本段 source.load）→T7（首帧
 * 呈现 first_frame），无首帧信号回落 playing 并标 basis；与逐次
 * 播放的 startupMs 同一定义。旧版结论行用 t0→buffered：buffered
 * 达标可远晚于首帧（如慢线下边播边缓冲），把 90s 级数字冒充起播
 * 与逐次的 11.7s 同报告打架，即此故。 */
const frameAt = reached.find(s => s.key === "first_frame")?.at?? null;
const playingAt = reached.find(s => s.key === "playing")?.at?? null;
const startupBasis: FlowResult["startupBasis"] = frameAt!= null? "first_frame": playingAt!= null? "playing": null;
const startupMs = startupBasis === "first_frame"? Math.max(0, (frameAt as number) - t0)
: startupBasis === "playing"? Math.max(0, (playingAt as number) - t0): null;
let verdict: string;
if (playingAt!= null || frameAt!= null) {
verdict = "最近播放已正常出画（playing）";
} else if (!furthest) {
verdict = "最近播放卡在起点（清单未达）";
} else if (furthest.key === "range") {
verdict = "最近播放卡在 append（分片已下载、未入缓冲——append 停滞签名）";
} else {
verdict = `最近播放卡在 ${furthest.label} 阶段`;
}
return { table: parts.join(" · "), verdict, startupMs, startupBasis, stalledThisSession, fallbackThisSession, stallCount, rebuildCount, fallbackCount, lastStallState, demoteCount, lineSwitchCount, confirmPendingCount, plays, medianStartupMs, slowest };
}

/* 看门狗四状态的人话标签：报告读者要一眼知道 append 死在哪一段。 */
const STALL_STATE_LABEL: Record<string, string> = {
"not-started": "append 未开始（队列没动）",
"append-hung": "append 处理中卡住",
"appended-no-buffer": "append 已结束但缓冲为空",
"buffered-no-play": "缓冲已增长但未出画",
};

export async function buildDiagnosticReport(): Promise<string> {
const [diagR, lineStateR, logR] = await Promise.allSettled([
api.netDiag(),
api.lineState(),
(async () => playbackLogApi.read())(),
]);

const diag = diagR.status === "fulfilled"? obj(diagR.value): {};
const lineState = lineStateR.status === "fulfilled"? obj(lineStateR.value): {};
const currentBase = str(lineState.base) || str(diag.base);
const currentHost = currentBase? hostOf(currentBase): "-";

/* 各固定线路延迟：用 line_probe（只测不切），候选 = 固定线路 + 当前线路。
   候选条数与不可达数单独计数入报告（2026-11-18 晚审计修正：原版只列
   当前一条时看不出是「共一条」还是「漏列」，选线现状行还写空话「见上」）。 */
let probeText = "未测（线路清单读取失败）";
let probeCount: number | null = null;
let probeDown: number | null = null;
if (lineStateR.status === "fulfilled") {
const fixed = Array.isArray(lineState.fixed)? lineState.fixed: [];
const urls = [...new Set(fixed.map(f => str(obj(f).url)).filter(Boolean).concat(currentBase? [currentBase]: []))].slice(0, 6);
if (urls.length) {
try {
const hits = await api.lineProbe(urls);
const list = Array.isArray(hits)? hits: [];
probeCount = list.length;
probeDown = list.filter(h => obj(h).ok!== true).length;
probeText = list.map(h => {
const hit = obj(h);
const name = hit.url === currentBase? `${hostOf(str(hit.url))}(当前)`: hostOf(str(hit.url));
return hit.ok === true? `${name} ${num(hit.ms)?? "?"}ms`: `${name} 不可达`;
}).join(" · ") || "无结果";
} catch {
probeText = "探测失败";
}
}
}

/* 当前线分片吞吐（net_diag.speed_ab：A=生产客户端 / B=裸客户端）。
* C 路（WebView fetch）自合并版起被 App 自家 CSP 恒拦，不再测。 */
const sab = obj(diag.speed_ab);
let speedText = "未测";
if (str(sab.error)) speedText = `失败（${str(sab.error)}）`;
else if (Object.keys(sab).length) {
const bytes = num(sab.bytes);
const mbps = (b: number | null, m: number | null) => (b!= null && m!= null && m > 0? `${(b / (m / 1000) / (1024 * 1024)).toFixed(1)} MB/s`: "—");
/* A=经 App 客户端栈（含代理环境）/ B=裸直连：双路分歧本身是诊断信号
   （A 慢 B 快=客户端/代理问题，双慢=线路/网络问题），保留双值但用
   人话标签（2026-11-18 晚审计修正：原「A 路/B 路」为内部术语）。 */
speedText = `App 通道 ${mbps(bytes, num(sab.a_ms))} · 直连 ${mbps(num(sab.b_bytes)?? bytes, num(sab.b_ms))}`;
}

const entries = logR.status === "fulfilled"? parseLog(String(logR.value?? "")): [];
const flow = entries.length? analyzeFlow(entries): null;
/* 日志状态明示（2026-11-18 终版加固）：读取失败/日志为空与「没播过」
 * 是三回事——旧实现一律显示「无最近播放记录」，真机出现过在播却零
 * 记录时误导判读。报告必须能自证记录通道是否活着。 */
const logReadFailed = logR.status !== "fulfilled";
const logEmpty = !logReadFailed && entries.length === 0;
const fallback = nativeFallbackState();
const facts = readPlaybackFacts();

const lines: string[] = [];
lines.push(`${new Date().toLocaleString("zh-CN", { hour12: false})}`);
/* 构建戳 + 账本完整性（Muse 2026-11-18 U6a/U6b）：报告头自证构建与
 * 会话。账本是纯旁路——读取失败只降级这一行为「未知」，不拖垮报告
 * 其余内容（下方 try/catch 即回退路径）。 */
lines.push(`构建：${BUILD_STAMP}`);
try {
const snap = ledgerSnapshot();
lines.push(`会话：${snap.sessionId} · 账本 已记 ${snap.recorded} · 迟到丢弃 ${snap.droppedLate}`);
} catch {
lines.push("会话：未知（事件账本不可用）");
}
lines.push("");
lines.push("── 结论 ──────────────────────────");
lines.push(`网络：${diagR.status === "fulfilled"? shortVerdict(diag): "诊断失败（net_diag 不可用）"}`);
lines.push(`当前线路：${currentHost}（自动选线 ${autoLineEnabled()? "开": "关"}）`);
lines.push(`各线延迟${probeCount!= null? `（候选 ${probeCount} 条）`: ""}：${probeText}`);
lines.push(`分片吞吐：${speedText}`);
/* 起播数字后标注信号来源（fix2 A4）：playing 代理回落要让读者知道
 * 这不是首帧实测；首帧与 playing 皆缺时明说统计不完整，不编数。 */
const startupNote = flow == null || flow.startupMs == null
? (flow && flow.plays.length? " · 起播统计不完整（缺首帧/playing 信号）": "")
: ` · 起播约 ${(flow.startupMs / 1000).toFixed(1)}s${flow.startupBasis === "playing"? "（以 playing 代首帧）": ""}`;
lines.push(`最近播放：${logReadFailed? "未知（诊断日志读取失败）": logEmpty? "未知（诊断日志为空——记录未启动或未写入）": flow? `${flow.verdict}${startupNote}`: "无最近播放记录"}`);
/* 本会话逐次汇总（复审批 §6）：只看最近一次会把前面的失败藏掉——
 * 频繁切换的用户要先看全会话的成败分布。unknown（未定性中断）单列、
 * 不算失败；起播中位/最慢只取干净出画，恢复耗时不混入。 */
if (flow && flow.plays.length > 1) {
const n = (o: PlayOutcome["outcome"]) => flow.plays.filter(p => p.outcome === o).length;
const bits = [`共 ${flow.plays.length} 次`, `出画 ${n("success")}`];
if (n("recovered") > 0) bits.push(`卡死后出画 ${n("recovered")}`);
if (n("failed") > 0) bits.push(`未能出画 ${n("failed")}`);
if (n("unknown") > 0) bits.push(`未定性中断 ${n("unknown")}`);
if (n("current") > 0) bits.push("进行中 1");
if (flow.medianStartupMs!= null) bits.push(`起播中位 ${(flow.medianStartupMs / 1000).toFixed(1)}s`);
if (flow.slowest) bits.push(`最慢 ${(flow.slowest.startupMs / 1000).toFixed(1)}s（#${flow.slowest.index}）`);
lines.push(`本会话播放：${bits.join(" · ")}`);
}
const healCounts = flow && flow.stallCount > 0? `（本会话卡死 ${flow.stallCount} 次 · 自愈重建 ${flow.rebuildCount} 次 · 降级 ${flow.fallbackCount} 次 · 最近卡死形态：${flow.lastStallState? STALL_STATE_LABEL[flow.lastStallState] ?? flow.lastStallState: "未记录"}）`: "";
if (fallback || flow?.fallbackThisSession) lines.push(`会话降级：本会话已降级原生播放（append 停滞）${healCounts}`);
else if (flow?.stalledThisSession) lines.push(`会话降级：发生过 append 卡死、已自愈重建（未降级）${healCounts}`);
else lines.push("会话降级：未发生");
/* 镜像覆盖（整改 2）：复用最近一轮自动选线的探测结果（10 分钟内），
 * 不为生成报告重测；无近期轮次时只报固定+当前延迟（上方各线延迟行）。
 * 原口径只有固定+当前 ≤6 条，与自动选线实际候选规模对不上，用户会
 * 误判「只发现一条线路」。 */
const round = lastPickRound();
if (round && Date.now() - round.at < 10 * 60_000) {
const measuredText = round.measured.length
? round.measured.map(m => `${m.host} ${m.kbps != null? `${(m.kbps / 8000).toFixed(1)} MB/s`: "吞吐未测"}·${m.ms}ms`).join(" · ")
: "无";
lines.push(`镜像覆盖（${Math.max(0, Math.round((Date.now() - round.at) / 1000))} 秒前选线轮次）：发布 ${round.published?? "?"} 条 · 探测 ${round.probed?? "?"} 条（可达 ${round.okCount?? "?"}） · 吞吐实测 ${round.measured.length} 条：${measuredText}`);
}
lines.push("");
lines.push("── 硬数据 ────────────────────────");
const rt = obj(diag.runtime);
const osText = [str(rt.os), str(rt.arch)].filter(Boolean).join(" ") || platform;
/* iOS 版本对本 App 的播放故障定性是关键变量（27.3 beta 的 MMS 停滞
   签名）。原从 WebView UA 解析是错的：UA 的 OS 号在新系统上被冻结，
   真机 27.3 beta 自报 18.7（2026-11-18 真机实锤）。改用 net_diag
   runtime.os_ver（Rust 侧 UIDevice.systemVersion 直读）；读不到就
   省略，不拿 UA 假数充数。 */
const osVer = str(rt.os_ver);
const iosText = osVer? ` · iOS ${osVer}`: "";
lines.push(`App 版本：${APP_VERSION} · 平台：${osText}${iosText}`);
if (facts) {
const kbps = facts.bitrateBps? Math.round(facts.bitrateBps / 1000): null;
const bpp = facts.bitrateBps && facts.w > 0 && facts.h > 0
? (facts.bitrateBps / (facts.w * facts.h) / (facts.fps && facts.fps > 0? facts.fps: 30)).toFixed(3)
: null;
/* 码率未知必须显式写「未知」不静默省略（仓库不变量：未知不是空）——
   码率缺失时超分密度判据无从复核，报告要让读者看见这个缺口。编码
   同理入报告：超分阈值按编码族缩放（整改 4），无编码无从复核判档。 */
const codecText = facts.codec? ` · 编码 ${facts.codec.split(".")[0]}`: " · 编码 未知";
/* 帧率单列（复审批 §5.4）：编码已知/fps 未知/两者皆未知是三种状态，
 * 帧成本预算与封顶判档都挂在 fps 上，不能塌缩进「编码未知」一格。 */
const fpsText = facts.fps? ` · 帧率 ${facts.fps}fps`: " · 帧率 未知";
lines.push(`当前集源：${facts.w}x${facts.h}${codecText}${fpsText}${kbps? ` · 码率 ${kbps} kbps`: " · 码率 未知"}${bpp? ` · 密度 bpp ${bpp}`: ""} · 超分档位 ${facts.srMode}${facts.engine? ` · 引擎 ${facts.engine}`: ""}`);
} else {
lines.push("当前集源：无（尚未播放）");
}
if (flow && flow.demoteCount > 0) lines.push(`超分降档：本会话 ${flow.demoteCount} 次（帧成本超标自动降档——发热/功耗问题先看这个数）`);
lines.push(`选线现状：当前 ${currentHost}${round && Date.now() - round.at < 10 * 60_000? `；最近轮次探测 ${round.probed?? "?"} 条、可达 ${round.okCount?? "?"} 条`: probeCount!= null? `；固定+当前探测 ${probeCount} 条、不可达 ${probeDown?? 0} 条`: ""}${flow? `；本会话切线 ${flow.lineSwitchCount} 次${flow.confirmPendingCount > 0? ` · 两轮确认待确认 ${flow.confirmPendingCount} 次`: ""}`: ""}`);
lines.push("");
lines.push("── 最近一次播放流水 ──────────────");
lines.push(flow? flow.table: logReadFailed? "（诊断日志读取失败——本次无法提供播放流水）": logEmpty? "（诊断日志为空——记录可能未成功开启）": "（无记录）");
/* 此前异常摘要（复审批 §6.5）：只列出过事的播放（卡死后出画/未能
 * 出画），全顺时不占篇幅；诊断要找的是「哪一次出的事」，不是流水账。 */
if (flow && flow.plays.length > 1) {
const anomalies = flow.plays.slice(0, -1).filter(p => p.outcome === "failed" || p.outcome === "recovered").slice(-4).reverse();
for (const p of anomalies) {
const bits = [p.outcome === "failed"? "未能出画": "卡死后出画"];
if (p.stalls > 0) bits.push(`卡死 ${p.stalls} 次`);
if (p.fellBack) bits.push("已降级原生");
if (p.startupMs!= null) bits.push(`总耗时 ${(p.startupMs / 1000).toFixed(1)}s`);
lines.push(`此前播放 #${p.index}：${bits.join(" · ")}`);
}
}
lines.push("");
lines.push("── WebGPU 探针 ───────────────────");
/* WebGPU 探针（Muse 2026-11-18 U3）：只读会话内后台自动探针的缓存
 * 结果，报告生成不在此现跑（探针时机见 gpuProbe.scheduleGpuProbe）。
 * 纯旁路：读缓存失败只降级本节，不拖垮报告其余内容。 */
try {
for (const l of formatGpuProbeLines(getCachedGpuProbe())) lines.push(l);
} catch {
lines.push("读取失败（纯旁路，不影响本报告其余内容）");
}
return lines.join("\n");
}
