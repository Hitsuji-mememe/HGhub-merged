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
 *
 * 断言适配（fix339/registry-cut-2，2026-11-21）：009/010 两源摘除
 * ＋适配器删码，其两条场景随功能同删退役；覆盖收口为 source-002
 * 单场景＋生产调用点断言，加载核（copyLoader）行为覆盖不变。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "../sources/registry.ts";
import type { SourceAdapter, SourceDef, SourceDetail, SourceItem } from "../sources/types.ts";
import { setFetchPage } from "../sources/adapters/fetchPage.ts";
import { createWpRestAdapter } from "../sources/adapters/templates.ts";
import { loadSearchCopy, copyCacheKey, type CopyLoaderDeps } from "./copyLoader.ts";
import { assembleSearchGallery } from "./searchGallery.ts";
import type { CopyRef, MergedHit } from "./multiSourceSearch.ts";

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
    case "wp-rest": return createWpRestAdapter(d);
    default: throw new Error(`unexpected template ${d.adapter.template}`);
  }
}

/** 跑一条「搜索结果 → 点开详情」完整场景：先经适配器 search
 * 拿真实结果条目，再以生产加载核打开；detail 调用计数由包装
 * 适配器实测（旧行为 video 分支 detail 调用恒为 0；本批后
 * video kind 已无生产消费者，场景改由存活 image kind 承接——
 * 加载核对各 kind 的 detail 先行口径不变，见 copyLoader 头注）。 */
async function runOpenScenario(
  sourceId: string,
  searchCall: (a: SourceAdapter) => Promise<SourceItem>,
): Promise<{ item: SourceItem; images?: string[]; detail?: SourceDetail; detailCalls: number }> {
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
  const got = await loadSearchCopy("image", copy, deps);
  assert.ok(detailCalls >= 1, `${sourceId} 点开详情必须先走适配器 detail 段（旧行为恒为 0 次）`);
  assert.ok(got.detail, `${sourceId} 详情面拿到 detail（旧行为单副本恒 undefined）`);
  assert.equal(got.detail?.externalId, item.externalId, `${sourceId} detail 与搜索条目同一条目`);
  assert.equal(detailCache.get(copyCacheKey(copy))?.externalId, item.externalId, `${sourceId} detail 入生产缓存（副本切换复用）`);
  assert.ok(got.images && got.images.length > 0, `${sourceId} 点开后产出图集（image kind 出口）`);
  return { item, images: got.images, detail: got.detail, detailCalls };
}

/* ── 存活承接场景（wp-rest 图片源）：搜索 → detail（单帖）→ 图集。
 * 原 source-002（hanime-api）完整场景随视频板块整组删除退役
 * （fix3314）——其握手/信封链覆盖对象已不存在；加载核 detail
 * 先行＋缓存＋出口形态的覆盖由本场景承接、不降。 ── */
{
  const post = {
    id: 11, link: "https://xiuren.example/p11",
    title: { rendered: "帖十一" }, excerpt: { rendered: "摘要" },
    content: { rendered: '<p><img src="https://img.example/11a.jpg"><img src="https://img.example/11b.jpg"></p>' },
    categories: [23], tags: [7],
  };
  setFetchPage(async (url) => {
    if (url.includes("/posts/11")) return JSON.stringify(post);
    if (url.includes("/posts?")) return JSON.stringify([post]);
    if (url.includes("/categories?")) return JSON.stringify([{ id: 23, name: "Hot Girl", count: 50 }]);
    if (url.includes("/tags?")) return JSON.stringify([{ id: 7, name: "长腿", count: 99 }]);
    throw new Error(`unexpected fetch ${url}`);
  });
  const r = await runOpenScenario("xiuren", async (a) => {
    const hit = await a.search!("帖", 1, 10);
    assert.equal(hit.items.length, 1, "wp-rest 源搜索出条目");
    return hit.items[0];
  });
  assert.equal(r.item.externalId, "11", "条目 id 为帖 id");
  assert.deepEqual(r.images, ["https://img.example/11a.jpg", "https://img.example/11b.jpg"], "图集＝detail 正文图序");
}

/* 原 source-002/010/011 场景均已退役（002 随 fix3314 视频板块
 * 删除、010/011 随 fix339 摘除）；加载核覆盖由上方 wp-rest 场景
 * 与下方生产调用点断言承接。 */

/* ── 生产调用点（源码文本断言）：Search 消费加载核、工厂分发
 * 齐全 ── */
{
  const searchSrc = readFileSync(new URL("./Search.tsx", import.meta.url), "utf8");
  assert.ok(searchSrc.includes("loadSearchCopy("), "Search 副本加载走生产加载核 copyLoader（生产调用点）");
  assert.ok(searchSrc.includes('from "./copyLoader"'), "Search 导入 copyLoader 单一出处");
  const factory = readFileSync(new URL("../sources/adapters/index.ts", import.meta.url), "utf8");
  /* 适配（fix338）：hentaihaven-api 已删码，分发断言收口三模板。
   * 适配（fix339）：iwara-api/hanime1 已删码，分发断言收口 hanime-api。
   * 适配（fix3314）：hanime-api/iwara-api 随视频板块删码，分发断言
   * 改钉存活模板全集。 */
  for (const [tpl, fn] of [["wp-rest", "createWpRestAdapter"], ["chigua", "createChiguaAdapter"], ["hls-site", "createHlsSiteAdapter"], ["danbooru-api", "createDanbooruAdapter"]] as const) {
    assert.ok(factory.includes(`case "${tpl}": return ${fn}(def)`), `工厂分发 ${tpl} → ${fn}`);
  }
}

/* ── 搜索宿主画廊组装（fix337/search-gallery；008-detail 同批横扫）──
 * 同根剩余面：booru 家族在源内宿主（SourceGallery）已以已加载列表
 * 组装画廊，但从搜索结果点开走 copyLoader 副本路径、只喂 detail
 * 单图——同帖在搜索面仍只有一张图、无从前后翻。搜索面的「列表」
 * 是跨源合并簇（MergedHit.copies），组装须以点开副本所属源为界：
 * 逐簇取该源副本的条目（非代表副本条目）、按结果列表序、同源条目
 * 去重，跨源条目绝不入画廊；判定与拼装仍走 albumGallery 唯一出处
 * （detail 恰 1 图∧自带大图 ≥2∧点开在列），不另起一套。
 * 基线（@20c219d）红形态：searchGallery 模块不存在、导入即
 * ERR_MODULE_NOT_FOUND（纯函数先行的既定证伪形态）。 */
{
  const mkItem = (sourceId: string, id: string, largeImage?: string): SourceItem => ({
    sourceId, externalId: id, title: `${sourceId}-${id}`, cover: `https://cdn.example.com/${sourceId}-p${id}.jpg`,
    href: "", tags: [], ...(largeImage ? { largeImage } : {}),
  });
  const mkCopy = (item: SourceItem, seq: number): CopyRef => ({
    sourceId: item.sourceId, sourceName: item.sourceId, weight: 40, hot: 0, seq, item,
  });
  const mkHit = (copies: CopyRef[]): MergedHit => {
    const rep = copies[0];
    return {
      kind: "image", title: rep.item.title, cover: rep.item.cover, tags: [],
      sourceId: rep.sourceId, sourceName: rep.sourceName, item: rep.item,
      hot: 0, seq: rep.seq, copies, alsoOn: [], identityConfirmed: true, mergeConfidence: 1,
    };
  };
  const X = "src-x";
  const Y = "src-y";
  const x1 = mkItem(X, "1", "https://cdn.example.com/x-l1.jpg");
  const x2 = mkItem(X, "2", "https://cdn.example.com/x-l2.jpg");
  const x3 = mkItem(X, "3", "https://cdn.example.com/x-l3.jpg");
  const y1 = mkItem(Y, "1", "https://cdn.example.com/y-l1.jpg");
  const y2 = mkItem(Y, "2", "https://cdn.example.com/y-l2.jpg");

  /* 跨源交错列表：只收点开副本所属源、保持列表序。 */
  const hits = [mkHit([mkCopy(x1, 1)]), mkHit([mkCopy(y1, 2)]), mkHit([mkCopy(x2, 3)]), mkHit([mkCopy(y2, 4)]), mkHit([mkCopy(x3, 5)])];
  const asm = assembleSearchGallery(hits, mkCopy(x2, 3), ["https://cdn.example.com/x-detail2.jpg"]);
  assert.ok(asm, "同源邻帖自带大图 ≥2＋点开在列 → 组装成立");
  assert.deepEqual(asm.items.map((i) => `${i.sourceId}:${i.externalId}`), [`${X}:1`, `${X}:2`, `${X}:3`],
    "画廊只含点开副本所属源条目（跨源条目绝不混入）、按结果列表序");
  assert.deepEqual(asm.images, ["https://cdn.example.com/x-l1.jpg", "https://cdn.example.com/x-detail2.jpg", "https://cdn.example.com/x-l3.jpg"],
    "点开位以 detail 图为准、邻帖以自带大图");
  assert.equal(asm.index, 1, "起始 index＝点开条目在同源入选集中的位置");

  /* 多副本簇：载体取该源副本条目，不取代表副本条目。 */
  const shared = mkHit([mkCopy(y1, 1), mkCopy(x1, 1)]);
  const asmShared = assembleSearchGallery([shared, mkHit([mkCopy(x2, 2)]), mkHit([mkCopy(x3, 3)])], mkCopy(x1, 1), ["d"]);
  assert.ok(asmShared, "簇内含点开副本所属源副本 → 该副本条目入画廊");
  assert.deepEqual(asmShared.items.map((i) => i.externalId), ["1", "2", "3"], "多副本簇以所属源副本条目为载体（非代表副本）");
  assert.equal(asmShared.items[0].sourceId, X, "载体条目属点开副本的源");

  /* 图集源形态：detail 多图 → 不组装（宿主维持 detail 图集逐字不变）。 */
  assert.equal(assembleSearchGallery(hits, mkCopy(x2, 3), ["a", "b", "c"]), null, "detail 多图（图集源）→ 不组装");
  /* 同源自带大图不足 2 → 不组装（无可翻之邻）。 */
  const sparse = [mkHit([mkCopy(mkItem(X, "1"), 1)]), mkHit([mkCopy(x2, 2)]), mkHit([mkCopy(y1, 3)])];
  assert.equal(assembleSearchGallery(sparse, mkCopy(x2, 2), ["d"]), null, "同源自带大图条目不足 2 → 不组装、无大图条目不以 preview 充数");
  /* 点开条目不在结果列表的同源副本中 → 不组装、不猜邻帖。 */
  assert.equal(assembleSearchGallery(hits, mkCopy(mkItem(X, "99", "https://cdn.example.com/x-l99.jpg"), 9), ["d"]), null,
    "点开条目不在已加载结果列表 → 不组装");
  /* 同源同条目在两簇重复到达（合并漏网形态）→ 去重、首现位置为准。 */
  const dup = [mkHit([mkCopy(x1, 1)]), mkHit([mkCopy(x2, 2)]), mkHit([mkCopy(x1, 3)]), mkHit([mkCopy(x3, 4)])];
  const asmDup = assembleSearchGallery(dup, mkCopy(x2, 2), ["d"]);
  assert.ok(asmDup, "重复到达不妨碍组装");
  assert.deepEqual(asmDup.items.map((i) => i.externalId), ["1", "2", "3"], "同源同 externalId 只入画廊一次（首现序位）");

  /* 生产接线（调用/渲染形态断言，非符号存在性）：三落点经同一
   * 组装应用点、组装判定吃 detail 原始图集、查看器仍只读
   * data.images 单字段（与 album-chrome 让位条件的同源前提）、
   * 组装成立时标题/收藏随当前条目跟随。 */
  const searchSrc = readFileSync(new URL("./Search.tsx", import.meta.url), "utf8");
  assert.ok(searchSrc.includes("assembleSearchGallery(groups[merged.kind], copy, value.detail?.images ?? [])"),
    "Search 组装判定以当前结果列表（按 kind 分组）为界、吃 detail.images 原值（封面回落不算单图签名）");
  assert.ok(searchSrc.includes("applySearchGallery(merged, got.copy, got.value)"), "openExternal 落点经组装应用点（顺延定出的活副本为界）");
  assert.ok(searchSrc.includes("applySearchGallery(merged, copy, value)"), "manualPick/switchCopy 落点经同一组装应用点");
  assert.ok(searchSrc.includes("galleryItems?: SourceItem[]"), "ExtReady 带画廊条目集字段（组装成立时与 images 一一对应）");
  assert.ok(searchSrc.includes("const images = data.images ?? [];"), "查看器图集仍只读 data.images 单字段（组装图集经同字段交付、让位条件同源覆盖）");
  assert.ok(searchSrc.includes("curItem.title || merged.title"), "组装成立时查看器标题随当前条目跟随（源内宿主同语义）");
  assert.ok(searchSrc.includes("headerAction={galleryItems ? ("), "组装成立时查看器顶栏收藏作用于当前条目；未组装（图集源）不注入、行为逐字不变");
}

console.log("fix330-riban-surfaces (search) contract: ok");
