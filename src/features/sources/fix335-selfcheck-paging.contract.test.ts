/**
 * fix335 自检语义扩展线契约（Muse 2026-11-20；本批任务书即维护者
 * 对新增测试的授权，AGENTS 不变量 11）：
 * 运行：node src/features/sources/fix335-selfcheck-paging.contract.test.ts
 *
 * 立项：自检此前只验列表第 1 页＋详情＋品类末段——分页信号说谎
 * （信号称有下一页、第 2 页却与第 1 页全同/不可达/为空）时列表段
 * 照样全绿，用户实际翻页才撞见。本线给自检加一轮「分页信号一致
 * 性抽查」：第 1 页信号（Paged.pagination.pages，与三套 UI 停拉
 * 判据同一黑盒口径）称有下一页时，多取第 2 页一页，要求可达、
 * 非空、且与第 1 页条目集不全同；失败落结果新段 paging 并经单
 * 一派生 classifySelfCheckResult 降级为部分可用（段名「分页」），
 * 进诊断逐源行；信号称单页的源标「不适用」（na），不冒充通过、
 * 也不多取页。协议变更配套：每源硬预算 3→4（多取的恰是这 1
 * 页）、SELF_CHECK_PROTOCOL_VERSION 1→2（旧结果按指纹不符判过
 * 期补探；落盘旧结果缺 paging 字段读入归一为 skipped）。
 *
 * 覆盖：(a) 信号说谎三形态（全同/不可达/空页）新码标失败＋派生
 * 降级＋诊断行；(b) 正常多页与部分重叠（置顶类合法重复）通过；
 * (c) 单页不适用且不多取页、列表失败跳过抽查；(d) 预算与请求
 * 计数（视频全链＋抽查＝4、posts 复用详情＝3）；(e) 落盘归一
 * （现行格式缺字段/旧两维格式迁移均归一 skipped、新格式往返
 * 保真）。基线（@5ca59ca）红：结果无 paging 段、引擎不取第 2
 * 页、预算常量为 3。
 * 不访问真实网络：适配器经注入接缝以脚本化假适配器隔离。
 * 断言适配（2026-11-21 fix339/probe-fidelity）：协议 v3 取流段
 * 加清单实拉、硬预算 4→5、SELF_CHECK_PROTOCOL_VERSION 2→3，
 * (d) 两常量断言随之改判；本文件假适配器不注入 probeManifest
 * 接缝、引擎维持 resolve-only 口径，各计数断言（视频全链＋抽
 * 查＝4 等）不变；覆盖不降，实拉段口径由 fix339-probe-fidelity
 * 契约承接。
 * 断言适配（2026-11-21 fix3310/file-playback-leg）：协议 v4 取
 * 流实拉按 kind 分支、SELF_CHECK_PROTOCOL_VERSION 3→4，(d)
 * 协议常量断言随之改判；硬预算仍 5、各计数断言不变；覆盖不
 * 降，file 分支口径由 fix3310-file-probe 契约承接。
 */
import assert from "node:assert/strict";
import {
  SELF_CHECK_MAX_REQUESTS_PER_SOURCE,
  SELF_CHECK_PROTOCOL_VERSION,
  bindSelfCheckStorage,
  classifySelfCheckResult,
  getSelfCheckResults,
  runSourceSelfCheck,
  saveSelfCheckResult,
  selfCheckDiagLines,
  selfCheckSegmentText,
  sourceHealthBadgeText,
  type SourceSelfCheckResult,
} from "./healthCheck.ts";
import { getActiveRegistry, getRegistryInfo } from "./manifest.ts";
import type { SourceAdapter, SourceDef } from "./types.ts";

const NOW = 1_700_000_000_000;

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
  };
}

function fakeDef(id: string, over: Partial<SourceDef> = {}): SourceDef {
  return {
    id, displayName: id, kind: "video", category: "video",
    adapter: { template: "hls-site" }, baseUrls: [`https://${id}.example`],
    enabled: true, order: 1, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false },
    network: { mode: "probe-required" },
    ...over,
  };
}

interface PagingScript {
  /** 第 1 页条目 externalId 列。 */
  p1: string[];
  /** 第 1 页信号声称的总页数（pagination.pages）。 */
  signalPages: number;
  /** 第 2 页结局：条目列，或抛错。 */
  p2?: string[] | Error;
  listError?: unknown;
  detailHtml?: string;
}

/** 脚本化假适配器：list 按页号回放脚本并记录取页序。 */
function pagingAdapter(script: PagingScript, counter: { calls: number; listPages: number[] }): SourceAdapter {
  const item = (externalId: string) => ({
    sourceId: "fake", externalId, title: `t-${externalId}`, cover: "", href: "", tags: [],
  });
  return {
    sourceId: "fake",
    async list(page: number) {
      counter.calls += 1;
      counter.listPages.push(page);
      if (script.listError) throw script.listError;
      if (page === 1) {
        return {
          items: script.p1.map(item),
          pagination: { page: 1, pages: script.signalPages, size: 20, total: script.p1.length },
        };
      }
      if (script.p2 instanceof Error) throw script.p2;
      const ids = script.p2 ?? [];
      return {
        items: ids.map(item),
        pagination: { page, pages: Math.max(1, script.signalPages), size: 20, total: ids.length },
      };
    },
    async detail(id: string) {
      counter.calls += 1;
      return {
        sourceId: "fake", externalId: id, title: "d", cover: "", href: "", tags: [],
        contentHtml: script.detailHtml, images: ["https://x.example/1.jpg"], episodes: [],
      };
    },
    async resolve() {
      counter.calls += 1;
      return { streams: [{ url: "https://x.example/v.m3u8", kind: "hls" as const }] };
    },
  };
}

const newCounter = () => ({ calls: 0, listPages: [] as number[] });

/* ── (a) 信号说谎·全同：第 2 页与第 1 页条目集全同 → 失败＋降级 ── */
{
  const def = fakeDef("liar-same");
  const c = newCounter();
  const r = await runSourceSelfCheck(def, {
    createAdapterFor: () => pagingAdapter({ p1: ["a", "b", "c"], signalPages: 5, p2: ["a", "b", "c"] }, c),
    now: () => NOW,
  });
  assert.deepEqual(c.listPages, [1, 2], "信号称有下一页时抽查恰多取第 2 页一页");
  assert.equal(r.paging, "fail", "第 2 页全同＝信号说谎/分页失效，抽查标失败");
  assert.equal(r.pagingFailure, "其他", "全同非取页错误形态，记其他");
  assert.equal(r.listOk, true, "抽查失败不翻列表结论");
  assert.equal(r.detail, "ok", "抽查失败不阻断详情段");
  assert.equal(r.tail, "ok", "抽查失败不阻断末段");
  assert.equal(r.requests, 4, "视频全链＋分页抽查恰 4 次适配器调用");
  assert.ok(c.calls <= SELF_CHECK_MAX_REQUESTS_PER_SOURCE, "不超硬预算");

  const core = classifySelfCheckResult(r, def, NOW);
  assert.equal(core.status, "partial", "分页抽查失败派生部分可用、不再全绿");
  assert.equal(core.segment, "分页", "部分可用注明死段＝分页");
  assert.equal(core.failure, "其他", "派生带抽查失败形态");
  assert.notEqual(core.status, "down", "分页失败不派生不可用（F 线 DiscoveryBar 只认 down 禁用，口径不误伤）");
  assert.equal(sourceHealthBadgeText(def, r, NOW), "部分可用", "徽标读派生：部分可用");

  assert.ok(selfCheckSegmentText(r).includes("分页抽查失败"), "自检段含分页抽查失败明示");
  const lines = selfCheckDiagLines([{ id: def.id, stableId: "source-101", def }], { [def.id]: r }, NOW);
  assert.ok(lines[0].includes("部分可用 1"), "诊断汇总按派生计部分可用");
  assert.ok(lines[1].includes("分页抽查失败"), "诊断逐源行含分页抽查失败");
}

/* ── (a) 信号说谎·不可达：第 2 页抛错 → 失败，形态与取页分类同源 ── */
{
  const def = fakeDef("liar-down");
  const c = newCounter();
  const r = await runSourceSelfCheck(def, {
    createAdapterFor: () => pagingAdapter({ p1: ["a", "b"], signalPages: 3, p2: new Error("HTTP 状态 503") }, c),
    now: () => NOW,
  });
  assert.equal(r.paging, "fail", "第 2 页不可达抽查标失败");
  assert.equal(r.pagingFailure, "HTTP 状态", "第 2 页失败形态与 classifyFetchError 口径对齐");
  assert.equal(r.requests, 4, "抽查抛错仍计入调用数（列表＋抽查＋详情＋取流）");
  assert.ok(selfCheckSegmentText(r).includes("分页抽查失败·HTTP 状态"), "自检段含抽查失败形态");
}

/* ── (a) 信号说谎·空页：第 2 页可达但为空 → 失败 ── */
{
  const def = fakeDef("liar-empty");
  const c = newCounter();
  const r = await runSourceSelfCheck(def, {
    createAdapterFor: () => pagingAdapter({ p1: ["a", "b"], signalPages: 3, p2: [] }, c),
    now: () => NOW,
  });
  assert.equal(r.paging, "fail", "信号称有下一页而第 2 页为空，抽查标失败");
  assert.equal(r.pagingFailure, "解析为空", "空页记解析为空形态");
  assert.equal(classifySelfCheckResult(r, def, NOW).status, "partial", "空页派生部分可用");
}

/* ── (b) 正常多页：第 2 页有新条目 → 通过；部分重叠不算全同 ── */
{
  const def = fakeDef("multi");
  const c = newCounter();
  const r = await runSourceSelfCheck(def, {
    createAdapterFor: () => pagingAdapter({ p1: ["a", "b", "c"], signalPages: 9, p2: ["d", "e"] }, c),
    now: () => NOW,
  });
  assert.equal(r.paging, "ok", "第 2 页可达非空且有新条目，抽查通过");
  assert.equal(r.pagingFailure, null, "通过无失败形态");
  assert.equal(classifySelfCheckResult(r, def, NOW).status, "ok", "全链＋抽查通派生可用");
  assert.equal(r.requests, 4, "正常多页同样恰多取 1 页");

  const c2 = newCounter();
  const overlap = await runSourceSelfCheck(def, {
    createAdapterFor: () => pagingAdapter({ p1: ["a", "b", "c"], signalPages: 9, p2: ["c", "d"] }, c2),
    now: () => NOW,
  });
  assert.equal(overlap.paging, "ok", "第 2 页部分重叠（置顶类合法重复）＋有新条目，不算全同");
}

/* ── (c) 单页源：标不适用、不多取页、不冒充通过 ── */
{
  const def = fakeDef("single");
  const c = newCounter();
  const r = await runSourceSelfCheck(def, {
    createAdapterFor: () => pagingAdapter({ p1: ["a", "b"], signalPages: 1 }, c),
    now: () => NOW,
  });
  assert.equal(r.paging, "na", "信号称单页，抽查标不适用");
  assert.deepEqual(c.listPages, [1], "不适用不多取第 2 页");
  assert.equal(r.requests, 3, "不适用不耗抽查调用（视频全链仍 3）");
  assert.equal(classifySelfCheckResult(r, def, NOW).status, "ok", "单页源全链通仍派生可用（不适用不降级）");
  assert.ok(selfCheckSegmentText(r).includes("分页抽查不适用"), "自检段如实标注不适用、不冒充通过");
}

/* ── (c) 列表失败：抽查跳过、不取第 2 页 ── */
{
  const def = fakeDef("list-dead");
  const c = newCounter();
  const r = await runSourceSelfCheck(def, {
    createAdapterFor: () => pagingAdapter({ p1: [], signalPages: 5, listError: new Error("connect 不可达") }, c),
    now: () => NOW,
  });
  assert.equal(r.listOk, false, "列表失败照旧");
  assert.equal(r.paging, "skipped", "列表失败无从抽查，标跳过");
  assert.deepEqual(c.listPages, [1], "列表失败不取第 2 页");
  assert.equal(r.requests, 1, "列表失败只用 1 次调用");
}

/* ── (d) posts 类：抽查多取 1 页、正文段复用详情不另发 ── */
{
  const def = fakeDef("posts-multi", { kind: "post", category: "posts", adapter: { template: "chigua" } });
  const c = newCounter();
  const r = await runSourceSelfCheck(def, {
    createAdapterFor: () => pagingAdapter({ p1: ["a"], signalPages: 4, p2: ["b"], detailHtml: "<p>正文</p>" }, c),
    now: () => NOW,
  });
  assert.equal(r.paging, "ok", "posts 类抽查通过");
  assert.equal(r.tail, "ok", "正文段照旧复用详情响应");
  assert.equal(r.requests, 3, "posts 类＝列表＋抽查＋详情恰 3 次调用");
}

/* ── (d) 预算常量与协议版本 ── */
{
  assert.equal(SELF_CHECK_MAX_REQUESTS_PER_SOURCE, 5, "硬预算 = 5（列表＋分页抽查＋详情＋取流解析＋清单实拉）");
  assert.equal(SELF_CHECK_PROTOCOL_VERSION, 5, "自检协议 v5＝全链＋分页抽查＋取流实拉按 kind 分支＋file 探针多步加固口径（fix3311 适配）");
}

/* ── (e) 落盘归一：旧结果缺 paging 字段读入归一 skipped、新格式往返保真 ── */
{
  const storage = fakeStorage();
  const def = fakeDef("stored");
  const v1Shape = {
    sourceId: "stored", at: NOW, listOk: true, itemCount: 2, listFailure: null,
    detail: "ok", detailFailure: null, tail: "ok", tailKind: "stream", tailFailure: null,
    protocolVersion: 1, adapterEpoch: 2, sourceScope: "fnv1a:whatever", requests: 3,
  };
  storage.map.set("hghubx_source_selfcheck_v1", JSON.stringify({ stored: v1Shape }));
  bindSelfCheckStorage(storage);
  const loaded = getSelfCheckResults().stored;
  assert.ok(loaded, "现行格式旧结果（协议 v1）读入不丢弃");
  assert.equal(loaded.paging, "skipped", "缺 paging 字段读入归一为 skipped（未抽查过）");
  assert.equal(loaded.pagingFailure, null, "缺 pagingFailure 归一为 null");
  assert.equal(classifySelfCheckResult(loaded, def, NOW).stale, true, "协议 v1 结果按指纹不符判过期、待补探刷新");

  const fresh: SourceSelfCheckResult = {
    sourceId: "stored", at: NOW, listOk: true, itemCount: 2, listFailure: null,
    detail: "ok", detailFailure: null, tail: "ok", tailKind: "stream", tailFailure: null,
    paging: "fail", pagingFailure: "其他",
    protocolVersion: SELF_CHECK_PROTOCOL_VERSION, adapterEpoch: 2, sourceScope: "fnv1a:whatever", requests: 4,
  };
  saveSelfCheckResult(fresh);
  bindSelfCheckStorage(null);
  bindSelfCheckStorage(storage);
  const back = getSelfCheckResults().stored;
  assert.equal(back?.paging, "fail", "新格式结果落盘往返 paging 保真");
  assert.equal(back?.pagingFailure, "其他", "新格式结果落盘往返 pagingFailure 保真");
  bindSelfCheckStorage(null);
}

/* ── (e) 旧两维指纹格式迁移：paging 归一 skipped、不冒充抽查过 ── */
{
  const storage = fakeStorage();
  const activeDef = getActiveRegistry().sources.find((s) => s.id === "xiuren")!;
  const legacy = {
    sourceId: "xiuren", at: NOW, listOk: true, itemCount: 5, listFailure: null,
    detail: "ok", detailFailure: null, requests: 3,
    tail: "ok", tailKind: "stream", tailFailure: null,
    manifestVersion: getActiveRegistry().manifestVersion, appVersion: getRegistryInfo().appVersion,
  };
  storage.map.set("hghubx_source_selfcheck_v1", JSON.stringify({ "xiuren": legacy }));
  bindSelfCheckStorage(storage);
  const migrated = getSelfCheckResults()["xiuren"];
  assert.ok(migrated, "旧两维格式结果迁移保留（同 App∧同清单口径不变）");
  assert.equal(migrated.paging, "skipped", "迁移结果 paging 归一 skipped（旧口径未抽查）");
  assert.equal(migrated.pagingFailure, null, "迁移结果 pagingFailure 归一 null");
  assert.ok(activeDef, "注册表样本在位");
  bindSelfCheckStorage(null);
}

console.log("fix335-selfcheck-paging.contract: all assertions passed");
