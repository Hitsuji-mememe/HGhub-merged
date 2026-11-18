//! 门3 账本完整性（Muse 2026-11-19，AVFoundation 混合路线验证原型）：
//! 自检会话期间，回环媒体服务在 serve() 入口独立计数每个已解析请求，
//! 并在媒体响应出口逐条记账（类别/状态/字节数），会话结束时两数对账——
//! 记账钩子若漏记，缺口立即显形；播放列表侧另统计「应请求分片数」，
//! 与实际分片响应数并列报告（AVPlayer 预取/中途停止会造成正差，不等同
//! 于记账缺口，报告里分开列）。
//!
//! 纪律：只记路径类别（/hls、/seg）、状态与字节数，绝不记 u= 内容、
//! 完整 URL 或任何凭据（仓规不变量 10）。无会话时全部函数为无操作，
//! 正式播放路径行为零变化。

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtoEntry {
    pub seq: u64,
    /// master | media | segment
    pub kind: &'static str,
    /// 只记路由名（/hls 或 /seg），不记查询串。
    pub path: String,
    pub status: u16,
    pub bytes: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtoReport {
    pub session_id: String,
    pub duration_ms: u64,
    /// serve() 入口独立计数（已解析的 /hls、/seg 请求总数）。
    pub independent_requests: u64,
    /// 记账条数（独立于保留窗口的单调计数）。
    pub recorded_responses: u64,
    /// independent - recorded；>0 即记账钩子漏记。
    pub missing_responses: u64,
    pub master_playlists: u64,
    pub media_playlists: u64,
    pub variant_count_max: u64,
    /// 媒体播放列表里 #EXTINF 段数合计（应请求分片数）。
    pub expected_segments: u64,
    pub segment_responses: u64,
    /// expected - segment_responses；含预取未取/中途停止等正常差。
    pub segment_gap: i64,
    pub error_responses: u64,
    pub entries: Vec<ProtoEntry>,
}

struct Session {
    id: String,
    started_ms: u64,
    independent: u64,
    recorded: u64,
    master: u64,
    media_playlists: u64,
    variants_max: u64,
    expected_segments: u64,
    segments: u64,
    errors: u64,
    entries: Vec<ProtoEntry>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
const MAX_ENTRIES: usize = 512;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 会话 id 生成用（lib.rs 命令层拼 proto-<ms>）。
pub fn now_ms_pub() -> u64 {
    now_ms()
}

pub fn begin(id: String) {
    *SESSION.lock().unwrap() = Some(Session {
        id,
        started_ms: now_ms(),
        independent: 0,
        recorded: 0,
        master: 0,
        media_playlists: 0,
        variants_max: 0,
        expected_segments: 0,
        segments: 0,
        errors: 0,
        entries: Vec::new(),
    });
}

/// serve() 入口的独立计数：每个通过解析的 /hls、/seg 请求 +1，
/// 与记账出口分开，专为对账。
pub fn note_request() {
    if let Some(session) = SESSION.lock().unwrap().as_mut() {
        session.independent += 1;
    }
}

fn count_occurrences(haystack: &[u8], needle: &[u8]) -> u64 {
    if needle.is_empty() || haystack.len() < needle.len() {
        return 0;
    }
    haystack
        .windows(needle.len())
        .filter(|window| *window == needle)
        .count() as u64
}

/// 媒体响应出口记账：按响应体分类（播放列表看 #EXTM3U 头，其余为分片）。
pub fn note_response(path: &str, status: u16, body: &[u8]) {
    let mut guard = SESSION.lock().unwrap();
    let Some(session) = guard.as_mut() else { return };
    session.recorded += 1;
    if status >= 400 {
        session.errors += 1;
    }
    let kind = if body.starts_with(b"#EXTM3U") {
        if count_occurrences(body, b"#EXT-X-STREAM-INF") > 0 {
            session.master += 1;
            let variants = count_occurrences(body, b"#EXT-X-STREAM-INF");
            session.variants_max = session.variants_max.max(variants);
            "master"
        } else {
            session.media_playlists += 1;
            session.expected_segments += count_occurrences(body, b"#EXTINF");
            "media"
        }
    } else {
        session.segments += 1;
        "segment"
    };
    if session.entries.len() < MAX_ENTRIES {
        session.entries.push(ProtoEntry {
            seq: session.recorded,
            kind,
            path: path.to_owned(),
            status,
            bytes: body.len(),
        });
    }
}

pub fn finish() -> Option<ProtoReport> {
    let session = SESSION.lock().unwrap().take()?;
    Some(ProtoReport {
        session_id: session.id,
        duration_ms: now_ms().saturating_sub(session.started_ms),
        independent_requests: session.independent,
        recorded_responses: session.recorded,
        missing_responses: session.independent.saturating_sub(session.recorded),
        master_playlists: session.master,
        media_playlists: session.media_playlists,
        variant_count_max: session.variants_max,
        expected_segments: session.expected_segments,
        segment_responses: session.segments,
        segment_gap: session.expected_segments as i64 - session.segments as i64,
        error_responses: session.errors,
        entries: session.entries,
    })
}
