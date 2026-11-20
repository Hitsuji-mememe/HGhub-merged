/**
 * 3.3.2 修复批·covers-header 线契约测试（Muse 2026-11-20；本批任务书
 * 即维护者对新增测试的授权，AGENTS 不变量 11）。
 * 运行：node src/features/sources/fix331-covers.contract.test.ts
 *
 * 覆盖 3.3.1 真机首验问题①（device-verdict-331 图 2）：source-005
 * 帖子列表封面整屏 HG 占位。请求级定性（2026-11-20 本机抓真站列表页
 * ＋生产解析器实跑，证据 fix331/evidence/covers-header.md）：
 * 该站卡片封面只由内联脚本 loadBannerDirect('<直址>', ...) 第一参数
 * 承载，firstCoverSrc 候选链（img 系属性 → x-bg/z-image-loader-url）
 * 全部落空返回 ""；parseAnchorList 又把 "" 经 absUrl(base, "") 补成
 * 站点根 URL（非空、合法），Img 遂把站点首页 HTML 当图片拉取、解码
 * 必失败、三次 attempt 烧光落 HG——整屏占位与真机严丝合缝。
 *
 * 本契约钉两点：
 * (1) 脚本参数载体进 firstCoverSrc 候选链（img/loader 皆落空时才轮
 *     到它，既有载体优先级不变）；
 * (2) 无任何载体时 cover 必须保持空串——absUrl 不许把空串补成根
 *     地址（假地址比无封面更坏：它伪装成一次真实图片请求）。
 * 夹具为真站结构形态构造（域名/标题合成），不访问真实网络。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "./registry.ts";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { firstCoverSrc } from "./adapters/parse.ts";
import { createChiguaAdapter } from "./adapters/templates.ts";
import type { SourceDef } from "./types.ts";

const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");
const def = (id: string): SourceDef => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};

/* ── (1) 脚本参数载体：单双引号两形态都必须命中 ── */
{
  const single = `<div class="post-card" id="post-card-1"><div class="blog-background"></div>`
    + `<script>loadBannerDirect('https://pic.fixture.invalid/a.jpg', '', document.querySelector('#post-card-1'), '-1', 300);</script></div>`;
  assert.equal(firstCoverSrc(single), "https://pic.fixture.invalid/a.jpg",
    "loadBannerDirect 第一参数（单引号）必须被识别为封面（旧码返回空串）");
  const double = `<div class="post-card" id="post-card-2"><script>loadBannerDirect("https://pic.fixture.invalid/b.jpg", '', null, '-1', 300);</script></div>`;
  assert.equal(firstCoverSrc(double), "https://pic.fixture.invalid/b.jpg",
    "loadBannerDirect 第一参数（双引号）必须被识别为封面");
}

/* ── (2) 既有载体优先级不变：img / loader 属性在场时不许被脚本参数抢占 ── */
{
  const withImg = `<img data-src="https://img.fixture.invalid/first.jpg"><script>loadBannerDirect('https://pic.fixture.invalid/other.jpg', '', null);</script>`;
  assert.equal(firstCoverSrc(withImg), "https://img.fixture.invalid/first.jpg", "img 系属性仍居首");
  const withLoader = `<div x-bg-loader-url="https://img.fixture.invalid/bg.jpg"></div><script>loadBannerDirect('https://pic.fixture.invalid/other.jpg', '', null);</script>`;
  assert.equal(firstCoverSrc(withLoader), "https://img.fixture.invalid/bg.jpg", "loader 属性仍优先于脚本参数");
}

/* ── (3) 生产适配器端到端：真站形态夹具解析出的封面必须是脚本直址，
 *        无载体卡片的 cover 必须为空串（旧码为站点根 URL） ── */
{
  const html = fx("chigua-list-banner-script.html");
  setFetchPage(async () => html);
  const adapter = createChiguaAdapter(def("meiridasai"));
  const page = await adapter.list(1, 20);
  assert.equal(page.items.length, 3, "夹具三张卡片应全部解析出条目");
  const byId = new Map(page.items.map((i) => [i.externalId, i]));
  const a = [...byId.values()].find((i) => i.href.endsWith("/archives/202559/"));
  const b = [...byId.values()].find((i) => i.href.endsWith("/archives/202560/"));
  const c = [...byId.values()].find((i) => i.href.endsWith("/archives/202561/"));
  assert.ok(a && b && c, "三张卡片条目齐全");
  assert.equal(a.cover, "https://pic.fixture.invalid/upload_01/x/20260101/cover-a.jpg",
    "脚本承载封面必须原样解析（旧码为站点根 URL）");
  assert.equal(b.cover, "https://pic.fixture.invalid/upload_01/x/20260101/cover-b.jpg",
    "双引号脚本承载封面必须原样解析");
  assert.equal(c.cover, "", "无封面载体的卡片 cover 必须为空串，不许补成站点根地址");
}

/* ── (4) reader3 批追加：z-bg-loader-url 载体（source-003 列表页
 *        2026-11-20 实测：两页 48 张卡片中 45 张只带此载体，生产
 *        firstCoverSrc 返回 ""——卡片在解析层无封面。证据
 *        fix333/evidence/reader3.md。同属 loader 属性族，优先级与
 *        既有 loader 一致，排在 img 系之后、脚本参数之前） ── */
{
  const zbg = `<div class="post-card"><div class="blog-background" z-bg-loader-url="https://pic.fixture.invalid/z.jpg"></div></div>`;
  assert.equal(firstCoverSrc(zbg), "https://pic.fixture.invalid/z.jpg",
    "z-bg-loader-url 必须被识别为封面（旧码返回空串）");
  const zbgImgFirst = `<img data-src="https://img.fixture.invalid/first.jpg"><div z-bg-loader-url="https://pic.fixture.invalid/z.jpg"></div>`;
  assert.equal(firstCoverSrc(zbgImgFirst), "https://img.fixture.invalid/first.jpg", "img 系属性仍优先于 z-bg-loader-url");
}

console.log("fix331-covers contract: all passed");
