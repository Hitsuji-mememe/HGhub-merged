/* ── 源注册表版本 provider（Muse 2026-11-19 根治包，诊断导出补全）──
 * 诊断导出需要标注「源注册表版本」，注册表本体由多源线维护。本模块只
 * 提供可注册的 provider 钩子：多源线落地后在应用启动处调用
 * registerSourceRegistryProvider(() => registry.version) 接入；在那
 * 之前返回内置版本字符串，报告里如实标注「多源注册表未接」。 */
let provider: (() => string) | null = null;

export function registerSourceRegistryProvider(fn: () => string): void {
  provider = fn;
}

export function sourceRegistryVersion(): string {
  try {
    return provider?.() ?? "内置注册表（多源注册表未接）";
  } catch {
    return "内置注册表（版本读取失败）";
  }
}
