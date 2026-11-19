/**
 * 3.2.1 修复 F5 线契约测试（Muse 2026-11-19，用户实报：搜「3p」视频
 * 页签里 Pornhub Shorties 结果封面全是 HG 占位图、有的点开播不了）。
 * 任务书即维护者对新增测试的授权（AGENTS 不变量 11）。
 * 运行：node src/features/search/fix321-f5.contract.test.ts
 *
 * 钉住的口径——搜索扇出资格＝三段齐全（见 multiSourceSearch.ts 的
 * missingSearchSegments）：搜索段（capabilities.search 为真且模板真有
 * search）、详情段与取流段（模板真有 detail/resolve 且 maturity=stable
 * ——types.ts 定义 stable=真站实测三段全通、probe=部分未证）、且模板
 * 参数非未校准骨架（note 不含「未按真站校准」）。INCLUDE_OVERRIDE 只
 * 能在三段齐全者中生效，不得再绕过三段门。源不删、频道浏览不受此限。
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

  const unverified = mkDef({ maturity: "probe", note: "真站实测：详情无流、取流接口未验证 → probe（合成夹具）" });
  assert.ok(missingSearchSegments(unverified).includes("detail"), "probe（未验通）→ 详情段不算真实现");
  assert.ok(missingSearchSegments(unverified).includes("play"), "probe（未验通）→ 取流段不算真实现");
  assert.equal(searchPolicyFor(unverified).include, false, "三段未验通：不进扇出（搜得出≠播得了）");

  const skeleton = mkDef({ maturity: "probe", capabilities: { ...NO_CAPS }, note: SKELETON_NOTE });
  assert.ok(missingSearchSegments(skeleton).includes("search"), "未校准骨架 → 缺搜索段");
  assert.equal(searchPolicyFor(skeleton).include, false, "未校准骨架源：不进扇出");

  const blocked = mkDef({ maturity: "blocked", note: "真站实测 blocked（合成夹具）" });
  assert.equal(searchPolicyFor(blocked).include, false, "blocked：不进扇出");
}

/* ── INCLUDE_OVERRIDE 只能在三段齐全者中生效，不得绕过三段门 ── */
{
  const overrideComplete = mkDef({ id: "supjav", enabled: false });
  assert.equal(searchPolicyFor(overrideComplete).include, true, "override 源三段齐全时：enabled=false 仍可经 override 进扇出");
  const overrideSkeleton = mkDef({
    id: "shorties", enabled: false, maturity: "probe", capabilities: { ...NO_CAPS },
    adapter: { template: "hls-site", params: { listPath: "/?page={page}", itemLinkPattern: "/video/", detailPath: "/video/{id}" } },
    note: SKELETON_NOTE,
  });
  assert.equal(searchPolicyFor(overrideSkeleton).include, false, "override 源缺段时：override 不得绕过三段门");
}

/* ── 注册表全量遍历：扇出名单恰为三段验通的 7 源 ── */
{
  const included = getBuiltinRegistry().filter((d) => searchPolicyFor(d).include).map((d) => d.id);
  assert.deepEqual(
    included,
    ["huangguo", "91video", "pornhub", "xvideos", "fyptt", "rule34video", "cosplaytele"],
    "扇出名单=三段全通源（与 2026-11-19 真站实测 7 个可用源一致）",
  );

  /* 基线（修复前）曾进扇出、因缺段被移出的 13 源：逐源断言出局＋缺段非空 */
  const removed: Record<string, SearchSegment[]> = {
    rouvideo: ["detail", "play"],        // probe：列表数据接口未定位
    "hanime-tv": ["detail", "play"],     // probe：详情无流、取流接口未验证
    swag: ["detail", "play"],            // probe：SSR 无条目、取流需登录态
    redgifs: ["detail", "play"],         // probe：官方 API 401、取页契约不支持 header
    fc2: ["search", "detail", "play"],   // 未实测＋通用骨架未校准
    "51chigua": ["search", "detail", "play"], // blocked＋NO_CAPS（旧 override 绕过）
    meiridasai: ["search", "detail", "play"], // blocked＋NO_CAPS（旧 override 绕过）
    pornpics: ["detail", "play"],        // probe：SSR 无图集锚点、前端渲染
    feedheiliao: ["search", "detail", "play"], // 目录骨架＋NO_CAPS（旧 override 绕过）
    av123: ["search", "detail", "play"],       // 目录骨架＋NO_CAPS（旧 override 绕过）
    supjav: ["search", "detail", "play"],      // 目录骨架＋NO_CAPS（旧 override 绕过）
    shorties: ["search", "detail", "play"],    // 目录骨架＋NO_CAPS（旧 override 绕过）
    "rouvideo-drama": ["search", "detail", "play"], // 目录骨架＋NO_CAPS（旧 override 绕过）
  };
  for (const [id, segs] of Object.entries(removed)) {
    const p = searchPolicyFor(def(id));
    assert.equal(p.include, false, `${id} 因缺段移出扇出`);
    assert.ok(p.reason.includes("三段"), `${id} 出局理由标明三段门`);
    const missing = missingSearchSegments(def(id));
    for (const s of segs) assert.ok(missing.includes(s), `${id} 缺段含 ${s}（实际 ${missing.join("/")}）`);
  }
  /* 被移出的源注册保留（不删源）：仍在注册表里、频道浏览口径不受扇出门影响 */
  for (const id of Object.keys(removed)) assert.ok(def(id), `${id} 注册保留`);
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
  await fanoutSearch("静默", [def("shorties"), def("pornhub")], (d) => stub(d.id), {
    onFailure: (sid) => { failures.push(sid); },
  });
  assert.deepEqual(searchedByAdapter, ["pornhub"], "扇出只真搜三段齐全源（shorties 未被调用）");
  assert.deepEqual(failures, [], "缺段源是资格出局、不是失败：不留失败痕（静默性）");
}

/* ── Shorties 断链夹具（真站 HTML 节录）：模板 search 产物全是建议词＋占位封面 ── */
{
  setFetchPage(async () => fx("pornhub-homepage-trending.html"));
  const a = createHlsSiteAdapter(def("shorties"));
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
  const a = createHlsSiteAdapter(def("shorties"));
  const l = await a.list(1, 20);
  assert.equal(l.items.length, 0, "锚点模板对真站 shorties 页解析零条目（详情/取流段同样无从谈起）");
  assert.equal(searchPolicyFor(def("shorties")).include, false, "Shorties 处置：移出搜索扇出（源保留）");
}

console.log("fix321-f5.contract: all assertions passed");
