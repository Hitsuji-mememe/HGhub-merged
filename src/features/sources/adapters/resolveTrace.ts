/* ── 取流辅助：生产取页错误文本的 HTTP 状态提取（共享落点）──
 * 本文件原为取流分段留痕设施（traceResolveFailure／
 * resolveFailureEventData，fix331-hanime-403 立、fix333-m5 抽共
 * 享）：适配器 resolve 各段失败落 source.resolve_fail 事件、由诊
 * 断导出「取流失败留痕」节结构化消费。其全部生产调用方（002
 * hanimeApi 与 wp-rest jw 分支）已随 fix3314 视频板块整组删除退
 * 场，写侧成无调用方死设施——fix3314 全方面审计 A1 裁定整删
 * （2026-11-21 阶段二执行）。读侧保留在位：resolveFailLines 的
 * 留痕节仍消费 Rust 媒体层清单腿（media/hls.rs，fix338 签名③）
 * 发出的同名事件（segment=manifest）与历史日志里的旧事件，段名
 * 标签表为旧日志可读性保留。
 * 本文件现只剩 httpStatusOf：wp-rest 适配器（templates）消费，
 * 勿随留痕删除误伤。 */

/** 生产取页栈折叠错误文本里的 HTTP 状态（fetchPage 失败形态
 * 恒为 "HTTP <n>"，见 net/edge）；提取不到回 undefined，不猜。 */
export function httpStatusOf(error: unknown): number | undefined {
  const m = /^HTTP (\d{3})$/.exec(error instanceof Error ? error.message : String(error));
  return m ? Number(m[1]) : undefined;
}
