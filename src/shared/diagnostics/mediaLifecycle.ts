/* 停滞判读补埋点·纯函数口径（Muse 2026-11-19 3.3.0批诊断标尺线）。
 *
 * ① media.emptied / media.abort 判读载荷：两事件此前混在
 * usePlayerDiagnostics 的通用 media 事件表里、经 `media.${e.type}`
 * 动态拼接入账——事件名无字面形态、无判读载荷，append 停滞复盘时
 * 静态检索与逐字段判读都无从下手（suspended-items 调查按字面名
 * grep 判「零监听」即源于此）。现提为显式专用埋点，载荷只取判读
 * 停滞所需的生命周期字段（就绪/网络状态、媒体错误码、缓冲末端、
 * 是否 seek 在途），不含任何媒体地址（日志不含秘密口径不变）。
 *
 * ② 内存压力信号查实：WKWebView/WebKit 不向 Web 内容暴露内存压力
 * 事件——WebKit 的 MemoryPressureHandler 只在原生 WebContent 进程
 * 内响应（清缓存/GC），不通知页面 JS；iOS 超限时进程被 jetsam 直
 * 接终止，页面无从记录。performance.memory 与 navigator.deviceMemory
 * 仅为 Chromium 系非标准用量仪表（存在也只是可轮询的用量数、不是
 * 压力事件源）；本仓 Tauri 侧亦无原生内存警告桥（src-tauri 全仓无
 * didReceiveMemoryWarning/onTrimMemory 接线）。结论：本环境无可用
 * 内存压力信号——memoryPressureSignalCheck 恒如实给出
 * pressure_event_available=false，只把两仪表的存在性记入查实行，
 * 不编造 memory.pressure 事件源、不轮询、不触发任何处置。 */

export type MediaLifecycleInput = {
  readyState: number;
  networkState: number;
  errorCode: number | null;
  bufferedEnd: number | null;
  seeking: boolean;
};

export function mediaLifecycleTraceData(input: MediaLifecycleInput): Record<string, unknown> {
  return {
    ready_state: input.readyState,
    network_state: input.networkState,
    media_error: input.errorCode,
    buffered_end: input.bufferedEnd,
    seeking: input.seeking,
  };
}

export type MemorySignalProbe = {
  performanceMemory: boolean;
  deviceMemory: boolean;
};

export function memoryPressureSignalCheck(probe: MemorySignalProbe): Record<string, unknown> {
  return {
    pressure_event_available: false,
    heap_usage_api: probe.performanceMemory,
    device_memory_api: probe.deviceMemory,
  };
}
