/**
 * 源总览取页计数唯一口径（Muse 2026-11-19 3.2.1修复F3b线）。
 *
 * registryDiag 的 L1 总览此前内联计数：无生效地址（origin 为空）的源
 * 被 continue 静默跳过——成功/失败/未发生三态之和小于源总数，读者无
 * 从知道有源被漏计，而同一文件 fetchStateText 对这类源的定性明明是
 * 「记录缺失」。现把计数抽为纯函数单点出口：四计数（成功/失败/未发
 * 生/记录缺失）之和恒等于源总数，L1 在记录缺失 >0 时明示该计数。
 * 取页健康记录按 host 对齐（fetchHealth 的存储口径），hostOf 由调用
 * 方注入，与 registryDiag 既有对齐方式一致。
 */

export type FetchStateCounts = {
  ok: number;
  fail: number;
  none: number;
  missing: number;
};

export function countFetchStates(
  sources: { origin: string }[],
  byHost: Map<string, { ok: boolean }>,
  hostOf: (url: string) => string,
): FetchStateCounts {
  const counts: FetchStateCounts = { ok: 0, fail: 0, none: 0, missing: 0 };
  for (const s of sources) {
    if (!s.origin) {
      counts.missing += 1;
      continue;
    }
    const h = byHost.get(hostOf(s.origin));
    if (!h) counts.none += 1;
    else if (h.ok) counts.ok += 1;
    else counts.fail += 1;
  }
  return counts;
}
