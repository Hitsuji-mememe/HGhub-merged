/**
 * 吃瓜正文「提取—重构」阅读层回归（Muse 2026-11-19 fix330/reader，
 * 任务书即维护者对新增测试的授权，AGENTS 不变量 11）。
 *
 * 被测：src/features/sources/articleBlocks.ts 的 extractArticleBlocks
 * ——不再清洗原文 HTML，而是从适配器 detail 的 contentHtml 按文档
 * 顺序提取内容块（文本段落／图片）原生重渲染；广告位/假按钮/导航/
 * 评论/相关推荐/分享件在提取层不入块，段级过滤只杀高置信垃圾
 * （防走失/地址发布、加群/下载 App 引导、与标题或正文重复段）。
 *
 * 夹具按三源真站形态构造（脱敏：域名/图床均为 example 占位）：
 * source-003＝<article> 容器＋z-image-loader-url 无 src 内容图；
 * source-004＝editormd-preview 容器＋相对占位 src＋z-image-loader-url；
 * source-005＝entry-content 容器＋<br> 分段＋data-xkrkllgl 插件图。
 * 对照口径：同夹具过旧链 sanitizeHtml 时垃圾文本仍在（旧红对照），
 * 且图片地址集合与 post-images 修复后的清洗链输出逐一相等。
 */
import { LOCAL } from "../src/shared/api/api";
import { sanitizeHtml, setStrictSecurity } from "../src/shared/lib/html";
import { extractArticleBlocks as extractRaw, type ArticleBlock } from "../src/features/sources/articleBlocks";

/* 夹具只断言块序列本身；located 降级口径在报告中另行说明。 */
const extractArticleBlocks = (html: string, opts?: { base?: string; title?: string }): ArticleBlock[] =>
  extractRaw(html, opts).blocks;

setStrictSecurity(true);

const results: { name: string; passed: boolean; error?: string }[] = [];
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
async function test(name: string, run: () => void | Promise<void>) {
  try { await run(); results.push({ name, passed: true }); }
  catch (e) { results.push({ name, passed: false, error: String(e) }); }
}

const proxied = (u: string) => `${LOCAL}/img?u=${encodeURIComponent(u)}`;
const texts = (bs: ArticleBlock[]) => bs.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
const images = (bs: ArticleBlock[]) => bs.filter((b) => b.type === "image").map((b) => (b as { src: string }).src);
const shape = (bs: ArticleBlock[]) => bs.map((b) => (b.type === "text" ? "T" : "I")).join(",");
const sanitizedImgSrcs = (html: string, base: string) => {
  const doc = new DOMParser().parseFromString(sanitizeHtml(html, base), "text/html");
  return [...doc.querySelectorAll("img")].map((i) => i.getAttribute("src") ?? "");
};
const sanitizedText = (html: string, base: string) =>
  new DOMParser().parseFromString(sanitizeHtml(html, base), "text/html").body.textContent ?? "";
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/* ── source-003 形态：<article>＋无 src 的 loader 图＋全套垃圾件 ── */
const BASE_003 = "https://source-003.example/archives/1001/";
const FIX_003 = `<article>
  <p>第一段正文，讲述事情的经过。</p>
  <p>第二段正文，补充了细节。</p>
  <div class="ad-banner"><p>广告位招商，点击了解详情</p></div>
  <p><img z-image-loader-url="https://img.example-cdn.com/a/1.jpg"></p>
  <p>第三段正文，继续叙述。</p>
  <a class="btn-download" href="https://dl.example.com/app.apk">点击下载APP</a>
  <p>本站永久地址：example.com，防走失请收藏本站地址发布页</p>
  <p>第三段正文，继续叙述。</p>
  <div class="share-box"><span>分享到微信</span></div>
  <div class="related-posts"><p>相关推荐</p><a href="/archives/2/">另一篇</a></div>
  <p>最后一段正文，事情有了结果。</p>
</article>`;

await test("003 shape: only body text+image blocks, in document order", () => {
  const bs = extractArticleBlocks(FIX_003, { base: BASE_003 });
  assert(shape(bs) === "T,T,I,T,T", `shape=${shape(bs)}`);
  assert(JSON.stringify(texts(bs)) === JSON.stringify([
    "第一段正文，讲述事情的经过。",
    "第二段正文，补充了细节。",
    "第三段正文，继续叙述。",
    "最后一段正文，事情有了结果。",
  ]), `texts=${JSON.stringify(texts(bs))}`);
  assert(JSON.stringify(images(bs)) === JSON.stringify([proxied("https://img.example-cdn.com/a/1.jpg")]), "image block mismatch");
});

await test("003 shape: junk segments never enter blocks", () => {
  const joined = texts(extractArticleBlocks(FIX_003, { base: BASE_003 })).join("\n");
  for (const junk of ["广告位招商", "点击下载", "防走失", "相关推荐", "分享到", "另一篇"]) {
    assert(!joined.includes(junk), `junk survived: ${junk}`);
  }
});

await test("003 shape: old sanitize path keeps the junk (defect contrast)", () => {
  const old = sanitizedText(FIX_003, BASE_003);
  assert(old.includes("防走失") && old.includes("相关推荐"), "old path unexpectedly clean");
});

await test("003 shape: image address set equals post-images chain output", () => {
  const bs = extractArticleBlocks(FIX_003, { base: BASE_003 });
  assert(sameSet(images(bs), sanitizedImgSrcs(FIX_003, BASE_003)), "image sets differ");
});

/* ── source-004 形态：editormd-preview＋占位 src＋加群段 ── */
const BASE_004 = "https://source-004.example/archives/2002/";
const FIX_004 = `<div class="editormd-preview">
  <p>黑料风格正文第一段。</p>
  <p><img src="/static/pc/img/placeholder.png" z-image-loader-url="https://img.example-cdn.com/b/2.jpg" data-image-zoom="https://img.example-cdn.com/b/2.jpg"></p>
  <p>正文第二段，内容继续。</p>
  <p>加群看更多：群号 123456，每日更新</p>
  <p>正文第三段，结尾。</p>
</div>`;

await test("004 shape: loader address wins over placeholder, group-guide dropped", () => {
  const bs = extractArticleBlocks(FIX_004, { base: BASE_004 });
  assert(shape(bs) === "T,I,T,T", `shape=${shape(bs)}`);
  assert(JSON.stringify(texts(bs)) === JSON.stringify([
    "黑料风格正文第一段。",
    "正文第二段，内容继续。",
    "正文第三段，结尾。",
  ]), `texts=${JSON.stringify(texts(bs))}`);
  assert(JSON.stringify(images(bs)) === JSON.stringify([proxied("https://img.example-cdn.com/b/2.jpg")]), "image block mismatch");
  assert(sameSet(images(bs), sanitizedImgSrcs(FIX_004, BASE_004)), "image sets differ");
});

/* ── source-005 形态：entry-content＋<br> 分段＋插件属性图＋页内导航 ── */
const BASE_005 = "https://source-005.example/archives/3003/";
const FIX_005 = `<div class="entry-content">
  正文第一段，用换行分隔。<br><br>
  <img src="/usr/plugins/tbxw/zw.png" data-xkrkllgl="https://img.example-cdn.com/c/3.jpg">
  正文第二段，紧跟图片之后。<br>
  <nav class="post-nav"><a href="/prev">上一篇</a><a href="/next">下一篇</a></nav>
  正文第三段，收尾。
  <p>扫码进群，第一时间更新</p>
</div>`;

await test("005 shape: br-separated text extracted, nav excluded, scan-guide dropped", () => {
  const bs = extractArticleBlocks(FIX_005, { base: BASE_005 });
  assert(shape(bs) === "T,I,T,T", `shape=${shape(bs)}`);
  assert(JSON.stringify(texts(bs)) === JSON.stringify([
    "正文第一段，用换行分隔。",
    "正文第二段，紧跟图片之后。",
    "正文第三段，收尾。",
  ]), `texts=${JSON.stringify(texts(bs))}`);
  assert(JSON.stringify(images(bs)) === JSON.stringify([proxied("https://img.example-cdn.com/c/3.jpg")]), "image block mismatch");
  assert(sameSet(images(bs), sanitizedImgSrcs(FIX_005, BASE_005)), "image sets differ");
});

/* ── 反例：形似垃圾的正文必须全保留（红线＝不误删） ── */
const FIX_KEEP = `<article>
  <h2>章节标题</h2>
  <p>他在微信群里发了一张照片，长辈们纷纷点赞，这件事后来在家族里传了很久，他自己也觉得好笑，每次聚会都要被拿出来说上一遍才算完。</p>
  <p>本文所说的域名，是指互联网上用于标识服务器位置的名称，和现实中的门牌地址是一个道理，理解了这一点就不难明白为什么网站换域名之后老用户会找不到入口了。</p>
  <p>他把录好的视频下载到手机里，准备路上慢慢看。</p>
  <p>第三段正文，继续叙述。</p>
  <p>第三段正文，继续叙述了不同的后续。</p>
</article>`;

await test("counter-examples: narrative look-alikes all survive", () => {
  const bs = extractArticleBlocks(FIX_KEEP, { base: BASE_003 });
  const ts = texts(bs);
  assert(ts.length === 6, `kept ${ts.length}/6: ${JSON.stringify(ts)}`);
  assert(ts[0] === "章节标题" && (bs[0] as { heading?: boolean }).heading === true, "heading block lost");
  assert(ts.some((t) => t.includes("微信群里发了一张照片")), "group narrative dropped");
  assert(ts.some((t) => t.includes("本文所说的域名")), "domain explainer dropped");
  assert(ts.some((t) => t.includes("下载到手机里")), "plain download narrative dropped");
  assert(ts.filter((t) => t.startsWith("第三段正文")).length === 2, "near-duplicate wrongly deduped");
});

/* ── 与标题重复段去重 ── */
await test("title repeat at body head is dropped", () => {
  const bs = extractArticleBlocks(
    `<article><p>示例标题</p><p>真正的第一段。</p></article>`,
    { base: BASE_003, title: "示例标题" },
  );
  assert(JSON.stringify(texts(bs)) === JSON.stringify(["真正的第一段。"]), `texts=${JSON.stringify(texts(bs))}`);
});

/* ── 相关推荐容器内的图片不入块 ── */
await test("image inside related container is excluded", () => {
  const bs = extractArticleBlocks(`<div class="entry-content">
    <p>正文一段。</p>
    <div class="related"><img src="https://img.example-cdn.com/r/9.jpg"><p>猜你喜欢</p></div>
    <p>正文二段。</p>
  </div>`, { base: BASE_003 });
  assert(JSON.stringify(texts(bs)) === JSON.stringify(["正文一段。", "正文二段。"]), `texts=${JSON.stringify(texts(bs))}`);
  assert(images(bs).length === 0, "related image entered blocks");
});

/* ── 容器被垃圾类名误包时，密度保底仍能提取 ── */
await test("fallback: body wrapped in share-class container still extracted", () => {
  const bs = extractArticleBlocks(
    `<div class="share-content"><p>被分享容器包住的正文。</p></div>`,
    { base: BASE_003 },
  );
  assert(JSON.stringify(texts(bs)) === JSON.stringify(["被分享容器包住的正文。"]), `texts=${JSON.stringify(texts(bs))}`);
});

/* ── 安全门继承：私网/非法图片地址不入块 ── */
await test("strict security gate still applies to extracted images", () => {
  const bs = extractArticleBlocks(`<article>
    <p>正文。</p>
    <img data-src="http://127.0.0.1:8080/x.jpg">
    <img src="https://img.example-cdn.com/safe/1.jpg">
  </article>`, { base: BASE_003 });
  assert(JSON.stringify(images(bs)) === JSON.stringify([proxied("https://img.example-cdn.com/safe/1.jpg")]),
    `images=${JSON.stringify(images(bs))}`);
});

/* ── 空/纯脚本输入不产块 ── */
await test("empty and script-only input yields no blocks", () => {
  assert(extractArticleBlocks("", { base: BASE_003 }).length === 0, "empty input produced blocks");
  assert(extractArticleBlocks(`<div><script>var x = 1;</script></div>`, { base: BASE_003 }).length === 0,
    "script-only input produced blocks");
});

const report = { passed: results.filter((r) => r.passed).length, failed: results.filter((r) => !r.passed).length, results };
document.querySelector("#results")!.textContent = JSON.stringify(report, null, 2);
(window as unknown as { readerResults: typeof report }).readerResults = report;
