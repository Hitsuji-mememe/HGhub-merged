//! 业务命令：列表 / 详情 / 播放。
//!
//! Commands live in domain modules; `lib.rs` still registers them through
//! the re-exports below, so Tauri command names stay unchanged.
//! 账号体系已于 3.3.0 拆除、用户恒游客：原 account/interact 命令与
//! SessionStore 会话本体已于 fix3311/registry-cleanup 整体删除——
//! 12 个命令在 TS 侧零调用点、会话唯一写入口随之不可达，游客请求
//! 链恒不带凭据（本模块 get/post 恒以 None 调 edge，与旧树会话恒
//! 空时的线上行为逐字一致）；证伪证据见
//! ~/workspace/hghub/fix3311/evidence/registry-cleanup.md。

pub(crate) mod feed;
pub(crate) mod lines;
pub(crate) mod platform;
pub(crate) mod source;
pub(crate) mod update;
pub(crate) mod video;

#[allow(unused_imports)]
pub use feed::*;
#[allow(unused_imports)]
pub use lines::*;
#[allow(unused_imports)]
pub use platform::*;
#[allow(unused_imports)]
pub use source::*;
#[allow(unused_imports)]
pub use update::*;
#[allow(unused_imports)]
pub use video::*;

use crate::net::{base, edge};
use serde_json::Value;

pub struct Api;

impl Api {
    pub fn new() -> Self {
        Self
    }

    /// POST 信封：新播放接口 /api/videos/{id}/episodes/{ep}/playback 需要。
    async fn post(&self, path: &str, body: Option<Value>) -> Result<Value, String> {
        let origin = base();
        edge(&origin, "POST", path, body, None).await
    }

    async fn get(&self, path: &str) -> Result<Value, String> {
        let origin = base();
        edge(&origin, "GET", path, None, None).await
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    #[test]
    fn frontend_cannot_bypass_url_policy_with_opener_commands() {
        let capability: Value =
            serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap();
        for permission in capability["permissions"].as_array().unwrap() {
            let name = permission
                .as_str()
                .or_else(|| permission["identifier"].as_str())
                .unwrap();
            assert!(
                !name.starts_with("opener:"),
                "frontend opener command exposed: {name}"
            );
        }
    }

    #[test]
    fn external_links_are_urls_not_shell_commands() {
        for raw in [
            "https://example.com/|calc.exe",
            "https://example.com/?a=1&b=2",
            "https://example.com/%25PATH%25",
            "https://example.com/%VAR%",
        ] {
            assert!(crate::network_policy::parse_target(raw).is_ok());
        }
        for raw in [
            "file:///etc/passwd",
            "mailto:user@example.com",
            "tel:123",
            "data:text/html,test",
            "javascript:alert(1)",
            "https://example.com/\0cmd",
            "https://user:password@example.com/",
        ] {
            assert!(crate::network_policy::parse_target(raw).is_err());
        }
    }
}
