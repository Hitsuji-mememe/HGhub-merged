# tauri-plugin-avproto

AVFoundation 混合路线「验证原型」插件（Muse 2026-11-19，用户拍板）。

- 只被设置 → 诊断 →「AVFoundation 原型自检」入口调用；正式播放路径
  （hls.js / Feed / Player / 原生降级）不依赖本插件，默认不触发。
- Rust 侧只有三个命令：`proto_load` / `proto_status` / `proto_close`，
  透传给 iOS Swift 实现（`ios/Sources/AvProtoPlugin.swift`）；桌面端
  一律返回「仅适用于 iOS」。
- 验证对象：门1 AVPlayer 经本机回环 HLS 喂流端到端；门2 AVPlayerVideoOutput
  取帧 → CVMetalTextureCache → Metal 锐化管线实测。门3 账本在主应用
  `proto_lab` 模块，不在本插件。
- 结论落地后若路线不走，整目录 + 主应用三处接线（Cargo 依赖、
  lib.rs 注册、capability）可一并摘除。
