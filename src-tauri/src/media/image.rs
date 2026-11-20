//! Image cache and AES-128-CBC cover decryption.

use super::ByteLru;
use crate::net::fetch_bytes_capped_with_page;
use aes::cipher::{BlockDecrypt, KeyInit};
use aes::Aes128;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex, Weak};

const IMG_KEY: &[u8] = b"f5d965df75336270";
const IMG_IV: &[u8] = b"97b60394abc2fbe1";

/// 封面缓存（P2-13）：真 LRU＋总字节预算 32MB＋单条上限 8MB——旧制
/// 只有 240 条条数上限、无单条/总字节上限，异常大图单条即可顶穿。
static IMG_CACHE: Lazy<Mutex<ByteLru<Arc<Vec<u8>>>>> =
    Lazy::new(|| Mutex::new(ByteLru::new(IMG_CACHE_MAX, IMG_CACHE_BUDGET_BYTES)));
type ImageResult = Result<(String, Arc<Vec<u8>>), String>;
type ImageLoad = tokio::sync::OnceCell<ImageResult>;
// 背景、视频 poster 和详情可能同时请求同一张图，共享下载和解密。
// 弱引用不保留已完成任务/错误；图片重试仍可发起新的请求。
static IMG_LOADING: Lazy<Mutex<HashMap<(u64, String), Weak<ImageLoad>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static IMG_GENERATION: AtomicU64 = AtomicU64::new(0);
const IMG_CACHE_MAX: usize = 240;
const IMG_CACHE_BUDGET_BYTES: usize = 32 * 1024 * 1024;
/// 图片类下载上限（P2-13 资源类分档：分片 16MB/图片 8MB/清单 4MB）。
const IMG_MAX_BYTES: usize = 8 * 1024 * 1024;

/* ───────────────────────── AES ───────────────────────── */

fn aes_cbc_decrypt(data: &[u8]) -> Option<Vec<u8>> {
    if data.is_empty() || data.len() % 16 != 0 {
        return None;
    }
    let cipher = Aes128::new_from_slice(IMG_KEY).ok()?;
    let mut prev = [0u8; 16];
    prev.copy_from_slice(IMG_IV);
    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks(16) {
        let mut ct = [0u8; 16];
        ct.copy_from_slice(chunk);
        let mut block = ct;
        cipher.decrypt_block((&mut block).into());
        for i in 0..16 {
            out.push(block[i] ^ prev[i]);
        }
        prev = ct;
    }
    Some(out)
}

fn strip_padding(mut buf: Vec<u8>) -> Vec<u8> {
    let pad = *buf.last().unwrap_or(&0) as usize;
    if pad > 0 && pad <= 16 && buf.len() >= pad {
        if buf[buf.len() - pad..].iter().all(|b| *b as usize == pad) {
            buf.truncate(buf.len() - pad);
        }
    }
    buf
}

fn image_kind(buf: &[u8]) -> Option<&'static str> {
    if buf.len() < 12 {
        return None;
    }
    if buf[0] == 0xFF && buf[1] == 0xD8 {
        return Some("image/jpeg");
    }
    if buf.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return Some("image/png");
    }
    if buf.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if buf.starts_with(b"RIFF") && &buf[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// 取封面：命中缓存直接返回；同地址的进行中请求共享下载和解密结果。
/// page（fix338/realphoto-add）：/img 的 p= 页面 Referer（详情页地址），
/// 只影响首次下载的 Referer 候选链、不进缓存键——同一图片字节与来
/// 源页无关，命中缓存时不重走候选链。
pub async fn load_image(url: &str, page: Option<&str>) -> ImageResult {
    let req_scope = crate::net::request_scope();
    let generation = IMG_GENERATION.load(Ordering::Acquire);
    let cache_key = format!("{}:{}:{generation}:{url}", u8::from(req_scope.strict), req_scope.generation);
    if let Some(hit) = IMG_CACHE.lock().unwrap().get(&cache_key) {
        let kind = image_kind(&hit).unwrap_or("image/jpeg");
        return Ok((kind.to_string(), hit));
    }
    let loading = {
        let mut requests = IMG_LOADING.lock().unwrap();
        requests.retain(|_, request| request.strong_count() > 0);
        let key = (generation, cache_key.clone());
        if let Some(request) = requests.get(&key).and_then(Weak::upgrade) {
            request
        } else {
            let request = Arc::new(ImageLoad::new());
            requests.insert(key, Arc::downgrade(&request));
            request
        }
    };
    let page = page.map(str::to_string);
    loading.get_or_init(|| download_image(url, &cache_key, req_scope, generation, page.as_deref())).await.clone()
}

async fn download_image(url: &str, cache_key: &str, req_scope: crate::net::RequestScope, generation: u64, page: Option<&str>) -> ImageResult {
    // 缓存检查与领取任务之间，另一请求可能已完成。
    if let Some(hit) = IMG_CACHE.lock().unwrap().get(cache_key) {
        let kind = image_kind(&hit).unwrap_or("image/jpeg");
        return Ok((kind.to_string(), hit));
    }
    let (_, bytes) = fetch_bytes_capped_with_page(url, IMG_MAX_BYTES, page).await?;
    let plain = if image_kind(&bytes).is_some() {
        bytes
    } else {
        let dec = aes_cbc_decrypt(&bytes).ok_or_else(|| "封面解密失败".to_string())?;
        strip_padding(dec)
    };
    let kind = image_kind(&plain).ok_or_else(|| "封面格式无效".to_string())?.to_string();
    let len = plain.len();
    let arc = Arc::new(plain);
    let mut cache = IMG_CACHE.lock().unwrap();
    // 清缓存或切换配置代次后，旧下载可完成当前显示，但不再把结果写回新一代缓存。
    if IMG_GENERATION.load(Ordering::Acquire) == generation && crate::net::request_scope() == req_scope {
        // 淘汰在 ByteLru 内：访问序 LRU＋总字节预算（P2-13）。
        cache.insert(cache_key.to_string(), arc.clone(), len);
    }
    Ok((kind, arc))
}

pub(super) fn clear_cache() {
    if let Ok(mut g) = IMG_CACHE.lock() {
        IMG_GENERATION.fetch_add(1, Ordering::AcqRel);
        g.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 离线回归：用已知明文 + 项目内置 key/IV 构造密文，验证解密、去填充与类型识别。
    /// 真实封面抓取那条仍保留为 `#[ignore]` 联网测试。
    #[test]
    fn cover_decrypt_roundtrip() {
        use aes::cipher::BlockEncrypt;

        let plain = b"\xFF\xD8\xFF\xE0cover-payload-for-test".to_vec();
        let mut buf = plain.clone();
        let pad = 16 - plain.len() % 16;
        buf.extend(std::iter::repeat_n(pad as u8, pad));

        let cipher = Aes128::new_from_slice(IMG_KEY).expect("key");
        let mut prev = [0u8; 16];
        prev.copy_from_slice(IMG_IV);
        let mut encrypted = Vec::with_capacity(buf.len());
        for chunk in buf.chunks(16) {
            let mut block = [0u8; 16];
            block.copy_from_slice(chunk);
            for i in 0..16 {
                block[i] ^= prev[i];
            }
            let mut out_block = block;
            cipher.encrypt_block((&mut out_block).into());
            encrypted.extend_from_slice(&out_block);
            prev = out_block;
        }

        let decrypted = aes_cbc_decrypt(&encrypted).expect("decrypt");
        let stripped = strip_padding(decrypted);
        assert_eq!(stripped, plain);
        assert_eq!(image_kind(&stripped), Some("image/jpeg"));
    }

    /// 联网测试：默认跳过。封面地址带时效签名，不能硬编码进仓库，
    /// 需要用当次上游返回的地址显式传入：
    /// `HGHUBX_TEST_COVER_URL='https://…?auth_key=…' cargo test --lib -- --ignored`
    #[tokio::test]
    #[ignore = "联网测试：需要 HGHUBX_TEST_COVER_URL，手动用 --ignored 运行"]
    async fn cover_decrypt_works() {
        let url = crate::env::var("TEST_COVER_URL")
            .expect("需要设置 HGHUBX_TEST_COVER_URL 为当前有效的封面地址");
        match load_image(&url, None).await {
            Ok((kind, bytes)) => {
                println!("kind={kind} len={}", bytes.len());
                assert!(kind.starts_with("image/"));
            }
            Err(e) => panic!("image failed: {e}"),
        }
    }
}
