/**
 * 自检触发面契约（Muse 2026-11-20 fix333/selfcheck-trigger；
 * 本批任务书即维护者对新增测试的授权，AGENTS 不变量 11）：
 * 运行：node src/features/sources/fix333-selfcheck-trigger.contract.test.ts
 *
 * 立项证据（3.3.2 真机验收，用户 2026-11-20 09:25 截图）：分类
 * 总览页 source-009 仍挂「未实测」、source-007 挂「不可用」。
 * 根因是触发面缺口：补探（ensureSourceSelfCheck）此前只挂在三
 * 浏览面（SourceBrowse/SourcePosts/SourceGallery）且只探当前选中
 * 的单个源；用户看状态的地方——分类总览行与切换器——只订阅派
 * 生、从不触发。刚升级（结果指纹含 App 版本、旧结果全失效）或
 * 从未点开过的源，在总览页长期挂「未实测」——正是用户
 * 2026-11-20 01:02 亲口定的核心痛点「未实测长期挂着」未达标。
 *
 * 覆盖：(a) 展示面批量补探 ensureSourcesSelfCheck——结果缺失时
 * 对名单内合格源逐个触发、结果落盘后派生脱离未自检；(b) 调度
 * 节制——串行队列（任一时刻至多 1 个补探在飞）、每源请求不超
 * 既有硬预算、与单源补探共用在飞去重；(c) 结果新鲜/不合格源
 * 零调用（不许无谓重探、不许探未启用/blocked 源）；(d) 指纹
 * 不符（适配器纪元不符）重新补探；(e) 展示面接线以文本断言钉住
 * （Category 总览行/SourceSwitcher 含 React 链不在 node 直导入，
 * 同 fix331 先例）。
 * 不访问真实网络：适配器经注入接缝以假适配器隔离。
 *
 * 断言适配（2026-11-20 fix333/m7-selfcheck）：结果指纹改三维
 * （协议版本/适配器纪元/源切片），夹具改按 def 盖指纹、派生
 * 调用签名收敛为 (结果, def, now)；(d) 的作废形态由「App 已
 * 换代」改「适配器纪元不符」接棒，口径不变、覆盖不降。批量
 * 补探排序（M7）由 fix333-m7-selfcheck 契约承接。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SELF_CHECK_ADAPTER_EPOCH,
  SELF_CHECK_MAX_REQUESTS_PER_SOURCE,
  bindSelfCheckStorage,
  classifySelfCheckResult,
  ensureSourceSelfCheck,
  ensureSourcesSelfCheck,
  getSelfCheckResults,
  reprobeSelfCheckOnListSuccess,
  saveSelfCheckResult,
  selfCheckFingerprintFor,
  type SourceSelfCheckResult,
} from "./healthCheck.ts";
import type { SourceAdapter, SourceDef } from "./types.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
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
    capabilities: { search: true, episodes: false, hevc: false },
    network: { mode: "probe-required" },
    ...over,
  };
}

interface BatchTracker {
  factoryCalls: Map<string, number>;
  calls: Map<string, number>;
  active: number;
  maxActive: number;
}

/** 假适配器：每次方法调用计入并发跟踪（进入 +1、退出 -1），
 * 以便断言批量补探全程串行（maxActive 恒 1）。 */
function trackedAdapter(id: string, t: BatchTracker, gate?: Promise<void>): SourceAdapter {
  const wrap = async <T>(fn: () => T): Promise<T> => {
    t.calls.set(id, (t.calls.get(id) ?? 0) + 1);
    t.active += 1;
    t.maxActive = Math.max(t.maxActive, t.active);
    try {
      if (gate) await gate;
      await sleep(4);
      return fn();
    } finally {
      t.active -= 1;
    }
  };
  return {
    sourceId: id,
    list: () => wrap(() => ({
      items: [{ sourceId: id, externalId: "ext-0", title: "t", cover: "", href: "", tags: [] }],
      pagination: { page: 1, pages: 1, size: 20, total: 1 },
    })),
    detail: (extId) => wrap(() => ({
      sourceId: id, externalId: extId, title: "d", cover: "", href: "", tags: [],
      contentHtml: "<p>正文</p>", images: ["https://x.example/1.jpg"], episodes: [],
    })),
    resolve: () => wrap(() => ({ streams: [{ url: "https://x.example/v.m3u8", kind: "hls" as const }] })),
  };
}

function newTracker(): BatchTracker {
  return { factoryCalls: new Map(), calls: new Map(), active: 0, maxActive: 0 };
}

function factoryFor(t: BatchTracker, gates?: Map<string, Promise<void>>) {
  return (def: SourceDef) => {
    t.factoryCalls.set(def.id, (t.factoryCalls.get(def.id) ?? 0) + 1);
    return trackedAdapter(def.id, t, gates?.get(def.id));
  };
}

function mkResult(def: SourceDef, over: Partial<SourceSelfCheckResult> = {}): SourceSelfCheckResult {
  return {
    sourceId: def.id, at: NOW, listOk: true, itemCount: 5, listFailure: null,
    /* fix335/selfcheck-paging 断言适配：结果格式新增分页抽查两
     * 字段，夹具补齐（口径不变、覆盖不降）。 */
    paging: "skipped", pagingFailure: null,
    detail: "ok", detailFailure: null, requests: 3,
    tail: "ok", tailKind: "stream", tailFailure: null, ...selfCheckFingerprintFor(def),
    ...over,
  };
}

/* ── (a)+(b) 结果缺失：批量补探逐个触发、串行、落盘后脱离未自检 ── */
{
  bindSelfCheckStorage(fakeStorage());
  const vid = fakeDef("t-vid");
  const img = fakeDef("t-img", { kind: "image", category: "image", adapter: { template: "wp-rest" } });
  const post = fakeDef("t-post", { kind: "post", category: "posts", adapter: { template: "chigua" } });
  const t = newTracker();
  const started = await ensureSourcesSelfCheck([vid, img, post], { createAdapterFor: factoryFor(t), now: () => NOW });
  assert.equal(started, 3, "结果缺失时名单内 3 个合格源全部启动补探");
  assert.equal(t.maxActive, 1, "批量补探串行：任一时刻至多 1 个适配器调用在飞（进页面不打满请求）");
  assert.equal(t.calls.get("t-vid"), 3, "视频类全链 3 请求（列表＋详情＋取流）");
  assert.equal(t.calls.get("t-img"), 2, "图片类 2 请求（图集段复用详情响应）");
  assert.equal(t.calls.get("t-post"), 2, "帖子类 2 请求（正文段复用详情响应）");
  const saved = getSelfCheckResults();
  for (const def of [vid, img, post]) {
    const r = saved[def.id];
    assert.ok(r, `${def.id} 补探结果已落盘`);
    assert.ok(r.requests <= SELF_CHECK_MAX_REQUESTS_PER_SOURCE, `${def.id} 不超既有每源硬预算`);
    assert.notEqual(
      classifySelfCheckResult(r, def, NOW).status, "unchecked",
      `${def.id} 落盘后派生脱离未自检（徽标转四态之一，不再长挂未实测）`,
    );
  }
  const again = await ensureSourcesSelfCheck([vid, img, post], { createAdapterFor: factoryFor(t), now: () => NOW });
  assert.equal(again, 0, "补探落盘后结果新鲜、重复挂载零重探");
  bindSelfCheckStorage(null);
}

/* ── (c) 结果新鲜：零调用；不合格源：零调用 ── */
{
  bindSelfCheckStorage(fakeStorage());
  const a = fakeDef("t-fresh-a");
  const b = fakeDef("t-fresh-b");
  saveSelfCheckResult(mkResult(a));
  saveSelfCheckResult(mkResult(b));
  const t = newTracker();
  const started = await ensureSourcesSelfCheck([a, b], { createAdapterFor: factoryFor(t), now: () => NOW });
  assert.equal(started, 0, "结果新鲜时批量补探零启动");
  assert.equal(t.factoryCalls.size, 0, "结果新鲜时适配器工厂零调用（不许无谓重探）");

  const off = fakeDef("t-off", { enabled: false });
  const blocked = fakeDef("t-blocked", { maturity: "blocked" });
  const started2 = await ensureSourcesSelfCheck([off, blocked], { createAdapterFor: factoryFor(t), now: () => NOW });
  assert.equal(started2, 0, "未启用/blocked 源不进批量补探（资格口径与全量计划同源）");
  assert.equal(t.factoryCalls.size, 0, "不合格源适配器工厂零调用");
  bindSelfCheckStorage(null);
}

/* ── (d) 指纹不符（适配器纪元不符）：旧结果判过期、重新补探 ── */
{
  bindSelfCheckStorage(fakeStorage());
  const def = fakeDef("t-upgraded");
  saveSelfCheckResult(mkResult(def, { adapterEpoch: 0 }));
  const t = newTracker();
  const started = await ensureSourcesSelfCheck([def], { createAdapterFor: factoryFor(t), now: () => NOW });
  assert.equal(started, 1, "适配器纪元不符的旧指纹结果在展示面挂载时重新补探（升级场景不再长挂未实测）");
  assert.deepEqual(
    (({ protocolVersion, adapterEpoch, sourceScope }) => ({ protocolVersion, adapterEpoch, sourceScope }))(getSelfCheckResults()["t-upgraded"]),
    selfCheckFingerprintFor(def),
    "补探结果带现行三维指纹",
  );
  bindSelfCheckStorage(null);
}

/* ── (b) 与单源补探共用在飞去重：浏览面在飞的源批量不重复启动 ── */
{
  bindSelfCheckStorage(fakeStorage());
  const a = fakeDef("t-fly-a");
  const b = fakeDef("t-fly-b");
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const gates = new Map([[a.id, gate]]);
  const t = newTracker();
  const single = ensureSourceSelfCheck(a, { createAdapterFor: factoryFor(t, gates), now: () => NOW });
  assert.equal(single, true, "浏览面单源补探先行启动");
  const batchPromise = ensureSourcesSelfCheck([a, b], { createAdapterFor: factoryFor(t, gates), now: () => NOW });
  await sleep(20);
  release();
  const started = await batchPromise;
  assert.equal(started, 1, "批量补探只新启动不在飞的源（在飞源跳过、不重复探）");
  assert.equal(t.factoryCalls.get(a.id), 1, "在飞源适配器工厂只调用一次（共用同一去重集）");
  assert.equal(t.factoryCalls.get(b.id), 1, "其余源正常补探");
  await sleep(20);
  assert.ok(getSelfCheckResults()["t-fly-a"], "单源补探结果照常落盘");
  assert.ok(getSelfCheckResults()["t-fly-b"], "批量补探结果照常落盘");
  bindSelfCheckStorage(null);
}

/* ── (e) 展示面接线文本断言 ── */
{
  const hooks = read("./sourceHealth.ts");
  assert.ok(hooks.includes("ensureSourcesSelfCheck"), "展示面批量补探走 healthCheck 统一入口（不另起调度）");
  assert.ok(hooks.includes("useSourceSelfCheckOnShow"), "展示面补探钩子在位");

  const category = read("../category/Category.tsx");
  assert.ok(category.includes("useSourceSelfCheckOnShow"), "分类总览挂载时对展示行源触发批量补探");

  const switcher = read("./SourceSwitcher.tsx");
  assert.ok(switcher.includes("useSourceSelfCheckOnShow"), "源切换器挂载时对展示选项源触发批量补探（频道页/帖子页经切换器覆盖）");

  for (const rel of ["./SourcePosts.tsx", "./SourceGallery.tsx"]) {
    assert.ok(read(rel).includes("useSourceSelfCheckOnView"), `${rel} 浏览面单源补探保持在位（本批不改浏览面）`);
  }
}

/* ── (f) 真实成功推翻旧失败结论（fix337/008-detail；3.3.6 真机
 * 定案，设备导出摘录 fix337/evidence/device-export-336-analysis.md）：
 * 3.3.5 时段的自检失败结论（008/009/010/011/016，时间戳 18:24/
 * 18:35）被带进 3.3.6 继续展示——取页形态已变（诚实 UA）而指纹
 * 未失效、且新会话取页成功 13 次也不推翻落盘结论。两点机制修：
 * ①纪元口径补正：纪元 2 时代（≤3.3.6）的结论一律判过期——取页
 * 链形态变更（UA/指纹层）与适配器行为同列入纪元覆盖面；
 * ②成功推翻：浏览面真实 list 成功而落盘结论为列表段失败时，
 * 立即强制补探一次（结论仍只由探针产生、不拿浏览结果改写；
 * 探针再失败则失败结论如实保留）。 */
{
  /* ① 纪元 2 的旧结论：时间再新也判过期（旧码纪元即 2 → 此断言红）。 */
  bindSelfCheckStorage(fakeStorage());
  const legacy = fakeDef("t-legacy-epoch");
  const staleCore = classifySelfCheckResult(mkResult(legacy, { adapterEpoch: 2 }), legacy, NOW);
  assert.equal(staleCore.stale, true, "纪元 2 时代结论不得再判新鲜（取页形态已变、旧失败结论不许冒充现行结论）");
  assert.ok(SELF_CHECK_ADAPTER_EPOCH > 2, "现行纪元已越过 2（fix336 取页形态变更的补 bump）");
  bindSelfCheckStorage(null);

  /* ② 新鲜的 down 结论：常规补探不触发（新鲜口径），成功推翻触发并翻正。 */
  bindSelfCheckStorage(fakeStorage());
  const def = fakeDef("t-contradicted", { kind: "image", category: "image", adapter: { template: "wp-rest" } });
  saveSelfCheckResult(mkResult(def, {
    listOk: false, itemCount: 0, listFailure: "网络类", detail: "skipped", tail: "skipped",
  }));
  assert.equal(classifySelfCheckResult(getSelfCheckResults()[def.id], def, NOW).status, "down", "夹具前提：落盘结论为不可用");
  const t = newTracker();
  assert.equal(ensureSourceSelfCheck(def, { createAdapterFor: factoryFor(t), now: () => NOW }), false,
    "结论尚新鲜时常规补探不启动（旧机制下该错误结论只能等 24h TTL——本症状的成因之一）");
  assert.equal(t.factoryCalls.size, 0, "常规补探零调用（对照组）");
  assert.equal(reprobeSelfCheckOnListSuccess(def, { createAdapterFor: factoryFor(t), now: () => NOW }), true,
    "浏览面真实 list 成功撞上落盘 down 结论 → 强制补探立即启动（不等过期）");
  for (let i = 0; i < 50 && !getSelfCheckResults()[def.id]?.listOk; i++) await sleep(20);
  assert.equal(getSelfCheckResults()[def.id]?.listOk, true, "补探后结论翻正（徽标/发现维度禁用随单一派生即时恢复）");
  assert.equal(classifySelfCheckResult(getSelfCheckResults()[def.id], def, NOW).status, "ok", "派生回到可用");

  /* 对照：结论已可用时成功信号不引发任何补探。 */
  const callsBefore = t.factoryCalls.get(def.id) ?? 0;
  assert.equal(reprobeSelfCheckOnListSuccess(def, { createAdapterFor: factoryFor(t), now: () => NOW }), false,
    "结论已可用 → 成功推翻不启动（不无谓重探）");
  assert.equal(t.factoryCalls.get(def.id) ?? 0, callsBefore, "已可用时适配器工厂零新增调用");

  /* 对照：无落盘结论时不归本通道（缺失走常规补探口径）。 */
  const unseen = fakeDef("t-unseen");
  assert.equal(reprobeSelfCheckOnListSuccess(unseen, { createAdapterFor: factoryFor(t), now: () => NOW }), false,
    "无落盘结论 → 不归成功推翻通道");

  /* 对照：探针复核仍失败时结论如实保留（不拿一次浏览成功冒充可用）。 */
  const down = fakeDef("t-still-down", { kind: "image", category: "image", adapter: { template: "wp-rest" } });
  saveSelfCheckResult(mkResult(down, {
    listOk: false, itemCount: 0, listFailure: "网络类", detail: "skipped", tail: "skipped",
  }));
  const failingFactory = (d: SourceDef): SourceAdapter => ({
    sourceId: d.id,
    list: async () => { throw new Error("fetch failed: network unreachable"); },
    detail: async () => { throw new Error("unreachable"); },
    resolve: async () => ({ streams: [] }),
  });
  assert.equal(reprobeSelfCheckOnListSuccess(down, { createAdapterFor: failingFactory, now: () => NOW }), true,
    "down 结论＋成功信号 → 复核补探启动");
  await sleep(200); // 复核探针为即时失败形态，落盘在毫秒级；留足余量防慢机抖动
  assert.equal(getSelfCheckResults()[down.id]?.listOk, false, "复核仍失败 → 失败结论如实保留（推翻只认探针复核结果）");
  bindSelfCheckStorage(null);

  /* 接线：三浏览面 list 成功点位统一经 sourceHealth 的成功信号口。 */
  const hooks = read("./sourceHealth.ts");
  assert.ok(hooks.includes("reprobeSelfCheckOnListSuccess"), "sourceHealth 成功信号口走 healthCheck 统一推翻入口");
  assert.ok(hooks.includes("noteSourceListSuccess"), "浏览面成功信号口在位");
  for (const rel of ["./SourcePosts.tsx", "./SourceGallery.tsx"]) {
    assert.ok(read(rel).includes("noteSourceListSuccess"), `${rel} list 成功后发成功信号（自检误报跨频道同治）`);
  }
}

console.log("fix333-selfcheck-trigger.contract: all assertions passed");
