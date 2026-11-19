/**
 * 最终版 D 线契约测试（Muse 2026-11-19，①用户点名条目6/7/8＋
 * 外部源接通；任务 brief 明确要求新增契约/接线断言与夹具数据流
 * 测试，故新增本文件——AGENTS 新增测试须经同意口径以 brief 的
 * 明确要求为据，并在回报中点名）。
 * 运行：node src/features/sources/final-d.contract.test.ts
 * 覆盖：清单新址常量、CSP 五处口径（三文件 csp/devCsp 的 connect-src
 * 均含新 origin）、「视频」改名与子筛撤除、图片分区接线、
 * createAdapter 生产调用者 >0、夹具数据流（video 列表→resolve，
 * image 列表→detail 图集）、blocked 仍走诚实提示页分支。
 * 不访问真实网络：经 setFetchPage 注入既有 fixtures 夹具。
 * 数据流口径与 adapters.contract.test.ts 一致：工厂 index.ts 的
 * native 分支牵连 Tauri api 链、Node 下不可直接 import，故数据流
 * 直测 createAdapter 所分发的同一模板工厂函数，createAdapter 的
 * 生产接线另由文本断言＋tools/wiring-manifest.json 接线门禁钉住。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REMOTE_MANIFEST_URL } from "./manifest.ts";
import { getBuiltinRegistry, sourcesForCategory } from "./registry.ts";
import { createHlsSiteAdapter, createWpRestAdapter } from "./adapters/templates.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");
const NEW_ORIGIN = "https://hghub-registry.pages.dev";

/* ── 条目6：清单改址 ── */
assert.equal(REMOTE_MANIFEST_URL, `${NEW_ORIGIN}/sources-manifest.json`, "清单 URL 常量为新址");

/* ── 条目6：CSP——三文件、csp 与 devCsp 共六字段的 connect-src 均含
 * 新 origin（任务口径五处＝主/iOS 四处＋Linux 一文件；Linux 内两
 * 字段一并补齐，不留 dev 缺口）。 ── */
for (const rel of ["../../../src-tauri/tauri.conf.json", "../../../src-tauri/tauri.ios.conf.json", "../../../src-tauri/tauri.linux.conf.json"]) {
  const conf = JSON.parse(read(rel)) as { app: { security: { csp: string; devCsp: string } } };
  for (const field of ["csp", "devCsp"] as const) {
    const connectSrc = conf.app.security[field].split(";").map((s) => s.trim()).find((s) => s.startsWith("connect-src")) ?? "";
    assert.ok(connectSrc.includes(NEW_ORIGIN), `${rel} ${field} connect-src 含新 origin`);
  }
}

/* ── 条目7：分类修订 ── */
{
  const category = read("../category/Category.tsx");
  assert.ok(category.includes('{ cate: "original", name: "视频"'), "original 频道显示名改「视频」");
  assert.ok(!category.includes('"ai-manju"'), "Category 代码无 ai-manju 子筛值残留（注释中的撤除说明除外）");
  const catesBlock = category.slice(category.indexOf("const ORIGINAL_CATES"), category.indexOf("const originalSort"));
  assert.ok(catesBlock.includes('value: "all"'), "ORIGINAL_CATES 只留全部");
  assert.ok(!catesBlock.includes("ai-duanju"), "ORIGINAL_CATES 无 ai-duanju 子筛");
  assert.ok(category.includes('{ cate: "ai-duanju", name: "短剧"'), "短剧频道本身不动");
  const inplace = read("../search/InplaceSearch.tsx");
  assert.ok(inplace.includes('scope === "original" ? "视频"'), "InplaceSearch 显示名一致改「视频」");
}

/* ── 条目8：图片分区 ── */
{
  const category = read("../category/Category.tsx");
  assert.ok(category.includes('sourcesForCategory("image"'), "图片分区经 sourcesForCategory(image) 列 active 注册表");
  assert.ok(category.includes("cate: `image:${s.id}`"), "图片源点开推 channel 栈页 image:<id>");
  assert.ok(category.includes("<SourceGallery def={imageSource}"), "图集页在 ChannelPage 挂载");
  const imageSources = sourcesForCategory("image", getBuiltinRegistry());
  const ids = imageSources.map((s) => s.id);
  for (const id of ["xiuren", "pornpics", "cosplaytele", "danbooru"]) {
    assert.ok(ids.includes(id), `active 图片源含 ${id}`);
  }
  /* 断言适配（fix330 图片线，2026-11-19）：xiuren 改走 xiuren.biz 本机
   * 四级全通解 blocked、danbooru 住宅四级全通翻案（旧 blocked 系机房
   * CF 假象），两源均改判 probe（App 未真机验），证据 fix330/evidence/images.md。 */
  assert.equal(imageSources.find((s) => s.id === "xiuren")!.maturity, "probe", "秀人网 fix330 解 blocked 为 probe");
  assert.equal(imageSources.find((s) => s.id === "danbooru")!.maturity, "probe", "Danbooru fix330 翻案为 probe");
  assert.equal(imageSources.find((s) => s.id === "cosplaytele")!.maturity, "stable", "CosplayTele 如实 stable");
  assert.equal(imageSources.find((s) => s.id === "pornpics")!.maturity, "probe", "PornPics 如实 probe");
}

/* ── 外部源接通：createAdapter 生产调用者 >0（接线断言） ── */
{
  const browse = read("./SourceBrowse.tsx");
  const gallery = read("./SourceGallery.tsx");
  const category = read("../category/Category.tsx");
  assert.ok(browse.includes("createAdapter(def)"), "SourceBrowse 生产调用 createAdapter");
  assert.ok(gallery.includes("createAdapter(def)"), "SourceGallery 生产调用 createAdapter");
  assert.ok(category.includes("<SourceBrowse def={channelSource}"), "ChannelPage 非黄果分支挂载 SourceBrowse");
  assert.ok(category.includes('channelSource.maturity === "blocked"'), "blocked 视频源仍走诚实提示分支");
  assert.ok(category.includes('imageSource.maturity === "blocked"'), "blocked 图片源仍走诚实提示分支");
}

/* ── 夹具数据流（video）：模板工厂（createAdapter 的 hls-site
 * 分发目标）→ list → resolve ── */
{
  setFetchPage(async (url) => (url.includes("/video/aaa-1") ? fx("hls-detail.html") : fx("hls-list.html")));
  /* 断言适配（Muse 2026-11-19 fix321-F2）：肉视频参数已按真站校准
   * 为 /home + /v/<id>，通用骨架数据流改用参数同形态的 FC2 def。
   * 再适配（fix321-F2b）：FC2 已按真站销量榜校准，通用骨架数据流
   * 再移交参数同形态的目录源 hentaihaven def，断言内容不变。
   * 再适配（fix330 接通批）：hentaihaven 已改专用模板
   * hentaihaven-api，通用骨架数据流改用与原目录条目功能字段逐字
   * 一致的合成 def（id 仍 hentaihaven），断言内容不变；专用模板
   * 的数据流由 fix330-new-adapters 契约承接。 */
  const def = {
    id: "hentaihaven", displayName: "HentaiHaven", kind: "video", category: "video",
    adapter: { template: "hls-site", params: { listPath: "/?page={page}", itemLinkPattern: "/video/", detailPath: "/video/{id}" } },
    baseUrls: ["https://hentaihaven.xxx/"], enabled: false, order: 105, maturity: "probe",
    capabilities: { search: false, episodes: false, hevc: false, comments: false },
    network: { mode: "probe-required" }, note: "历史目录条目参数（fix330 适配合成 def）",
  } as unknown as Parameters<typeof createHlsSiteAdapter>[0];
  assert.equal(def.adapter.template, "hls-site", "合成 def 模板为 hls-site（createAdapter 分发目标即下方工厂）");
  assert.ok(read("./adapters/index.ts").includes('case "hls-site": return createHlsSiteAdapter(def)'), "createAdapter 分发 hls-site → createHlsSiteAdapter");
  const adapter = createHlsSiteAdapter(def);
  const list = await adapter.list(1, 20);
  assert.equal(list.items.length, 2, "video 夹具列表 2 条");
  assert.equal(list.items[0].sourceId, "hentaihaven", "条目带源 id、不冒充黄果");
  const res = await adapter.resolve(list.items[0].externalId);
  assert.equal(res.streams[0].kind, "hls");
  assert.ok(res.streams[0].url.includes("master.m3u8"), "video resolve 出 HLS 地址供 Player 消费");
}

/* ── 夹具数据流（image）：模板工厂（createAdapter 的 wp-rest
 * 分发目标）→ list → detail 图集 ── */
{
  setFetchPage(async (url) => {
    if (url.includes("/posts/501")) {
      return JSON.stringify({
        id: 501, link: "https://cosplaytele.example.com/501", title: { rendered: "夹具图集一" },
        content: { rendered: '<p><img src="https://img.example.com/c501a.jpg"></p><p><img src="https://img.example.com/c501b.jpg"></p>' },
        excerpt: { rendered: "" },
      });
    }
    return fx("wp-rest-list.json");
  });
  const def = getBuiltinRegistry().find((s) => s.id === "cosplaytele")!;
  assert.equal(def.adapter.template, "wp-rest", "cosplaytele 模板为 wp-rest（createAdapter 分发目标即下方工厂）");
  assert.ok(read("./adapters/index.ts").includes('case "wp-rest": return createWpRestAdapter(def)'), "createAdapter 分发 wp-rest → createWpRestAdapter");
  const adapter = createWpRestAdapter(def);
  const list = await adapter.list(1, 20);
  assert.equal(list.items.length, 2, "image 夹具列表 2 条");
  const detail = await adapter.detail("501");
  assert.deepEqual(detail.images, ["https://img.example.com/c501a.jpg", "https://img.example.com/c501b.jpg"], "image detail 图集 2 张供大图查看");
}

/* ── 失败态：取页抛错时适配器如实抛错（页面据此呈现错误态＋重试，
 * 不静默回落） ── */
{
  setFetchPage(async () => { throw new Error("fixture net down"); });
  const def = getBuiltinRegistry().find((s) => s.id === "rule34video")!; // 断言适配（3.2.2 瘦身）：pornhub 已摘除，同模板保留源接替
  const adapter = createHlsSiteAdapter(def);
  await assert.rejects(() => adapter.list(1, 20), /fixture net down/, "取数失败如实抛错");
}

console.log("final-d.contract: all assertions passed");
