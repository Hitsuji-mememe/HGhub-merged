/**
 * 选中源解析（fix333-P2，结构审计 G5 修根）。
 *
 * 问题：选中态（持久化的 sourceId、路由参数里的源 id）相对 active 注册表
 * 从未被校验——各面各自 `sourcesForCategory(...).find(id)`，找不到就
 * 以 undefined 落到通用提示分支，文案谎称「尚未接通」、页头回落显示
 * 内部 id 原文。ChannelPage 的 effectiveChannelSourceId 回落只修了
 * 视频频道一面，吃瓜/图片/视频深链三面同病（审计 B.2 #5 要求把回落
 * 模式抽成共用派生，本模块即该派生）。
 *
 * 判定（全 App 唯一出处；调用方只传本面的 active 表）：
 * - active：id 在调用方给的 active 表（清单覆盖已生效）且 enabled；
 * - disabled：id 不在 active 表、但在全量内置注册表（清单将其
 *   enabled=false 停用，或内置即未启用，如目录源 015–017）；
 * - gone：两表皆无（代码已删源 / 陈旧 id）。
 * 内置查表不按分类、也不按 enabled 过滤——它只负责给已知源找回
 * 显示名；跨分类 id 因此也落 disabled（选单本就按分类出，跨分类
 * 选中态经 UI 不可达；万一到达，补救动作与停用相同——请用户切换，
 * 文案不致误导到别的源）。label 一律取 displayName；gone 时无名
 * 可取，用通用「该数据源」。内部 id 永不进用户可见文案（调用方页
 * 头与提示一律读 label，不再 `?? id`）。
 *
 * 不做：不自动回落选中态（停用是值得用户知道的事实，提示页请用户
 * 手动切换；自动回落会把「你的源被停用了」藏起来，是否回落另议）。
 */
import { getBuiltinRegistry } from "./registry.ts";
import type { SourceDef } from "./types.ts";

export type SelectedSourceKind = "active" | "disabled" | "gone";

export interface SelectedSourceResolution {
  kind: SelectedSourceKind;
  /** active 时为生效 def；disabled 时为内置 def（仅供显示名，参数/域名以清单为准，不可用于取数）；gone 时无。 */
  def?: SourceDef;
  /** 用户可见名：def.displayName；gone 时为通用「该数据源」。 */
  label: string;
}

export function resolveSelectedSource(
  id: string,
  activeList: SourceDef[],
): SelectedSourceResolution {
  const active = activeList.find((s) => s.id === id && s.enabled);
  if (active) return { kind: "active", def: active, label: active.displayName };
  const builtin = getBuiltinRegistry().find((s) => s.id === id);
  if (builtin) return { kind: "disabled", def: builtin, label: builtin.displayName };
  return { kind: "gone", label: "该数据源" };
}

/**
 * 频道页初始落点（Muse 2026-11-20 fix336/ui-fixes，用户亲定分类
 * 逻辑：频道进入先落一个源、页内 chips 再切）：候选＝该频道切源
 * 名单（已启用源，注册表序）；有「最近打开」记忆
 * （healthCheck 的 hghubx_source_last_view_v1，经
 * useSourceSelfCheckOnView 在各浏览面落盘）时落候选中最近打开的
 * 那个，无记忆（或记忆源已不在候选内，如被清单停用）落候选首个；
 * 候选为空回 undefined（调用方落诚实空态）。
 *
 * 与本文件头「不自动回落选中态」的分工：那条管的是用户已明确
 * 选定/被寻址的源停用后不许偷换；本函数只定「尚无任何选择时
 * 的初始值」，用户点 chips 的选择不经此函数、不被覆盖。
 */
export function defaultSourceId(
  candidates: readonly SourceDef[],
  lastViewedAt: Readonly<Record<string, number>>,
): string | undefined {
  let best: SourceDef | undefined;
  let bestAt = 0;
  for (const def of candidates) {
    const at = lastViewedAt[def.id] ?? 0;
    if (at > bestAt) {
      best = def;
      bestAt = at;
    }
  }
  return (best ?? candidates[0])?.id;
}
