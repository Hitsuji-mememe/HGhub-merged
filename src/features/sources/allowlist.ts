/**
 * 生产取页白名单派生（Muse 2026-11-19 fix321-F2c，验收 D 缺口 G1
 * 根治）：Rust source_fetch 的 origin 白名单全仓只在此一处派生，
 * main.tsx 推送时只消费本函数结果、不再内联拼装。
 *
 * 派生口径（收紧方向，与浏览面可取页集合对齐）：
 * - 只认「已启用且可取页」的源：enabled ∧ maturity≠blocked（blocked
 *   源点开走诚实提示、不拉数据，见 SourceSwitcher/Category 口径）
 *   ∧ 模板经 fetchPage 取页（isFetchPageTemplate）；
 * - 每源贡献 active baseUrls 的全部 origin ∪ 其模板声明 origin
 *   （adapters/fetchOrigins.ts）——模板声明是代码级事实，远程清单
 *   整组替换 baseUrls 削不掉它（清单 v1/v2 对 swag/redgifs 只写
 *   根域时，api.swag.live／api.redgifs.com 仍靠声明入名单）；
 * - 未启用（含清单远程下线）与 blocked 源的 origin 一律不放行：
 *   修前 main.tsx 内联派生把全注册表（含 33 个停用目录源）baseUrls
 *   全推送，本派生起改为只推可取页集合（只收紧、不放松）。
 */
import type { SourceDef } from "./types.ts";
import { isFetchPageTemplate, templateFetchOrigins } from "./adapters/fetchOrigins.ts";

function originOf(u: string): string {
  try { return new URL(u).origin; } catch { return ""; }
}

/** 该源是否经 source_fetch 取页且当前可取页（白名单派生的源集合判定）。 */
export function isAllowlistSource(s: SourceDef): boolean {
  return s.enabled && s.maturity !== "blocked" && isFetchPageTemplate(s.adapter.template);
}

export function sourceFetchAllowlistOrigins(sources: SourceDef[]): string[] {
  const origins = new Set<string>();
  for (const s of sources) {
    if (!isAllowlistSource(s)) continue;
    for (const u of s.baseUrls) {
      const o = originOf(u);
      if (o !== "" && o !== "null") origins.add(o);
    }
    for (const o of templateFetchOrigins(s.adapter.template)) origins.add(o);
  }
  return [...origins];
}
