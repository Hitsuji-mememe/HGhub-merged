//! 不可信目标的连接策略。FakeIP 是明确例外，不能把它当作普通私网拒绝。
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;
use std::time::Duration;
use url::{Host, Url};

/// 解析命令行参数与环境变量中的严格安全模式覆盖项。
/// 支持 `--no-strict` / `--no-strict-security` / `--relaxed` / `--relaxed-security` 关闭，
/// `--strict` / `--strict-security` 开启，以及 `HGHUBX_STRICT=0|1|false|true`。
pub fn parse_strict_override<I, S>(args: I, env_val: Option<&str>) -> Option<bool>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = match env_val.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        Some("0" | "false" | "off" | "no") => Some(false),
        Some("1" | "true" | "on" | "yes") => Some(true),
        _ => None,
    };
    for arg in args {
        match arg.as_ref().trim() {
            "--no-strict" | "--no-strict-security" | "--relaxed" | "--relaxed-security" => {
                out = Some(false);
            }
            "--strict" | "--strict-security" => {
                out = Some(true);
            }
            _ => {}
        }
    }
    out
}

pub fn cli_strict_override() -> Option<bool> {
    parse_strict_override(
        std::env::args(),
        crate::env::var("STRICT").as_deref(),
    )
}

static STRICT: Lazy<AtomicBool> =
    Lazy::new(|| AtomicBool::new(cli_strict_override().unwrap_or(true)));
static SECURITY_FILE: Lazy<RwLock<Option<PathBuf>>> = Lazy::new(|| RwLock::new(None));

/// 当前是否启用严格安全模式（默认开启）。
pub fn strict_security() -> bool {
    STRICT.load(Ordering::Relaxed)
}

/// 启动时读取落盘的安全模式设置；若命令行显式指定了 `--no-strict` 等参数，则以命令行参数为准。
pub fn bind_security(dir: &Path) {
    let path = dir.join("security.json");
    if cli_strict_override().is_none() {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if let Some(strict) = v.get("strict").and_then(|x| x.as_bool()) {
                    STRICT.store(strict, Ordering::Relaxed);
                }
            }
        }
    }
    if let Ok(mut f) = SECURITY_FILE.write() {
        *f = Some(path);
    }
}

/// 切换严格安全模式并落盘。
pub fn set_strict_security(strict: bool) -> Result<(), String> {
    let file = SECURITY_FILE.write().map_err(|_| "安全设置锁失败")?;
    let path = file.as_ref().ok_or("安全设置尚未初始化")?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, json!({ "strict": strict }).to_string())
        .and_then(|_| std::fs::rename(&temp, path))
        .map_err(|_| "无法保存安全设置，请检查应用数据目录")?;
    STRICT.store(strict, Ordering::Relaxed);
    Ok(())
}

pub(crate) fn is_internal_webview_host(name: &str) -> bool {
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    matches!(
        name.as_str(),
        "tauri.localhost" | "hg.localhost" | "ipc.localhost"
    )
}

pub fn allowed_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            if a == 198 && (b == 18 || b == 19) {
                return true;
            }
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 192 && b == 0 && (c == 0 || c == 2))
                || (a == 192 && b == 88 && c == 99)
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return allowed_ip(IpAddr::V4(v4));
            }
            let s = ip.segments();
            // 仅全球单播；拒绝 ULA、链路本地、回环、组播、NAT64，以及可封装私网 IPv4 的 6to4/Teredo。
            (s[0] & 0xe000) == 0x2000
                && s[0] != 0x2002
                && !(s[0] == 0x2001 && (s[1] < 0x0200 || s[1] == 0x0db8))
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}

pub fn parse_target(raw: &str) -> Result<Url, String> {
    parse_target_with_mode(raw, strict_security())
}

pub fn parse_target_with_mode(raw: &str, strict: bool) -> Result<Url, String> {
    if raw.chars().any(char::is_control) {
        return Err("目标地址含控制字符".into());
    }
    let url = Url::parse(raw).map_err(|_| "目标地址无效")?;
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("目标只允许不带认证信息的 HTTP(S) 地址".into());
    }
    match url.host().ok_or("目标缺少主机名")? {
        Host::Ipv4(ip) if strict => check_ip(ip.into())?,
        Host::Ipv6(ip) if strict => check_ip(ip.into())?,
        Host::Ipv4(_) | Host::Ipv6(_) => {}
        Host::Domain(name) => {
            if is_internal_webview_host(name) {
                return Err("禁止访问应用内部协议主机名".into());
            }
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            if strict
                && ["localhost", "local", "internal", "home.arpa"]
                    .iter()
                    .any(|suffix| name == *suffix || name.ends_with(&format!(".{suffix}")))
            {
                return Err("禁止访问本机或内网主机名".into());
            }
        }
    }
    Ok(url)
}

fn check_ip(ip: IpAddr) -> Result<(), String> {
    if allowed_ip(ip) {
        Ok(())
    } else {
        Err("禁止访问普通内网、回环或保留地址（仅放行 FakeIP 198.18.0.0/15）".into())
    }
}

#[cfg(test)]
pub fn check_addresses(addrs: &[SocketAddr]) -> Result<(), String> {
    check_addresses_with_mode(addrs, strict_security())
}

pub fn check_addresses_with_mode(addrs: &[SocketAddr], strict: bool) -> Result<(), String> {
    if addrs.is_empty() {
        return Err("目标没有可用的 DNS 地址".into());
    }
    if strict {
        // 混合公私网答案整体拒绝，不能让连接器回退到私网地址。
        for addr in addrs {
            check_ip(addr.ip())?;
        }
    }
    Ok(())
}

/// 与浏览器一致优先 IPv6：连接器以首个地址的协议族为首选，另一族在其失败后（Happy Eyeballs）兜底。
/// 普通排序会把 IPv4 排在前面；共享 IPv4 出口被上游接口限流时，请求会挂起或返回 502/503，
/// 而同一网络下浏览器走 IPv6 一切正常。
fn sort_ipv6_first(addrs: &mut [SocketAddr]) {
    addrs.sort_unstable_by_key(|addr| (addr.is_ipv4(), *addr));
}

/// strict 模式下从系统答案里保留被允许的子集（纯函数，
/// fix337/video-resolve）：整组拒绝的旧语义让一条被污染的记录
/// （如上游回的 Teredo AAAA——fix335 Hark 实证的污染形态）把
/// 同组好地址一并否决、目标恒 private_address_denied 且无回退
/// 命中（3.3.6 真机 source-011 播放时段 ×10）。只保留子集不
/// 放宽连接面：连接器钉住的地址仍逐个过 allowed_ip、永不连
/// 被拒地址；子集为空（全被拒）时由调用方按旧语义整组拒绝。
fn strict_allowed_subset(addrs: &[SocketAddr]) -> Vec<SocketAddr> {
    addrs.iter().copied().filter(|a| allowed_ip(a.ip())).collect()
}

/// FakeIP 合成地址形态（fix338 签名②）：代理核心 fake-ip 池的
/// 地址——v4 198.18.0.0/15 与 v6 ULA 段（fc00::/7；sing-box
/// fake-ip6 默认 fc00::/18、mihomo 默认 fdfe:dcba:9876::/64 均
/// 落在其内）。与 allowed_ip 分开：ULA 本身不是「放行地址」，
/// 只有当一组答案**全为**合成形态时才构成 fake 分支的证据
/// （见 adopt_addresses）；混合集里的 ULA 仍按普通内网剔除，
/// 非 fake 分支的真实 ULA/内网地址维持拒绝。
pub fn is_synthetic_fake_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, _, _] = v4.octets();
            a == 198 && (b == 18 || b == 19)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_synthetic_fake_ip(IpAddr::V4(v4));
            }
            let s = v6.segments();
            (s[0] & 0xfe00) == 0xfc00
        }
    }
}

/// 一组解析答案是否全为 FakeIP 合成形态（空集不算）。
pub fn answers_all_synthetic(addrs: &[SocketAddr]) -> bool {
    !addrs.is_empty() && addrs.iter().all(|a| is_synthetic_fake_ip(a.ip()))
}

/// 地址采用裁定（fix338 签名②）：系统解析（resolve_target）与
/// 公网 DNS 回退（client_for_dns 的 public_dns 分支）两个采用点
/// 共用同一口径。此前两处命运不同：前者 strict 子集保留
/// （fix337），后者整组校验——同一混合答案集一放一拒；且
/// AAAA-only 的 FakeIP v6 合成集在两处都因 ULA 被 allowed_ip
/// 拒而整组失败（3.3.7 真机分片 private_address_denied ×12，
/// 调查 fix338/investigation-338.md 签名②）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AddressAdoption {
    /// 钉死这组地址连接：每个地址都已过 allowed_ip，连接器
    /// 永不连被拒地址。
    Pin(Vec<SocketAddr>),
    /// 答案集全为代理合成形态：不钉死、按主机名经系统/代理
    /// 连接（fake→域名映射在代理核心数据面、连接由其接管，
    /// 与 v4 fake_trusted 同口径同信任论证）；原始集仅作记录
    /// 与探测参考，不作为连接目标钉入客户端。
    ByHostname(Vec<SocketAddr>),
}

impl AddressAdoption {
    pub fn into_addresses(self) -> Vec<SocketAddr> {
        match self {
            AddressAdoption::Pin(addrs) | AddressAdoption::ByHostname(addrs) => addrs,
        }
    }
}

/// 采用裁定纯函数（两采用点共用）：非 strict 全量保留（仅空集
/// 拒绝，与旧 check 语义一致）；strict 下全合成集走 fake 分支，
/// 其余保留 allowed 子集，子集为空（全被拒或无答案）整组拒绝、
/// 错误文本与旧整组拒绝一致。
pub fn adopt_addresses(addrs: &[SocketAddr], strict: bool) -> Result<AddressAdoption, String> {
    if !strict {
        check_addresses_with_mode(addrs, false)?;
        return Ok(AddressAdoption::Pin(addrs.to_vec()));
    }
    if answers_all_synthetic(addrs) {
        return Ok(AddressAdoption::ByHostname(addrs.to_vec()));
    }
    let subset = strict_allowed_subset(addrs);
    if subset.is_empty() {
        let err = check_addresses_with_mode(addrs, strict)
            .err()
            .unwrap_or_else(|| "目标没有可用的 DNS 地址".to_string());
        return Err(err);
    }
    Ok(AddressAdoption::Pin(subset))
}

pub async fn resolve_target(url: &Url, strict: bool) -> Result<Vec<SocketAddr>, String> {
    resolve_target_adopted(url, strict)
        .await
        .map(AddressAdoption::into_addresses)
}

/// 同 resolve_target，保留采用裁定：连接面（client_for_dns）
/// 需要知道 fake 分支不钉死；诊断/探测方用 resolve_target 取
/// 地址集即可（ByHostname 时为原始合成集）。
pub async fn resolve_target_adopted(
    url: &Url,
    strict: bool,
) -> Result<AddressAdoption, String> {
    let port = url.port_or_known_default().ok_or("目标端口无效")?;
    let mut addrs = match url.host().ok_or("目标缺少主机名")? {
        Host::Ipv4(ip) => vec![SocketAddr::new(ip.into(), port)],
        Host::Ipv6(ip) => vec![SocketAddr::new(ip.into(), port)],
        Host::Domain(host) => tokio::time::timeout(
            Duration::from_secs(10),
            tokio::net::lookup_host((host, port)),
        )
        .await
        .map_err(|_| "DNS 解析超时")?
        .map_err(|_| "DNS 解析失败")?
        .collect(),
    };
    sort_ipv6_first(&mut addrs);
    addrs.dedup();
    match adopt_addresses(&addrs, strict) {
        Ok(adopted) => Ok(adopted),
        Err(e) => {
            /* 抛出点留痕（fix338 签名②）：被拒目标此前在诊断导出
             * 里没有任何解析观测行（resolve_target 在 strict_reresolve
             * 落 network.resolve 之前失败），答案构成不可见、真机
             * 只能靠猜。现按 fake_trusted 行同格式落一行
             * branch=denied：kinds 按 media_dns::ip_kind 归类计数、
             * 不记原始 IP（不变量 10）。空集（纯 DNS 无答案）不是
             * 策略拒绝，不落此行。 */
            if strict && !addrs.is_empty() {
                if let Some(host) = url.host_str() {
                    crate::playback_log::record(
                        "network.resolve",
                        json!({"host": host, "kinds": crate::media_dns::resolve_kinds(&addrs), "count": addrs.len(), "all_fake": false, "branch": "denied"}),
                    );
                }
            }
            Err(e)
        }
    }
}

pub fn redirect_target(current: &Url, location: &str) -> Result<Url, String> {
    redirect_target_with_mode(current, location, strict_security())
}

pub fn redirect_target_with_mode(
    current: &Url,
    location: &str,
    strict: bool,
) -> Result<Url, String> {
    let next = current.join(location).map_err(|_| "重定向地址无效")?;
    let next = parse_target_with_mode(next.as_str(), strict)?;
    if strict && current.scheme() == "https" && next.scheme() != "https" {
        return Err("禁止 HTTPS 降级重定向".into());
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_security_save_keeps_the_effective_mode() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("hghubx-security-{}-{unique}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("security.json");
        let previous = SECURITY_FILE.write().unwrap().replace(path.clone());
        let before = strict_security();
        set_strict_security(before).unwrap();
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(saved["strict"], before);
        *SECURITY_FILE.write().unwrap() = Some(dir.join("missing/security.json"));
        assert!(set_strict_security(!before).is_err());
        assert_eq!(strict_security(), before);
        *SECURITY_FILE.write().unwrap() = previous;
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn resolved_addresses_prefer_ipv6() {
        let mut addrs: Vec<SocketAddr> = [
            "18.65.214.45:443",
            "[2600:9000:221c:5000:3:fdd6:fcc0:93a1]:443",
            "18.65.214.3:443",
            "[2600:9000:221c:4000:3:fdd6:fcc0:93a1]:443",
        ]
        .iter()
        .map(|s| s.parse().unwrap())
        .collect();
        sort_ipv6_first(&mut addrs);
        assert!(addrs[..2].iter().all(SocketAddr::is_ipv6), "{addrs:?}");
        assert!(addrs[2..].iter().all(SocketAddr::is_ipv4), "{addrs:?}");
        assert_eq!(addrs[2], "18.65.214.3:443".parse::<SocketAddr>().unwrap());
    }

    #[test]
    fn public_and_fakeip_are_allowed() {
        for ip in [
            "1.1.1.1",
            "8.8.8.8",
            "198.18.0.0",
            "198.19.255.255",
            "2606:4700:4700::1111",
            "::ffff:198.18.0.1",
        ] {
            assert!(allowed_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn private_and_special_addresses_are_blocked() {
        for ip in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "100.127.255.254",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.1",
            "192.0.0.1",
            "192.0.2.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:192.168.1.1",
            "64:ff9b::c0a8:101",
            "2002:c0a8:101::1",
            "2001::1",
            "2001:db8::1",
            "3fff::1",
        ] {
            assert!(!allowed_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn reserved_ipv6_subranges_are_covered_by_the_existing_block() {
        for raw in [
            "2001:2::1",
            "2001:2:ffff:ffff:ffff:ffff:ffff:ffff",
            "2001:10::1",
            "2001:1f:ffff:ffff:ffff:ffff:ffff:ffff",
        ] {
            assert!(!allowed_ip(raw.parse().unwrap()), "{raw}");
        }
    }

    #[test]
    fn alternate_spellings_and_unsafe_urls_are_blocked() {
        for raw in [
            "http://127.1/",
            "http://2130706433/",
            "http://0x7f000001/",
            "http://[::ffff:192.168.0.1]/",
            "http://localhost./",
            "http://foo.local/",
            "file:///etc/passwd",
            "https://user:secret@example.com/",
            "https://example.com/\n",
        ] {
            assert!(parse_target(raw).is_err(), "{raw}");
        }
        assert!(parse_target("http://198.18.0.1/video").is_ok());
    }

    /* fix337/video-resolve（3.3.6 真机 source-011 播放时段
     * private_address_denied×10）：strict 解析对混合答案集整组拒绝
     * 时，一条被污染的记录（如上游给的 Teredo AAAA，fix335 Hark
     * 实证的污染形态）会把同组的好地址一并否决、目标恒失败且无
     * 任何回退命中。resolve_target 改为只保留被允许的子集继续
     * （连接器钉住的地址仍逐个过 allowed_ip、永不连被拒地址）；
     * 子集为空才整组拒绝（check_addresses 语义不变）。 */
    #[test]
    fn strict_subset_keeps_allowed_addresses_of_mixed_answers() {
        let mixed: Vec<SocketAddr> = ["1.1.1.1:443", "192.168.1.1:443", "[2001::1]:443"]
            .iter()
            .map(|s| s.parse().unwrap())
            .collect();
        assert_eq!(
            strict_allowed_subset(&mixed),
            vec!["1.1.1.1:443".parse::<SocketAddr>().unwrap()],
            "公网＋内网＋Teredo 混合集只保留公网"
        );
        let fake_mixed: Vec<SocketAddr> = ["198.19.0.1:443", "[2001::1]:443"]
            .iter()
            .map(|s| s.parse().unwrap())
            .collect();
        assert_eq!(
            strict_allowed_subset(&fake_mixed),
            vec!["198.19.0.1:443".parse::<SocketAddr>().unwrap()],
            "FakeIP＋Teredo 混合集保留 FakeIP（后续走 fake_trusted 分支）"
        );
        let all_bad: Vec<SocketAddr> = ["10.0.0.1:443", "[fe80::1]:443"]
            .iter()
            .map(|s| s.parse().unwrap())
            .collect();
        assert!(strict_allowed_subset(&all_bad).is_empty(), "全被拒时子集为空、由调用方整组拒绝");
    }

    /* fix338 签名②（3.3.7 真机 source-009/010 点播，调查
     * fix338/investigation-338.md）：FakeIP 的 IPv6 合成池（ULA：
     * sing-box fake-ip6 默认 fc00::/18、mihomo 默认
     * fdfe:dcba:9876::/64）与 v4 198.18.0.0/15 同口径——答案集
     * 全为合成形态时走 fake 分支放行。旧码 allowed_ip 的 v6 分支
     * 只认全球单播，AAAA-only 合成集子集为空、整组以「禁止访问
     * 普通内网、回环或保留地址」拒绝（调查探针在旧码上字面复现
     * 同一文案，真机 kind=private_address_denied ×12）。 */
    #[tokio::test]
    async fn strict_resolve_target_accepts_all_synthetic_answers() {
        let ula = Url::parse("https://[fc00::abcd]/seg.ts").unwrap();
        let addrs = resolve_target(&ula, true)
            .await
            .expect("AAAA-only ULA 合成集应放行（fake 分支）");
        assert_eq!(
            addrs,
            vec!["[fc00::abcd]:443".parse::<SocketAddr>().unwrap()]
        );
        let mihomo = Url::parse("https://[fdfe:dcba:9876::1]/seg.ts").unwrap();
        assert!(
            resolve_target(&mihomo, true).await.is_ok(),
            "mihomo fake-ip6 池形态同样放行"
        );
        // 非合成的真实内网字面集维持拒绝（fake 分支只收全合成集）。
        let lan = Url::parse("https://192.168.1.1/seg.ts").unwrap();
        assert!(resolve_target(&lan, true).await.is_err(), "真实内网地址维持拒绝");
        let lan6 = Url::parse("https://[fe80::1]/seg.ts").unwrap();
        assert!(resolve_target(&lan6, true).await.is_err(), "链路本地维持拒绝");
    }

    /* fix338 签名②采用口径（任务夹具三组形态）：全合成集走
     * ByHostname 不钉死、混合集子集保留、真内网集仍拒；两采用
     * 点（resolve_target 与 public_dns 分支）共用本函数，同一
     * 答案集不得两处异命运——旧 public_dns 整组校验对
     * 「FakeIP＋Teredo」集为 Err、与子集口径矛盾，本组钉住。 */
    #[test]
    fn adopt_addresses_unifies_subset_and_fake_semantics() {
        let set = |raw: &[&str]| -> Vec<SocketAddr> {
            raw.iter().map(|s| s.parse().unwrap()).collect()
        };
        // AAAA-only ULA 合成集（真机形态）→ ByHostname。
        assert!(matches!(
            adopt_addresses(&set(&["[fc00::abcd]:443"]), true),
            Ok(AddressAdoption::ByHostname(_))
        ));
        // v4 FakeIP＋v6 合成混合集 → ByHostname。
        assert!(matches!(
            adopt_addresses(&set(&["198.18.0.5:443", "[fdfe:dcba:9876::1]:443"]), true),
            Ok(AddressAdoption::ByHostname(_))
        ));
        // FakeIP＋Teredo → 子集保留 FakeIP（旧整组校验此集为 Err）。
        assert_eq!(
            adopt_addresses(&set(&["198.18.0.5:443", "[2001::1]:443"]), true),
            Ok(AddressAdoption::Pin(set(&["198.18.0.5:443"])))
        );
        // 公网＋ULA → 只保留公网（非 fake 分支的真实 ULA 维持拒绝）。
        assert_eq!(
            adopt_addresses(&set(&["1.1.1.1:443", "[fd00::1]:443"]), true),
            Ok(AddressAdoption::Pin(set(&["1.1.1.1:443"])))
        );
        // 公网＋Teredo → 保留公网（两采用点同命运）。
        assert_eq!(
            adopt_addresses(&set(&["1.1.1.1:443", "[2001::1]:443"]), true),
            Ok(AddressAdoption::Pin(set(&["1.1.1.1:443"])))
        );
        // 污染集（公网＋真内网）→ 子集保留公网（fix337 语义不回退）。
        assert_eq!(
            adopt_addresses(&set(&["1.1.1.1:443", "192.168.1.1:443"]), true),
            Ok(AddressAdoption::Pin(set(&["1.1.1.1:443"])))
        );
        // 真内网集 → 整组拒绝；空集 → 拒绝。
        assert!(adopt_addresses(&set(&["192.168.1.1:443", "10.0.0.1:443"]), true).is_err());
        assert!(adopt_addresses(&[], true).is_err());
        // 非 strict：全量保留（仅空集拒绝），与旧 check 语义一致。
        assert_eq!(
            adopt_addresses(&set(&["192.168.1.1:443"]), false),
            Ok(AddressAdoption::Pin(set(&["192.168.1.1:443"])))
        );
        assert!(adopt_addresses(&[], false).is_err());
    }

    #[test]
    fn mixed_dns_and_redirect_bypasses_are_blocked() {
        let addrs = [
            "1.1.1.1:443".parse().unwrap(),
            "192.168.1.1:443".parse().unwrap(),
        ];
        assert!(check_addresses(&addrs).is_err());
        assert!(check_addresses(&[]).is_err());
        let current = Url::parse("https://example.com/media").unwrap();
        assert!(redirect_target(&current, "//127.0.0.1/private").is_err());
        assert!(redirect_target(&current, "http://example.com/media").is_err());
        assert!(redirect_target(&current, "https://198.19.0.1/media").is_ok());
        assert_eq!(
            redirect_target(&current, "/next").unwrap().as_str(),
            "https://example.com/next"
        );
    }

    #[test]
    fn relaxed_mode_and_cli_flags_work_without_exposing_internal_hosts() {
        assert_eq!(parse_strict_override(["hghubx"], None), None);
        assert_eq!(
            parse_strict_override(["hghubx", "--no-strict"], None),
            Some(false)
        );
        assert_eq!(
            parse_strict_override(["hghubx", "--no-strict-security"], None),
            Some(false)
        );
        assert_eq!(
            parse_strict_override(["hghubx", "--no-strict", "--strict"], None),
            Some(true)
        );
        assert_eq!(parse_strict_override(["hghubx"], Some("0")), Some(false));
        assert!(parse_target_with_mode("http://10.0.0.1/video.m3u8", false).is_ok());
        assert!(parse_target_with_mode("http://nas.local/video.m3u8", false).is_ok());
        assert!(parse_target_with_mode("http://tauri.localhost/", false).is_err());
        assert!(parse_target_with_mode("http://hg.localhost/img", false).is_err());
        assert!(parse_target_with_mode("http://ipc.localhost/", false).is_err());
        assert!(parse_target_with_mode("javascript:alert(1)", false).is_err());
    }
}
