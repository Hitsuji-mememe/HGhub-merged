/**
 * 诊断档位行契约测试（Muse 2026-11-19 3.3.0批诊断档位线；
 * 新增测试经维护者在任务书中授权，AGENTS 不变量 11，只加这一组）。
 * 运行：node src/shared/diagnostics/fix330-diag-levels.contract.test.ts
 *
 * 背景（3.2.2 真机诊断实锤，见 fix330/evidence/diag-levels.md）：贴文含
 * 完整播放事实（720x1280 · 1219 kbps · 判档 natural），却无任何档位行，
 * 「源有几档」不可判读。逐环定性：rendition 只活在内存 PlaybackFacts
 * 快照里（不入日志/账本），报告里又只是「超分：」行的条件后缀——
 * facts.firstRendition 缺失即整段静默省略，无「未知」标记；最高档
 * （levels 末位）参数从未被采集。本测试钉三件事：
 * ①同形场景（有播放、采集侧有 rendition 事实）：档位行必出且三要素
 *   （档数 N · 当前档序号 · 最高档分辨率/码率）齐全；
 * ②要素缺失（未触发／原生不可控／快照缺失）：行仍出现，缺失项标
 *   「未知」并标缺失来源，不许整行消失；
 * ③无播放证据时不出行（不编造）；报告侧接线以源码断言钉住。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatLevelFactsLine, levelFactsFromFirstRendition } from "./levelFacts.ts";
import type { PlaybackFacts } from "./playbackFacts.ts";

const factsBase: PlaybackFacts = { w: 720, h: 1280, bitrateBps: 1_219_000, srMode: "natural", pipeline: "webgpu", at: 1 };

/* ── ① 同形场景：采集侧有结构化 rendition 事实 ──────────────────── */
{
  const levelFacts = levelFactsFromFirstRendition({
    index: 1, total: 1, width: 720, height: 1280, bitrate: 1_219_000,
    topWidth: 720, topHeight: 1280, topBitrate: 1_219_000,
  });
  assert.deepEqual(levelFacts, { total: 1, currentIndex: 1, topWidth: 720, topHeight: 1280, topBitrate: 1_219_000 }, "首分片 rendition → 结构化档位事实（最高档取 levels 末位）");
  const line = formatLevelFactsLine({ facts: { ...factsBase, levelFacts }, hasPlayback: true });
  assert.ok(line != null && line.startsWith("档位："), "含播放的诊断必含档位行");
  assert.ok(line.includes("共 1 档"), "档位行含档数 N");
  assert.ok(line.includes("当前第 1 档"), "档位行含当前档序号");
  assert.ok(line.includes("最高档 720x1280"), "档位行含最高档分辨率");
  assert.ok(line.includes("最高档码率 1219 kbps"), "档位行含最高档码率");
}
{
  /* 多档：当前档（首分片，起播锁最高档）与最高档同为末档也要分开报。 */
  const line = formatLevelFactsLine({
    facts: { ...factsBase, levelFacts: { total: 4, currentIndex: 4, topWidth: 1920, topHeight: 1080, topBitrate: 8_000_000 } },
    hasPlayback: true,
  });
  assert.ok(line != null && line.includes("共 4 档") && line.includes("当前第 4 档") && line.includes("最高档 1920x1080") && line.includes("最高档码率 8000 kbps"), "多档三要素齐全");
}
{
  /* 旧形态 facts（只有预格式化 firstRendition 字符串、无结构化字段，
   * 与真机失败同形）：回落解析出档数/当前档；当前档即末档时其参数
   * 即最高档参数，行不得缺。 */
  const line = formatLevelFactsLine({ facts: { ...factsBase, firstRendition: "第 1/1 档 · 720x1280 · 1219kbps" }, hasPlayback: true });
  assert.ok(line != null && line.includes("共 1 档") && line.includes("当前第 1 档") && line.includes("最高档 720x1280") && line.includes("最高档码率 1219 kbps"), "旧形态字符串回落解析仍出齐三要素");
  const partial = formatLevelFactsLine({ facts: { ...factsBase, firstRendition: "第 2/4 档 · 1280x720 · 2500kbps" }, hasPlayback: true });
  assert.ok(partial != null && partial.includes("共 4 档") && partial.includes("当前第 2 档"), "旧形态多档回落出档数/当前档");
  assert.ok(partial.includes("最高档 未知"), "当前档非末档时最高档不冒充当前档参数、如实标未知");
}

/* ── ② 要素缺失：行仍在、逐项标未知＋缺失来源 ───────────────────── */
{
  /* facts 在、rendition 未记录（未触发/复位未重采形态）。 */
  const line = formatLevelFactsLine({ facts: factsBase, hasPlayback: true });
  assert.ok(line != null && line.startsWith("档位："), "rendition 缺失时档位行仍出现");
  assert.ok(line.includes("未知") && line.includes("缺失来源"), "缺失要素标未知并标来源");
  assert.ok(line.includes("首分片 rendition 未记录"), "缺失来源指明首分片 rendition 通道");
}
{
  /* 原生引擎：采集侧明示不可控。 */
  const line = formatLevelFactsLine({
    facts: { ...factsBase, levelFacts: { missingNote: "原生引擎档位不可控（无 rendition 列表）" } },
    hasPlayback: true,
  });
  assert.ok(line != null && line.includes("原生引擎档位不可控"), "原生引擎缺失来源如实入行");
}
{
  /* facts 快照缺失但账本/流水有播放（F3b flowMissingButPlaying 同形）。 */
  const line = formatLevelFactsLine({ facts: null, hasPlayback: true });
  assert.ok(line != null && line.startsWith("档位：") && line.includes("未知") && line.includes("播放事实快照缺失"), "快照缺失但有播放时档位行仍出现并标来源");
}
{
  /* 最高档未声明码率：只缺该要素，其余要素照常。 */
  const line = formatLevelFactsLine({
    facts: { ...factsBase, levelFacts: { total: 2, currentIndex: 2, topWidth: 1280, topHeight: 720 } },
    hasPlayback: true,
  });
  assert.ok(line != null && line.includes("最高档 1280x720") && line.includes("最高档码率 未知"), "单要素缺失只标该要素");
}

/* ── ③ 无播放证据不出行 ──────────────────────────────────────────── */
assert.equal(formatLevelFactsLine({ facts: null, hasPlayback: false }), null, "无播放证据时不出档位行（不编造）");

/* ── 报告与采集侧接线断言 ────────────────────────────────────────── */
{
  const report = readFileSync(new URL("./diagnosticReport.ts", import.meta.url), "utf8");
  assert.ok(report.includes("formatLevelFactsLine("), "诊断报告经 formatLevelFactsLine 拼装独立档位行（唯一口径）");
  const kernel = readFileSync(new URL("../../features/playback/usePlaybackKernel.ts", import.meta.url), "utf8");
  assert.ok(kernel.includes("levelFactsFromFirstRendition("), "播放内核在首分片采集点同步登记结构化档位事实（两面共用 attachHls）");
  const hlsConfig = readFileSync(new URL("../../features/playback/hlsConfig.ts", import.meta.url), "utf8");
  assert.ok(hlsConfig.includes("topBitrate"), "采集点附带最高档（levels 末位）参数，不止首分片所属档");
}

console.log("fix330-diag-levels.contract: all assertions passed");
