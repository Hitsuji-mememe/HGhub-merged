/* 列表请求超时护栏（Muse 2026-11-19 fix2 A2 推广）：手写分页点
 * （频道/专题/标签/搜索/首页/评论）与 usePaginatedList 同病——请求
 * 无超时时慢线悬挂会把 busy/loading 锁永久堵死。统一 30s 竞速：
 * 超时即抛错走各调用方既有 catch/finally（释放锁、置错误态），
 * 迟到的原响应被 Promise.race 丢弃、不再进入调用方后续逻辑。 */
export const LIST_REQUEST_TIMEOUT_MS = 30_000;

export class RequestTimeoutError extends Error {
  constructor(ms: number = LIST_REQUEST_TIMEOUT_MS) {
    super(`请求超过 ${Math.round(ms / 1000)}s 未返回`);
    this.name = "RequestTimeoutError";
  }
}

export function withRequestTimeout<T>(p: Promise<T>, ms: number = LIST_REQUEST_TIMEOUT_MS): Promise<T> {
  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new RequestTimeoutError(ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => window.clearTimeout(timer));
}
