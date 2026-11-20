/**
 * 适配器模板契约测试（Muse 2026-11-19 根治包·多源线 条目4）：
 * 运行：node src/features/sources/adapters/adapters.contract.test.ts
 * 经 setFetchPage 注入录制式夹具（fixtures/，构造样本非真站抓取），
 * 断言 list/detail/resolve 解析结果形状。不访问真实网络。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "../registry.ts";
import { setFetchPage } from "./fetchPage.ts";
import { createChiguaAdapter, createDanbooruAdapter, createHlsSiteAdapter, createPreviewOnlyAdapter, createWpRestAdapter } from "./templates.ts";

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const def = (id: string) => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};

/* ── 吃瓜模板（51吃瓜网 def） ── */
{
  setFetchPage(async (url) => (url.includes("/archives/") ? fx("chigua-detail.html") : fx("chigua-list.html")));
  const a = createChiguaAdapter(def("51chigua"));
  const list = await a.list(1, 20);
  assert.equal(list.items.length, 2, "chigua list 去重后 2 条");
  assert.equal(list.items[0].title, "夹具帖一");
  assert.ok(list.items[0].cover.endsWith("c101.jpg"), "chigua cover");
  const detail = await a.detail(list.items[0].externalId);
  assert.equal(detail.title, "夹具帖一");
  assert.ok(detail.contentHtml?.includes("正文第一段"), "chigua detail 正文");
  const res = await a.resolve(list.items[0].externalId);
  assert.equal(res.streams.length, 1);
  assert.equal(res.streams[0].kind, "hls");
  assert.ok(res.streams[0].url.endsWith("index.m3u8"), "chigua resolve m3u8");
}

/* ── 通用 HLS 模板（FC2 def） ──
 * 断言适配（Muse 2026-11-19 fix321-F2，不削弱覆盖）：肉视频参数已
 * 按真站校准为 /home + /v/<id>（见 fix321-f2.contract 真站夹具），
 * 不再是通用骨架形态；通用骨架（/?page= + /video/）覆盖移交参数
 * 同形态的 FC2 def，断言内容不变。
 * 再适配（fix321-F2b）：FC2 已按真站销量榜校准（/ranking/article/
 * weekly + /article_search.php?id=），通用骨架覆盖再移交参数同形态
 * 的目录源 hentaihaven def，断言内容不变。
 * 再适配（fix330 接通批）：hentaihaven 已改专用模板 hentaihaven-api，
 * 通用骨架覆盖改用与原目录条目功能字段逐字一致的内联合成 def，
 * 断言内容不变；专用模板覆盖见 fix330-new-adapters 契约。 */
{
  setFetchPage(async (url) => (url.includes("/video/") && !url.endsWith("?page=1") && url.includes("aaa") ? fx("hls-detail.html") : url.includes("/video/aaa-1") ? fx("hls-detail.html") : fx("hls-list.html")));
  const a = createHlsSiteAdapter({
    id: "hentaihaven", displayName: "HentaiHaven", kind: "video", category: "video",
    adapter: { template: "hls-site", params: { listPath: "/?page={page}", itemLinkPattern: "/video/", detailPath: "/video/{id}" } },
    baseUrls: ["https://hentaihaven.xxx/"], enabled: false, order: 105, maturity: "probe",
    capabilities: { search: false, episodes: false, hevc: false, comments: false },
    network: { mode: "probe-required" }, note: "历史目录条目参数（fix330 适配合成 def）",
  } as Parameters<typeof createHlsSiteAdapter>[0]);
  const list = await a.list(1, 20);
  assert.equal(list.items.length, 2, "hls list 2 条");
  assert.equal(list.items[1].title, "夹具视频二");
  const res = await a.resolve(list.items[0].externalId);
  assert.equal(res.streams[0].kind, "hls");
  assert.ok(res.streams[0].url.includes("master.m3u8"), "hls resolve m3u8");
  const detail = await a.detail(list.items[0].externalId);
  assert.equal(detail.title, "夹具视频一");
}

/* ── WP REST 模板（秀人网 def） ── */
{
  setFetchPage(async (url) => {
    if (url.includes("/posts/501")) return JSON.stringify({ id: 501, link: "https://xiuren.example.com/501", title: { rendered: "夹具图集一" }, content: { rendered: '<p><img src="https://img.example.com/x501a.jpg"></p>' }, excerpt: { rendered: "" } });
    return fx("wp-rest-list.json");
  });
  const a = createWpRestAdapter(def("xiuren"));
  const list = await a.list(1, 20);
  assert.equal(list.items.length, 2, "wp list 2 条");
  assert.equal(list.items[0].externalId, "501");
  assert.ok(list.items[0].cover.endsWith("x501.jpg"), "wp cover 取摘要首图");
  const detail = await a.detail("501");
  assert.deepEqual(detail.images, ["https://img.example.com/x501a.jpg"], "wp detail 图片集");
}

/* ── Danbooru API（danbooru def） ── */
{
  setFetchPage(async (url) => (url.includes("/posts/9001.json")
    ? JSON.stringify({ id: 9001, tag_string: "landscape sky", preview_file_url: "https://cdn.example.com/p9001.jpg", large_file_url: "https://cdn.example.com/l9001.jpg", file_url: "https://cdn.example.com/f9001.jpg" })
    : fx("danbooru-list.json")));
  const a = createDanbooruAdapter(def("danbooru"));
  const list = await a.list(1, 20);
  assert.equal(list.items.length, 2, "danbooru list 2 条");
  assert.ok(list.items[0].cover.endsWith("p9001.jpg"), "danbooru cover=preview");
  /* fix337/008-detail：单帖单图模型的列表侧载体——列表载荷本就
   * 逐帖带大图地址（large_file_url），旧 toItem 只留 preview 作
   * cover、大图被丢弃，宿主无从以列表组装画廊、点开恒只见详情
   * 的 1 张。条目须自带大图（与 detail 同口径 largeField 优先）。 */
  assert.ok(list.items[0].largeImage?.endsWith("l9001.jpg"), "danbooru 条目自带大图（large_file_url）");
  const detail = await a.detail("9001");
  assert.deepEqual(detail.images, ["https://cdn.example.com/l9001.jpg"], "danbooru detail 恒单图（单帖单图模型：画廊靠列表组装、非详情聚合丢图）");
  const res = await a.resolve("9001");
  assert.equal(res.streams[0].kind, "file");
  assert.ok(res.streams[0].url.endsWith("f9001.jpg"), "danbooru resolve=file_url");
}

/* ── Danbooru 模板 moebooru 校准形态（yandere def；同族 konachan
 * 参数逐字同构、共用本块口径）fix337/008-detail ── */
{
  const post = { id: 7001, tags: "landscape sky", preview_url: "https://cdn.example.com/p7001.jpg", jpeg_url: "https://cdn.example.com/j7001.jpg", file_url: "https://cdn.example.com/f7001.jpg" };
  setFetchPage(async (url) => (url.includes("tags=id:7001") ? JSON.stringify([post]) : JSON.stringify([post, { ...post, id: 7002 }])));
  const a = createDanbooruAdapter(def("yandere"));
  const list = await a.list(1, 20);
  assert.equal(list.items.length, 2, "moebooru list 2 条");
  assert.ok(list.items[0].cover.endsWith("p7001.jpg"), "moebooru cover=preview_url");
  assert.ok(list.items[0].largeImage?.endsWith("j7001.jpg"), "moebooru 条目自带大图（jpeg_url＝largeField）");
  const detail = await a.detail("7001");
  assert.deepEqual(detail.images, ["https://cdn.example.com/j7001.jpg"], "moebooru detail 恒单图（单元素数组归一）");
}

/* ── preview-only 模板（断言适配，3.2.2 瘦身）：唯一使用方 myfans 已
 * 摘除注册表，模板工厂留仓——覆盖移交合成 def（模板行为不变式：
 * 条目标注仅预览、resolve 明确拒绝），断言内容不变。 ── */
{
  const synthetic = {
    id: "preview-synthetic", displayName: "预览合成源", kind: "video", category: "preview",
    adapter: { template: "preview-only", params: {} }, baseUrls: ["https://example.com"],
    enabled: true, order: 999, maturity: "preview",
    capabilities: { search: false, episodes: false, hevc: false, comments: false },
  } as Parameters<typeof createPreviewOnlyAdapter>[0];
  const a = createPreviewOnlyAdapter(synthetic);
  const list = await a.list(1, 20);
  assert.equal(list.items[0].previewOnly, true, "preview-only 条目标注仅预览");
  assert.ok(list.items[0].tags.includes("仅预览"));
  await assert.rejects(() => a.resolve("preview-root"), /仅预览/, "preview-only resolve 明确拒绝");
}

console.log("adapters.contract: all assertions passed");
