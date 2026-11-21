/**
 * 模板取页 origin 声明（Muse 2026-11-19 fix321-F2c，验收 D 缺口 G1
 * 根治）：每个适配器模板除注册表 baseUrls 之外、还可能请求哪些
 * origin，在此跟模板一处声明——这些 host 是模板实现里写死的常数
 * （代码级事实），远程清单覆盖 baseUrls 无权削掉；生产取页白名单
 * 的派生（../allowlist.ts）把声明并入，清单落定与 builtin 落定
 * 两种状态下适配器能请求的 origin 全集都必须在白名单内。
 *
 * 现状盘点（逐模板核对 templates.ts 的 fetchPage 调用点）：
 * - chigua/wp-rest/hls-site/danbooru-api：全部取页都以
 *   baseUrls[0] 为基址拼相对路径，无额外 origin，声明为空。
 *   （wp-rest resolve 跟进正文 iframe 的绝对地址属内容派生、非
 *   模板常数，不在此声明——与修前口径一致，不放宽。）
 * - native-huangguo 不经 source_fetch、none 不取页。
 * （fix3314：hanime-api/iwara-api 两模板随视频板块整组删除同删，
 * 其三域声明与常数一并退役，见 fix3314/release-note-3314.md。）
 */

/** 模板 → baseUrls 之外的取页 origin 全集（规范化 origin 串）。 */
export const TEMPLATE_FETCH_ORIGINS: Readonly<Record<string, readonly string[]>> = {
  "native-huangguo": [],
  "chigua": [],
  "wp-rest": [],
  "hls-site": [],
  "danbooru-api": [],
  "none": [],
};

/** 经 fetchPage（Rust source_fetch）取页的模板集合：白名单派生只认
 * 这些模板的源——native 走仓内既有通道、none 不取页，
 * 其 baseUrls 不进 source_fetch 白名单。 */
export const FETCH_PAGE_TEMPLATES: readonly string[] = [
  "chigua", "wp-rest", "hls-site", "danbooru-api",];

export function templateFetchOrigins(template: string): string[] {
  return [...(TEMPLATE_FETCH_ORIGINS[template] ?? [])];
}

export function isFetchPageTemplate(template: string): boolean {
  return FETCH_PAGE_TEMPLATES.includes(template);
}
