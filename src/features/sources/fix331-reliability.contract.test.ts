/**
 * 源可靠性单一派生契约（Muse 2026-11-20 fix331/source-reliability；
 * 本批任务书即维护者对新增测试的授权，AGENTS 不变量 11）：
 * 运行：node src/features/sources/fix331-reliability.contract.test.ts
 *
 * 立项证据（设备数据，判读 ~/workspace/hghub/fix331/evidence/
 * device-diag-331-analysis.md）：① 3.3.1 真机会话（00:53–01:06）
 * 内自检零刷新，结果最近一条 23:42、source-002 的失败停在 21:49
 * 旧抓页路线时代——陈旧结果无标注地冒充现状；② 本会话真实发生
 * 的 source-002 取流段 403 在整份诊断里零记录——自检只探列表＋
 * 详情、「可用」不覆盖用户真正用的取流段。
 *
 * 覆盖：(a) 探活补全链——视频类详情后抽 1 条目续探取流（只取流
 * 不播放）、posts 类正文段与 image 类图集段复用详情响应判定，
 * 每源请求 ≤ 硬预算 3；(b) 旧格式结果（无末段/无版本指纹）
 * 落盘读入即丢弃，不许冒充已检；(c) 四态派生＋徽标文案逐一对号
 * （全链通／取流段死／从未探／已过期／清单版本已变／App 已换代／
 * 列表即死）；
 * (d) 补探触发——结果缺失/过期/版本不符才补、补完即新鲜不再补、
 * 在飞去重；(e) 诊断行组按四态计数；(f) 展示面/浏览面/诊断归属
 * 的接线以文本断言钉住（registryDiag/SourceSwitcher 含 React/
 * Tauri 链不在 node 直导入，同 final-d 先例）。
 * 不访问真实网络：适配器经注入接缝以假适配器隔离。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SELF_CHECK_MAX_REQUESTS_PER_SOURCE,
  SELF_CHECK_TTL_MS,
  bindSelfCheckStorage,
  buildSelfCheckPlan,
  classifySelfCheckResult,
  ensureSourceSelfCheck,
  getSelfCheckResults,
  runSourceSelfCheck,
  saveSelfCheckResult,
  selfCheckDiagLines,
  selfCheckNeedsProbe,
  sourceHealthBadgeText,
  type SourceSelfCheckResult,
} from "./healthCheck.ts";
import { getActiveRegistry, getRegistryInfo } from "./manifest.ts";
import type { SourceAdapter, SourceDef } from "./types.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const NOW = 1_700_000_000_000;
const MV = getActiveRegistry().manifestVersion;
const AV = getRegistryInfo().appVersion;

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
    capabilities: { search: true, episodes: false, hevc: false, comments: false },
    network: { mode: "probe-required" },
    ...over,
  };
}

interface FakeBehavior {
  listItems?: number;
  listError?: unknown;
  detailError?: unknown;
  detailHtml?: string;
  detailImages?: string[];
  resolveError?: unknown;
  resolveStreams?: number;
}

function fakeAdapter(behavior: FakeBehavior, counter: { calls: number; resolveCalls: number }): SourceAdapter {
  return {
    sourceId: "fake",
    async list() {
      counter.calls += 1;
      if (behavior.listError) throw behavior.listError;
      const n = behavior.listItems ?? 0;
      return {
        items: Array.from({ length: n }, (_, i) => ({
          sourceId: "fake", externalId: `ext-${i}`, title: `t${i}`, cover: "", href: "", tags: [],
        })),
        pagination: { page: 1, pages: 1, size: 20, total: n },
      };
    },
    async detail(id) {
      counter.calls += 1;
      if (behavior.detailError) throw behavior.detailError;
      return {
        sourceId: "fake", externalId: id, title: "d", cover: "", href: "", tags: [],
        contentHtml: behavior.detailHtml, images: behavior.detailImages ?? [], episodes: [],
      };
    },
    async resolve() {
      counter.calls += 1;
      counter.resolveCalls += 1;
      if (behavior.resolveError) throw behavior.resolveError;
      const n = behavior.resolveStreams ?? 1;
      return { streams: Array.from({ length: n }, () => ({ url: "https://x.example/v.m3u8", kind: "hls" as const })) };
    },
  };
}

function mkResult(over: Partial<SourceSelfCheckResult> = {}): SourceSelfCheckResult {
  return {
    sourceId: "s", at: NOW, listOk: true, itemCount: 5, listFailure: null,
    detail: "ok", detailFailure: null, requests: 3,
    tail: "ok", tailKind: "stream", tailFailure: null, manifestVersion: MV, appVersion: AV,
    ...over,
  };
}

/* ── (a) 探活补全链：视频类取流段 ── */
{
  const def = fakeDef("vid");
  const c = { calls: 0, resolveCalls: 0 };
  const ok = await runSourceSelfCheck(def, { createAdapterFor: () => fakeAdapter({ listItems: 2 }, c), now: () => NOW });
  assert.equal(c.resolveCalls, 1, "视频类详情可达后续探 1 次取流（抽样 1 条目）");
  assert.equal(ok.tail, "ok", "取流有流记末段可达");
  assert.equal(ok.tailKind, "stream", "视频类末段＝取流");
  assert.equal(ok.requests, 3, "全链通用满 3 请求（列表＋详情＋取流）");
  assert.ok(ok.requests <= SELF_CHECK_MAX_REQUESTS_PER_SOURCE, "不超硬预算");
  assert.equal(ok.manifestVersion, MV, "结果带清单版本指纹");
  assert.equal(ok.appVersion, AV, "结果带 App 版本指纹");

  const c403 = { calls: 0, resolveCalls: 0 };
  const dead = await runSourceSelfCheck(def, {
    createAdapterFor: () => fakeAdapter({ listItems: 2, resolveError: new Error("HTTP 状态 403") }, c403),
    now: () => NOW,
  });
  assert.equal(dead.listOk, true, "取流失败不翻列表结论");
  assert.equal(dead.detail, "ok", "取流失败不翻详情结论");
  assert.equal(dead.tail, "fail", "取流段单独记失败（002 式 403 不再零记录）");
  assert.equal(dead.tailFailure, "HTTP 状态", "取流失败形态与取页分类同源");

  const cEmpty = { calls: 0, resolveCalls: 0 };
  const noStream = await runSourceSelfCheck(def, {
    createAdapterFor: () => fakeAdapter({ listItems: 2, resolveStreams: 0 }, cEmpty),
    now: () => NOW,
  });
  assert.equal(noStream.tail, "fail", "取流返回零流＝末段失败（无可用流不可播）");
  assert.equal(noStream.tailFailure, "取流失败", "零流记取流失败形态");

  const cDetail = { calls: 0, resolveCalls: 0 };
  const detailDead = await runSourceSelfCheck(def, {
    createAdapterFor: () => fakeAdapter({ listItems: 2, detailError: new Error("boom") }, cDetail),
    now: () => NOW,
  });
  assert.equal(detailDead.tail, "skipped", "详情失败不续探取流");
  assert.equal(cDetail.resolveCalls, 0, "详情失败时取流零请求");
  assert.equal(detailDead.requests, 2, "详情失败路径只用 2 请求");
}

/* ── (a) 探活补全链：posts 正文段／image 图集段（复用详情响应） ── */
{
  const posts = fakeDef("post", { kind: "post", category: "posts", adapter: { template: "chigua" } });
  const c1 = { calls: 0, resolveCalls: 0 };
  const bodyOk = await runSourceSelfCheck(posts, {
    createAdapterFor: () => fakeAdapter({ listItems: 1, detailHtml: "<p>正文</p>" }, c1),
    now: () => NOW,
  });
  assert.equal(bodyOk.tailKind, "body", "posts 类末段＝正文");
  assert.equal(bodyOk.tail, "ok", "详情带正文 HTML 记正文可达");
  assert.equal(bodyOk.requests, 2, "正文段复用详情响应、不另发请求");
  assert.equal(c1.resolveCalls, 0, "posts 类不调取流");

  const c2 = { calls: 0, resolveCalls: 0 };
  const bodyDead = await runSourceSelfCheck(posts, {
    createAdapterFor: () => fakeAdapter({ listItems: 1, detailHtml: "" }, c2),
    now: () => NOW,
  });
  assert.equal(bodyDead.detail, "ok", "详情可达不翻");
  assert.equal(bodyDead.tail, "fail", "详情可达但正文为空＝正文段失败");
  assert.equal(bodyDead.tailFailure, "解析为空", "正文为空记解析为空形态");

  const image = fakeDef("img", { kind: "image", category: "image", adapter: { template: "wp-rest" } });
  const c3 = { calls: 0, resolveCalls: 0 };
  const galOk = await runSourceSelfCheck(image, {
    createAdapterFor: () => fakeAdapter({ listItems: 1, detailImages: ["https://x.example/1.jpg"] }, c3),
    now: () => NOW,
  });
  assert.equal(galOk.tailKind, "gallery", "image 类末段＝图集");
  assert.equal(galOk.tail, "ok", "详情带图记图集可达");
  const c4 = { calls: 0, resolveCalls: 0 };
  const galDead = await runSourceSelfCheck(image, {
    createAdapterFor: () => fakeAdapter({ listItems: 1, detailImages: [] }, c4),
    now: () => NOW,
  });
  assert.equal(galDead.tail, "fail", "详情可达但图集为空＝图集段失败");
}

/* ── (b) 旧格式结果读入即丢弃 ── */
{
  const storage = fakeStorage();
  storage.map.set("hghubx_source_selfcheck_v1", JSON.stringify({
    legacy: {
      sourceId: "legacy", at: NOW, listOk: true, itemCount: 3, listFailure: null,
      detail: "ok", detailFailure: null, requests: 2,
    },
  }));
  bindSelfCheckStorage(storage);
  const loaded = getSelfCheckResults();
  assert.equal(loaded.legacy, undefined, "旧格式结果（无末段/无版本指纹）读入即丢弃、不冒充已检");
  assert.equal(classifySelfCheckResult(loaded.legacy, NOW, MV, AV).status, "unchecked", "丢弃后派生为未自检");
  bindSelfCheckStorage(null);
}

/* ── (c) 四态派生＋徽标逐一对号 ── */
{
  const probeDef = fakeDef("probe-src");
  const stableDef = fakeDef("stable-src", { maturity: "stable" });

  const full = mkResult();
  const coreFull = classifySelfCheckResult(full, NOW, MV, AV);
  assert.equal(coreFull.status, "ok", "全链通（列表/详情/取流）派生可用");
  assert.equal(coreFull.stale, false, "新鲜结果不标过期");
  assert.equal(sourceHealthBadgeText(probeDef, full, NOW, MV, AV), undefined, "可用源不挂徽标（与 stable 既有口径一致）");

  const streamDead = mkResult({ tail: "fail", tailFailure: "HTTP 状态" });
  const coreStream = classifySelfCheckResult(streamDead, NOW, MV, AV);
  assert.equal(coreStream.status, "partial", "取流段死派生部分可用（不再全绿）");
  assert.equal(coreStream.segment, "取流", "部分可用注明死段＝取流");
  assert.equal(sourceHealthBadgeText(probeDef, streamDead, NOW, MV, AV), "部分可用", "徽标读派生：部分可用");

  const bodyDead = mkResult({ tailKind: "body", tail: "fail", tailFailure: "解析为空" });
  assert.equal(classifySelfCheckResult(bodyDead, NOW, MV, AV).segment, "正文", "posts 死段注明正文");

  const listDead = mkResult({ listOk: false, listFailure: "网络类", detail: "skipped", tail: "skipped" });
  const coreDown = classifySelfCheckResult(listDead, NOW, MV, AV);
  assert.equal(coreDown.status, "down", "列表即死派生不可用");
  assert.equal(sourceHealthBadgeText(probeDef, listDead, NOW, MV, AV), "不可用", "徽标读派生：不可用");

  assert.equal(classifySelfCheckResult(undefined, NOW, MV, AV).status, "unchecked", "无结果派生未自检");
  assert.equal(sourceHealthBadgeText(probeDef, undefined, NOW, MV, AV), "未实测", "从未探过回落静态 maturity：probe→未实测");
  assert.equal(sourceHealthBadgeText(stableDef, undefined, NOW, MV, AV), undefined, "从未探过回落静态 maturity：stable→无徽标");

  const stale = mkResult({ at: NOW - SELF_CHECK_TTL_MS - 1 });
  const coreStale = classifySelfCheckResult(stale, NOW, MV, AV);
  assert.equal(coreStale.status, "ok", "过期结果底层结论仍是可用");
  assert.equal(coreStale.stale, true, "超 24h 标已过期、不冒充新鲜");
  assert.equal(sourceHealthBadgeText(probeDef, stale, NOW, MV, AV), "已过期", "过期可用源徽标明示已过期");

  const wrongVersion = mkResult({ manifestVersion: MV + 99 });
  assert.equal(classifySelfCheckResult(wrongVersion, NOW, MV, AV).stale, true, "清单版本已变标已过期（热改域名后旧结果不冒充）");

  const oldApp = mkResult({ appVersion: "0.0.0-old" });
  assert.equal(classifySelfCheckResult(oldApp, NOW, MV, AV).stale, true, "App 已换代标已过期（旧抓页路线时代的结果不冒充现行结论）");
  assert.equal(selfCheckNeedsProbe(probeDef, { "probe-src": oldApp }, NOW, MV, AV), true, "App 版本不符要补探");

  const emptyList = mkResult({ itemCount: 0, detail: "skipped", tail: "skipped", requests: 1 });
  assert.equal(classifySelfCheckResult(emptyList, NOW, MV, AV).status, "partial", "列表真空深段无从验证派生部分可用、不冒充全通");
}

/* ── (d) 补探触发口径 ── */
{
  const def = fakeDef("topup");
  const fresh = mkResult({ sourceId: "topup" });
  assert.equal(selfCheckNeedsProbe(def, { topup: fresh }, NOW, MV, AV), false, "新鲜结果不补探");
  assert.equal(selfCheckNeedsProbe(def, {}, NOW, MV, AV), true, "无结果要补探");
  assert.equal(selfCheckNeedsProbe(def, { topup: { ...fresh, at: NOW - SELF_CHECK_TTL_MS - 1 } }, NOW, MV, AV), true, "过期要补探");
  assert.equal(selfCheckNeedsProbe(def, { topup: { ...fresh, manifestVersion: MV + 1 } }, NOW, MV, AV), true, "清单版本不符要补探");
  assert.equal(selfCheckNeedsProbe(fakeDef("off", { enabled: false }), {}, NOW, MV, AV), false, "未启用源不补探");
  assert.ok(!buildSelfCheckPlan([def], { topup: fresh }, NOW).some((s) => s.id === "topup"), "全量计划同口径：新鲜不进名单");
  assert.ok(buildSelfCheckPlan([def], { topup: { ...fresh, manifestVersion: MV + 1 } }, NOW).some((s) => s.id === "topup"), "全量计划同口径：版本不符进名单");

  const storage = fakeStorage();
  bindSelfCheckStorage(storage);
  const c = { calls: 0, resolveCalls: 0 };
  const started = ensureSourceSelfCheck(def, { createAdapterFor: () => fakeAdapter({ listItems: 1 }, c), now: () => NOW });
  assert.equal(started, true, "进入浏览面且结果缺失 → 启动单源补探");
  const dup = ensureSourceSelfCheck(def, { createAdapterFor: () => fakeAdapter({ listItems: 1 }, c), now: () => NOW });
  assert.equal(dup, false, "补探在飞时不重复启动");
  await new Promise((r) => setTimeout(r, 30));
  const saved = getSelfCheckResults().topup;
  assert.ok(saved && saved.tail === "ok", "补探完成落盘（含取流段）");
  const again = ensureSourceSelfCheck(def, { createAdapterFor: () => fakeAdapter({ listItems: 1 }, c), now: () => NOW });
  assert.equal(again, false, "补探后结果新鲜、不再补探");
  bindSelfCheckStorage(null);
}

/* ── (e) 诊断行组按四态计数 ── */
{
  const sources = [
    { id: "a", stableId: "source-001" },
    { id: "b", stableId: "source-002" },
    { id: "c", stableId: "source-003" },
  ];
  const results: Record<string, SourceSelfCheckResult> = {
    a: mkResult({ sourceId: "a" }),
    b: mkResult({ sourceId: "b", tail: "fail", tailFailure: "HTTP 状态" }),
  };
  const lines = selfCheckDiagLines(sources, results, NOW, MV, AV);
  const joined = lines.join("\n");
  assert.ok(joined.includes("可用 1"), "诊断汇总按派生计可用");
  assert.ok(joined.includes("部分可用 1"), "诊断汇总按派生计部分可用（取流死不再计通过）");
  assert.ok(joined.includes("未自检 1"), "诊断汇总计未自检");
  assert.ok(joined.includes("source-002") && joined.includes("取流失败"), "部分可用源逐源行含死段");
}

/* ── (f) 接线文本断言 ── */
{
  const diag = read("./registryDiag.ts");
  assert.ok(diag.includes("selfCheckEligible"), "导出路径自检分母按资格过滤（未启用不入未自检分母）");
  assert.ok(diag.includes("templateFetchOrigins"), "诊断取页归属按全部 baseUrls∪模板 origin 认领（C④）");
  assert.ok(diag.includes("selfCheckStatusText"), "App 内明细健康状态读同一派生");

  const switcher = read("./SourceSwitcher.tsx");
  assert.ok(switcher.includes("sourceHealthBadgeText"), "源切换器徽标读同一派生");
  assert.ok(switcher.includes("useSourceHealthResults"), "源切换器订阅自检结果（补探完成即刷新）");

  const category = read("../category/Category.tsx");
  assert.ok(category.includes("sourceHealthBadgeText"), "分类总览源行徽标读同一派生");

  for (const rel of ["./SourceBrowse.tsx", "./SourcePosts.tsx", "./SourceGallery.tsx"]) {
    assert.ok(read(rel).includes("useSourceSelfCheckOnView"), `${rel} 进入浏览面触发补探`);
  }

  const hooks = read("./sourceHealth.ts");
  assert.ok(hooks.includes("useSyncExternalStore"), "展示面经订阅消费自检结果");
  assert.ok(hooks.includes("ensureSourceSelfCheck"), "浏览面补探走 healthCheck 统一入口");
}

console.log("fix331-reliability.contract: all assertions passed");
