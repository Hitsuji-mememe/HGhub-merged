/**
 * 源切换器（Muse 2026-11-19 根治包·多源线 条目5）：
 * 同一分类内切换数据源，切换即整页换源重拉、源间不混排。
 * badge 口径（2026-11-20 fix331/source-reliability 改读单一派生）：
 * 一律走 healthCheck.sourceHealthBadgeText——探过的源按实测四态
 * （可用不挂标/部分可用/不可用/已过期），从未探过才回落静态
 * maturity 作底（preview→「仅预览」；probe→「未实测」；blocked→
 * 「暂不可用」，用户保留口径：列表可见、点开诚实提示，不删不假
 * 数据）。旧口径对 probe 一律挂「未实测」，与自检结果双轨并存、
 * 探过了也永不摘标，已废。
 * 触发口径（2026-11-20 fix333/selfcheck-trigger）：切换器同为展
 * 示面，挂载时对展示的选项源批量补探（useSourceSelfCheckOnShow）
 * ——此前只读不触发，未点开过的源在本面长挂「未实测」。
 */
import { Button } from "../../shared/ui/ios/controls";
import { tracePlayback } from "../../shared/diagnostics/playbackDiagnostics";
import { sourcesForCategory, sourcesForChannel } from "./registry.ts";
import { getActiveRegistry } from "./manifest.ts";
import { getSelfCheckResults, sourceHealthBadgeText } from "./healthCheck.ts";
import { useSourceHealthResults, useSourceSelfCheckOnShow } from "./sourceHealth.ts";
import type { SelectedSourceKind } from "./selectedSource.ts";
import type { SourceCategory, SourceDef, SourceMaturity } from "./types.ts";

export interface SourceOption { id: string; label: string; badge?: string }

const toOption = (s: SourceDef): SourceOption => ({
  id: s.id,
  label: s.displayName,
  badge: sourceHealthBadgeText(s, getSelfCheckResults()[s.id], Date.now()),
});

/* UI 消费口径（Muse 2026-11-19 整改 D2）：一律读 active 注册表
 * （远程清单覆盖后即时生效），不再读内置表。 */
export function sourceOptionsForCategory(category: SourceCategory): SourceOption[] {
  return sourcesForCategory(category, getActiveRegistry().sources).map(toOption);
}

/* 频道切源片口径（Muse 2026-11-19 fix321-F2）：按频道-源映射
 * （registry.sourcesForChannel）取源，无该频道真实品类映射的源
 * 不进该频道切源列表；sourcesForChannel 只返回已启用源。 */
export function sourceOptionsForChannel(cate: string): SourceOption[] {
  return sourcesForChannel(cate, getActiveRegistry().sources).map(toOption);
}

export function SourceSwitcher({ options, value, onChange, ariaLabel }: {
  options: SourceOption[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
}) {
  /* 订阅自检结果：补探/整轮落盘即重渲染，徽标按最新派生重算
   * （options 构建时的 badge 只作注册表外 id 的回落）。 */
  const healthResults = useSourceHealthResults();
  /* 展示面补探（fix333/selfcheck-trigger）：切换器是状态展示面，
   * 此前只读派生不触发——选项里从未点开过的源永远挂「未实测」。
   * 挂载时对本面展示的选项源批量补探（healthCheck 串行队列节
   * 制、后台不阻塞）；频道页/帖子页/总览吃瓜区的切换器同覆盖。 */
  const optionDefs = options
    .map((o) => getActiveRegistry().sources.find((s) => s.id === o.id))
    .filter((d): d is SourceDef => !!d);
  /* 批量补探排序（fix333/m7-selfcheck M7）：本切换器当前选中源
   * （value）最先探，其余按最近打开/注册表序。 */
  useSourceSelfCheckOnShow(optionDefs, value);
  if (options.length <= 1) return null;
  const badgeFor = (o: SourceOption): string | undefined => {
    const def = getActiveRegistry().sources.find((s) => s.id === o.id);
    return def
      ? sourceHealthBadgeText(def, healthResults[o.id], Date.now())
      : o.badge;
  };
  /* 源切换事件（Muse 2026-11-19 整改 D5，diag-audit #8）：只带稳定
   * 编号（active 注册表顺序 source-001 式）与分类标识，不带业务名/域名
   * （报告风控口径，AGENTS 不变量 10）。 */
  const handleSelect = (id: string) => {
    const list = getActiveRegistry().sources;
    const idx = list.findIndex((s) => s.id === id);
    tracePlayback("source.switch", {
      source: `source-${String(idx + 1).padStart(3, "0")}`,
      category: idx >= 0 ? list[idx].category : "unknown",
    });
    onChange(id);
  };
  return (
    <div role="group" aria-label={ariaLabel} className="flex gap-2 overflow-x-auto pb-1">
      {options.map((o) => {
        const badge = badgeFor(o);
        return (
          <Button key={o.id} aria-pressed={value === o.id} onClick={() => handleSelect(o.id)}
            className="ios-filter-pill shrink-0">
            <span>{o.label}</span>
            {badge && <span className="ml-1 text-[11px] text-mut">{badge}</span>}
          </Button>
        );
      })}
    </div>
  );
}

/** 非黄果源的诚实提示（按成熟度分化，用户保留口径）：
 * blocked＝站点实测不可达——保留在列表、点开只给证据与状态，不拉
 * 数据、不拿别源内容冒充；其余（probe/stable）＝该分类的外部源
 * 浏览页尚未接通时暂不展示内容（视频/图片分类已于 2026-11-19
 * 最终版 D 线接通 SourceBrowse/SourceGallery、吃瓜帖分类已于
 * 3.3.0 接通批接通 SourcePosts，三分类均不再走本提示；
 * 本提示现行只用于 blocked 全部）。
 * selectedKind（fix333-P2 立、fix333-M3 拆文案，结构审计 G5）：
 * 选中源不在 active 注册表时优先于 maturity 分支，且按
 * resolveSelectedSource 的三态分叉字面精确的文案——disabled＝源
 * 还在应用内、只是被清单停用；gone＝源已自应用移除、两表皆无。
 * 两态此前共用「已被清单停用」一句，对已删源字面不实（M3 拆分）；
 * displayName 由调用方经 resolveSelectedSource 给显示名或通用名，
 * 内部 id 永不进本组件。 */
export function SourcePendingNotice({ displayName, maturity, note, selectedKind }: { displayName: string; maturity?: SourceMaturity; note?: string; selectedKind?: SelectedSourceKind }) {
  if (selectedKind === "disabled") {
    return (
      <div role="status" className="mx-4 mt-6 rounded-[18px] bg-s2 px-4 py-5 text-center">
        <div className="text-[14px] font-semibold text-on">{displayName}（已停用）</div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-mut">
          该源已被清单停用，不在当前可用列表中，暂不展示内容。请切换到其他源继续浏览。
        </p>
      </div>
    );
  }
  if (selectedKind === "gone") {
    return (
      <div role="status" className="mx-4 mt-6 rounded-[18px] bg-s2 px-4 py-5 text-center">
        <div className="text-[14px] font-semibold text-on">{displayName}（已下线）</div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-mut">
          该源已被移除，不在应用的源列表中，无法展示内容。请切换到其他源继续浏览。
        </p>
      </div>
    );
  }
  if (maturity === "blocked") {
    return (
      <div role="status" className="mx-4 mt-6 rounded-[18px] bg-s2 px-4 py-5 text-center">
        <div className="text-[14px] font-semibold text-on">{displayName}（暂不可用）</div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-mut">
          真站实测显示该站点当前不可达，暂不展示内容，也不会拿其他源的数据冒充。该源已保留在列表中，后续版本将重新评估开放。
        </p>
        {note && <p className="mt-1.5 text-[12px] leading-relaxed text-mut">实测记录：{note}</p>}
      </div>
    );
  }
  return (
    <div role="status" className="mx-4 mt-6 rounded-[18px] bg-s2 px-4 py-5 text-center">
      <div className="text-[14px] font-semibold text-on">{displayName}</div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-mut">
        该源已注册、适配器与受控取页通道已就绪，但本分类的外部源浏览页尚未接通，暂不展示内容，以免混入其他源数据。
        {maturity === "probe" ? "该源尚未完成真站验通，实际可用性以实测为准。" : ""}
      </p>
    </div>
  );
}
