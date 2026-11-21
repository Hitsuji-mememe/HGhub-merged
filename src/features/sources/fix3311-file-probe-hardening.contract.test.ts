/**
 * fix3311 file 流探针加固契约（Muse 2026-11-21；本批任务书即维护
 * 者对新增测试的授权，AGENTS 不变量 11）：
 * 运行：node src/features/sources/fix3311-file-probe-hardening.contract.test.ts
 *
 * 立项（3.3.10 真机定案＋调查 fix3311/evidence/file-playback-stall-
 * investigation.md）：fix3310 的 file 探针只验首段 2KB 的 ftyp——
 * 020/021 探针全绿、点播全灭：①021 上游恒回 application/octet-
 * stream，探针不看响应类型、播放器以 code 4 拒收（§A）；②两样
 * 本 moov 均在文件最尾，探针对尾段全盲（§B）；③播放器的无 Range
 * 形态请求（HEAD 等）在 App 侧旧形态落整段拼片级联，探针永不
 * 踩（§1/§2）。本契约钉住加固后的多步序列（fileProbe.
 * probeFileStream）：HEAD 等价调用＋0-1 试探＋首段 ftyp＋尾段实
 * 拉验 moov＋响应类型须 video/*，全步经注入的脚本化假 fetch 隔
 * 离，不访问真实网络。
 *
 * 旧码红点：基线无 fileProbe.ts（导入即红）；且基线单步探针面对
 * 本契约的 octet-stream 替身与无 moov 替身都会判绿（只验 ftyp）
 * ——即本批要根治的盲区本身。
 */
import assert from "node:assert/strict";
import { probeFileStream, type FileProbeFetch, type FileProbeResponse } from "./fileProbe.ts";
import { SELF_CHECK_PROTOCOL_VERSION } from "./healthCheck.ts";

const SEG_URL = "hg://localhost/seg?u=https%3A%2F%2Ffiles.example%2Fv%2Fclip.mp4";
const TIMEOUT = 5_000;

function fakeResponse(
  status: number,
  ctype: string,
  body: Uint8Array,
  extraHeaders: Record<string, string> = {},
): FileProbeResponse {
  const headers = new Map<string, string>([
    ["content-type", ctype],
    ["content-length", String(body.length)],
    ...Object.entries(extraHeaders),
  ]);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    text: async () => new TextDecoder().decode(body),
  };
}

interface RecordedCall {
  method: string;
  range: string | null;
}

/** Range 语义齐全的脚本化替身（206＋Content-Range 精确、HEAD 只
 * 回头）；lieTailRange 时后缀响应谎报 Content-Range 起点。 */
function rangeServer(
  body: Uint8Array,
  ctype: string,
  opts: { lieTailRange?: boolean } = {},
): { calls: RecordedCall[]; fetchImpl: FileProbeFetch } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FileProbeFetch = async (_url, init) => {
    const method = init.method ?? "GET";
    const range = init.headers?.Range ?? null;
    calls.push({ method, range });
    if (method === "HEAD") {
      return fakeResponse(200, ctype, new Uint8Array(0), {
        "content-length": String(body.length),
      });
    }
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      assert.ok(m, `替身收到不可解析 Range: ${range}`);
      let start: number;
      let end: number;
      if (m[1] === "") {
        start = Math.max(0, body.length - Number(m[2]));
        end = body.length - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === "" ? body.length - 1 : Math.min(Number(m[2]), body.length - 1);
      }
      const crStart = opts.lieTailRange && m[1] === "" ? 0 : start;
      return fakeResponse(206, ctype, body.slice(start, end + 1), {
        "content-range": `bytes ${crStart}-${end}/${body.length}`,
      });
    }
    return fakeResponse(200, ctype, body);
  };
  return { calls, fetchImpl };
}

function boxHeader(size: number, type: string): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  return b;
}

/** 合成 MP4：ftyp(32) + free(8) + mdat + moov（moov 在尾）。 */
function buildMp4(mdatPayload: number, moovPayload: number): Uint8Array {
  const ftyp = new Uint8Array(32);
  ftyp.set(boxHeader(32, "ftyp"), 0);
  ftyp.set([0x69, 0x73, 0x6f, 0x6d], 8); // "isom"
  const mdat = new Uint8Array(8 + mdatPayload);
  mdat.set(boxHeader(8 + mdatPayload, "mdat"), 0);
  for (let i = 8; i < mdat.length; i++) mdat[i] = i % 251;
  const moov = new Uint8Array(8 + moovPayload);
  moov.set(boxHeader(8 + moovPayload, "moov"), 0);
  const parts = [ftyp, boxHeader(8, "free"), mdat, moov];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/* ── 协议版本：file 探针步序变更已 bump v5 ── */
assert.equal(SELF_CHECK_PROTOCOL_VERSION, 5, "探针步序变更必须 bump 协议版本至 v5");

/* ── (a) 小文件全步通过：步序与结论 ── */
{
  const body = buildMp4(1000, 500); // total 1556，moov 在首段内
  const server = rangeServer(body, "video/mp4");
  const outcome = await probeFileStream(SEG_URL, server.fetchImpl, TIMEOUT);
  assert.equal(outcome.totalBytes, body.length);
  assert.ok(outcome.tailElapsedMs >= 0, "尾段耗时随返回值落账");
  assert.deepEqual(
    server.calls.map((c) => `${c.method}:${c.range ?? ""}`),
    ["HEAD:", "GET:bytes=0-1", "GET:bytes=0-2047", "GET:bytes=-262144"],
    "步序＝HEAD 等价＋0-1 试探＋首段＋尾段后缀",
  );
}

/* ── (b) 大文件：moov 在尾窗内（盒遍历定位＋尾窗验） ── */
{
  const body = buildMp4(100_000, 700); // total 100756，moov@100048
  const server = rangeServer(body, "video/mp4");
  const outcome = await probeFileStream(SEG_URL, server.fetchImpl, TIMEOUT);
  assert.equal(outcome.totalBytes, body.length);
  assert.equal(server.calls.length, 4, "moov 在尾窗内不需定点补发");
}

/* ── (c) moov 在首段与尾窗之间：定点补一发验盒头 ── */
{
  const body = buildMp4(100_000, 300_000); // total 400056，moov@100048，尾窗起 137912
  const server = rangeServer(body, "video/mp4");
  const outcome = await probeFileStream(SEG_URL, server.fetchImpl, TIMEOUT);
  assert.equal(outcome.totalBytes, body.length);
  assert.ok(
    server.calls.some((c) => c.range === "bytes=100048-102095"),
    `moov 候选偏移须定点补取，实得 ${JSON.stringify(server.calls.map((c) => c.range))}`,
  );
}

/* ── (d) octet-stream 必须判失败且带类型原文（定因 §A） ── */
{
  const server = rangeServer(buildMp4(1000, 500), "application/octet-stream");
  await assert.rejects(
    () => probeFileStream(SEG_URL, server.fetchImpl, TIMEOUT),
    /application\/octet-stream/,
    "响应类型非 video/* 必须以原文判失败（旧探针此形态判绿）",
  );
}

/* ── (e) 无 moov（mdat size=0 延至文件尾）必须判失败（定因 §B） ── */
{
  const ftyp = new Uint8Array(32);
  ftyp.set(boxHeader(32, "ftyp"), 0);
  ftyp.set([0x69, 0x73, 0x6f, 0x6d], 8);
  const payload = new Uint8Array(1000);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  const parts = [ftyp, boxHeader(8, "free"), boxHeader(0, "mdat"), payload];
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    body.set(p, off);
    off += p.length;
  }
  const server = rangeServer(body, "video/mp4");
  await assert.rejects(
    () => probeFileStream(SEG_URL, server.fetchImpl, TIMEOUT),
    /moov/,
    "mdat 之后无 moov 必须判失败（旧探针此形态判绿）",
  );
}

/* ── (f) 尾段 Content-Range 谎报必须判失败 ── */
{
  const body = buildMp4(300_000, 500); // total 300548，尾窗起 38404
  const server = rangeServer(body, "video/mp4", { lieTailRange: true });
  await assert.rejects(
    () => probeFileStream(SEG_URL, server.fetchImpl, TIMEOUT),
    /Content-Range/,
    "尾段 Content-Range 起点与请求区间不符必须判失败",
  );
}

/* ── (g) HEAD 挂死（级联形态）必须被单步超时判红 ── */
{
  const server = rangeServer(buildMp4(1000, 500), "video/mp4");
  const hangingHead: FileProbeFetch = (url, init) => {
    if ((init.method ?? "GET") === "HEAD") {
      return new Promise<FileProbeResponse>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("AbortError")));
      });
    }
    return server.fetchImpl(url, init);
  };
  await assert.rejects(
    () => probeFileStream(SEG_URL, hangingHead, 60),
    /AbortError/,
    "HEAD 无结论必须由单步超时判红（旧探针从不发 HEAD、测不到级联）",
  );
}

/* ── (h) ftyp 不符仍判失败（fix3310 原判读不回退） ── */
{
  const server = rangeServer(new Uint8Array(100), "video/mp4");
  await assert.rejects(
    () => probeFileStream(SEG_URL, server.fetchImpl, TIMEOUT),
    /ftyp/,
  );
}

/* ── (i) HEAD 非 2xx：Rust/上游错误正文原样抛 ── */
{
  const failing: FileProbeFetch = async () =>
    fakeResponse(404, "text/plain", new TextEncoder().encode("上游不可达"));
  await assert.rejects(
    () => probeFileStream(SEG_URL, failing, TIMEOUT),
    /上游不可达/,
  );
}

console.log("fix3311-file-probe-hardening contract OK");
