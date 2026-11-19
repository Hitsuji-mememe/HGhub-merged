/**
 * 源总览取页计数唯一口径（Muse 2026-11-19 3.2.1修复F3b线；
 * 2026-11-20 fix331/source-reliability 扩多 host 归属）。
 *
 * registryDiag 的 L1 总览此前内联计数：无生效地址（origin 为空）的源
 * 被 continue 静默跳过——成功/失败/未发生三态之和小于源总数，读者无
 * 从知道有源被漏计，而同一文件 fetchStateText 对这类源的定性明明是
 * 「记录缺失」。现把计数抽为纯函数单点出口：四计数（成功/失败/未发
 * 生/记录缺失）之和恒等于源总数，L1 在记录缺失 >0 时明示该计数。
 *
 * 归属口径（2026-11-20 修正，结构审计 C④）：取页健康按实际请求
 * host 记录（fetchHealth），一个源的真实流量可能落在多个 host
 * （baseUrls 多个、模板另有 API/认证 host）。旧口径只认每源首个
 * baseUrl 的 host，多域源的记录必然认领不到、被报「未发生」并堆
 * 进「未归属」。现按源的全部 host 集合认领：任一 host 有记录即
 * 归该源，多条时取最近一条（at 最大）定态。host 集合的派生在
 * registryDiag（全部 baseUrls ∪ 模板声明 origin，与 allowlist
 * 白名单派生同源），本函数只做计数。
 */

export type FetchStateCounts = {
  ok: number;
  fail: number;
  none: number;
  missing: number;
};

export function countFetchStates(
  sources: { hosts: string[] }[],
  byHost: Map<string, { ok: boolean; at: number }>,
): FetchStateCounts {
  const counts: FetchStateCounts = { ok: 0, fail: 0, none: 0, missing: 0 };
  for (const s of sources) {
    if (s.hosts.length === 0) {
      counts.missing += 1;
      continue;
    }
    let best: { ok: boolean; at: number } | undefined;
    for (const h of s.hosts) {
      const r = byHost.get(h);
      if (r && (!best || r.at > best.at)) best = r;
    }
    if (!best) counts.none += 1;
    else if (best.ok) counts.ok += 1;
    else counts.fail += 1;
  }
  return counts;
}
