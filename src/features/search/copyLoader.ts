/**
 * 搜索详情副本加载核（Muse 2026-11-19 fix330-riban-surfaces）：
 * 自 Search.tsx 抽出为纯模块（依赖注入形态，与 postsRoute 同先例），
 * 使「搜索结果点开 → 详情/取流」这条生产路径可被契约夹具直驱，
 * 不再只有组件内不可测的实现。
 *
 * 本批定性（3.3.0 真机首验，里番四源搜索可达、点开全灭）：App 内
 * 路径逐 seam 普查无断点（结果卡 onOpen → openMerged → openExternal
 * → loadWithFallback → 本模块 → createAdapter → adapter.detail/
 * resolve；启动注入与 Rust source_fetch/source_post 均对齐），但
 * video/drama 分支此前**跳过 adapter.detail() 直调 resolve**——
 * 详情面名实不符：单副本时 detail 恒为 undefined（描述/分集/封面
 * 升级全缺），且失败只能落在从未被任何门禁探过的 resolve 段。
 * 现 video/drama 与其余 kind 同口径：先经 detail 段（缓存复用、
 * 与 F7 自检探的正是同一段），再 resolve 取流。detail 失败不
 * 阻断 resolve（降级 detail=undefined、由 resolve 成败定成败）：
 * detail 解析口径比 resolve 更挑剔的源（如详情页标题缺失但流
 * 表可得）不因本次接线回归为不可播。
 *
 * 按集取流（2026-11-20 fix334/L2 G3）：opts.episodeExternalId
 * 给定时 video/drama 的 resolve 目标换为所选集的 externalId
 * （集 externalId 形态由适配器定义，如 <slug>/episode-<n>，
 * 适配器 resolve 已支持按集解析）；缺省仍为条目 id（默认第一
 * 集，既有行为不变）。detail 段与缓存口径不随集变（detail 本
 * 就是整条目详情、含全集列表）。
 */
import type { SourceAdapter, SourceDef, SourceDetail } from "../sources/types.ts";
import type { CopyRef, GlobalSearchKind } from "./multiSourceSearch.ts";

/** 副本详情缓存键（单一出处：Search 副本评估与本加载核共用）。 */
export function copyCacheKey(c: CopyRef): string {
  return `${c.sourceId}:${c.item.externalId}`;
}

export interface CopyLoadResult {
  streamUrl?: string;
  /* 首条流的形态（Muse 2026-11-21 fix3310 kind 透传）：与
   * streamUrl 同源于 resolve 结果，Search 据此传 Player 分流。 */
  streamKind?: "hls" | "file";
  detail?: SourceDetail;
  images?: string[];
}

export interface CopyLoaderDeps {
  getDef: (sourceId: string) => SourceDef | undefined;
  makeAdapter: (def: SourceDef) => SourceAdapter | null;
  detailCache: Map<string, SourceDetail>;
}

/**
 * 加载一个外部副本的详情面数据：
 * - video/drama：detail 段（缓存优先）→ resolve 取首个流；
 *   无流即失败（调用方走副本顺延/错误态）。
 * - image：detail 段 → 图集（detail.images 优先、回落封面）；
 *   无图即失败。
 * - post：detail 段直出。
 */
export async function loadSearchCopy(
  kind: GlobalSearchKind,
  copy: CopyRef,
  deps: CopyLoaderDeps,
  opts?: { episodeExternalId?: string },
): Promise<CopyLoadResult> {
  const def = deps.getDef(copy.sourceId);
  if (!def) throw new Error("源不在注册表");
  const adapter = deps.makeAdapter(def);
  if (!adapter) throw new Error("该源未注册可用适配器");
  if (kind === "video" || kind === "drama") {
    let detail = deps.detailCache.get(copyCacheKey(copy));
    if (!detail) {
      try {
        detail = await adapter.detail(copy.item.externalId);
        deps.detailCache.set(copyCacheKey(copy), detail);
      } catch { /* detail 段失败降级：不阻断取流，由 resolve 定成败 */ }
    }
    const res = await adapter.resolve(opts?.episodeExternalId ?? copy.item.externalId);
    const stream = res.streams[0];
    if (!stream) throw new Error("该副本未解析到可播放地址");
    return { streamUrl: stream.url, streamKind: stream.kind, detail };
  }
  let detail = deps.detailCache.get(copyCacheKey(copy));
  if (!detail) {
    detail = await adapter.detail(copy.item.externalId);
    deps.detailCache.set(copyCacheKey(copy), detail);
  }
  if (kind === "image") {
    const images = (detail.images?.length ? detail.images : [detail.cover]).filter(Boolean);
    if (!images.length) throw new Error("该副本未解析到图片");
    return { detail, images };
  }
  return { detail };
}
