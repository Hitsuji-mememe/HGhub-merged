//! Shared UTC timestamps and the always-on debug journal.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use time::{format_description::well_known::Rfc3339, OffsetDateTime, UtcOffset};

static DEBUG_WRITER: Mutex<()> = Mutex::new(());

/// debug.log 轮转规格与 playback.log 统一（P2-17）：2MB 上限＋一份
/// previous。旧实现纯 append、无轮转无上限，长会话能涨无 bound。
const MAX_DEBUG_LOG: u64 = 2 * 1024 * 1024;

fn format_utc(at: OffsetDateTime) -> Result<String, String> {
    at.to_offset(UtcOffset::UTC)
        .format(&Rfc3339)
        .map_err(|_| "日志时间格式错误".to_string())
}

pub(crate) fn utc_timestamp() -> Result<String, String> {
    format_utc(OffsetDateTime::now_utc())
}

/// 日志层统一脱敏（P2-17，Muse 2026-11-19）：旧实现 append_debug
/// 本层零脱敏、靠各调用方自觉——Web 侧经 debug_log 命令直入的原文
/// （全局错误、带查询参数的 URL、上游报错）能把 token/直链带进
/// 日志。现日志层默认一道 scrub，口径与 net/redact 对齐：代理认证
/// 交 redact_error_proxy_auth；URL 查询参数整体剥除；token 状键值
/// （key=value / JSON "key": value / Bearer xxx）掩码。调用方从此
/// 不再各自负责脱敏。
fn scrub_debug(message: &str) -> String {
    let no_proxy_auth = crate::net::redact_error_proxy_auth(message);
    let mut out = String::with_capacity(no_proxy_auth.len());
    // "Bearer xxx" 的值是独立 token：记住上一个 token 是 Bearer 时
    // 把当前 token 整体掩码。
    let mut mask_next = false;
    for piece in no_proxy_auth.split_inclusive(|c: char| c.is_whitespace()) {
        let (token, sep) = match piece.find(|c: char| c.is_whitespace()) {
            Some(idx) => piece.split_at(idx),
            None => (piece, ""),
        };
        if mask_next && !token.is_empty() {
            out.push_str("[redacted]");
            mask_next = false;
        } else {
            out.push_str(&scrub_token(token));
        }
        let word = token
            .trim_matches(|c: char| !c.is_ascii_alphanumeric())
            .to_ascii_lowercase();
        if word == "bearer" {
            mask_next = true;
        }
        out.push_str(sep);
    }
    out
}

fn scrub_token(token: &str) -> String {
    let lower = token.to_ascii_lowercase();
    // JSON 键值："token": "xxx" / "authorization":"xxx"——冒号后整段掩码。
    for key in ["\"token\"", "\"password\"", "\"cookie\"", "\"authorization\"", "\"access_token\""] {
        if let Some(at) = lower.find(key) {
            let after = at + key.len();
            if let Some(colon) = token[after..].find(':') {
                return format!("{}: \"[redacted]\"", &token[..after + colon]);
            }
        }
    }
    // URL：剥查询参数（直链签名/token 多在 query 里）。
    let mut out = token.to_string();
    if out.contains("://") {
        if let Some(q) = out.find('?') {
            out.truncate(q);
        }
    }
    // key=value 键值：敏感键掩码值。
    if let Some(eq) = out.find('=') {
        let key = out[..eq]
            .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .to_ascii_lowercase();
        if matches!(
            key.as_str(),
            "token" | "access_token" | "password" | "passwd" | "cookie" | "authorization" | "auth_key" | "sign" | "signature"
        ) {
            return format!("{}=[redacted]", &out[..eq]);
        }
    }
    out
}

pub(crate) fn append_debug(dir: &Path, message: &str) -> Result<(), String> {
    let _writer = DEBUG_WRITER.lock().map_err(|_| "日志锁失败")?;
    fs::create_dir_all(dir).map_err(|_| "无法创建日志目录")?;
    let message = scrub_debug(message);
    let at = utc_timestamp()?;
    let prefix = format!("[{at}] [pid={}] ", std::process::id());
    let mut record = String::new();
    // Stamp continuation lines too, including stack traces, HTML errors and pretty JSON.
    for line in message.lines() {
        record.push_str(&prefix);
        record.push_str(line);
        record.push('\n');
    }
    if record.is_empty() {
        record.push_str(&prefix);
        record.push('\n');
    }
    // 轮转（与 playback_log 同规格）：写前预计超 2MB 先把现文件
    // 改名为 debug.previous.log（旧 previous 删除），再写新文件。
    let path = dir.join("debug.log");
    if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) + record.len() as u64 > MAX_DEBUG_LOG {
        let previous = dir.join("debug.previous.log");
        if previous.exists() {
            fs::remove_file(&previous).map_err(|_| "无法轮转调试日志")?;
        }
        if path.exists() {
            fs::rename(&path, &previous).map_err(|_| "无法轮转调试日志")?;
        }
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut f| f.write_all(record.as_bytes()))
        .map_err(|_| "无法写入调试日志".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn test_dir() -> std::path::PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "hghubx-debug-log-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn timestamps_are_utc_even_when_input_has_another_offset() {
        let instant = OffsetDateTime::from_unix_timestamp(0)
            .unwrap()
            .replace_nanosecond(123_456_789)
            .unwrap();
        for offset in [
            UtcOffset::UTC,
            UtcOffset::from_hms(8, 0, 0).unwrap(),
            UtcOffset::from_hms(-7, 0, 0).unwrap(),
        ] {
            assert_eq!(
                format_utc(instant.to_offset(offset)).unwrap(),
                "1970-01-01T00:00:00.123456789Z"
            );
        }
    }

    #[test]
    fn debug_errors_and_continuation_lines_have_utc_and_preserve_history() {
        let dir = test_dir();
        let path = dir.join("debug.log");
        fs::write(&path, "legacy entry without timestamp\n").unwrap();
        append_debug(&dir, "[api] api_feed → HTTP 503\r\n<html>\r\nerror\n").unwrap();
        append_debug(&dir, "[reject] failure\n    at handler").unwrap();
        append_debug(&dir, "").unwrap();
        let text = fs::read_to_string(&path).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines[0], "legacy entry without timestamp");
        assert_eq!(lines.len(), 7);
        for line in &lines[1..] {
            let (at, rest) = line.strip_prefix('[').unwrap().split_once("] ").unwrap();
            assert!(at.ends_with('Z'));
            assert!(at.contains('T'));
            assert!(rest.starts_with(&format!("[pid={}] ", std::process::id())));
            assert!(!line.contains('\r'));
        }
        assert!(lines[1].ends_with("[api] api_feed → HTTP 503"));
        assert!(lines[5].ends_with("    at handler"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn debug_log_scrubs_queries_tokens_and_bearer_values() {
        // P2-17：日志层默认脱敏——查询参数、token 状键值、Bearer 值、
        // JSON 键值都不许原样落盘；普通文本不受影响。
        let dir = test_dir();
        append_debug(
            &dir,
            "GET https://cdn.example/seg.ts?auth_key=abc123&x=1 failed token=zzz {\"token\": \"sekret\"} Authorization: Bearer hunter2 end",
        )
        .unwrap();
        let text = fs::read_to_string(dir.join("debug.log")).unwrap();
        for secret in ["abc123", "zzz", "sekret", "hunter2"] {
            assert!(!text.contains(secret), "秘密 {secret} 不许出现在 debug.log");
        }
        assert!(text.contains("https://cdn.example/seg.ts"));
        assert!(text.contains("end"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn debug_log_rotates_at_two_megabytes_keeping_one_previous() {
        // P2-17：与 playback.log 同规格——超 2MB 轮转，旧内容进
        // debug.previous.log，新内容写新文件。
        let dir = test_dir();
        let filler = "x".repeat(1024);
        for _ in 0..2100 {
            append_debug(&dir, &filler).unwrap();
        }
        assert!(dir.join("debug.previous.log").exists(), "超限必须轮转出 previous");
        let current = fs::metadata(dir.join("debug.log")).unwrap().len();
        assert!(current <= MAX_DEBUG_LOG, "当前文件不许超 2MB 规格, got {current}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_multiline_records_remain_together() {
        let dir = test_dir();
        let writers: Vec<_> = (0..4)
            .map(|worker| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    for entry in 0..8 {
                        append_debug(
                            &dir,
                            &format!("start {worker}/{entry}\nend {worker}/{entry}"),
                        )
                        .unwrap();
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        let text = fs::read_to_string(dir.join("debug.log")).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines.len(), 64);
        for pair in lines.chunks_exact(2) {
            assert_eq!(pair[1], pair[0].replace("start ", "end "));
            assert!(pair[0].contains("Z] [pid="));
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
