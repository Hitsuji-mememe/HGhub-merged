//! Upstream lines and mirrors published by the upstream address pages.
//! Publisher scripts are parsed as data; remote JavaScript is never executed.

mod mirror;
mod probe;

#[allow(unused_imports)]
pub use mirror::{fixed, is_fixed, is_trusted_mirror, mirrors, verify_published_origin, FIXED};
#[cfg(test)]
pub(crate) use mirror::PUBLISH_PAGES;
pub(crate) use probe::healthy_video_data;
#[allow(unused_imports)]
pub use probe::{auto_pick, health, probe, try_main, Hit};

#[cfg(test)]
mod tests {
    // 跟版合并（Muse 2026-11-18）：jsparse 已被上游删除（解析抽到
    // crate::publish_parser），absolute/parse_mirrors/script_src/MIRROR_MAX 亦不存在；
    // pick_from_hits 已由我方 line_rank 重构删除，其不变量由既有接棒断言守
    // （见下方注释），故两边导入取现存符号的并集减去已删符号。
    use super::mirror::{merge_publishers, PublishedPage, FIXED, PUBLISH_PAGES};
    use super::probe::{auto_candidates, healthy_video_data, Hit};
    use serde_json::{json, Value};

    fn origins(items: &[Value]) -> Vec<&str> {
        items
            .iter()
            .filter_map(|item| item["url"].as_str())
            .collect()
    }

    fn page(source: &str, hosts: &[&str]) -> Result<PublishedPage, String> {
        Ok(PublishedPage {
            source: source.into(),
            script: format!("{source}publish.js"),
            items: hosts
                .iter()
                .map(|host| json!({"host": host, "url": format!("https://{host}")}))
                .collect(),
        })
    }

    #[test]
    fn publisher_failure_retains_other_success_and_current_is_display_only() {
        let value = merge_publishers(
            [
                Err("timeout".into()),
                page(PUBLISH_PAGES[1], &["a.example"]),
            ],
            "https://restored.example",
        )
        .unwrap();
        assert_eq!(
            origins(value["items"].as_array().unwrap()),
            ["https://a.example"]
        );
        assert_eq!(value["recommended"][0]["url"], "https://restored.example");
        assert_eq!(value["errors"].as_array().unwrap().len(), 1);
        assert!(merge_publishers([Err("first".into()), Err("second".into())], FIXED[0].1).is_err());
    }

    #[test]
    fn publisher_lists_interleave_and_deduplicate() {
        let value = merge_publishers(
            [
                page(PUBLISH_PAGES[0], &["a.example", "c.example"]),
                page(PUBLISH_PAGES[1], &["b.example", "a.example"]),
            ],
            "https://a.example",
        )
        .unwrap();
        assert_eq!(
            origins(value["items"].as_array().unwrap()),
            [
                "https://a.example",
                "https://b.example",
                "https://c.example"
            ]
        );
        assert_eq!(value["recommended"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn health_requires_real_unwrapped_feed_data() {
        let valid = json!({"items": [{"id": 12, "title": "video"}], "pagination": {"page": 1, "pages": 2, "size": 1, "total": 2}});
        assert!(healthy_video_data(&valid));
        assert!(healthy_video_data(
            &json!({"items": [], "pagination": {"page": 1, "pages": 0, "size": 1, "total": 0}})
        ));
        for invalid in [
            Value::Null,
            json!("<html>200 OK</html>"),
            json!({}),
            json!({"status": 0, "msg": "denied"}),
            json!({"status": 1, "data": valid}),
            json!({"items": []}),
            json!({"items": [{}], "pagination": {"page": 1, "pages": 1, "size": 1, "total": 1}}),
        ] {
            assert!(!healthy_video_data(&invalid), "{invalid}");
        }
    }

    #[test]
    fn all_down_never_returns_a_line_to_switch_to() {
        // 接棒（2026-11-18 收官批 D）：原断言经 pick_from_hits 守两件事——
        // 全挂不给可切换线路、可达者按延迟选。选线规则已改为吞吐优先
        // （line_rank::rank_lines 有专测：吞吐胜、同带延迟胜、无吞吐回退
        // 延迟），pick_from_hits 随之删除；此处守剩余不变量：无候选时
        // rank 无胜者（auto_pick 据此回 all-down、保持当前线路），且
        // 无吞吐数据时仍按延迟选——原「fast 按延迟胜」语义在此延续。
        assert!(crate::line_rank::rank_lines(&[]).is_none());
        let unmeasured = [
            crate::line_rank::LineMeasure { url: "https://slow.example".into(), tier: "mirror".into(), ms: 20, bps: None },
            crate::line_rank::LineMeasure { url: "https://fast.example".into(), tier: "mirror".into(), ms: 8, bps: None },
        ];
        assert_eq!(
            crate::line_rank::rank_lines(&unmeasured).map(|w| w.url.as_str()),
            Some("https://fast.example")
        );
    }

    #[test]
    fn auto_candidates_require_publication_and_exclude_ai_landing_page() {
        let items = [
            // The .ai navigation page must stay out of candidates even if a
            // publish page lists it; it is no longer a fixed line.
            json!({"url": "https://huangguoai.ai"}),
            json!({"url": "https://published.example"}),
            json!({"url": "https://untrusted.example"}),
            json!({"url": "https://published.example"}),
        ];
        let candidates = auto_candidates(&items, "https://restored.example", |origin| {
            origin == "https://published.example"
        });
        assert_eq!(candidates, ["https://published.example"]);
        assert!(auto_candidates(&[], "https://restored.example", |_| true).is_empty());
    }
}
