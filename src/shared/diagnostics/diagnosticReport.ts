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

import { api, APP_VERSION, hostOf, platform} from "../api/api";
import { autoLineEnabled} from "../network/autoLine";
import { nativeFallbackState} from "../../features/playback/mediaTransport";
import { playbackLogApi} from "./playbackDiagnostics";
import { readPlaybackFacts} from "./playbackFacts";
import { shortVerdict} from "./netDiagReport";

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

/* 流水阶段定义：事件名以真机日志为准（前端事件在文件中带 web. 前缀）。 */
const STAGES: { key: string; label: string; events: string[]}[] = [
{ key: "resolve", label: "resolve", events: ["web.play.resolve"]},
{ key: "manifest", label: "manifest", events: ["web.hls.manifest", "web.media.loadstart"]},
{ key: "range", label: "range", events: ["web.hlsFragLoaded", "media.range_fetch"]},
{ key: "append", label: "append", events: ["web.hls.buffer_appended"]},
{ key: "buffered", label: "buffered", events: ["web.hlsFragBuffered"]},
{ key: "playing", label: "playing", events: ["web.media.playing"]},
];

type FlowResult = {
/** 一行流水简表，如 "resolve ✓ 12ms · manifest ✓ … · append ✗ 未达" */
table: string;
/** 卡点结论（已出画则为正常结论）。 */
verdict: string;
/** 本进程（pid 相同）是否发生过 append 卡死/会话降级。 */
stalledThisSession: boolean;
fallbackThisSession: boolean;
};

export function analyzeFlow(entries: LogEntry[]): FlowResult | null {
const startIdx = entries.map(e => e.event).lastIndexOf("web.source.load");
if (startIdx < 0) return null;
const tail = entries.slice(startIdx);
const t0 = tail[0].ts;
const lastPid = entries.length? entries[entries.length - 1].pid: null;
const sessionEntries = lastPid == null? entries: entries.filter(e => e.pid === lastPid);
const stalledThisSession = sessionEntries.some(e => e.event === "web.hls.append_stall");
const fallbackThisSession = sessionEntries.some(e => e.event === "web.playback.fallback");

const reached = STAGES.map(stage => {
const hit = tail.find(e => stage.events.includes(e.event));
return {...stage, at: hit? hit.ts: null};
});
const parts = reached.map(s => `${s.label} ${s.at == null? "✗ 未达": `✓ ${Math.max(0, s.at - t0)}ms`}`);
const furthest = [...reached].reverse().find(s => s.at!= null);
let verdict: string;
if (reached[reached.length - 1].at!= null) {
verdict = "最近播放已正常出画（playing）";
} else if (!furthest) {
verdict = "最近播放卡在起点（清单未达）";
} else if (furthest.key === "range") {
verdict = "最近播放卡在 append（分片已下载、未入缓冲——append 停滞签名）";
} else {
verdict = `最近播放卡在 ${furthest.label} 阶段`;
}
return { table: parts.join(" · "), verdict, stalledThisSession, fallbackThisSession};
}

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

/* 各固定线路延迟：用 line_probe（只测不切），候选 = 固定线路 + 当前线路。 */
let probeText = "未测（线路清单读取失败）";
if (lineStateR.status === "fulfilled") {
const fixed = Array.isArray(lineState.fixed)? lineState.fixed: [];
const urls = [...new Set(fixed.map(f => str(obj(f).url)).filter(Boolean).concat(currentBase? [currentBase]: []))].slice(0, 6);
if (urls.length) {
try {
const hits = await api.lineProbe(urls);
const list = Array.isArray(hits)? hits: [];
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
speedText = `A 路 ${mbps(bytes, num(sab.a_ms))}（生产客户端） · B 路 ${mbps(num(sab.b_bytes)?? bytes, num(sab.b_ms))}（裸客户端）`;
}

const entries = logR.status === "fulfilled"? parseLog(String(logR.value?? "")): [];
const flow = entries.length? analyzeFlow(entries): null;
const fallback = nativeFallbackState();
const facts = readPlaybackFacts();

const lines: string[] = [];
lines.push(`${new Date().toLocaleString("zh-CN", { hour12: false})}`);
lines.push("");
lines.push("── 结论 ──────────────────────────");
lines.push(`网络：${diagR.status === "fulfilled"? shortVerdict(diag): "诊断失败（net_diag 不可用）"}`);
lines.push(`当前线路：${currentHost}（自动选线 ${autoLineEnabled()? "开": "关"}）`);
lines.push(`各线延迟：${probeText}`);
lines.push(`分片吞吐：${speedText}`);
lines.push(`最近播放：${flow? flow.verdict: "无最近播放记录"}`);
if (fallback || flow?.fallbackThisSession) lines.push("会话降级：本会话已降级原生播放（append 停滞）");
else if (flow?.stalledThisSession) lines.push("会话降级：发生过 append 卡死、已自愈重建（未降级）");
else lines.push("会话降级：未发生");
lines.push("");
lines.push("── 硬数据 ────────────────────────");
const rt = obj(diag.runtime);
const osText = [str(rt.os), str(rt.arch)].filter(Boolean).join(" ") || platform;
lines.push(`App 版本：${APP_VERSION} · 平台：${osText}`);
if (facts) {
const kbps = facts.bitrateBps? Math.round(facts.bitrateBps / 1000): null;
const bpp = facts.bitrateBps && facts.w > 0 && facts.h > 0
? (facts.bitrateBps / (facts.w * facts.h) / (facts.fps && facts.fps > 0? facts.fps: 30)).toFixed(3)
: null;
lines.push(`当前集源：${facts.w}x${facts.h}${kbps? ` · 码率 ${kbps} kbps`: ""}${bpp? ` · 密度 bpp ${bpp}`: ""} · 超分档位 ${facts.srMode}${facts.engine? ` · 引擎 ${facts.engine}`: ""}`);
} else {
lines.push("当前集源：无（尚未播放）");
}
lines.push(`选线现状：当前 ${currentHost}；${probeText.includes("不可达")? "存在不可达线路": "候选线路可达性见上"}`);
lines.push("");
lines.push("── 最近一次播放流水 ──────────────");
lines.push(flow? flow.table: "（无记录）");
return lines.join("\n");
}
