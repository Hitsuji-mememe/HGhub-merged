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

/* ── 3.3.2 reader-filter2：真机漏杀两类形态（脱敏构造，形态等价） ── */

/* ⑦ 关键词墙·整段形态：空格分隔的短词元堆砌、无句读，现行规则因
 * 其为长段全部放行（基线红）。 */
const FIX_WALL = `<article>
  <p>正文第一段，交代事情的起因。</p>
  <p>免费短剧 免费小说 免费漫画 高清影视 在线直播 手机投注 体育投注 棋牌娱乐 真人视讯 电子游艺 彩票投注 注册礼金 首存优惠 极速提款 同城交友 视频聊天</p>
  <p>正文第二段，事情有了结果。</p>
</article>`;

await test("filter2: keyword wall paragraph dropped, body kept", () => {
  const bs = extractArticleBlocks(FIX_WALL, { base: BASE_003 });
  assert(JSON.stringify(texts(bs)) === JSON.stringify([
    "正文第一段，交代事情的起因。",
    "正文第二段，事情有了结果。",
  ]), `texts=${JSON.stringify(texts(bs))}`);
});

/* ⑦ 关键词墙·分行形态：<br> 分成两行，每行单独不满整段门槛，
 * 成组判读才杀（基线红）。 */
const FIX_WALL_LINES = `<div class="entry-content">
  正文开头段落，说明背景。<br>
  免费短剧 免费小说 免费漫画 高清影视 在线直播 手机投注<br>
  体育投注 棋牌娱乐 真人视讯 电子游艺 彩票投注 注册礼金<br>
  正文结尾段落，说明结果。
</div>`;

await test("filter2: br-split keyword wall lines dropped as a group", () => {
  const bs = extractArticleBlocks(FIX_WALL_LINES, { base: BASE_005 });
  assert(JSON.stringify(texts(bs)) === JSON.stringify([
    "正文开头段落，说明背景。",
    "正文结尾段落，说明结果。",
  ]), `texts=${JSON.stringify(texts(bs))}`);
});

/* ⑧ 地址发布块·行组形态：带标签的 URL/邮箱连续行组＋播放 CTA 行，
 * 现行规则只认裸域名行与短段话术、整组漏过（基线红）。 */
const FIX_ADDR_GROUP = `<article>
  <p>正文第一段，讲述事情经过。</p>
  <p>👉 国内：https://addr-a.example.com</p>
  <p>📩 邮箱：tips@mail.example.org</p>
  <p>🌍 海外：https://addr-b.example.net</p>
  <p>🔒 永久：https://addr-c.example.com</p>
  <p>🎬 播放异常？刷新页面或使用示例APP重试</p>
  <p>正文第二段，事情有了结果。</p>
</article>`;

await test("filter2: labeled address-publish line group dropped as a group", () => {
  const bs = extractArticleBlocks(FIX_ADDR_GROUP, { base: BASE_003 });
  assert(JSON.stringify(texts(bs)) === JSON.stringify([
    "正文第一段，讲述事情经过。",
    "正文第二段，事情有了结果。",
  ]), `texts=${JSON.stringify(texts(bs))}`);
});

/* ⑧ 地址发布块·单块形态：行组写进同一段、提取时空白折叠成一整块
 * （基线红）。 */
const FIX_ADDR_BLOCK = `<article>
  <p>正文第一段，讲述事情经过。</p>
  <p>👉 国内： https://addr-a.example.com 📩 邮箱： tips@mail.example.org 🌍 海外： https://addr-b.example.net 🔒 永久： https://addr-c.example.com</p>
  <p>正文第二段，事情有了结果。</p>
</article>`;

await test("filter2: address-publish merged into one block dropped", () => {
  const bs = extractArticleBlocks(FIX_ADDR_BLOCK, { base: BASE_003 });
  assert(JSON.stringify(texts(bs)) === JSON.stringify([
    "正文第一段，讲述事情经过。",
    "正文第二段，事情有了结果。",
  ]), `texts=${JSON.stringify(texts(bs))}`);
});

/* 反例：正常列举多个网址的科普/导航段——有完整句子、非发布口径，
 * 必须保留（红线）。 */
const FIX_KEEP_URLS = `<article>
  <p>挑选镜像站时可以看三点：甲站（https://mirror-a.example.com）更新最快，乙站（https://mirror-b.example.com）界面最清爽，丙站（https://mirror-c.example.com）胜在稳定。三个站的内容完全同步，读者按自己的网络情况任选其一即可，收藏哪一个都不影响后续的阅读进度。</p>
  <p>他把网址抄在笔记本上，还特意标注了每个站的特点，方便下次直接打开。</p>
</article>`;

await test("filter2 counter-example: multi-URL explainer with full sentences survives", () => {
  const bs = extractArticleBlocks(FIX_KEEP_URLS, { base: BASE_003 });
  const ts = texts(bs);
  assert(ts.length === 2, `kept ${ts.length}/2: ${JSON.stringify(ts)}`);
  assert(ts[0].includes("挑选镜像站时可以看三点"), "explainer dropped");
  assert(ts[1].includes("把网址抄在笔记本上"), "narrative dropped");
});

/* 反例：人物对白式短句连排——连续短行成组但无联系点无标签，
 * 必须整组保留（红线）。 */
const FIX_KEEP_DIALOG = `<article>
  <p>正文引入段，交代场景。</p>
  <p>「你来了？」</p>
  <p>「嗯，刚到，路上有点堵。」</p>
  <p>「东西都带齐了吗？」</p>
  <p>「带齐了，清单核对过两遍。」</p>
  <p>「那就出发吧，别让大家等太久。」</p>
  <p>正文收尾段，事情告一段落。</p>
</article>`;

await test("filter2 counter-example: dialogue short-line run survives intact", () => {
  const bs = extractArticleBlocks(FIX_KEEP_DIALOG, { base: BASE_003 });
  const ts = texts(bs);
  assert(ts.length === 7, `kept ${ts.length}/7: ${JSON.stringify(ts)}`);
  assert(ts.some((t) => t.includes("东西都带齐了吗")), "dialogue line dropped");
});

/* 反例：叙事吐槽句提到播放失败与 app，但无处置动词，不是 CTA，
 * 必须保留（红线）。 */
await test("filter2 counter-example: playback-failure complaint narrative survives", () => {
  const bs = extractArticleBlocks(
    `<article><p>他吐槽这个app老是播放失败，气得直接卸载了，再也不想用了。</p></article>`,
    { base: BASE_003 },
  );
  assert(JSON.stringify(texts(bs)) === JSON.stringify([
    "他吐槽这个app老是播放失败，气得直接卸载了，再也不想用了。",
  ]), `texts=${JSON.stringify(texts(bs))}`);
});

/* ── 3.3.2 普查形态：头部模板块（同源跨帖雷同的整块站务模板） ── */

/* ⑨ source-004 形态：标签行（冒号结尾）与值行（裸域名/URL）交替
 * 分行＋APP 填充行＋占位邮箱行，逐行判读必然漏行、值行被杀后只
 * 剩孤儿标签行组——按块整段杀（基线红：标签行全存活）。 */
const FIX_TEMPLATE_ALT = `<div class="editormd-preview">
  <p>示例站最新入口（中转）：</p>
  <p>mirror-a.example.com</p>
  <p>示例站海外主站：</p>
  <p>https://main.example.com</p>
  <p>示例站海外中转：</p>
  <p>mirror-b.example.com</p>
  <p>示例 APP 免费看，下载还能拿福利</p>
  <p>获取最新地址：发送任意内容至邮箱</p>
  <p>[email protected]</p>
  <p>唯一官方商务合作：</p>
  <p>https://chat.example.com/abc123</p>
  <p>正文第一段开始讲述事情的来龙去脉，这一段文字足够长，带有完整的句子和标点，正是用来标示正文起点位置的段落。</p>
  <p>正文第二段，内容继续展开。</p>
</div>`;

await test("filter2: alternating label/value head template dropped as a block", () => {
  const bs = extractArticleBlocks(FIX_TEMPLATE_ALT, { base: BASE_004 });
  assert(JSON.stringify(texts(bs)) === JSON.stringify([
    "正文第一段开始讲述事情的来龙去脉，这一段文字足够长，带有完整的句子和标点，正是用来标示正文起点位置的段落。",
    "正文第二段，内容继续展开。",
  ]), `texts=${JSON.stringify(texts(bs))}`);
});

/* ⑨ source-005 形态：标签与 URL 同行＋浏览器推荐填充行夹在信号
 * 行之间（其后还有带域名的帖内标题行延伸模板段界）——整段杀
 * （基线红：同行地址行全存活）。 */
const FIX_TEMPLATE_INLINE = `<article>
  <p>示例站最新地址</p>
  <p>国内地址 https://addr-a.example.com</p>
  <p>获取最新地址 邮箱自动回复｜长按复制</p>
  <p>tips@mail.example.org</p>
  <p>海外地址 https://addr-b.example.com</p>
  <p>推荐浏览器 Yandex / UC / Chrome / Safari</p>
  <p>示例站（addr-b.example.com）原创视频招募详情</p>
  <p>正文第一段开始讲述事情的来龙去脉，这一段文字足够长，带有完整的句子和标点，正是用来标示正文起点位置的段落。</p>
  <p>正文第二段，内容继续展开。</p>
</article>`;

await test("filter2: inline label+URL head template dropped as a block", () => {
  const bs = extractArticleBlocks(FIX_TEMPLATE_INLINE, { base: BASE_005 });
  assert(JSON.stringify(texts(bs)) === JSON.stringify([
    "正文第一段开始讲述事情的来龙去脉，这一段文字足够长，带有完整的句子和标点，正是用来标示正文起点位置的段落。",
    "正文第二段，内容继续展开。",
  ]), `texts=${JSON.stringify(texts(bs))}`);
});

/* 尾部站务残形：播放器占位行、# 标签墙、编号式播放 CTA——逐行
 * 判据杀（基线红：三行全存活）。 */
const FIX_TAIL_JUNK = `<article>
  <p>正文第一段开始讲述事情的来龙去脉，这一段文字足够长，带有完整的句子和标点，正是用来标示正文起点位置的段落。</p>
  <p>播放器加载中...</p>
  <p>正文第二段，内容继续展开，讲述后续的发展。</p>
  <p>关键词：#标签甲 #标签乙 #标签丙 #标签丁 #标签戊 #标签己 #标签庚</p>
  <p>1视频播放异常时请尝试刷新页面；仍无法播放时，建议切换至APP</p>
  <p>正文第三段，收尾。</p>
</article>`;

await test("filter2: player placeholder, hashtag wall and numbered playback CTA dropped", () => {
  const bs = extractArticleBlocks(FIX_TAIL_JUNK, { base: BASE_003 });
  assert(JSON.stringify(texts(bs)) === JSON.stringify([
    "正文第一段开始讲述事情的来龙去脉，这一段文字足够长，带有完整的句子和标点，正是用来标示正文起点位置的段落。",
    "正文第二段，内容继续展开，讲述后续的发展。",
    "正文第三段，收尾。",
  ]), `texts=${JSON.stringify(texts(bs))}`);
});

/* ⑩ 分类导航行组：≥10 行连续超短行（栏目名单形态）在正文之后
 * 整组杀（基线红：整组存活）。 */
const FIX_NAV_RUN = `<article>
  <p>正文第一段开始讲述事情的来龙去脉，这一段文字足够长，带有完整的句子和标点，正是用来标示正文起点位置的段落。</p>
  <p>栏目甲一</p><p>栏目乙二</p><p>栏目丙三</p><p>栏目丁四</p><p>栏目戊五</p><p>栏目己六</p>
  <p>栏目庚七</p><p>栏目辛八</p><p>栏目壬九</p><p>栏目癸十</p><p>栏目子一</p><p>栏目丑二</p>
  <p>正文第二段，收尾。</p>
</article>`;

await test("filter2: ultra-short nav line run dropped as a group", () => {
  const bs = extractArticleBlocks(FIX_NAV_RUN, { base: BASE_003 });
  assert(JSON.stringify(texts(bs)) === JSON.stringify([
    "正文第一段开始讲述事情的来龙去脉，这一段文字足够长，带有完整的句子和标点，正是用来标示正文起点位置的段落。",
    "正文第二段，收尾。",
  ]), `texts=${JSON.stringify(texts(bs))}`);
});

/* 反例：章节标题行组——同为连续超短行，但都是标题块，必须全
 * 保留（⑩ 的标题资格守门）。 */
const FIX_KEEP_HEADINGS = `<article>
  <h3>第一章起</h3><h3>第二章承</h3><h3>第三章转</h3><h3>第四章合</h3><h3>第五章进</h3>
  <h3>第六章深</h3><h3>第七章变</h3><h3>第八章定</h3><h3>第九章终</h3><h3>第十章余</h3>
  <p>正文第一段开始讲述事情的来龙去脉，这一段文字足够长，带有完整的句子和标点，正是用来标示正文起点位置的段落。</p>
</article>`;

await test("filter2 counter-example: heading line run survives", () => {
  const bs = extractArticleBlocks(FIX_KEEP_HEADINGS, { base: BASE_003 });
  const ts = texts(bs);
  assert(ts.length === 11, `kept ${ts.length}/11: ${JSON.stringify(ts)}`);
  assert(ts.some((t) => t.includes("第五章进")), "heading dropped");
});

/* 反例：带标点的短行组——每行都有句读，是正文的分行短句，必须
 * 全保留（⑩/⑨ 的句读守门）。 */
const FIX_KEEP_PUNCT_LINES = `<article>
  <p>他推开门，看见屋里坐满了人。</p>
  <p>大家都抬起头，望向门口。</p>
  <p>他愣了一下，随即笑了起来。</p>
  <p>屋里的气氛，一下子热闹起来。</p>
  <p>有人给他让座，有人递茶。</p>
  <p>他坐下来，慢慢讲起经过。</p>
  <p>众人听得入神，不时点头。</p>
  <p>窗外起了风，吹动了帘子。</p>
  <p>他讲完最后一句，停了下来。</p>
  <p>屋里安静了片刻，随后掌声响起。</p>
  <p>正文最后一段开始收束全文，这一段文字足够长，带有完整的句子和标点，用来标示正文的结尾位置。</p>
</article>`;

await test("filter2 counter-example: punctuated short-line narrative survives", () => {
  const bs = extractArticleBlocks(FIX_KEEP_PUNCT_LINES, { base: BASE_003 });
  const ts = texts(bs);
  assert(ts.length === 11, `kept ${ts.length}/11: ${JSON.stringify(ts)}`);
});

/* ── 第三轮（3.3.3 批）：3.3.2 真机验收两帖漏杀形态 ─────────────
 * 证据：fix333/evidence/reader3.md（复现对账表）。判据全部走结构
 * 形态（问答编号交替、尾部模板区、标签容器、显式标签关键词墙、
 * 下载 CTA 短行句式），不照单帖字面写关键词表；每条判据都配正文
 * 反例形态钉住不许误伤。 */

/* ⑪ FAQ 问答块：模板小节头＋编号 Q/A 交替 ≥2 对（003 真机形态）。
 * 正文段落与图片必须保留，问答块与小节头整组消失。 */
const FIX3_FAQ = `<article>
  <p>正文第一段开始讲述事情的来龙去脉，这一段文字足够长，带有完整的句子和标点，正是用来标示正文起点位置的段落。</p>
  <h2>常见问题解答</h2>
  <p>Q1：这位当事人是谁？</p>
  <p>A1：一位小有名气的网络红人，此前以清纯形象示人，粉丝数量不少。</p>
  <p>Q2：这次流出的内容主要是什么？</p>
  <p>A2：一段私下聚会的视频，尺度较大，与此前的公开形象形成强烈反差。</p>
  <p>Q3：为什么会引发热议？</p>
  <p>A3：与她此前公开表态形成强烈对比，人设反差本身就具备话题性。</p>
  <p><img z-image-loader-url="https://img.example.invalid/faq-1.jpg"></p>
  <p>正文最后一段开始收束全文，这一段文字足够长，带有完整的句子和标点，用来标示正文的结尾位置。</p>
</article>`;

await test("filter3: numbered FAQ block with template heading is dropped", () => {
  const bs = extractArticleBlocks(FIX3_FAQ, { base: BASE_003 });
  const ts = texts(bs);
  assert(ts.length === 2, `kept ${ts.length}/2 texts: ${JSON.stringify(ts)}`);
  assert(bs.some((b) => b.type === "image"), "body image kept");
  assert(!ts.some((t) => t.startsWith("Q1") || t.startsWith("A1") || t.includes("常见问题解答")), "faq leaked");
});

/* ⑪ 变体小节头「常见疑问解答」＋恰好 2 对同样成立。 */
const FIX3_FAQ_VARIANT = `<article>
  <p>正文第一段开始讲述事情的来龙去脉，这一段文字足够长，带有完整的句子和标点，正是用来标示正文起点位置的段落。</p>
  <h2>常见疑问解答</h2>
  <p>Q1：甲是谁？</p>
  <p>A1：一位海外创作者，以体力见长。</p>
  <p>Q2：乙是谁？</p>
  <p>A2：一位本地创作者，以真实感强的作品为主。</p>
  <p>正文最后一段开始收束全文，这一段文字足够长，带有完整的句子和标点，用来标示正文的结尾位置。</p>
</article>`;

await test("filter3: FAQ variant heading with two pairs is dropped", () => {
  const bs = extractArticleBlocks(FIX3_FAQ_VARIANT, { base: BASE_003 });
  const ts = texts(bs);
  assert(ts.length === 2, `kept ${ts.length}/2 texts: ${JSON.stringify(ts)}`);
});

/* ⑪ 反例一：无编号的访谈问答（Q：/A：）是正文体裁，必须全保留。 */
const FIX3_KEEP_INTERVIEW = `<article>
  <p>正文第一段开始讲述事情的来龙去脉，这一段文字足够长，带有完整的句子和标点，正是用来标示正文起点位置的段落。</p>
  <p>Q：你第一次意识到自己会红，是什么时候？</p>
  <p>A：其实没有想过这个问题，当时只是把日常随手发了出来。</p>
  <p>Q：后来为什么改变了风格？</p>
  <p>A：因为观众的反馈很直接，我慢慢摸到了他们喜欢的方向。</p>
  <p>正文最后一段开始收束全文，这一段文字足够长，带有完整的句子和标点，用来标示正文的结尾位置。</p>
</article>`;

await test("filter3 counter-example: unnumbered interview Q/A survives", () => {
  const bs = extractArticleBlocks(FIX3_KEEP_INTERVIEW, { base: BASE_003 });
  const ts = texts(bs);
  assert(ts.length === 6, `kept ${ts.length}/6: ${JSON.stringify(ts)}`);
});

/* ⑪ 反例二：只有一对编号问答（测验/互动）不构成模板块，必须保留。 */
const FIX3_KEEP_SINGLE_PAIR = `<article>
  <p>正文第一段开始讲述事情的来龙去脉，这一段文字足够长，带有完整的句子和标点，正是用来标示正文起点位置的段落。</p>
  <p>Q1：猜猜看，这次登上热搜第一的会是谁？</p>
  <p>A1：答案放在文末揭晓，先卖个关子。</p>
  <p>正文最后一段开始收束全文，这一段文字足够长，带有完整的句子和标点，用来标示正文的结尾位置。</p>
</article>`;

await test("filter3 counter-example: single numbered Q/A pair survives", () => {
  const bs = extractArticleBlocks(FIX3_KEEP_SINGLE_PAIR, { base: BASE_003 });
  const ts = texts(bs);
  assert(ts.length === 4, `kept ${ts.length}/4: ${JSON.stringify(ts)}`);
});

/* 标签容器：两源同构的 tags/keywords 容器（itemprop=keywords 的
 * 锚点簇）在正文里渲染成无空格关键词拼接行，必须整容器排除；
 * 容器外的正文段落保留。 */
const FIX3_TAGS_CONTAINER = `<article>
  <p>正文第一段开始讲述事情的来龙去脉，这一段文字足够长，带有完整的句子和标点，正是用来标示正文起点位置的段落。</p>
  <div class="tags"><div itemprop="keywords" class="keywords AbCdEf"><a href="/tag/a/">甲词</a><a href="/tag/b/">乙词</a><a href="/tag/c/">丙词</a><a href="/tag/d/">丁词</a><a href="/tag/e/">戊词</a></div></div>
  <p>正文最后一段开始收束全文，这一段文字足够长，带有完整的句子和标点，用来标示正文的结尾位置。</p>
</article>`;

await test("filter3: tags/keywords container is excluded", () => {
  const bs = extractArticleBlocks(FIX3_TAGS_CONTAINER, { base: BASE_003 });
  const ts = texts(bs);
  assert(ts.length === 2, `kept ${ts.length}/2 texts: ${JSON.stringify(ts)}`);
  assert(!ts.some((t) => t.includes("甲词")), "tag cluster leaked");
});

/* ⑫ 尾部模板区（003 形态）：正文之后出现模板小节头，其后全部
 * 文本（另一小节头、他帖推广标题行）整区消失；正文与正文图片
 * 保留。 */
const FIX3_TAIL_ZONE = `<article>
  <p>正文第一段开始讲述事情的来龙去脉，这一段文字足够长，带有完整的句子和标点，正是用来标示正文起点位置的段落。</p>
  <p><img z-image-loader-url="https://img.example.invalid/tail-1.jpg"></p>
  <p>正文最后一段开始收束全文，这一段文字足够长，带有完整的句子和标点，用来标示正文的结尾位置。</p>
  <p><strong>🔥 热门吃瓜</strong></p>
  <h2>🔥重磅热瓜🔥</h2>
  <p>另一位当事人 新帖标题 噱头十足的推广文案！</p>
</article>`;

await test("filter3: trailing template zone after body is dropped", () => {
  const bs = extractArticleBlocks(FIX3_TAIL_ZONE, { base: BASE_003 });
  const ts = texts(bs);
  assert(ts.length === 2, `kept ${ts.length}/2 texts: ${JSON.stringify(ts)}`);
  assert(bs.some((b) => b.type === "image"), "body image kept");
  assert(!ts.some((t) => t.includes("热门吃瓜") || t.includes("重磅热瓜") || t.includes("推广文案")), "tail zone leaked");
});

/* ⑫ 尾部模板区（005 形态，无容器版）：温馨提示/重要提示小节头、
 * 官方网址行、下载 CTA、导航行整区消失。 */
const FIX3_TAIL_ZONE_005 = `<article>
  <p>正文第一段开始讲述事情的来龙去脉，这一段文字足够长，带有完整的句子和标点，正是用来标示正文起点位置的段落。</p>
  <h2>🔥重磅热瓜🔥</h2>
  <p>另一位当事人 新帖标题 噱头十足的推广文案！</p>
  <p>点击可下载完整版视频！</p>
  <h2>温馨提示</h2>
  <p>本站 官方网址，永久有效，真实可靠，谨防假冒</p>
  <p>福利导航（福利 管家）：</p>
  <h2>重要提示</h2>
</article>`;

await test("filter3: trailing template zone (005 form) is dropped", () => {
  const bs = extractArticleBlocks(FIX3_TAIL_ZONE_005, { base: BASE_005 });
  const ts = texts(bs);
  assert(ts.length === 1, `kept ${ts.length}/1 texts: ${JSON.stringify(ts)}`);
});

/* 公告选项卡容器（content-tabs）：005 尾部整块模板的容器形态，
 * 容器内文本不进块流；容器外正文保留。 */
const FIX3_CONTENT_TABS = `<article>
  <p>正文第一段开始讲述事情的来龙去脉，这一段文字足够长，带有完整的句子和标点，正是用来标示正文起点位置的段落。</p>
  <div class="content-tabs"><h2>🔥重磅热瓜🔥</h2><p>点击可下载完整版视频！</p><h2>温馨提示</h2></div>
  <p>正文最后一段开始收束全文，这一段文字足够长，带有完整的句子和标点，用来标示正文的结尾位置。</p>
</article>`;

await test("filter3: content-tabs announcement container is excluded", () => {
  const bs = extractArticleBlocks(FIX3_CONTENT_TABS, { base: BASE_005 });
  const ts = texts(bs);
  assert(ts.length === 2, `kept ${ts.length}/2 texts: ${JSON.stringify(ts)}`);
});

/* ⑫ 反例：作者在正文中段写「温馨提示」小节、其后还有成段正文
 * 继续叙事——尾部区的中止守门必须让它整段保留。 */
const FIX3_KEEP_MID_NOTICE = `<article>
  <p>正文第一段开始讲述事情的来龙去脉，这一段文字足够长，带有完整的句子和标点，正是用来标示正文起点位置的段落。</p>
  <h2>温馨提示</h2>
  <p>故事在这里继续展开，主人公经历了许多波折之后终于回到家乡，与多年未见的亲人重逢，席间说起这些年的经历，大家都感慨万千。</p>
  <p>正文最后一段开始收束全文，这一段文字足够长，带有完整的句子和标点，用来标示正文的结尾位置。</p>
</article>`;

await test("filter3 counter-example: mid-article notice followed by body survives", () => {
  const bs = extractArticleBlocks(FIX3_KEEP_MID_NOTICE, { base: BASE_003 });
  const ts = texts(bs);
  assert(ts.length === 4, `kept ${ts.length}/4: ${JSON.stringify(ts)}`);
  assert(ts.some((t) => t.includes("温馨提示")), "notice heading dropped");
});

/* ⑬ 显式标签关键词墙：「关键词：」标签＋空格分隔的词墙（004 真机
 * 形态，含较长的复合词）必须消失；正文保留。 */
const FIX3_LABELED_WALL = `<article>
  <p>正文第一段开始讲述事情的来龙去脉，这一段文字足够长，带有完整的句子和标点，正是用来标示正文起点位置的段落。</p>
  <p>关键词：眼镜妹 约炮 探花 反差 年度盛宴 蓝衣眼镜妹 年度盛宴眼镜妹新晋挑战者 蓝衣眼镜妹换妻性爱视频</p>
  <p>正文最后一段开始收束全文，这一段文字足够长，带有完整的句子和标点，用来标示正文的结尾位置。</p>
</article>`;

await test("filter3: labelled keyword wall is dropped", () => {
  const bs = extractArticleBlocks(FIX3_LABELED_WALL, { base: BASE_003 });
  const ts = texts(bs);
  assert(ts.length === 2, `kept ${ts.length}/2 texts: ${JSON.stringify(ts)}`);
});

/* ⑬ 反例：「关键词：」起头的正常句子（带句读、是叙述）必须保留。 */
const FIX3_KEEP_LABELED_SENTENCE = `<article>
  <p>正文第一段开始讲述事情的来龙去脉，这一段文字足够长，带有完整的句子和标点，正是用来标示正文起点位置的段落。</p>
  <p>关键词：效率。他用整整一个下午把这件事讲透了，从工具的选择讲到习惯的养成，听的人都觉得受益匪浅。</p>
  <p>正文最后一段开始收束全文，这一段文字足够长，带有完整的句子和标点，用来标示正文的结尾位置。</p>
</article>`;

await test("filter3 counter-example: labelled narrative sentence survives", () => {
  const bs = extractArticleBlocks(FIX3_KEEP_LABELED_SENTENCE, { base: BASE_003 });
  const ts = texts(bs);
  assert(ts.length === 3, `kept ${ts.length}/3: ${JSON.stringify(ts)}`);
});

/* ⑭ 反例：以「点击」起头但带逗号句读的叙述句必须保留（下载 CTA
 * 判据只认无句读的整行短句式）。 */
const FIX3_KEEP_CLICK_NARRATIVE = `<article>
  <p>正文第一段开始讲述事情的来龙去脉，这一段文字足够长，带有完整的句子和标点，正是用来标示正文起点位置的段落。</p>
  <p>点击了下载按钮，他发现网速太慢，只好先去泡了杯茶。</p>
  <p>正文最后一段开始收束全文，这一段文字足够长，带有完整的句子和标点，用来标示正文的结尾位置。</p>
</article>`;

await test("filter3 counter-example: click narrative sentence survives", () => {
  const bs = extractArticleBlocks(FIX3_KEEP_CLICK_NARRATIVE, { base: BASE_003 });
  const ts = texts(bs);
  assert(ts.length === 3, `kept ${ts.length}/3: ${JSON.stringify(ts)}`);
});

const report = { passed: results.filter((r) => r.passed).length, failed: results.filter((r) => !r.passed).length, results };
document.querySelector("#results")!.textContent = JSON.stringify(report, null, 2);
(window as unknown as { readerResults: typeof report }).readerResults = report;
