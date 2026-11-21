/* fix3310/jw-extract 契约：020（wp-rest＋jwFile opt-in）的 JW Player
 * setup 小解析专属覆盖——extractJwFile/extractJwImage 的字段语义、
 * wp-rest 模板在声明 jwFile 时的 resolve 优先序与封面回落、未声明
 * 源逐字旧行为。
 *
 * 本文件的新增由 fix3310 集成线任务书（维护者裁定）批准（仓库不
 * 变量 11：新增测试须先经维护者同意，同意记录即该任务书第 2 条）。
 * 接线线当时无同意记录未建此契约、JW 行为以生产路径实拉为据
 * （fix3310/evidence/video-add-2.md 偏离账 2），本批补建。
 * 旧码先红：接线基点 fix3310/file-playback-leg @26ef439 的 parse.ts
 * 无 extractJwFile/extractJwImage 导出（本文件在该树 exit 1），且
 * 同夹具下旧 wp-rest resolve 对 JW 正文返回空流（集成报告附探针
 * 输出）。不访问真实网络：取页经 setFetchPage 注入内联夹具（形
 * 态据候选实拉证据：JW setup 的 file:/image: 字段、文件名含字面
 * 空格，见 fix339/evidence/video-candidates.md）。 */
import assert from "node:assert/strict";
import { getBuiltinRegistry } from "./registry.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { extractJwFile, extractJwImage, extractMp4 } from "./adapters/parse.ts";
import { createWpRestAdapter } from "./adapters/templates.ts";
import type { SourceDef } from "./types.ts";

const registry = getBuiltinRegistry();
const byId = (id: string): SourceDef => {
  const def = registry.find((s) => s.id === id);
  assert.ok(def, `注册表含 ${id}`);
  return def;
};

/* JW 正文样本：file/image 均含字面空格（站方原串形态）；正文另散
 * 落一条无空格的普通 mp4 链接——JW 声明源必须以 setup file 为准
 * （播放器事实源优先于正文散落链接）。 */
const JW_FILE_RAW = "https://files.example.com/media/Some Title Episode 1.mp4";
const JW_FILE_ENC = "https://files.example.com/media/Some%20Title%20Episode%201.mp4";
const JW_IMG_RAW = "https://files.example.com/thumbs/Some Title Cover.jpg";
const JW_IMG_ENC = "https://files.example.com/thumbs/Some%20Title%20Cover.jpg";
const JW_HTML = `<p>intro</p><script>jwplayer("player").setup({file:"${JW_FILE_RAW}",image:"${JW_IMG_RAW}",width:"100%",height:"100%"});</script><p><a href="https://files.example.com/other/plain.mp4">download</a></p>`;

/* ── 解析层：字段语义 ── */
{
  assert.equal(extractMp4(JW_HTML), "https://files.example.com/other/plain.mp4",
    "前提实证：stock extractMp4 只能命中无空格的散落链接、JW 的含空格 file 恒不命中（小解析承重）");
  assert.equal(extractJwFile(JW_HTML), JW_FILE_ENC, "JW file 取 setup 首个 file: 字段、空格编码 %20");
  assert.equal(extractJwImage(JW_HTML), JW_IMG_ENC, "JW image 取 setup 的 image: 字段、空格编码 %20");
  assert.equal(extractJwFile(`<script>jwplayer("p").setup({file:'https://f.example/a b.mp4'});</script>`),
    "https://f.example/a%20b.mp4", "单引号形态同口径");
  assert.equal(extractJwFile(`<script>jwplayer("p").setup({file:"https://f.example/a.mp4?token=1"});</script>`),
    "https://f.example/a.mp4?token=1", ".mp4 带查询串仍认");
  assert.equal(extractJwFile(`<script>jwplayer("p").setup({file:"https://f.example/a.m3u8"});</script>`),
    null, "file 非 .mp4 不认（m3u8 走 extractM3u8 本路）");
  assert.equal(extractJwFile(`<p>file:"https://f.example/a.mp4"</p>`), null, "无 .setup( 锚点不取");
  assert.equal(extractJwImage(`<p>no player here</p>`), null, "无 setup 时 image 为 null");
  /* setup 本体在前、其后 advertising 块的 file 不取（锚定首个
   * .setup( 后取首个同名字段）。 */
  const withAds = `<script>jwplayer("p").setup({file:"${JW_FILE_RAW}",advertising:{file:"https://ads.example/ad.mp4"}});</script>`;
  assert.equal(extractJwFile(withAds), JW_FILE_ENC, "取 setup 本体的 file、不取其后 advertising 块");
  /* 字段超出锚点后 4000 字窗口不取（setup 对象本体应在窗口内）。 */
  const far = `<script>jwplayer("p").setup({${"x:".padEnd(4100, "1")}file:"https://f.example/a.mp4"});</script>`;
  assert.equal(extractJwFile(far), null, "file: 超出 4000 字窗口不取");
}

/* ── 注册形态：020 声明 jwFile、021 不声明 ── */
{
  const g = byId("hentaigasm");
  const p = byId("hentaiplay");
  assert.equal(g.adapter.template, "wp-rest", "020 走 wp-rest 模板");
  assert.equal((g.adapter.params as Record<string, unknown>).jwFile, true, "020 声明 jwFile=true");
  assert.equal((p.adapter.params as Record<string, unknown> | undefined)?.jwFile, undefined, "021 不声明 jwFile（stock extractMp4 直命中）");
}

/* ── 适配器层：声明源 resolve 走 JW、封面回落 JW image ── */
const post = {
  id: 777, link: "https://hentaigasm.example/777",
  title: { rendered: "JW 夹具帖" },
  content: { rendered: JW_HTML },
  excerpt: { rendered: "<p>无图摘要</p>" },
  categories: [], tags: [],
};
const stubPost = () => setFetchPage(async (url) => {
  if (url.includes("/categories") || url.includes("/tags")) return "[]";
  if (url.includes("/posts/777")) return JSON.stringify(post);
  if (url.includes("/posts")) return JSON.stringify([post]);
  throw new Error(`未预期取页 ${url}`);
});
{
  stubPost();
  const def = byId("hentaigasm");
  const a = createWpRestAdapter(def);
  const resolved = await a.resolve("777");
  assert.deepEqual(resolved.streams, [{ url: JW_FILE_ENC, kind: "file" }],
    "声明 jwFile：resolve 取 JW file（%20 编码、kind=file）、优先于正文散落 mp4");
  const list = await a.list(1, 20);
  assert.equal(list.items[0].cover, JW_IMG_ENC, "封面 <img> 落空时回落 JW image（%20 编码）");
  const detail = await a.detail("777");
  assert.equal(detail.cover, JW_IMG_ENC, "详情封面同回落 JW image");
}

/* ── 适配器层：未声明源同夹具逐字旧行为（JW 段不可达） ── */
{
  stubPost();
  const declared = byId("hentaigasm");
  const legacyDef: SourceDef = {
    ...declared,
    id: "jw-legacy-control",
    adapter: { template: "wp-rest", params: { ...(declared.adapter.params ?? {}), jwFile: false } },
  };
  const a = createWpRestAdapter(legacyDef);
  const resolved = await a.resolve("777");
  assert.deepEqual(resolved.streams, [{ url: "https://files.example.com/other/plain.mp4", kind: "file" }],
    "未声明 jwFile：resolve 只走 stock extractMp4、JW file 不可达（旧行为）");
  const list = await a.list(1, 20);
  assert.equal(list.items[0].cover, "", "未声明 jwFile：无 <img> 时封面为空、不回落 JW image（旧行为）");
}

/* ── 适配器层：m3u8 优先序不变（JW 不抢 HLS 本路） ── */
{
  const hlsPost = {
    ...post, id: 778,
    content: { rendered: `<script>jwplayer("p").setup({file:"${JW_FILE_RAW}"});</script><video src="https://cdn.example.com/live/index.m3u8"></video>` },
  };
  setFetchPage(async (url) => {
    if (url.includes("/categories") || url.includes("/tags")) return "[]";
    if (url.includes("/posts/778")) return JSON.stringify(hlsPost);
    throw new Error(`未预期取页 ${url}`);
  });
  const a = createWpRestAdapter(byId("hentaigasm"));
  const resolved = await a.resolve("778");
  assert.deepEqual(resolved.streams, [{ url: "https://cdn.example.com/live/index.m3u8", kind: "hls" }],
    "正文含 m3u8 时仍走 HLS 本路、JW file 不抢占");
}

console.log("fix3310-jw-extract contract ok");
