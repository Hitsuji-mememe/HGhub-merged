#!/usr/bin/env node
/**
 * 接线检查（整改批次 2026-11-19 建立，MERGE-PLAYBOOK 验收规矩第 1 条的机制化）：
 * 逐条核对 tools/wiring-manifest.json 中每个「已修」条目的关键符号，是否在
 * 清单所列的生产源码文件里真实出现（定义处之外的生产调用点）。
 *
 * 判定口径：
 * - 条目带 "each": true —— 所列每个文件都必须至少出现 1 次（多调用方形态，
 *   如 notePlaybackPlaying 必须 VideoSurface 与 Player 两处都在）。
 * - 否则 —— 所列文件出现次数总和必须 >= "min"（min 通常为 2：定义＋调用，
 *   或同文件内的定义点与消费点）。
 * - 清单所列文件不许是测试文件/夹具（路径含 test/fixture 即判清单错误）。
 *
 * 任一条不达标 exit 1。后续批次只增不减：新条目交付时同步往清单加行。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "tools", "wiring-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

function countOccurrences(text, symbol) {
  let n = 0;
  let i = text.indexOf(symbol);
  while (i !== -1) {
    n += 1;
    i = text.indexOf(symbol, i + symbol.length);
  }
  return n;
}

let failed = 0;
for (const entry of manifest.entries) {
  const problems = [];
  let total = 0;
  for (const rel of entry.files) {
    if (/(^|\/)(tests?|fixtures?)\//.test(rel) || /\.test\./.test(rel)) {
      problems.push(`清单错误：${rel} 是测试文件，接线证据必须落在生产源码`);
      continue;
    }
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      problems.push(`文件不存在：${rel}`);
      continue;
    }
    const n = countOccurrences(fs.readFileSync(abs, "utf8"), entry.symbol);
    total += n;
    if (entry.each && n < 1) problems.push(`${rel} 中未找到 ${entry.symbol}`);
  }
  if (!entry.each && total < (entry.min ?? 1)) {
    problems.push(`总出现 ${total} 次 < 要求 ${entry.min ?? 1} 次`);
  }
  if (problems.length) {
    failed += 1;
    console.log(`FAIL ${entry.id}（${entry.item}）：${problems.join("；")}`);
  } else {
    console.log(`ok   ${entry.id}（${entry.item}）：${entry.symbol} 共 ${total} 处`);
  }
}

console.log(`\nwiring-check: ${manifest.entries.length - failed}/${manifest.entries.length} entries wired`);
if (failed > 0) process.exit(1);
