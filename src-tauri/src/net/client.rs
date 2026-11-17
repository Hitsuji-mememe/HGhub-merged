use super::proxy_env::{
    env_proxy_set, proxy_override, system_explicit_proxy, windows_proxy_enabled,
};
use super::redact::{err_text, redact_proxy};
use super::{
    base, ClientCache, CLIENTS, CLIENT_GENERATION, CLIENT_TTL, MEDIA_CONFIG_FINGERPRINT,
    MEDIA_CONFIG_GENERATION, MEDIA_DNS_ROUTES,
};
use crate::network_policy;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// 按**当前**系统代理设置新建一个客户端。
///
/// 注意：reqwest 的 `system-proxy` 只在构建时读一次注册表 / 环境变量。代理软件被关掉后，
/// 旧客户端仍会往 `127.0.0.1:7897` 建隧道，症状是满屏 `tunnel error: failed to create
/// underlying connection`（浏览器却是通的，因为它每次都重读系统代理）。所以这里允许重建。
pub(super) fn build_client(host: &str, addrs: &[SocketAddr], route: &ProxyRoute) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .gzip(true)
        .brotli(true)
        .pool_idle_timeout(Duration::from_secs(60));
    if !addrs.is_empty() {
        builder = builder.resolve_to_addrs(host, addrs);
    }
    if route.mode == crate::proxy::Mode::Off {
        builder = builder.no_proxy();
    } else if let Some(proxy) = &route.explicit {
        let proxy = reqwest::Proxy::all(proxy).map_err(|_| "代理配置无效（已隐藏原始值）")?;
        builder = builder.no_proxy().proxy(proxy);
    }
    builder.build().map_err(|_| "无法创建 HTTP 客户端".to_string())
}

/// One immutable selection is used for DNS, cache identity and client creation.
/// An in-flight request may finish on its old route; it cannot populate the new
/// configuration's cache entry after the user saves a different proxy.
pub(super) struct ProxyRoute {
    mode: crate::proxy::Mode,
    pub(super) explicit: Option<String>,
    pub(super) active: bool,
    generation: u64,
}

impl ProxyRoute {
    pub(super) fn for_config(config: &crate::proxy::Config, target: &url::Url) -> Self {
        use crate::proxy::Mode;
        let explicit = match config.mode {
            Mode::Off => None,
            Mode::Custom => Some(config.url.clone()),
            Mode::System => system_explicit_proxy(),
        };
        let active = match config.mode {
            Mode::Off => false,
            Mode::Custom => true,
            Mode::System => explicit.is_some() || system_proxy_routes_target(target),
        };
        Self { mode: config.mode, explicit, active, generation: CLIENT_GENERATION.load(Ordering::Acquire) }
    }

    fn fingerprint(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        self.mode.hash(&mut hash);
        self.explicit.hash(&mut hash);
        hash.finish()
    }

    pub(super) fn label(&self) -> String {
        if self.mode == crate::proxy::Mode::Off {
            "direct".into()
        } else if let Some(proxy) = &self.explicit {
            redact_proxy(proxy)
        } else if self.active {
            "system".into()
        } else {
            "direct".into()
        }
    }
}


/// Immutable transport identity captured when a media single-flight starts.
///
/// Only an effective line/proxy/security change increments `generation`.
/// Routine connection/DNS refreshes leave completed media caches usable.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct RequestScope {
    pub(crate) strict: bool,
    pub(crate) generation: u64,
}

pub(crate) fn request_scope() -> RequestScope {
    RequestScope {
        strict: network_policy::strict_security(),
        generation: MEDIA_CONFIG_GENERATION.load(Ordering::Acquire),
    }
}

pub(super) fn media_config_fingerprint(
    origin: &str,
    strict: bool,
    config: &crate::proxy::Config,
    system_proxy: u64,
) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    origin.hash(&mut hash);
    strict.hash(&mut hash);
    config.mode.hash(&mut hash);
    match config.mode {
        crate::proxy::Mode::Custom => config.url.hash(&mut hash),
        crate::proxy::Mode::System => system_proxy.hash(&mut hash),
        crate::proxy::Mode::Off => {}
    }
    hash.finish()
}

/// Snapshot system settings only when rebuilding clients, never per segment.
/// Values (including proxy credentials) are hashed in memory and never logged.
fn system_proxy_fingerprint() -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    proxy_override().hash(&mut hash);
    for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] {
        name.hash(&mut hash);
        std::env::var_os(name).hash(&mut hash);
    }
    #[cfg(target_os = "linux")]
    system_explicit_proxy().hash(&mut hash);
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    format!("{:?}", hyper_util::client::proxy::matcher::Matcher::from_system()).hash(&mut hash);
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        {
            key.get_value::<u32, _>("ProxyEnable").ok().hash(&mut hash);
            key.get_value::<String, _>("ProxyServer").ok().hash(&mut hash);
            key.get_value::<String, _>("ProxyOverride").ok().hash(&mut hash);
        }
    }
    hash.finish()
}

pub(super) fn update_media_generation(
    previous: &mut Option<u64>,
    fingerprint: u64,
    generation: &std::sync::atomic::AtomicU64,
) {
    if *previous != Some(fingerprint) {
        *previous = Some(fingerprint);
        generation.fetch_add(1, Ordering::AcqRel);
    }
}

pub(super) fn refresh_media_scope() {
    if let Ok(mut previous) = MEDIA_CONFIG_FINGERPRINT.lock() {
        let config = crate::proxy::snapshot();
        let system_proxy = if config.mode == crate::proxy::Mode::System {
            system_proxy_fingerprint()
        } else {
            0
        };
        let fingerprint = media_config_fingerprint(&base(), network_policy::strict_security(), &config, system_proxy);
        update_media_generation(&mut previous, fingerprint, &MEDIA_CONFIG_GENERATION);
    }
}

pub(super) fn cached_client(cache: &ClientCache, key: &str, now: Instant) -> Option<Arc<reqwest::Client>> {
    cache
        .get(key)
        .filter(|(expires, _)| now < *expires)
        .map(|(_, http)| http.clone())
}

/// 缓存按模式、主机和端口隔离；有效期内仅复用已经检查并固定地址的客户端。
/// 到期后重新检查全部 DNS 答案，不使用旧连接绕过新的目标检查。
pub(super) async fn client_for(raw: &str) -> Result<(url::Url, Arc<reqwest::Client>), String> {
    client_for_dns(raw, false).await
}

/// Keep Apple's existing per-target NO_PROXY/per-scheme/system matching.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn system_proxy_routes_target(target: &url::Url) -> bool {
    crate::apple_proxy::routes_target(
        &hyper_util::client::proxy::matcher::Matcher::from_system(),
        target.as_str(),
    )
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn system_proxy_routes_target(_target: &url::Url) -> bool {
    env_proxy_set() || windows_proxy_enabled()
}

pub(super) fn proxy_active(target: &url::Url) -> bool {
    ProxyRoute::for_config(&crate::proxy::snapshot(), target).active
}

pub(super) fn client_key(strict: bool, host: &str, port: u16, public_dns: bool, route: &ProxyRoute) -> String {
    format!("{strict}:{host}:{port}:{public_dns}:{}:{:x}:{}", route.active, route.fingerprint(), route.generation)
}


fn ipv4_kind(o: [u8; 4]) -> &'static str {
    let v4 = std::net::Ipv4Addr::from(o);
    if v4.is_loopback() { "loopback" } else if o == [0, 0, 0, 0] { "unspecified" }
    else if o[0] == 198 && (o[1] == 18 || o[1] == 19) { "fake_ip" }
    else if v4.is_private() { "private" } else if v4.is_link_local() { "link_local" }
    else if v4.is_broadcast() { "broadcast" } else { "public" }
}

fn ip_kind(ip: std::net::IpAddr) -> &'static str {
    match ip {
        std::net::IpAddr::V4(v4) => ipv4_kind(v4.octets()),
        std::net::IpAddr::V6(v6) => {
            if v6.is_loopback() { "loopback" } else if v6.is_unspecified() { "unspecified" }
            else if let Some(v4) = v6.to_ipv4_mapped() { ipv4_kind(v4.octets()) } else { "public" }
        }
    }
}

/// 阿里 DoH 的解析客户端：bootstrap 地址已钉死，且强制直连（mode=Off → no_proxy）。
/// DoH 若跟随应用代理从境外出口出去，阿里会按出口地理位置返回海外 CDN 节点，
/// 正是家里 WiFi 被 fake-ip 带偏后要绕开的坑，所以这里不接受任何代理路线。
fn doh_resolver() -> Result<reqwest::Client, String> {
    let direct = ProxyRoute {
        mode: crate::proxy::Mode::Off,
        explicit: None,
        active: false,
        generation: CLIENT_GENERATION.load(Ordering::Acquire),
    };
    build_client(crate::media_dns::HOST, &crate::media_dns::BOOTSTRAP, &direct)
}

/// 经阿里 DoH 拿真实地址并做与系统解析同一套地址校验；TTL 与客户端缓存上限取小。
async fn resolve_via_doh(host: &str, port: u16, strict: bool) -> Result<(Vec<SocketAddr>, Duration), String> {
    let resolver = doh_resolver()?;
    let resolution = crate::media_dns::resolve(&resolver, host, port).await?;
    network_policy::check_addresses_with_mode(&resolution.addresses, strict)?;
    Ok((resolution.addresses, CLIENT_TTL.min(resolution.ttl)))
}

/// 全 fake 时的第一绕行（Muse 2026-11-14，2.0.9）：向 223.5.5.5:53 走普通 UDP
/// DNS 直查拿真实地址。2.0.8 真机已钉死家里 DoH（443）通道不通，所以顺序是
/// UDP → DoH → fake 回退。UDP 答案若仍全是 fake 段（被网关劫持回假答案）视为失败；
/// 其余校验与 DoH 路径同一套（check_addresses_with_mode）。
async fn resolve_via_udp(host: &str, port: u16, strict: bool) -> Result<(Vec<SocketAddr>, Duration), String> {
    let resolution = crate::media_dns::resolve_udp(host, port).await?;
    if !resolution.addresses.is_empty()
        && resolution
            .addresses
            .iter()
            .all(|addr| ip_kind(addr.ip()) == "fake_ip")
    {
        return Err("备用 DNS 返回内网或保留地址".into());
    }
    network_policy::check_addresses_with_mode(&resolution.addresses, strict)?;
    Ok((resolution.addresses, CLIENT_TTL.min(resolution.ttl)))
}

/// 握手竞速重排（Muse 2026-11-14，2.0.9）：媒体主机的系统答案常有 2–9 个真实
/// 地址但顺序随机、快慢悬殊（Hark 实测同一主机国内 IP 握手 0.10s、海外 IP
/// 0.65–2.76s），原序钉给 reqwest 时先连上谁全凭运气。对前 8 个地址并发 TCP
/// connect 竞速（总窗口 300ms；有 <150ms 连上即可提前收工）：连上的按 RTT 升序
/// 排前，未连上/超时的保持原相对顺序跟在后面（可能只是慢、不是死，不能丢）；
/// 全都没连上则原序原样返回。竞速连接连上即弃、不发任何数据。
async fn race_answers(addrs: &[SocketAddr]) -> (Vec<SocketAddr>, Option<u64>) {
    const RACE_WINDOW: Duration = Duration::from_millis(300);
    const FAST_ENOUGH: Duration = Duration::from_millis(150);
    const MAX_RACED: usize = 8;
    let mut set = tokio::task::JoinSet::new();
    for (index, addr) in addrs.iter().take(MAX_RACED).enumerate() {
        let addr = *addr;
        set.spawn(async move {
            let started = Instant::now();
            // TcpStream 连上后立即 drop：只测握手 RTT，不发任何数据。
            tokio::net::TcpStream::connect(addr)
                .await
                .ok()
                .map(|_| (index, started.elapsed()))
        });
    }
    let mut connected: Vec<(usize, Duration)> = Vec::new();
    let deadline = tokio::time::sleep(RACE_WINDOW);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            joined = set.join_next() => {
                match joined {
                    Some(Ok(Some(hit))) => {
                        let fast_enough = hit.1 < FAST_ENOUGH;
                        connected.push(hit);
                        if fast_enough {
                            break;
                        }
                    }
                    Some(_) => {} // 该地址连接失败，继续等其余
                    None => break, // 全部竞速任务已结束
                }
            }
            _ = &mut deadline => break,
        }
    }
    set.abort_all();
    if connected.is_empty() {
        return (addrs.to_vec(), None);
    }
    connected.sort_by_key(|(index, rtt)| (*rtt, *index));
    let first_ms = connected.first().map(|(_, rtt)| rtt.as_millis() as u64);
    let mut reordered: Vec<SocketAddr> = connected.iter().map(|(index, _)| addrs[*index]).collect();
    for (index, addr) in addrs.iter().enumerate() {
        if !connected.iter().any(|(hit, _)| *hit == index) {
            reordered.push(*addr);
        }
    }
    (reordered, first_ms)
}

/// network.resolve 诊断用：把一组解析答案按 ip_kind 归类成去重排序后的种类数组，
/// 让真机日志能直接看出答案构成是纯 fake-ip、纯公网还是混合（Muse 2026-11-14，2.0.8 定位绕行未触发用）。
fn resolve_kinds(addrs: &[SocketAddr]) -> Vec<&'static str> {
    let mut kinds: Vec<&'static str> = addrs.iter().map(|addr| ip_kind(addr.ip())).collect();
    kinds.sort_unstable();
    kinds.dedup();
    kinds
}

async fn client_for_dns(raw: &str, public_dns: bool) -> Result<(url::Url, Arc<reqwest::Client>), String> {
    let strict = network_policy::strict_security();
    let target = network_policy::parse_target_with_mode(raw, strict)?;
    let host = target.host_str().ok_or("目标缺少主机名")?;
    let port = target.port_or_known_default().ok_or("目标端口无效")?;
    let route = ProxyRoute::for_config(&crate::proxy::snapshot(), &target);
    let proxy = route.active;
    let key = client_key(strict, host, port, public_dns, &route);
    {
        let cache = CLIENTS.lock().map_err(|_| "HTTP 客户端锁失败")?;
        if let Some(http) = cached_client(&cache, &key, Instant::now()) {
            return Ok((target, http));
        }
    }
    let (addrs, ttl) = if proxy {
        // 有代理：跳过本地解析与 IP 校验，addrs 留空，域名交给代理。
        (Vec::new(), CLIENT_TTL)
    } else if public_dns {
        let resolver = build_client(crate::media_dns::HOST, &crate::media_dns::BOOTSTRAP, &route)?;
        let resolution = crate::media_dns::resolve(&resolver, host, port).await?;
        network_policy::check_addresses_with_mode(&resolution.addresses, strict)?;
        (resolution.addresses, CLIENT_TTL.min(resolution.ttl))
    } else if strict {
let resolved = network_policy::resolve_target(&target, strict).await?;
        let system_kinds = resolve_kinds(&resolved);
        let all_fake = !resolved.is_empty() && resolved.iter().all(|addr| ip_kind(addr.ip()) == "fake_ip");
        if all_fake {
            // 系统 DNS 给的全是 fake-ip：那是网关伪造并接管的地址，拿它当真公网 IP
            // 直连会被带到代理出口侧解析、多半落到海外节点。绕行顺序（2.0.9）：
            // 先 UDP 直查阿里（家里 443 不通时 53 常还活着），失败再原 DoH；两条都
            // 断才回退 fake 地址建客户端，保住纯 TUN 环境可用。
            match resolve_via_udp(host, port, strict).await {
                Ok(real) => {
                    crate::playback_log::record("network.resolve", json!({"host": host, "kinds": resolve_kinds(&real.0), "count": real.0.len(), "all_fake": true, "branch": "udp_dns"}));
                    real
                }
                Err(udp_error) => match resolve_via_doh(host, port, strict).await {
                    Ok(real) => {
                        crate::playback_log::record("network.dns_fallback", json!({"resource": crate::playback_log::resource_id(raw), "public_dns": true, "reason": "fake_ip"}));
                        crate::playback_log::record("network.resolve", json!({"host": host, "kinds": resolve_kinds(&real.0), "count": real.0.len(), "all_fake": true, "branch": "doh"}));
                        real
                    }
                    Err(error) => {
                        // 绕行失败回退 fake 地址也要留痕，否则真机上分不清是「全假判断没成立」还是「DoH 飞快失败被吞」（2.0.8）；2.0.9 起同条带上 udp_error，区分两条绕行各死在哪。
                        crate::playback_log::record("network.resolve", json!({"host": host, "kinds": system_kinds, "count": resolved.len(), "all_fake": true, "branch": "fake_fallback", "doh_error": error, "udp_error": udp_error}));
                        (resolved, CLIENT_TTL)
                    }
                },
            }
        } else if resolved.len() >= 2 {
            // 答案全是真地址但顺序随机、快慢悬殊：握手竞速重排后再钉住（2.0.9 修复一）。
            let (raced, first_ms) = race_answers(&resolved).await;
            crate::playback_log::record("network.resolve", json!({"host": host, "kinds": system_kinds, "count": resolved.len(), "all_fake": false, "branch": "system_raced", "first_ms": first_ms}));
            (raced, CLIENT_TTL)
        } else {
            crate::playback_log::record("network.resolve", json!({"host": host, "kinds": system_kinds, "count": resolved.len(), "all_fake": false, "branch": "system"}));
            (resolved, CLIENT_TTL)
        }
    } else {
        (Vec::new(), CLIENT_TTL)
    };
    let http = Arc::new(build_client(host, &addrs, &route)?);
    let now = Instant::now();
    let mut cache = CLIENTS.lock().map_err(|_| "HTTP 客户端锁失败")?;
    // 同时到达的请求可能已完成解析；不延长已有结果的有效期。
    let http = cached_client(&cache, &key, now).unwrap_or(http);
    if !cache.get(&key).is_some_and(|(expires, _)| now < *expires) {
        cache.retain(|_, (expires, _)| now < *expires);
        if cache.len() >= 64 {
            cache.clear();
        }
        cache.insert(key, (now + ttl, http.clone()));
    }
    Ok((target, http))
}

pub fn refresh_client() {
    // A periodic main-site probe can rebuild clients without changing proxy or
    // line. Preserve KEY/SEG caches unless the actual configuration changed.
    refresh_media_scope();
    // Builders still resolving DNS must not repopulate the new generation.
    CLIENT_GENERATION.fetch_add(1, Ordering::AcqRel);
    if let Ok(mut cache) = CLIENTS.lock() {
        cache.clear();
    }
    if let Ok(mut routes) = MEDIA_DNS_ROUTES.lock() {
        *routes = crate::media_dns::Routes::default();
    }
}

/// 不可信 GET 的统一入口；自动重定向被关闭，每一跳重新检查 URL、DNS 并固定解析地址。
pub async fn get(
    raw: &str,
    timeout: Duration,
    accept: Option<&str>,
    referer: Option<&str>,
) -> Result<reqwest::Response, String> {
    get_with_dns(raw, timeout, accept, referer, false).await
}

pub(super) async fn get_with_dns(
    raw: &str,
    timeout: Duration,
    accept: Option<&str>,
    referer: Option<&str>,
    public_dns: bool,
) -> Result<reqwest::Response, String> {
    tokio::time::timeout(timeout, async {
        let policy_error = |phase: &str, error: String| {
            crate::playback_log::record("network.target_failed", json!({"resource": crate::playback_log::resource_id(raw), "phase": phase, "error_kind": crate::playback_log::error_kind(&error)}));
            error
        };
        let mut next = network_policy::parse_target(raw).map_err(|e| policy_error("parse", e))?;
        for hop in 0..=5 {
            let resolving = Instant::now();
            let (target, http) = client_for_dns(next.as_str(), public_dns).await.map_err(|e| policy_error("dns_or_client", e))?;
            crate::playback_log::record("network.target_ready", json!({"resource": crate::playback_log::resource_id(raw), "target_resource": crate::playback_log::resource_id(target.as_str()), "dns_or_client_ms": resolving.elapsed().as_millis() as u64, "hop": hop}));
            let mut request = http.get(target.clone()).timeout(timeout);
            if let Some(value) = accept {
                request = request.header("Accept", value);
            }
            if let Some(value) = referer {
                request = request.header("Referer", value);
            }
            let response = request.send().await.map_err(|e| err_text(&e))?;
            if !matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
                return Ok(response);
            }
            if hop == 5 {
                return Err("重定向次数超过限制".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or("重定向缺少有效 Location")?;
            next = network_policy::redirect_target(&target, location).map_err(|e| policy_error("redirect", e))?;
            crate::playback_log::record("network.redirect", json!({"resource": crate::playback_log::resource_id(raw), "from": crate::playback_log::resource_id(target.as_str()), "to": crate::playback_log::resource_id(next.as_str()), "status": response.status().as_u16(), "hop": hop + 1}));
        }
        Err("重定向次数超过限制".into())
    })
    .await
    .map_err(|_| "请求超时".to_string())?
}

pub(super) async fn get_with_dns_h(
    raw: &str,
    timeout: Duration,
    accept: Option<&str>,
    referer: Option<&str>,
    public_dns: bool,
    extra_headers: &[(&str, &str)],
) -> Result<reqwest::Response, String> {
    tokio::time::timeout(timeout, async {
        let policy_error = |phase: &str, error: String| {
            crate::playback_log::record("network.target_failed", json!({"resource": crate::playback_log::resource_id(raw), "phase": phase, "error_kind": crate::playback_log::error_kind(&error)}));
            error
        };
        let mut next = network_policy::parse_target(raw).map_err(|e| policy_error("parse", e))?;
        for hop in 0..=5 {
            let resolving = Instant::now();
            let (target, http) = client_for_dns(next.as_str(), public_dns).await.map_err(|e| policy_error("dns_or_client", e))?;
            crate::playback_log::record("network.target_ready", json!({"resource": crate::playback_log::resource_id(raw), "target_resource": crate::playback_log::resource_id(target.as_str()), "dns_or_client_ms": resolving.elapsed().as_millis() as u64, "hop": hop}));
            let mut request = http.get(target.clone()).timeout(timeout);
            if let Some(value) = accept {
                request = request.header("Accept", value);
            }
            if let Some(value) = referer {
                request = request.header("Referer", value);
            }
            for (name, value) in extra_headers {
                request = request.header(*name, *value);
            }
            let response = request.send().await.map_err(|e| err_text(&e))?;
            if !matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
                return Ok(response);
            }
            if hop == 5 {
                return Err("重定向次数超过限制".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or("重定向缺少有效 Location")?;
            next = network_policy::redirect_target(&target, location).map_err(|e| policy_error("redirect", e))?;
            crate::playback_log::record("network.redirect", json!({"resource": crate::playback_log::resource_id(raw), "from": crate::playback_log::resource_id(target.as_str()), "to": crate::playback_log::resource_id(next.as_str()), "status": response.status().as_u16(), "hop": hop + 1}));
        }
        Err("重定向次数超过限制".into())
    })
    .await
    .map_err(|_| "请求超时".to_string())?
}

/// 一次 Range 抓取的结果（状态码 / 总长 / 类型 / 字节）。
pub struct RangeFetch {
    pub status: u16,
    /// Content-Range 里的总长；服务器没给或给 `*` 时为 None。
    pub total: Option<u64>,
    pub ctype: Option<String>,
    pub bytes: Vec<u8>,
}

/// 解析 `Content-Range: bytes 0-65535/1234567` 的总长部分。
fn parse_content_range_total(value: &str) -> Option<u64> {
    let (_, total) = value.rsplit_once('/')?;
    let total = total.trim();
    if total == "*" {
        return None;
    }
    total.parse::<u64>().ok().filter(|n| *n > 0)
}

/// 带 Range 头拉一段字节，走系统 DNS 路径（与 fetch_bytes_direct 同路，不翻公共 DNS）。
/// 客户端构造、UA、Referer 都与 fetch_bytes 一致，只是多个 Range 头和状态码语义：
/// 206＝分段命中（看 total 规划后续）；200＝服务器忽略 Range、响应即全量；非 2xx 直接报错。
pub async fn fetch_range_direct(
    url: &str,
    start: u64,
    end: u64,
) -> Result<RangeFetch, String> {
    let referer = format!("{}/", base());
    let range = format!("bytes={start}-{end}");
    let resp = get_with_dns_h(
        url,
        Duration::from_secs(20),
        None,
        Some(&referer),
        false,
        &[("Range", &range)],
    )
    .await?;
    let status = resp.status().as_u16();
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_content_range_total);
    let ctype = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let bytes = resp.bytes().await.map_err(|e| err_text(&e))?.to_vec();
    Ok(RangeFetch { status, total, ctype, bytes })
}
