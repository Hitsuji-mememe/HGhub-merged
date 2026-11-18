/**
 * Anime4K GLSL → WGSL 权重转换器（Muse 2026-11-19，fix2 超分换代）。
 *
 * 输入：bloc97/Anime4K（MIT）的两个 S 档 CNN 着色器原文
 *   glsl/Restore/Anime4K_Restore_CNN_Soft_S.glsl（同分辨率残差修复，4 趟）
 *   glsl/Upscale/Anime4K_Upscale_CNN_x2_S.glsl （2x 上采样，4 趟卷积＋1 趟
 *   Depth-to-Space：双线性底图＋单通道子像素细节残差）
 * 输出：src/features/playback/anime4kWeights.ts —— 每趟卷积的权重以
 * 「趟内出现顺序」原样导出（mat4 列主序字面量不做任何重排），运行时
 * WGSL 用同一列主序 mat4x4 乘法重放，保证与 GLSL 数值路径一致。
 * 转换是纯机械解析：数字逐字拷贝，不手抄、不取舍。解析失败即抛错退出，
 * 绝不产出半成品权重。
 *
 * 用法：node scripts/convert-anime4k.mjs <soft_s.glsl> <upscale_s.glsl>
 */
import { readFileSync, writeFileSync } from "node:fs";

function parsePasses(source, fileLabel) {
  const blocks = source.split(/(?=^\/\/!DESC )/m).filter((b) => b.includes("//!DESC"));
  if (!blocks.length) throw new Error(`${fileLabel}: 未找到任何 //!DESC 趟`);
  return blocks.map((block, idx) => {
    const desc = /\/\/!DESC (.+)/.exec(block)?.[1]?.trim() ?? "";
    const save = /\/\/!SAVE (\S+)/.exec(block)?.[1];
    if (!save) throw new Error(`${fileLabel} 趟 ${idx}: 缺 //!SAVE`);
    if (/Depth-to-Space/.test(desc)) {
      const bind = [...block.matchAll(/\/\/!BIND (\S+)/g)].map((m) => m[1]);
      return { kind: "d2s", desc, save, binds: bind, residual: /MAIN_tex\(MAIN_pos\)/.test(block) };
    }
    /* go_k 宏 → (源纹理, 激活模式)：max(-( 为 neg、max(( 为 pos、其余 raw。 */
    const gos = new Map();
    for (const m of block.matchAll(/#define (go_\d+)\(x_off, y_off\) \((.+)\)$/gm)) {
      const [, name, expr] = m;
      const tex = /(\w+)_texOff/.exec(expr)?.[1];
      if (!tex) throw new Error(`${fileLabel} 趟 ${idx}: ${name} 宏里找不到纹理名`);
      const mode = expr.includes("max(-(") ? "neg" : expr.includes("max((") ? "pos" : "raw";
      gos.set(name, { tex, mode });
    }
    if (!gos.size) throw new Error(`${fileLabel} 趟 ${idx}: 无 go 宏`);
    /* 卷积项：mat4(16 数) * go_k(dx, dy)，按出现顺序。 */
    const terms = [];
    const termRe = new RegExp(`mat4\\(([\\d\\.,\\s\\-e+]+)\\) \\* (go_\\d+)\\((-?\\d+\\.\\d+), (-?\\d+\\.\\d+)\\)`, "g");
    for (const m of block.matchAll(termRe)) {
      const nums = m[1].split(",").map((s) => Number(s.trim()));
      if (nums.length !== 16 || nums.some((n) => !Number.isFinite(n))) {
        throw new Error(`${fileLabel} 趟 ${idx}: mat4 数字个数异常 (${nums.length})`);
      }
      const go = gos.get(m[2]);
      if (!go) throw new Error(`${fileLabel} 趟 ${idx}: 未定义的 ${m[2]}`);
      terms.push({ tex: go.tex, mode: go.mode, dx: Number(m[3]), dy: Number(m[4]), w: nums });
    }
    if (terms.length !== 9 * gos.size && desc.includes("Conv")) {
      throw new Error(`${fileLabel} 趟 ${idx}: 卷积项数 ${terms.length} 与 9×${gos.size} 不符`);
    }
    const biasM = new RegExp(`result \\+= vec4\\(([\\d\\.,\\s\\-e+]+)\\);`).exec(block);
    if (!biasM) throw new Error(`${fileLabel} 趟 ${idx}: 缺 bias vec4`);
    const bias = biasM[1].split(",").map((s) => Number(s.trim()));
    if (bias.length !== 4) throw new Error(`${fileLabel} 趟 ${idx}: bias 个数异常`);
    const residual = /return result \+ MAIN_tex\(MAIN_pos\);/.test(block);
    return { kind: "conv", desc, save, terms, bias, residual };
  });
}

function emitPass(p) {
  if (p.kind === "d2s") {
    return `  { kind: "d2s", desc: ${JSON.stringify(p.desc)}, save: ${JSON.stringify(p.save)}, input: "conv2d_last_tf", residual: ${p.residual} },`;
  }
  const terms = p.terms.map((t) =>
    `    { tex: ${JSON.stringify(t.tex)}, mode: ${JSON.stringify(t.mode)}, dx: ${t.dx}, dy: ${t.dy}, w: [${t.w.join(", ")}] },`,
  );
  return [
    `  { kind: "conv", desc: ${JSON.stringify(p.desc)}, save: ${JSON.stringify(p.save)}, residual: ${p.residual}, bias: [${p.bias.join(", ")}], terms: [`,
    ...terms,
    "  ] },",
  ].join("\n");
}

const [softPath, upPath] = process.argv.slice(2);
if (!softPath || !upPath) {
  console.error("用法：node scripts/convert-anime4k.mjs <Restore_CNN_Soft_S.glsl> <Upscale_CNN_x2_S.glsl>");
  process.exit(2);
}
const restore = parsePasses(readFileSync(softPath, "utf8"), "Restore-Soft-S");
const upscale = parsePasses(readFileSync(upPath, "utf8"), "Upscale-x2-S");
console.log(`restore passes: ${restore.length}, upscale passes: ${upscale.length}`);

const out = `/**
 * Anime4K CNN 权重（自动生成，请勿手改）。
 *
 * 来源：bloc97/Anime4K（MIT License, Copyright (c) 2019-2021 bloc97）
 *   glsl/Restore/Anime4K_Restore_CNN_Soft_S.glsl
 *   glsl/Upscale/Anime4K_Upscale_CNN_x2_S.glsl
 * 由 scripts/convert-anime4k.mjs 从 GLSL 原文机械转换：mat4 字面量按
 * 列主序原样保留（w[列*4+行]），运行时 WGSL 以 mat4x4<f32> 同序乘法
 * 重放，与原 mpv GLSL 数值路径一致。激活模式：raw=原值、
 * pos=max(v,0)、neg=max(-v,0)（Anime4K 的 LeakyReLU 双路表示）。
 * residual=true 表示该趟输出需加回链首输入（MAIN）的中心像素。
 */

export type SrTerm = { tex: string; mode: "raw" | "pos" | "neg"; dx: number; dy: number; w: number[] };
export type SrPass =
  | { kind: "conv"; desc: string; save: string; residual: boolean; bias: number[]; terms: SrTerm[] }
  | { kind: "d2s"; desc: string; save: string; input: string; residual: boolean };

export const RESTORE_PASSES: SrPass[] = [
${restore.map(emitPass).join("\n")}
];

export const UPSCALE_PASSES: SrPass[] = [
${upscale.map(emitPass).join("\n")}
];
`;
const target = new URL("../src/features/playback/anime4kWeights.ts", import.meta.url);
writeFileSync(target, out);
console.log(`wrote ${target.pathname} (${out.length} bytes)`);
