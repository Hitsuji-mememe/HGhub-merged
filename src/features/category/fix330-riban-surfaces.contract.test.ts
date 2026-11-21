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
 * - 列示的生产选择器口径：sourcesForCategory("video",
 *   active) 恰为四源（已启用∧category="video"）、全员 probe
 *   （列示须带「未实测」标）；任一源 enabled=false 即退出列示
 *   （active 口径、清单覆盖后自动生效）；
 * - 与频道页切源片口径一致：sourcesForChannel("original") 同含
 *   四源（两条到达路径列同一集合、不许再分叉）；
 * - 生产调用点：列示面与 ChannelPage 的 video: 分支
 *   （SourceBrowse/诚实提示）以源码文本断言守（与工厂分发文本
 *   断言同口径——JSX 渲染层无 Node 契约直驱形态，接线证据另
 *   由 check-wiring 清单条目守）。
 *
 * 断言适配（2026-11-20 fix336/ui-fixes，用户亲定分类逻辑重定）：
 * 总览「视频源」区段随总览改四频道行整区退场——本契约的列示义
 * 务由「总览区段」改钉「视频频道切源片」（到达路径＝总览视频
 * 行→频道页 chips，四源集合断言不变、仍是同一选择器口径）；
 * video:<id> 深链分支（资料库回访在用）断言不变。总览不得再
 * 出现视频源区段/源行消费，改以负断言守退场不复活。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry, sourcesForCategory, sourcesForChannel } from "../sources/registry.ts";

/* 适配（fix338/registry-cut）：011 已摘除，里番列示集合四源→三源。
 * 适配（fix339/registry-cut-2）：009/010 已摘除，列示集合三源→单源
 * （002 保留、视频频道保留，用户 2026-11-21 改判）；单源频道呈现
 * 维持现状、不做单源简化。
 * 适配（fix3310/video-add-2）：009/010 试装恢复＋020/021 补位，
 * 列示集合单源→五源（002＋009＋010＋020＋021，注册表序）。 */
const RIBAN_IDS = ["hanime-tv", "hanime1", "iwara", "hentaigasm", "hentaiplay"];

/* ── 列示选择器口径：单源在列、全员 probe ── */
{
  const builtin = getBuiltinRegistry();
  const listed = sourcesForCategory("video", builtin);
  assert.deepEqual(
    listed.map((s) => s.id).sort(),
    [...RIBAN_IDS].sort(),
    "视频源列示集合 = active 注册表 category=video 已启用源，恰为里番五源（fix3310 后）",
  );
  for (const s of listed) {
    assert.equal(s.enabled, true, `${s.id} 已启用才入列示`);
    assert.equal(s.category, "video", `${s.id} 品类为 video`);
    assert.equal(s.maturity, "probe", `${s.id} maturity=probe（总览须带「未实测」标、不得冒充已验通）`);
  }
  /* active 口径：清单覆盖把全部视频源置 enabled=false → 列示为空
   * （v2 清单下 010/012 的真机形态即此路径）。 */
  const overlaid = builtin.map((s) => (s.category === "video" ? { ...s, enabled: false } : s));
  assert.deepEqual(
    sourcesForCategory("video", overlaid).map((s) => s.id).sort(),
    [],
    "enabled=false 的源不入列示（active 注册表口径；全员被熔断则列示为空、不冒充）",
  );
  /* 两条到达路径同集合：频道页切源片（sourcesForChannel）与
   * 列示不得分叉。 */
  assert.deepEqual(
    sourcesForChannel("original", builtin).map((s) => s.id).sort(),
    [...RIBAN_IDS].sort(),
    "频道页切源片与列示集合为同一五源集合（fix3310 后）",
  );
}

/* ── 生产调用点（Category.tsx 源码文本断言） ── */
{
  const src = readFileSync(new URL("./Category.tsx", import.meta.url), "utf8");
  /* 列示面（fix336/ui-fixes 适配）：总览「视频源」区段已退场，
   * 列示改由视频频道切源片承接——名单经 sourceOptionsFor
   * Channel(cate) 自 sourcesForChannel 派生（与上方选择器口径
   * 段同集合、消费 active 注册表、非写死名单）；总览侧以负断
   * 言守退场（区段与 overview-video-rows 消费不许复活）。 */
  assert.ok(!src.includes('aria-label="视频源"'), "总览无「视频源」区段（fix336 退场、源不外露）");
  assert.ok(!src.includes("overview-video-rows"), "总览不再消费 overview-video-rows（面已删）");
  assert.ok(src.includes("sourceOptionsForChannel(cate)"), "频道切源片消费频道-源映射派生（active 注册表、非写死名单）");
  assert.ok(src.includes('cate.startsWith("video:")'), "ChannelPage 识别 video: 深链（原生频道加载跳过＋专属分支）");
  assert.ok(src.includes("SourceBrowse def={videoSource}"), "video: 分支经 SourceBrowse 走适配器真取数（生产调用点）");
  assert.ok(src.includes("videoSource.maturity === \"blocked\""), "video: 分支 blocked/缺源走诚实提示、不拉数据冒充");
}

console.log("fix330-riban-surfaces (category) contract: ok");
