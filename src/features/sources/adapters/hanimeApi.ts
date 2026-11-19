/**
 * Hanime 官方 API v11 适配器（Muse 2026-11-19 fix330-hanime-api，
 * 模板 hanime-api）：协议事实据公开插件仓 Hentai-Park 的 hanime 源
 * （AGPL——只借协议事实、本文件代码原创）与 2026-11-19 本机实测
 * 对账。四段形态：
 * - 列表/搜索/详情：guest API 全量目录 GET
 *   guest.freeanimehentai.net/api/v11/search_hvs（无签名、无分页
 *   参数——服务端恒回全量，客户端排序/过滤/切片；目录进程内
 *   缓存 15 分钟、并发合流）。详情优先目录行，目录未收录时回落
 *   详情页 HTML 的 og 元信息。
 * - 播放（resolve）：站点官方握手——GET ct.hanime.tv/csrf-token
 *   取 CSRF → 明文 {timestamp_unix, directive, slug} 以
 *   AES-256-GCM 封入信封（密钥 = SHA-256(公开常数串)、AAD = 公开
 *   常数串）→ 经 fetchPost 定向接缝 POST auth.hanime.tv/
 *   api/v11/handshake（签名头 x-signature = SHA-256(time 与公开
 *   常数拼接)、x-signature-version: web2）→ 响应 x-token 头回
 *   同形加密信封，解密得 sources 流表，只收 kind="normal" 且
 *   src 形如 /hls/<画质>/<令牌> 的条目、按画质降序。
 *   CSRF 失效（error_id = CSRF_ERROR_1..4）时重取 CSRF 重试一次。
 * 密钥/签名材料全是站点公开协议常数，不涉及任何用户凭据；
 * 令牌、签名值、信封内容一律不入日志/错误文本（不变量 10）——
 * 错误只报固定形态（HTTP 状态/段名）。
 */
import type { SourceAdapter, SourceDef, SourceItem, SourceStream } from "../types.ts";
import { fetchPage } from "./fetchPage.ts";
import { fetchPost } from "./fetchPost.ts";
import { HANIME_AUTH_ORIGIN, HANIME_CT_ORIGIN, HANIME_GUEST_ORIGIN } from "./fetchOrigins.ts";
import { metaContent, pageOf, stripTags } from "./parse.ts";
import { SourceParseEmptyError } from "./templates.ts";

const CATALOG_URL = `${HANIME_GUEST_ORIGIN}/api/v11/search_hvs`;
const CSRF_URL = `${HANIME_CT_ORIGIN}/csrf-token`;
const HANDSHAKE_URL = `${HANIME_AUTH_ORIGIN}/api/v11/handshake`;
const CATALOG_TTL_MS = 15 * 60 * 1000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,219}$/;

interface HanimeRow {
  slug?: unknown;
  name?: unknown;
  search_titles?: unknown;
  description?: unknown;
  cover_url?: unknown;
  poster_url?: unknown;
  brand?: unknown;
  views?: unknown;
  created_at_unix?: unknown;
  tags?: unknown;
}

function tagNames(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => (typeof t === "string" ? t : (t as { name?: unknown })?.name))
    .filter((x): x is string => typeof x === "string" && x.length > 0);
}

function absUrl(base: string, href: string): string {
  try { return new URL(href, base).href; } catch { return ""; }
}

/* ── 加密原语（WebCrypto；密钥/签名均为公开协议常数） ── */

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(value: string): Uint8Array {
  if (typeof value !== "string" || value.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("信封字段形态无效");
  }
  const bin = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const HANDSHAKE_AAD = new TextEncoder().encode("htv-insecure-v1");

async function handshakeKey(): Promise<CryptoKey> {
  const hex = await sha256Hex("htv-insecure-handshake-v1");
  return crypto.subtle.importKey("raw", hexToBytes(hex) as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** AES-256-GCM 密封：返回 {iv, tag, data} 的 base64url 形态
 * （WebCrypto 输出密文尾附 16 字节 tag，信封按协议拆开存放）。 */
export async function sealEnvelope(plaintext: string, iv: Uint8Array): Promise<{ iv: string; tag: string; data: string }> {
  const key = await handshakeKey();
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: HANDSHAKE_AAD as BufferSource },
    key,
    new TextEncoder().encode(plaintext) as BufferSource,
  ));
  return {
    iv: b64urlEncode(iv),
    tag: b64urlEncode(sealed.slice(-16)),
    data: b64urlEncode(sealed.slice(0, -16)),
  };
}

async function openEnvelope(envelopeJson: string): Promise<string> {
  const env = JSON.parse(envelopeJson) as { v?: unknown; alg?: unknown; iv?: unknown; tag?: unknown; data?: unknown };
  if (env.v !== 1 || env.alg !== "AES-256-GCM") throw new Error("信封版本或算法不符");
  const key = await handshakeKey();
  const data = b64urlDecode(String(env.data));
  const tag = b64urlDecode(String(env.tag));
  const iv = b64urlDecode(String(env.iv));
  const joined = new Uint8Array(data.length + tag.length);
  joined.set(data); joined.set(tag, data.length);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: HANDSHAKE_AAD as BufferSource },
    key,
    joined as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

/** web2 请求签名：SHA-256(time + ",Xkdi29," + BASE + ",mn2," + time)。 */
export function hanimeSignatureHex(time: string, base: string): Promise<string> {
  return sha256Hex(`${time},Xkdi29,${base},mn2,${time}`);
}

/** 握手请求构造（纯函数形态：now/iv 注入，便于契约夹具定值验证）。
 * 返回 POST 正文与固定头名单内的请求头；CSRF 只进 x-csrf-token 头。 */
export async function buildHandshakeRequest(
  slug: string,
  csrfToken: string,
  base: string,
  nowMs: number,
  iv: Uint8Array,
): Promise<{ body: string; headers: Record<string, string> }> {
  const payload = JSON.stringify({
    timestamp_unix: Math.floor(nowMs / 1000),
    directive: "htv_player_handshake",
    slug,
  });
  const sealed = await sealEnvelope(payload, iv);
  const envelope = JSON.stringify({ v: 1, alg: "AES-256-GCM", iv: sealed.iv, tag: sealed.tag, data: sealed.data });
  const token = b64urlEncode(new TextEncoder().encode(envelope));
  const time = String(Math.floor(nowMs / 1000));
  return {
    body: JSON.stringify({ token }),
    headers: {
      Referer: `${base}/videos/hentai/${slug}`,
      Origin: base,
      "Content-Type": "application/json",
      "x-signature-version": "web2",
      "x-time": time,
      "x-signature": await hanimeSignatureHex(time, base),
      "x-csrf-token": csrfToken,
    },
  };
}

/** 握手响应判读：x-token（base64url 的信封 JSON）→ 解密 → 流表。
 * 只收 kind="normal"、src 形如 /hls/<数字>/<令牌>、画质为合法
 * 正整数的条目，去重后按画质降序；推广位（非 normal）不入表。 */
export async function openHandshakeResponse(xToken: string, base: string): Promise<SourceStream[]> {
  const envelopeJson = new TextDecoder().decode(b64urlDecode(xToken));
  const plain = await openEnvelope(envelopeJson);
  const data = JSON.parse(plain) as { sources?: unknown };
  const seen = new Set<string>();
  const streams: SourceStream[] = [];
  for (const raw of Array.isArray(data.sources) ? data.sources : []) {
    const s = raw as { kind?: unknown; src?: unknown; height?: unknown };
    if (s?.kind !== "normal" || typeof s.src !== "string") continue;
    if (!/^\/hls\/\d+\/[A-Za-z0-9]{1,1024}$/.test(s.src) || seen.has(s.src)) continue;
    const height = Number(s.height);
    if (!Number.isInteger(height) || height <= 0 || height > 4320) continue;
    seen.add(s.src);
    streams.push({ url: `${base}${s.src}`, kind: "hls" });
  }
  streams.sort((a, b) => Number(/\/hls\/(\d+)\//.exec(b.url)?.[1] ?? 0) - Number(/\/hls\/(\d+)\//.exec(a.url)?.[1] ?? 0));
  return streams;
}

/* ── 适配器 ── */

export function createHanimeApiAdapter(def: SourceDef): SourceAdapter {
  const base = def.baseUrls[0];
  let catalog: HanimeRow[] | null = null;
  let catalogAt = 0;
  let pending: Promise<HanimeRow[]> | null = null;

  const loadCatalog = async (): Promise<HanimeRow[]> => {
    if (catalog && Date.now() - catalogAt < CATALOG_TTL_MS) return catalog;
    if (!pending) {
      pending = (async () => {
        const raw = await fetchPage(CATALOG_URL);
        const parsed = JSON.parse(raw) as HanimeRow[] | { data?: HanimeRow[] };
        const rows = Array.isArray(parsed) ? parsed : parsed.data;
        if (!Array.isArray(rows)) throw new Error("Hanime 目录数据无效");
        const clean = rows.filter((r) => r && typeof r.slug === "string" && typeof r.name === "string");
        catalog = clean;
        catalogAt = Date.now();
        return clean;
      })().finally(() => { pending = null; });
    }
    return pending;
  };

  const toItem = (row: HanimeRow): SourceItem => {
    const slug = String(row.slug);
    return {
      sourceId: def.id,
      externalId: slug,
      title: String(row.name),
      cover: absUrl(base, String(row.cover_url ?? "")),
      href: `${base}/videos/hentai/${slug}`,
      tags: tagNames(row.tags),
      hot: typeof row.views === "number" ? row.views : undefined,
    };
  };

  const byNewest = (rows: HanimeRow[]): HanimeRow[] =>
    [...rows].sort((a, b) => Number(b.created_at_unix ?? 0) - Number(a.created_at_unix ?? 0));

  const pageSlice = (rows: HanimeRow[], page: number, size: number) => ({
    items: rows.slice((page - 1) * size, page * size).map(toItem),
    pagination: pageOf(rows.length, page, size),
  });

  const assertSlug = (id: string): string => {
    if (!SLUG_RE.test(id)) throw new Error("Hanime 条目编号无效");
    return id;
  };

  return {
    sourceId: def.id,
    async list(page, size) {
      const rows = byNewest(await loadCatalog());
      if (rows.length === 0) throw new SourceParseEmptyError(def.id);
      return pageSlice(rows, page, size);
    },
    async search(q, page, size) {
      const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const rows = await loadCatalog();
      if (words.length === 0) return pageSlice(byNewest(rows), page, size);
      const matched = rows.filter((r) => {
        const hay = [r.name, r.search_titles, r.description, r.brand, tagNames(r.tags).join(" ")]
          .map((v) => String(v ?? "").toLowerCase())
          .join(" ");
        return words.every((w) => hay.includes(w));
      });
      return pageSlice(byNewest(matched), page, size);
    },
    async detail(id) {
      const slug = assertSlug(id);
      const rows = await loadCatalog().catch(() => [] as HanimeRow[]);
      const row = rows.find((r) => r.slug === slug);
      if (row) {
        const item = toItem(row);
        return {
          ...item,
          description: stripTags(String(row.description ?? "")),
          images: [absUrl(base, String(row.poster_url ?? ""))].filter(Boolean),
          episodes: [{ label: "正片", externalId: slug }],
        };
      }
      /* 目录未收录：回落详情页 HTML 的 og 元信息（与旧抓页形态同口径）。 */
      const html = await fetchPage(`${base}/videos/hentai/${slug}`);
      const title = metaContent(html, "og:title");
      if (!title) throw new Error("Hanime 条目不存在或详情不可用");
      return {
        sourceId: def.id, externalId: slug, title,
        cover: absUrl(base, metaContent(html, "og:image")),
        href: `${base}/videos/hentai/${slug}`, tags: [],
        description: metaContent(html, "description"),
        images: [], episodes: [{ label: "正片", externalId: slug }],
      };
    },
    async resolve(id) {
      const slug = assertSlug(id);
      for (let attempt = 0; attempt < 2; attempt++) {
        const csrfRaw = await fetchPage(CSRF_URL);
        const csrf = (JSON.parse(csrfRaw) as { csrf_token?: unknown }).csrf_token;
        if (typeof csrf !== "string" || !csrf) throw new Error("Hanime 握手失败：CSRF 令牌不可用");
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const req = await buildHandshakeRequest(slug, csrf, base, Date.now(), iv);
        const res = await fetchPost(HANDSHAKE_URL, req.body, req.headers);
        if (res.status >= 200 && res.status < 300 && res.xToken) {
          return { streams: await openHandshakeResponse(res.xToken, base) };
        }
        let errorId = "";
        try { errorId = String((JSON.parse(res.body) as { error_id?: unknown }).error_id ?? ""); } catch { /* 正文非 JSON：按状态判读 */ }
        if (attempt === 0 && /^CSRF_ERROR_[1-4]$/.test(errorId)) continue;
        throw new Error(`Hanime 握手失败：HTTP ${res.status}`);
      }
      throw new Error("Hanime 握手失败：CSRF 重试后仍未成功");
    },
  };
}
