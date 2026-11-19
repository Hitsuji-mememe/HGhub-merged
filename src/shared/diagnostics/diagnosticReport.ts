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
import { autoLineEnabled, lastPickRound, recentPickRounds} from "../network/autoLine";
import { nativeFallbackState} from "../../features/playback/mediaTransport";
import { flushPlaybackLog, playbackLogApi} from "./playbackDiagnostics";
import { ledgerPlaybackEvidence, selectFlowSegment } from "./flowSegments";
import { readPlaybackFacts, type PlaybackFacts } from "./playbackFacts";
import { formatLevelFactsLine } from "./levelFacts";
import { shortVerdict} from "./netDiagReport";
import { snapshot as ledgerSnapshot, validateLedgerIntegrity} from "./eventLedger";
import { sourceRegistryVersion, sourceHealthLines } from "./sourceRegistry";
import { cacheCountersSnapshot } from "../../features/feed/cacheMap";
import { formatSrProductionLines, formatSrProbeLines, getSrProductionStats, getSrProbeResult } from "./gpuProbe";
import { summarizeHoldEvents } from "../../features/feed/holdJank";
import { feedTraceSnapshot, feedTraceSummary} from "../lib/feedTrace";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" &&!Array.isArray(v)? (v as Json): {});
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v)? v: null);
const str = (v: unknown): string => (typeof v === "string"? v: "");

type LogEntry = { event: string; ts: number; pid: number | null; data: Json;
/** 事件自带单调钟（data.mono_ms，前端 performance.now）：阶段计时
 * 优先用它（Muse 2026-11-19 整改 C3）——raw.ts 是 Rust 写盘时刻，
 * 前端 250ms 批量 flush 会把同批阶段压成 ≈0、耗时记到下一批。 */
mono: number | null};

function parseLog(text: string): LogEntry[] {
const out: LogEntry[] = [];
for (const line of text.split("\n")) {
const trimmed = line.trim();
if (!trimmed.startsWith("{")) continue;
try {
const raw = JSON.parse(trimmed) as Json;
const ts = Date.parse(str(raw.ts));
const data = obj(raw.data);
out.push({
event: str(raw.event),
ts: Number.isFinite(ts)? ts: 0,
pid: num(raw.pid),
data,
mono: num(data.mono_ms)?? num(raw.mono_ms),
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
/** 本会话全部逐次起播（有 startupMs 者）的 P50/P90（audit6 诊断节）。 */
startupP50: number | null;
startupP90: number | null;
/** 最近一段已达阶段的偏移序列（STAGES 序、仅已达者）：口径自检的
 * 单调性判据数据源。 */
stageOffsets: number[];
/** 最近一段相邻已达阶段的增量串（慢环定位）。 */
stageIncrements: string;
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
/* 选段（Muse 2026-11-19 3.2.1修复F3b线）：旧口径只取最后一行 pid
 * 的段——读到窗口的尾段 pid 不是当前播放段时（轮转/导出裁剪/debug
 * 行混入），段内无 source.load 即整体返回 null、报告假报「无记
 * 录」，与同窗完整播放段和账本 media.playing 打架（3.2.0 第二份真
 * 机诊断实锤）。现经 selectFlowSegment 取最新含 load 的段；全窗无
 * load 时回落最后 pid 段（仍为 null），由报告层结合账本证据明示
 * 通道状态。回归见 fix321-f3b-diagnostic-summary.contract.test.ts。 */
const sessionEntries = selectFlowSegment(entries);
/* 流水与逐次共用同一套分段（fix2 A4）：旧版流水取全日志最后一次
 * load 起的 tail（不分进程/实例），逐次却按 pid 分段——同一份报告
 * 里 append 偏移可来自另一个实例，与 playing 互相打架（真机实锤：
 * 结论 90.1s vs 流水 playing 11688ms）。现统一：先按本进程
 * source.load 分段，流水只取最后一段，t0 同源。 */
const loadIdxsAll: number[] = [];
sessionEntries.forEach((e, i) => { if (e.event === "web.source.load") loadIdxsAll.push(i); });
if (!loadIdxsAll.length) return null;
/* 阶段偏移（整改 C3）：同实例内 mono_ms 存在时用单调钟差，缺失回落
 * 写盘 ts 差——两种钟不混算（mono 是 performance.now、ts 是墙钟）。 */
const offOf = (e: LogEntry, base: LogEntry): number =>
e.mono!= null && base.mono!= null? e.mono - base.mono: e.ts - base.ts;
/* resolve 归段（整改 C4）：play.resolve 在 source.load 之前发出且不带
 * player（Feed 口径），分段组装时把同条目紧邻在前的 resolve（上一段
 * load 之后、本段 load 之前）归入本次起播，否则 resolve 阶段恒缺。 */
const preResolveOf = (loadIdx: number): LogEntry[] => {
const prev = loadIdxsAll.filter(i => i < loadIdx).pop();
const gap = sessionEntries.slice(prev == null? 0: prev + 1, loadIdx);
const resolves = gap.filter(e => e.event === "web.play.resolve");
return resolves.length? [resolves[resolves.length - 1]]: [];
};
const lastLoadIdx = loadIdxsAll[loadIdxsAll.length - 1];
const tailAll = [...preResolveOf(lastLoadIdx), ...sessionEntries.slice(lastLoadIdx)];
const tailPlayer = str(sessionEntries[lastLoadIdx].data.player);
/* player 过滤（整改 C4）：str() 对缺失字段返回 ""，旧判 pl == null
 * 永不成立、无 player 的系统事件被误删——"" 归一为无 player 保留。 */
const tail = tailPlayer? tailAll.filter(e => { const pl = str(e.data.player); return pl === "" || pl === tailPlayer; }): tailAll;
const tailBase = sessionEntries[lastLoadIdx];
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
/* (playerInstanceId) 隔离（Muse 2026-11-19 根治包，audit6 诊断节）：
 * pid 隔离之外再按日志 data.player 过滤本段——双播放器并发时另一
 * 实例的事件不混入本段结局判定；无 player 的系统事件保留。 */
const segLoad = sessionEntries[li];
const segAll = [...preResolveOf(li), ...sessionEntries.slice(li, k + 1 < loadIdxs.length? loadIdxs[k + 1]: undefined)];
const segPlayer = str(segLoad.data.player);
const seg = segPlayer? segAll.filter(e => { const pl = str(e.data.player); return pl === "" || pl === segPlayer; }): segAll;
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
plays.push({ index: k + 1, outcome, startupMs: startEv? Math.max(0, offOf(startEv, segLoad)): null, stalls, fellBack });
});
}
const cleanPlays = plays.filter(p => p.outcome === "success" && p.startupMs!= null);
const cleanStarts = cleanPlays.map(p => p.startupMs as number).sort((a, b) => a - b);
const medianStartupMs = cleanStarts.length? cleanStarts[Math.floor(cleanStarts.length / 2)]: null;
const slowestPlay = cleanPlays.length? [...cleanPlays].sort((a, b) => (b.startupMs as number) - (a.startupMs as number))[0]: null;
const slowest = slowestPlay? { index: slowestPlay.index, startupMs: slowestPlay.startupMs as number }: null;

const reached = STAGES.map(stage => {
const hit = tail.find(e => stage.events.includes(e.event));
return {...stage, off: hit? Math.max(0, offOf(hit, tailBase)): null};
});
const furthestIdx = reached.reduce((acc, s, i) => (s.off!= null? i: acc), -1);
/* 阶段标记口径（2026-11-18 晚真机报告审计修正）：缺失阶段分两种——
   已越过它（更晚阶段已达）说明只是没记到该事件，标「— 未记录」，
   不打 ✗ 假警报（实测：出画成功仍报 resolve ✗）；真正卡点之后
   的阶段才标「✗ 未达」。playing 的偏移若远超起播尺度（>30s，多为
   加载后隔很久才起播/续播），只记成败不记 ms，避免 218081ms 这类
   数字被误读成起播耗时。起播耗时口径见下方 startupMs（fix2 A4）。 */
const parts = reached.map((s, i) => {
if (s.off == null) return `${s.label} ${i <= furthestIdx? "— 未记录": "✗ 未达"}`;
const off = s.off;
if (s.key === "playing" && off > 30000) return `${s.label} ✓`;
return `${s.label} ✓ ${off}ms`;
});
const furthest = [...reached].reverse().find(s => s.off!= null);
/* 起播耗时（fix2 A4 统一口径）：T0（本段 source.load）→T7（首帧
 * 呈现 first_frame），无首帧信号回落 playing 并标 basis；与逐次
 * 播放的 startupMs 同一定义。旧版结论行用 t0→buffered：buffered
 * 达标可远晚于首帧（如慢线下边播边缓冲），把 90s 级数字冒充起播
 * 与逐次的 11.7s 同报告打架，即此故。 */
const frameAt = reached.find(s => s.key === "first_frame")?.off?? null;
const playingAt = reached.find(s => s.key === "playing")?.off?? null;
const startupBasis: FlowResult["startupBasis"] = frameAt!= null? "first_frame": playingAt!= null? "playing": null;
const startupMs = startupBasis === "first_frame"? frameAt
: startupBasis === "playing"? playingAt: null;
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
const allStarts = plays.map(p => p.startupMs).filter((v): v is number => v!= null).sort((a, b) => a - b);
const pctile = (q: number) => allStarts.length? allStarts[Math.min(allStarts.length - 1, Math.floor(q * allStarts.length))]: null;
const reachedOffs = reached.filter(r => r.off!= null).map(r => ({ label: r.label, off: r.off as number }));
const stageIncrements = reachedOffs.map((r, i) => i === 0? `${r.label} +${r.off}ms`: `${r.label} +${r.off - reachedOffs[i - 1].off}ms`).join(" · ");
return { table: parts.join(" · "), verdict, startupMs, startupBasis, stalledThisSession, fallbackThisSession, stallCount, rebuildCount, fallbackCount, lastStallState, demoteCount, lineSwitchCount, confirmPendingCount, plays, medianStartupMs, slowest, startupP50: pctile(0.5), startupP90: pctile(0.9), stageOffsets: reachedOffs.map(r => r.off), stageIncrements };
}

/* 看门狗四状态的人话标签：报告读者要一眼知道 append 死在哪一段。 */
const STALL_STATE_LABEL: Record<string, string> = {
"not-started": "append 未开始（队列没动）",
"append-hung": "append 处理中卡住",
"appended-no-buffer": "append 已结束但缓冲为空",
"buffered-no-play": "缓冲已增长但未出画",
};

/* ── 口径自检（Muse 2026-11-19 根治包，audit6 诊断节）──
 * 报告生成时先跑自洽断言：不过则在报告顶部印「口径自检未过：X」，
 * 防止口径漂移的报告被当成事实发出去。检查项：①起播阶段时间戳单调；
 * ②超分判档与实际管线成对出现；③有播放事实但账本零实例事件＝接线
 * 缺失；④账本序号缺口/重复为零。 */
export function diagnosticSelfChecks(facts: PlaybackFacts | null, flow: FlowResult | null): string[] {
  const fails: string[] = [];
  if (flow) {
    const offs = flow.stageOffsets;
    for (let i = 1; i < offs.length; i++) {
      if (offs[i] < offs[i - 1]) { fails.push("最近播放起播阶段时间戳非单调"); break; }
    }
  }
  if (facts?.srMode && !facts.pipeline) fails.push("超分判档与实际管线未成对出现");
  const snap = ledgerSnapshot();
  const integ = validateLedgerIntegrity(snap);
  /* ③④换真判据（Muse 2026-11-19 整改 C8，G4 P2-1）：旧③依赖恒 0
   * 的 droppedLate、旧④查单线程单调计数器的序号缺口/重复，两项都
   * 结构性恒过。现③＝有当前播放事实（playbackFacts）但账本内无任何
   * media 事件 → 接线缺失（真机会失败：镜像断线时 facts 仍在发布）；
   * ④＝账本计数对齐：recorded 必须等于保留窗口条数＋窗口外截断数，
   * 且与导出尾段条数口径一致，对不上即账本自洽性破裂。 */
  if (facts && !snap.events.some(e => e.name.startsWith("media."))) {
    fails.push("有当前播放事实但账本内无 media 事件（账本接线缺失）");
  }
  if (snap.recorded !== snap.events.length + integ.truncated) {
    fails.push(`事件账本计数不对齐（已记 ${snap.recorded} ≠ 窗口 ${snap.events.length} + 截断 ${integ.truncated}）`);
  }
  return fails;
}

/* ── 导出 ID 化辅助（Muse 2026-11-19 整改 C8）──────────────────
 * 频道稳定编号：channel-01=ai-duanju（剧集频道）、channel-02=
 * original（主内容频道）——两频道数据源不同、不得合并（主代理裁定）。 */
export function channelLabel(list: string): string {
  if (list.includes("ai-duanju")) return "channel-01（剧集频道）";
  if (list.includes("original")) return "channel-02（主内容频道）";
  return list;
}

/* 最近一次报告构建时的线路 host→编号映射，供导出尾段替换复用。 */
let lastLineIdByHost = new Map<string, string>();

/* 通用域名 TLD 白名单：点分事件名（web.media.playing 等）与文件名
 * 不在此列，不会被误伤；真实 host 的 TLD 覆盖常见集合。 */
const GENERIC_TLDS = new Set(["com", "net", "org", "io", "tv", "me", "co", "cn", "ai", "app", "dev", "xyz", "cc", "live", "to", "info", "site", "online", "club", "vip", "pro", "gg", "invalid", "local"]);

/** 导出文本 host 替换：先用已知映射（线路编号）替换，再把残余的
 * 域名形 token（尾段 TLD 在白名单内）按首现顺序编号为 host-NN——
 * 保证日志尾/事件尾不带任何域名出门。源业务名不在此处理（源段已
 * 在 registryDiag 层 ID 化，日志尾只含 host）。 */
export function redactExportText(text: string, known: Map<string, string>): string {
  let out = text;
  for (const [host, id] of known) {
    if (!host) continue;
    out = out.split(host).join(id);
  }
  out = out.replace(/ai-duanju/g, "channel-01").replace(/original/g, "channel-02");
  const generic = new Map<string, string>();
  let seq = 0;
  out = out.replace(/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, (m) => {
    const tld = m.split(".").pop()?.toLowerCase() ?? "";
    if (!GENERIC_TLDS.has(tld)) return m;
    const hit = generic.get(m);
    if (hit) return hit;
    const id = `host-${String(++seq).padStart(2, "0")}`;
    generic.set(m, id);
    return id;
  });
  return out;
}

/* ── 一键导出补全（audit6 诊断节）：报告＋日志尾＋探针结果＋源注册表
 * 版本。Settings 的诊断入口生成与复制都走这里（既有契约：复制内容
 * 与预览全文一致，故生成即全量、预览即全文）。 */
export async function buildFullDiagnosticExport(): Promise<string> {
  const report = await buildDiagnosticReport();
  let logTail = "（日志读取失败）";
  try {
    /* 读前 flush（F3b 线，同 buildDiagnosticReport）：日志尾必须是
     * 含写队列在内的当前记录，不许是未落盘前的过期快照。 */
    await flushPlaybackLog();
    const raw = await playbackLogApi.read();
    logTail = raw ? raw.slice(-8000) : "（暂无日志）";
  } catch { /* 保持失败文案 */ }
  /* 日志尾先过 host→编号替换再附（整改 C8）：映射来自账本 origin/
   * 当前 base/固定线路（lastLineIdByHost），残余域名走通用编号。 */
  logTail = redactExportText(logTail, lastLineIdByHost);
  const probe = getSrProbeResult();
  /* 账本事件本体进导出（diag-audit #3）：尾段印最近 64 条的
   * seq/ts/instanceId/generation/事件名，同样过 host 替换。 */
  let ledgerTail = "（账本不可用）";
  try {
    const snap = ledgerSnapshot();
    ledgerTail = snap.events.length
      ? snap.events.slice(-64).map(e => {
          const gen = e.data && typeof e.data === "object" ? (e.data as Json).generation : undefined;
          return `#${e.seq} ${e.ts} ${e.instanceId ?? "-"} gen=${gen ?? "-"} ${e.name}`;
        }).join("\n")
      : "（账本暂无事件）";
  } catch { /* 保持失败文案 */ }
  ledgerTail = redactExportText(ledgerTail, lastLineIdByHost);
  const parts = [
    report,
    "",
    "══ 探针结果（JSON） ══",
    probe ? JSON.stringify(probe, null, 2) : "（无探针结果）",
    "",
    "══ 账本事件（尾 64 条） ══",
    ledgerTail,
    "",
    "══ 播放日志（尾 8000 字符） ══",
    logTail,
  ];
  return parts.join("\n");
}

export async function buildDiagnosticReport(): Promise<string> {
/* 读日志前先 flush 写队列（Muse 2026-11-19 3.2.1修复F3b线）：
 * tracePlayback 是 250ms 批量落盘，报告直接 read 会读到未含最近
 * 事件的过期快照——当前播放段可能整段还在队列里。copyPlaybackLog
 * 一直是 flush 后读，报告侧此前漏了这一步。flush 失败不挡报告，
 * 后续读取按既有降级口径走。 */
await flushPlaybackLog().catch(() => { /* 降级：按读取结果如实明示 */ });
const [diagR, lineStateR, logR, proxyStateR] = await Promise.allSettled([
api.netDiag(),
api.lineState(),
(async () => playbackLogApi.read())(),
api.proxyState(),
]);

const diag = diagR.status === "fulfilled"? obj(diagR.value): {};
const lineState = lineStateR.status === "fulfilled"? obj(lineStateR.value): {};
const currentBase = str(lineState.base) || str(diag.base);
/* 线路稳定编号（Muse 2026-11-19 整改 C8）：按账本顺序 line-01…，
 * 其后当前线路、固定线路、探测结果按遇序补号；导出全文以编号代
 * host（零域名口径）。映射同时存入模块级 lastLineIdByHost，供一键
 * 导出的日志尾 host 替换复用。 */
const lineIdByHost = new Map<string, string>();
let lineSeq = 0;
const lineIdFor = (urlOrHost: string): string => {
const host = hostOf(urlOrHost);
const hit = lineIdByHost.get(host);
if (hit) return hit;
const id = `line-${String(++lineSeq).padStart(2, "0")}`;
lineIdByHost.set(host, id);
return id;
};
for (const e of (Array.isArray(lineState.ledger)? lineState.ledger.map(obj): [])) {
const origin = str(e.origin);
if (origin) lineIdFor(origin);
}
const currentLineId = currentBase? lineIdFor(currentBase): null;
lastLineIdByHost = lineIdByHost;

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
const name = hit.url === currentBase? `${lineIdFor(str(hit.url))}(当前)`: lineIdFor(str(hit.url));
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
const pidSegmentCount = new Set(entries.map(e => e.pid).filter(p => p != null)).size;
const flow = entries.length? analyzeFlow(entries): null;
/* 日志状态明示（2026-11-18 终版加固）：读取失败/日志为空与「没播过」
 * 是三回事——旧实现一律显示「无最近播放记录」，真机出现过在播却零
 * 记录时误导判读。报告必须能自证记录通道是否活着。 */
const logReadFailed = logR.status !== "fulfilled";
const logEmpty = !logReadFailed && entries.length === 0;
/* 账本交叉核对（Muse 2026-11-19 3.2.1修复F3b线）：播放事实在日志
 * 与账本两套存储都有记录，汇总不许只因日志一侧无完整段就报「无记
 * 录」——flow 为空时先看账本证据：账本有播放则结论/流水/降级三处
 * 按日志状态明示体系写清通道状态（日志无完整播放段），账本也无
 * 播放才成立「无最近播放记录」。账本读取失败只降级本核对（证据
 * 按无计），不拖垮报告。 */
let ledgerEvidence = { hasPlayback: false, stallCount: 0 };
try { ledgerEvidence = ledgerPlaybackEvidence(ledgerSnapshot().events); } catch { /* 证据缺失按无计 */ }
const flowMissingButPlaying = flow == null && !logReadFailed && !logEmpty && ledgerEvidence.hasPlayback;
const fallback = nativeFallbackState();
const facts = readPlaybackFacts();

const lines: string[] = [];
lines.push(`${new Date().toLocaleString("zh-CN", { hour12: false})}`);
/* 构建戳 + 账本完整性（Muse 2026-11-18 U6a/U6b）：报告头自证构建与
 * 会话。账本是纯旁路——读取失败只降级这一行为「未知」，不拖垮报告
 * 其余内容（下方 try/catch 即回退路径）。 */
lines.push(`构建：${BUILD_STAMP}`);
/* 诊断原则（Muse 2026-11-19 根治包·飞行记录仪收口，用户定版；
 * 2026-11-19 最终版 E 线按 diag-audit 口径修正）：本报告为未知问题
 * 回溯而建，不是已知问题清单。不存在单一「统一时间线」存储——
 * 本报告是多存储拼装：播放日志文件／事件账本／Feed 追踪／选线
 * 近轮／Rust 即时探测／取页健康／播放事实快照，各存储留存与淘汰
 * 口径不同、事件间无全局关联 ID，跨存储只能靠时间戳对齐。原则入
 * 报告头，让读者按此口径判读覆盖面与缺口。 */
/* 报告头口径（整改 C8，G4 P2-5）：不把目标写成现状——已接入与未
 * 接入如实分列（据 diag-audit-20261119 接入矩阵）。 */
lines.push("诊断原则：全量飞行记录仪（目标）——本报告无单一统一时间线存储，系多存储拼装（播放日志文件／事件账本／Feed 追踪／选线近轮／Rust 即时探测／取页健康／播放事实快照），跨存储靠时间戳对齐；已接入：播放/选线/超分/Feed 分页与封面/缓存计数/网络（生成时现跑探测）/错误；未接入：源取页观测链（无触发者，见源总览三态）、账号会话生命周期事件、注册表变更事件。覆盖面按此判读，不把目标当现状。");
try {
const snap = ledgerSnapshot();
const integrity = validateLedgerIntegrity(snap);
lines.push(`会话：${snap.sessionId} · 账本 已记 ${snap.recorded} · 迟到丢弃 ${snap.droppedLate} · 完整性 缺口 ${integrity.seqGaps} / 重复 ${integrity.seqDuplicates} / 窗口外截断 ${integrity.truncated}`);
/* 留存范围明示（飞行记录仪收口）：读者须知道这份导出覆盖到哪、
 * 窗口之外还有什么——账本本会话 512 条滚动、播放日志 2MB 轮转
 * （含上一进程段尾段）、内存计数类进程重启清零。 */
lines.push(`留存范围：播放日志共 ${entries.length} 条 · ${pidSegmentCount} 个进程段（流水/逐次只分析最近一段，上一会话尾段在日志文件内）；事件账本保留本会话最近 512 条（窗口外截断 ${integrity.truncated} 条）；取页健康/缓存计数/选线近轮为本会话内存记录，进程重启清零`);
} catch {
lines.push("会话：未知（事件账本不可用）");
}
/* 口径自检置顶（不过先印）：读者第一眼就知道这份口径可不可信。 */
{
const scFails = diagnosticSelfChecks(facts, flow);
if (scFails.length) lines.push(`口径自检未过：${scFails.join("；")}`);
}
lines.push("");
lines.push("── 结论 ──────────────────────────");
lines.push(`网络：${diagR.status === "fulfilled"? shortVerdict(diag): "诊断失败（net_diag 不可用）"}`);
lines.push(`当前线路：${currentLineId?? "未知（无当前线路）"}（自动选线 ${autoLineEnabled()? "开": "关"}）`);
lines.push(`各线延迟${probeCount!= null? `（候选 ${probeCount} 条）`: ""}：${probeText}`);
lines.push(`分片吞吐：${speedText}`);
/* 起播数字后标注信号来源（fix2 A4）：playing 代理回落要让读者知道
 * 这不是首帧实测；首帧与 playing 皆缺时明说统计不完整，不编数。 */
const startupNote = flow == null || flow.startupMs == null
? (flow && flow.plays.length? " · 起播统计不完整（缺首帧/playing 信号）": "")
: ` · 起播约 ${(flow.startupMs / 1000).toFixed(1)}s${flow.startupBasis === "playing"? "（以 playing 代首帧）": ""}`;
lines.push(`最近播放：${logReadFailed? "未知（诊断日志读取失败）": logEmpty? "未知（诊断日志为空——记录未启动或未写入）": flow? `${flow.verdict}${startupNote}`: flowMissingButPlaying? "未知（诊断日志无完整播放段——事件账本显示本会话有播放，流水通道与账本不一致）": "无最近播放记录"}`);
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
if (flow.startupP50!= null) bits.push(`起播 P50 ${(flow.startupP50 / 1000).toFixed(1)}s · P90 ${((flow.startupP90?? 0) / 1000).toFixed(1)}s`);
if (flow.medianStartupMs!= null) bits.push(`干净起播中位 ${(flow.medianStartupMs / 1000).toFixed(1)}s`);
if (flow.slowest) bits.push(`最慢 ${(flow.slowest.startupMs / 1000).toFixed(1)}s（#${flow.slowest.index}）`);
lines.push(`本会话播放：${bits.join(" · ")}`);
}
const healCounts = flow && flow.stallCount > 0? `（本会话卡死 ${flow.stallCount} 次 · 自愈重建 ${flow.rebuildCount} 次 · 降级 ${flow.fallbackCount} 次 · 最近卡死形态：${flow.lastStallState? STALL_STATE_LABEL[flow.lastStallState] ?? flow.lastStallState: "未记录"}）`: "";
if (fallback || flow?.fallbackThisSession) lines.push(`会话降级：本会话已降级原生播放（append 停滞）${healCounts}`);
else if (flow?.stalledThisSession) lines.push(`会话降级：发生过 append 卡死、已自愈重建（未降级）${healCounts}`);
/* 日志无完整段时降级结论改认账本卡死计数（F3b 线）：不许在账本明明
 * 有 append 卡死时报「未发生」；账本亦无卡死且原生降级态为假，
 * 「未发生」才有两套存储共同支撑。 */
else if (flowMissingButPlaying && ledgerEvidence.stallCount > 0) lines.push(`会话降级：发生过 append 卡死、已自愈重建（未降级）（本会话卡死 ${ledgerEvidence.stallCount} 次——据事件账本，诊断日志无完整播放段）`);
else lines.push("会话降级：未发生");
/* 镜像覆盖（整改 2）：复用最近一轮自动选线的探测结果（10 分钟内），
 * 不为生成报告重测；无近期轮次时只报固定+当前延迟（上方各线延迟行）。
 * 原口径只有固定+当前 ≤6 条，与自动选线实际候选规模对不上，用户会
 * 误判「只发现一条线路」。 */
const round = lastPickRound();
if (round && Date.now() - round.at < 10 * 60_000) {
const measuredText = round.measured.length
? round.measured.map(m => `${lineIdFor(m.host)} ${m.kbps != null? `${(m.kbps / 8000).toFixed(1)} MB/s`: "吞吐未测"}·${m.ms}ms`).join(" · ")
: "无";
/* 探测池口径（最终版 C 线 P2-02，裁定条目 5）：published＝发布条数、
 * probed＝延迟探测条数、okCount＝可达数、measured＝吞吐探测池条数
 * （其中 kbps 非空者为真测得吞吐），四数分开呈现，不再用一个「探测」
 * 含混带过；池规则明示——可达 ≤6 全测吞吐／>6 池内轮换（延迟前 2
 * ＋当前线保底＋轮换 1 条），未入池者本轮无吞吐样本、不是被漏测。 */
const measuredOk = round.measured.filter(m => m.kbps != null).length;
lines.push(`镜像覆盖（${Math.max(0, Math.round((Date.now() - round.at) / 1000))} 秒前选线轮次）：发布 ${round.published?? "?"} 条 · 延迟探测 ${round.probed?? "?"} 条 · 可达 ${round.okCount?? "?"} 条 · 吞吐探测池 ${round.measured.length} 条（测得吞吐 ${measuredOk} 条；池规则：可达 ≤6 全测／>6 池内轮换）：${measuredText}`);
}
if (round?.breakerBlocked) lines.push("最近选线轮次：本轮被熔断拦截——自动选线保持当前线路，未执行切换（熔断冷却中）");
/* 选线近轮（飞行记录仪收口）：单轮快照看不出抖动/乒乓/待确认拉锯，
 * 近 5 轮连读（落定线路＋Rust 决胜原因＋候选/可达＋熔断标记）。 */
{
const rounds = recentPickRounds();
if (rounds.length > 1) {
lines.push(`选线近轮（最近 ${rounds.length} 轮，旧→新）：`);
for (const r of rounds) {
lines.push(`· ${new Date(r.at).toLocaleTimeString("zh-CN", { hour12: false })} 落定 ${lineIdFor(r.base)} · 决胜 ${r.reason} · 发布 ${r.published?? "?"} 条 · 延迟探测 ${r.probed?? "?"} 条 · 可达 ${r.okCount?? "?"} 条 · 吞吐探测池 ${r.measured.length} 条${r.breakerBlocked? " · 本轮熔断拦截": ""}`);
}
}
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
lines.push(`当前集源：${facts.w}x${facts.h}${codecText}${fpsText}${kbps? ` · 码率 ${kbps} kbps`: " · 码率 未知"}${bpp? ` · 密度 bpp ${bpp}`: ""}${facts.engine? ` · 引擎 ${facts.engine}`: ""}`);
/* 超分双行口径（audit6 P0-A 第 2 层）：判档是意图、实际管线是实况、
 * 降档次数是稳定性——分开报，禁止用单个「超分档位」冒充实况。 */
lines.push(`超分：判档 ${facts.srMode} · 实际管线 ${facts.pipeline?? "未知"} · 降档 ${facts.srDemoteCount?? flow?.demoteCount?? 0} 次${facts.firstRendition? ` · 首分片档位 ${facts.firstRendition}`: ""}`);
/* 独立档位行（Muse 2026-11-19 3.3.0批诊断档位线）：含播放的诊断
 * 必含——三要素（档数/当前档/最高档分辨率·码率）逐项呈现，缺失标
 * 未知＋来源，不再只作超分行的条件后缀静默省略（3.2.2 真机贴文缺行
 * 实锤，定性见 fix330/evidence/diag-levels.md）。拼装唯一口径在
 * levelFacts.formatLevelFactsLine。 */
const levelLine = formatLevelFactsLine({ facts, hasPlayback: true });
if (levelLine) lines.push(levelLine);
} else {
lines.push("当前集源：无（尚未播放）");
/* facts 快照缺失但流水/账本有播放时档位行仍必出（同档位线口径）：
 * 整行标未知＋快照缺失来源，不许因快照一侧为空整行消失。 */
const levelLine = formatLevelFactsLine({ facts: null, hasPlayback: flow != null || ledgerEvidence.hasPlayback });
if (levelLine) lines.push(levelLine);
}
if (flow && flow.demoteCount > 0) lines.push(`超分降档：本会话 ${flow.demoteCount} 次（帧成本超标自动降档——发热/功耗问题先看这个数）`);
lines.push(`选线现状：当前 ${currentLineId?? "未知"}${round && Date.now() - round.at < 10 * 60_000? `；最近轮次发布 ${round.published?? "?"} 条、延迟探测 ${round.probed?? "?"} 条、可达 ${round.okCount?? "?"} 条、吞吐探测池 ${round.measured.length} 条（池规则：可达 ≤6 全测／>6 池内轮换）`: probeCount!= null? `；固定+当前探测 ${probeCount} 条、不可达 ${probeDown?? 0} 条`: ""}${flow? `；本会话切线 ${flow.lineSwitchCount} 次${flow.confirmPendingCount > 0? ` · 两轮确认待确认 ${flow.confirmPendingCount} 次`: ""}`: ""}`);
lines.push("");
lines.push("── 状态快照 ──────────────────────");
/* 状态快照（飞行记录仪收口）：各子系统当前状态汇总，与时间线流水
 * 互补——流水答「发生过什么」，快照答「现在是什么状态」。任一面
 * 读取失败只降级对应行。 */
{
const ps = proxyStateR.status === "fulfilled"? obj(proxyStateR.value): {};
const env = obj(diag.env);
const sp = obj(env.session_persist);
const persistText = Object.keys(sp).length === 0? "未记录": sp.ok === true? `成功${str(sp.at)? `（${str(sp.at)}）`: ""}`: `失败（阶段 ${str(sp.stage) || "未知"}）`;
/* 代理生效地址不入导出（整改 C8 零 host 口径）：只报是否生效。 */
lines.push(`环境：代理模式 ${str(ps.mode) || "未知"}${str(ps.effective)? " · 生效中（地址不入导出）": ""} · session 落盘 ${persistText}`);
const brk = obj(lineState.breaker);
if (Object.keys(brk).length) lines.push(`熔断：进程期自动切换 ${num(brk.total)?? "?"} / ${num(brk.sessionMax)?? "?"} · 10 分钟窗口 ${num(brk.windowCount)?? "?"} / ${num(brk.windowMax)?? "?"} · 退避中 ${num(brk.backoffLines)?? "?"} 条`);
const ledgerEntries = Array.isArray(lineState.ledger)? lineState.ledger.map(obj): [];
if (ledgerEntries.length) {
const fmtBps = (v: unknown) => { const n = num(v); return n == null? "—": `${(n / 8_000_000).toFixed(1)} MB/s`; };
for (const e of ledgerEntries) {
/* 账本行扩印（整改 C8，消费 A 线新字段 playFirstAt/playUpdatedAt/
 * probeUpdatedAt/playEnough/probeEnough/playStale，epoch ms）：字段
 * 缺失（A 线未合入）时不印，不冒充。 */
const timeOf = (v: number | null) => v == null? "?": new Date(v).toLocaleTimeString("zh-CN", { hour12: false });
const extras: string[] = [];
const firstAt = num(e.playFirstAt);
const playUpd = num(e.playUpdatedAt);
const probeUpd = num(e.probeUpdatedAt);
if (firstAt != null || playUpd != null) extras.push(`样本窗 ${timeOf(firstAt)}–${timeOf(playUpd)}`);
if (probeUpd != null) extras.push(`探测更新 ${timeOf(probeUpd)}`);
if (e.playEnough === false) extras.push("播放样本不足");
if (e.probeEnough === false) extras.push("探测样本不足");
if (e.playStale === true) extras.push("播放样本已过期");
/* recovery 语义标注（Muse 2026-11-19 最终版 E 线，GPT P2-12 残余）：
 * 账本 recovery＝切线决策已提交的计数，不是播放恢复成功率（无分母、
 * 不可算率）——行内明示，防读者误读为恢复成功次数/成功率。 */
lines.push(`账本[${lineIdFor(str(e.origin))} · ${str(e.mode) || "?"}]：play ${fmtBps(e.playBps)}（${num(e.playSamples)?? 0} 样本） · probe ${fmtBps(e.probeBps)}（${num(e.probeSamples)?? 0} 样本） · 卡顿 ${num(e.stall)?? 0} · 恢复 ${num(e.recovery)?? 0}（切线决策已提交计数，非播放恢复成功率） · 降级 ${num(e.fallback)?? 0}${extras.length? ` · ${extras.join(" · ")}`: ""}`);
}
} else {
lines.push("账本：无条目（本会话尚无线路吞吐/事件记录）");
}
try {
const cc = cacheCountersSnapshot();
lines.push(`缓存：播放 URL 查找 命中 ${cc.hits} · 未命中 ${cc.misses} · 写入 ${cc.sets} · 淘汰 ${cc.evictions} · 作用域失效 ${cc.scopeClears} 次（作用域清空入流水 cache.scope_clear，逐次淘汰只计数）`);
} catch {
lines.push("缓存：计数读取失败");
}
lines.push(`源注册表：${sourceRegistryVersion()}`);
const healthLines = sourceHealthLines();
if (healthLines.length) for (const l of healthLines) lines.push(l);
else lines.push("源健康：未接（注册表健康 provider 未注册）");
}
lines.push("");
lines.push("── 最近一次播放流水 ──────────────");
lines.push(flow? flow.table: logReadFailed? "（诊断日志读取失败——本次无法提供播放流水）": logEmpty? "（诊断日志为空——记录可能未成功开启）": flowMissingButPlaying? "（诊断日志无完整播放段——事件账本显示本会话有播放，本次无法提供播放流水）": "（无记录）");
/* 起播阶段增量表（audit6 诊断节）：绝对偏移看不出哪段吃时间，
 * 相邻增量一眼定位慢环。 */
if (flow?.stageIncrements) lines.push(`阶段增量：${flow.stageIncrements}`);
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
lines.push("── Feed 分页与封面 ────────────────");
/* FeedRequestTrace（fix2 A2/A3）：分页状态机与封面状态机的证据环。
 * 纯旁路：读取失败只降级本节。慢线下「只出首屏/封面全黑」复现后
 * 生成报告即可定性，不再靠猜。 */
try {
const summary = feedTraceSummary();
const snap = feedTraceSnapshot();
if (!summary) {
lines.push("无记录（本会话未打开任何分页列表）");
} else {
/* 按列表隔离逐行输出（fix2.1 批三#10）：多列表同会话不再混算 */
for (const l of summary.lists) {
const failText = l.lastFail? ` · 最近失败 ${l.lastFail}`: "";
lines.push(`分页[${channelLabel(l.list)}]：已加载至第 ${l.loadedPages} 页 · 终态 ${l.lastState?? "未知"}${failText}`);
}
const reasons = Object.entries(snap.image.byReason).map(([k, v]) => `${k} ${v}`).join(" · ");
lines.push(`封面：已显示 ${snap.image.displayed} · 终局失败 ${snap.image.failed}${reasons? `（${reasons}）`: ""} · 在途峰值 ${snap.image.inFlightPeak}`);
const recent = snap.events.filter(e => e.kind.startsWith("page.")).slice(-4);
for (const e of recent) lines.push(`· ${e.kind} ${redactExportText(JSON.stringify(e.data), lineIdByHost)}`);
}
} catch {
lines.push("读取失败（纯旁路，不影响本报告其余内容）");
}
lines.push("");
/* 探针 v1 节已随 v1 退役删除（整改 C10）：只保留 v2 超分检证节。 */
lines.push("── WebGPU 探针 v2（超分检证）───────");
try {
for (const l of formatSrProbeLines(getSrProbeResult())) lines.push(l);
} catch {
lines.push("读取失败（纯旁路，不影响本报告其余内容）");
}
/* 生产期统计（Muse 2026-11-19 最终版 E2 线）：与探针期分开成节——
 * 探针数字是离线 bench、生产数字是真实播放循环的周期发布，两组数
 * 不许混读（GPT 后续复审条目 1 的缺口即在于此前只有探针数字）。 */
lines.push("── WebGPU 生产期统计（真实播放）─────");
try {
for (const l of formatSrProductionLines(getSrProductionStats())) lines.push(l);
} catch {
lines.push("读取失败（纯旁路，不影响本报告其余内容）");
}
/* 长按松手分组汇总（Muse 2026-11-19 最终版协调接线，聚合器为 B3 线
 * summarizeHoldEvents）：按事件自带 sr_engaged 把长按/松手卡顿分
 * 「SR 接管／判档直通」两组——设置里没有手动引擎开关、用户做不了
 * A/B 对照，此分组就是真机一份诊断判读 SR 与松手卡顿是否相关的
 * 唯一对照（条目 9 判别力）。无 sr_engaged 标记的事件不入桶不推断。 */
try {
/* 数据源（Muse 2026-11-19 3.2.1修复F3线）：hold.* 事件的事实来源是
 * 事件账本——汇总吃 ledgerSnapshot().events，与一键导出的账本尾段
 * 同源。旧实现喂播放日志 entries（按最后一个 pid 过滤）：那是另一套
 * 存储，且日志落盘名由 Rust 统一加 web. 前缀（web.hold.jank），聚合器
 * 按 hold.jank 精确匹配恒不命中——3.2.0 真机实锤账本尾段有
 * release_profile/jank ×3、汇总却报 0。账本事件无 pid、会话内不再
 * 分段，口径＝本会话保留窗全集（最近 512 条），与报告头留存范围
 * 一致；回归见 fix321-f3-hold-summary.contract.test.ts。 */
const holdEvents = ledgerSnapshot().events;
const hs = summarizeHoldEvents(holdEvents);
lines.push("── 长按松手分组（SR 接管 vs 判档直通）──");
lines.push(`SR 接管：长按 ${hs.engaged.holds} 次 · 松手卡顿 ${hs.engaged.janks} 次`);
lines.push(`判档直通：长按 ${hs.bypass.holds} 次 · 松手卡顿 ${hs.bypass.janks} 次`);
/* 判读面补齐（fix322/sr）：旧节只印桶计数，release_profile 的分段
 * 值从不进报告——账本尾段又被播放器心跳挤出导出窗，报告侧实际判
 * 读不了松手帧成本落在哪一段（首帧/SR 尝试/SR 呈现/主线程长任务）。
 * 现印最近 3 条剖面分段＋两桶松手尾窗最大帧间隔（hold.jank 的
 * post_max_gap_ms），量级在报告内可直接判读。 */
const msOr = (v: unknown): string => { const n = num(v); return n === null ? "—" : `${n}ms`; };
for (const p of holdEvents.filter(e => e.name === "hold.release_profile").slice(-3)) {
const d = p.data ?? {};
const bucket = d.sr_engaged === true ? "SR 接管" : d.sr_engaged === false ? "判档直通" : "未标记";
lines.push(`松手剖面[${bucket}]：首帧 ${msOr(d.release_to_first_frame_ms)} · SR 尝试 ${msOr(d.release_to_sr_attempt_ms)} · 尝试→呈现 ${msOr(d.sr_attempt_to_present_ms)} · SR 呈现 ${msOr(d.release_to_sr_present_ms)} · 长任务max ${msOr(d.longtask_max_ms)}`);
}
const worstPostGap = (engaged: boolean): number | null => {
let worst: number | null = null;
for (const e of holdEvents) {
if (e.name !== "hold.jank" || e.data?.sr_engaged !== engaged) continue;
const g = num(e.data?.post_max_gap_ms);
if (g !== null && (worst === null || g > worst)) worst = g;
}
return worst;
};
const wgE = worstPostGap(true);
const wgB = worstPostGap(false);
lines.push(`松手尾窗最大帧间隔：SR 接管 ${wgE === null ? "—" : `${wgE}ms`} · 判档直通 ${wgB === null ? "—" : `${wgB}ms`}`);
} catch {
lines.push("长按松手分组：读取失败（纯旁路，不影响本报告其余内容）");
}
return lines.join("\n");
}
