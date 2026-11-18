use serde::{Deserialize, Serialize};

/// 门1/门2 自检的入参：回环媒体地址（由前端经 media_http_origin + 播放
/// 路由拼出，与正式原生降级路径同源）。URL 只在本机回环内传递，不落日志。
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtoLoadRequest {
  pub url: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtoLoadResponse {
  pub started: bool,
}

/// status / close 无入参；回参是 Swift 侧的自由 JSON（检查项与帧统计），
/// Rust 侧只透传，避免两侧 schema 漂移导致原型误红。
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtoEmptyRequest {}

pub type ProtoStatusResponse = serde_json::Value;
