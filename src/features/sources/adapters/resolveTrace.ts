/* ── 取流分段留痕（共享落点，Muse 2026-11-20 fix331-hanime-403 立、
 * 2026-11-20 fix333-m5 抽共享并补齐三源）──
 * 立项依据（设备级实证）：3.3.1 真机握手 403 发生在诊断会话内，
 * 整份导出却零记录——POST 接缝无取页埋点、GET 侧记录按 host 归属
 * 错位、自检结果是旧账。取流段失败此前只在 002（hanime-api）有段级
 * 留痕，010/011/012 的 resolve 失败只有 fetchHealth 的 host 级兜底、
 * 死在哪一段不可见（fix332 清扫 P5）。现四源同口径：resolve 各段
 * 任一失败落一条 tracePlayback("source.resolve_fail")，只带稳定
 * 编号（active 注册表顺序 source-NNN）、段名、固定错误码、HTTP
 * 状态（有才带）与尝试序——结构上没有能放令牌/签名/正文的位置
 * （不变量 10）。段名按各适配器真实管线取词：
 * - 002 hanime-api：csrf / handshake / decode
 * - 010 hanime1：watch / download / decode
 * - 011 iwara-api：detail / fetch / decode
 * - 012 hentaihaven-api：watch / episode / decode
 * 诊断导出由 diagnosticReport 的「取流失败留痕」节结构化消费，
 * 不再只躺播放日志尾段原文。动态 import 与 manifest.ts 的解析埋点
 * 同模式（避免 adapters → diagnostics/manifest 的静态环）；纯旁路，
 * 埋点失败不影响取流本身。 */

/** 留痕数据组装（纯函数，契约可定值断言）：键集合固定为
 * source/segment/code[/status]/attempt，值只来自入参的固定码、
 * 状态与序号。 */
export function resolveFailureEventData(
  source: string,
  segment: string,
  code: string,
  status: number | undefined,
  attempt: number,
): Record<string, unknown> {
  return {
    source,
    segment,
    code,
    ...(status !== undefined ? { status } : {}),
    attempt,
  };
}

/** 段失败留痕（旁路）：defId → 稳定编号的换算与 002 原实现同口径
 * （active 注册表顺序；查不到落 source-001 兜底，与原实现一致）。 */
export function traceResolveFailure(
  defId: string,
  segment: string,
  code: string,
  status: number | undefined,
  attempt: number,
): void {
  void (async () => {
    const [diag, manifest, registryDiag] = await Promise.all([
      import("../../../shared/diagnostics/playbackDiagnostics"),
      import("../manifest.ts"),
      import("../registryDiag.ts"),
    ]);
    const idx = manifest.getActiveRegistry().sources.findIndex((s) => s.id === defId);
    diag.tracePlayback(
      "source.resolve_fail",
      resolveFailureEventData(registryDiag.sourceStableId(idx >= 0 ? idx : 0), segment, code, status, attempt),
    );
  })().catch(() => { /* 诊断不可用时静默 */ });
}

/** 生产取页栈折叠错误文本里的 HTTP 状态（fetchPage 失败形态
 * 恒为 "HTTP <n>"，见 net/edge）；提取不到回 undefined，不猜。 */
export function httpStatusOf(error: unknown): number | undefined {
  const m = /^HTTP (\d{3})$/.exec(error instanceof Error ? error.message : String(error));
  return m ? Number(m[1]) : undefined;
}
