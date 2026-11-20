/**
 * fix332-B1 契约：hls-site 详情图片只收内容区，站点样式资产不进相册。
 * 运行：node src/features/sources/fix332-b1.contract.test.ts
 * 背景（3.3.2 独立证伪清扫 B1）：source-007 真站详情页经生产适配器
 * 实跑，每册恒定混入 5 张站点样式 SVG（页眉 logo×2＋登录图标＋页脚
 * 合规徽标×2，全在内容区之外）充当相册照片——旧 htmlDetail 以整页
 * allImgSrcs 为图集、无内容区限定。真站三册 DOM 实测：内容图（含
 * 列表内 banner tile 的头像）全在内容区地标（id="main" 容器）内、
 * 样式资产全在地标外，地标边界与两集分割完全重合。
 * 本契约钉死：①有地标时 detail.images 恰为地标内图片（顺序/重复
 * 与整页采集在地标内的投影一致）；②<main> 元素地标同效；③无地标
 * 或地标未配平时回落整页采集（旧行为逐字不变、无地标站零影响）。
 * 夹具 hls-detail-gallery.html 按真站形态构造（非真站抓取），不访问
 * 真实网络。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setFetchPage } from "./adapters/fetchPage.ts";
import { createHlsSiteAdapter } from "./adapters/templates.ts";
import { allImgSrcs } from "./adapters/parse.ts";
import type { SourceDef } from "./types.ts";

const fx = (name: string) => readFileSync(new URL(`./adapters/fixtures/${name}`, import.meta.url), "utf8");
/* 断言适配（fix335/g-sources）：pornpics 已退役摘除注册表，改用与删除
 * 前注册表条目功能字段一致的内联 def 守 hls-site 详情采集覆盖，断言
 * 内容不变（模板代码留仓）。 */
const def: SourceDef = {
  id: "pornpics", displayName: "PornPics", kind: "image", category: "image",
  adapter: { template: "hls-site", params: { listPath: "/recent/", itemLinkPattern: "/galleries/", detailPath: "/galleries/{id}/" } },
  baseUrls: ["https://www.pornpics.com"], enabled: true, order: 41, maturity: "probe",
  capabilities: { search: false, episodes: false, hevc: false, comments: false },
  network: { mode: "probe-required" },
};

const LIST_HTML = `<a href='https://www.pornpics.com/galleries/fixture-album-1001/'><h2>Fixture Album</h2></a>`;

/* ── 主形态：id="main" 地标（真站 007 形态） ── */
{
  setFetchPage(async (url) => (url.includes("/galleries/") ? fx("hls-detail-gallery.html") : LIST_HTML));
  const a = createHlsSiteAdapter(def);
  const list = await a.list(1, 20);
  assert.equal(list.items.length, 1, "列表 1 条");
  const detail = await a.detail(list.items[0].externalId);
  assert.equal(detail.title, "Fixture Album One", "详情标题 og:title");
  const expected = [
    "https://cdni.example.com/av/48_300x450.jpg",
    "https://cdni.example.com/460/3/51/1001/1001_001_ab12.jpg",
    "https://cdni.example.com/460/3/51/1001/1001_002_cd34.jpg",
    "https://public.example.net/files/c/avatar.jpg",
    "https://cdni.example.com/460/3/51/1001/1001_003_ef56.jpg",
    "https://cdni.example.com/av/39_300x450.jpg",
  ];
  assert.deepEqual(detail.images, expected, "图集恰为内容区内图片（顺序一致、banner 头像保留）");
  assert.ok(detail.images.every((u) => !u.endsWith(".svg")), "样式 SVG 不进相册");
}

/* ── <main> 元素地标同效 ── */
{
  const html = `<header><img src="https://static.example.com/style/img/logo.svg"></header>`
    + `<main><img src="https://img.example.com/a.jpg"><div><img src="https://img.example.com/b.jpg"></div></main>`
    + `<footer><img src="https://static.example.com/style/img/badge.svg"></footer>`;
  setFetchPage(async () => html);
  const a = createHlsSiteAdapter(def);
  const detail = await a.detail("https://www.pornpics.com/galleries/x-1/");
  assert.deepEqual(detail.images, ["https://img.example.com/a.jpg", "https://img.example.com/b.jpg"], "<main> 地标内采集");
}

/* ── 无地标：回落整页采集（旧行为不变） ── */
{
  const html = `<div><img src="https://img.example.com/p.jpg"></div><div><img src="https://static.example.com/style/img/logo.svg"></div>`;
  setFetchPage(async () => html);
  const a = createHlsSiteAdapter(def);
  const detail = await a.detail("https://www.pornpics.com/galleries/x-2/");
  assert.deepEqual(detail.images, allImgSrcs(html), "无地标时与整页采集逐字一致");
}

/* ── 地标未配平：回落整页采集 ── */
{
  const html = `<div id="main"><img src="https://img.example.com/p.jpg"><div><img src="https://img.example.com/q.jpg">`;
  setFetchPage(async () => html);
  const a = createHlsSiteAdapter(def);
  const detail = await a.detail("https://www.pornpics.com/galleries/x-3/");
  assert.deepEqual(detail.images, allImgSrcs(html), "地标未配平时与整页采集逐字一致");
}

console.log("fix332-b1 contract: all assertions passed");
