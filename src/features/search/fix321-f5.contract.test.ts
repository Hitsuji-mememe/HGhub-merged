/**
 * 3.2.1 修复 F5 线契约测试（Muse 2026-11-19，用户实报：搜「3p」视频
 * 页签里 Pornhub Shorties 结果封面全是 HG 占位图、有的点开播不了）。
 * 任务书即维护者对新增测试的授权（AGENTS 不变量 11）。
 * 运行：node src/features/search/fix321-f5.contract.test.ts
 *
 * 钉住的口径（2026-11-19 20:48 用户裁定变更，本文件随之适配）——
 * 搜索扇出资格＝搜索段结构门（见 multiSourceSearch.ts 的
 * missingSearchSegments）：模板真有 search 方法且 capabilities.
 * search 为真、且源已启用，即进扇出；maturity（验通状态）与参数
 * 校准状态不再在搜索入口预判（源已砍到保留集、重复压力低，可播
 * 性改在详情/起播时解析与兜底）。3.2.1 的 F5 三段齐全门（须
 * maturity=stable＋参数已校准、INCLUDE_OVERRIDE 门后生效）已被
 * 本裁定取代，OFF_IDS/INCLUDE_OVERRIDE 一并退役。本文件原 F5
 * 断言中与结构事实相关的部分（缺段判定、静默出局、Shorties 断链
 * 夹具证据）继续有效，验通门相关断言按新口径改写并逐处标注。
 *
 * Shorties 断链证据（真站抓取，2026-11-19 本机 curl，参考级）：
 * 模板 search 硬编码 /?s={q}&paged={page}（WordPress 式）请求
 * pornhub.com → 301 跳首页；首页中 itemLinkPattern "/video/" 唯一命中
 * 的是热门搜索建议词锚点（无 img）→ 条目封面被 absUrl(base,"") 填成
 * base 本身（HTML 页 URL）→ 图片解码失败呈 HG 占位；点开后 detail/
 * resolve 取的是建议词搜索页，全页首个 mp4 是无关视频的兜底文件。
 * 真站 /shorties 页条目只在 JSON_SHORTIES 内嵌 JS 数据里、锚点为 0，
 * 且该站无 shorties 服务端搜索入口——搜索段无真实现可补，移出扇出。
 * 夹具为真站 HTML 逐字节节录（fixtures/pornhub-*.html，注记含出处），
 * 完整原页存 evidence/f5。不访问真实网络。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "../sources/registry.ts";
import type { SourceDef } from "../sources/types.ts";
import { setFetchPage } from "../sources/adapters/fetchPage.ts";
import { createHlsSiteAdapter } from "../sources/adapters/templates.ts";
import {
  fanoutSearch, missingSearchSegments, searchPolicyFor,
  type SearchSegment,
} from "./multiSourceSearch.ts";

const fx = (name: string) => readFileSync(new URL(`../sources/adapters/fixtures/${name}`, import.meta.url), "utf8");
/* 断言适配（3.2.2 瘦身）：shorties 已摘除注册表，其断链夹具证据守
 * 的是 hls-site 模板在该参数下的解析产物——改用与删除前目录条目
 * 逐字一致的内联 def，断言内容不变。 */
const SHORTIES_DEF = {
  id: "shorties", displayName: "Pornhub Shorties", kind: "video", category: "video",
  adapter: { template: "hls-site", params: { listPath: "/?page={page}", itemLinkPattern: "/video/", detailPath: "/video/{id}" } },
  baseUrls: ["https://www.pornhub.com/shorties"], enabled: false, order: 115, maturity: "probe",
  capabilities: { search: false, episodes: false, hevc: false, comments: false },
  network: { mode: "probe-required" }, note: "目录导入·未实测（历史条目）",
} as unknown as SourceDef;
const def = (id: string): SourceDef => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};

/* ── 合成源工厂：默认三段齐全（stable＋search 声明＋已校准模板） ── */
const COMPLETE_PARAMS = { listPath: "/video?page={page}", itemLinkPattern: "/view_video.php", detailPath: "/view_video.php?viewkey={id}" };
const mkDef = (over: Partial<SourceDef>): SourceDef => ({
  id: "synthetic-f5", displayName: "合成源", kind: "video", category: "video",
  adapter: { template: "hls-site", params: { ...COMPLETE_PARAMS } },
  baseUrls: ["https://example.com"], enabled: true, order: 999, maturity: "stable",
  capabilities: { search: true, episodes: false, hevc: false, comments: false },
  network: { mode: "probe-required" }, note: "真站实测三段全通（合成夹具）",
  ...over,
});
const NO_CAPS = { search: false, episodes: false, hevc: false, comments: false };
const SKELETON_NOTE = "目录导入·未实测（合成夹具）：模板参数为通用骨架、未按真站校准";

/* ── 扇出资格判定：齐全源进、缺段源出（逐段） ── */
{
  const complete = mkDef({});
  assert.deepEqual(missingSearchSegments(complete), [], "三段齐全：无缺段");
  assert.equal(searchPolicyFor(complete).include, true, "三段齐全源进扇出");

  const noSearchDecl = mkDef({ capabilities: { ...NO_CAPS } });
  assert.ok(missingSearchSegments(noSearchDecl).includes("search"), "capabilities.search=false → 缺搜索段");
  assert.equal(searchPolicyFor(noSearchDecl).include, false, "缺搜索段声明：不进扇出");

  const noAdapter = mkDef({ adapter: { template: "none" } });
  assert.deepEqual(
    (missingSearchSegments(noAdapter) as SearchSegment[]).sort(),
    ["detail", "play", "search"],
    "template=none（无适配器）→ 三段全缺",
  );
  assert.equal(searchPolicyFor(noAdapter).include, false, "无适配器：不进扇出");

  const previewOnly = mkDef({ adapter: { template: "preview-only" } });
  assert.ok(missingSearchSegments(previewOnly).includes("play"), "preview-only 的 resolve 明确拒绝 → 缺取流段");
  assert.ok(missingSearchSegments(previewOnly).includes("search"), "preview-only 无 search 方法 → 缺搜索段");
  assert.equal(searchPolicyFor(previewOnly).include, false, "仅预览源：不进扇出");

  /* 裁定变更适配：probe 只记验通状态、不再让结构段失效——三段
   * 实现都在即无缺段、进扇出（可播性后移详情/起播解析）。 */
  const unverified = mkDef({ maturity: "probe", note: "真站实测：详情无流、取流接口未验证 → probe（合成夹具）" });
  assert.deepEqual(missingSearchSegments(unverified), [], "probe（未验通）→ 结构段仍齐全（验通状态不预判）");
  assert.equal(searchPolicyFor(unverified).include, true, "未验通但具备搜索段：进扇出（20:48 裁定）");

  const skeleton = mkDef({ maturity: "probe", capabilities: { ...NO_CAPS }, note: SKELETON_NOTE });
  assert.ok(missingSearchSegments(skeleton).includes("search"), "未声明 capabilities.search → 缺搜索段（与参数校准状态无关）");
  assert.equal(searchPolicyFor(skeleton).include, false, "无搜索段声明：不进扇出");

  /* 裁定变更适配：blocked 是验通状态而非结构缺段——具备搜索段
   * 且已启用的源一律进扇出（失败在扇出层如实留痕、不预扣）。 */
  const blocked = mkDef({ maturity: "blocked", note: "真站实测 blocked（合成夹具）" });
  assert.equal(searchPolicyFor(blocked).include, true, "blocked 但具备搜索段且已启用：进扇出（20:48 裁定「一律」）");
}

/* ── INCLUDE_OVERRIDE／OFF_IDS 已退役（20:48 裁定）：名单特例
 * 不复存在——旧 override 成员与任何源同规则：enabled=false 即出
 * 局（不再有越过 enabled 的纳入），有搜索段＋enabled 即纳入。 ── */
{
  const formerOverrideOff = mkDef({ id: "51chigua", enabled: false });
  assert.equal(searchPolicyFor(formerOverrideOff).include, false, "旧 override 成员 enabled=false：无特例、出局");
  const formerOffNowIn = mkDef({ id: "xiuren", enabled: true, maturity: "blocked" });
  assert.equal(searchPolicyFor(formerOffNowIn).include, true, "旧 OFF 成员（秀人）具备搜索段：按通则进扇出、无名单特判");
}

/* ── 注册表全量遍历：扇出名单恰为保留集内具备搜索段的源 ──
 * 契约适配（3.3.0 接通批集成，2026-11-19）：吃瓜线 51chigua/meiridasai
 * 接线搜索段进扇出、feedheiliao 实证无 GET 搜索段维持出局；图片线
 * pixibb/nudecosplay 启用进扇出、pornpics 搜索属实 false 出局；
 * 新适配器线 hanime1/iwara/hentaihaven 三源已写带 search 的专用适配器
 * 并启用进扇出。名单 7→13 源，判定口径（结构门）不变。 */
{
  const included = getBuiltinRegistry().filter((d) => searchPolicyFor(d).include).map((d) => d.id);
  assert.deepEqual(
    included,
    ["huangguo", "hanime-tv", "rule34video", "51chigua", "meiridasai", "xiuren", "cosplaytele", "danbooru", "hanime1", "iwara", "hentaihaven", "pixibb", "nudecosplay"],
    "扇出名单=保留集内 enabled∧具备搜索段（注册表序，3.3.0 集成）",
  );

  /* 出局的保留源逐源断言：无搜索段（caps 未声明/属实 false）或未启用 */
  const excludedSearch: Record<string, SearchSegment[]> = {
    feedheiliao: ["search"],      // caps.search 未声明（无 GET 搜索段，3.3.0 实证）
    pornpics: ["search"],         // 模板搜索实证不可用、search 属实 false（3.3.0 图片线）
  };
  for (const [id, segs] of Object.entries(excludedSearch)) {
    const p = searchPolicyFor(def(id));
    assert.equal(p.include, false, `${id} 无搜索段出局`);
    assert.ok(p.reason.includes("无搜索段"), `${id} 出局理由标明结构门`);
    const missing = missingSearchSegments(def(id));
    for (const s of segs) assert.ok(missing.includes(s), `${id} 缺段含 ${s}（实际 ${missing.join("/")}）`);
  }
  /* 断言适配（3.3.0 集成）：pixibb/nudecosplay 已启用且具备搜索段、进
   * 扇出（见上方名单断言）；hentaihaven 已毕业为命名源并进扇出；
   * 本组只剩未启用目录源。 */
  for (const id of ["yandere", "gelbooru", "pixiv"]) {    assert.equal(searchPolicyFor(def(id)).include, false, `目录源 ${id} 未启用出局`);
  }
  /* 出局源注册保留（不删源）：仍在注册表里、频道浏览不受扇出门影响 */
  for (const id of [...Object.keys(excludedSearch), "pixibb", "nudecosplay", "yandere", "gelbooru", "hentaihaven", "pixiv"]) {
    assert.ok(def(id), `${id} 注册保留`);
  }
}

/* ── 扇出行为：缺段源静默不搜（不发请求、不记失败），齐全源照常 ── */
{
  const searchedByAdapter: string[] = [];
  const stub = (sid: string) => ({
    sourceId: sid,
    list: async () => ({ items: [], pagination: { page: 1, pages: 1, size: 20, total: 0 } }),
    detail: async () => { throw new Error("unused"); },
    resolve: async () => ({ streams: [] }),
    search: async () => {
      searchedByAdapter.push(sid);
      return { items: [], pagination: { page: 1, pages: 1, size: 20, total: 0 } };
    },
  });
  const failures: string[] = [];
  /* 契约适配（3.3.0 接通批）：静默出局的接棒源改 feedheiliao
   * （51chigua 已接线搜索段、不再出局）；断言语义不变。 */
  await fanoutSearch("静默", [def("feedheiliao"), def("huangguo")], (d) => stub(d.id), {
    onFailure: (sid) => { failures.push(sid); },
  });
  assert.deepEqual(searchedByAdapter, ["huangguo"], "扇出只真搜具备搜索段的源（黑料网无搜索段未被调用）");
  assert.deepEqual(failures, [], "缺段源是资格出局、不是失败：不留失败痕（静默性）");
}

/* ── Shorties 断链夹具（真站 HTML 节录）：模板 search 产物全是建议词＋占位封面 ── */
{
  setFetchPage(async () => fx("pornhub-homepage-trending.html"));
  const a = createHlsSiteAdapter(SHORTIES_DEF);
  const r = await a.search!("3p", 1, 20);
  assert.ok(r.items.length > 0, "模板 search 在首页节录上仍能「搜出」条目（问题不在零结果）");
  for (const it of r.items) {
    assert.ok(it.externalId.includes("/video/search?search="), "条目实为热门搜索建议词链接、不是视频详情页");
    assert.equal(it.cover, "https://www.pornhub.com/shorties", "无 img 锚点封面被 absUrl(base,\"\") 填成 base 本身（HTML 页 URL）→ 解码失败呈 HG 占位");
  }
}
{
  const page = fx("pornhub-shorties-json.html");
  assert.ok(page.includes("JSON_SHORTIES"), "真站 shorties 条目数据在 JSON_SHORTIES 内嵌 JS 里");
  setFetchPage(async () => page);
  const a = createHlsSiteAdapter(SHORTIES_DEF);
  /* 断言适配（协调者合并 F2 时）：F2 的 SourceParseEmptyError 已把
   * 「取到页解析零条目」从静默空列表改为显式抛错——零条目这一事实
   * 不变，呈现形态按新契约断言（抛错即证解析零条目）。 */
  await assert.rejects(() => a.list(1, 20), /解析失败|SourceParseEmptyError|未解析到条目/,
    "锚点模板对真站 shorties 页解析零条目（详情/取流段同样无从谈起）");
  assert.equal(searchPolicyFor(SHORTIES_DEF).include, false, "Shorties 处置口径不变：无搜索段声明、不进扇出（3.2.2 起源已摘除注册表）");
}

console.log("fix321-f5.contract: all assertions passed");
