/**
 * 模板取页 origin 声明（Muse 2026-11-19 fix321-F2c，验收 D 缺口 G1
 * 根治）：每个适配器模板除注册表 baseUrls 之外、还可能请求哪些
 * origin，在此跟模板一处声明——这些 host 是模板实现里写死的常数
 * （代码级事实），远程清单覆盖 baseUrls 无权削掉；生产取页白名单
 * 的派生（../allowlist.ts）把声明并入，清单落定与 builtin 落定
 * 两种状态下适配器能请求的 origin 全集都必须在白名单内。
 *
 * 现状盘点（逐模板核对 templates.ts 的 fetchPage 调用点）：
 * - hanime-api（fix330）：取页跨三域——guest 目录 API、ct CSRF、
 *   auth 握手 POST（经 fetchPost 定向接缝、同一白名单把关），
 *   三 origin 全是模板写死常数，必须靠声明入白名单。
 * - iwara-api（fix330 接通批）：列表/搜索/详情只请求 API 基址；
 *   取流请求详情数据里的 fileUrl（files/filesq.iwara.tv，内容
 *   派生 host 但集合由公开协议证据钉死为两 host）——三 origin
 *   全靠声明入白名单（清单覆盖 baseUrls 削不掉）。
 * - chigua/wp-rest/hls-site/danbooru-api：全部取页都以
 *   baseUrls[0] 为基址拼相对路径，无额外 origin，声明为空。
 *   （wp-rest resolve 跟进正文 iframe 的绝对地址属内容派生、非
 *   模板常数，不在此声明——与修前口径一致，不放宽。）
 * - native-huangguo 不经 source_fetch、none 不取页。
 */

/** Iwara API 基址（templates.ts 回落值与本声明共用同一常数）。 */
export const IWARA_API_ORIGIN = "https://api.iwara.tv";
/** Iwara 文件 host（取流 fileUrl 的目标 origin——详情数据派生、
 * 非注册表 baseUrls，必须靠模板声明入白名单；filesq 为同站现行
 * 镜像 host，公开客户端证据同列）。 */
export const IWARA_FILES_ORIGIN = "https://files.iwara.tv";
export const IWARA_FILESQ_ORIGIN = "https://filesq.iwara.tv";

/** Hanime guest 目录 API 基址（hanimeApi.ts 与本声明共用同一常数；
 * fix330-hanime-api）：列表/搜索/详情走此域的 /api/v11/search_hvs
 * 全量目录（无签名纯 GET）。 */
export const HANIME_GUEST_ORIGIN = "https://guest.freeanimehentai.net";
/** Hanime CSRF 令牌域（hanimeApi.ts 握手第一步 GET /csrf-token）。 */
export const HANIME_CT_ORIGIN = "https://ct.hanime.tv";
/** Hanime 握手 POST 域（hanimeApi.ts 与本声明共用同一常数；
 * Rust 侧定向放行的 HANIME_AUTH_ORIGIN 与此同值、各自守界，
 * 见 src-tauri/src/api/source.rs）。 */
export const HANIME_AUTH_ORIGIN = "https://auth.hanime.tv";

/** 模板 → baseUrls 之外的取页 origin 全集（规范化 origin 串）。 */
export const TEMPLATE_FETCH_ORIGINS: Readonly<Record<string, readonly string[]>> = {
  "native-huangguo": [],
  "chigua": [],
  "wp-rest": [],
  "hls-site": [],
  "danbooru-api": [],
  "hanime-api": [HANIME_GUEST_ORIGIN, HANIME_CT_ORIGIN, HANIME_AUTH_ORIGIN],
  "iwara-api": [IWARA_API_ORIGIN, IWARA_FILES_ORIGIN, IWARA_FILESQ_ORIGIN],
  "none": [],
};

/** 经 fetchPage（Rust source_fetch）取页的模板集合：白名单派生只认
 * 这些模板的源——native 走仓内既有通道、none 不取页，
 * 其 baseUrls 不进 source_fetch 白名单。 */
export const FETCH_PAGE_TEMPLATES: readonly string[] = [
  "chigua", "wp-rest", "hls-site", "danbooru-api", "hanime-api",
  "iwara-api",];

export function templateFetchOrigins(template: string): string[] {
  return [...(TEMPLATE_FETCH_ORIGINS[template] ?? [])];
}

export function isFetchPageTemplate(template: string): boolean {
  return FETCH_PAGE_TEMPLATES.includes(template);
}
