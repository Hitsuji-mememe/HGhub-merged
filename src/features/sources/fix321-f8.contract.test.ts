/**
 * 3.2.1 修复 F8 线契约测试（Muse 2026-11-19 fix321-F8；本批任务书
 * 即维护者对新增测试的授权，AGENTS 不变量 11）：
 * 运行：node src/features/sources/fix321-f8.contract.test.ts
 * 覆盖：① schema 校验——合法 adapterParams 过、危险形态/类型错只丢
 * 该条目参数（整份清单与 enabled/baseUrls 覆盖照常）、条目级
 * minAppVersion 门；② 应用生效——生效 def 的 adapter.params 被清单
 * 参数覆盖、非 hls-site 源参数被忽略、参数不改 enabled/maturity；
 * ③ 回滚——注入自检接缝：应用后变坏→回滚内置＋rejected 落盘、同
 * 版本不再重复应用；应用后自检通过→保留并记 applied。
 * 不访问上游网络：清单经 validateManifest/applyManifest 直喂、自检
 * 经注入接缝（runCheck）以假结果隔离。
 * （原 ④ 故障分类与诊断段文本两节随其两构建器于 fix334 清扫
 * 修复线按清扫裁定一并删除——两者自 fix334/L4 死面删除后无生
 * 产消费者、靠本契约自测续命，与 M20 同口径处置。）
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyManifest, validateManifest } from "./manifest.ts";
import { getBuiltinRegistry } from "./registry.ts";
import {
  ADAPTER_PARAMS_STORAGE_KEY,
  bindAdapterParamsStorage,
  fingerprintParams,
  getAdapterParamsState,
  validateAdapterParams,
  verifyAppliedAdapterParams,
} from "./adapterParams.ts";
import { selfCheckFingerprintFor, type SourceSelfCheckResult } from "./healthCheck.ts";
import type { SourceDef } from "./types.ts";

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

function hlsDef(id: string, over: Partial<SourceDef> = {}): SourceDef {
  return {
    id, displayName: id, kind: "video", category: "video",
    adapter: { template: "hls-site", params: { listPath: "/?page={page}", itemLinkPattern: "/video/", detailPath: "/video/{id}" } },
    baseUrls: [`https://${id}.example`],
    enabled: true, order: 1, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false, comments: false },
    network: { mode: "probe-required" },
    ...over,
  };
}

function checkResult(sourceId: string, over: Partial<SourceSelfCheckResult> = {}): SourceSelfCheckResult {
  return {
    sourceId, at: NOW, listOk: true, itemCount: 5, listFailure: null,
    detail: "ok", detailFailure: null, requests: 2,
    /* fix331/source-reliability 断言适配：结果格式新增末段三字段＋
     * 清单版本指纹，夹具补齐（口径不变、覆盖不降）。
     * fix333/m7-selfcheck 断言适配：指纹改三维（协议版本/适配器
     * 纪元/源切片），夹具按同形 def 盖指纹（口径不变、覆盖不降）。 */
    tail: "ok", tailKind: "stream", tailFailure: null, ...selfCheckFingerprintFor(hlsDef(sourceId)), ...over,
  };
}

/* ── ① schema 校验 ── */
{
  // 合法参数过
  assert.deepEqual(
    validateAdapterParams({ listPath: "/new?page={page}", itemLinkPattern: "/v/", detailPath: "/v/{id}" }),
    { listPath: "/new?page={page}", itemLinkPattern: "/v/", detailPath: "/v/{id}" },
  );
  // 危险形态被丢：scheme 注入 / 协议相对 / data: / javascript:
  assert.equal(validateAdapterParams({ listPath: "javascript:alert(1)" }), null);
  assert.equal(validateAdapterParams({ listPath: "//evil.example/x" }), null);
  assert.equal(validateAdapterParams({ listPath: "https://evil.example/x" }), null);
  assert.equal(validateAdapterParams({ itemLinkPattern: "data:text/html;base64,x" }), null);
  // 类型错 / 未知字段 / 超长 pattern / 空对象被丢
  assert.equal(validateAdapterParams({ listPath: 42 }), null);
  assert.equal(validateAdapterParams({ streamPattern: ".*\\.m3u8" }), null, "模板不消费的字段不许下发");
  assert.equal(validateAdapterParams({ itemLinkPattern: "x".repeat(129) }), null);
  assert.equal(validateAdapterParams({}), null);
  assert.equal(validateAdapterParams("nope"), null);

  // 单条目参数非法 → 只丢该条目参数，整份清单与既有覆盖照常
  const m = validateManifest({
    manifestVersion: 9, minAppVersion: "1.0.0",
    sources: [
      { id: "a", enabled: false, baseUrls: ["https://a2.example"], adapterParams: { listPath: "javascript:x" }, paramsVersion: 3 },
      { id: "b", adapterParams: { listPath: "/ok" }, paramsVersion: 1 },
    ],
  });
  assert.ok(m, "含非法参数条目的清单整份仍有效");
  assert.equal(m.sources[0].adapterParams, undefined, "非法参数被丢");
  assert.equal(m.sources[0].enabled, false, "enabled 覆盖保留");
  assert.deepEqual(m.sources[0].baseUrls, ["https://a2.example"], "baseUrls 覆盖保留");
  assert.deepEqual(m.sources[1].adapterParams, { listPath: "/ok" }, "合法参数保留");
  assert.equal(m.sources[1].paramsVersion, 1);

  // paramsVersion 缺失/非整数 → 参数被丢（版本是回滚防抖的锚）
  const m2 = validateManifest({
    manifestVersion: 9, minAppVersion: "1.0.0",
    sources: [{ id: "a", adapterParams: { listPath: "/ok" } }],
  });
  assert.equal(m2?.sources[0].adapterParams, undefined, "无 paramsVersion 的参数被丢");
}

/* ── ①+② 条目级 minAppVersion 门＋应用生效 ── */
{
  const storage = fakeStorage();
  bindAdapterParamsStorage(storage);
  const builtin = [hlsDef("a"), hlsDef("b", { adapter: { template: "wp-rest", params: { listPath: "/posts" } } })];
  const manifest = validateManifest({
    manifestVersion: 9, minAppVersion: "1.0.0",
    sources: [
      { id: "a", adapterParams: { listPath: "/new", itemLinkPattern: "/n/" }, paramsVersion: 2, minAppVersion: "3.2.1" },
      { id: "b", adapterParams: { listPath: "/wp-new" }, paramsVersion: 1 },
    ],
  })!;
  // App 版本低于条目门 → a 的参数不应用
  const gated = applyManifest(builtin, manifest, "3.2.0");
  assert.equal(gated[0].adapter.params?.listPath, "/?page={page}", "条目 minAppVersion 高于 App 版本时参数不应用");
  // 版本达标 → 覆盖生效，未下发字段保留内置值
  const applied = applyManifest(builtin, manifest, "3.2.1");
  assert.equal(applied[0].adapter.params?.listPath, "/new");
  assert.equal(applied[0].adapter.params?.itemLinkPattern, "/n/");
  assert.equal(applied[0].adapter.params?.detailPath, "/video/{id}", "未下发字段保留内置参数");
  // 非 hls-site 源参数被忽略
  assert.equal(applied[1].adapter.params?.listPath, "/posts", "非 hls-site 源参数被忽略");
  // 参数通道不动 enabled/maturity
  assert.equal(applied[0].enabled, true);
  assert.equal(applied[0].maturity, "probe");
  // 已应用快照落盘：含 paramsVersion/基线指纹/pending 状态
  const state = getAdapterParamsState();
  assert.equal(state.applied["a"]?.paramsVersion, 2);
  assert.equal(state.applied["a"]?.status, "pending");
  assert.equal(state.applied["a"]?.builtinFingerprint, fingerprintParams(builtin[0].adapter.params));
  assert.ok(storage.map.has(ADAPTER_PARAMS_STORAGE_KEY), "快照落 hghubx_* 键");
  bindAdapterParamsStorage(null);
}

/* ── ③ 回滚：应用后变坏 → 回滚内置＋rejected；同版本不再应用 ── */
{
  const storage = fakeStorage();
  bindAdapterParamsStorage(storage);
  const builtin = [hlsDef("a")];
  const manifest = validateManifest({
    manifestVersion: 9, minAppVersion: "1.0.0",
    sources: [{ id: "a", adapterParams: { listPath: "/broken" }, paramsVersion: 5 }],
  })!;
  const applied = applyManifest(builtin, manifest, "3.2.1");
  assert.equal(applied[0].adapter.params?.listPath, "/broken");

  let reverted: string[] = [];
  const active = [...applied];
  const summary = await verifyAppliedAdapterParams({
    getSources: () => active,
    runCheck: async (def) => checkResult(def.id, { listOk: false, itemCount: 0, listFailure: "解析为空", detail: "skipped" }),
    getPriorResult: () => undefined, // 应用前未知 → 变坏即回滚
    revertSource: (id) => { reverted = [...reverted, id]; const i = active.findIndex((s) => s.id === id); if (i >= 0) active[i] = builtin[i]; return i >= 0; },
    now: () => NOW,
  });
  assert.deepEqual(summary.rolledBack, ["a"]);
  assert.deepEqual(reverted, ["a"], "回滚经 revertSource 生效点落到 active 注册表");
  assert.equal(active[0].adapter.params?.listPath, "/?page={page}", "回滚后恢复内置参数");
  const state = getAdapterParamsState();
  assert.deepEqual(state.rejected["a"], [5], "rejected paramsVersion 落盘");
  assert.equal(state.applied["a"]?.status, "rolled-back");

  // 同版本再次下发 → 不再应用（防抖动循环）
  const again = applyManifest(builtin, manifest, "3.2.1");
  assert.equal(again[0].adapter.params?.listPath, "/?page={page}", "rejected 同版本不再重复应用");
  bindAdapterParamsStorage(null);
}

/* ── ③ 保留：应用后自检通过 → applied；应用前已坏、应用后仍坏不算变坏 ── */
{
  const storage = fakeStorage();
  bindAdapterParamsStorage(storage);
  const builtin = [hlsDef("a"), hlsDef("c")];
  const manifest = validateManifest({
    manifestVersion: 9, minAppVersion: "1.0.0",
    sources: [
      { id: "a", adapterParams: { listPath: "/fixed" }, paramsVersion: 1 },
      { id: "c", adapterParams: { listPath: "/still-broken" }, paramsVersion: 1 },
    ],
  })!;
  const applied = applyManifest(builtin, manifest, "3.2.1");
  const summary = await verifyAppliedAdapterParams({
    getSources: () => applied,
    runCheck: async (def) => def.id === "a"
      ? checkResult("a")
      : checkResult("c", { listOk: false, itemCount: 0, listFailure: "解析为空", detail: "skipped" }),
    getPriorResult: (id) => id === "c" ? checkResult("c", { listOk: false, itemCount: 0, listFailure: "解析为空", detail: "skipped" }) : undefined,
    revertSource: () => { throw new Error("不应回滚"); },
    now: () => NOW,
  });
  assert.deepEqual(summary.confirmed, ["a", "c"], "自检通过保留；应用前已坏不算变坏、不回滚");
  assert.deepEqual(summary.rolledBack, []);
  assert.equal(getAdapterParamsState().applied["a"]?.status, "applied");
  bindAdapterParamsStorage(null);
}

/* ── 接线与覆盖面 ── */
{
  const main = read("../../main.tsx");
  assert.ok(main.includes("verifyAppliedAdapterParams"), "main.tsx 启动装配参数校验回滚");
  /* 原 registryDiag 明细呈现两断言随该死面于 fix334/L4 删除；
   * 两构建器本身已于 fix334 清扫修复线按清扫裁定连同其专属自
   * 测一并删除（见文件头落账）。 */
  const manifestSrc = read("./manifest.ts");
  // 契约适配（3.3.0 集成，2026-11-19）：原断言写死 "3.2.1"，版本 bump 后
  // 必然假红；保护的行为是「FALLBACK_APP_VERSION 与 package.json 同步」，改为
  // 动态读 package.json 版本断言，任何版本下都成立且不削弱覆盖（同 infra 线适配）。
  const pkgVersion = (JSON.parse(read("../../../package.json")) as { version: string }).version;
  assert.ok(manifestSrc.includes(`"${pkgVersion}"`), `FALLBACK_APP_VERSION 与 package.json ${pkgVersion} 同步`);
  // 覆盖面：内置注册表中 hls-site 源即本机制覆盖名单（枚举 >0）
  const covered = getBuiltinRegistry().filter((s) => s.adapter.template === "hls-site");
  // 契约适配（3.3.0 集成，2026-11-19）：原断言「两位数」基于瘦身前 52 源注册表；
  // 3.2.2 瘦身后保留集 hls-site 源为个位数。保护的行为是「机制覆盖名单＝注册表
  // hls-site 全集、枚举非空且含保留里番/图片源」，改按保留集实名断言，不削弱覆盖。
  /* 断言适配（fix330/ui-fixes，2026-11-19）：rule34video 按用户裁定
   * 摘除注册表后，保留集 hls-site 全集只剩 pornpics 一源——下限改
   * 非空（>=1）、实名断言收口到 pornpics；保护行为（覆盖名单＝注册
   * 表 hls-site 全集、由上方 filter 枚举本身保证）不变。 */
  assert.ok(covered.length >= 1, `hls-site 覆盖源应为保留集全集（非空），实际 ${covered.length}`);
  /* 断言适配（3.3.0 接通批集成，2026-11-19）：hanime-tv 已换 hanime-api
   * 模板、hentaihaven 已毕业 hentaihaven-api 专用模板——两者均不再属
   * hls-site 参数下发覆盖面（F8 口径本就只覆盖 hls-site）；保留集
   * hls-site 全集现为 pornpics 一源（rule34video 已摘除），实名断言
   * 随之收口，保护行为不变。 */
  for (const id of ["pornpics"]) {    assert.ok(covered.some((s) => s.id === id), `hls-site 覆盖名单应含 ${id}`);
  }
}

console.log("fix321-f8 contract: ALL PASS");
