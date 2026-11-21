/**
 * 适配器工厂（Muse 2026-11-19 根治包）：按注册表 adapter.template
 * 实例化。template="none"（探路未过）与未知模板返回 null——
 * 注册表完整性契约即「每个 enabled 源都能解析出适配器」。
 */
import type { SourceAdapter, SourceDef } from "../types";
import { createNativeHuangguoAdapter } from "./nativeHuangguo";
import { createChiguaAdapter, createDanbooruAdapter, createHlsSiteAdapter, createWpRestAdapter } from "./templates";
export function createAdapter(def: SourceDef): SourceAdapter | null {
  switch (def.adapter.template) {
    case "native-huangguo": return createNativeHuangguoAdapter();
    case "chigua": return createChiguaAdapter(def);
    case "wp-rest": return createWpRestAdapter(def);
    case "hls-site": return createHlsSiteAdapter(def);
    case "danbooru-api": return createDanbooruAdapter(def);
    default: return null;
  }
}

export { TEMPLATE_IDS } from "./templates";
