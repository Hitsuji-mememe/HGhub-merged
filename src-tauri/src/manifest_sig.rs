//! 远程清单 Ed25519 验签（fix3317，2026-11-21；GPT 源码核验 P1 收口）。
//!
//! 信任根：发布公钥固化在本模块常量里，随 IPA 发布；私钥只在发布机
//! （~/workspace/hghub/registry-signing/ed25519-private.pem，600 权限、
//! 不进 git/IPA）。签名形态：清单顶层 `signature` 字段（base64），
//! 签的是「去掉 signature 字段后的规范化清单内容」——规范化口径与
//! 发布脚本 ~/workspace/hghub/remote-manifest/canonical-json.mjs 逐字
//! 同构（对象键递归排序、无空白、原语走 JSON 序列化）。浮点不出现在
//! 清单里；清单形态变更引入浮点时两侧须同步复核本口径。
//!
//! 本模块只依赖 serde_json / ed25519-dalek / base64，可独立编译验证
//! （发布前离线回读线上清单原件即复用本文件的 canonicalize/verify）。
//! 前端接线：manifest.ts 在 validate/apply 远程清单前经
//! `manifest_verify_signature` 命令调用 verify_manifest；返回 false
//! （无签名/格式坏/验不过）一律视为远程失败，走 last-good → builtin
//! 回退链，不半应用。防回滚仍由前端既有版本比较承担，本模块不管。

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::Value;

/// 发布公钥（Ed25519，32B）。与 registry-signing/ed25519-public.txt 同值。
const MANIFEST_PUBKEY: [u8; 32] = [
    66, 157, 176, 45, 209, 115, 207, 163, 144, 185, 132, 149, 121, 199, 226, 145, 31, 115, 35, 23,
    45, 21, 135, 76, 67, 159, 182, 245, 169, 193, 140, 136,
];

/// 规范化序列化：对象键按字节序（清单键均为 ASCII，与 JS 侧 UTF-16
/// 码元序一致）递归排序；字符串经 serde_json 序列化（转义集合与
/// JSON.stringify 一致：仅 `"`、`\` 与控制字符）；数字走 Number 的
/// Display（整数形态与 JS 一致）。
pub fn canonicalize(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(items) => {
            let inner: Vec<String> = items.iter().map(canonicalize).collect();
            format!("[{}]", inner.join(","))
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let inner: Vec<String> = keys
                .iter()
                .map(|k| {
                    let key_json =
                        serde_json::to_string(k.as_str()).unwrap_or_else(|_| "\"\"".to_string());
                    format!("{}:{}", key_json, canonicalize(&map[*k]))
                })
                .collect();
            format!("{{{}}}", inner.join(","))
        }
    }
}

/// 待验字节：去掉顶层 signature 字段后的规范化清单。
pub fn signing_payload(manifest: &Value) -> Vec<u8> {
    let mut rest = manifest.clone();
    if let Value::Object(ref mut map) = rest {
        map.remove("signature");
    }
    canonicalize(&rest).into_bytes()
}

/// 验签入口：signature 字段须为 base64 字符串且解码后恰 64B；任一
/// 环节不合 → false（不 panic、不报错外泄细节，调用方只认布尔）。
pub fn verify_manifest(manifest: &Value) -> bool {
    let Some(sig_b64) = manifest.get("signature").and_then(Value::as_str) else {
        return false;
    };
    let Ok(sig_bytes) = B64.decode(sig_b64) else {
        return false;
    };
    let Ok(sig_array) = <[u8; 64]>::try_from(sig_bytes.as_slice()) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&MANIFEST_PUBKEY) else {
        return false;
    };
    let signature = Signature::from_bytes(&sig_array);
    key.verify_strict(&signing_payload(manifest), &signature).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonicalize_sorts_keys_recursively() {
        let v = json!({"b": 1, "a": {"d": [1, 2], "c": "x"}});
        assert_eq!(canonicalize(&v), "{\"a\":{\"c\":\"x\",\"d\":[1,2]},\"b\":1}");
    }

    #[test]
    fn unsigned_manifest_rejected() {
        assert!(!verify_manifest(&json!({"manifestVersion": 11, "sources": []})));
    }

    #[test]
    fn malformed_signature_rejected() {
        assert!(!verify_manifest(&json!({"manifestVersion": 11, "signature": "not-base64!!"})));
        assert!(!verify_manifest(&json!({"manifestVersion": 11, "signature": "AAAA"})));
        assert!(!verify_manifest(&json!({"manifestVersion": 11, "signature": 42})));
    }
}
