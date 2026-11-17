import { playlist } from "../../shared/api/api";
import { tracePlayback } from "../../shared/diagnostics/playbackDiagnostics";

/* ── 下一条首分片预热（2.0.6） ──────────────────────────────
 * 取流路径（VideoSurface）：hls.js 用默认 loader 向 playlist(src)
 * （即 `{LOCAL}/hls?u=…`）拉清单，分片与 key 的地址是 Rust 在清单里改写好的
 * `{LOCAL}/seg?u=…`；两类请求都经 Rust `media::handle` 的进程内缓存
 * （PL_CACHE 按 `{prefix}|{上游地址}`、SEG_CACHE 按上游地址）。
 * 所以这里用 fetch() 走与播放器逐字相同的 URL 把清单与首分片先拉一遍，
 * 就能把同一份缓存填好——用户切过去时 hls.js 的请求直接命中。
 * 全程只用 fetch、不碰播放器的 hls 实例，不污染 2.0.5 的分片统计与自愈判据。 */
function firstUriLine(text: string): string | null {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#")) return t;
  }
  return null;
}

function resolveUri(u: string, base: string): string {
  try { return new URL(u, base).href; } catch { return u; }
}

export async function prewarmFirstSegment(videoId: number, rawUrl: string, signal: AbortSignal): Promise<void> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  try {
    const plUrl = playlist(rawUrl);
    const r = await fetch(plUrl, { signal });
    if (!r.ok) {
      tracePlayback("feed.prewarm", { video_id: videoId, stage: "playlist_fail", status: r.status, ms: ms() });
      return;
    }
    let text = await r.text();
    tracePlayback("feed.prewarm", { video_id: videoId, stage: "playlist", ms: ms() });
    /* 主清单（多码率）：第一条 URI 行是子清单，它经 /seg 返回时会被二次改写，照拉一遍 */
    if (text.includes("#EXT-X-STREAM-INF")) {
      const variant = firstUriLine(text);
      if (!variant) return;
      const vr = await fetch(resolveUri(variant, plUrl), { signal });
      if (!vr.ok) return;
      text = await vr.text();
    }
    /* init 段（fMP4 的 EXT-X-MAP）先热，再热首个媒体分片；
       URL 全部取自改写后清单的原文，与 hls.js 实际请求逐字一致，缓存键才对得上 */
    const mapUri = /#EXT-X-MAP:[^\n]*URI="([^"]+)"/.exec(text)?.[1];
    if (mapUri) {
      const mr = await fetch(resolveUri(mapUri, plUrl), { signal });
      await mr.arrayBuffer();
      if (signal.aborted) return;
      tracePlayback("feed.prewarm", { video_id: videoId, stage: "map", ms: ms() });
    }
    const seg = firstUriLine(text);
    if (!seg) return;
    const sr = await fetch(resolveUri(seg, plUrl), { signal });
    if (!sr.ok) return;
    const buf = await sr.arrayBuffer();
    tracePlayback("feed.prewarm", { video_id: videoId, stage: "segment", ms: ms(), bytes: buf.byteLength });
  } catch { /* 取消或失败一律静默：预热只是加速，失败不影响正常播放路径 */ }
}
