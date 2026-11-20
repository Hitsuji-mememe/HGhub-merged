/**
 * 3.3.7 视频取流线契约测试（Muse 2026-11-20 fix337/video-resolve；
 * 本批任务书即维护者对新增测试的授权，AGENTS 不变量 11）：
 * 运行：node src/features/sources/fix337-video-resolve.contract.test.ts
 * 背景：3.3.6 真机 source-010 resolve 三连 stream_unavailable（取数
 * 成功、流表判读为零候选）、source-011 取到非权威清单后子级全灭。
 * 协议事实来源＝维护中的第三方客户端双证据（IwaraTool docs/API.md
 * 「verified」节＋其取画质代码、gallery-dl iwara extractor）：流表
 * src.view/download 为**协议相对地址**（//host/...，客户端须补
 * https:），且站点轮换 X-Version 签名盐、客户端按内置盐序逐个试。
 * 本仓旧夹具把地址写成绝对 https，契约全绿而真机全灭——夹具形态
 * 与真实响应脱节。本文件断言：
 * ① 协议相对候选经规范化后成为可播流（旧码 ^https:// 过滤全杀→红）；
 * ② 首盐签名被站方回空表时自动换备用盐重试（旧码单盐→红）；
 * ③ HentaiHaven 集页无 ld+json 时，页内非权威 .m3u8 字面不作流
 *    返回（旧码整页首个 .m3u8 兜底→红）；有 ld+json 的既有形态由
 *    fix330 契约继续钉住。不访问真实网络。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "./registry.ts";
import { createHentaihavenAdapter, createIwaraAdapter } from "./adapters/templates.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";

const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");
const def = (id: string) => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const NEW_SALT_HASH = sha1("fixturefile001_1893456000_mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN");
const LEGACY_SALT_HASH = sha1("fixturefile001_1893456000_5nFp9kmbNnHdAFhaqMvt");

/* ── ① Iwara 协议相对候选：流表 src 为 //host/... 时必须补
 * https: 后作流返回；旧码只收 ^https:// → 零候选 stream_unavailable。 ── */
{
  setFetchPage(async (url) => {
    if (url.includes("files.iwara.tv")) return fx("iwara-sources.json");
    if (url.includes("/video/")) return fx("iwara-video.json");
    throw new Error(`unexpected fetch ${url}`);
  });
  const a = createIwaraAdapter(def("iwara"));
  const r = await a.resolve("Ab12Cd34Ef56");
  assert.equal(r.streams.length, 1, "协议相对候选必须产出一条流（旧码为零候选）");
  assert.ok(r.streams[0]?.url.startsWith("https://"), "协议相对地址必须补 https: 规范化");
  assert.ok(r.streams[0]?.url.endsWith("-720.mp4"), "仍取最高档（720 > 360）");
}

/* ── ② Iwara 双盐回退：站方对首盐（现行盐）签名回空表（200＋[]，
 * 维护客户端实证的轮换期形态）、对备用盐（旧盐）回真表时，resolve
 * 必须换盐重试并成功；旧码单盐一次判读即终局。 ── */
{
  const seenVersions: (string | undefined)[] = [];
  setFetchPage(async (url, headers) => {
    if (url.includes("files.iwara.tv")) {
      const v = headers?.["X-Version"];
      seenVersions.push(v);
      return v === LEGACY_SALT_HASH ? fx("iwara-sources.json") : "[]";
    }
    if (url.includes("/video/")) return fx("iwara-video.json");
    throw new Error(`unexpected fetch ${url}`);
  });
  const a = createIwaraAdapter(def("iwara"));
  const r = await a.resolve("Ab12Cd34Ef56");
  assert.equal(r.streams.length, 1, "首盐回空表必须换备用盐重试（旧码零流）");
  assert.deepEqual(seenVersions, [NEW_SALT_HASH, LEGACY_SALT_HASH], "盐序＝现行盐先、备用盐后，各试一次");
}

/* ── ③ HentaiHaven 无 ld+json 集页：页内只有 iframe 播放器与一处
 * 非权威 .m3u8 字面时 resolve 必须回空（诚实失败），不许把字面
 * 当流交给播放器；旧码 extractM3u8 整页兜底会返回该字面。 ── */
{
  setFetchPage(async (url) => {
    if (url.includes("/api/manga/")) return fx("hentaihaven-list.json");
    if (url.includes("/episode-")) return fx("hentaihaven-episode-noldjson.html");
    if (url.includes("/watch/")) return fx("hentaihaven-watch.html");
    throw new Error(`unexpected fetch ${url}`);
  });
  const a = createHentaihavenAdapter(def("hentaihaven"));
  const r = await a.resolve("fixture-slug-001");
  assert.deepEqual(r.streams, [], "无 ld+json 时非权威 .m3u8 字面不得作流返回（旧码会返回预告字面）");
}

console.log("fix337-video-resolve.contract: all assertions passed");
