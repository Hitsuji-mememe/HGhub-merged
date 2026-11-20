/* ── 自检取流段·清单实拉探针（Muse 2026-11-21 fix339/probe-fidelity）──
 * 背景（3.3.8 真机定案，证据 fix338/evidence/device-export-338-
 * analysis.md）：自检取流段此前只跑 adapter.resolve()——流地址能从
 * 站点/API 主机解析出来即判「取流可达」；但播放的第一步是把该地址
 * 经本地 /hls 路由（Rust load_playlist：媒体栈取数＋15s 总截止＋
 * #EXTM3U 魔数校验）取回来，流/清单主机只在播放路径上被请求。
 * 009/010 在真机即死在探针视野之外：resolve 06:44 成功、点播
 * 06:47 清单取数 dns_error 全灭，自检仍报可用。
 *
 * 本模块是该实拉的生产实现：以与播放器逐字相同的 URL
 * （shared/api 的 playlist()，与 feed/prewarm.ts 的预热取数同路）
 * fetch 一次本地 /hls 路由——200 ⟺ Rust 清单腿取数成功且魔数
 * 校验通过（load_playlist 的成功定义）；非 200 时 Rust 回的正文
 * 即其错误原文（如清单腿的传输/超时/魔数失败文本），原样抛作
 * 错误供自检失败分类（healthCheck.selfCheckFailureKind）判读，
 * 不在此另造分类。客户端超时 20s 只是兜底：清单腿自身 15s 总
 * 截止恒先于它给出结论（fix338 签名③）。
 *
 * 接缝纪律：本文件 import shared/api（构建期 define＋Tauri 链，
 * node 契约环境不可直导入——既有约束），故 healthCheck 引擎只认
 * 注入的 probeManifest 接缝、生产装配（main.tsx 调度与 F8 接线、
 * sourceHealth.ts 补探接线）显式注入本函数；契约以假实现隔离。
 * 只记成败、不记 URL 本身（不变量 10）：本函数不落日志，调用方
 * （自检引擎）只把结果收敛成段状态与失败形态。 */

import { playlist } from "../../shared/api/api";

/** 客户端兜底超时：恒大于清单腿 15s 总截止，只防本地路由自身
 * 无响应时探针挂死，不与 Rust 侧结论竞速。 */
export const STREAM_MANIFEST_PROBE_TIMEOUT_MS = 20_000;

/** 经播放同路实拉一条流地址的清单：成功（HTTP 200）返回，
 * 失败抛 Error（正文为 Rust 侧错误原文时以其为 message）。 */
export async function probeStreamManifestViaPlayback(streamUrl: string): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STREAM_MANIFEST_PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(playlist(streamUrl), { signal: ctrl.signal });
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
