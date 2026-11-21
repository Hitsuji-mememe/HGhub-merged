/**
 * fix333-P2 契约：选中源被清单停用时，浏览面不得落假文案、不得外显内部 id。
 * 运行：node src/features/sources/fix333-p2.contract.test.ts
 * 背景（3.3.2 独立证伪清扫 P2＝结构审计 G5 残存）：Posts 页与分类总览
 * 吃瓜区以 sourcesForCategory(...).find(id) 取选中源、无回落校验；
 * 源不在 active 表时 activeSource=undefined → resolvePostsBrowse 判
 * "blocked" → 渲染 SourcePendingNotice，其非 blocked 文案为「本分类的
 * 外部源浏览页尚未接通」——与真实原因（源已被清单停用）不符；页头
 * 「数据源：」回落显示内部 id 原文。图片/视频深链页（ChannelPage
 * image:/video: 分支）与频道外源分支是同型：缺失时 maturity 强制
 * "blocked" 落错分支、或页头回落 id 原文。
 * 本契约钉死：①选中态三态唯一派生（active/disabled/gone，判定只认
 * 调用方给的 active 表，内置查表只给已知源找回显示名）；②disabled 的
 * 提示含停用口径、gone 的提示含移除口径（fix333-M3 拆分，此前共用
 * 停用一句对已删源字面不实），两态均不含「尚未接通」、不外显内部
 * id；③pending 原口径逐字保留（真未接线时仍是那句话）；④四处页头/提示回落不再用 id 原文。
 * 夹具为注册表本身（内置表＋按清单停用模拟裁剪的 active 表），不访问
 * 真实网络、不读 localStorage（判定函数取显式 active 表为入参，内置
 * 查表在函数内对全量内置注册表做——不按 enabled/分类过滤，见
 * selectedSource.ts 文件头）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry, sourcesForCategory } from "./registry.ts";
import { resolveSelectedSource } from "./selectedSource.ts";

const builtinPosts = sourcesForCategory("posts", getBuiltinRegistry());
const builtinImages = sourcesForCategory("image", getBuiltinRegistry());

/* ── active：清单在位 ── */
{
  const r = resolveSelectedSource("51chigua", builtinPosts);
  assert.equal(r.kind, "active", "在位源判 active");
  assert.equal(r.def?.id, "51chigua", "active 返回生效 def");
  assert.equal(r.label, "51吃瓜网", "active 显示名");
}

/* ── disabled：清单停用（模拟 v3 停用 51吃瓜网：active 表去掉它） ── */
{
  const activeWithout51 = builtinPosts.filter((s) => s.id !== "51chigua");
  const r = resolveSelectedSource("51chigua", activeWithout51);
  assert.equal(r.kind, "disabled", "清单停用判 disabled");
  assert.equal(r.def?.id, "51chigua", "disabled 的 def 取内置表（仅供显示名）");
  assert.equal(r.label, "51吃瓜网", "disabled 显示内置显示名、不外显 id");
  assert.ok(!r.label.includes("51chigua"), "label 不含内部 id");
}

/* ── disabled：内置即未启用（gelbooru 等目录源，enabled=false）──
 * 此例曾在旧签名下跑出 gone：调用方传的 builtin 表经
 * sourcesForCategory 已按 enabled 过滤，内置未启用源根本进不了查表。
 * 修法：内置查表收进函数内、对全量内置注册表做（见 selectedSource.ts）。
 * 适配（fix335/g-sources）：原例 yandere 已启用，改挂仍未启用的 gelbooru。 */
{
  const activeImages = builtinImages.filter((s) => s.enabled);
  const r = resolveSelectedSource("gelbooru", activeImages);
  assert.equal(r.kind, "disabled", "内置未启用判 disabled");
  assert.equal(r.label, "Gelbooru", "disabled 显示内置显示名");
}

/* ── gone：代码已删源（rule34video 已自注册表摘除） ── */
{
  const r = resolveSelectedSource("rule34video", builtinPosts);
  assert.equal(r.kind, "gone", "两表皆无判 gone");
  assert.equal(r.def, undefined, "gone 无 def");
  assert.equal(r.label, "该数据源", "gone 用通用名、不外显 id");
  assert.ok(!r.label.includes("rule34video"), "gone label 不含内部 id");
}

/* ── 跨分类 id：内置查表不按分类，落 disabled（选单按分类出，跨分类
 * 选中态经 UI 不可达；万一到达，补救动作与停用相同——请用户切换）。 ── */
{
  /* 断言适配（fix3314）：跨分类样本原用 hanime-tv（video），该源已
   * 随视频板块摘除（现落 gone、由上组承接），样本改存活跨分类源
   * xiuren（image 対 posts），覆盖不变。 */
  const r = resolveSelectedSource("xiuren", builtinPosts);
  assert.equal(r.kind, "disabled", "跨分类已知源 id 落 disabled");
  assert.equal(r.label, "秀人网", "跨分类已知源显示内置显示名");
}

/* ── 文案钉死：disabled 分支含停用口径、不含假文案；pending 原口径逐字保留 ──
 * 断言适配（Muse 2026-11-20 fix333-M3，不削弱覆盖）：M3 把共用布尔
 * disabled 拆成三态 selectedKind，disabled/gone 各一份字面精确文案
 * （gone 不再谎称「被清单停用」）。分支锚点随签名更新，并新增 gone
 * 分支断言组：含「已被移除/已下线」、不含「清单停用」。 */
{
  const src = readFileSync(new URL("./SourceSwitcher.tsx", import.meta.url), "utf8");
  /* 只取 selectedKind === "disabled" 分支体（到 gone 分支为止），注释不算在内。 */
  const disStart = src.indexOf('if (selectedKind === "disabled") {');
  const disEnd = src.indexOf('if (selectedKind === "gone")', disStart);
  assert.ok(disStart > 0 && disEnd > disStart, "disabled 分支在位");
  const disBlock = src.slice(disStart, disEnd);
  assert.ok(disBlock.includes("已被清单停用"), "disabled 文案在位");
  assert.ok(!disBlock.includes("尚未接通"), "disabled 分支不含假文案");
  assert.ok(!disBlock.includes("已下线"), "disabled 分支不串 gone 文案");
  /* gone 分支（到 blocked 分支为止）：文案写「已被移除」、不冒充清单停用。 */
  const goneEnd = src.indexOf('if (maturity === "blocked")', disEnd);
  assert.ok(goneEnd > disEnd, "gone 分支在位");
  const goneBlock = src.slice(disEnd, goneEnd);
  assert.ok(goneBlock.includes("已被移除"), "gone 文案写移除事实");
  assert.ok(goneBlock.includes("已下线"), "gone 标题为已下线");
  assert.ok(!goneBlock.includes("清单停用"), "gone 分支不谎称清单停用");
  assert.ok(!goneBlock.includes("尚未接通"), "gone 分支不含假文案");
  assert.ok(src.includes("本分类的外部源浏览页尚未接通"), "pending 原口径逐字保留");
  /* 五面调用点一律传三态 kind，不再压成布尔（压扁即两态同文案的根源）。 */
  const posts = readFileSync(new URL("../posts/Posts.tsx", import.meta.url), "utf8");
  assert.ok(posts.includes("selectedKind={selectedSource.kind}"), "Posts 面传三态 kind");
  const cat = readFileSync(new URL("../category/Category.tsx", import.meta.url), "utf8");
  /* 计数适配（fix335/e-category 总览索引化）：总览吃瓜预览面退场，
   * 其 selectedKind 调用点随面删除；余三面（图片深链/视频深链/
   * 频道外源）仍逐面传三态 kind，口径不变。
   * 计数再适配（fix336/ui-fixes）：图片频道分支（cate="image"）
   * 新增一面同口径传三态 kind，三面→四面，覆盖增加。
   * 计数再适配（fix3314）：视频深链面与频道外源面随视频板块删除
   * 退场，四面→两面（图片深链/图片频道），逐面传三态口径不变。 */
  assert.equal(cat.split("selectedKind={").length - 1, 2, "Category 两面传三态 kind（图片深链/图片频道）");
}

/* ── 调用点不再用内部 id 作页头/提示回落 ── */
{
  const posts = readFileSync(new URL("../posts/Posts.tsx", import.meta.url), "utf8");
  assert.ok(!posts.includes("activeSource?.displayName ?? sourceId"), "Posts 页不再以内部 id 作数据源回落");
  const cat = readFileSync(new URL("../category/Category.tsx", import.meta.url), "utf8");
  assert.ok(!cat.includes("postsSource?.displayName ?? postsSourceId"), "吃瓜总览不再以内部 id 作提示回落");
  assert.ok(!cat.includes("imageSource?.displayName ?? imageSourceId"), "图片深链页不再以内部 id 作数据源回落");
  assert.ok(!cat.includes("videoSource?.displayName ?? videoSourceId"), "视频深链页不再以内部 id 作数据源回落");
  assert.ok(!cat.includes("channelSource?.displayName ?? effectiveChannelSourceId"), "频道外源页不再以内部 id 作数据源回落");
}

console.log("fix333-p2 contract: all assertions passed");
