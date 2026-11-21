/* 长按松手剖面/尾窗报告行格式化（Muse 2026-11-21 fix3311
 * 第 0 步判读面）：自 diagnosticReport 长按松手分组节抽出为纯
 * 函数，供报告与契约共用同一口径（仿 flowSegments 先例）。
 *
 * 第 0 步补两件事（调查 fix3311 hold-release-jank §5）：
 * ① 剖面行增印账本已记录、旧行没印的字段——预期呈现差
 *    （rvfc_expected_display_delta_ms，判形态 A 二选一的关键量）、
 *    rVFC mediaTime、SR 画布龄、画布重挂、HLS 窗口内重建；
 * ② 剖面行与 hold.jank 行加可配对序号：按账本顺序逐条编号，
 *    release_profile 落第 n 号，其后第一条尚未配对的 hold.jank
 *    （松手尾窗 ~600ms 后落行）配同号并紧随印出该次松手的期间/
 *    尾窗分布——旧报告只有桶聚合分布，逐次配对判读不了（调查
 *    裁定 8 的口径边界）。无前置剖面的孤儿 jank 不占号不冒充。
 * 只印最近 3 次松手（与旧行口径一致）；序号按保留窗全集计，
 * 同一会话内稳定可引。 */

type HoldEvent = { name?: string; event?: string; data?: Record<string, unknown> };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const msOr = (v: unknown): string => { const n = num(v); return n === null ? "—" : `${n}ms`; };
const countOr = (v: unknown): string => { const n = num(v); return n === null ? "—" : `${n}`; };
const boolOr = (v: unknown): string => (v === true ? "是" : v === false ? "否" : "—");
const mediaTimeOr = (v: unknown): string => { const n = num(v); return n === null ? "—" : `${Math.round(n * 1000) / 1000}s`; };
const bucketOf = (d: Record<string, unknown>): string =>
  d.sr_engaged === true ? "SR 接管" : d.sr_engaged === false ? "判档直通" : "未标记";

export function formatHoldProfileLines(events: readonly HoldEvent[]): string[] {
  const pairs: { seq: number; profile: Record<string, unknown>; jank: Record<string, unknown> | null }[] = [];
  for (const e of events) {
    const name = e.name ?? e.event;
    if (name === "hold.release_profile") {
      pairs.push({ seq: pairs.length + 1, profile: e.data ?? {}, jank: null });
    } else if (name === "hold.jank") {
      /* 配最近一条尚未配对的剖面（尾窗行恒在其剖面之后 ~600ms）。 */
      for (let i = pairs.length - 1; i >= 0; i--) {
        if (pairs[i].jank === null) { pairs[i].jank = e.data ?? {}; break; }
      }
    }
  }
  const lines: string[] = [];
  for (const p of pairs.slice(-3)) {
    const d = p.profile;
    const bucket = bucketOf(d);
    lines.push(`松手剖面#${p.seq}[${bucket}]：首帧 ${msOr(d.release_to_first_frame_ms)} · SR 尝试 ${msOr(d.release_to_sr_attempt_ms)} · 尝试→呈现 ${msOr(d.sr_attempt_to_present_ms)} · SR 呈现 ${msOr(d.release_to_sr_present_ms)} · 长任务max ${msOr(d.longtask_max_ms)} · 预期呈现差 ${msOr(d.rvfc_expected_display_delta_ms)} · mediaTime ${mediaTimeOr(d.rvfc_media_time)} · SR 画布龄 ${msOr(d.sr_canvas_age_ms)} · 画布重挂 ${boolOr(d.sr_canvas_remounted)} · HLS 重建 ${boolOr(d.hls_rebuilt_during_window)}`);
    if (p.jank) {
      const j = p.jank;
      lines.push(`松手尾窗#${p.seq}[${bucket}]：期间 over33 ${countOr(j.over33)} · over50 ${countOr(j.over50)} · 期间 max ${msOr(j.max_gap_ms)} · 尾窗 over33 ${countOr(j.post_over33)} · over50 ${countOr(j.post_over50)} · 尾窗 max ${msOr(j.post_max_gap_ms)}`);
    }
  }
  return lines;
}
