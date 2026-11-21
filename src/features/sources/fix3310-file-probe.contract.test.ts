/**
 * fix3310 file 流自检探针契约（Muse 2026-11-21；本批任务书即维护
 * 者对新增测试的授权，AGENTS 不变量 11）：
 * 运行：node src/features/sources/fix3310-file-probe.contract.test.ts
 *
 * 立项（fix3310/video-add 停工定案，evidence/video-add.md §二）：
 * 纪元 5 探针只认 HLS 清单——取流段经 probeManifest 接缝以
 * playlist() URL 实拉清单判可达。kind:"file" 的 MP4 流没有清单：
 * 旧形态下接缝收到裸地址后照样包 /hls 实拉，Rust 清单腿对 MP4
 * 字节必以魔数不符 502，file 流恒判取流失败——与播放侧同病（播
 * 放链同样只认清单）。本线给探针按 kind 分支：接缝入参改为整条
 * 流（{url, kind}），生产实现（manifestProbe.ts）对 file 流改走
 * /seg 同路 Range 实拉＋ftyp 魔数校验（与播放第一步同构：播放
 * 侧 file 流包 /seg 直连 native，首个请求即 Range 字节）。
 *
 * 覆盖：(a) file 流实拉失败翻转取流结论＋接缝收到整条流（核心
 * 证伪：旧码接缝只收到裸字符串地址、且 file 流被包 /hls 必败的
 * 判读在生产实现侧，引擎侧旧码对 kind 无分支）；(b) file 流实
 * 拉成功判可达、计数同口径；(c) hls 流分支不走样（接缝收到
 * kind:"hls"、结论口径与 fix339 一致）；(d) 生产实现文本断言
 * （manifestProbe 按 kind 分支、file 分支走 segment()＋Range＋
 * ftyp 判读、hls 分支仍走 playlist() 逐字同路）。
 * 不访问真实网络：适配器与实拉接缝均经注入以假实现隔离。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runSourceSelfCheck } from "./healthCheck.ts";
import type { SourceAdapter, SourceDef, SourceStream } from "./types.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const NOW = 1_700_000_000_000;
const FILE_URL = "https://files.example/v/clip.mp4";
const HLS_URL = "https://cdn.example/v/playlist.m3u8";

function fakeDef(id: string): SourceDef {
  return {
    id, displayName: id, kind: "video", category: "video",
    adapter: { template: "wp-rest" }, baseUrls: [`https://${id}.example`],
    enabled: true, order: 1, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false, comments: false },
    network: { mode: "probe-required" },
  };
}

function fakeAdapter(stream: SourceStream): SourceAdapter {
  return {
    sourceId: "fake",
    async list(page) {
      return {
        items: [{ sourceId: "fake", externalId: `ext-p${page}`, title: `t${page}`, cover: "", href: "", tags: [] }],
        pagination: { page, pages: 1, size: 20, total: 1 },
      };
    },
    async detail(id) {
      return {
        sourceId: "fake", externalId: id, title: "d", cover: "", href: "", tags: [],
        images: [], episodes: [], contentHtml: "",
      };
    },
    async resolve() {
      return { streams: [stream] };
    },
  };
}

function probeRecorder(impl: (stream: SourceStream) => Promise<void>) {
  const calls: SourceStream[] = [];
  return {
    calls,
    fn: async (stream: SourceStream) => { calls.push(stream); await impl(stream); },
  };
}

/* ── (a) file 流实拉失败翻转取流结论（核心证伪） ── */
{
  const probe = probeRecorder(async () => { throw new Error("响应不是 MP4 文件（ftyp 魔数不符）"); });
  const r = await runSourceSelfCheck(fakeDef("fp-file-a"), {
    createAdapterFor: () => fakeAdapter({ url: FILE_URL, kind: "file" }),
    probeStream: probe.fn,
    now: () => NOW,
  });
  assert.deepEqual(probe.calls, [{ url: FILE_URL, kind: "file" }], "接缝必须收到整条流（含 kind），旧码只传裸地址字符串");
  assert.equal(r.detail, "ok", "详情段不受末段影响");
  assert.equal(r.tail, "fail", "file 实拉失败必须翻转取流结论");
  assert.equal(r.requests, 4, "单页口径：列表＋详情＋取流解析＋file 实拉恰 4 次调用");
}

/* ── (b) file 流实拉成功判可达 ── */
{
  const probe = probeRecorder(async () => {});
  const r = await runSourceSelfCheck(fakeDef("fp-file-b"), {
    createAdapterFor: () => fakeAdapter({ url: FILE_URL, kind: "file" }),
    probeStream: probe.fn,
    now: () => NOW,
  });
  assert.deepEqual(probe.calls, [{ url: FILE_URL, kind: "file" }], "成功路径同样恰调 1 次、入参为整条流");
  assert.equal(r.tail, "ok", "file 实拉成功（Range 取回且 ftyp 通过的等价信号）判取流可达");
  assert.equal(r.tailFailure, null);
  assert.equal(r.requests, 4, "成功路径调用计数同为 4");
}

/* ── (c) hls 流分支不走样 ── */
{
  const probe = probeRecorder(async () => {});
  const r = await runSourceSelfCheck(fakeDef("fp-hls-c"), {
    createAdapterFor: () => fakeAdapter({ url: HLS_URL, kind: "hls" }),
    probeStream: probe.fn,
    now: () => NOW,
  });
  assert.deepEqual(probe.calls, [{ url: HLS_URL, kind: "hls" }], "hls 流经同一接缝、kind 透传不改判读");
  assert.equal(r.tail, "ok", "hls 分支结论口径与 fix339 清单实拉一致");
  assert.equal(r.requests, 4);
}

/* ── (d) 生产实现按 kind 分支（文本断言） ── */
{
  const impl = read("./manifestProbe.ts");
  assert.ok(impl.includes("export async function probeStreamViaPlayback"), "生产实现导出 probeStreamViaPlayback 在 manifestProbe.ts");
  assert.ok(impl.includes('stream.kind === "file"'), "生产实现按 kind 分支 file 流");
  assert.ok(impl.includes("segment(stream.url)"), "file 分支经 shared/api 的 segment() 构造 /seg 同路 URL（与播放侧逐字同路）");
  assert.ok(impl.includes("playlist(stream.url)"), "hls 分支仍经 playlist() 实拉清单（fix339 同路不变）");
  /* fix3311/file-leg-fix 断言适配（非削弱）：file 分支的实拉步序
   * 自 manifestProbe 内联实现改为委托 fileProbe.probeFileStream
   * （多步序列，行为覆盖由 fix3311-file-probe-hardening 契约承
   * 接且严于原单步断言）——此处改钉委托接线与步序文件归属。 */
  assert.ok(impl.includes("probeFileStream"), "file 分支委托 fileProbe.probeFileStream 多步实拉（fix3311 加固）");
  const seq = read("./fileProbe.ts");
  assert.ok(seq.includes('"Range"') || seq.includes("Range:"), "实拉步序带 Range 头（fileProbe.ts）");
  assert.ok(seq.includes("ftyp"), "实拉步序以 ftyp 魔数判读响应字节（fileProbe.ts）");
}

console.log("fix3310-file-probe contract OK");
