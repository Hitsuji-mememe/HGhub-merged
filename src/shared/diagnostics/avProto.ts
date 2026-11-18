import { record } from "./eventLedger";

/* AVFoundation 混合路线验证原型结果（Muse 2026-11-19）：
 * 自检页（设置 → 诊断 → AVFoundation 原型自检）手动触发一轮后，把
 * Swift 侧快照（门1/门2）与 Rust 侧对账（门3）合并存这里：内存一份 +
 * localStorage 一份（hghubx_ 前缀，仓规不变量 7），供诊断报告读取。
 * 纯旁路：本模块任何失败都不得影响播放与报告其余内容，全部吞异常。 */

export type ProtoSnapshot = {
  active?: boolean;
  presenting?: boolean;
  sequenceDone?: boolean;
  elapsedMs?: number;
  checks?: Record<string, unknown>;
  frame?: Record<string, unknown>;
  events?: Array<{ tMs: number; name: string; detail: string }>;
};

export type ProtoGate3 = {
  sessionId: string;
  durationMs: number;
  independentRequests: number;
  recordedResponses: number;
  missingResponses: number;
  masterPlaylists: number;
  mediaPlaylists: number;
  variantCountMax: number;
  expectedSegments: number;
  segmentResponses: number;
  segmentGap: number;
  errorResponses: number;
};

export type AvProtoRun = {
  /** ISO 时间。 */
  at: string;
  sessionId: string;
  snapshot: ProtoSnapshot | null;
  gate3: ProtoGate3 | null;
  error?: string;
};

const STORAGE_KEY = "hghubx_avproto_last_v1";

function loadPersisted(): AvProtoRun | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AvProtoRun;
    return parsed && typeof parsed.at === "string" ? parsed : null;
  } catch {
    return null;
  }
}

let lastRun: AvProtoRun | null = loadPersisted();

export function getLastAvProtoRun(): AvProtoRun | null {
  return lastRun;
}

/** 保存一轮结果，并把关键事件逐条写进事件账本（会话级事件，恒记）。 */
export function saveAvProtoRun(run: AvProtoRun): void {
  lastRun = run;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(run));
  } catch { /* 落盘失败只丢持久化，内存份仍在 */ }
  try {
    record("proto.av.session", {
      sessionId: run.sessionId,
      error: run.error ?? null,
      gate3Missing: run.gate3?.missingResponses ?? null,
      gate3Segments: run.gate3?.segmentResponses ?? null,
    });
    for (const event of run.snapshot?.events ?? []) {
      record(`proto.av.${event.name}`, { detail: event.detail, tMs: event.tMs });
    }
  } catch { /* 账本是旁路，写账失败不回滚结果 */ }
}

function seekText(checks: Record<string, unknown>): string {
  const seek = checks.seek as Record<string, unknown> | undefined;
  if (!seek) return "未测";
  if (typeof seek.skipped === "string") return `跳过（${seek.skipped}）`;
  return `目标 ${seek.target}s → 落点 ${seek.landed}s（偏差 ${seek.delta}s，${seek.ok ? "通过" : "未达标"}）`;
}

function subtitlesText(checks: Record<string, unknown>): string {
  const sub = checks.subtitles as Record<string, unknown> | undefined;
  if (!sub) return "未测";
  return sub.present
    ? `有字幕轨 ${sub.options} 条，已选中（${sub.locale || "未知语言"}）`
    : "源无字幕轨（数据，非失败）";
}

function abrText(checks: Record<string, unknown>): string {
  const abr = checks.abr as Record<string, unknown> | undefined;
  if (!abr) return "未测";
  return `基线 indicated ${abr.baselineIndicated} → 钳制后 ${abr.clampedIndicated}（变体 ${abr.variantCount} 个，切换${abr.switched ? "已发生" : "未发生"})`;
}

/** 诊断报告「AVFoundation 原型」一节；没跑过就一行说明去哪触发。 */
export function formatAvProtoLines(): string[] {
  const run = lastRun;
  if (!run) {
    return ["尚未运行（设置 → 诊断 → AVFoundation 原型自检，手动触发）"];
  }
  const lines: string[] = [];
  lines.push(`最近一轮：${run.at} · 会话 ${run.sessionId}`);
  if (run.error) {
    lines.push(`本轮中断：${run.error}`);
    return lines;
  }
  const checks = (run.snapshot?.checks ?? {}) as Record<string, unknown>;
  const frame = (run.snapshot?.frame ?? {}) as Record<string, unknown>;
  if (typeof checks.itemError === "string") {
    lines.push(`门1 端到端喂流：失败——播放项错误 ${checks.itemError}`);
  } else {
    lines.push(
      `门1 端到端喂流：readyToPlay ${checks.readyToPlayMs ?? "?"}ms · 起播 ${checks.startupMs ?? "?"}ms · seek ${seekText(checks)} · 字幕 ${subtitlesText(checks)} · ABR ${abrText(checks)}`,
    );
  }
  if (typeof frame.error === "string" && !frame.frames) {
    lines.push(`门2 帧管线：未测出——${frame.error}`);
  } else {
    lines.push(
      `门2 帧管线：${frame.frames ?? 0} 帧 · 平均 ${frame.avgMs != null ? Number(frame.avgMs).toFixed(2) : "?"}ms · p95 ${frame.p95Ms != null ? Number(frame.p95Ms).toFixed(2) : "?"}ms · ${frame.width ?? "?"}x${frame.height ?? "?"} · 像素格式 ${frame.pixelFormat ?? "?"} · IOSurface 背书 ${frame.ioSurfaceBacked ? "是" : "否"}${typeof frame.error === "string" ? ` · 备注 ${frame.error}` : ""}`,
    );
  }
  const g = run.gate3;
  if (!g) {
    lines.push("门3 账本完整性：无对账数据（会话未正常收尾）");
  } else {
    lines.push(
      `门3 账本完整性：独立计数 ${g.independentRequests} · 已记 ${g.recordedResponses} · 记账缺口 ${g.missingResponses}（>0 即门3 不过） · 播放列表 主${g.masterPlaylists}/媒体${g.mediaPlaylists} · 应请求分片 ${g.expectedSegments} · 实记分片 ${g.segmentResponses} · 差 ${g.segmentGap}（含预取未取/中途停止） · 错误响应 ${g.errorResponses}`,
    );
  }
  return lines;
}
