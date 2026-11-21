/* ── file 流自检探针·多步实拉序列（Muse 2026-11-21 fix3311/file-leg-fix）──
 * 背景（3.3.10 真机定案，调查 fix3311/evidence/file-playback-stall-
 * investigation.md）：fix3310 的 file 探针只做一步——Range 取首段
 * 2KB 验 ftyp。真机 020/021 探针全绿、点播全灭，分叉在首步之后：
 * ①021 上游恒回 Content-Type: application/octet-stream，探针从不
 * 看响应类型，播放器却以 code 4 拒收（§A）；②两样本 moov 均在文
 * 件最尾，播放器解码前必须取尾段，探针零覆盖（§B）；③播放器的
 * 无 Range 形态请求（HEAD/裸 GET 等）在 App 侧旧形态落整段拼片
 * 级联，探针永不踩（§1/§2）。
 *
 * 本序列按播放器真实请求形态加固（定因报告「通用探针加固基线」
 * ＋候选 3 的 HEAD 等价调用），每步经同一本地 /seg 路由、单步超
 * 时与播放同值（20s，生产由 manifestProbe 注入）：
 *   步骤 0 · HEAD 等价调用——级联形态下此发必超时/502，先行判红；
 *   步骤 1 · bytes=0-1 试探（播放器对渐进式 MP4 的首发形态）；
 *   步骤 2 · 首段 bytes=0-2047＋ftyp 魔数（fix3310 原步保留）；
 *   步骤 3 · 尾段实拉（后缀 256KB）：206＋Content-Range 精确；
 *   步骤 4 · moov 定位判读：头部盒遍历定位 moov 盒头（在首段内
 *     直接验、在尾窗内以尾窗字节验、在两者之间定点补一发验；
 *     遍历无结论时尾窗内盒头扫描兜底）。
 *   响应类型判据贯穿 1–3 步：206/200 的 Content-Type 必须为
 *   video/*，否则以类型原文判失败（octet-stream 不许过关）。
 * 任一步失败即整条判取流不可达（抛 Error，文案口径与既有探针
 * 一致：Rust 侧错误正文原样、本地判读用固定中文形态）。
 *
 * 尾段耗时落账：本步请求经本地路由时，其 status/bytes/elapsed
 * 由 Rust 侧 proxy.end 逐请求落盘（resource 为 URL 哈希，不记
 * URL 本身，不变量 10）——尾段耗时即以该通道落账，本函数另以
 * 返回值 tailElapsedMs 交回调用方（自检引擎现行只收敛成败，暂
 * 不消费该值；慢尾判部分可用为定因候选 2 的后续项，不在本批）。
 *
 * 接缝纪律：本模块不 import shared/api（node 契约环境不可直导
 * 入——manifestProbe 既有约束），fetch 与超时由生产实现
 * （manifestProbe.ts）注入全局 fetch，契约以脚本化假 fetch 隔离
 * 行为测试。 */

export interface FileProbeResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export type FileProbeFetch = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; signal: AbortSignal },
) => Promise<FileProbeResponse>;

/** 步骤 1 的试探 Range（播放器对渐进式 MP4 的首发形态）。 */
export const FILE_PROBE_PING_RANGE = "bytes=0-1";
/** 步骤 2 的首段 Range：覆盖 ftyp 魔数与盒链头部（与设备链 MP4
 * 用例同口径）。 */
export const FILE_PROBE_HEAD_RANGE = "bytes=0-2047";
/** 步骤 3 的尾段窗口：验尾段可达性与响应头；moov 盒头定位走盒
 * 遍历＋按需定点取数，不依赖尾窗覆盖整个 moov（样本 moov
 * 0.76MB/1.7MB 均大于本窗）。 */
export const FILE_PROBE_TAIL_WINDOW = 262_144;

export interface FileProbeOutcome {
  /** 探得的文件总长（字节）。 */
  totalBytes: number;
  /** 步骤 3 尾段实拉耗时（ms，performance.now 口径）。 */
  tailElapsedMs: number;
}

async function send(
  fetchImpl: FileProbeFetch,
  url: string,
  init: { method?: string; headers?: Record<string, string> },
  timeoutMs: number,
): Promise<FileProbeResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 非 2xx 的处置与既有探针同口径：Rust 正文即错误原文，原样抛。 */
async function ensureOk(r: FileProbeResponse): Promise<void> {
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(body.trim() || `HTTP ${r.status}`);
  }
}

/** 响应类型判据（定因基线④）：必须 video/*，否则以原文判失败。 */
function requireVideoType(r: FileProbeResponse): void {
  const ct = r.headers.get("content-type");
  if (!ct || !ct.toLowerCase().startsWith("video/")) {
    throw new Error(`响应类型不是视频类型（Content-Type: ${ct ?? "缺失"}）`);
  }
}

function parseLength(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

interface ContentRange {
  start: number;
  end: number;
  total: number;
}

function parseContentRange(r: FileProbeResponse): ContentRange | null {
  const raw = r.headers.get("content-range");
  if (!raw) return null;
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(raw.trim());
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) };
}

function u32be(b: Uint8Array, off: number): number {
  return (b[off] * 0x1_0000_00 + ((b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3])) >>> 0;
}

function u64be(b: Uint8Array, off: number): number {
  return u32be(b, off) * 0x1_0000_0000 + u32be(b, off + 4);
}

function boxTypeAt(b: Uint8Array, off: number): string {
  return String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
}

function isMoovAt(b: Uint8Array, off: number): boolean {
  return off >= 0 && off + 8 <= b.length && boxTypeAt(b, off) === "moov";
}

/** 头部盒遍历定位 moov 盒头偏移（定因基线③的强判读）：
 * - 遍历中直接遇 moov → 其偏移；
 * - 遇 mdat → moov 应紧随其后 → 返回 mdat 终点（候选偏移，可能
 *   超出已取字节，由调用方按覆盖面判读/定点补取）；
 * - mdat 的 size 为 0（盒延至文件尾）→ 其后无 moov，返回 -1；
 * - 盒头超出已取字节或结构非法 → null（调用方走尾窗扫描兜底）。 */
function locateMoovOffset(head: Uint8Array, total: number): number | null {
  let off = 0;
  while (off + 8 <= head.length) {
    const size32 = u32be(head, off);
    const type = boxTypeAt(head, off);
    let header = 8;
    let size: number;
    if (size32 === 1) {
      if (off + 16 > head.length) return null;
      size = u64be(head, off + 8);
      header = 16;
    } else if (size32 === 0) {
      return type === "mdat" ? -1 : null;
    } else {
      size = size32;
    }
    if (size < header) return null;
    if (type === "moov") return off;
    if (type === "mdat") return off + size;
    off += size;
    if (off >= total) return -1;
  }
  return null;
}

/** 尾窗内 moov 盒头扫描（遍历无结论时的兜底判读）：找一个盒长
 * 自洽（≥8 且不越文件尾）的 moov 盒头。 */
function scanMoovInTail(tail: Uint8Array, tailStart: number, total: number): boolean {
  for (let i = 0; i + 8 <= tail.length; i++) {
    if (boxTypeAt(tail, i) !== "moov") continue;
    const size = u32be(tail, i);
    if (size >= 8 && tailStart + i + size <= total) return true;
  }
  return false;
}

/** file 流多步实拉：全步通过返回总长与尾段耗时，任一步失败抛
 * Error（口径见文件头）。url 为已包好的本地 /seg 路由地址。 */
export async function probeFileStream(
  segUrl: string,
  fetchImpl: FileProbeFetch,
  timeoutMs: number,
): Promise<FileProbeOutcome> {
  /* 步骤 0 · HEAD 等价调用：抓无 Range 级联（定因候选 3）。 */
  const headResp = await send(fetchImpl, segUrl, { method: "HEAD" }, timeoutMs);
  await ensureOk(headResp);
  let total = parseLength(headResp.headers.get("content-length"));

  /* 步骤 1 · bytes=0-1 试探。 */
  const ping = await send(fetchImpl, segUrl, { headers: { Range: FILE_PROBE_PING_RANGE } }, timeoutMs);
  await ensureOk(ping);
  requireVideoType(ping);
  total ??= parseContentRange(ping)?.total ?? null;

  /* 步骤 2 · 首段＋ftyp（fix3310 原步）。 */
  const head = await send(fetchImpl, segUrl, { headers: { Range: FILE_PROBE_HEAD_RANGE } }, timeoutMs);
  await ensureOk(head);
  requireVideoType(head);
  const headBytes = new Uint8Array(await head.arrayBuffer());
  const magic = headBytes.length >= 8
    ? String.fromCharCode(headBytes[4], headBytes[5], headBytes[6], headBytes[7])
    : "";
  if (magic !== "ftyp") {
    throw new Error("响应不是 MP4 文件（ftyp 魔数不符）");
  }
  total ??= parseContentRange(head)?.total ?? null;
  /* 200 全量体（小文件整段返回形态）即文件全图：总长以其实长
   * 为准，moov 判读直接在全图上做。 */
  let fullBody: Uint8Array | null = head.status === 200 ? headBytes : null;
  if (fullBody) total = fullBody.length;

  /* 步骤 3 · 尾段实拉：后缀窗一发，Content-Range 须精确（起点
   * ＝总长−窗口、终点＝总长−1、总长与头部所见一致）。 */
  const tailBegin = performance.now();
  const tail = await send(
    fetchImpl,
    segUrl,
    { headers: { Range: `bytes=-${FILE_PROBE_TAIL_WINDOW}` } },
    timeoutMs,
  );
  const tailElapsedMs = performance.now() - tailBegin;
  await ensureOk(tail);
  requireVideoType(tail);
  const tailBytes = new Uint8Array(await tail.arrayBuffer());
  if (tail.status === 200 && !fullBody) {
    fullBody = tailBytes;
    total = tailBytes.length;
  }
  let tailStart = 0;
  const cr = parseContentRange(tail);
  if (cr) {
    const expectedStart = cr.total - Math.min(FILE_PROBE_TAIL_WINDOW, cr.total);
    if (cr.start !== expectedStart || cr.end !== cr.total - 1 || tailBytes.length !== cr.end - cr.start + 1) {
      throw new Error("尾段 Content-Range 与请求区间不一致");
    }
    if (total !== null && total !== cr.total) {
      throw new Error("尾段总长与头部所见不一致");
    }
    total = cr.total;
    tailStart = cr.start;
  } else if (fullBody) {
    tailStart = Math.max(0, fullBody.length - FILE_PROBE_TAIL_WINDOW);
  }
  if (total === null) {
    throw new Error("无法确定流总长（无 Content-Length/Content-Range），尾段不可验");
  }

  /* 步骤 4 · moov 定位判读（定因基线③）。 */
  const image = fullBody;
  const candidate = locateMoovOffset(image ?? headBytes, total);
  if (candidate === -1) {
    throw new Error("文件无 moov 盒（mdat 之后无 moov）");
  }
  if (candidate !== null && candidate >= total) {
    throw new Error("文件无 moov 盒（mdat 终点即文件尾）");
  }
  let moovOk = false;
  if (candidate !== null) {
    if (image) {
      moovOk = isMoovAt(image, candidate);
    } else if (isMoovAt(headBytes, candidate)) {
      moovOk = true;
    } else if (candidate >= tailStart && isMoovAt(tailBytes, candidate - tailStart)) {
      moovOk = true;
    } else {
      /* 候选在首段与尾窗之间：定点补一发小窗验盒头。 */
      const spot = await send(
        fetchImpl,
        segUrl,
        { headers: { Range: `bytes=${candidate}-${candidate + 2047}` } },
        timeoutMs,
      );
      await ensureOk(spot);
      requireVideoType(spot);
      const spotBytes = new Uint8Array(await spot.arrayBuffer());
      moovOk = isMoovAt(spotBytes, 0);
    }
  }
  if (!moovOk && candidate === null) {
    moovOk = scanMoovInTail(tailBytes, tailStart, total)
      || (image !== null && scanMoovInTail(image, 0, total));
  }
  if (!moovOk) {
    throw new Error("尾段未见 moov 盒（moov 不可达或文件不完整）");
  }
  return { totalBytes: total, tailElapsedMs };
}
