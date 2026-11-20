/* ── 取流分段留痕（共享落点，Muse 2026-11-20 fix331-hanime-403 立、
 * 2026-11-20 fix333-m5 抽共享并补齐三源）──
 * 立项依据（设备级实证）：3.3.1 真机握手 403 发生在诊断会话内，
 * 整份导出却零记录——POST 接缝无取页埋点、GET 侧记录按 host 归属
 * 错位、自检结果是旧账。取流段失败此前只在 002（hanime-api）有段级
 * 留痕，010/011/012 的 resolve 失败只有 fetchHealth 的 host 级兜底、
 * 死在哪一段不可见（fix332 清扫 P5）。现三源同口径（011 已于
 * fix338/registry-cut 随源摘除，其段名行退役）：resolve 各段
 * 任一失败落一条 tracePlayback("source.resolve_fail")，只带稳定
 * 编号（active 注册表顺序 source-NNN）、段名、固定错误码、HTTP
 * 状态（有才带）与尝试序——结构上没有能放令牌/签名/正文的位置
 * （不变量 10）。段名按各适配器真实管线取词：
 * - 002 hanime-api：csrf / handshake / decode
 * - 009 hanime1：watch / download / decode
 * - 010 iwara-api：detail / fetch / decode
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

/** 源事件发射（共享旁路）：defId → 稳定编号的换算与 002 原实现同
 * 口径（active 注册表顺序；查不到落 source-001 兜底，与原实现一
 * 致）。动态 import 与 manifest.ts 的解析埋点同模式（避免静态环）；
 * 纯旁路，埋点失败不影响业务本身。 */
function emitSourceTrace(
  event: string,
  defId: string,
  build: (stableId: string) => Record<string, unknown>,
): void {
  void (async () => {
    const [diag, manifest, registryDiag] = await Promise.all([
      import("../../../shared/diagnostics/playbackDiagnostics"),
      import("../manifest.ts"),
      import("../registryDiag.ts"),
    ]);
    const idx = manifest.getActiveRegistry().sources.findIndex((s) => s.id === defId);
    diag.tracePlayback(event, build(registryDiag.sourceStableId(idx >= 0 ? idx : 0)));
  })().catch(() => { /* 诊断不可用时静默 */ });
}

/** 段失败留痕（旁路）：事件与数据形状自立项不变，经共享发射器。 */
export function traceResolveFailure(
  defId: string,
  segment: string,
  code: string,
  status: number | undefined,
  attempt: number,
): void {
  emitSourceTrace("source.resolve_fail", defId, (stable) =>
    resolveFailureEventData(stable, segment, code, status, attempt));
}

/** 列表逐条失败的事件数据组装（纯函数，契约可定值断言）：键集合
 * 固定为 source/code/count，值只来自稳定编号、固定码与计数——
 * 不带条目 id、错误原文或 URL（不变量 10）。 */
export function listSkipEventData(source: string, failedCount: number): Record<string, unknown> {
  return { source, code: "item_fetch_failed", count: failedCount };
}

/** 列表逐条取数失败留痕（旁路，Muse 2026-11-20 fix335/a-pagination
 * 收敛审计）：列表页逐条补取详情的适配器（SWAG 逐条 /messages）旧
 * 形态单条失败静默跳过——失败与判据过滤在结果里不可分、诊断导出
 * 查无此失败，撞「失败留痕」口径。现失败计数后经本通道落一条
 * source.list_skip 进同一播放账本（诊断导出全量日志可见；结构化
 * 专节暂不设，与 search.copy_fail 同级处理）。计数 ≤0 不发。 */
export function traceListItemSkips(defId: string, failedCount: number): void {
  if (!Number.isFinite(failedCount) || failedCount <= 0) return;
  emitSourceTrace("source.list_skip", defId, (stable) => listSkipEventData(stable, failedCount));
}

/** 生产取页栈折叠错误文本里的 HTTP 状态（fetchPage 失败形态
 * 恒为 "HTTP <n>"，见 net/edge）；提取不到回 undefined，不猜。 */
export function httpStatusOf(error: unknown): number | undefined {
  const m = /^HTTP (\d{3})$/.exec(error instanceof Error ? error.message : String(error));
  return m ? Number(m[1]) : undefined;
}
