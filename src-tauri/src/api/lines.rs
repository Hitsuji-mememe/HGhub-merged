//! Line (data source) commands.

use super::Api;
use crate::net::base;
use serde_json::{json, Value};
use tauri::State;

/* ───────────────────────── 线路（数据源） ───────────────────────── */
// Network probes run without holding this lock. Manual selection/cancellation
// invalidates older probes; applying a result is serialized with manual writes.
static LINE_SELECTION: std::sync::Mutex<u64> = std::sync::Mutex::new(0);

fn begin_line_selection() -> Result<u64, String> {
    let mut generation = LINE_SELECTION.lock().map_err(|_| "线路选择锁失败")?;
    *generation = generation.wrapping_add(1);
    Ok(*generation)
}

#[tauri::command]
pub async fn line_cancel() -> Result<(), String> {
    begin_line_selection()?;
    crate::lines::invalidate_pending_confirm();
    Ok(())
}

/// 当前线路 + 固定线路清单（镜像线路另外按需拉取）。
#[tauri::command]
pub async fn line_state() -> Result<Value, String> {
    Ok(json!({
        "base": base(),
        "default": crate::net::DEFAULT_BASE,
        "custom": crate::net::is_custom_line(),
        "fixed": crate::lines::fixed(),
    }))
}

/// 手动切换线路：只允许固定线路或刚从可信发布页读取的镜像。
/// 可信↔可信切换保留会话（同一账号体系）；任一端不可信则清空。
#[tauri::command]
pub async fn line_set(state: State<'_, Api>, url: String) -> Result<String, String> {
    let mut generation = LINE_SELECTION.lock().map_err(|_| "线路选择锁失败")?;
    *generation = generation.wrapping_add(1);
    crate::lines::invalidate_pending_confirm();
    let previous = base();
    let applied = crate::net::set_base(&url)?;
    crate::net::refresh_client();
    if previous != applied { state.session.rebase_or_clear(&applied, crate::session::rebase_trust); }
    Ok(applied)
}

#[tauri::command]
pub async fn line_custom_set(state: State<'_, Api>, url: String) -> Result<Value, String> {
    let mut generation = LINE_SELECTION.lock().map_err(|_| "线路选择锁失败")?;
    *generation = generation.wrapping_add(1);
    crate::lines::invalidate_pending_confirm();
    let previous = base();
    let applied = crate::net::set_custom_base(&url)?;
    crate::net::refresh_client();
    // Custom lines never join the trusted rebase: even a trusted old origin
    // must not hand its token to a user-specified site.
    let _ = previous;
    state.session.clear();
    Ok(json!({ "base": applied, "custom": crate::net::is_custom_line() }))
}

#[tauri::command]
pub async fn line_reset(state: State<'_, Api>) -> Result<Value, String> {
    let base = line_set(state, crate::net::DEFAULT_BASE.to_string()).await?;
    Ok(json!({ "base": base, "custom": false }))
}

#[tauri::command]
pub async fn proxy_state() -> Result<Value, String> {
    Ok(crate::net::proxy_state())
}

#[tauri::command]
pub async fn proxy_set(mode: String, url: String) -> Result<Value, String> {
    // Serialize with line application: probes using the previous proxy must
    // never switch the line after the new proxy has been saved.
    let mut generation = LINE_SELECTION.lock().map_err(|_| "线路选择锁失败")?;
    crate::proxy::set(&mode, &url)?;
    *generation = generation.wrapping_add(1);
    crate::lines::invalidate_pending_confirm();
    crate::net::refresh_client();
    let state = crate::net::proxy_state();
    crate::playback_log::record("proxy.changed", json!({
        "mode": state.get("mode"), "proxy": state.get("effective"),
    }));
    Ok(state)
}

#[tauri::command]
pub async fn proxy_test(mode: String, url: String) -> Result<Value, String> {
    Ok(crate::net::test_proxy(&mode, &url).await)
}

/// 从地址发布页抓镜像线路（只在用户点开「线路」时调用）。
#[tauri::command]
pub async fn line_mirrors() -> Result<Value, String> {
    // 用户手动点「刷新 / 打开线路」时重新读一次系统代理：代理软件开关过之后旧客户端会卡死
    crate::net::refresh_client();
    crate::lines::mirrors().await
}

/// 可达性探测：只报结果，不做自动检查 / 自动切换。
#[tauri::command]
pub async fn line_probe(urls: Vec<String>) -> Result<Value, String> {
    crate::net::refresh_client();
    Ok(crate::lines::probe(urls).await)
}

/// 自动选线：探测主站与可信发布页镜像，全部失败时保持当前线路。
///
/// 切换两端都可信（固定线路或本进程发布页确认的镜像）时保留会话并 rebase origin；
/// 旧 origin 不可信（如自定义线路）时清空会话，绝不把 token 带给新站点。
#[tauri::command]
pub async fn line_auto(state: State<'_, Api>, urgent: Option<bool>) -> Result<Value, String> {
    let selection = begin_line_selection()?;
    crate::net::refresh_client();
    let urgent = urgent.unwrap_or(false);
    if urgent {
        // 被动记账（U2 一期）：urgent 入口即前端播放卡顿/健康连挂的
        // 自愈路径，这次触发本身就是当前线路的一次卡顿事件。
        crate::lines::ledger::record_event(&base(), crate::lines::ledger::LineEvent::Stall);
    }
    let pick = crate::lines::auto_pick(urgent).await;
    let chosen = pick
        .get("base")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut switched = false;
    let mut breaker_blocked = false;
    let generation = LINE_SELECTION.lock().map_err(|_| "线路选择锁失败")?;
    let previous = base();
    if *generation == selection
        && pick.get("reason").and_then(Value::as_str) != Some("all-down")
        && !chosen.is_empty() && chosen != previous {
        // 会话熔断（U2 一期）：只拦自动切换，手动命令不经此路。拦下
        // 时保持当前线路正常返回、不报错——当前线还能播就继续播，
        // 熔断的窗口/退避到期后下一次自动选线自动恢复尝试。
        if crate::lines::ledger::auto_switch_allowed(&chosen) {
            let next = crate::net::set_base(&chosen)?;
            crate::net::refresh_client();
            switched = next != previous;
            if switched {
                crate::lines::ledger::note_auto_switch(&previous, &next);
                crate::lines::ledger::record_event(&previous, crate::lines::ledger::LineEvent::Fallback);
                crate::lines::ledger::record_event(&next, crate::lines::ledger::LineEvent::Recovery);
                state.session.rebase_or_clear(&next, crate::session::rebase_trust);
            }
        } else {
            breaker_blocked = true;
            crate::playback_log::record("line.auto_switch_blocked", json!({ "reason": "breaker" }));
        }
    }
    Ok(json!({
        "previous": previous,
        "base": crate::net::base(),
        "switched": switched,
        "breakerBlocked": breaker_blocked,
        "cancelled": *generation != selection,
        "pick": pick,
    }))
}

/// 主站健康探针（已收编，根治包 P0-B.3，audit6 §二条 5）：旧实现
/// 单次 probe ok 即直接 set_base 切主站，绕过排名/两轮确认/熔断/
/// 熔断记账——自动切换的单一切换权只许在 line_auto 一条路上。本
/// 命令保留注册与返回形状（旧前端契约不破），但只探不切：前端
/// check() 发现主站健康后改触发普通一轮 line_auto（reason
/// main-return），主站作为候选进统一排名（同带优先），切换必经
/// confirm_gate、熔断检查与 note_auto_switch 记账。
#[tauri::command]
pub async fn line_try_main() -> Result<Value, String> {
    let selection = begin_line_selection()?;
    crate::net::refresh_client();
    let probe = crate::lines::try_main().await;
    let generation = LINE_SELECTION.lock().map_err(|_| "线路选择锁失败")?;
    Ok(json!({
        "previous": base(),
        "base": crate::net::base(),
        "switched": false,
        "probe": probe,
        "cancelled": *generation != selection,
    }))
}

/// 线路体检：探一次 `/api/videos`，和自动选线用同一个判据。
#[tauri::command]
pub async fn line_health() -> Result<Value, String> {
    Ok(crate::lines::health().await)
}

/// 真实播放吞吐回写账本（根治包 P0-B.2，audit6 §五）：前端
/// VideoSurface 把分片实测聚合 bps（每 5 片中位数节流）经此命令
/// 写入账本 play EWMA，与主动探测的 probe EWMA 分账。签名与前端
/// api.lineRecordPlayback(origin, bps) 对齐（bps 为 f64 bit/s）；
/// 非有限/非正值由账本层丢弃，本命令不因记账失败打断播放。
#[tauri::command]
pub async fn line_record_playback(origin: String, bps: f64) -> Result<(), String> {
    crate::lines::ledger::record_playback(&origin, bps);
    Ok(())
}
