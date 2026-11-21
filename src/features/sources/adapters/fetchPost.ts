/**
 * 适配器定向 POST 接缝（Muse 2026-11-19 fix330-hanime-api）。
 *
 * fetchPage（GET）契约解决不了 Hanime 官方播放握手：它必须 POST
 * 一个加密信封到 auth.hanime.tv 并读回 x-token 响应头。本接缝是全仓
 * 唯一的 POST 出口，Rust 侧 source_post 命令与之对齐收紧：
 * - 目标 origin 必须在生效注册表白名单内且恰为 auth.hanime.tv，
 *   其余 origin 一律拒绝（不是通用 POST 通道）；
 * - 请求头只放行固定名单（Referer/Origin/Content-Type/x-signature/
 *   x-signature-version/x-time/x-csrf-token），其余丢弃；
 * - 响应只回 { status, body, xToken }——x-token 是唯一被回传的
 *   响应头；状态不折叠成错误，适配器据正文判读 CSRF 重试；
 * - 请求体上限 64KB（Rust 侧），正文/令牌不入任何日志（不变量 10）。
 * 默认实现明确抛错；应用启动处（src/main.tsx）以 invoke 注入，
 * 契约测试经 setFetchPost 注入夹具，不碰真实网络。
 */
export interface FetchPostResult {
  status: number;
  body: string;
  xToken: string | null;
}

export type FetchPost = (
  url: string,
  body: string,
  headers?: Record<string, string>,
) => Promise<FetchPostResult>;

export class SourcePostChannelUnavailableError extends Error {
  constructor(url: string) {
    super(`源 POST 通道未接入：无法向 ${safeHost(url)} 发起定向握手 POST（待启动处注入 source_post 后生效）`);
    this.name = "SourcePostChannelUnavailableError";
  }
}

function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return "(invalid url)"; }
}

let impl: FetchPost = async (url) => {
  throw new SourcePostChannelUnavailableError(url);
};

export function setFetchPost(fn: FetchPost): void {
  impl = fn;
}

export function fetchPost(url: string, body: string, headers?: Record<string, string>): Promise<FetchPostResult> {
  return impl(url, body, headers);
}
