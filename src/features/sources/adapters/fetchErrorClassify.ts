/* ── 取页错误分类（唯一出处，Muse 2026-11-19 fix321-F7 抽出）──
 * 原在 fetchHealth.ts 内；F7 源健康自检需要同一套分类口径而
 * fetchHealth 含诊断时间线导入（Tauri/react 链）、契约测试无法在
 * node 直加载。分类逻辑原样抽到本无依赖纯模块，fetchHealth 与
 * healthCheck 都从这里取——口径只有一份，不另造第二套。 */

export type FetchErrorCategory = "校验拒绝" | "网络不可达" | "HTTP 状态" | "超时" | "响应过大" | "其他";

/** Rust 侧错误串 → 粗粒度类别（关键词匹配，宁粗勿假）：错误串来自
 * 生产网络栈（目标校验/DNS/重定向复检/流式上限），类别只用于报告
 * 判读方向，不参与任何控制流。
 *
 * 判序（Muse 2026-11-20 fix336 集成裁定）：HTTP 状态码先判、其余
 * 词元后判。原序把「校验拒绝」排在状态码之前，而 403 的原因短语
 * Forbidden 恰命中校验词元 forbidden——响应完整到达的干净 403
 * （如 `Error: HTTP 403 Forbidden`，fix336 线 A 本机实拉三源实证）
 * 被误标校验拒绝、自检再归并成「网络类」，把站点拒绝读成网络不通。
 * 状态码是响应已到达的硬证据，优先于一切原因短语词元；校验拒绝的
 * 真实错误串（目标校验在发请求前拒绝）不含状态码，不受影响。 */
export function classifyFetchError(raw: string): FetchErrorCategory {
  const s = raw.toLowerCase();
  if (/\b(401|403|404|429|5\d\d)\b|http 状态|status/.test(s)) return "HTTP 状态";
  if (/过大|超过|上限|too large|exceed/.test(s)) return "响应过大";
  if (/超时|timeout|timed out|deadline/.test(s)) return "超时";
  if (/校验|不允许|非法|禁止|内网|回环|scheme|invalid target|forbidden/.test(s)) return "校验拒绝";
  if (/dns|解析|connect|连接|网络|不可达|unreachable|reset|eof|tls|证书/.test(s)) return "网络不可达";
  return "其他";
}
