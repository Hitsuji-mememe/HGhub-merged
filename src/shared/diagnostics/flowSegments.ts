/**
 * 诊断流水选段与账本交叉核对（Muse 2026-11-19 3.2.1修复F3b线）。
 *
 * 选段（selectFlowSegment）：analyzeFlow 此前只取播放日志「最后一行
 * pid」的段且段内必须有 web.source.load——读到的窗口里最后 pid 段无
 * load 时（日志轮转后新段未及写入、Rust 导出 256KB 裁剪把当前段的
 * load 裁出窗口、文件尾混入他 pid 行如 debug.line/上一进程段），整段
 * 流水连同结论一起塌缩成「无记录」，哪怕同窗更早的段里播放完整、
 * 事件账本里 media.playing 正在发生（3.2.0 第二份真机诊断实锤）。
 * 新口径：按各 pid 最后出现位置由新到旧试段，取第一个含 source.load
 * 的段；全窗无 load 时回落旧口径（最后一行 pid 段），让上层如实走
 * 通道状态明示分支，不在这里编造结论。
 *
 * 账本证据（ledgerPlaybackEvidence）：播放事实在两套存储都有记录
 * （日志流水＋事件账本）时，汇总层不许只因日志一侧读空就报「无记
 * 录」——本函数把账本保留窗内的播放/卡死证据提成计数，供报告在
 * 日志无完整段时明示通道状态（沿用报告既有「日志状态明示」体系）。
 * 账本事件名无 web. 前缀（账本是 trace 的第一落点，日志落盘才加
 * 前缀），口径＝本会话保留窗全集，与报告头留存范围一致。
 */

type FlowEntryLike = { event: string; pid: number | null };

export function selectFlowSegment<T extends FlowEntryLike>(entries: T[]): T[] {
  if (!entries.length) return entries;
  const lastPid = entries[entries.length - 1].pid;
  /* 各 pid 按「最后出现位置」由新到旧排序：最新段优先，含 load 即取。 */
  const lastSeenAt = new Map<number | null, number>();
  entries.forEach((e, i) => lastSeenAt.set(e.pid, i));
  const pidsByRecency = [...lastSeenAt.entries()].sort((a, b) => b[1] - a[1]).map(([pid]) => pid);
  for (const pid of pidsByRecency) {
    const seg = pid == null ? entries.filter(e => e.pid == null) : entries.filter(e => e.pid === pid);
    if (seg.some(e => e.event === "web.source.load")) return seg;
  }
  return lastPid == null ? entries : entries.filter(e => e.pid === lastPid);
}

type LedgerEventLike = { name: string; instanceId?: string | null };

export type LedgerPlaybackEvidence = {
  /** 账本保留窗内有播放段证据（起播/清单/分片/出画任一）。 */
  hasPlayback: boolean;
  /** 账本保留窗内 append 卡死次数（hls.append_stall）。 */
  stallCount: number;
};

const LEDGER_PLAYBACK_EVENTS = new Set([
  "source.load",
  "play.resolve",
  "hls.manifest",
  "hlsFragLoaded",
  "hlsFragBuffered",
  "media.playing",
  "media.loadstart",
]);

export function ledgerPlaybackEvidence(events: LedgerEventLike[]): LedgerPlaybackEvidence {
  let hasPlayback = false;
  let stallCount = 0;
  for (const e of events) {
    if (LEDGER_PLAYBACK_EVENTS.has(e.name)) hasPlayback = true;
    else if (e.name === "hls.append_stall") stallCount += 1;
  }
  return { hasPlayback, stallCount };
}
