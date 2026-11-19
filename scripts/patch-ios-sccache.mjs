/**
 * sccache 接入补丁（Muse 2026-11-19，fix2 C3 实验）。
 *
 * 背景（fix1 教训）：在 workflow 层 export RUSTC_WRAPPER 进不到
 * Xcode 的「Build Rust Code」脚本阶段（该阶段由 xcodebuild 以工程
 * 内脚本独立执行）。正确做法是把设置直接写进生成工程的阶段脚本
 * 开头。本脚本在 `tauri ios init` 之后运行：
 *   1. 找到 src-tauri/gen/apple/*.xcodeproj/project.pbxproj；
 *   2. 定位含 cargo 调用的 shellScript 段（Build Rust Code 阶段）；
 *   3. 在脚本开头插入：source 运行时环境文件（workflow 写入
 *      $RUNNER_TEMP 的 SCCACHE_GHA_ENABLED/ACTIONS_* ——密钥只经
 *      运行时文件传递，绝不写进仓库或工程文件）＋
 *      RUSTC_WRAPPER=sccache ＋ CARGO_INCREMENTAL=0（仅 CI）。
 * 找不到 cargo 阶段即非零退出（实验失败要响亮，不许静默无效）。
 *
 * 用法：node scripts/patch-ios-sccache.mjs <sccache-env.sh 绝对路径>
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const envFile = process.argv[2];
if (!envFile) {
  console.error("用法：node scripts/patch-ios-sccache.mjs <sccache-env.sh 绝对路径>");
  process.exit(2);
}
/* env 文件由 workflow 在调用本脚本前写入；缺失说明 workflow 步骤
 * 顺序被改坏，此时阶段脚本会静默降级成本地缓存——响亮失败，
 * 不要静默无效（Muse 2026-11-19 热跑验证后补强）。 */
if (!existsSync(envFile)) {
  console.error(`sccache env 文件不存在：${envFile}（workflow 应先写入 $RUNNER_TEMP/sccache-env.sh）`);
  process.exit(1);
}
const appleDir = "src-tauri/gen/apple";
const projects = readdirSync(appleDir).filter((n) => n.endsWith(".xcodeproj"));
if (projects.length !== 1) {
  console.error(`期望恰好 1 个 xcodeproj，实际 ${projects.length}`);
  process.exit(1);
}
const pbxPath = join(appleDir, projects[0], "project.pbxproj");
const original = readFileSync(pbxPath, "utf8");

/* pbxproj 的 shellScript 是带 \n 转义的引号字符串。逐段扫描
 * shellScript = "...."; 段，含 cargo 的即补丁目标。 */
const segmentRe = /shellScript = "((?:[^"\\]|\\.)*)";/g;
let patched = 0;
let alreadyPatched = 0;
const prefix =
  `[ -f \\"${envFile}\\" ] && . \\"${envFile}\\"; ` +
  `export RUSTC_WRAPPER=sccache; export CARGO_INCREMENTAL=0; `;
const out = original.replace(segmentRe, (whole, body) => {
  /* Tauri v2 的 Build Rust Code 阶段脚本是
   * `pnpm tauri ios xcode-script ...`（内部再起 cargo），脚本里
   * 没有字面 "cargo"——两种形态都认，前缀 env 由子进程继承。 */
  if (!body.includes("cargo") && !body.includes("xcode-script")) return whole;
  if (body.includes("RUSTC_WRAPPER")) { alreadyPatched += 1; return whole; }
  patched += 1;
  return `shellScript = "${prefix}${body}";`;
});
if (patched === 0 && alreadyPatched > 0) {
  /* 重复运行不重复插入；此前会误报「未找到阶段」并 exit 1，
   * 错误信息与真实原因不符（Muse 2026-11-19 本地实测发现）。 */
  console.log(`already patched (${alreadyPatched} shell script phase(s)) in ${pbxPath}`);
  process.exit(0);
}
if (patched === 0) {
  console.error("未找到含 cargo 的 shellScript 阶段，补丁未生效");
  /* 诊断：把所有阶段脚本的开头打出来，下一轮按真实内容改匹配。 */
  const all = [...original.matchAll(/shellScript = "((?:[^"\\]|\\.)*)";/g)];
  console.error(`共 ${all.length} 个 shellScript 段：`);
  all.forEach((m, i) => {
    console.error(`── seg ${i}: ${m[1].slice(0, 300).replace(/\\n/g, " ⏎ ")}`);
  });
  process.exit(1);
}
writeFileSync(pbxPath, out);
console.log(`patched ${patched} shell script phase(s) in ${pbxPath}`);
