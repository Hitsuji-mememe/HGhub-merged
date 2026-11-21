/* ── 自检取流段·实拉探针（Muse 2026-11-21 fix339/probe-fidelity 立，
 * fix3310/file-playback-leg 扩 file 分支）──
 * 背景（3.3.8 真机定案，证据 fix338/evidence/device-export-338-
 * analysis.md）：自检取流段此前只跑 adapter.resolve()——流地址能从
 * 站点/API 主机解析出来即判「取流可达」；但播放的第一步是把该地址
 * 经本地 /hls 路由（Rust load_playlist：媒体栈取数＋15s 总截止＋
 * #EXTM3U 魔数校验）取回来，流/清单主机只在播放路径上被请求。
 * 009/010 在真机即死在探针视野之外：resolve 06:44 成功、点播
 * 06:47 清单取数 dns_error 全灭，自检仍报可用。
 *
 * 本模块是该实拉的生产实现，按流 kind 分支（入参为整条流）：
 * - HLS（fix339 原形态，逐字不变）：以与播放器逐字相同的 URL
 *   （shared/api 的 playlist()，与 feed/prewarm.ts 的预热取数同
 *   路）fetch 一次本地 /hls 路由——200 ⟺ Rust 清单腿取数成功且
 *   魔数校验通过（load_playlist 的成功定义）；非 200 时 Rust 回
 *   的正文即其错误原文（如清单腿的传输/超时/魔数失败文本），原
 *   样抛作错误供自检失败分类（healthCheck.selfCheckFailureKind）
 *   判读，不在此另造分类。客户端超时 20s 只是兜底：清单腿自身
 *   15s 总截止恒先于它给出结论（fix338 签名③）。
 * - file（fix3310 新增、fix3311/file-leg-fix 加固）：MP4 直链没
 *   有清单，播放第一步是经本地 /seg 路由以 Range 取首段字节
 *   （playbackSource 包 segment()、native 引擎直连）。fix3310
 *   探针只验首段 ftyp——3.3.10 真机探针全绿而点播全灭（响应类
 *   型 octet-stream 被播放器拒收、moov 在尾探针全盲、无 Range
 *   请求在 App 侧落整段级联，定因见 fix3311 调查报告）。现行
 *   步序由 fileProbe.ts 的 probeFileStream 实现（HEAD 等价调用
 *   ＋0-1 试探＋首段 ftyp＋尾段实拉验 moov＋响应类型须
 *   video/*，按播放器真实请求形态），本文件只负责以 segment()
 *   构造同路 URL 并注入全局 fetch 与 20s 单步超时。非 2xx 时
 *   Rust 正文原样抛作错误、沿用既有失败分类，不在此另造分类。
 *
 * 接缝纪律：本文件 import shared/api（构建期 define＋Tauri 链，
 * node 契约环境不可直导入——既有约束），故 healthCheck 引擎只认
 * 注入的 probeStream 接缝、生产装配（main.tsx 调度与 F8 接线、
 * sourceHealth.ts 补探接线）显式注入本函数；契约以假实现隔离。
 * 只记成败、不记 URL 本身（不变量 10）：本函数不落日志，调用方
 * （自检引擎）只把结果收敛成段状态与失败形态。 */

import { playlist, segment } from "../../shared/api/api";
import { probeFileStream } from "./fileProbe.ts";
import type { SourceStream } from "./types.ts";

/** 客户端兜底超时：恒大于清单腿 15s 总截止，只防本地路由自身
 * 无响应时探针挂死，不与 Rust 侧结论竞速。file 分支的多步序列
 * 以本值作单步超时（与播放单发同值，见 fileProbe.ts 文件头）。 */
export const STREAM_MANIFEST_PROBE_TIMEOUT_MS = 20_000;

/** 经播放同路实拉一条流（按 kind 分支）：成功返回，失败抛
 * Error（正文为 Rust 侧错误原文时以其为 message）。 */
export async function probeStreamViaPlayback(stream: SourceStream): Promise<void> {
  if (stream.kind === "file") {
    await probeFileStreamViaPlayback(stream);
    return;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STREAM_MANIFEST_PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(playlist(stream.url), { signal: ctrl.signal });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(body.trim() || `HTTP ${r.status}`);
    }
    /* 成功路径排空响应体：本地路由的清单已被 Rust 侧缓存
     * （load_playlist PL_CACHE），排空只为释放连接、不消费内容。 */
    await r.text().catch(() => "");
  } finally {
    clearTimeout(timer);
  }
}

/** file 流实拉：经 /seg 同路多步实拉（步序与判据在 fileProbe.ts，
 * 按播放器真实请求形态：HEAD 等价调用＋0-1 试探＋首段 ftyp＋尾
 * 段实拉验 moov＋响应类型须 video/*）。本函数只注入同路 URL、
 * 全局 fetch 与单步超时，结论口径（成功返回/失败抛错）不变。 */
async function probeFileStreamViaPlayback(stream: SourceStream): Promise<void> {
  await probeFileStream(
    segment(stream.url),
    (url, init) => fetch(url, init),
    STREAM_MANIFEST_PROBE_TIMEOUT_MS,
  );
}
