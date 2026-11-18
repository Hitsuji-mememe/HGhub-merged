/**
 * 事件账本骨架（Muse 2026-11-18 U6b，诊断域升级第一批：只落骨架与报告头，
 * 不迁移既有逐次统计逻辑，不接线播放内核的 trace 调用点——实例 ID 接线随
 * 播放内核收敛批走）。
 *
 * 解决的问题：异步回调（HLS 事件、看门狗、seek 帧回调等）可能在播放器
 * 实例已经销毁/换源之后才迟到返回，若无条件写入记录，会把旧实例的事件
 * 记到新实例头上，污染诊断。本账本给每条事件绑定「会话 + 实例 + 序号」，
 * 迟到回调在写账前先校验实例仍有效，失效直接丢弃并计数——报告头用
 * 「已记 / 迟到丢弃」两个计数自证完整性，读者能判断流水有没有被污染。
 *
 * ── API 契约 ────────────────────────────────────────────────────────────
 * sessionId（会话）：
 *   - 进程（页面）加载时生成一次，整个页面生命周期内不变。
 *   - 轮换时机：仅显式调用 rotateSessionId() 时轮换——预留给未来的
 *     「账号切换 / 线路代次整体切换」这类会话语义变更点；本批没有任何
 *     调用方自动轮换，播放/切集/切线都不轮换。
 *   - 读取：getSessionId()。
 *
 * playerInstanceId（播放器实例）：
 *   - 注册：播放器实例创建时由其所有者调用 registerPlayerInstance()
 *     （未来接线点：VideoSurface / Player 的挂载路径），拿到唯一 id。
 *   - 注销：实例销毁/卸载时由同一所有者调用 unregisterPlayerInstance(id)；
 *     注销后该 id 永久失效、不复用（计数器单调递增）。
 *   - 本批只提供注册表本身，不改任何现有播放器调用点。
 *
 * record / recordIfCurrent（写账）：
 *   - record(name, data?)：会话级事件（无实例归属），恒记。
 *   - recordIfCurrent(instanceId, name, data?)：实例级事件的唯一正道。
 *     异步回调在调用前（或由本函数内部）以 isCurrent(instanceId) 校验；
 *     实例已注销 → 不写账、droppedLate 计数 +1、返回 false。
 *   - isCurrent(instanceId)：instanceId 为 null/undefined 时视为会话级、
 *     恒 true；否则查注册表是否仍活跃。
 *
 * snapshot()：供诊断报告读取的只读快照（计数 + 最近事件副本）。
 *
 * ── 旁路纪律 ────────────────────────────────────────────────────────────
 * 本模块是纯旁路：不落盘、不发 IPC、不被播放路径依赖；全部公开函数
 * 内部吞异常、绝不抛错——账本自身故障最多让报告头少一行计数，绝不
 * 影响播放、起播或诊断报告其余内容的生成。内存有界：仅保留最近
 * MAX_RETAINED 条事件，完整性计数（totalRecorded）独立单调累计、
 * 不随截断回退。
 */

export type LedgerEvent = {
  /** 会话内自增序号，从 1 开始，单调递增（含被截断的旧事件）。 */
  seq: number;
  /** 墙钟时间（ISO 字符串）。 */
  ts: string;
  /** 单调时钟毫秒（performance.now 取整），同一会话内可比。 */
  monoMs: number;
  name: string;
  /** 归属的播放器实例 id；会话级事件为 null。 */
  instanceId: string | null;
  data?: Record<string, unknown>;
};

export type LedgerSnapshot = {
  sessionId: string;
  /** 已记事件总数（单调累计，不受保留上限截断影响）。 */
  recorded: number;
  /** 因实例已失效而被丢弃的迟到事件数。 */
  droppedLate: number;
  /** 当前仍活跃的播放器实例数。 */
  activeInstances: number;
  /** 保留窗口内的最近事件（最多 MAX_RETAINED 条，旧→新）。 */
  events: LedgerEvent[];
};

const MAX_RETAINED = 512;

function newSessionId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
  } catch { /* 降级到时间戳+随机后缀 */ }
  return `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

let sessionId = newSessionId();
let seq = 0;
let totalRecorded = 0;
let droppedLate = 0;
let nextInstance = 0;
const retained: LedgerEvent[] = [];
const active = new Set<string>();

/** 当前会话 id（页面生命周期内不变，除非显式 rotateSessionId）。 */
export function getSessionId(): string {
  return sessionId;
}

/**
 * 显式轮换会话 id 并清空实例注册表与保留窗口（完整性计数不重置——
 * 报告要能看出轮换前记过多少）。仅供未来的会话语义变更点调用；
 * 本批无自动调用方。
 */
export function rotateSessionId(): string {
  sessionId = newSessionId();
  active.clear();
  retained.length = 0;
  return sessionId;
}

/**
 * 注册一个播放器实例，返回其唯一 id。由实例所有者在创建时调用
 * （未来接线：VideoSurface / Player 挂载路径；本批无调用方）。
 */
export function registerPlayerInstance(): string {
  const id = `player-${++nextInstance}`;
  active.add(id);
  return id;
}

/** 注销播放器实例（所有者在销毁/卸载时调用）。注销后 id 永久失效。 */
export function unregisterPlayerInstance(instanceId: string): void {
  active.delete(instanceId);
}

/**
 * 实例有效性判据：异步回调写账前必须过这一关。
 * null/undefined 表示会话级（无实例归属），恒有效。
 */
export function isCurrent(instanceId: string | null | undefined): boolean {
  if (instanceId == null) return true;
  return active.has(instanceId);
}

function append(name: string, data: Record<string, unknown> | undefined, instanceId: string | null): boolean {
  seq += 1;
  totalRecorded += 1;
  retained.push({
    seq,
    ts: new Date().toISOString(),
    monoMs: Math.round(performance.now()),
    name,
    instanceId,
    data,
  });
  if (retained.length > MAX_RETAINED) retained.splice(0, retained.length - MAX_RETAINED);
  return true;
}

/** 记一条会话级事件（无实例归属）。旁路：永不抛错，恒返回 true。 */
export function record(name: string, data?: Record<string, unknown>): boolean {
  try {
    return append(name, data, null);
  } catch {
    return false;
  }
}

/**
 * 记一条实例级事件：instanceId 已失效（实例已注销）时直接丢弃、
 * droppedLate +1 并返回 false——迟到回调的唯一正道入口。
 */
export function recordIfCurrent(
  instanceId: string | null | undefined,
  name: string,
  data?: Record<string, unknown>,
): boolean {
  try {
    if (!isCurrent(instanceId)) {
      droppedLate += 1;
      return false;
    }
    return append(name, data, instanceId ?? null);
  } catch {
    return false;
  }
}

export type LedgerIntegrity = {
  /** 保留窗口内相邻序号的缺口总数（应为 0：序号由本模块单调分配，
   * 窗口内断裂只可能来自数据损坏或并发写账竞态）。 */
  seqGaps: number;
  /** 保留窗口内重复出现的序号数（应为 0）。 */
  seqDuplicates: number;
  /** 已被保留窗口截断的旧事件数（= 已记总数 − 窗口内条数；是设计内
   * 的有界保留，不算丢失，但报告必须让读者看见窗口之外还有多少）。 */
  truncated: number;
  /** 归属某播放器实例的事件数（instanceId 非 null）。 */
  instanceLinked: number;
  /** 会话级事件数（instanceId 为 null）。 */
  sessionLevel: number;
  /** 归属实例已注销的事件数：迟到事件在写账前已被 isCurrent 拦下，
   * 窗口内出现这类只可能是实例正常销毁后的历史事件（信息项，
   * 非损坏指标；真正的迟到丢弃看 droppedLate）。 */
  orphanedInstance: number;
};

/** 账本完整性验证（Muse 2026-11-19 fix2 B2）：对快照做结构核对，
 * 供诊断报告自证流水未被污染。纯函数、无副作用。 */
export function validateLedgerIntegrity(snap: LedgerSnapshot): LedgerIntegrity {
  const evs = snap.events;
  let seqGaps = 0;
  let seqDuplicates = 0;
  const seen = new Set<number>();
  for (let i = 0; i < evs.length; i++) {
    const isDuplicate = seen.has(evs[i].seq);
    if (isDuplicate) seqDuplicates++;
    seen.add(evs[i].seq);
    if (i > 0) {
      const delta = evs[i].seq - evs[i - 1].seq;
      if (delta > 1) seqGaps += delta - 1;
      /* 乱序（delta<1 且非重复序号）：窗口内事件应严格单调，出现
       * 回退同样是污染信号，计入缺口侧（fix2 收尾猎查补强）。 */
      else if (delta < 1 && !isDuplicate) seqGaps += 1;
    }
  }
  return {
    seqGaps,
    seqDuplicates,
    truncated: Math.max(0, snap.recorded - evs.length),
    instanceLinked: evs.filter(e => e.instanceId != null).length,
    sessionLevel: evs.filter(e => e.instanceId == null).length,
    orphanedInstance: evs.filter(e => e.instanceId != null && !active.has(e.instanceId)).length,
  };
}

/** 只读快照，供诊断报告头读取完整性计数。旁路：失败时返回空计数快照。 */
export function snapshot(): LedgerSnapshot {
  try {
    return {
      sessionId,
      recorded: totalRecorded,
      droppedLate,
      activeInstances: active.size,
      events: retained.slice(),
    };
  } catch {
    return { sessionId, recorded: 0, droppedLate: 0, activeInstances: 0, events: [] };
  }
}
