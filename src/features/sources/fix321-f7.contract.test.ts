/**
 * 3.2.1 修复 F7 线契约测试（Muse 2026-11-19 fix321-F7；本批任务书
 * 即维护者对新增测试的授权，AGENTS 不变量 11）：
 * 运行：node src/features/sources/fix321-f7.contract.test.ts
 * 覆盖：(a) 调度注册——自检调度在启动装配（main.tsx）被注册、且
 * 经注入定时器断言启动延迟与单次注册语义；(b) 结果进诊断——喂入
 * 假自检结果，registryDiag 实际消费的自检行构建器
 * （selfCheckDiagLines/selfCheckSegmentText）输出含该源自检行与
 * 失败形态，registryDiag 两条呈现路径文本接线；(c) 预算/资格——
 * 未启用/blocked/preview 源不进探测名单、结果未过期不重探、每源
 * 请求数 ≤ SELF_CHECK_MAX_REQUESTS_PER_SOURCE（硬预算 2）。
 * 不访问真实网络：适配器经注入接缝（createAdapterFor）以假适配器
 * 隔离；registryDiag.ts 本体不在 node 直导入（其 fetchHealth→
 * playbackDiagnostics 链含 Tauri/react 导入，为既有约束），其消费
 * 的自检行构建器在此直测、接线以文本断言钉住（同 final-d 先例）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "./registry.ts";
import { SourceParseEmptyError } from "./adapters/templates.ts";
import {
  SELF_CHECK_MAX_REQUESTS_PER_SOURCE,
  SELF_CHECK_START_DELAY_MS,
  SELF_CHECK_STORAGE_KEY,
  SELF_CHECK_TTL_MS,
  bindSelfCheckStorage,
  buildSelfCheckPlan,
  getSelfCheckResults,
  runSelfCheckRound,
  runSourceSelfCheck,
  saveSelfCheckResult,
  selfCheckDiagLines,
  selfCheckEligible,
  selfCheckFailureKind,
  selfCheckSegmentText,
  startSourceSelfCheckScheduler,
  type SourceSelfCheckResult,
} from "./healthCheck.ts";
import type { SourceAdapter, SourceDef } from "./types.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
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
    capabilities: { search: true, episodes: false, hevc: false, comments: false },
    network: { mode: "probe-required" },
    ...over,
  };
}

function fakeAdapter(behavior: { listItems?: number; listError?: unknown; detailError?: unknown }, counter: { calls: number }): SourceAdapter {
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
      return { sourceId: "fake", externalId: id, title: "d", cover: "", href: "", tags: [], images: [], episodes: [] };
    },
    async resolve() { return { streams: [] }; },
  };
}

/* ── (c) 资格：未启用/blocked/preview/无适配器模板不进名单 ── */
{
  const plan = buildSelfCheckPlan(getBuiltinRegistry(), {}, NOW);
  const ids = plan.map((s) => s.id);
  /* 断言适配（3.2.2 瘦身）：名单收口到保留集（91video/swag/jabletv/
   * missav 已摘除注册表），资格口径不变。 */
  for (const id of ["huangguo", "hanime-tv", "rule34video", "pornpics"]) {
    assert.ok(ids.includes(id), `已启用源 ${id} 在自检名单`);
  }
  for (const id of ["hanime1", "iwara"]) {
    assert.ok(!ids.includes(id), `未启用源 ${id} 不进自检名单`);
  }
  /* 集成适配（3.3.0 接通批）：xiuren/danbooru/meiridasai 均已解 blocked
   * 改判 probe 进自检名单（见下方 fix330 定级源断言），「blocked 不进
   * 名单」改由合成 blocked def 承接（口径不变、覆盖不降）。 */
  {
    const blockedClone = { ...getBuiltinRegistry().find((s) => s.id === "huangguo")!, maturity: "blocked" as const };
    const blockedPlan = buildSelfCheckPlan([blockedClone], {}, NOW);
    assert.ok(!blockedPlan.some((s) => s.id === "huangguo"), "blocked 源不进自检名单（blocked 本就不拉数据）");
    assert.ok(ids.includes("meiridasai"), "meiridasai 已解 blocked 进自检名单（3.3.0 吃瓜线）");
  }  /* 断言适配（fix330 图片线，2026-11-19）：xiuren（xiuren.biz 四级
   * 全通）与 danbooru（住宅四级全通翻案）已解 blocked 改判 probe，
   * pixibb/nudecosplay 已实证启用——四源按资格口径进自检名单；
   * 「blocked 不探测」由 meiridasai 接棒（同 51chigua 先例）。 */
  for (const id of ["xiuren", "danbooru", "pixibb", "nudecosplay"]) {
    assert.ok(ids.includes(id), `fix330 定级源 ${id} 进自检名单`);
  }
  // 契约适配（基础设施批集成，2026-11-19）：51chigua 已被 fix321-F2b 解 blocked
  // （换现行域名 51cg1.com、maturity=probe、enabled=true），不再属 blocked 名单；
  // 原断言保护的「blocked 不探测」由上面两源接棒，本行改验解封后的新事实。
  // 3.3.0 接通批续适配：meiridasai 同理（换 mrds66、probe、enabled）进自检名单。
  assert.ok(ids.includes("51chigua"), "51chigua 已解 blocked（F2b），进自检名单");
  assert.ok(ids.includes("meiridasai"), "meiridasai 已解 blocked（3.3.0 接通批），进自检名单");
  /* myfans 已于 3.2.2 瘦身摘除：注册表内已无 preview 源，preview
   * 排除口径由下方合成 def 断言接棒（覆盖不降）。 */
  assert.equal(selfCheckEligible(fakeDef("x", { maturity: "preview" })), false, "preview 成熟度不合格");
  assert.equal(selfCheckEligible(fakeDef("x", { adapter: { template: "none" } })), false, "无适配器模板不合格");
  assert.equal(selfCheckEligible(fakeDef("x", { adapter: { template: "preview-only" } })), false, "preview-only 模板不合格");
  assert.equal(selfCheckEligible(fakeDef("x")), true, "已启用普通源合格");
}

/* ── (c) 频率上限：结果未过期（TTL 内）不重探、过期才重探 ── */
{
  const fresh: SourceSelfCheckResult = {
    sourceId: "hanime-tv", at: NOW - 1000, listOk: true, itemCount: 3,
    listFailure: null, detail: "ok", detailFailure: null, requests: 2,
  };
  const stale = { ...fresh, at: NOW - SELF_CHECK_TTL_MS - 1 };
  assert.ok(!buildSelfCheckPlan(getBuiltinRegistry(), { "hanime-tv": fresh }, NOW).some((s) => s.id === "hanime-tv"), "TTL 内不重探");
  assert.ok(buildSelfCheckPlan(getBuiltinRegistry(), { "hanime-tv": stale }, NOW).some((s) => s.id === "hanime-tv"), "过期后重探");
}

/* ── (c) 预算：每源最多 2 请求（列表 1＋详情 1），失败形态分开记 ── */
{
  assert.equal(SELF_CHECK_MAX_REQUESTS_PER_SOURCE, 2, "硬预算常量 = 2");
  const def = fakeDef("budget");

  const c1 = { calls: 0 };
  const ok = await runSourceSelfCheck(def, { createAdapterFor: () => fakeAdapter({ listItems: 3 }, c1), now: () => NOW });
  assert.equal(ok.listOk, true, "列表成功");
  assert.equal(ok.itemCount, 3, "记条目数");
  assert.equal(ok.detail, "ok", "有条目再探详情、可达");
  assert.equal(ok.requests, 2, "成功路径恰用 2 请求");
  assert.ok(c1.calls <= SELF_CHECK_MAX_REQUESTS_PER_SOURCE, "适配器调用不超硬预算");

  const c2 = { calls: 0 };
  const empty = await runSourceSelfCheck(def, { createAdapterFor: () => fakeAdapter({ listItems: 0 }, c2), now: () => NOW });
  assert.equal(empty.listOk, true, "结构化真空列表算成功");
  assert.equal(empty.detail, "skipped", "无条目不探详情");
  assert.equal(empty.requests, 1, "真空只用 1 请求");

  const c3 = { calls: 0 };
  const parseEmpty = await runSourceSelfCheck(def, { createAdapterFor: () => fakeAdapter({ listError: new SourceParseEmptyError("budget") }, c3), now: () => NOW });
  assert.equal(parseEmpty.listOk, false, "解析为空记列表失败");
  assert.equal(parseEmpty.listFailure, "解析为空", "解析为空与 SourceParseEmptyError 对齐");
  assert.equal(parseEmpty.detail, "skipped", "列表失败不探详情");
  assert.equal(parseEmpty.requests, 1, "列表失败只用 1 请求");

  const httpFail = await runSourceSelfCheck(def, { createAdapterFor: () => fakeAdapter({ listError: new Error("HTTP 状态 503") }, { calls: 0 }), now: () => NOW });
  assert.equal(httpFail.listFailure, "HTTP 状态", "HTTP 状态与 classifyFetchError 口径对齐");

  const netFail = await runSourceSelfCheck(def, { createAdapterFor: () => fakeAdapter({ listError: new Error("dns 解析失败 connect 不可达") }, { calls: 0 }), now: () => NOW });
  assert.equal(netFail.listFailure, "网络类", "网络类与 classifyFetchError 的网络不可达对齐");

  const detailFail = await runSourceSelfCheck(def, { createAdapterFor: () => fakeAdapter({ listItems: 2, detailError: new Error("boom") }, { calls: 0 }), now: () => NOW });
  assert.equal(detailFail.listOk, true, "详情失败不翻列表结论");
  assert.equal(detailFail.detail, "fail", "详情失败单独记");
  assert.equal(detailFail.detailFailure, "详情失败", "详情步未分类错误记详情失败形态");
  assert.equal(detailFail.requests, 2, "详情失败路径仍 ≤2 请求");

  assert.equal(selfCheckFailureKind(new SourceParseEmptyError("x"), "list"), "解析为空", "分类纯函数：解析为空");
  assert.equal(selfCheckFailureKind(new Error("请求超时 timeout"), "list"), "网络类", "分类纯函数：超时归网络类");
}

/* ── 落盘：hghubx_* 键、重启后可读回（注入存储模拟重启） ── */
{
  assert.ok(SELF_CHECK_STORAGE_KEY.startsWith("hghubx_"), "落盘键为 hghubx_*（不变量 7）");
  const storage = fakeStorage();
  bindSelfCheckStorage(storage);
  const r: SourceSelfCheckResult = {
    sourceId: "swag", at: NOW, listOk: false, itemCount: 0,
    listFailure: "解析为空", detail: "skipped", detailFailure: null, requests: 1,
  };
  saveSelfCheckResult(r);
  assert.ok(storage.map.has(SELF_CHECK_STORAGE_KEY), "结果写入落盘键");
  bindSelfCheckStorage(null);
  bindSelfCheckStorage(storage); // 重绑同一存储 = 模拟进程重启后读盘
  const back = getSelfCheckResults();
  assert.equal(back.swag?.listFailure, "解析为空", "重启后自检结果仍可读");
  assert.equal(back.swag?.at, NOW, "最近自检时间落盘");
  bindSelfCheckStorage(null);
}

/* ── (b) 结果进诊断：自检行含稳定编号、最近自接口径与失败形态 ── */
{
  const sources = [
    { id: "huangguo", stableId: "source-001" },
    { id: "swag", stableId: "source-013" },
    { id: "91video", stableId: "source-003" },
  ];
  const results: Record<string, SourceSelfCheckResult> = {
    swag: { sourceId: "swag", at: NOW, listOk: false, itemCount: 0, listFailure: "解析为空", detail: "skipped", detailFailure: null, requests: 1 },
    huangguo: { sourceId: "huangguo", at: NOW, listOk: true, itemCount: 12, listFailure: null, detail: "ok", detailFailure: null, requests: 2 },
  };
  const lines = selfCheckDiagLines(sources, results);
  const joined = lines.join("\n");
  assert.ok(joined.includes("最近自检"), "自检行标注最近自检口径（与本会话取页分开）");
  assert.ok(joined.includes("source-013"), "失败源以稳定编号出自检行");
  assert.ok(joined.includes("解析为空"), "自检行含失败形态");
  assert.ok(joined.includes("source-001"), "成功源同样出自检行");
  assert.ok(joined.includes("未自检 1"), "无结果源计入未自检（不冒充未发生）");
  const seg = selfCheckSegmentText(results.swag);
  assert.ok(seg.includes("最近自检") && seg.includes("解析为空"), "App 内明细段含口径与失败形态");
  const diag = read("./registryDiag.ts");
  assert.ok(diag.includes("selfCheckDiagLines("), "导出路径 sourceHealthLines 消费自检行构建器");
  assert.ok(diag.includes("selfCheckSegmentText("), "App 内明细路径消费自检段构建器");
  assert.ok(diag.includes("getSelfCheckResults("), "registryDiag 读落盘自检结果");
}

/* ── (a) 调度注册：启动装配注册＋延迟/单次语义 ── */
{
  const main = read("../../main.tsx");
  assert.ok(main.includes("startSourceSelfCheckScheduler"), "main.tsx 启动装配注册自检调度");
  assert.ok(main.includes("createAdapter"), "main.tsx 注入生产适配器工厂（走 createAdapter 生产路径）");

  const storage = fakeStorage();
  const timerBox: { fn: (() => void) | null; ms: number } = { fn: null, ms: -1 };
  const deps = {
    getSources: () => [fakeDef("sched-a"), fakeDef("sched-b")],
    createAdapterFor: () => fakeAdapter({ listItems: 1 }, { calls: 0 }),
    now: () => NOW,
    storage,
    delay: async () => {},
    setTimeoutFn: (fn: () => void, ms: number) => { timerBox.fn = fn; timerBox.ms = ms; return 0; },
  };
  assert.equal(startSourceSelfCheckScheduler(deps), true, "首次注册成功");
  assert.ok(timerBox.fn, "调度经注入定时器登记");
  assert.equal(timerBox.ms, SELF_CHECK_START_DELAY_MS, "启动延迟 = 常量口径");
  assert.ok(SELF_CHECK_START_DELAY_MS >= 60_000, "启动延迟 ≥60s（不抢占启动与首屏取页）");
  assert.equal(startSourceSelfCheckScheduler(deps), false, "重复注册被单次门拦下");
  timerBox.fn();
  await new Promise((r) => setTimeout(r, 20));
  const saved = JSON.parse(storage.map.get(SELF_CHECK_STORAGE_KEY) ?? "{}") as Record<string, SourceSelfCheckResult>;
  assert.ok(saved["sched-a"] && saved["sched-b"], "定时器到期后一轮自检落盘");
}

/* ── 一轮调度：分片错峰（片间有 delay 调用）、单源异常不拖垮整轮 ── */
{
  const storage = fakeStorage();
  let delays = 0;
  const defs = Array.from({ length: 7 }, (_, i) => fakeDef(`round-${i}`));
  const res = await runSelfCheckRound({
    getSources: () => defs,
    createAdapterFor: (d: SourceDef) => fakeAdapter(d.id === "round-3" ? { listError: new Error("connect 不可达") } : { listItems: 1 }, { calls: 0 }),
    now: () => NOW,
    storage,
    delay: async () => { delays += 1; },
  });
  assert.equal(res.checked, 7, "一轮全量 7 源");
  assert.ok(delays >= 1, "分片之间有错峰间隔（7 源 > 单片上限）");
  const saved = JSON.parse(storage.map.get(SELF_CHECK_STORAGE_KEY) ?? "{}") as Record<string, SourceSelfCheckResult>;
  assert.equal(Object.keys(saved).length, 7, "失败源同样落盘（观测不处置）");
  assert.equal(saved["round-3"].listFailure, "网络类", "轮内失败源记网络类");
  assert.equal(saved["round-0"].listOk, true, "单源失败不拖垮整轮其余源");
}

console.log("fix321-f7.contract: all assertions passed");
