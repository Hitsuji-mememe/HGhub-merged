/**
 * 3.3.1 里番面接线修复·分类面契约（Muse 2026-11-19
 * fix330-riban-surfaces；本线任务书即维护者对新增测试的授权，
 * AGENTS 不变量 11）。运行：
 * node src/features/category/fix330-riban-surfaces.contract.test.ts
 *
 * 真机事实（3.3.0 首验）：source-002/010/011/012（视频品类四源）
 * 搜索可达、但分类（Category）总览面完全缺席。
 * 定性：总览此前只有图片区有「源入口列示」、吃瓜区有源切换器，
 * 视频品类源无任何总览列示——唯一到达路径是先进「视频」频道页
 * 再切源片（注册表已启用 ≠ 浏览面已接通，lessons 2026-11-19
 * 同病在视频面的复发）。另：真机生效清单 v2 将 010/011/012 置
 * enabled=false（清单层口径、非本线可改），002 在 v2 启用却同
 * 样缺席——缺席主因是总览无此区段，与清单状态无关。
 *
 * 旧红形态（基线 fix-330-20261119 @4cf7454）：Category.tsx 无
 * 「视频源」区段、无 video:<id> 深链分支——下方对 Category.tsx
 * 的生产调用点文本断言全部失败；本文件在基线即红。
 *
 * 覆盖：
 * - 总览列示的生产选择器口径：sourcesForCategory("video",
 *   active) 恰为四源（已启用∧category="video"）、全员 probe
 *   （总览须带「未实测」标）；任一源 enabled=false 即退出列示
 *   （active 口径、清单覆盖后自动生效）；
 * - 与频道页切源片口径一致：sourcesForChannel("original") 同含
 *   四源（两条到达路径列同一集合、不许再分叉）；
 * - 生产调用点：总览区段（aria-label/深链 cate 形态）与
 *   ChannelPage 的 video: 分支（SourceBrowse/诚实提示）以源码
 *   文本断言守（与工厂分发文本断言同口径——JSX 渲染层无 Node
 *   契约直驱形态，接线证据另由 check-wiring 清单条目守）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry, sourcesForCategory, sourcesForChannel } from "../sources/registry.ts";

const RIBAN_IDS = ["hanime-tv", "hanime1", "iwara", "hentaihaven"];

/* ── 列示选择器口径：四源齐列、全员 probe ── */
{
  const builtin = getBuiltinRegistry();
  const listed = sourcesForCategory("video", builtin);
  assert.deepEqual(
    listed.map((s) => s.id).sort(),
    [...RIBAN_IDS].sort(),
    "总览视频源列示 = active 注册表 category=video 已启用源，恰为里番四源",
  );
  for (const s of listed) {
    assert.equal(s.enabled, true, `${s.id} 已启用才入列示`);
    assert.equal(s.category, "video", `${s.id} 品类为 video`);
    assert.equal(s.maturity, "probe", `${s.id} maturity=probe（总览须带「未实测」标、不得冒充已验通）`);
  }
  /* active 口径：清单覆盖把某源置 enabled=false → 立即退出列示
   * （v2 清单下 010/011/012 的真机形态即此路径）。 */
  const overlaid = builtin.map((s) => (s.id === "iwara" ? { ...s, enabled: false } : s));
  assert.deepEqual(
    sourcesForCategory("video", overlaid).map((s) => s.id).sort(),
    ["hanime-tv", "hanime1", "hentaihaven"].sort(),
    "enabled=false 的源不入总览列示（active 注册表口径）",
  );
  /* 两条到达路径同集合：频道页切源片（sourcesForChannel）与
   * 总览列示不得分叉。 */
  assert.deepEqual(
    sourcesForChannel("original", builtin).map((s) => s.id).sort(),
    [...RIBAN_IDS].sort(),
    "频道页切源片与总览列示为同一四源集合",
  );
}

/* ── 生产调用点（Category.tsx 源码文本断言） ── */
{
  const src = readFileSync(new URL("./Category.tsx", import.meta.url), "utf8");
  assert.ok(src.includes('aria-label="视频源"'), "总览有「视频源」区段（与图片区同列示形态）");
  assert.ok(src.includes("sourcesForCategory(\"video\", activeSources)"), "总览列示消费 active 注册表 category=video 选择器（非内置表、非写死名单）");
  assert.ok(src.includes("cate: `video:${s.id}`"), "总览条目深链 cate=video:<源id>（与 image:<源id> 同约定）");
  assert.ok(src.includes('cate.startsWith("video:")'), "ChannelPage 识别 video: 深链（原生频道加载跳过＋专属分支）");
  assert.ok(src.includes("SourceBrowse def={videoSource}"), "video: 分支经 SourceBrowse 走适配器真取数（生产调用点）");
  assert.ok(src.includes("videoSource.maturity === \"blocked\""), "video: 分支 blocked/缺源走诚实提示、不拉数据冒充");
}

console.log("fix330-riban-surfaces (category) contract: ok");
