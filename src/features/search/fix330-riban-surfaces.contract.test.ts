/**
 * 3.3.1 里番面接线修复·详情面契约（Muse 2026-11-19
 * fix330-riban-surfaces；本线任务书即维护者对新增测试的授权，
 * AGENTS 不变量 11）。运行：
 * node src/features/search/fix330-riban-surfaces.contract.test.ts
 *
 * 真机事实（3.3.0 首验）：source-002 搜索能出结果，点开报「全部
 * 来源副本均加载失败」；010/011/012 详情未验。
 * 定性（逐 seam 普查）：App 内路径无断点——结果卡 onOpen →
 * openMerged → openExternal → loadWithFallback → 副本加载 →
 * createAdapter → adapter.detail/resolve；启动注入（fetchPage/
 * fetchPost）与 Rust source_fetch/source_post 注册/白名单/头名单
 * 全部对齐；002 适配器经本机真实网络实测 list/detail/resolve
 * 全通（3 档 HLS）。真机失败段收窄在 resolve 独有且从未被任何
 * 门禁在真机探过的三段（ct 域 GET / WebCrypto / auth 域 POST
 * ＋设备出口），本机证据无法再细分、如实标注待真机探针。
 * App 路径内真实缺口：副本加载对 video/drama **跳过 detail 段
 * 直调 resolve**——详情面名实不符（单副本 detail 恒 undefined、
 * 描述/分集全缺）。本批修根：加载核抽为纯模块 copyLoader
 * （postsRoute 先例），video/drama 先经 detail 段再 resolve。
 *
 * 旧红形态（基线 fix-330-20261119 @4cf7454）：copyLoader 模块
 * 不存在（副本加载封死在 Search 组件内、video 分支无 detail
 * 调用），本文件在基线无法运行（模块缺失即红）。
 *
 * 覆盖：四源各一条完整场景——真实适配器经夹具接缝走 search
 * 出条目（搜索结果形态）→ 以该条目构造副本 → 生产加载核
 * loadSearchCopy("video", …) → 断言：detail 段被调用、detail
 * 入结果与缓存、resolve 产出可播放流（形态逐源断言）。不访问
 * 真实网络（fetchPage/fetchPost 均经接缝注入既有夹具）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "../sources/registry.ts";
import type { SourceAdapter, SourceDef, SourceDetail, SourceItem } from "../sources/types.ts";
import { setFetchPage } from "../sources/adapters/fetchPage.ts";
import { setFetchPost, type FetchPostResult } from "../sources/adapters/fetchPost.ts";
import { createHanimeApiAdapter, sealEnvelope } from "../sources/adapters/hanimeApi.ts";
import { createHanime1Adapter, createHentaihavenAdapter, createIwaraAdapter } from "../sources/adapters/templates.ts";
import { loadSearchCopy, copyCacheKey, type CopyLoaderDeps } from "./copyLoader.ts";
import type { CopyRef } from "./multiSourceSearch.ts";

const fx = (name: string) => readFileSync(new URL(`../sources/adapters/fixtures/${name}`, import.meta.url), "utf8");
const def = (id: string): SourceDef => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};

/** 与生产分发（adapters/index.ts）同映射的直引工厂（index.ts
 * 为无扩展名导入、契约环境不直引，与既有契约同口径；分发本体
 * 由下方源码文本断言守）。 */
function makeAdapterDirect(d: SourceDef): SourceAdapter {
  switch (d.adapter.template) {
    case "hanime-api": return createHanimeApiAdapter(d);
    case "iwara-api": return createIwaraAdapter(d);
    case "hanime1": return createHanime1Adapter(d);
    case "hentaihaven-api": return createHentaihavenAdapter(d);
    default: throw new Error(`unexpected template ${d.adapter.template}`);
  }
}

/** 跑一条「搜索结果 → 点开详情」完整场景：先经适配器 search
 * 拿真实结果条目，再以生产加载核打开；detail 调用计数由包装
 * 适配器实测（旧行为 video 分支 detail 调用恒为 0）。 */
async function runOpenScenario(
  sourceId: string,
  searchCall: (a: SourceAdapter) => Promise<SourceItem>,
): Promise<{ item: SourceItem; streamUrl?: string; detail?: SourceDetail; detailCalls: number }> {
  const d = def(sourceId);
  const raw = makeAdapterDirect(d);
  const item = await searchCall(raw);
  assert.equal(item.sourceId, sourceId, `${sourceId} 搜索条目带本源 sourceId`);
  let detailCalls = 0;
  const counting: SourceAdapter = {
    ...raw,
    detail: async (id: string) => { detailCalls += 1; return raw.detail(id); },
  };
  const detailCache = new Map<string, SourceDetail>();
  const deps: CopyLoaderDeps = {
    getDef: (id) => getBuiltinRegistry().find((s) => s.id === id),
    makeAdapter: () => counting,
    detailCache,
  };
  const copy: CopyRef = { sourceId, sourceName: d.displayName, weight: 40, hot: 0, seq: 0, item };
  const got = await loadSearchCopy("video", copy, deps);
  assert.ok(detailCalls >= 1, `${sourceId} 点开详情必须先走适配器 detail 段（旧行为恒为 0 次）`);
  assert.ok(got.detail, `${sourceId} 详情面拿到 detail（旧行为单副本恒 undefined）`);
  assert.equal(got.detail?.externalId, item.externalId, `${sourceId} detail 与搜索条目同一条目`);
  assert.equal(detailCache.get(copyCacheKey(copy))?.externalId, item.externalId, `${sourceId} detail 入生产缓存（副本切换复用）`);
  assert.ok(got.streamUrl, `${sourceId} 点开后继续到取流、产出可播放地址`);
  return { item, streamUrl: got.streamUrl, detail: got.detail, detailCalls };
}

/* ── source-002（hanime-api）：目录搜索 → detail（目录行）→
 * 握手 resolve（CSRF＋信封 POST 夹具链） ── */
{
  const catalogJson = fx("hanime-search-hvs.json");
  const sourcesPayload = JSON.stringify({
    sources: [
      { kind: "normal", src: "/hls/480/FixtureToken480", height: 480 },
      { kind: "normal", src: "/hls/720/FixtureToken720", height: 720 },
    ],
  });
  const sealed = await sealEnvelope(sourcesPayload, new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2]));
  const envelopeJson = JSON.stringify({ v: 1, alg: "AES-256-GCM", iv: sealed.iv, tag: sealed.tag, data: sealed.data });
  const xToken = Buffer.from(envelopeJson, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  let postCalls = 0;
  setFetchPage(async (url) => {
    if (url.includes("search_hvs")) return catalogJson;
    if (url.includes("csrf-token")) return JSON.stringify({ csrf_token: "fixture-csrf", csrf_token_expires_at: 1795107769 });
    throw new Error(`unexpected fetch ${url}`);
  });
  setFetchPost(async (url): Promise<FetchPostResult> => {
    assert.ok(url.includes("/api/v11/handshake"), "握手 POST 发 auth 域 handshake 端点");
    postCalls += 1;
    return { status: 200, body: "{}", xToken };
  });
  const r = await runOpenScenario("hanime-tv", async (a) => {
    const hit = await a.search!("unicorn", 1, 10);
    assert.equal(hit.items.length, 1, "source-002 搜索出条目（真机同形态：搜索可达）");
    return hit.items[0];
  });
  assert.equal(r.item.externalId, "fixture-slug-one", "source-002 条目 id 为目录 slug");
  assert.equal(r.streamUrl, "https://hanime.tv/hls/720/FixtureToken720", "source-002 取流经握手链产出最高画质 HLS");
  assert.ok(postCalls >= 1, "source-002 resolve 真走 fetchPost 定向接缝（握手已达）");
}

/* ── source-011（iwara-api）：API 搜索 → detail → X-Version
 * 签名取流 ── */
{
  setFetchPage(async (url) => {
    if (url.includes("files.iwara.tv")) return fx("iwara-sources.json");
    if (url.includes("/video/")) return fx("iwara-video.json");
    if (url.includes("/videos?") || url.includes("/search?")) return fx("iwara-list.json");
    throw new Error(`unexpected fetch ${url}`);
  });
  const r = await runOpenScenario("iwara", async (a) => {
    const hit = await a.search!("夹具", 1, 20);
    assert.ok(hit.items.length >= 1, "source-011 搜索出条目");
    return hit.items[0];
  });
  assert.equal(r.item.externalId, "Ab12Cd34Ef56", "source-011 条目 id 为 API 视频 id");
  assert.ok(r.streamUrl?.endsWith("-720.mp4"), "source-011 取流产出最高档 mp4");
  assert.equal(r.detail?.title, "夹具条目一", "source-011 detail 经 /video/<id> 取数");
}

/* ── source-010（hanime1）：/search 卡片 → /watch detail →
 * watch 页多档取流 ── */
{
  setFetchPage(async (url) => {
    if (url.includes("/watch?v=")) return fx("hanime1-watch.html");
    if (url.includes("/search")) return fx("hanime1-search.html");
    throw new Error(`unexpected fetch ${url}`);
  });
  const r = await runOpenScenario("hanime1", async (a) => {
    const hit = await a.search!("夹具", 1, 20);
    assert.ok(hit.items.length >= 1, "source-010 搜索出条目");
    return hit.items[0];
  });
  assert.equal(r.item.externalId, "100001", "source-010 条目 id 为 watch?v= 数字 id");
  assert.ok(r.streamUrl?.includes("-1080p.mp4"), "source-010 取流产出 watch 页最高档 mp4");
  assert.equal(r.detail?.title, "夹具条目一", "source-010 detail 经 watch 页取数");
}

/* ── source-012（hentaihaven-api）：目录 API 搜索 → watch
 * detail（分集）→ 集页 ld+json 取 HLS ── */
{
  setFetchPage(async (url) => {
    if (url.includes("/api/manga/")) return fx("hentaihaven-list.json");
    if (url.includes("/episode-")) return fx("hentaihaven-episode.html");
    if (url.includes("/watch/")) return fx("hentaihaven-watch.html");
    throw new Error(`unexpected fetch ${url}`);
  });
  const r = await runOpenScenario("hentaihaven", async (a) => {
    const hit = await a.search!("夹具", 1, 20);
    assert.ok(hit.items.length >= 1, "source-012 搜索出条目");
    return hit.items[0];
  });
  assert.equal(r.item.externalId, "fixture-slug-001", "source-012 条目 id 为 slug");
  assert.ok(r.streamUrl?.endsWith(".m3u8"), "source-012 取流产出集页 HLS");
  assert.equal(r.detail?.episodes?.length, 2, "source-012 detail 带分集（详情面可呈现分集结构）");
}

/* ── 生产调用点（源码文本断言）：Search 消费加载核、工厂分发
 * 四模板齐全 ── */
{
  const searchSrc = readFileSync(new URL("./Search.tsx", import.meta.url), "utf8");
  assert.ok(searchSrc.includes("loadSearchCopy("), "Search 副本加载走生产加载核 copyLoader（生产调用点）");
  assert.ok(searchSrc.includes('from "./copyLoader"'), "Search 导入 copyLoader 单一出处");
  const factory = readFileSync(new URL("../sources/adapters/index.ts", import.meta.url), "utf8");
  for (const [tpl, fn] of [["hanime-api", "createHanimeApiAdapter"], ["iwara-api", "createIwaraAdapter"], ["hanime1", "createHanime1Adapter"], ["hentaihaven-api", "createHentaihavenAdapter"]] as const) {
    assert.ok(factory.includes(`case "${tpl}": return ${fn}(def)`), `工厂分发 ${tpl} → ${fn}`);
  }
}

console.log("fix330-riban-surfaces (search) contract: ok");
