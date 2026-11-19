/**
 * 诊断档位行拼装（Muse 2026-11-19 3.3.0批诊断档位线）。
 *
 * 背景：3.2.2 真机诊断含完整播放事实却无任何档位行——rendition 只作
 * 「超分：」行的条件后缀，缺失即静默省略（定性全文见
 * fix330/evidence/diag-levels.md）。本模块是档位行的唯一拼装口径：
 * 含播放证据（hasPlayback）时必出独立「档位：」行，三要素（档数 N、
 * 当前档序号、最高档分辨率/码率）逐项呈现；某要素在会话中确实无从
 * 取得时标「未知」并在行尾标缺失来源，整行不消失（不变量：未知
 * 不是空）。无播放证据时返回 null，不编造。
 *
 * 数据优先序：结构化 levelFacts（新采集）→ firstRendition 预格式化
 * 字符串回落解析（旧发布形态）。字符串只含首分片所属档参数：当前档
 * 即末档（index==total）时其参数即最高档参数；否则最高档如实标
 * 未知，不冒充。
 */
import type { PlaybackFacts, PlaybackLevelFacts } from "./playbackFacts.ts";

/** 首分片 rendition 采集结果（hlsConfig.FirstRendition 的结构形状，
 * 本模块不反向依赖 features 层，故按形状声明）。 */
export type FirstRenditionLike = {
  index: number;
  total: number;
  width?: number;
  height?: number;
  bitrate?: number;
  topWidth?: number;
  topHeight?: number;
  topBitrate?: number;
};

/** 采集点转换：首分片 rendition → 结构化档位事实。最高档参数只认
 * 采集侧给出的 levels 末位字段（top*），缺失即整键缺失待报告标未知。 */
export function levelFactsFromFirstRendition(r: FirstRenditionLike): PlaybackLevelFacts {
  return {
    total: r.total,
    currentIndex: r.index,
    ...(r.topWidth !== undefined ? { topWidth: r.topWidth } : {}),
    ...(r.topHeight !== undefined ? { topHeight: r.topHeight } : {}),
    ...(r.topBitrate !== undefined ? { topBitrate: r.topBitrate } : {}),
  };
}

/** firstRendition 字符串回落解析（格式由 hlsConfig.formatFirstRendition
 * 钉死：「第 i/N 档 · WxH · Bkbps」，原生形态「原生实际 WxH（档位
 * 不可控）」无档位段、解析为 null）。 */
function parseFirstRendition(s: string | undefined): PlaybackLevelFacts | null {
  if (!s) return null;
  const m = /^第 (\d+)\/(\d+) 档(?: · (\d+)x(\d+))?(?: · (\d+)kbps)?$/.exec(s);
  if (!m) return null;
  const index = Number(m[1]);
  const total = Number(m[2]);
  const atTop = index === total;
  return {
    total,
    currentIndex: index,
    ...(atTop && m[3] ? { topWidth: Number(m[3]), topHeight: Number(m[4]) } : {}),
    ...(atTop && m[5] ? { topBitrate: Number(m[5]) * 1000 } : {}),
  };
}

export function formatLevelFactsLine(input: { facts: PlaybackFacts | null; hasPlayback: boolean }): string | null {
  if (!input.hasPlayback) return null;
  const facts = input.facts;
  const lf: PlaybackLevelFacts = facts?.levelFacts ?? parseFirstRendition(facts?.firstRendition) ?? {};
  const missing: string[] = [];
  const totalText = lf.total != null ? `共 ${lf.total} 档` : "档数 未知";
  if (lf.total == null) missing.push("档数");
  const currentText = lf.currentIndex != null ? `当前第 ${lf.currentIndex} 档` : "当前档 未知";
  if (lf.currentIndex == null) missing.push("当前档");
  const topResText = lf.topWidth != null && lf.topHeight != null ? `最高档 ${lf.topWidth}x${lf.topHeight}` : "最高档 未知";
  if (lf.topWidth == null || lf.topHeight == null) missing.push("最高档分辨率");
  const topBrText = lf.topBitrate != null ? `最高档码率 ${Math.round(lf.topBitrate / 1000)} kbps` : "最高档码率 未知";
  if (lf.topBitrate == null) missing.push("最高档码率");
  let line = `档位：${totalText} · ${currentText} · ${topResText} · ${topBrText}`;
  if (missing.length) {
    /* 缺失来源：采集侧明示（missingNote，如原生不可控）优先；其次按
     * 事实通道状态定性——快照整体缺失与「快照在但 rendition 通道无
     * 记录」是两种不同的丢失形态，分开标。 */
    const source = lf.missingNote
      ?? (facts == null
        ? "播放事实快照缺失（facts 未发布，档位采集无记录）"
        : facts.levelFacts == null && facts.firstRendition == null
          ? "首分片 rendition 未记录（未触发、原生引擎或呈现复位后未重采）"
          : "清单最高档未声明该参数");
    line += `（缺失来源：${source}；缺失要素：${missing.join("、")}）`;
  }
  return line;
}
