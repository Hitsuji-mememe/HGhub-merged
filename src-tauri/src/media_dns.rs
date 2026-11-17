use crate::network_policy;
use serde_json::Value;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::{Duration, Instant};

pub(crate) const HOST: &str = "dns.alidns.com";
pub(crate) const BOOTSTRAP: [SocketAddr; 2] = [
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(223, 5, 5, 5)), 443),
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(223, 6, 6, 6)), 443),
];
const MAX_RESPONSE_BYTES: usize = 16 * 1024;

#[derive(Default)]
pub(crate) struct Routes(HashMap<String, Instant>);

impl Routes {
    pub(crate) fn prefers_public(&self, host: &str, now: Instant) -> bool {
        self.0.get(host).is_some_and(|expires| now < *expires)
    }

    pub(crate) fn remember(&mut self, host: &str, now: Instant) {
        self.0.retain(|_, expires| now < *expires);
        if self.0.len() >= 64 {
            self.0.clear();
        }
        self.0
            .insert(host.to_string(), now + Duration::from_secs(30));
    }

    pub(crate) fn forget(&mut self, host: &str) {
        self.0.remove(host);
    }
}

pub(crate) fn eligible(target: &url::Url, error: &str) -> bool {
    target.scheme() == "https"
        && matches!(target.host(), Some(url::Host::Domain(_)))
        && matches!(
            crate::playback_log::error_kind(error),
            "dns_error" | "timeout" | "transport_error"
        )
}

pub(crate) struct Resolution {
    pub(crate) addresses: Vec<SocketAddr>,
    pub(crate) ttl: Duration,
}

fn answers(value: &Value, port: u16) -> Result<Resolution, String> {
    if value["Status"].as_u64() != Some(0) {
        return Err("备用 DNS 解析失败".into());
    }
    let records = value["Answer"].as_array().ok_or("备用 DNS 没有可用地址")?;
    let mut addresses = Vec::new();
    let mut ttl = 30;
    for record in records {
        ttl = ttl.min(record["TTL"].as_u64().unwrap_or(0));
        if record["type"].as_u64() != Some(1) {
            continue;
        }
        let ip: Ipv4Addr = record["data"]
            .as_str()
            .ok_or("备用 DNS 地址无效")?
            .parse()
            .map_err(|_| "备用 DNS 地址无效")?;
        let [first, second, _, _] = ip.octets();
        if !network_policy::allowed_ip(ip.into())
            || (first == 198 && (18..=20).contains(&second))
        {
            return Err("备用 DNS 返回内网或保留地址".into());
        }
        addresses.push(SocketAddr::new(ip.into(), port));
    }
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.is_empty() || addresses.len() > 32 {
        return Err("备用 DNS 没有可用地址".into());
    }
    Ok(Resolution {
        addresses,
        ttl: Duration::from_secs(ttl),
    })
}

pub(crate) async fn resolve(
    http: &reqwest::Client,
    host: &str,
    port: u16,
) -> Result<Resolution, String> {
    let mut response = http
        .get(format!("https://{HOST}/resolve"))
        .query(&[("name", host), ("type", "A")])
        .timeout(Duration::from_secs(4))
        .send()
        .await
        .map_err(|_| "备用 DNS 请求失败")?
        .error_for_status()
        .map_err(|_| "备用 DNS 服务不可用")?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "备用 DNS 响应失败")? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("备用 DNS 响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "备用 DNS 响应无效")?;
    answers(&value, port)
}

// ===== UDP 直查（Muse 2026-11-14，2.0.9）=====
// 2.0.8 真机日志钉死：家里环境到 223.5.5.5:443 的 DoH HTTPS 通道整体不通
// （doh_error=「备用 DNS 请求失败」），全 fake 的域名因此永远回退假地址。
// UDP/53 是另一条物理通道，未必被堵：全 fake 时先手写最小 DNS 报文直查阿里，
// 失败再回落原 DoH。不引第三方 DNS 库；解析全程设界（响应 ID、answer 段、
// CNAME 跳过、压缩指针步数上限、报文长度上限），防劫持报文把解析器带偏。

const UDP_SERVER: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(223, 5, 5, 5)), 53);
const UDP_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_UDP_PACKET_BYTES: usize = 4096;
const MAX_POINTER_JUMPS: usize = 16;
const MAX_ANSWER_RECORDS: usize = 64;

fn encode_query(id: u16, host: &str, qtype: u16) -> Result<Vec<u8>, String> {
    let mut packet = Vec::with_capacity(64);
    packet.extend_from_slice(&id.to_be_bytes());
    packet.extend_from_slice(&0x0100u16.to_be_bytes()); // RD
    packet.extend_from_slice(&1u16.to_be_bytes()); // QDCOUNT
    packet.extend_from_slice(&0u16.to_be_bytes()); // ANCOUNT
    packet.extend_from_slice(&0u16.to_be_bytes()); // NSCOUNT
    packet.extend_from_slice(&0u16.to_be_bytes()); // ARCOUNT
    for label in host.split('.') {
        if label.is_empty()
            || label.len() > 63
            || !label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("备用 DNS 域名无效".into());
        }
        packet.push(label.len() as u8);
        packet.extend_from_slice(label.as_bytes());
    }
    packet.push(0);
    if packet.len() > 512 {
        return Err("备用 DNS 域名无效".into());
    }
    packet.extend_from_slice(&qtype.to_be_bytes());
    packet.extend_from_slice(&1u16.to_be_bytes()); // QCLASS = IN
    Ok(packet)
}

/// 跳过报文 pos 处的一个（可能带压缩指针的）域名，返回名字之后的位置。
/// 每一步都做界检；指针跟随次数封顶，指针自环/互环都会在此失败。
fn skip_name(packet: &[u8], mut pos: usize) -> Result<usize, String> {
    let mut end: Option<usize> = None;
    let mut jumps = 0usize;
    loop {
        let byte = *packet.get(pos).ok_or("备用 DNS 响应无效")?;
        match byte & 0xC0 {
            0xC0 => {
                let low = *packet.get(pos + 1).ok_or("备用 DNS 响应无效")? as usize;
                if end.is_none() {
                    end = Some(pos + 2);
                }
                jumps += 1;
                if jumps > MAX_POINTER_JUMPS {
                    return Err("备用 DNS 响应无效".into());
                }
                pos = ((byte as usize & 0x3F) << 8) | low;
            }
            0 => {
                if byte == 0 {
                    return Ok(end.unwrap_or(pos + 1));
                }
                pos += 1 + byte as usize; // 标签内容由下一轮 get 界检
            }
            _ => return Err("备用 DNS 响应无效".into()),
        }
    }
}

fn parse_udp_answers(packet: &[u8], id: u16, port: u16) -> Result<Resolution, String> {
    let read_u16 = |pos: usize| -> Result<u16, String> {
        let bytes = packet.get(pos..pos + 2).ok_or("备用 DNS 响应无效")?;
        Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
    };
    if packet.len() < 12 || read_u16(0)? != id {
        return Err("备用 DNS 响应无效".into());
    }
    let flags = read_u16(2)?;
    if flags & 0x8000 == 0 || flags & 0x000F != 0 {
        return Err("备用 DNS 响应无效".into()); // 必须是响应且 RCODE = 0
    }
    if flags & 0x0200 != 0 {
        return Err("备用 DNS 响应被截断".into()); // TC：无 EDNS 时答案可能不全，不冒险用
    }
    let qdcount = read_u16(4)? as usize;
    let ancount = read_u16(6)? as usize;
    if ancount > MAX_ANSWER_RECORDS {
        return Err("备用 DNS 响应无效".into());
    }
    let mut pos = 12usize;
    for _ in 0..qdcount {
        pos = skip_name(packet, pos)?;
        if pos + 4 > packet.len() {
            return Err("备用 DNS 响应无效".into());
        }
        pos += 4;
    }
    let mut addresses = Vec::new();
    let mut ttl = 30u64;
    for _ in 0..ancount {
        pos = skip_name(packet, pos)?;
        if pos + 10 > packet.len() {
            return Err("备用 DNS 响应无效".into());
        }
        let rr_type = read_u16(pos)?;
        let ttl_bytes = packet
            .get(pos + 4..pos + 8)
            .ok_or("备用 DNS 响应无效")?;
        let rr_ttl = u32::from_be_bytes([ttl_bytes[0], ttl_bytes[1], ttl_bytes[2], ttl_bytes[3]]) as u64;
        let rdlen = read_u16(pos + 8)? as usize;
        let rdata_start = pos + 10;
        let rdata_end = rdata_start
            .checked_add(rdlen)
            .filter(|end| *end <= packet.len())
            .ok_or("备用 DNS 响应无效")?;
        match (rr_type, rdlen) {
            (1, 4) => {
                addresses.push(SocketAddr::new(
                    IpAddr::V4(Ipv4Addr::new(
                        packet[rdata_start],
                        packet[rdata_start + 1],
                        packet[rdata_start + 2],
                        packet[rdata_start + 3],
                    )),
                    port,
                ));
                ttl = ttl.min(rr_ttl);
            }
            (28, 16) => {
                let mut bytes = [0u8; 16];
                bytes.copy_from_slice(&packet[rdata_start..rdata_end]);
                addresses.push(SocketAddr::new(IpAddr::V6(Ipv6Addr::from(bytes)), port));
                ttl = ttl.min(rr_ttl);
            }
            _ => {} // CNAME 等其余类型整段跳过
        }
        pos = rdata_end;
    }
    // 与 DoH answers() 同一套卫生校验：任一地址是内网/保留或 fake 段，整份答案作废，
    // 不能让网关劫持回的假地址混进钉住列表。
    for addr in &addresses {
        let ip = addr.ip();
        let fake_v4 = matches!(ip, IpAddr::V4(v4) if {
            let [first, second, _, _] = v4.octets();
            first == 198 && (18..=20).contains(&second)
        });
        if !network_policy::allowed_ip(ip) || fake_v4 {
            return Err("备用 DNS 返回内网或保留地址".into());
        }
    }
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.is_empty() || addresses.len() > 32 {
        return Err("备用 DNS 没有可用地址".into());
    }
    Ok(Resolution {
        addresses,
        ttl: Duration::from_secs(ttl),
    })
}

async fn query_udp(id: u16, host: &str, qtype: u16, target_port: u16) -> Result<Resolution, String> {
    let packet = encode_query(id, host, qtype)?;
    let socket = tokio::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .await
        .map_err(|_| "备用 DNS 请求失败")?;
    socket
        .connect(UDP_SERVER)
        .await
        .map_err(|_| "备用 DNS 请求失败")?;
    socket
        .send(&packet)
        .await
        .map_err(|_| "备用 DNS 请求失败")?;
    let mut buffer = vec![0u8; MAX_UDP_PACKET_BYTES];
    let received = tokio::time::timeout(UDP_TIMEOUT, socket.recv(&mut buffer))
        .await
        .map_err(|_| "备用 DNS 请求超时")?
        .map_err(|_| "备用 DNS 请求失败")?;
    buffer.truncate(received);
    parse_udp_answers(&buffer, id, target_port)
}

/// 向 223.5.5.5:53 直查 A 与 AAAA（并发各一次、不重试），合并可用答案。
/// 只问一轮：调用方在全 fake 分支才进来，后面还有 DoH 兜底，不能在这里放大等待。
pub(crate) async fn resolve_udp(host: &str, port: u16) -> Result<Resolution, String> {
    static NEXT_ID: AtomicU16 = AtomicU16::new(0x4d32);
    let seed = NEXT_ID.fetch_add(0x9e37, Ordering::Relaxed);
    let (a, aaaa) = tokio::join!(
        query_udp(seed, host, 1, port),
        query_udp(seed.wrapping_add(1), host, 28, port),
    );
    let mut addresses = Vec::new();
    let mut ttl = Duration::from_secs(30);
    let mut error: Option<String> = None;
    for result in [a, aaaa] {
        match result {
            Ok(resolution) => {
                ttl = ttl.min(resolution.ttl);
                addresses.extend(resolution.addresses);
            }
            Err(e) => error = Some(e),
        }
    }
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.is_empty() || addresses.len() > 32 {
        return Err(error.unwrap_or_else(|| "备用 DNS 没有可用地址".into()));
    }
    Ok(Resolution { addresses, ttl })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn public_answers_keep_the_target_port_and_shortest_dns_ttl() {
        let result = answers(
            &json!({"Status":0,"Answer":[
                {"type":5,"data":"edge.example.","TTL":5},
                {"type":1,"data":"1.1.1.1","TTL":60},
                {"type":1,"data":"1.1.1.1","TTL":60}
            ]}),
            8443,
        )
        .unwrap();
        assert_eq!(result.addresses, vec!["1.1.1.1:8443".parse().unwrap()]);
        assert_eq!(result.ttl, Duration::from_secs(5));
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "198.18.0.1",
            "198.19.0.1",
            "not-an-ip",
        ] {
            assert!(
                answers(
                    &json!({"Status":0,"Answer":[
                        {"type":1,"data":"1.1.1.1","TTL":60},
                        {"type":1,"data":ip,"TTL":60}
                    ]}),
                    443
                )
                .is_err(),
                "{ip}"
            );
        }
        for response in [json!({"Status":3}), json!({"Status":0,"Answer":[]})] {
            assert!(answers(&response, 443).is_err());
        }
    }

    #[test]
    fn recovery_only_applies_to_https_domains_and_connection_failures() {
        let url = url::Url::parse("https://media.example/list.m3u8?auth_key=secret").unwrap();
        for error in [
            "DNS 解析失败",
            "请求超时",
            "client error (Connect) ← operation timed out",
            "tls handshake eof",
        ] {
            assert!(eligible(&url, error));
        }
        for error in [
            "HTTP 403 Forbidden",
            "HTTP 404 Not Found",
            "HTTP 503 Service Unavailable",
            "禁止访问内网",
            "禁止 HTTPS 降级重定向",
        ] {
            assert!(!eligible(&url, error), "{error}");
        }
        for raw in [
            "http://media.example/video",
            "https://127.0.0.1/video",
            "https://[::1]/video",
        ] {
            assert!(!eligible(&url::Url::parse(raw).unwrap(), "请求超时"));
        }
    }

    #[test]
    fn recovered_hosts_expire_and_do_not_change_other_hosts() {
        let now = Instant::now();
        let mut routes = Routes::default();
        assert!(!routes.prefers_public("media.example", now));
        routes.remember("media.example", now);
        assert!(routes.prefers_public("media.example", now + Duration::from_secs(29)));
        assert!(!routes.prefers_public("other.example", now));
        assert!(!routes.prefers_public("media.example", now + Duration::from_secs(30)));
    }
    fn udp_response(id: u16, answers: &[u8], ancount: u16) -> Vec<u8> {
        let mut packet = Vec::new();
        packet.extend_from_slice(&id.to_be_bytes());
        packet.extend_from_slice(&0x8180u16.to_be_bytes());
        packet.extend_from_slice(&1u16.to_be_bytes());
        packet.extend_from_slice(&ancount.to_be_bytes());
        packet.extend_from_slice(&0u16.to_be_bytes());
        packet.extend_from_slice(&0u16.to_be_bytes());
        packet.extend_from_slice(&[
            7, b'e', b'x', b'a', b'm', b'p', b'l', b'e', 3, b'c', b'o', b'm', 0,
        ]);
        packet.extend_from_slice(&1u16.to_be_bytes());
        packet.extend_from_slice(&1u16.to_be_bytes());
        packet.extend_from_slice(answers);
        packet
    }

    fn a_record(ip: [u8; 4], ttl: u32) -> Vec<u8> {
        let mut record = vec![0xC0, 0x0C];
        record.extend_from_slice(&1u16.to_be_bytes());
        record.extend_from_slice(&1u16.to_be_bytes());
        record.extend_from_slice(&ttl.to_be_bytes());
        record.extend_from_slice(&4u16.to_be_bytes());
        record.extend_from_slice(&ip);
        record
    }

    #[test]
    fn udp_answers_skip_cname_and_collect_a_records() {
        let mut answers = vec![0xC0, 0x0C];
        answers.extend_from_slice(&5u16.to_be_bytes()); // CNAME
        answers.extend_from_slice(&1u16.to_be_bytes());
        answers.extend_from_slice(&60u32.to_be_bytes());
        answers.extend_from_slice(&2u16.to_be_bytes());
        answers.extend_from_slice(&[0xC0, 0x0C]);
        answers.extend_from_slice(&a_record([1, 2, 3, 4], 30));
        let packet = udp_response(0x1234, &answers, 2);
        let result = parse_udp_answers(&packet, 0x1234, 443).unwrap();
        assert_eq!(result.addresses, vec!["1.2.3.4:443".parse().unwrap()]);
        assert_eq!(result.ttl, Duration::from_secs(30));
        // ID 不符必须失败
        assert!(parse_udp_answers(&packet, 0x9999, 443).is_err());
    }

    #[test]
    fn udp_answers_reject_fake_ip_and_pointer_loops() {
        let fake = udp_response(0x1234, &a_record([198, 20, 0, 11], 30), 1);
        assert!(parse_udp_answers(&fake, 0x1234, 443).is_err());
        // 第一答的名字指针指向自己（偏移 29 = 12 头 + 13 问题名 + 4 类型/类）
        let mut looped = vec![0xC0, 0x1D];
        looped.extend_from_slice(&1u16.to_be_bytes());
        looped.extend_from_slice(&1u16.to_be_bytes());
        looped.extend_from_slice(&30u32.to_be_bytes());
        looped.extend_from_slice(&4u16.to_be_bytes());
        looped.extend_from_slice(&[1, 2, 3, 4]);
        let packet = udp_response(0x1234, &looped, 1);
        assert!(parse_udp_answers(&packet, 0x1234, 443).is_err());
        // 截断的报文
        assert!(parse_udp_answers(&packet[..10], 0x1234, 443).is_err());
    }

    #[test]
    fn recovered_hosts_expire_and_do_not_change_other_hosts() {
        let now = Instant::now();
        let mut routes = Routes::default();
        assert!(!routes.prefers_public("media.example", now));
        routes.remember("media.example", now);
        assert!(routes.prefers_public("media.example", now + Duration::from_secs(29)));
        assert!(!routes.prefers_public("other.example", now));
        assert!(!routes.prefers_public("media.example", now + Duration::from_secs(30)));
    }

}

/* ── 严格模式解析链（Muse 2026-11-18 自 net/client 拆入，移植自 2.0.x DNS 绕行） ──
 * client_for_dns 的 strict 分支调用：全 fake 时先 UDP 直查、再 DoH，最后回退系统结果；
 * ≥2 个真实答案时按 TCP 握手 RTT 竞速重排。 */
fn ipv4_kind(o: [u8; 4]) -> &'static str {
    let v4 = std::net::Ipv4Addr::from(o);
    if v4.is_loopback() { "loopback" } else if o == [0, 0, 0, 0] { "unspecified" }
    else if o[0] == 198 && (o[1] == 18 || o[1] == 19) { "fake_ip" }
    else if v4.is_private() { "private" } else if v4.is_link_local() { "link_local" }
    else if v4.is_broadcast() { "broadcast" } else { "public" }
}

pub fn ip_kind(ip: std::net::IpAddr) -> &'static str {
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
    crate::net::doh_resolver_client()
}
/// 经阿里 DoH 拿真实地址并做与系统解析同一套地址校验；TTL 与客户端缓存上限取小。
pub async fn resolve_via_doh(host: &str, port: u16, strict: bool) -> Result<(Vec<SocketAddr>, Duration), String> {
    let resolver = doh_resolver()?;
    let resolution = crate::media_dns::resolve(&resolver, host, port).await?;
    network_policy::check_addresses_with_mode(&resolution.addresses, strict)?;
    Ok((resolution.addresses, crate::net::CLIENT_TTL.min(resolution.ttl)))
}

/// 全 fake 时的第一绕行（Muse 2026-11-14，2.0.9）：向 223.5.5.5:53 走普通 UDP
/// DNS 直查拿真实地址。2.0.8 真机已钉死家里 DoH（443）通道不通，所以顺序是
/// UDP → DoH → fake 回退。UDP 答案若仍全是 fake 段（被网关劫持回假答案）视为失败；
/// 其余校验与 DoH 路径同一套（check_addresses_with_mode）。
pub async fn resolve_via_udp(host: &str, port: u16, strict: bool) -> Result<(Vec<SocketAddr>, Duration), String> {
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
    Ok((resolution.addresses, crate::net::CLIENT_TTL.min(resolution.ttl)))
}

/// 握手竞速重排（Muse 2026-11-14，2.0.9）：媒体主机的系统答案常有 2–9 个真实
/// 地址但顺序随机、快慢悬殊（Hark 实测同一主机国内 IP 握手 0.10s、海外 IP
/// 0.65–2.76s），原序钉给 reqwest 时先连上谁全凭运气。对前 8 个地址并发 TCP
/// connect 竞速（总窗口 300ms；有 <150ms 连上即可提前收工）：连上的按 RTT 升序
/// 排前，未连上/超时的保持原相对顺序跟在后面（可能只是慢、不是死，不能丢）；
/// 全都没连上则原序原样返回。竞速连接连上即弃、不发任何数据。
pub async fn race_answers(addrs: &[SocketAddr]) -> (Vec<SocketAddr>, Option<u64>) {
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
pub fn resolve_kinds(addrs: &[SocketAddr]) -> Vec<&'static str> {
    let mut kinds: Vec<&'static str> = addrs.iter().map(|addr| ip_kind(addr.ip())).collect();
    kinds.sort_unstable();
    kinds.dedup();
    kinds
}

/// strict 模式重解析决策（Muse 2026-11-18 自 net/client_for_dns 拆入）：
/// 全 fake → UDP 直查 → DoH → 回退 fake；≥2 真实答案 → 握手竞速重排；否则原样。
/// 返回 (地址, TTL)。`raw` 仅用于日志 resource_id。
pub async fn strict_reresolve(
    raw: &str,
    host: &str,
    port: u16,
    strict: bool,
    resolved: Vec<SocketAddr>,
) -> (Vec<SocketAddr>, Duration) {
    let system_kinds = resolve_kinds(&resolved);
    let all_fake = !resolved.is_empty() && resolved.iter().all(|addr| ip_kind(addr.ip()) == "fake_ip");
    if all_fake {
        match resolve_via_udp(host, port, strict).await {
            Ok(real) => {
                crate::playback_log::record("network.resolve", serde_json::json!({"host": host, "kinds": resolve_kinds(&real.0), "count": real.0.len(), "all_fake": true, "branch": "udp_dns"}));
                real
            }
            Err(udp_error) => match resolve_via_doh(host, port, strict).await {
                Ok(real) => {
                    crate::playback_log::record("network.dns_fallback", serde_json::json!({"resource": crate::playback_log::resource_id(raw), "public_dns": true, "reason": "fake_ip"}));
                    crate::playback_log::record("network.resolve", serde_json::json!({"host": host, "kinds": resolve_kinds(&real.0), "count": real.0.len(), "all_fake": true, "branch": "doh"}));
                    real
                }
                Err(error) => {
                    crate::playback_log::record("network.resolve", serde_json::json!({"host": host, "kinds": system_kinds, "count": resolved.len(), "all_fake": true, "branch": "fake_fallback", "doh_error": error, "udp_error": udp_error}));
                    (resolved, crate::net::CLIENT_TTL)
                }
            },
        }
    } else if resolved.len() >= 2 {
        let (raced, first_ms) = race_answers(&resolved).await;
        crate::playback_log::record("network.resolve", serde_json::json!({"host": host, "kinds": system_kinds, "count": resolved.len(), "all_fake": false, "branch": "system_raced", "first_ms": first_ms}));
        (raced, crate::net::CLIENT_TTL)
    } else {
        crate::playback_log::record("network.resolve", serde_json::json!({"host": host, "kinds": system_kinds, "count": resolved.len(), "all_fake": false, "branch": "system"}));
        (resolved, crate::net::CLIENT_TTL)
    }
}
