/**
 * fix339 自检取流探针保真线契约（Muse 2026-11-21；本批任务书即
 * 维护者对新增测试的授权，AGENTS 不变量 11）：
 * 运行：node src/features/sources/fix339-probe-fidelity.contract.test.ts
 *
 * 立项（3.3.8 真机定案，fix338/evidence/device-export-338-
 * analysis.md）：自检取流段此前只跑 adapter.resolve()——流地址能
 * 从站点/API 主机解析出来即判「取流可达」；播放的第一步却是把
 * 该地址经本地 /hls 路由（Rust 清单腿：媒体栈取数＋15s 总截止
 * ＋#EXTM3U 魔数校验）取回来，流/清单主机只在播放路径上被请
 * 求。009/010 真机即死在探针视野之外（06:44 探针判可达、06:47
 * 点播清单取数 dns_error 全灭）。本线给取流段加「清单实拉」：
 * resolve 解出首条流地址后，经注入接缝 probeManifest 以播放同
 * 路实拉清单（生产实现 manifestProbe.ts），成功才判可达。
 *
 * 覆盖：(a) 实拉失败翻转取流结论＋失败分类＋诊断行呈现（核心
 * 证伪：旧码无此步、恒判可达）；(b) 实拉成功判可达且调用计数
 * 入账；(c) 零流不实拉、维持零流失败；(d) 接缝缺席维持
 * resolve-only 旧口径（契约隔离语义）；(e) 协议/纪元/预算常
 * 量（v3/纪元 5/预算 5）；(f) 分页抽查与实拉叠加计数恰 5；
 * (g) 非视频品类不实拉；(h) 生产接线文本断言（main.tsx 两处、
 * sourceHealth.ts 三处显式注入生产实现，manifestProbe 本体走
 * playlist() 同路 URL）。
 * 不访问真实网络：适配器与实拉接缝均经注入以假实现隔离。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SELF_CHECK_ADAPTER_EPOCH,
  SELF_CHECK_MAX_REQUESTS_PER_SOURCE,
  SELF_CHECK_PROTOCOL_VERSION,
  runSourceSelfCheck,
  selfCheckSegmentText,
} from "./healthCheck.ts";
import type { SourceAdapter, SourceDef } from "./types.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const NOW = 1_700_000_000_000;
const STREAM_URL = "https://cdn.example/v/playlist.m3u8";

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

function fakeAdapter(behavior: {
  signalPages?: number;
  streams?: { url: string; kind: "hls" | "file" }[];
  detailHtml?: string;
} = {}): SourceAdapter {
  const pages = behavior.signalPages ?? 1;
  return {
    sourceId: "fake",
    async list(page) {
      return {
        items: [{ sourceId: "fake", externalId: `ext-p${page}`, title: `t${page}`, cover: "", href: "", tags: [] }],
        pagination: { page, pages, size: 20, total: pages },
      };
    },
    async detail(id) {
      return {
        sourceId: "fake", externalId: id, title: "d", cover: "", href: "", tags: [],
        images: [], episodes: [], contentHtml: behavior.detailHtml ?? "",
      };
    },
    async resolve() {
      return { streams: behavior.streams ?? [{ url: STREAM_URL, kind: "hls" as const }] };
    },
  };
}

function probeRecorder(impl: (url: string) => Promise<void>) {
  const calls: string[] = [];
  return {
    calls,
    fn: async (url: string) => { calls.push(url); await impl(url); },
  };
}

/* ── (a) 实拉失败翻转取流结论（核心证伪） ── */
{
  const probe = probeRecorder(async () => { throw new Error("dns 解析失败 connect 不可达"); });
  const r = await runSourceSelfCheck(fakeDef("pf-a"), {
    createAdapterFor: () => fakeAdapter(),
    probeManifest: probe.fn,
    now: () => NOW,
  });
  assert.deepEqual(probe.calls, [STREAM_URL], "实拉恰对 resolve 首条流地址调 1 次");
  assert.equal(r.detail, "ok", "详情段不受末段影响");
  assert.equal(r.tail, "fail", "清单实拉失败必须翻转取流结论（旧码恒 ok＝假绿）");
  assert.equal(r.tailFailure, "网络类", "清单腿 DNS 形态错误按取流步分类归网络类");
  assert.equal(r.requests, 4, "单页口径：列表＋详情＋取流解析＋清单实拉恰 4 次调用");
  assert.ok(selfCheckSegmentText(r).includes("取流失败"), "诊断逐源行明示取流段失败、不被详情可达盖住");
}

/* ── (b) 实拉成功判可达 ── */
{
  const probe = probeRecorder(async () => {});
  const r = await runSourceSelfCheck(fakeDef("pf-b"), {
    createAdapterFor: () => fakeAdapter(),
    probeManifest: probe.fn,
    now: () => NOW,
  });
  assert.deepEqual(probe.calls, [STREAM_URL], "实拉成功路径同样恰调 1 次");
  assert.equal(r.tail, "ok", "实拉成功（清单取回且魔数通过的等价信号）判取流可达");
  assert.equal(r.tailFailure, null);
  assert.equal(r.requests, 4, "成功路径调用计数同为 4");
}

/* ── (c) 零流不实拉 ── */
{
  const probe = probeRecorder(async () => {});
  const r = await runSourceSelfCheck(fakeDef("pf-c"), {
    createAdapterFor: () => fakeAdapter({ streams: [] }),
    probeManifest: probe.fn,
    now: () => NOW,
  });
  assert.equal(probe.calls.length, 0, "零流无地址可拉、不得调实拉接缝");
  assert.equal(r.tail, "fail", "零流维持失败");
  assert.equal(r.tailFailure, "取流失败", "零流维持既有失败形态");
  assert.equal(r.requests, 3, "零流路径不耗实拉调用（列表＋详情＋取流解析）");
}

/* ── (d) 接缝缺席维持 resolve-only（契约隔离语义） ── */
{
  const r = await runSourceSelfCheck(fakeDef("pf-d"), {
    createAdapterFor: () => fakeAdapter(),
    now: () => NOW,
  });
  assert.equal(r.tail, "ok", "未注入接缝时维持解出即 ok 的旧口径（生产装配恒注入，见 (h)）");
  assert.equal(r.requests, 3, "缺席不计实拉调用");
}

/* ── (e) 协议/纪元/预算常量 ── */
{
  assert.equal(SELF_CHECK_PROTOCOL_VERSION, 3, "自检协议 v3＝全链＋分页抽查＋清单实拉");
  assert.equal(SELF_CHECK_ADAPTER_EPOCH, 5, "适配器纪元 5＝取流结论依据链扩展到媒体取数链");
  assert.equal(SELF_CHECK_MAX_REQUESTS_PER_SOURCE, 5, "硬预算 5＝列表＋抽查＋详情＋取流解析＋清单实拉");
}

/* ── (f) 分页抽查与实拉叠加恰 5 ── */
{
  const probe = probeRecorder(async () => {});
  const r = await runSourceSelfCheck(fakeDef("pf-f"), {
    createAdapterFor: () => fakeAdapter({ signalPages: 3 }),
    probeManifest: probe.fn,
    now: () => NOW,
  });
  assert.equal(r.paging, "ok", "多页信号抽查通过");
  assert.equal(r.tail, "ok");
  assert.equal(r.requests, 5, "全链＋抽查＋实拉恰 5 次调用、不超硬预算");
  assert.ok(r.requests <= SELF_CHECK_MAX_REQUESTS_PER_SOURCE, "不超硬预算");
}

/* ── (g) 非视频品类不实拉 ── */
{
  const probe = probeRecorder(async () => {});
  const posts = fakeDef("pf-g", { kind: "post", category: "posts", adapter: { template: "chigua" } });
  const r = await runSourceSelfCheck(posts, {
    createAdapterFor: () => fakeAdapter({ detailHtml: "<p>正文</p>" }),
    probeManifest: probe.fn,
    now: () => NOW,
  });
  assert.equal(probe.calls.length, 0, "posts 正文段复用详情响应、不经清单实拉");
  assert.equal(r.tail, "ok", "正文段口径不变");
}

/* ── (h) 生产接线文本断言 ── */
{
  const main = read("../../main.tsx");
  const mainInjections = main.split("probeManifest: probeStreamManifestViaPlayback").length - 1;
  assert.ok(mainInjections >= 2, "main.tsx 两处生产装配（调度＋F8 参数验证）显式注入实拉实现");
  assert.ok(main.includes("from \"./features/sources/manifestProbe\""), "main.tsx 注入实现来自 manifestProbe 模块");
  const hooks = read("./sourceHealth.ts");
  const hookInjections = hooks.split("probeManifest: probeStreamManifestViaPlayback").length - 1;
  assert.ok(hookInjections >= 3, "sourceHealth.ts 三处补探接线（单源/成功推翻/批量）显式注入实拉实现");
  const impl = read("./manifestProbe.ts");
  assert.ok(impl.includes("export async function probeStreamManifestViaPlayback"), "生产实现导出在 manifestProbe.ts");
  assert.ok(impl.includes("playlist(streamUrl)"), "实拉 URL 经 shared/api 的 playlist() 构造（与播放器逐字同路）");
  const engine = read("./healthCheck.ts");
  assert.ok(engine.includes("probeManifest: partial.probeManifest"), "调度路径经 resolveDeps 透传接缝");
  assert.ok(engine.includes("probeManifest: deps.probeManifest"), "补探路径经 launchTopUp 透传接缝");
}

console.log("fix339-probe-fidelity contract OK");
