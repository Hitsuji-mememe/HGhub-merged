/* fix3312/cover-021 契约：021（wp-rest＋yoastCover opt-in）的 Yoast
 * 封面回落专属覆盖——toItem 封面链末位回落 yoast_head_json.
 * twitter_image 的字段语义、未声明源逐字旧行为、Yoast 不发字段
 * 的帖如实留空、正文 <img> 优先序不变。
 *
 * 本文件的新增由 fix3312/cover-021 线任务书（维护者裁定）批准
 * （仓库不变量 11：新增测试须先经维护者同意，同意记录即该任务
 * 书）。旧码先红：基点 fix3311-integration @24fb26f 的 templates.ts
 * 无 yoastCover 消费、registry 021 未声明——同夹具下基点 021 列表
 * 封面为空（生产路径实拉基线同证：list1/list2 covers=0/20，见
 * fix3312/evidence/cover-021.md），本文件在该树 exit 1。
 * 不访问真实网络：取页经 setFetchPage 注入内联夹具（形态据实拉
 * 证据：帖 27139 正文只有 <video><source>、excerpt 无 <img>、
 * yoast_head_json.twitter_image 直载封面 URL；帖 27086 的
 * yoast_head_json 无 twitter_image 键，见证据同文件）。 */
import assert from "node:assert/strict";
import { getBuiltinRegistry } from "./registry.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { createWpRestAdapter } from "./adapters/templates.ts";
import type { SourceDef } from "./types.ts";

const registry = getBuiltinRegistry();
const byId = (id: string): SourceDef => {
  const def = registry.find((s) => s.id === id);
  assert.ok(def, `注册表含 ${id}`);
  return def;
};

const COVER_URL = "https://hentaiplay.net/wp-content/uploads/Kanojo-no-Tomodachi-Episode-7-Hentaiplay.jpg";
const MP4_URL = "https://hentaiplanet.info/Kanojo-no-Tomodachi-Episode-7-English-Subbed.mp4";

/* 帖 27139 实拉形态：正文只有 fluidplayer <video><source>、无
 * <img>；excerpt 是 series 说明文字、无 <img>；封面只在
 * yoast_head_json.twitter_image（与 featured_media 同一文件）。 */
const postWithYoast = {
  id: 27139, link: "https://hentaiplay.net/kanojo-no-tomodachi-episode-7/",
  title: { rendered: "Kanojo no Tomodachi Episode 7 English Subbed" },
  content: { rendered: `<p>Watch online.</p><video id="my-video" class="fluidplayer"><source src="${MP4_URL}" type="video/mp4"></video>` },
  excerpt: { rendered: "<p>This entry is part 7 of 7 in the series Kanojo no Tomodachi</p>" },
  featured_media: 27136,
  yoast_head_json: { twitter_card: "summary_large_image", twitter_image: COVER_URL },
  categories: [], tags: [],
};
/* 帖 27086 实拉形态：Yoast 未发 twitter_image（键不存在），
 * featured_media 仍有值——本线口径如实留空、不合成地址。 */
const postWithoutYoastImage = {
  ...postWithYoast, id: 27086,
  link: "https://hentaiplay.net/dark-summoner-to-dekiteiru-episode-5-english/",
  featured_media: 27087,
  yoast_head_json: { twitter_card: "summary_large_image" },
};
/* 正文带 <img> 的帖：既有封面链优先序不变、正文图压过 Yoast 回落。 */
const CONTENT_IMG = "https://hentaiplay.net/wp-content/uploads/in-content-first.jpg";
const postWithContentImg = {
  ...postWithYoast, id: 27001,
  content: { rendered: `<p><img src="${CONTENT_IMG}" alt=""></p><video><source src="${MP4_URL}" type="video/mp4"></video>` },
};

const stubPosts = (posts: Record<string, unknown>[]) => setFetchPage(async (url) => {
  if (url.includes("/categories") || url.includes("/tags")) return "[]";
  const single = posts.find((p) => url.includes(`/posts/${p.id}`));
  if (single) return JSON.stringify(single);
  if (url.includes("/posts")) return JSON.stringify(posts);
  throw new Error(`未预期取页 ${url}`);
});

/* ── 注册形态：021 声明 yoastCover、其余 wp-rest 源不声明 ── */
{
  const p = byId("hentaiplay");
  assert.equal(p.adapter.template, "wp-rest", "021 走 wp-rest 模板");
  assert.equal((p.adapter.params as Record<string, unknown>).yoastCover, true, "021 声明 yoastCover=true");
  /* 适配（fix3315）：hentaigasm 保持删除、不在册——对照组改由在册
   * wp-rest 源 everia/xiuren 承接，作用域断言强度不变。 */
  for (const id of ["everia", "xiuren"]) {
    assert.equal((byId(id).adapter.params as Record<string, unknown> | undefined)?.yoastCover, undefined,
      `${id} 不声明 yoastCover（opt-in 作用域只限 021）`);
  }
}

/* ── 适配器层：声明源封面回落 Yoast 字段（列表/详情同链） ── */
{
  stubPosts([postWithYoast]);
  const a = createWpRestAdapter(byId("hentaiplay"));
  const list = await a.list(1, 20);
  assert.equal(list.items[0].cover, COVER_URL, "正文/excerpt 无 <img> 时封面回落 yoast_head_json.twitter_image");
  const detail = await a.detail("27139");
  assert.equal(detail.cover, COVER_URL, "详情封面同回落 Yoast 字段");
  const resolved = await a.resolve("27139");
  assert.deepEqual(resolved.streams, [{ url: MP4_URL, kind: "file" }], "resolve 不受封面回落影响、仍走 stock extractMp4");
}

/* ── Yoast 不发字段的帖：如实留空 ── */
{
  stubPosts([postWithoutYoastImage]);
  const a = createWpRestAdapter(byId("hentaiplay"));
  const list = await a.list(1, 20);
  assert.equal(list.items[0].cover, "", "yoast_head_json 无 twitter_image 时封面为空、不合成地址");
}

/* ── 优先序：正文 <img> 在 Yoast 回落之前 ── */
{
  stubPosts([postWithContentImg]);
  const a = createWpRestAdapter(byId("hentaiplay"));
  const list = await a.list(1, 20);
  assert.equal(list.items[0].cover, CONTENT_IMG, "正文 <img> 命中时不落 Yoast 回落（封面链优先序不变）");
}

/* ── 未声明源同夹具逐字旧行为（Yoast 段不可达） ── */
{
  stubPosts([postWithYoast]);
  const declared = byId("hentaiplay");
  const legacyDef: SourceDef = {
    ...declared,
    id: "yoast-legacy-control",
    adapter: { template: "wp-rest", params: { ...(declared.adapter.params ?? {}), yoastCover: false } },
  };
  const a = createWpRestAdapter(legacyDef);
  const list = await a.list(1, 20);
  assert.equal(list.items[0].cover, "", "未声明 yoastCover：同夹具封面为空、不读 Yoast 字段（旧行为）");
}
