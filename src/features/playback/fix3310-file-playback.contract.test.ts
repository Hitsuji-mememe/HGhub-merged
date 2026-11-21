/**
 * fix3310 file 流播放分流契约（Muse 2026-11-21；本批任务书即维护
 * 者对新增测试的授权，AGENTS 不变量 11）：
 * 运行：node src/features/playback/fix3310-file-playback.contract.test.ts
 *
 * 立项（fix3310/video-add 停工定案，evidence/video-add.md §二）：
 * 播放链只认 HLS 清单——适配器 resolve 的 streams[].kind 在 UI
 * （SourceBrowse/SourcePosts/Search）被丢弃，Player/VideoSurface
 * 只拿到裸地址，playbackSource 一律包 /hls，Rust 清单腿对 MP4
 * 字节以魔数不符 502，kind:"file" 的流在本 App 没有可达播放路
 * 径。本线补 kind 透传与分流：file 流包本地 /seg 地址直连、走
 * native 引擎（与已包裹 /seg 地址同一形态）；HLS 路径逐字不变。
 *
 * mediaTransport/shared/api 含构建期 define 与 Tauri 链、node 契
 * 约环境不可直导入（manifestProbe 文件头既有约束），故本契约以
 * 文本断言钉分流结构（与 fix339 (h) 同法）：(a) api.ts 有
 * segment() 与 playlist() 并列的本地路由构造；(b) mediaTransport
 * 的 playbackSource 接受 streamKind、file 时 direct 并包 segment
 * ()、引擎判定不让 hls.js 接管 file；(c) Player/VideoSurface 把
 * streamKind 透传进 playbackSource 调用；(d) 三个 UI 消费面
 * （SourceBrowse/SourcePosts/Search 的 copyLoader）从 resolve
 * 结果保留 kind 并传给 Player。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* ── (a) segment() 本地路由构造与 playlist() 并列 ── */
{
  const api = read("../../shared/api/api.ts");
  assert.ok(api.includes("export const segment = (url: string)"), "shared/api 导出 segment() 本地 /seg 路由构造");
  assert.ok(api.includes("/seg?u=${encodeURIComponent(url)}"), "segment() 与 playlist() 同口径编码上游地址");
}

/* ── (b) playbackSource 按 kind 分流 ── */
{
  const mt = read("./mediaTransport.ts");
  assert.ok(mt.includes('streamKind?: "hls" | "file"'), "playbackSource 接受 streamKind 入参");
  assert.ok(mt.includes('streamKind === "file"'), "playbackSource 对 file 流显式分支");
  assert.ok(mt.includes("segment(src)"), "file 流包 segment() 本地直连地址");
  assert.ok(mt.includes("hlsSupported && !direct && !nativeFallback"), "引擎判定保持 hls.js 只接管非直通 HLS（file 经 direct 落 native）");
}

/* ── (c) 两播放面透传 streamKind ── */
{
  const player = read("./Player.tsx");
  assert.ok(player.includes("streamKind"), "Player 契约含 streamKind");
  assert.ok(player.includes("playbackSource(src, Hls.isSupported(), streamKind)"), "Player 把 streamKind 透传进 playbackSource");
  const surface = read("./VideoSurface.tsx");
  assert.ok(surface.includes("streamKind"), "VideoSurface 契约含 streamKind");
  assert.ok(surface.includes("playbackSource(src, Hls.isSupported(), streamKind)"), "VideoSurface 把 streamKind 透传进 playbackSource");
}

/* ── (d) UI 消费面保留 kind ── */
{
  /* 断言适配（fix3314）：SourceBrowse 随视频板块删除退役，其两条
   * kind 透传断言随宿主同删；file 腿的 UI 消费面由 SourcePosts 与
   * Search/copyLoader 继续全覆盖（下方断言不变）。 */
  const posts = read("../sources/SourcePosts.tsx");
  assert.ok(posts.includes("streamKind: res.streams[0]?.kind"), "SourcePosts 从 resolve 首条流保留 kind");
  assert.ok(posts.includes("streamKind={detail.streamKind}"), "SourcePosts 把 kind 传给 Player");
  const copyLoader = read("../search/copyLoader.ts");
  assert.ok(copyLoader.includes("streamKind: stream.kind"), "Search copyLoader 从 resolve 首条流保留 kind");
  const search = read("../search/Search.tsx");
  assert.ok(search.includes("streamKind={data.streamKind}"), "Search 把 kind 传给 Player");
}

console.log("fix3310-file-playback contract OK");
