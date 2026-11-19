/**
 * 3.3.0 接通批 Hanime API 线契约测试（Muse 2026-11-19
 * fix330-hanime-api；本批任务书即维护者对新增测试的授权，AGENTS
 * 不变量 11）。运行：node src/features/sources/fix330-hanime-api.contract.test.ts
 *
 * 旧红形态（基线 fix-330-20261119 @0f32895）：模板 hanime-api 不
 * 存在——createAdapter(hanime-tv) 产出的仍是 hls-site 抓页适配器、
 * TEMPLATE_FETCH_ORIGINS 无 hanime-api 条目、fetchPost 接缝与
 * Rust source_post 命令均不存在，本文件在基线无法运行（模块缺失）。
 *
 * 覆盖：
 * - 签名/密钥已知答案向量（期望值由 sha256sum 独立实现算出）；
 * - AES-256-GCM 密封与 node:crypto 独立实现交叉对账（定值 iv）；
 * - 目录夹具（结构取自 2026-11-19 实抓 search_hvs 字段形态、内容
 *   全脱敏为 fixture 占位）→ 列表排序/分页、搜索过滤、详情；
 * - 握手全链（夹具接缝）：CSRF → 信封 POST（头名单/签名定值）→
 *   x-token 回信封 → 流表过滤（推广位/坏形态剔除）与画质降序；
 *   CSRF_ERROR_1 首败后重取 CSRF 重试成功；
 * - 注册表/工厂/fetchOrigins/白名单派生的接线断言。
 * 不访问真实网络（fetchPage/fetchPost 均经接缝注入夹具）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "./registry.ts";
import { sourceFetchAllowlistOrigins } from "./allowlist.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { setFetchPost, type FetchPostResult } from "./adapters/fetchPost.ts";
import { HANIME_AUTH_ORIGIN, HANIME_CT_ORIGIN, HANIME_GUEST_ORIGIN, isFetchPageTemplate, templateFetchOrigins } from "./adapters/fetchOrigins.ts";
import { buildHandshakeRequest, createHanimeApiAdapter, hanimeSignatureHex, openHandshakeResponse, resolveFailureEventData, sealEnvelope, sha256Hex } from "./adapters/hanimeApi.ts";

const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");
const def = getBuiltinRegistry().find((s) => s.id === "hanime-tv");
assert.ok(def, "registry has hanime-tv");

/* ── 已知答案向量（期望 hex 由 sha256sum 在仓外算出、写死于此） ── */
{
  assert.equal(
    await sha256Hex("htv-insecure-handshake-v1"),
    "5d657a4dcb0bad1c637ff2e221059b10ff17ae39fe855003e846918941f4ebe3",
    "握手密钥派生 = SHA-256(公开常数串)",
  );
  assert.equal(
    await hanimeSignatureHex("1700000000", "https://hanime.tv"),
    "bc2348fd32ead4c3d79e87ad1abecd3759e573bf2f31024f7313a2fe054703ee",
    "web2 签名 = SHA-256(time + 常数拼接)",
  );
}

/* ── AES-256-GCM 密封与 node:crypto 独立实现交叉对账（定值 iv） ── */
{
  const sealed = await sealEnvelope('{"fixture":true}', new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
  assert.equal(sealed.iv, "AAECAwQFBgcICQoL", "信封 iv base64url 形态");
  assert.equal(sealed.data, "HEs4ffBT3ClqPyvbNKNAGw", "信封 data 与独立实现一致");
  assert.equal(sealed.tag, "AZEkMzzp9KgdKY2Phz3zjQ", "信封 tag 与独立实现一致");
}

/* ── 目录段：列表（created_at 降序＋分页＋无 slug 行剔除） ── */
const catalogJson = fx("hanime-search-hvs.json");
{
  setFetchPage(async (url) => {
    assert.ok(url === `${HANIME_GUEST_ORIGIN}/api/v11/search_hvs`, "列表只请求 guest 目录端点");
    return catalogJson;
  });
  const a = createHanimeApiAdapter(def);
  const p1 = await a.list(1, 2);
  assert.deepEqual(p1.items.map((i) => i.externalId), ["fixture-slug-three", "fixture-slug-two"], "列表按 created_at_unix 降序、首页切片");
  assert.equal(p1.pagination.total, 3, "无 slug 行被剔除、总数 3");
  assert.equal(p1.pagination.pages, 2, "分页按目录总数推导");
  const p2 = await a.list(2, 2);
  assert.deepEqual(p2.items.map((i) => i.externalId), ["fixture-slug-one"], "次页切片");
  assert.equal(p1.items[0].href, "https://hanime.tv/videos/hentai/fixture-slug-three", "条目 href 为详情页形态");
  assert.ok(p1.items[0].cover.startsWith("https://"), "封面为绝对地址");

  /* 搜索段：关键词命中 search_titles 备用名（目录客户端过滤） */
  assert.ok(a.search, "hanime-api 模板带 search 方法");
  const hit = await a.search("unicorn", 1, 10);
  assert.deepEqual(hit.items.map((i) => i.externalId), ["fixture-slug-one"], "搜索命中 search_titles");
  const byTag = await a.search("fixture-tag-two", 1, 10);
  assert.deepEqual(byTag.items.map((i) => i.externalId), ["fixture-slug-one"], "搜索命中对象形态标签名");
  const miss = await a.search("no-such-word", 1, 10);
  assert.equal(miss.items.length, 0, "搜索无命中为合法真空（不抛解析为空）");

  /* 详情段：目录行直出（标签双形态归一、剧集一段） */
  const d = await a.detail("fixture-slug-one");
  assert.equal(d.title, "Fixture Title One", "详情标题取目录行");
  assert.deepEqual(d.tags, ["fixture-tag", "fixture-tag-two"], "详情标签 string/{name} 双形态归一");
  assert.equal(d.description, "Fixture description one.", "详情简介取目录行");
  assert.deepEqual(d.episodes, [{ label: "正片", externalId: "fixture-slug-one" }], "详情带正片段");
}

/* ── 握手段：请求构造定值（time/iv 注入 → 签名与信封可复现） ── */
{
  const req = await buildHandshakeRequest("fixture-slug-one", "fixture-csrf", "https://hanime.tv", 1700000000000, new Uint8Array(12));
  assert.equal(req.headers["x-signature-version"], "web2", "签名版本头为 web2");
  assert.equal(req.headers["x-time"], "1700000000", "x-time 为注入时刻秒数");
  assert.equal(req.headers["x-signature"], "bc2348fd32ead4c3d79e87ad1abecd3759e573bf2f31024f7313a2fe054703ee", "签名头与已知答案向量一致");
  assert.equal(req.headers["x-csrf-token"], "fixture-csrf", "CSRF 只进 x-csrf-token 头");
  assert.equal(req.headers.Origin, "https://hanime.tv", "Origin 头为站点基址");
  const body = JSON.parse(req.body) as { token: string };
  assert.ok(/^[A-Za-z0-9_-]+$/.test(body.token), "POST 正文 token 为 base64url 信封");
}

/* ── 握手段：响应判读（流表过滤＋降序）与全链 resolve（含 CSRF 重试） ── */
{
  const sourcesPayload = JSON.stringify({
    sources: [
      { kind: "normal", src: "/hls/480/FixtureToken480", height: 480 },
      { kind: "promotion", src: "/hls/1080/FixturePromo", height: 1080 },
      { kind: "normal", src: "/hls/720/FixtureToken720", height: 720 },
      { kind: "normal", src: "/hls/720/FixtureToken720", height: 720 },
      { kind: "normal", src: "https://evil.example/hls/720/x", height: 720 },
      { kind: "normal", src: "/hls/abc/FixtureBad", height: 720 },
    ],
  });
  const sealed = await sealEnvelope(sourcesPayload, new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2]));
  const envelopeJson = JSON.stringify({ v: 1, alg: "AES-256-GCM", iv: sealed.iv, tag: sealed.tag, data: sealed.data });
  const xToken = Buffer.from(envelopeJson, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const streams = await openHandshakeResponse(xToken, "https://hanime.tv");
  assert.deepEqual(
    streams,
    [
      { url: "https://hanime.tv/hls/720/FixtureToken720", kind: "hls" },
      { url: "https://hanime.tv/hls/480/FixtureToken480", kind: "hls" },
    ],
    "流表只收 normal＋合法 /hls 形态、去重、画质降序，推广位与外域 src 剔除",
  );

  let csrfCalls = 0;
  let postCalls = 0;
  setFetchPage(async (url) => {
    if (url === `${HANIME_GUEST_ORIGIN}/api/v11/search_hvs`) return catalogJson;
    assert.equal(url, `${HANIME_CT_ORIGIN}/csrf-token`, "握手前只向 ct 域取 CSRF");
    csrfCalls += 1;
    return JSON.stringify({ csrf_token: `fixture-csrf-${csrfCalls}`, csrf_token_expires_at: 1795107769 });
  });
  setFetchPost(async (url, body, headers): Promise<FetchPostResult> => {
    assert.equal(url, `${HANIME_AUTH_ORIGIN}/api/v11/handshake`, "握手 POST 只发 auth 域");
    postCalls += 1;
    assert.ok(body.length > 0 && body.length <= 64 * 1024, "POST 正文在定向通道上限内");
    assert.equal(headers?.["x-signature-version"], "web2", "POST 带 web2 签名版本头");
    assert.ok(/^[a-f0-9]{64}$/.test(headers?.["x-signature"] ?? ""), "POST 带 64 位 hex 签名头");
    if (postCalls === 1) {
      return { status: 403, body: JSON.stringify({ error_id: "CSRF_ERROR_2" }), xToken: null };
    }
    assert.equal(headers?.["x-csrf-token"], "fixture-csrf-2", "重试用重取的 CSRF");
    return { status: 200, body: "{}", xToken };
  });
  const a = createHanimeApiAdapter(def);
  const r = await a.resolve("fixture-slug-one");
  assert.equal(csrfCalls, 2, "CSRF 失效后重取一次");
  assert.equal(postCalls, 2, "握手 POST 共两次（首败重试）");
  assert.deepEqual(r.streams, streams, "resolve 全链产出与响应判读一致");
}

/* ── 取流分段留痕（fix331-hanime-403）：纯函数键集合固定、无敏感
 * 值位置；终局 HTTP 拒绝的重试行为与留痕前一致，403 文案按本线
 * 定性处置带出口提示（非 403 维持裸状态形态） ── */
{
  assert.deepEqual(
    resolveFailureEventData("source-002", "handshake", "handshake_http_error", 403, 0),
    { source: "source-002", segment: "handshake", code: "handshake_http_error", status: 403, attempt: 0 },
    "留痕数据：编号/段名/固定码/状态/尝试序",
  );
  const noStatus = resolveFailureEventData("source-002", "decode", "decode_failed", undefined, 1);
  assert.deepEqual(Object.keys(noStatus).sort(), ["attempt", "code", "segment", "source"], "无状态时 status 键整缺、键集合封闭");
  const adapterSrc = readFileSync(new URL("./adapters/hanimeApi.ts", import.meta.url), "utf8");
  assert.ok(adapterSrc.includes('tracePlayback(\n      "source.resolve_fail"') || adapterSrc.includes('"source.resolve_fail"'), "resolve 失败经 source.resolve_fail 留痕");
  for (const seg of ['"csrf"', '"handshake"', '"decode"']) {
    assert.ok(adapterSrc.includes(`traceResolveFailure(def.id, ${seg}`), `三段留痕齐全：${seg}`);
  }
  assert.ok(!adapterSrc.includes("tracePlayback") || !/tracePlayback\([^)]*(req\.|headers|csrfToken)/.test(adapterSrc), "留痕落点不直收请求材料（只经 resolveFailureEventData 固定组装）");

  /* 终局拒绝：非 CSRF 错误的 403 不重试、错误文案保持固定形态 */
  setFetchPage(async (url) => {
    if (url === `${HANIME_GUEST_ORIGIN}/api/v11/search_hvs`) return catalogJson;
    return JSON.stringify({ csrf_token: "fixture-csrf-x" });
  });
  let denyPosts = 0;
  setFetchPost(async (): Promise<FetchPostResult> => {
    denyPosts += 1;
    return { status: 403, body: JSON.stringify({ error_id: "ACCESS_DENIED" }), xToken: null };
  });
  const denied = createHanimeApiAdapter(def);
  await assert.rejects(denied.resolve("fixture-slug-one"), (e: unknown) => e instanceof Error && e.message === "Hanime 握手失败：HTTP 403（站点拒绝了当前网络出口，切换线路或节点后重试）", "终局 403 带出口提示文案");
  assert.equal(denyPosts, 1, "非 CSRF 错误不重试");
  /* 非 403 状态维持裸状态固定形态，不带出口提示 */
  setFetchPost(async (): Promise<FetchPostResult> => ({ status: 500, body: "{}", xToken: null }));
  const failed500 = createHanimeApiAdapter(def);
  await assert.rejects(failed500.resolve("fixture-slug-one"), (e: unknown) => e instanceof Error && e.message === "Hanime 握手失败：HTTP 500", "非 403 维持裸状态文案");
}

/* ── 注册表/工厂/白名单接线 ── */
{
  assert.equal(def.adapter.template, "hanime-api", "hanime-tv 注册表换 hanime-api 模板");
  assert.equal(def.capabilities.search, true, "capabilities.search 据实 true（API 搜索段已接）");
  assert.equal(def.maturity, "probe", "App 侧未真机验、维持 probe");
  assert.ok(def.note?.includes("source_post"), "note 记录通道扩展形态");
  /* 工厂分发按仓内既有口径以源码文本断言（adapters/index.ts 的
   * 无扩展名 import 不能被 node 类型剥离直接加载，见 final-d 契约）。 */
  const factorySrc = readFileSync(new URL("./adapters/index.ts", import.meta.url), "utf8");
  assert.ok(factorySrc.includes('case "hanime-api": return createHanimeApiAdapter(def)'), "createAdapter 分发 hanime-api → createHanimeApiAdapter");
  const adapter = createHanimeApiAdapter(def);
  assert.equal(typeof adapter.search, "function", "适配器带 search 方法（扇出结构门可过）");
  assert.ok(isFetchPageTemplate("hanime-api"), "hanime-api 属取页模板集合");
  assert.deepEqual(
    templateFetchOrigins("hanime-api"),
    [HANIME_GUEST_ORIGIN, HANIME_CT_ORIGIN, HANIME_AUTH_ORIGIN],
    "模板声明三 origin（guest/ct/auth）与适配器常数同源",
  );
  const allow = new Set(sourceFetchAllowlistOrigins(getBuiltinRegistry()));
  for (const o of ["https://hanime.tv", HANIME_GUEST_ORIGIN, HANIME_CT_ORIGIN, HANIME_AUTH_ORIGIN]) {
    assert.ok(allow.has(o), `生产白名单派生含 ${o}`);
  }
}

console.log("fix330-hanime-api contract: ok");
