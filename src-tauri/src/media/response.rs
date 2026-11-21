//! Protocol responses, byte ranges and playlist/segment response shaping.

use tauri::http::{Response, StatusCode};

use super::hls::{is_playlist_bytes, rewrite_playlist};

/// 目标 URL 的路径是否声称为播放列表（.m3u8 结尾，忽略查询串/
/// 片段与大小写）：与 ctype 并列的「声称清单」判据（fix338 签名①）。
fn target_claims_playlist(target: &str) -> bool {
    let path = target.split(['?', '#']).next().unwrap_or(target);
    path.to_ascii_lowercase().ends_with(".m3u8")
}

// Linux can selectively clear WebKit's durable cache, so proxied media must not
// regrow it without bound. Other platforms lack that safe clearing path here;
// keep the original WebKit disk-cache fallback for native HLS and seeks.
#[cfg(target_os = "linux")]
pub(super) const PROXIED_MEDIA_CACHE_CONTROL: &str = "no-store";
#[cfg(not(target_os = "linux"))]
pub(super) const PROXIED_MEDIA_CACHE_CONTROL: &str = "public, max-age=3600";

#[cfg(target_os = "linux")]
pub(super) const PROXIED_IMAGE_CACHE_CONTROL: &str = "no-store";
#[cfg(not(target_os = "linux"))]
pub(super) const PROXIED_IMAGE_CACHE_CONTROL: &str = "public, max-age=86400";

/* ───────────────────────── 协议响应 ───────────────────────── */

pub(super) fn respond(status: u16, ctype: &str, body: Vec<u8>, cache: &str) -> Response<Vec<u8>> {
    let len = body.len().to_string();
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK))
        .header("Content-Type", ctype)
        // 长度以最终响应字节为准；播放列表始终完整返回，媒体分片支持 Range。
        .header("Content-Length", len)
        .header("Access-Control-Expose-Headers", "Content-Length, Content-Type, Accept-Ranges, Content-Range")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", cache)
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// 为原生播放器提供单段 byte range；无效/多段范围按 HTTP 语义退回完整 200。
pub(super) fn apply_byte_range(mut response: Response<Vec<u8>>, range: Option<&str>) -> Response<Vec<u8>> {
    use tauri::http::HeaderValue;

    if response.status() != StatusCode::OK {
        return response;
    }
    // A native HLS loader may send a byte probe for a playlist. Returning only
    // its first bytes hides #EXTM3U and nested URLs, so both /hls and playlists
    // discovered through /seg must remain complete 200 responses.
    if response.headers().get("Content-Type").and_then(|v| v.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("mpegurl"))
    {
        return response;
    }
    response.headers_mut().insert("Accept-Ranges", HeaderValue::from_static("bytes"));
    let Some((first, last)) = range
        .and_then(|v| v.trim().strip_prefix("bytes="))
        .and_then(|v| v.split_once('-'))
    else {
        return response;
    };
    let number = |s: &str| -> Option<usize> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            None
        } else {
            s.parse().ok()
        }
    };
    let len = response.body().len();
    let bounds = if first.is_empty() {
        let Some(suffix) = number(last) else { return response };
        (suffix > 0 && len > 0).then(|| (len.saturating_sub(suffix), len - 1))
    } else {
        let Some(start) = number(first) else { return response };
        let end = if last.is_empty() {
            len.saturating_sub(1)
        } else {
            let Some(end) = number(last) else { return response };
            if end < start { return response; }
            end
        };
        (start < len).then(|| (start, end.min(len - 1)))
    };

    let content_range = if let Some((start, end)) = bounds {
        // 原响应已经持有完整字节；原位截取，避免再复制完整视频分片。
        let body = response.body_mut();
        body.truncate(end + 1);
        if start > 0 {
            body.drain(..start);
        }
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
        format!("bytes {start}-{end}/{len}")
    } else {
        response.body_mut().clear();
        *response.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
        response.headers_mut().insert("Cache-Control", HeaderValue::from_static("no-store"));
        format!("bytes */{len}")
    };
    let length = response.body().len().to_string();
    response.headers_mut().insert("Content-Length", HeaderValue::from_str(&length).unwrap());
    response.headers_mut().insert("Content-Range", HeaderValue::from_str(&content_range).unwrap());
    response
}

/// 主清单的子清单也经 /seg 返回：必须继续改写，不能把内层 URL 原样交给播放器。
pub(super) fn segment_response(
    target: &str,
    ctype: Option<&str>,
    bytes: Vec<u8>,
    origin: &str,
) -> Response<Vec<u8>> {
    /* 内容形态守卫（fix337/video-resolve，3.3.6 真机 source-011
     * 形态乙）：/seg 目标回 200＋HTML 文档（防盗链落地页/挑战页）
     * 时，旧实现按上游 ctype 原样以媒体 200 返回——变体清单位
     * 置上 hls.js 报 levelParsingError「Missing format
     * identifier #EXTM3U」、分片位置上下载成功却永不入缓冲。
     * HTML 文档恒不是清单/分片/Key，先于 ctype 判读直接 502，
     * 与 /hls 的 #EXTM3U 校验、fetch_bytes 的 HTML 候选链同口径：
     * 非播放列表不当成功。 */
    if crate::net::is_html_document(&bytes) {
        return respond(
            502,
            "text/plain",
            "响应为 HTML 文档而非媒体字节".as_bytes().to_vec(),
            "no-store",
        );
    }
    /* 魔数复验（fix338 签名①，调查 fix338/investigation-338.md）：
     * 旧 playlist 判定是「ctype 含 mpegurl 或魔数命中」二选一、
     * 分支内从不复验——非 doctype 前缀的网页体（脚本页/<head>
     * 页/纯文本/JSON 错误体）绕过上面的窄前缀 HTML 判别后，
     * 只要上游 ctype 标 mpegurl 就被当清单改写成一条代理 URL
     * 以 200 返回，hls.js 在变体清单位上必然 levelParsingError
     * （3.3.7 真机 source-011）。现凡「声称清单」（ctype 含
     * mpegurl 或目标路径以 .m3u8 结尾）而 #EXTM3U 魔数不符 →
     * 502；魔数判别与 load_playlist 共用 hls::is_playlist_bytes，
     * 全仓一份实现。未声称清单的普通媒体体行为不变。 */
    let claims_playlist = ctype.is_some_and(|t| t.to_ascii_lowercase().contains("mpegurl"))
        || target_claims_playlist(target);
    if claims_playlist && !is_playlist_bytes(&bytes) {
        return respond(
            502,
            "text/plain",
            "响应声称为 HLS 播放列表但内容不是播放列表".as_bytes().to_vec(),
            "no-store",
        );
    }
    let playlist = is_playlist_bytes(&bytes);
    if playlist {
        return match std::str::from_utf8(&bytes) {
            Ok(text) => respond(
                200,
                "application/vnd.apple.mpegurl",
                rewrite_playlist(target, text, origin).into_bytes(),
                PROXIED_MEDIA_CACHE_CONTROL,
            ),
            Err(_) => respond(
                502,
                "text/plain",
                b"invalid playlist encoding".to_vec(),
                "no-store",
            ),
        };
    }
    /* 媒体文件目标的类型归一（fix3311/file-leg-fix）：整段路径的
     * ctype 来自上游（download_segment 仅在上游缺省时按扩展名兜
     * 底）——021 形态的 octet-stream 在此原样透传会与 ranged 路径
     * 同病（code 4 拒收）。仅媒体文件目标在末支归一，清单/Key/分
     * 片（.ts/.m4s/.m3u8）逐字不变。 */
    let mime = if super::segment::is_media_file_target(target) {
        media_mime_for_target(target, ctype)
    } else {
        ctype.unwrap_or("application/octet-stream").to_string()
    };
    respond(200, &mime, bytes, PROXIED_MEDIA_CACHE_CONTROL)
}

/// 媒体文件目标的响应类型归一（Muse 2026-11-21 fix3311/file-leg-fix）：
/// 上游类型已是 video/* 时原样透传；泛类型（application/octet-stream、
/// 缺失、其他非视频类型）按目标扩展名映射为对应 video/*——021 上游
/// 对一切 Range 请求恒回 octet-stream，App 侧原样透传又带 nosniff
/// （respond 恒置），媒体元素以 MEDIA_ERR_SRC_NOT_SUPPORTED（code 4）
/// 拒收（3.3.10 真机定案，调查 fix3311 §A）。映射表与
/// segment::is_media_file_target 的扩展名集同界；不在集内的目标
/// 保持上游值（或 octet-stream 缺省），行为不变。
pub(super) fn media_mime_for_target(target: &str, upstream: Option<&str>) -> String {
    if let Some(raw) = upstream {
        let base = raw.split(';').next().unwrap_or(raw).trim();
        if base.to_ascii_lowercase().starts_with("video/") {
            return raw.to_string();
        }
    }
    let path = target
        .split(['?', '#'])
        .next()
        .unwrap_or(target)
        .to_ascii_lowercase();
    if path.ends_with(".mp4") || path.ends_with(".m4v") {
        "video/mp4".to_string()
    } else if path.ends_with(".mov") {
        "video/quicktime".to_string()
    } else if path.ends_with(".webm") {
        "video/webm".to_string()
    } else if path.ends_with(".mkv") {
        "video/x-matroska".to_string()
    } else {
        upstream.unwrap_or("application/octet-stream").to_string()
    }
}

/// ranged 直通的 206 整形（Muse 2026-11-21 fix3310/file-playback-leg）：
/// 上游已按请求区间回字节（segment::load_segment_ranged），这里只
/// 补 Content-Range/Accept-Ranges 并以窗口字节为体；状态 206 使
/// handle 末端的 apply_byte_range 原样直通（其只整形 200）。
/// 调用方保证 bytes 非空且 start+len-1 < total。响应类型经
/// media_mime_for_target 归一（fix3311，见其注）。
pub(super) fn range_window_response(
    target: &str,
    ctype: Option<&str>,
    bytes: Vec<u8>,
    start: u64,
    total: u64,
) -> Response<Vec<u8>> {
    use tauri::http::HeaderValue;
    let end = start + bytes.len() as u64 - 1;
    let mut response = respond(
        206,
        &media_mime_for_target(target, ctype),
        bytes,
        PROXIED_MEDIA_CACHE_CONTROL,
    );
    response
        .headers_mut()
        .insert("Accept-Ranges", HeaderValue::from_static("bytes"));
    response.headers_mut().insert(
        "Content-Range",
        HeaderValue::from_str(&format!("bytes {start}-{end}/{total}"))
            .unwrap_or_else(|_| HeaderValue::from_static("bytes */*")),
    );
    response
}

/// HEAD 元信息响应（Muse 2026-11-21 fix3311/file-leg-fix）：媒体
/// 文件目标的 HEAD 只回头不回体——Content-Length 写文件总长（而
/// 非空体长度，覆盖 respond 的体长值）、类型经 media_mime_for_
/// target 归一、Accept-Ranges 声明可分段。两个套接字入口
/// （ios_media_http/linux_http）对 HEAD 请求以本响应的
/// Content-Length 头为准写线；其 GET 路径仍以体长为准（各入口注）。
pub(super) fn media_head_response(
    target: &str,
    ctype: Option<&str>,
    total: u64,
) -> Response<Vec<u8>> {
    use tauri::http::HeaderValue;
    let mut response = respond(
        200,
        &media_mime_for_target(target, ctype),
        Vec::new(),
        PROXIED_MEDIA_CACHE_CONTROL,
    );
    response.headers_mut().insert(
        "Content-Length",
        HeaderValue::from_str(&total.to_string())
            .unwrap_or_else(|_| HeaderValue::from_static("0")),
    );
    response
        .headers_mut()
        .insert("Accept-Ranges", HeaderValue::from_static("bytes"));
    response
}

/// Socket tests supply bytes without contacting an upstream. They use the same
/// playlist rewrite, MIME detection and range implementation as real requests.
#[cfg(test)]
pub(crate) fn fixture_response(
    target: &str,
    ctype: &str,
    bytes: &[u8],
    origin: &str,
    range: Option<&str>,
) -> Response<Vec<u8>> {
    apply_byte_range(segment_response(target, Some(ctype), bytes.to_vec(), origin), range)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::hls::rewrite_playlist;
    use crate::media::LOCAL_ORIGIN;

    #[test]
    fn native_range_probe_returns_only_requested_segment_bytes() {
        let body = b"0123456789abcdef";
        for (range, start, end) in [
            ("bytes=0-1", 0, 1),
            ("bytes=0-7", 0, 7),
            ("bytes=8-", 8, body.len() - 1),
            ("bytes=-4", body.len() - 4, body.len() - 1),
            ("bytes=0-999", 0, body.len() - 1),
        ] {
            let response = apply_byte_range(
                respond(200, "video/mp2t", body.to_vec(), "no-store"),
                Some(range),
            );
            assert_eq!(response.status(), 206, "{range}");
            assert_eq!(response.body().as_slice(), &body[start..=end]);
            assert_eq!(response.headers()["Content-Type"], "video/mp2t");
            assert_eq!(response.headers()["Content-Length"], (end - start + 1).to_string());
            assert_eq!(response.headers()["Content-Range"], format!("bytes {start}-{end}/{}", body.len()));
        }
    }

    #[test]
    fn native_range_probes_keep_playlists_complete() {
        let body = b"#EXTM3U\n#EXTINF:4,\nsegment.ts\n";
        for range in ["bytes=0-1", "bytes=99999-", "bytes=-4"] {
            let response = apply_byte_range(
                respond(200, "application/vnd.apple.mpegurl", body.to_vec(), "no-store"),
                Some(range),
            );
            assert_eq!(response.status(), 200);
            assert_eq!(response.body(), body);
            assert_eq!(response.headers()["Content-Length"], body.len().to_string());
            assert!(!response.headers().contains_key("Content-Range"));
            assert!(!response.headers().contains_key("Accept-Ranges"));
        }
    }

    #[test]
    fn ranges_preserve_full_responses_and_reject_unsatisfiable_offsets() {
        for range in [None, Some("bytes=0-1,4-5"), Some("bytes=bad"), Some("bytes=3-1"), Some("items=0-1")] {
            let response = apply_byte_range(respond(200, "video/mp2t", b"data".to_vec(), "no-store"), range);
            assert_eq!(response.status(), 200);
            assert_eq!(response.body(), b"data");
            assert!(!response.headers().contains_key("Content-Range"));
        }
        for (body, range) in [(b"data".as_slice(), "bytes=4-"), (b"data".as_slice(), "bytes=-0"), (b"".as_slice(), "bytes=0-1")] {
            let response = apply_byte_range(respond(200, "video/mp2t", body.to_vec(), "no-store"), Some(range));
            assert_eq!(response.status(), 416);
            assert!(response.body().is_empty());
            assert_eq!(response.headers()["Content-Length"], "0");
            assert_eq!(response.headers()["Content-Range"], format!("bytes */{}", body.len()));
        }
        let error = apply_byte_range(respond(502, "text/plain", b"upstream failed".to_vec(), "no-store"), Some("bytes=0-1"));
        assert_eq!(error.status(), 502);
        assert_eq!(error.body(), b"upstream failed");
        assert!(!error.headers().contains_key("Accept-Ranges"));
    }

    #[test]
    fn nested_playlists_and_alternate_uris_stay_behind_proxy() {
        let text = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"audio/list.m3u8\"\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"http://127.0.0.1/key\"\n#EXT-X-PART:DURATION=1,URI=\"part.ts\"\nvariant/list.m3u8\n";
        let response = segment_response(
            "https://cdn.example/master.m3u8",
            Some("application/octet-stream"),
            text.as_bytes().to_vec(),
            LOCAL_ORIGIN,
        );
        let body = std::str::from_utf8(response.body()).unwrap();
        assert_eq!(body.matches(&format!("{LOCAL_ORIGIN}/seg?u=")).count(), 4);
        // Linux 上 LOCAL_ORIGIN 本身就是 `http://127.0.0.1:<port>`，
        // 所以不能断言「不含 127.0.0.1」，要断言上游那条 key 地址已被代理包起来
        assert!(!body.contains("URI=\"http://127.0.0.1/key\""));
        assert!(body.contains("https%3A%2F%2Fcdn%2Eexample%2Faudio%2Flist%2Em3u8"));
        assert_eq!(
            response.headers()["Content-Type"],
            "application/vnd.apple.mpegurl"
        );
        assert_eq!(response.headers()["X-Content-Type-Options"], "nosniff");
        assert_eq!(
            response.headers()["Cache-Control"],
            PROXIED_MEDIA_CACHE_CONTROL
        );
        assert!(!response
            .headers()
            .contains_key("Access-Control-Allow-Origin"));
        let optional = rewrite_playlist("https://cdn.example/list.m3u8",
            "#EXTM3U\n#EXT-X-CONTENT-STEERING:SERVER-URI=\"https://other.example/list.json\"\n#EXT-X-DATERANGE:ID=\"ad\",X-ASSET-LIST=\"http://127.0.0.1/assets\"\nsegment.ts\n", LOCAL_ORIGIN);
        assert!(!optional.contains("CONTENT-STEERING") && !optional.contains("X-ASSET-LIST"));
        assert!(optional.contains("#EXT-X-DATERANGE:ID=\"ad\""));
        let bom = segment_response(
            "https://cdn.example/list.m3u8",
            None,
            b"\xef\xbb\xbf#EXTM3U\nsegment.ts\n".to_vec(),
            LOCAL_ORIGIN,
        );
        assert!(bom.body().starts_with(b"#EXTM3U\n"));
    }

    /* fix337/video-resolve（3.3.6 真机 source-011 形态乙）：/seg 目标
     * 回 200＋HTML 文档（防盗链落地页/挑战页）时旧实现原样以媒体
     * 200 返回，hls.js 拿到 HTML 报 levelParsingError「Missing
     * format identifier #EXTM3U」——非播放列表/非媒体字节不得以
     * 成功形态交给播放器，必须 502 如实失败（与 /hls 的 #EXTM3U
     * 校验、fetch_bytes 的 HTML 候选链同口径）。 */
    #[test]
    fn html_document_bodies_are_not_served_as_media() {
        for ctype in [Some("video/mp2t"), Some("application/vnd.apple.mpegurl"), None] {
            let response = segment_response(
                "https://cdn.example/seg-1.ts",
                ctype,
                b"<!DOCTYPE html><html><body>landing</body></html>".to_vec(),
                LOCAL_ORIGIN,
            );
            assert_eq!(response.status(), 502, "HTML 文档必须 502，ctype={ctype:?}");
        }
        // 真分片（TS 同步字节）与真清单不受影响。
        let segment = segment_response(
            "https://cdn.example/seg-1.ts",
            Some("video/mp2t"),
            vec![0x47, 0x40, 0x11, 0x10],
            LOCAL_ORIGIN,
        );
        assert_eq!(segment.status(), 200);
        let playlist = segment_response(
            "https://cdn.example/list.m3u8",
            None,
            b"#EXTM3U\nseg-1.ts\n".to_vec(),
            LOCAL_ORIGIN,
        );
        assert_eq!(playlist.status(), 200);
    }

    /* fix338 签名①（3.3.7 真机 source-011 点播 levelParsingError，
     * 调查 fix338/investigation-338.md）：变体清单腿的唯一内容判别
     * 是窄前缀 is_html_document（只认 doctype/<html 两前缀），且
     * playlist 分支只凭 ctype 含 mpegurl 即入、从不复验 #EXTM3U
     * 魔数——非 doctype 前缀的网页体（脚本页/<head> 页/纯文本/
     * JSON 错误体）只要上游标 mpegurl、或目标是 .m3u8，就以 200
     * 到达 hls.js。承重判据改为魔数复验：凡「声称清单」（ctype
     * 含 mpegurl 或目标路径以 .m3u8 结尾）而魔数不符 → 502。
     * 调查探针四组体在旧码上全 200（红），修复后全 502。 */
    #[test]
    fn claimed_playlist_without_magic_is_rejected() {
        let bodies: [&[u8]; 4] = [
            b"<script type=\"text/javascript\">var a=1;</script>",
            b"<head><title>blocked</title></head>",
            b"Access Denied",
            b"{\"error\":\"upstream unavailable\"}",
        ];
        for body in bodies {
            // 形态甲：ctype 标 mpegurl（目标为分片名也一样）。
            let by_ctype = segment_response(
                "https://cdn.example/seg-1.ts",
                Some("application/vnd.apple.mpegurl"),
                body.to_vec(),
                LOCAL_ORIGIN,
            );
            assert_eq!(
                by_ctype.status(),
                502,
                "ctype 声称清单而魔数不符必须 502，体={:?}",
                String::from_utf8_lossy(body)
            );
            // 形态乙：无 ctype、目标路径以 .m3u8 结尾。
            let by_target = segment_response(
                "https://cdn.example/variant.m3u8",
                None,
                body.to_vec(),
                LOCAL_ORIGIN,
            );
            assert_eq!(
                by_target.status(),
                502,
                "目标声称清单而魔数不符必须 502，体={:?}",
                String::from_utf8_lossy(body)
            );
        }
        // 对照组：doctype 网页体＋mpegurl 在旧码上本就 502，不回退。
        let doctype = segment_response(
            "https://cdn.example/variant.m3u8",
            Some("application/vnd.apple.mpegurl"),
            b"<!DOCTYPE html><html><body>landing</body></html>".to_vec(),
            LOCAL_ORIGIN,
        );
        assert_eq!(doctype.status(), 502);
        // 真变体清单（可带 BOM）声称与魔数俱在 → 200 且改写不变。
        for body in [
            b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv2.m3u8\n".to_vec(),
            b"\xef\xbb\xbf#EXTM3U\nseg-1.ts\n".to_vec(),
        ] {
            let ok = segment_response(
                "https://cdn.example/variant.m3u8",
                Some("application/vnd.apple.mpegurl"),
                body,
                LOCAL_ORIGIN,
            );
            assert_eq!(ok.status(), 200, "真清单必须放行");
            assert!(ok.body().starts_with(b"#EXTM3U"));
        }
        // TS 分片被上游误标 mpegurl：旧码送 playlist 分支改写损坏，
        // 新码 502 如实失败（修复报告记账项，非回归）。
        let ts = segment_response(
            "https://cdn.example/seg-1.ts",
            Some("application/vnd.apple.mpegurl"),
            vec![0x47, 0x40, 0x11, 0x10],
            LOCAL_ORIGIN,
        );
        assert_eq!(ts.status(), 502, "误标 mpegurl 的分片字节不得再被改写损坏");
        // 未声称清单的普通媒体（无 ctype、.ts 目标、TS 字节）行为不变。
        let media = segment_response(
            "https://cdn.example/seg-1.ts",
            None,
            vec![0x47, 0x40, 0x11, 0x10],
            LOCAL_ORIGIN,
        );
        assert_eq!(media.status(), 200);
    }

    #[test]
    fn proxied_media_uses_platform_cache_policy() {
        let segment = segment_response(
            "https://cdn.example/seg-1.ts",
            Some("video/mp2t"),
            b"segment-bytes".to_vec(),
            LOCAL_ORIGIN,
        );
        assert_eq!(
            segment.headers()["Cache-Control"],
            PROXIED_MEDIA_CACHE_CONTROL
        );
        let playlist = segment_response(
            "https://cdn.example/list.m3u8",
            None,
            b"#EXTM3U\nseg-1.ts\n".to_vec(),
            LOCAL_ORIGIN,
        );
        assert_eq!(
            playlist.headers()["Cache-Control"],
            PROXIED_MEDIA_CACHE_CONTROL
        );
    }

    /* fix3311/file-leg-fix：类型归一——video 类型透传、泛类型按
     * 扩展名映射、集外目标保持原值。 */
    #[test]
    fn media_mime_normalizes_generic_types_for_file_targets() {
        assert_eq!(media_mime_for_target("https://cdn.example/v.mp4", Some("application/octet-stream")), "video/mp4");
        assert_eq!(media_mime_for_target("https://cdn.example/v.webm", None), "video/webm");
        assert_eq!(media_mime_for_target("https://cdn.example/v.mov", Some("application/octet-stream")), "video/quicktime");
        assert_eq!(media_mime_for_target("https://cdn.example/v.mkv", Some("binary/octet-stream")), "video/x-matroska");
        assert_eq!(media_mime_for_target("https://cdn.example/v.mp4", Some("video/mp4")), "video/mp4", "已是 video/* 原样透传");
        assert_eq!(media_mime_for_target("https://cdn.example/seg.ts", Some("application/octet-stream")), "application/octet-stream", "集外目标不变");
        assert_eq!(media_mime_for_target("https://cdn.example/seg.ts", None), "application/octet-stream");
    }

    #[test]
    fn platform_cache_policy_matches_selective_clear_support() {
        #[cfg(target_os = "linux")]
        {
            assert_eq!(PROXIED_MEDIA_CACHE_CONTROL, "no-store");
            assert_eq!(PROXIED_IMAGE_CACHE_CONTROL, "no-store");
        }
        #[cfg(not(target_os = "linux"))]
        {
            assert_eq!(PROXIED_MEDIA_CACHE_CONTROL, "public, max-age=3600");
            assert_eq!(PROXIED_IMAGE_CACHE_CONTROL, "public, max-age=86400");
        }
    }
}
