/**
 * 模板段结构事实（Muse 2026-11-20 fix333-M3，3.3.2 清扫 P9 收口）。
 *
 * 此前「哪个模板真有 search 方法」有两处口径：工厂本体（templates.ts
 * 与 hanimeApi.ts 的 create* 函数）与搜索层 multiSourceSearch.ts 手抄
 * 的 SEARCH_TEMPLATES / DETAIL_PLAY_TEMPLATES 副本集合——新模板接通
 * 须两处同步、漏改即静默漂移（3.3.0 三模板接通靠人工同步三处登记）。
 * 现段事实的唯一出处＝工厂本身：本模块逐模板以探针 def 实例化、
 * 按方法存在性派生，搜索层只消费本派生、不再持有模板名单。
 * detail/resolve 在 SourceAdapter 类型上必填——适配器存在即两段
 * 皆在（templateHasAdapter），唯一可选段只有 search
 * （templateHasSearch）。
 *
 * 本模块的工厂表与 adapters/index.ts 的 createAdapter 分发是同一
 * 事实的两个落点（index.ts 为无扩展名导入、Node 契约不可直载，
 * 其分发由多份既有契约以源码文本钉死，本批不改）：两表 parity
 * （分发有的模板探针必有、反之亦然）由 fix333-m3 契约逐模板钉死，
 * 任一侧新增模板漏改另一侧即契约红，不会静默漂移。
 *
 * 探针构造只建闭包、不发请求（各工厂构造期只读 params/baseUrls 并
 * 建闭包，取页都在方法内；既有适配器契约同款构造）。探针结果按
 * 模板缓存，进程内只算一次。
 *
 * 例外 native-huangguo：其工厂包既有 api 通道（shared/api 依赖
 * Tauri 运行时），探针环境（Node 契约进程）不可构造。其 search
 * 事实在此按工厂现状声明（对象字面含 search 方法、走
 * api.searchPosts），并由 fix333-m3 契约对 nativeHuangguo.ts 源码
 * 逐字钉死——工厂删掉 search 时契约先红，不会静默漂移。
 */
import type { SourceAdapter, SourceDef } from "../types.ts";
import { createHanimeApiAdapter } from "./hanimeApi.ts";
import {
  createChiguaAdapter, createDanbooruAdapter,
  createHlsSiteAdapter, createPreviewOnlyAdapter, createRedgifsAdapter,
  createSwagAdapter, createWpRestAdapter,
} from "./templates.ts";

/** 探针工厂表（与 index.ts createAdapter 分发 parity，见文件头）。 */
const PROBE_FACTORIES: Record<string, (def: SourceDef) => SourceAdapter> = {
  chigua: createChiguaAdapter,
  "wp-rest": createWpRestAdapter,
  "hls-site": createHlsSiteAdapter,
  "danbooru-api": createDanbooruAdapter,
  "swag-api": createSwagAdapter,
  "redgifs-api": createRedgifsAdapter,
  "hanime-api": createHanimeApiAdapter,
  "preview-only": createPreviewOnlyAdapter,
};

const probeDef = (template: string): SourceDef => ({
  id: "template-probe",
  displayName: "模板探针",
  kind: "video",
  category: "video",
  adapter: { template, params: {} },
  baseUrls: ["https://example.com"],
  enabled: false,
  order: 0,
  maturity: "probe",
  capabilities: { search: false, episodes: false, hevc: false, comments: false },
  network: { mode: "probe-required" },
  note: "段结构探针专用合成 def（fix333-M3）：只构造不取页",
});

const probeCache = new Map<string, SourceAdapter | null>();

function probeAdapter(template: string): SourceAdapter | null {
  const hit = probeCache.get(template);
  if (hit !== undefined) return hit;
  const factory = PROBE_FACTORIES[template];
  let adapter: SourceAdapter | null = null;
  if (factory) {
    try { adapter = factory(probeDef(template)); } catch { adapter = null; }
  }
  probeCache.set(template, adapter);
  return adapter;
}

/** 该模板有无适配器（有适配器即 detail/resolve 两段皆在——类型必填）。
 * "none" 与未知模板无适配器、三段全缺。 */
export function templateHasAdapter(template: string): boolean {
  if (template === "native-huangguo") return true;
  return probeAdapter(template) !== null;
}

/** 该模板的工厂真有 search 方法（唯一可选段，探针派生）。 */
export function templateHasSearch(template: string): boolean {
  /* native-huangguo 工厂现状声明（文件头例外）：search 走 api.searchPosts。 */
  if (template === "native-huangguo") return true;
  const adapter = probeAdapter(template);
  return adapter !== null && typeof adapter.search === "function";
}
