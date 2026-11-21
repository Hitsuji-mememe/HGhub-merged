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
/* 断言适配（3.2.2 瘦身）：肉视频/SWAG/RedGifs/FC2 已摘除注册表，
 * 适配器与校准参数留仓——四源改用与删除前注册表功能字段逐字一致
 * 的夹具 def 守适配器解析覆盖（note 只保留被断言的性质），断言
 * 内容不变；保留源仍走注册表 def。 */
const FIXTURE_DEFS: Record<string, unknown> = {
  rouvideo: {
    id: "rouvideo", displayName: "肉视频", kind: "video", category: "video",
    adapter: { template: "hls-site", params: { listPath: "/home", itemLinkPattern: "/v/", detailPath: "/v/{id}", streamUrlTemplate: "/api/hls/{id}" } },
    baseUrls: ["https://rou.video"], enabled: true, order: 20, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false, comments: false },
    note: "fix321-F2b 校准：取流走站内 /api/hls/<id> 代理端点（历史注册表条目）",
  },
  swag: {
    id: "swag", displayName: "SWAG", kind: "video", category: "video",
    adapter: { template: "swag-api", params: {} },
    baseUrls: ["https://swag.live", "https://api.swag.live"], enabled: true, order: 25, maturity: "probe",
    capabilities: { search: false, episodes: false, hevc: false, comments: false },
    note: "fix321-F2b 校准：免登录数据通道已接通（历史注册表条目）",
  },
  redgifs: {
    id: "redgifs", displayName: "RedGifs", kind: "video", category: "video",
    adapter: { template: "redgifs-api", params: {} },
    baseUrls: ["https://www.redgifs.com", "https://api.redgifs.com"], enabled: true, order: 27, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false, comments: false },
    note: "fix321-F2b 校准：官方 API 临时令牌链已接通（历史注册表条目）",
  },
  fc2: {
    id: "fc2", displayName: "FC2", kind: "video", category: "video",
    adapter: { template: "hls-site", params: { listPath: "/ranking/article/weekly?page={page}", itemLinkPattern: "/article_search.php?id=", detailPath: "/article/{id}/" } },
    baseUrls: ["https://adult.contents.fc2.com"], enabled: true, order: 29, maturity: "probe",
    capabilities: { search: true, episodes: false, hevc: false, comments: false },
    note: "fix321-F2b 校准：销量榜列表＋作品页（历史注册表条目）",
  },
};
const def = (id: string) => {
  const d = getBuiltinRegistry().find((s) => s.id === id) ?? FIXTURE_DEFS[id];
  assert.ok(d, `registry/fixture has ${id}`);
  return d as ReturnType<typeof getBuiltinRegistry>[number];
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

/* ── Hanime.tv：断言适配（3.3.0 fix330-hanime-api 接通批）——
 * F2b 期结论「结构已明、通道不通」经本批复核属实后已被定向扩展
 * 打通（Rust source_post 仅 auth origin＋固定头名单＋仅回 x-token；
 * 协议级实证四级形态合法），原「维持 probe＋note 写卡点」断言由
 * fix330-hanime-api 契约接棒；此处只守注册表侧不变量：模板已换
 * hanime-api、App 侧未真机验仍 probe、note 为纯技术记录。 ── */
{
  const d = def("hanime-tv");
  assert.equal(d.adapter.template, "hanime-api", "Hanime 已换 hanime-api 模板（官方 API v11）");
  assert.equal(d.maturity, "probe", "Hanime 维持 probe（代码就绪未验证）");
  assert.ok(d.note?.includes("handshake"), "Hanime note 写明握手协议段");
  assert.ok(d.note?.includes("代码就绪未验证"), "Hanime note 标注 App 侧未真机验");
}

/* ── Iwara：fix339/registry-cut-2 曾按用户定案摘除注册表（3.3.8 一轮
 * 修复后真机仍不可播、整组删无第三轮）；fix3310/video-add-2 按用户
 * 授权试装恢复（播放腿补齐后试一轮），原不在册断言回滚为模板/启用
 * 事实断言，强度不变。 ── */
{
  const d = def("iwara");
  assert.equal(d.adapter.template, "iwara-api", "Iwara 恢复 iwara-api 专用模板（fix3310 试装）");
  assert.equal(d.enabled, true, "Iwara 试装启用");
  assert.equal(d.maturity, "probe", "Iwara 维持 probe（App 侧未真机验）");
}

/* ── PornPics：fix335/g-sources 已按用户裁定退役摘除注册表（hls-site
 * 适配器代码留仓）；原 note/maturity 断言随源退役改为不在册断言。 ── */
{
  assert.ok(!getBuiltinRegistry().some((s) => s.id === "pornpics"), "PornPics 已摘除注册表（fix335/g-sources）");
}

console.log("fix321-f2b.contract: all assertions passed");
