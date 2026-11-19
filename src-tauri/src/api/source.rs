//! 多源适配器取页命令（audit6 模块化与源注册表节）。
//!
//! 外部站点的页面只能经此命令取：底层走生产网络栈
//! （net::fetch_page_text_with_headers —— 目标校验/DNS 固定/逐跳
//! 重定向复检/4MB 流式上限），适配器不得另开任何直连旁路。
//!
//! 前端契约（features/sources/adapters/fetchPage.ts 的 FetchPage）：
//! 启动处以 invoke("source_fetch", { url }) 注入；headers 可选，
//! 适配器需要 Referer/User-Agent 等头时以键值对象传入，缺省即无头。

use std::collections::HashMap;

/// 取一个外部站点页面并以文本返回（UTF-8 lossy）。
/// 签名：source_fetch(url: string, headers?: Record<string, string>)
///   -> Promise<string>；失败 reject 为错误字符串（HTTP 状态/策略拒绝/
///   超限/头无效）。只许 http/https（由生产栈 parse_target 校验）。
#[tauri::command]
pub async fn source_fetch(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<String, String> {
    let headers: Vec<(String, String)> = headers
        .unwrap_or_default()
        .into_iter()
        .collect();
    crate::net::fetch_page_text_with_headers(&url, &headers).await
}
