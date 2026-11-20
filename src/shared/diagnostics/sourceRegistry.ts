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

/* 每源健康行 provider（Muse 2026-11-19 根治包·飞行记录仪收口）：
 * 报告的「源健康」需要结构化数据（每源 maturity＋生效 origin＋最近
 * 取页结果），而数据本体在 features/sources——与版本 provider 同
 * 模式：启动处注册格式化函数，shared 只消费字符串行，不反向依赖
 * features。未注册时返回空数组，报告如实标注未接。 */
let healthProvider: (() => string[]) | null = null;

export function registerSourceHealthProvider(fn: () => string[]): void {
  healthProvider = fn;
}

export function sourceHealthLines(): string[] {
  try {
    return healthProvider?.() ?? [];
  } catch {
    return [];
  }
}

/* 逐源最近取页错误原文 provider（Muse 2026-11-20 fix336-a）：
 * 与健康行同模式——数据本体（fetchHealth 记录＋注册表归属）在
 * features/sources，报告只消费字符串行。未注册返回 null（报告如实
 * 标注未接），已注册无错误返回空数组，两态不许混。 */
let fetchErrorProvider: (() => string[]) | null = null;

export function registerSourceFetchErrorProvider(fn: () => string[]): void {
  fetchErrorProvider = fn;
}

export function sourceFetchErrorLines(): string[] | null {
  try {
    return fetchErrorProvider?.() ?? null;
  } catch {
    return null;
  }
}
