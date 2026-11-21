/**
 * 适配器取页层——全源唯一收敛点（Muse 2026-11-19 根治包·多源线 条目4）。
 *
 * 现状（已核查）：仓内 Web 侧取外部页只有两条既有通道——
 * ① Tauri invoke 命令（src/shared/api/api.ts，命令集为黄果上游专用，
 *    没有通用取页命令）；② 本地媒体协议 LOCAL（/img /hls /seg，
 *    只服务媒体流与封面，AGENTS 不变量 5/6 禁止扩成通用开放代理）。
 * 因此 Web 侧不存在合规的通用取页通道，适配器一律经本函数取页，
 * 默认实现明确抛错（不许裸 fetch 绕过网络策略）。Rust 受控取页命令
 * source_fetch 已落地（走生产栈 get_with_dns：目标校验/DNS 固定/逐跳
 * 重定向复检＋4MB 流式上限），应用启动处（src/main.tsx）已以
 * invoke("source_fetch", { url }) 注入本函数，全源生效。契约测试同样
 * 经 setFetchPage 注入夹具，不碰真实网络。
 */
/* 契约对齐（Muse 2026-11-19 整改 D6.3，G5 P2-4）：与 Rust 命令
 * source_fetch(url, headers?) 签名一致——headers 可选第二参，适配器
 * 需要 Referer/User-Agent 等头时传入；不传即无头，现有调用不受影响。
 * Rust 侧只放行 Referer/User-Agent/Accept/Accept-Language，其余头
 * 丢弃（X-Version 定向例外已随 Iwara 源于 fix3314 整删，见 api/source.rs）。 */
export type FetchPage = (url: string, headers?: Record<string, string>) => Promise<string>;

export class SourceFetchChannelUnavailableError extends Error {
  constructor(url: string) {
    super(`源取页通道未接入：仓内无通用取页 Tauri 命令，无法获取 ${safeHost(url)}（待 Rust 受控取页命令落地后在 fetchPage.ts 一处注入）`);
    this.name = "SourceFetchChannelUnavailableError";
  }
}

function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return "(invalid url)"; }
}

let impl: FetchPage = async (url) => {
  throw new SourceFetchChannelUnavailableError(url);
};

export function setFetchPage(fn: FetchPage): void {
  impl = fn;
}

export function fetchPage(url: string, headers?: Record<string, string>): Promise<string> {
  return impl(url, headers);
}
