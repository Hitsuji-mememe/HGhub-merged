/**
 * 3.3.3 修复批·promo-004 线契约测试（Muse 2026-11-20；本批任务书
 * 即维护者对新增测试的授权，AGENTS 不变量 11）。
 * 运行：node src/features/sources/fix333-promo-004.contract.test.ts
 *
 * 覆盖 source-004（feedheiliao）站务型推广帖的详情层异步验杀
 * （promoVerify.ts）：该源列表卡无分类/作者字段、列表层组合信号
 * 不存在（fix333/evidence/promo-filter.md 第三节停工证据），唯一
 * 可分信号在详情层——站务推广三连正文 587–706 字、episodes=0；
 * 内容 1075–1770 字、episodes=1；活动投票帖 1744 字、episodes=1
 * （活动壳＋真内容，用户裁定保留）。用户口径（2026-11-20 两次
 * 亲定）：硬线＝不许伤真正的内容帖与正文；擦边垃圾可伤；004
 * 裁法＝站务型短帖杀、活动壳真内容留。
 *
 * 本契约钉六点：
 * (1) 判据 classifyStaffPost：站务档（≤890 字∧无流）判 staff；
 *     内容帖与活动投票帖（1744 字∧有流）判 clean；短正文但有流
 *     靠 episodes 合取存活；正文提取不到（contentHtml 缺失）判
 *     unknown 不杀；阈值边界 890/891 分界。
 * (2) 合成反例（已知尾巴风险，明示）：正文 500 字∧无流的短内容
 *     帖按现行判据判 staff——样本内不存在此形态（内容下限 1075
 *     字且均有流），此断言钉死现状，判据收紧时必须先改此例。
 * (3) 正文量法 bodyTextLength：与 promo-filter 抽查同一量法
 *     （去 script/style/标签、空白折叠）；缺失返回 null。
 * (4) 判定缓存：落盘后重绑存储（模拟重启）仍可读；作用域含判
 *     据版本，旧版本作用域在新判定落盘时被清掉（自动失效）。
 * (5) 验杀会话：并发 ≤3；在飞去重；详情失败不判不落缓存（网
 *     络失败≠站务）；unknown 不落缓存；已落盘判定经 enqueue
 *     直接回放、不再抓详情（每帖一生只验一次）。
 * (6) 注册表口径：仅 feedheiliao 声明 staffVerify（阈值 890），
 *     其余源零外溢；SourcePosts 接线文本断言（hook 真接入）。
 * 夹具为合成形态，不访问真实网络。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBuiltinRegistry } from "./registry.ts";
import {
  PROMO_VERIFY_RULE_VERSION,
  bindPromoVerifyStorage,
  bodyTextLength,
  classifyStaffPost,
  createPromoVerifySession,
  getPromoVerdicts,
  promoVerifyScope,
  recordPromoVerdict,
  staffVerifyConfig,
  type PromoVerdictStorageLike,
} from "./promoVerify.ts";
import type { SourceDef, SourceDetail, SourceItem } from "./types.ts";

const def = (id: string): SourceDef => {
  const d = getBuiltinRegistry().find((s) => s.id === id);
  assert.ok(d, `registry has ${id}`);
  return d;
};
const cfgOf = (id: string) => {
  const cfg = staffVerifyConfig(def(id));
  assert.ok(cfg, `${id} declares staffVerify`);
  return cfg;
};
/** 合成详情：正文为 n 个无空白字符（量法下长度恰为 n），eps 为流数。 */
const detailOf = (chars: number, eps: number): { contentHtml?: string; episodes: unknown[] } => ({
  contentHtml: `<div class="editormd-preview"><p>${"x".repeat(chars)}</p></div>`,
  episodes: Array.from({ length: eps }, (_, i) => ({ label: `ep${i}`, externalId: "e" })),
});
const flush = async (rounds = 60) => {
  /* 会话内假详情带 5ms 定时器，须按真实时间等待其触发与回落。 */
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 2));
};

/* ── (6) 注册表口径：仅 004 声明、阈值与样本中点一致 ── */
{
  assert.deepEqual(cfgOf("feedheiliao"), { maxBodyChars: 890 },
    "feedheiliao 声明 staffVerify.maxBodyChars=890（站务上限 706 与内容下限 1075 的中点）");
  for (const id of ["51chigua", "meiridasai", "huangguo", "xiuren", "hanime-tv"]) {
    assert.equal(staffVerifyConfig(def(id)), null, `${id} 未声明 staffVerify（零外溢）`);
  }
  assert.match(promoVerifyScope(def("feedheiliao"), cfgOf("feedheiliao")),
    new RegExp(`^feedheiliao/staff-verify/v${PROMO_VERIFY_RULE_VERSION}/max890$`),
    "作用域串含源 id＋判据版本＋阈值");
}

/* ── (3) 正文量法 ── */
{
  assert.equal(bodyTextLength(undefined), null, "contentHtml 缺失 → null（提取不到不等于空）");
  assert.equal(bodyTextLength(`<p>ab</p><script>var x = "长长长";</script><style>.a{}</style><p> cd </p>`), 5,
    "script/style 不计入、标签剥离、空白折叠（结果「ab cd」5 字）");
  assert.equal(bodyTextLength(detailOf(650, 0).contentHtml), 650, "合成正文长度与构造一致");
}

/* ── (1)(2) 判据 ── */
{
  const cfg = cfgOf("feedheiliao");
  assert.equal(classifyStaffPost(detailOf(587, 0), cfg), "staff", "站务样本下限 587 字∧无流 → staff");
  assert.equal(classifyStaffPost(detailOf(706, 0), cfg), "staff", "站务样本上限 706 字∧无流 → staff");
  assert.equal(classifyStaffPost(detailOf(890, 0), cfg), "staff", "阈值边界 890 字∧无流 → staff");
  assert.equal(classifyStaffPost(detailOf(891, 0), cfg), "clean", "阈值边界 891 字∧无流 → clean（边距外）");
  assert.equal(classifyStaffPost(detailOf(1075, 1), cfg), "clean", "内容样本下限 1075 字∧有流 → clean");
  assert.equal(classifyStaffPost(detailOf(1744, 1), cfg), "clean",
    "活动投票帖反例：1744 字∧有流 → clean（活动壳＋真内容，用户裁定保留）");
  assert.equal(classifyStaffPost(detailOf(500, 1), cfg), "clean",
    "短正文∧有流 → clean（episodes 合取守门：有流不杀）");
  assert.equal(classifyStaffPost({ contentHtml: undefined, episodes: [] }, cfg), "unknown",
    "正文提取不到 → unknown（不判、不杀）");
  /* (2) 合成反例——已知尾巴风险：短正文∧无流的真实短内容帖会
   * 被现行判据误杀。样本内内容帖下限 1075 字且均有流、此形态
   * 未出现；按用户「垃圾可伤」口径接受现状，此断言钉死之。 */
  assert.equal(classifyStaffPost(detailOf(500, 0), cfg), "staff",
    "合成反例：500 字∧无流 → staff（已知尾巴风险，见文件头 (2)）");
}

/* ── (4) 判定缓存：落盘/重绑/版本失效 ── */
{
  const backing = new Map<string, string>();
  const storage: PromoVerdictStorageLike = {
    getItem: (k) => backing.get(k) ?? null,
    setItem: (k, v) => { backing.set(k, v); },
  };
  bindPromoVerifyStorage(storage);
  const scope = promoVerifyScope(def("feedheiliao"), cfgOf("feedheiliao"));
  recordPromoVerdict(scope, "post-a", "staff");
  recordPromoVerdict(scope, "post-b", "clean");
  bindPromoVerifyStorage(null);
  bindPromoVerifyStorage(storage); /* 重绑同一存储 = 模拟进程重启后读盘 */
  assert.deepEqual(getPromoVerdicts(scope), { "post-a": "staff", "post-b": "clean" },
    "判定落盘后重启可读（每帖一生只验一次的依据）");
  const staleScope = `feedheiliao/staff-verify/v${PROMO_VERIFY_RULE_VERSION - 1}/max890`;
  recordPromoVerdict(staleScope, "post-old", "staff");
  recordPromoVerdict(scope, "post-c", "clean"); /* 新判定落盘触发旧域清理 */
  assert.deepEqual(getPromoVerdicts(staleScope), {}, "旧判据版本作用域在落盘时被清掉（自动失效）");
  assert.equal(getPromoVerdicts(scope)["post-c"], "clean", "现行作用域判定不受清旧影响");
  bindPromoVerifyStorage(null);
}

/* ── (5) 验杀会话：并发/去重/失败与 unknown 不落缓存/缓存回放 ── */
{
  const backing = new Map<string, string>();
  bindPromoVerifyStorage({
    getItem: (k) => backing.get(k) ?? null,
    setItem: (k, v) => { backing.set(k, v); },
  });
  const d = def("feedheiliao");
  const cfg = cfgOf("feedheiliao");
  const scope = promoVerifyScope(d, cfg);
  const item = (externalId: string): SourceItem => ({
    sourceId: d.id, externalId, title: "t", cover: "", href: externalId, tags: [],
  });
  let active = 0;
  let maxActive = 0;
  const fetchCalls: string[] = [];
  const verdicts: [string, string][] = [];
  const session = createPromoVerifySession({
    def: d,
    cfg,
    fetchDetail: async (id) => {
      fetchCalls.push(id);
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (id === "fail-1") throw new Error("network down");
      if (id === "unknown-1") return { contentHtml: undefined, episodes: [] } as unknown as SourceDetail;
      if (id.startsWith("staff-")) return detailOf(650, 0) as unknown as SourceDetail;
      return detailOf(1500, 1) as unknown as SourceDetail;
    },
    onVerdict: (id, v) => { verdicts.push([id, v]); },
  });
  const batch = ["staff-1", "staff-2", "ok-1", "ok-2", "fail-1", "unknown-1", "ok-3"].map(item);
  session.enqueue(batch);
  session.enqueue(batch); /* 重复入队：在飞/已处理去重，不许重复抓 */
  await flush();
  assert.ok(maxActive <= 3, `并发峰值 ${maxActive} ≤ 3`);
  assert.equal(new Set(fetchCalls).size, fetchCalls.length, "同一帖在会话内只抓一次");
  assert.deepEqual(verdicts.filter(([, v]) => v === "staff").map(([id]) => id).sort(),
    ["staff-1", "staff-2"], "站务型判定回放给列表面撤下");
  const cached = getPromoVerdicts(scope);
  assert.equal(cached["staff-1"], "staff", "站务判定落盘");
  assert.equal(cached["ok-1"], "clean", "内容判定落盘");
  assert.ok(!("fail-1" in cached), "详情失败不落缓存（网络失败≠站务，下次挂载再验）");
  assert.ok(!("unknown-1" in cached), "unknown 不落缓存（提取不到不等于已判）");
  assert.ok(!verdicts.some(([id]) => id === "fail-1" || id === "unknown-1"),
    "失败/unknown 不产生判定回放（不撤帖）");
  session.dispose();

  /* 新会话（模拟下次挂载）：已落盘判定直接回放、不再抓详情；
   * 上次失败的帖子则重新验（失败不缓存的另一面）。 */
  const fetch2: string[] = [];
  const verdicts2: [string, string][] = [];
  const session2 = createPromoVerifySession({
    def: d,
    cfg,
    fetchDetail: async (id) => {
      fetch2.push(id);
      return detailOf(1500, 1) as unknown as SourceDetail;
    },
    onVerdict: (id, v) => { verdicts2.push([id, v]); },
  });
  session2.enqueue([item("staff-1"), item("fail-1")]);
  await flush();
  assert.deepEqual(fetch2, ["fail-1"], "已落盘的 staff-1 不再抓详情；上次失败的 fail-1 重新验");
  assert.ok(verdicts2.some(([id, v]) => id === "staff-1" && v === "staff"),
    "缓存 staff 判定经 enqueue 直接回放（列表一挂载即撤下、无闪烁窗口）");
  session2.dispose();
  bindPromoVerifyStorage(null);
}

/* ── (6) SourcePosts 接线文本断言 ── */
{
  const src = readFileSync(new URL("./SourcePosts.tsx", import.meta.url), "utf8");
  assert.ok(src.includes("useStaffPromoVerify(def, items, fetchDetailForVerify)"), "SourcePosts 接入验杀 hook（注入适配器 detail）");
  assert.ok(src.includes("visibleItems"), "SourcePosts 呈现按验杀后的 visibleItems");
}

console.log("fix333-promo-004 contract: OK");
