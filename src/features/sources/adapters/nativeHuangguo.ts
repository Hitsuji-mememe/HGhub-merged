/**
 * 黄果 native 适配器（Muse 2026-11-19 根治包）：包既有 api 调用，
 * 不重写任何上游逻辑。list/detail 走帖子板块（remen-chigua，
 * 与 Posts.tsx 现行写死口径一致），resolve 走 postPlayback 分段接口。
 */
import { api } from "../../../shared/api/api";
import type { Post } from "../../../shared/api/types";
import type { SourceAdapter, SourceItem } from "../types";

const toItem = (p: Post): SourceItem => ({
  sourceId: "huangguo",
  externalId: String(p.id),
  title: p.title,
  cover: p.cover,
  href: "",
  tags: p.tags ?? [],
  hot: p.hot,
});

export function createNativeHuangguoAdapter(): SourceAdapter {
  return {
    sourceId: "huangguo",
    async list(page, size) {
      const r = await api.postCategory("remen-chigua", page, size, "latest");
      return { items: (r?.items ?? []).map(toItem), pagination: r.pagination };
    },
    async detail(id) {
      const p = await api.post(Number(id));
      return {
        ...toItem(p), description: p.desc, contentHtml: p.content,
        images: [], episodes: [],
      };
    },
    async resolve(id) {
      const r = await api.postPlayback(Number(id));
      const streams = (r?.videos ?? [])
        .map((v) => v?.url)
        .filter((u): u is string => Boolean(u))
        .map((url) => ({ url, kind: "hls" as const }));
      return { streams };
    },
    async search(q, page, size) {
      const r = await api.searchPosts(q, page, size);
      return { items: (r?.items ?? []).map(toItem), pagination: r.pagination };
    },
  };
}
