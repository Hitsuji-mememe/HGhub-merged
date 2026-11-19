/* ── 取页错误分类（唯一出处，Muse 2026-11-19 fix321-F7 抽出）──
 * 原在 fetchHealth.ts 内；F7 源健康自检需要同一套分类口径而
 * fetchHealth 含诊断时间线导入（Tauri/react 链）、契约测试无法在
 * node 直加载。分类逻辑原样抽到本无依赖纯模块，fetchHealth 与
 * healthCheck 都从这里取——口径只有一份，不另造第二套。 */

export type FetchErrorCategory = "校验拒绝" | "网络不可达" | "HTTP 状态" | "超时" | "响应过大" | "其他";

/** Rust 侧错误串 → 粗粒度类别（关键词匹配，宁粗勿假）：错误串来自
 * 生产网络栈（目标校验/DNS/重定向复检/流式上限），类别只用于报告
 * 判读方向，不参与任何控制流。 */
export function classifyFetchError(raw: string): FetchErrorCategory {
  const s = raw.toLowerCase();
  if (/过大|超过|上限|too large|exceed/.test(s)) return "响应过大";
  if (/超时|timeout|timed out|deadline/.test(s)) return "超时";
  if (/校验|不允许|非法|禁止|内网|回环|scheme|invalid target|forbidden/.test(s)) return "校验拒绝";
  if (/\b(401|403|404|429|5\d\d)\b|http 状态|status/.test(s)) return "HTTP 状态";
  if (/dns|解析|connect|连接|网络|不可达|unreachable|reset|eof|tls|证书/.test(s)) return "网络不可达";
  return "其他";
}
