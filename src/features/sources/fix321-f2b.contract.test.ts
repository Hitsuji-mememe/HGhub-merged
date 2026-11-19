/**
 * 3.2.1 修复 F2b 线契约测试（Muse 2026-11-19 fix321-F2b；本批任务书
 * 即维护者对新增测试的授权，AGENTS 不变量 11）：
 * 运行：node src/features/sources/fix321-f2b.contract.test.ts
 * 背景：住宅出口四级验收（source-verify-20261119）推翻机房定性——
 * 肉视频/SWAG/RedGifs/FC2 四站住宅全通、App 侧不可用属适配器未按
 * 真站校准；51吃瓜（51cg1.com）/黑料网（heiliao.com）住宅四级全通。
 * 覆盖（每源一条夹具解析契约，夹具=真站结构摘录，evidence/f2b/）：
 * 肉视频取流走站内 /api/hls/<id> 代理端点（Hentai-Park 插件＋真站
 * 前端 chunk 双证据）；SWAG 免登录 API 通道（api.swag.live feeds/
 * messages，本机出口实测 200）列表/详情接通、AES 加密流维持未证；
 * RedGifs 官方 API 临时令牌＋Bearer 链（列表/详情/流）；FC2 销量榜
 * 列表＋作品页按普通视频源校准；51吃瓜换域名 51cg1.com 解 blocked；
 * 黑料网自目录导入毕业为命名源并启用（三段结构证据齐＋住宅四级
 * 全通）；Hanime 取流 handshake 需 POST＋加密信封、超 GET-only 取页
 * 契约 → 维持 probe 并 note 写明；Iwara 本批撤下施工（仅 note）；
 * PornPics note 追加住宅 DNS 不可达。不访问真实网络。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "./registry.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { createChiguaAdapter, createHlsSiteAdapter, createRedgifsAdapter, createSwagAdapter } from "./adapters/templates.ts";

const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");
const def = (id: string) => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};

/* ── 肉视频：取流 = 站内代理端点 /api/hls/<id>（插件 videos() 与
 * 真站 VideoBox chunk 的 sources/videoUrl 形态互证）；resolve 不再
 * 回详情页 HTML 里找 m3u8（真站详情 SSR 无流）。 ── */
{
  setFetchPage(async () => { throw new Error("streamUrlTemplate 形态不应取页"); });
  const a = createHlsSiteAdapter(def("rouvideo"));
  const r = await a.resolve("https://rou.video/v/cmwjhndfm0000s6ndp7y0vun7");
  assert.deepEqual(r.streams, [{ url: "https://rou.video/api/hls/cmwjhndfm0000s6ndp7y0vun7", kind: "hls" }], "肉视频 resolve 给 /api/hls/<id> 站内 HLS 端点");
}

/* ── SWAG：免登录数据通道（api.swag.live）——旧 note「需登录态」
 * 断言系机房出口结论、已被住宅验收＋本机实测推翻，必须删除；
 * 列表经 feeds/shorts_curated＋逐条 messages 补标题/封面出条目；
 * 流为 AES-128 加密 HLS（key URI 占位＋会话头换钥，超播放栈）
 * → resolve 诚实为空、仍 probe。 ── */
{
  const d = def("swag");
  assert.ok(!d.note?.includes("需登录态"), "SWAG note 删除已被推翻的「api 需登录态」旧断言");
  assert.ok(d.baseUrls.includes("https://api.swag.live"), "SWAG API origin 入 baseUrls（source_fetch 白名单随注册表推送）");
  const feed = JSON.parse(fx("real-swag-feed.json")) as { id: string }[];
  const message = fx("real-swag-message.json");
  setFetchPage(async (url) => {
    if (url.includes("/feeds/shorts_curated")) return fx("real-swag-feed.json");
    if (url.includes("/messages/")) return message;
    throw new Error(`unexpected fetch ${url}`);
  });
  const a = createSwagAdapter(d);
  assert.ok(a, "SWAG 有适配器");
  const list = await a!.list(1, 20);
  assert.ok(list.items.length >= 1, `SWAG 列表经公开 API 出条目（实得 ${list.items.length}）`);
  assert.equal(list.items[0].externalId, feed[0].id, "SWAG 条目 id 为 message id");
  assert.ok(list.items[0].title.length > 4, "SWAG 条目标题由 messages 补齐");
  assert.ok(list.items[0].cover.startsWith("https://public.swag.live/"), "SWAG 封面挂 public CDN");
  const detail = await a!.detail(feed[0].id);
  assert.equal(detail.externalId, feed[0].id, "SWAG 详情按 message id 取数");
  const r = await a!.resolve(feed[0].id);
  assert.deepEqual(r.streams, [], "SWAG 流为 AES 加密 HLS、播放栈不支持 → resolve 诚实为空（未证）");
}

/* ── RedGifs：官方 API 临时令牌链——先 GET /v2/auth/temporary 取
 * 匿名令牌，再带 Authorization: Bearer 调 search/detail；列表出
 * 条目、resolve 给 hd mp4。fetchPage 须透传 Authorization（Rust
 * 侧仅对 api.redgifs.com origin 定向放行，见 api/source.rs）。 ── */
{
  const d = def("redgifs");
  assert.ok(d.baseUrls.includes("https://api.redgifs.com"), "RedGifs API origin 入 baseUrls");
  const seen: { url: string; auth?: string }[] = [];
  setFetchPage(async (url, headers) => {
    seen.push({ url, auth: headers?.Authorization });
    if (url.includes("/v2/auth/temporary")) return JSON.stringify({ token: "fixture-token" });
    if (url.includes("/v2/gifs/search")) return fx("real-redgifs-search.json");
    if (url.includes("/v2/gifs/abc123def")) return JSON.stringify({ gif: JSON.parse(fx("real-redgifs-search.json")).gifs[0] });
    throw new Error(`unexpected fetch ${url}`);
  });
  const a = createRedgifsAdapter(d);
  assert.ok(a, "RedGifs 有适配器");
  const list = await a!.list(1, 20);
  assert.ok(list.items.length >= 2, `RedGifs 列表经官方 API 出条目（实得 ${list.items.length}）`);
  assert.ok(list.items[0].cover.includes("media.redgifs.com"), "RedGifs 封面取 urls.thumbnail");
  const searchCall = seen.find((s) => s.url.includes("/v2/gifs/search"));
  assert.equal(searchCall?.auth, "Bearer fixture-token", "search 调用带临时令牌 Bearer 头");
  const r = await a!.resolve(list.items[0].externalId);
  assert.equal(r.streams[0]?.kind, "file", "RedGifs 流为 mp4 文件");
  assert.ok(r.streams[0]?.url.includes("-hd.mp4"), "RedGifs resolve 优先 hd mp4");
}

/* ── FC2：普通视频源校准——销量榜 /ranking/article/weekly 的
 * /article_search.php?id= 卡片（h3 标题＋缩略图）出条目；kind/
 * category 维持 video（用户定性：进视频分区当普通源、不单独
 * 成档）；作品为 PPV 付费资料、无免费流 → resolve 诚实为空。 ── */
{
  const d = def("fc2");
  assert.equal(d.kind, "video", "FC2 kind=video（普通视频源定性）");
  assert.equal(d.category, "video", "FC2 category=video（进视频分区）");
  assert.ok(String(d.adapter.params?.listPath).includes("/ranking/article/"), "FC2 列表按真站销量榜路径校准");
  setFetchPage(async (url) => url.includes("/ranking/") ? fx("real-fc2-ranking.html") : fx("real-fc2-article.html"));
  const a = createHlsSiteAdapter(d);
  const list = await a.list(1, 20);
  assert.ok(list.items.length >= 2, `FC2 榜单解析出条目（实得 ${list.items.length}）`);
  assert.ok(list.items[0].title.includes("【"), "FC2 标题取卡片 h3（非整卡文本拼接）");
  assert.ok(list.items[0].cover.includes("contents.fc2.com"), "FC2 封面取卡片缩略图");
  const r = await a.resolve(list.items[0].externalId);
  assert.deepEqual(r.streams, [], "FC2 为 PPV 作品资料、无免费流 → resolve 诚实为空");
}

/* ── 51吃瓜：域名换 51cg1.com（旧 51chigua.com 已停放，v2 清单
 * 同口径）、解除 blocked；列表 post-card（x-bg-loader-url 封面）
 * 出条目、详情 DPlayer data-config 内嵌 m3u8 可取流。 ── */
{
  const d = def("51chigua");
  assert.equal(d.baseUrls[0], "https://51cg1.com", "51吃瓜域名按 v2 清单改 51cg1.com");
  assert.notEqual(d.maturity, "blocked", "51吃瓜解除 blocked 呈现（住宅四级全通＋本机三段实测）");
  setFetchPage(async (url) => url.includes("/archives/") ? fx("real-51cg-detail.html") : fx("real-51cg-home.html"));
  const a = createChiguaAdapter(d);
  const list = await a.list(1, 20);
  assert.ok(list.items.length >= 2, `51吃瓜列表解析出条目（实得 ${list.items.length}）`);
  assert.ok(list.items[0].cover.includes("pic."), "51吃瓜封面取 post-card 背景图（x-bg-loader-url）");
  const r = await a.resolve(list.items[0].externalId);
  assert.ok(r.streams[0]?.url.includes(".m3u8"), "51吃瓜详情 DPlayer 配置可取 HLS 流");
}

/* ── 黑料网：自目录导入毕业为命名源并启用——列表 video-item
 * 卡片（z-image-loader-url 封面）出条目、详情内嵌 m3u8 可取流
 * （三段结构证据齐：插件＋本机实测＋住宅四级全通）。 ── */
{
  const d = def("feedheiliao");
  assert.equal(d.enabled, true, "黑料网启用（启用依据见 registry note 与本线回报）");
  assert.ok(!d.note?.includes("目录导入·未实测"), "黑料网 note 不再是目录导入未实测口径");
  setFetchPage(async (url) => url.includes("/archives/") ? fx("real-heiliao-detail.html") : fx("real-heiliao-home.html"));
  const a = createChiguaAdapter(d);
  const list = await a.list(1, 20);
  assert.ok(list.items.length >= 2, `黑料网列表解析出条目（实得 ${list.items.length}）`);
  assert.ok(list.items[0].cover.includes("pic.biacea.cn"), "黑料网封面取 z-image-loader-url");
  const r = await a.resolve(list.items[0].externalId);
  assert.ok(r.streams[0]?.url.includes(".m3u8"), "黑料网详情可取 HLS 流");
}

/* ── Hanime.tv：取流链结构已定位（guest API＋AES-GCM handshake
 * POST＋签名头，插件证据）但超 GET-only 取页契约 → 维持 probe、
 * note 写明卡点与住宅验收「第 4 级未确认」。 ── */
{
  const d = def("hanime-tv");
  assert.equal(d.maturity, "probe", "Hanime 维持 probe");
  assert.ok(d.note?.includes("handshake"), "Hanime note 写明取流卡点（handshake POST＋加密信封）");
  assert.ok(d.note?.includes("未确认"), "Hanime note 标注住宅验收第 4 级未确认");
}

/* ── Iwara：本批撤下施工——站点住宅四级全通、缺适配器待立项，
 * 只更新 note，不动模板（template=none、enabled=false 不变）。 ── */
{
  const d = def("iwara");
  assert.equal(d.adapter.template, "none", "Iwara 本批不动模板");
  assert.equal(d.enabled, false, "Iwara 维持未启用（待立项）");
  assert.ok(d.note?.includes("四级验收全通"), "Iwara note 据实更新住宅验收结论");
}

/* ── PornPics：解析不动（F2 已校准），note 追加住宅出口 DNS
 * 不可达事实、maturity 维持 probe。 ── */
{
  const d = def("pornpics");
  assert.equal(d.maturity, "probe", "PornPics 维持 probe");
  assert.ok(d.note?.includes("DNS"), "PornPics note 追加住宅出口 DNS 不可达事实");
}

console.log("fix321-f2b.contract: all assertions passed");
