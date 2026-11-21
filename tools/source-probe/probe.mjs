#!/usr/bin/env node
/**
 * source-probe — 探路源轻量探测（Muse 2026-11-19 根治包·多源线 条目1）
 *
 * 对探路 4 站逐个测三件事（只发普通 GET、不绕验证墙、不下媒体文件）：
 *   1) 列表页 plain HTTP 可达：状态码 / 是否被 JS 墙或验证墙挡；
 *   2) 页面可解析出条目：按通用链接启发式数出候选条目数；
 *   3) 详情页可提取 HLS：跟进第一个条目详情页，找 .m3u8 地址。
 *
 * 出口两轮：①直连（--noproxy '*'）；②环境代理（HTTPS_PROXY 等，
 * 本机出口为非日本；双轮起因是已删的 Hanime1「封日本 IP」，机制保留）。两轮都记。
 * 产出 results.json + results.md，并把每站最佳一轮的列表页样本存
 * fixtures/<id>-list.html 供适配器契约测试当录制夹具（截断 256KB）。
 *
 * 用法：node tools/source-probe/probe.mjs
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const TIMEOUT_S = 25;
const MAX_BODY = 2 * 1024 * 1024;

export const PROBE_TARGETS = [
  { id: "jabletv", name: "JableTV", listUrl: "https://jable.tv/", detailHint: /\/videos\/[a-z0-9-]+\//i },
  { id: "missav", name: "MissAV", listUrl: "https://missav.ws/", detailHint: /\/[a-z]{2,}\/([a-z]+-\d+)/i },
  { id: "tikporn", name: "Tik.porn", listUrl: "https://tik.porn/", detailHint: /\/video\//i },
  { id: "iwara", name: "Iwara", listUrl: "https://www.iwara.tv/videos", detailHint: /\/video\//i },
];

const WALL_MARKERS = [
  { kind: "cloudflare-challenge", re: /cf-challenge|challenges\.cloudflare\.com|just a moment|checking your browser/i },
  { kind: "captcha", re: /recaptcha|hcaptcha|g-recaptcha|verify you are human|人机验证|安全验证/i },
  { kind: "js-wall", re: /enable javascript|requires javascript|noscript/i },
  { kind: "age-gate", re: /age.?verification|are you (over )?18|年齢確認|年龄确认/i },
];

async function fetchViaCurl(url, useProxy) {
  const args = ["-sS", "-L", "--max-time", String(TIMEOUT_S), "--max-filesize", String(MAX_BODY),
    "-A", UA, "-w", "\n__PROBE_STATUS__:%{http_code}:%{url_effective}"];
  if (useProxy) {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
    if (!proxy) return { ok: false, error: "no-proxy-env" };
    args.push("--proxy", proxy);
  } else {
    args.push("--noproxy", "*");
  }
  args.push(url);
  try {
    const { stdout } = await run("curl", args, { maxBuffer: MAX_BODY + 65536, timeout: (TIMEOUT_S + 5) * 1000 });
    const m = stdout.match(/\n__PROBE_STATUS__:(\d{3}):(.*)$/s);
    const body = m ? stdout.slice(0, m.index) : stdout;
    return { ok: true, status: m ? Number(m[1]) : 0, finalUrl: m ? m[2].trim() : url, body };
  } catch (e) {
    const stdout = e.stdout ? String(e.stdout) : "";
    const m = stdout.match(/\n__PROBE_STATUS__:(\d{3}):(.*)$/s);
    if (m) return { ok: true, status: Number(m[1]), finalUrl: m[2].trim(), body: stdout.slice(0, m.index) };
    return { ok: false, error: String(e.stderr || e.message || e).slice(0, 200) };
  }
}

function analyzeList(body, target) {
  const walls = WALL_MARKERS.filter((w) => w.re.test(body)).map((w) => w.kind);
  const links = [...body.matchAll(/href="([^"]+)"/gi)].map((x) => x[1]);
  const items = links.filter((h) => target.detailHint.test(h));
  const uniqueItems = [...new Set(items)];
  const hasM3u8 = /\.m3u8(\?|"|')/.test(body);
  return { walls, linkCount: links.length, itemCount: uniqueItems.length, sampleItems: uniqueItems.slice(0, 3), hasM3u8InList: hasM3u8, bytes: body.length };
}

function extractM3u8(body) {
  const m = body.match(/https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/i);
  return m ? m[0] : null;
}

async function probeRound(target, useProxy) {
  const list = await fetchViaCurl(target.listUrl, useProxy);
  if (!list.ok) return { reachable: false, error: list.error, status: null, walls: [], parse: null, hls: null, body: "" };
  const parse = analyzeList(list.body, target);
  let hls = null;
  const firstItem = parse.sampleItems[0];
  if (firstItem && list.status >= 200 && list.status < 400 && parse.walls.length === 0) {
    const detailUrl = new URL(firstItem, list.finalUrl).href;
    const detail = await fetchViaCurl(detailUrl, useProxy);
    if (detail.ok) {
      const found = extractM3u8(detail.body);
      hls = { detailUrl, detailStatus: detail.status, found: Boolean(found), evidence: found ? "detail html contains .m3u8 URL" : "no .m3u8 in detail html (可能需 JS/接口)" };
    } else {
      hls = { detailUrl, detailStatus: null, found: false, evidence: `detail fetch failed: ${detail.error}` };
    }
  }
  return { reachable: list.status >= 200 && list.status < 400, status: list.status, error: list.status === 0 ? "connection-failed (curl status 000)" : undefined, finalUrl: list.finalUrl, walls: parse.walls, parse, hls, body: list.body };
}

function verdict(r) {
  if (!r || !r.reachable) return "降级";
  if (r.walls.length > 0) return "降级";
  if (!r.parse || r.parse.itemCount === 0) return "降级";
  return "可接入";
}

const results = { generatedAt: new Date().toISOString(), proxyEnvPresent: Boolean(process.env.HTTPS_PROXY || process.env.https_proxy), sites: [] };
await mkdir(new URL("./fixtures/", import.meta.url), { recursive: true });

for (const target of PROBE_TARGETS) {
  process.stderr.write(`[probe] ${target.id} direct…\n`);
  const direct = await probeRound(target, false);
  process.stderr.write(`[probe] ${target.id} proxy…\n`);
  const viaProxy = await probeRound(target, true);
  const best = verdict(viaProxy) === "可接入" ? { round: "proxy", ...viaProxy } : verdict(direct) === "可接入" ? { round: "direct", ...direct }
    : (viaProxy.status ?? 0) > 0 ? { round: "proxy", ...viaProxy } : (direct.status ?? 0) > 0 ? { round: "direct", ...direct } : { round: "proxy", ...viaProxy };
  const conclusion = verdict(best);
  const reasons = [];
  if (!best.reachable) reasons.push(`不可达(status=${best.status ?? "无"}, ${best.error ?? "链路失败"})`);
  if (best.walls?.length) reasons.push(`墙: ${best.walls.join(",")}`);
  if (best.reachable && !best.walls?.length && best.parse?.itemCount === 0) reasons.push("列表页解析不出条目(通用启发式 0 条，可能需 JS 渲染或专用选择器)");
  if (best.hls && !best.hls.found) reasons.push(`详情页未提取到 HLS: ${best.hls.evidence}`);
  if (conclusion === "可接入" && best.hls && !best.hls.found) reasons.push("注: 列表可解析但 HLS 未证实，接入后 resolve 可能需专用接口");
  const strip = ({ body, ...rest }) => rest;
  results.sites.push({ id: target.id, name: target.name, listUrl: target.listUrl, conclusion, reasons, bestRound: best.round, direct: strip(direct), proxy: strip(viaProxy) });
  const fixtureBody = (viaProxy.body?.length ?? 0) > (direct.body?.length ?? 0) ? viaProxy.body : direct.body;
  if (fixtureBody) await writeFile(new URL(`./fixtures/${target.id}-list.html`, import.meta.url), fixtureBody.slice(0, 256 * 1024));
}

await writeFile(new URL("./results.json", import.meta.url), JSON.stringify(results, null, 2));
const md = ["# 探路 4 站探测结果", "", `生成: ${results.generatedAt} · 代理环境变量存在: ${results.proxyEnvPresent}`, "",
  "| 站点 | 结论 | 最佳轮 | 可达 | 解析条目 | HLS | 墙 | 备注 |", "|---|---|---|---|---|---|---|---|",
  ...results.sites.map((s) => {
    const b = s.bestRound === "proxy" ? s.proxy : s.direct;
    return `| ${s.name} | ${s.conclusion} | ${s.bestRound} | ${b.reachable ? `是(${b.status})` : "否"} | ${b.parse?.itemCount ?? "-"} | ${b.hls ? (b.hls.found ? "是" : "否") : "-"} | ${(b.walls || []).join(",") || "无"} | ${s.reasons.join("; ") || "-"} |`;
  }), "", "证据摘要见 results.json（每站 direct/proxy 两轮的 status/walls/parse/hls 原始字段）。", ""].join("\n");
await writeFile(new URL("./results.md", import.meta.url), md);
process.stderr.write("[probe] done → results.json / results.md\n");
console.log(JSON.stringify(results.sites.map((s) => ({ id: s.id, conclusion: s.conclusion, bestRound: s.bestRound, reasons: s.reasons })), null, 2));
