/**
 * 自检补探排序＋指纹分维度契约（Muse 2026-11-20 fix333/m7-selfcheck；
 * 本批任务书即维护者对新增测试的授权，AGENTS 不变量 11）：
 * 运行：node src/features/sources/fix333-m7-selfcheck.contract.test.ts
 *
 * 立项证据：① M7 补探排序——3.3.2 真机升级后总览一次排 14 个
 * 串行补探、靠后源徽标刷新最晚（fix333 集成报告残余 8）；批量
 * 补探此前只按注册表序，用户正在看的选中源与最近打开过的源
 * 不优先。② M9 指纹分维度——自检指纹此前＝清单版本＋App 版本
 * 两维：纯 UI/文案更新（App 版本必变）与清单无关变更（清单版
 * 本必变）都会全量作废已有结果，2026-11-20 09:29 真机「未实
 * 测」虚惊即其代价（GPT 全面审查采纳项）。
 *
 * 覆盖：(a) 批量补探排序——选中源最先、最近打开过的源次之
 * （时刻倒序）、未打开过的按注册表序；只重排启动序，串行
 * （maxActive=1）与每源 ≤3 请求预算不变；(b) 最近打开记录——
 * recordSourceView 落盘、重绑存储（模拟重启）后可读回且能驱动
 * 批量排序；(c) 指纹三维——引擎结果带协议版本/适配器纪元/源
 * 切片指纹；切片只认适配器相关字段（模板/基址/生效参数/品类/
 * 取页模式），显示名/备注/注册表序等非适配器字段变化不作废、
 * 切片内字段变化作废；协议/纪元不符作废并触发补探；(d) 旧指
 * 纹迁移——全链旧格式结果（清单版本＋App 版本）首次读入按新
 * 口径逐条判定：同 App 版本∧同清单版本者迁移为现行指纹、保
 * 持新鲜；任一不符者迁移为永不命中的哨兵指纹——判过期但不丢
 * 弃（派生状态仍在、只缀已过期）。
 * 不访问真实网络：适配器经注入接缝以假适配器隔离。
 */
import assert from "node:assert/strict";
import {
  SELF_CHECK_ADAPTER_EPOCH,
  SELF_CHECK_MAX_REQUESTS_PER_SOURCE,
  SELF_CHECK_PROTOCOL_VERSION,
  SOURCE_LAST_VIEW_STORAGE_KEY,
  bindSelfCheckStorage,
  classifySelfCheckResult,
  ensureSourcesSelfCheck,
  getSelfCheckResults,
  getSourceLastViewed,
  orderTopUpCandidates,
  recordSourceView,
  runSourceSelfCheck,
  saveSelfCheckResult,
  selfCheckFingerprintFor,
  selfCheckNeedsProbe,
  selfCheckSourceScope,
  type SourceSelfCheckResult,
} from "./healthCheck.ts";
import { getActiveRegistry, getRegistryInfo } from "./manifest.ts";
import { getBuiltinRegistry } from "./registry.ts";
import type { SourceAdapter, SourceDef } from "./types.ts";

const NOW = 1_700_000_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

interface Tracker { startOrder: string[]; calls: Map<string, number>; active: number; maxActive: number }

function trackedFactory(t: Tracker) {
  return (def: SourceDef): SourceAdapter => {
    t.startOrder.push(def.id);
    const wrap = async <T>(fn: () => T): Promise<T> => {
      t.calls.set(def.id, (t.calls.get(def.id) ?? 0) + 1);
      t.active += 1;
      t.maxActive = Math.max(t.maxActive, t.active);
      try { await sleep(2); return fn(); } finally { t.active -= 1; }
    };
    return {
      sourceId: def.id,
      list: () => wrap(() => ({
        items: [{ sourceId: def.id, externalId: "ext-0", title: "t", cover: "", href: "", tags: [] }],
        pagination: { page: 1, pages: 1, size: 20, total: 1 },
      })),
      detail: (extId) => wrap(() => ({
        sourceId: def.id, externalId: extId, title: "d", cover: "", href: "", tags: [],
        contentHtml: "<p>正文</p>", images: ["https://x.example/1.jpg"], episodes: [],
      })),
      resolve: () => wrap(() => ({ streams: [{ url: "https://x.example/v.m3u8", kind: "hls" as const }] })),
    };
  };
}

function newTracker(): Tracker {
  return { startOrder: [], calls: new Map(), active: 0, maxActive: 0 };
}

/* ── (a) 批量补探排序：选中 > 最近打开（时刻倒序）> 未打开（注册表序） ── */
{
  const sel = fakeDef("m-sel", { order: 9 });
  const recentOld = fakeDef("m-recent-old", { order: 1 });
  const recentNew = fakeDef("m-recent-new", { order: 2 });
  const neverA = fakeDef("m-never-a", { order: 3 });
  const neverB = fakeDef("m-never-b", { order: 4 });
  const input = [neverB, recentOld, sel, neverA, recentNew];
  const viewed = { "m-recent-old": NOW - 5000, "m-recent-new": NOW - 1000 };

  const ordered = orderTopUpCandidates(input, { selectedId: "m-sel", lastViewedAt: viewed });
  assert.deepEqual(ordered.map((d) => d.id), ["m-sel", "m-recent-new", "m-recent-old", "m-never-a", "m-never-b"],
    "纯函数排序：选中最先、最近打开倒序、未打开按注册表序");
  const noSel = orderTopUpCandidates(input, { lastViewedAt: viewed });
  assert.deepEqual(noSel.map((d) => d.id), ["m-recent-new", "m-recent-old", "m-never-a", "m-never-b", "m-sel"],
    "无选中源时最近打开仍优先、其余按注册表序（m-sel 注册表序最末）");

  bindSelfCheckStorage(fakeStorage());
  const t = newTracker();
  const started = await ensureSourcesSelfCheck(input, {
    createAdapterFor: trackedFactory(t), now: () => NOW,
    selectedId: "m-sel", lastViewedAt: viewed,
  });
  assert.equal(started, 5, "名单内 5 个合格源全部启动补探");
  assert.deepEqual(t.startOrder, ["m-sel", "m-recent-new", "m-recent-old", "m-never-a", "m-never-b"],
    "批量补探启动序按排序口径（选中源不等注册表序轮到它）");
  assert.equal(t.maxActive, 1, "排序不改串行节制：任一时刻至多 1 个补探在飞");
  for (const def of input) {
    const r = getSelfCheckResults()[def.id];
    assert.ok(r && r.requests <= SELF_CHECK_MAX_REQUESTS_PER_SOURCE, `${def.id} 不超既有每源硬预算`);
  }
  bindSelfCheckStorage(null);
}

/* ── (b) 最近打开记录：落盘、重启可读回、驱动排序 ── */
{
  const storage = fakeStorage();
  bindSelfCheckStorage(storage);
  recordSourceView("m-view-a", NOW - 2000);
  recordSourceView("m-view-b", NOW - 1000);
  assert.ok(storage.map.has(SOURCE_LAST_VIEW_STORAGE_KEY), "打开记录写入 hghubx_* 落盘键");
  assert.equal(getSourceLastViewed()["m-view-a"], NOW - 2000, "记录可读回");
  bindSelfCheckStorage(null);
  bindSelfCheckStorage(storage); // 重绑同一存储 = 模拟进程重启
  assert.equal(getSourceLastViewed()["m-view-b"], NOW - 1000, "重启后打开记录仍可读（驱动升级后首轮排序）");

  const a = fakeDef("m-view-a", { order: 8 });
  const b = fakeDef("m-view-b", { order: 7 });
  const t = newTracker();
  const started = await ensureSourcesSelfCheck([a, b], { createAdapterFor: trackedFactory(t), now: () => NOW });
  assert.equal(started, 2, "两源均需补探");
  assert.deepEqual(t.startOrder, ["m-view-b", "m-view-a"], "未注入排序上下文时按落盘打开记录排序（最近打开在前）");
  bindSelfCheckStorage(null);
}

/* ── (c) 指纹三维：切片只认适配器相关字段、协议/纪元独立作废 ── */
{
  const def = fakeDef("m-fp");
  const c = { calls: 0 };
  const adapter: SourceAdapter = {
    sourceId: def.id,
    async list() {
      c.calls += 1;
      return {
        items: [{ sourceId: def.id, externalId: "ext-0", title: "t", cover: "", href: "", tags: [] }],
        pagination: { page: 1, pages: 1, size: 20, total: 1 },
      };
    },
    async detail(id) {
      c.calls += 1;
      return { sourceId: def.id, externalId: id, title: "d", cover: "", href: "", tags: [], contentHtml: "<p>x</p>", images: [], episodes: [] };
    },
    async resolve() { c.calls += 1; return { streams: [{ url: "https://x.example/v.m3u8", kind: "hls" as const }] }; },
  };
  const r = await runSourceSelfCheck(def, { createAdapterFor: () => adapter, now: () => NOW });
  assert.equal(r.protocolVersion, SELF_CHECK_PROTOCOL_VERSION, "结果带自检协议版本指纹");
  assert.equal(r.adapterEpoch, SELF_CHECK_ADAPTER_EPOCH, "结果带适配器纪元指纹");
  assert.equal(r.sourceScope, selfCheckSourceScope(def), "结果带该源适配器切片指纹");
  assert.deepEqual(selfCheckFingerprintFor(def), {
    protocolVersion: SELF_CHECK_PROTOCOL_VERSION, adapterEpoch: SELF_CHECK_ADAPTER_EPOCH, sourceScope: r.sourceScope,
  }, "指纹派生三维齐全");
  assert.equal(classifySelfCheckResult(r, def, NOW).stale, false, "现行指纹结果新鲜");

  /* 纯 UI/文案类变更：显示名、备注、注册表序都不进指纹——不作废。 */
  const relabeled: SourceDef = { ...def, displayName: "新显示名", note: "新备注文案", order: 42 };
  assert.equal(selfCheckSourceScope(relabeled), r.sourceScope, "显示名/备注/注册表序不进切片指纹");
  assert.equal(classifySelfCheckResult(r, relabeled, NOW).stale, false, "纯文案/展示变更后结果保留（UI 更新不全量重探）");
  assert.equal(selfCheckNeedsProbe(relabeled, { [def.id]: r }, NOW), false, "纯文案变更不触发补探");

  /* 切片内变更：基址/生效参数/模板任一变 → 作废。 */
  const moved: SourceDef = { ...def, baseUrls: ["https://moved.example"] };
  assert.equal(classifySelfCheckResult(r, moved, NOW).stale, true, "该源基址变更（清单热改）后旧结果作废");
  assert.equal(selfCheckNeedsProbe(moved, { [def.id]: r }, NOW), true, "基址变更触发补探");
  const reparametrized: SourceDef = { ...def, adapter: { template: "hls-site", params: { listPath: "/new?page={page}" } } };
  assert.equal(classifySelfCheckResult(r, reparametrized, NOW).stale, true, "该源生效参数变更（清单热下发）后旧结果作废");
  const retemplated: SourceDef = { ...def, adapter: { template: "wp-rest" } };
  assert.equal(classifySelfCheckResult(r, retemplated, NOW).stale, true, "该源模板变更后旧结果作废");

  /* 协议/纪元变更：全量作废（适配器版本变后失效形态）。 */
  const epochNext: SourceSelfCheckResult = { ...r, adapterEpoch: SELF_CHECK_ADAPTER_EPOCH + 1 };
  assert.equal(classifySelfCheckResult(epochNext, def, NOW).stale, true, "适配器纪元不符标已过期（适配器改版后旧结果不冒充）");
  assert.equal(selfCheckNeedsProbe(def, { [def.id]: epochNext }, NOW), true, "纪元不符触发补探");
  const protoNext: SourceSelfCheckResult = { ...r, protocolVersion: SELF_CHECK_PROTOCOL_VERSION + 1 };
  assert.equal(classifySelfCheckResult(protoNext, def, NOW).stale, true, "自检协议版本不符标已过期（探测口径变更后旧结果不冒充）");
}

/* ── (d) 旧指纹迁移：逐条按新口径判定去留、不无条件全丢 ── */
{
  const activeDef = getBuiltinRegistry().find((s) => s.id === "hanime-tv")!;
  const MV = getActiveRegistry().manifestVersion;
  const AV = getRegistryInfo().appVersion;
  const legacyBase = {
    at: NOW, listOk: true, itemCount: 5, listFailure: null,
    detail: "ok", detailFailure: null, requests: 3,
    tail: "ok", tailKind: "stream", tailFailure: null,
  };
  const storage = fakeStorage();
  storage.map.set("hghubx_source_selfcheck_v1", JSON.stringify({
    "hanime-tv": { sourceId: "hanime-tv", ...legacyBase, manifestVersion: MV, appVersion: AV },
    "gone-app": { sourceId: "gone-app", ...legacyBase, manifestVersion: MV, appVersion: "0.0.0-old" },
    "gone-manifest": { sourceId: "gone-manifest", ...legacyBase, manifestVersion: MV + 99, appVersion: AV },
  }));
  bindSelfCheckStorage(storage);
  const loaded = getSelfCheckResults();

  const kept = loaded["hanime-tv"];
  assert.ok(kept, "同 App 版本∧同清单版本的旧结果迁移后保留、不丢弃");
  assert.equal(kept.protocolVersion, SELF_CHECK_PROTOCOL_VERSION, "迁移：协议版本按现行全链口径认定");
  assert.equal(kept.adapterEpoch, SELF_CHECK_ADAPTER_EPOCH, "迁移：同 App 版本＝同一适配器代码、纪元按现行认定");
  assert.equal(kept.sourceScope, selfCheckSourceScope(activeDef), "迁移：同清单版本＝切片未变、按现行 def 认定");
  assert.equal(classifySelfCheckResult(kept, activeDef, NOW).stale, false, "迁移后保持新鲜（UI 更新后结果保留形态）");
  assert.equal(selfCheckNeedsProbe(activeDef, loaded, NOW), false, "迁移保留的结果不触发无谓补探");

  const goneApp = loaded["gone-app"];
  assert.ok(goneApp, "App 版本不符的旧结果不丢弃（仍出派生、只判过期）");
  assert.equal(goneApp.adapterEpoch, 0, "迁移：App 版本不符→纪元哨兵 0（永不命中现行纪元）");
  const goneAppCore = classifySelfCheckResult(goneApp, activeDef, NOW);
  assert.equal(goneAppCore.status, "ok", "不符旧结果的底层结论仍在（全链通）");
  assert.equal(goneAppCore.stale, true, "不符旧结果判已过期、不冒充新鲜");

  const goneManifest = loaded["gone-manifest"];
  assert.ok(goneManifest, "清单版本不符的旧结果不丢弃");
  assert.equal(goneManifest.sourceScope, "", "迁移：清单版本不符→切片哨兵空串（无法证明该源切片未变）");
  assert.equal(classifySelfCheckResult(goneManifest, activeDef, NOW).stale, true, "清单不符旧结果判已过期");

  /* 迁移结果随下一次落盘以新格式写回（存储里不再留旧指纹）。 */
  saveSelfCheckResult({ ...kept, at: NOW });
  const stored = JSON.parse(storage.map.get("hghubx_source_selfcheck_v1") ?? "{}") as Record<string, Record<string, unknown>>;
  assert.equal(stored["hanime-tv"].protocolVersion, SELF_CHECK_PROTOCOL_VERSION, "写回后存储为新指纹格式");
  assert.equal(stored["hanime-tv"].appVersion, undefined, "写回后旧 App 版本指纹字段退役");
  bindSelfCheckStorage(null);
}

console.log("fix333-m7-selfcheck.contract: all assertions passed");
