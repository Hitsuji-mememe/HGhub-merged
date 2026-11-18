import AVFoundation
import AVKit
import CoreVideo
import Metal
import SwiftRs
import Tauri
import UIKit

// AVFoundation 混合路线验证原型（Muse 2026-11-19）：
// 门1 —— AVPlayer 经本机回环 HLS 服务端到端播放（起播 / seek / 字幕轨 /
//        多码率 ABR 切换），全程只在自检页手动触发时运行。
// 门2 —— AVPlayerItemVideoOutput 取帧 → CVMetalTextureCache → Metal
//        锐化计算，实测每帧耗时与像素缓冲属性（只测不用，不回显）。
// 所有状态只在主队列上读写；结果经 protoStatus / protoClose 以 JSON
// 回前端，再由前端写入事件账本与诊断报告。播放直链不进日志。

class ProtoLoadArgs: Decodable {
  let url: String?
}

private let sharpenShaderSource = """
#include <metal_stdlib>
using namespace metal;
kernel void sharpen(texture2d<float, access::read> inTex [[texture(0)]],
                    texture2d<float, access::write> outTex [[texture(1)]],
                    uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= outTex.get_width() || gid.y >= outTex.get_height()) { return; }
  int w = int(inTex.get_width());
  int h = int(inTex.get_height());
  int x = int(gid.x);
  int y = int(gid.y);
  float3 c = inTex.read(gid).rgb;
  float3 l = inTex.read(uint2(uint(max(x - 1, 0)), gid.y)).rgb;
  float3 r = inTex.read(uint2(uint(min(x + 1, w - 1)), gid.y)).rgb;
  float3 u = inTex.read(uint2(gid.x, uint(max(y - 1, 0)))).rgb;
  float3 d = inTex.read(uint2(gid.x, uint(min(y + 1, h - 1)))).rgb;
  float3 s = c * 5.0 - (l + r + u + d);
  outTex.write(float4(clamp(s, 0.0, 1.0), 1.0), gid);
}
"""

class AvProtoPlugin: Plugin {
  // 播放侧
  private var player: AVPlayer?
  private var playerItem: AVPlayerItem?
  private var viewController: AVPlayerViewController?
  private var statusObservation: NSKeyValueObservation?
  private var timeObserverToken: Any?

  // 结果
  private var events: [[String: Any]] = []
  private var checks: [String: Any] = [:]
  private var loadStartedAt: Date?
  private var sequenceDone = false

  // 门1 阶段机（tick 驱动）：seek 0 未开始 / 1 进行中 / 2 结束；
  // abr 0 未开始 / 1 已钳制待读 / 2 结束
  private var didStartPlaying = false
  private var seekPhase = 0
  private var abrPhase = 0
  private var abrBaseline: Double = -1

  // 门2 帧管线
  private var videoOutput: AVPlayerItemVideoOutput?
  private var displayLink: CADisplayLink?
  private var metalDevice: MTLDevice?
  private var metalQueue: MTLCommandQueue?
  private var pipeline: MTLComputePipelineState?
  private var textureCache: CVMetalTextureCache?
  private var outTexture: MTLTexture?
  private var frameSamplesMs: [Double] = []
  private var frameWidth = 0
  private var frameHeight = 0
  private var frameFormat: UInt32 = 0
  private var frameIOSurface = false
  private var frameBytesPerRow = 0
  private var frameError: String?

  // MARK: - 命令入口

  @objc public func protoLoad(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ProtoLoadArgs.self)
    guard let urlString = args.url, let url = URL(string: urlString) else {
      invoke.reject("缺少有效的回环播放地址")
      return
    }
    DispatchQueue.main.async {
      self.startLoad(url: url)
      invoke.resolve(["started": true])
    }
  }

  @objc public func protoStatus(_ invoke: Invoke) throws {
    DispatchQueue.main.async {
      invoke.resolve(self.snapshot())
    }
  }

  @objc public func protoClose(_ invoke: Invoke) throws {
    DispatchQueue.main.async {
      let snap = self.snapshot()
      self.teardown()
      invoke.resolve(snap)
    }
  }

  // MARK: - 门1：加载与呈现

  private func startLoad(url: URL) {
    teardown()
    events = []
    checks = [:]
    sequenceDone = false
    didStartPlaying = false
    seekPhase = 0
    abrPhase = 0
    abrBaseline = -1
    frameSamplesMs = []
    frameError = nil
    loadStartedAt = Date()
    logEvent("load", "AVPlayerItem 已创建（回环地址）")

    let item = AVPlayerItem(url: url)
    playerItem = item

    setupFramePipeline(item: item)

    let player = AVPlayer(playerItem: item)
    self.player = player

    statusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
      DispatchQueue.main.async { self?.onItemStatus(item) }
    }
    timeObserverToken = player.addPeriodicTimeObserver(
      forInterval: CMTime(seconds: 0.5, preferredTimescale: 600),
      queue: .main
    ) { [weak self] time in
      self?.tick(time: time)
    }

    let vc = AVPlayerViewController()
    vc.player = player
    viewController = vc
    addCloseButton(to: vc)

    guard let top = topViewController() else {
      checks["present"] = "失败：找不到可呈现的视图控制器"
      logEvent("present", "失败：无顶层视图控制器")
      return
    }
    top.present(vc, animated: true) { [weak self] in
      self?.logEvent("present", "AVPlayerViewController 已呈现")
    }
    player.play()
    logEvent("play", "已调用 play()")
  }

  private func addCloseButton(to vc: AVPlayerViewController) {
    guard let overlay = vc.contentOverlayView else { return }
    let button = UIButton(type: .system)
    button.setTitle("关闭自检", for: .normal)
    button.setTitleColor(.white, for: .normal)
    button.backgroundColor = UIColor.black.withAlphaComponent(0.55)
    button.layer.cornerRadius = 15
    button.contentEdgeInsets = UIEdgeInsets(top: 6, left: 12, bottom: 6, right: 12)
    button.addTarget(self, action: #selector(onCloseButton), for: .touchUpInside)
    button.translatesAutoresizingMaskIntoConstraints = false
    overlay.addSubview(button)
    NSLayoutConstraint.activate([
      button.topAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.topAnchor, constant: 10),
      button.trailingAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.trailingAnchor, constant: -12),
      button.heightAnchor.constraint(equalToConstant: 30),
    ])
  }

  @objc private func onCloseButton() {
    logEvent("close", "用户点关闭自检（结果请回自检页查看）")
    teardown()
  }

  private func topViewController() -> UIViewController? {
    let window = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }
    var top = window?.rootViewController
    while let presented = top?.presentedViewController {
      top = presented
    }
    return top
  }

  // MARK: - 门1：状态机

  private func onItemStatus(_ item: AVPlayerItem) {
    switch item.status {
    case .readyToPlay:
      let ms = elapsedMs()
      checks["readyToPlayMs"] = ms
      logEvent("ready", "readyToPlay（\(ms)ms）")
      runSubtitleCheck(item)
      runVariantLoad(item)
    case .failed:
      let message = item.error?.localizedDescription ?? "未知错误"
      checks["itemError"] = message
      logEvent("itemFailed", message)
      sequenceDone = true
    default:
      break
    }
  }

  private func tick(time: CMTime) {
    guard let player = player, let item = playerItem else { return }
    if !didStartPlaying, player.timeControlStatus == .playing, time.seconds > 0.2 {
      didStartPlaying = true
      checks["startupMs"] = elapsedMs()
      checks["playing"] = true
      logEvent("playing", "已出画播放（起播 \(elapsedMs())ms）")
    }
    if didStartPlaying, seekPhase == 0, time.seconds >= 2.0 {
      runSeekTest(player: player, item: item)
    }
    if seekPhase == 2, abrPhase == 0 {
      runAbrClamp(item: item)
    }
  }

  private func runSeekTest(player: AVPlayer, item: AVPlayerItem) {
    seekPhase = 1
    let duration = item.duration.seconds
    guard duration.isFinite, duration > 20 else {
      checks["seek"] = ["skipped": "时长未知或过短（\(duration)）"]
      logEvent("seek", "跳过：时长不可用")
      seekPhase = 2
      return
    }
    let target = duration * 0.3
    let tolerance = CMTime(seconds: 0.5, preferredTimescale: 600)
    player.seek(
      to: CMTime(seconds: target, preferredTimescale: 600),
      toleranceBefore: tolerance,
      toleranceAfter: tolerance
    ) { [weak self] finished in
      DispatchQueue.main.async {
        guard let self = self else { return }
        let landed = item.currentTime().seconds
        let delta = abs(landed - target)
        self.checks["seek"] = [
          "target": target, "landed": landed, "delta": delta,
          "finished": finished, "ok": finished && delta < 2.0,
        ]
        self.logEvent("seek", "目标 \(Int(target))s 落点 \(String(format: "%.1f", landed))s 偏差 \(String(format: "%.1f", delta))s")
        self.seekPhase = 2
      }
    }
    logEvent("seek", "发起 seek 到 \(Int(target))s")
  }

  private func runSubtitleCheck(_ item: AVPlayerItem) {
    let asset = item.asset
    if let group = asset.mediaSelectionGroup(forMediaCharacteristic: .legible),
       !group.options.isEmpty {
      let option = group.options[0]
      item.select(option, in: group)
      checks["subtitles"] = [
        "present": true,
        "options": group.options.count,
        "selected": true,
        "locale": option.locale?.identifier ?? "",
      ]
      logEvent("subtitles", "字幕轨 \(group.options.count) 条，已选中第一条")
    } else {
      checks["subtitles"] = ["present": false, "options": 0, "selected": false]
      logEvent("subtitles", "源无字幕轨")
    }
  }

  private func runVariantLoad(_ item: AVPlayerItem) {
    // .variants 键挂在 AVURLAsset 上（CI 第二跑编译错误实证）；本原型条目
    // 恒由 URL 创建，asset 实际即 AVURLAsset，转换失败则如实记错。
    guard let asset = item.asset as? AVURLAsset else {
      checks["variants"] = ["error": "asset 非 AVURLAsset，无法读变体"]
      logEvent("variants", "跳过：asset 非 AVURLAsset")
      return
    }
    Task { [weak self] in
      guard let self = self else { return }
      do {
        let variants = try await asset.load(.variants)
        let bitrates = variants.map { $0.bitrate }
        await MainActor.run {
          self.checks["variants"] = ["count": variants.count, "bitrates": bitrates]
          self.logEvent("variants", "变体 \(variants.count) 个")
        }
      } catch {
        await MainActor.run {
          self.checks["variants"] = ["error": error.localizedDescription]
          self.logEvent("variants", "变体读取失败：\(error.localizedDescription)")
        }
      }
    }
  }

  private func lastIndicatedBitrate(_ item: AVPlayerItem) -> Double {
    guard let events = item.accessLog()?.events, let last = events.last else { return -1 }
    return last.indicatedBitrate
  }

  private func runAbrClamp(item: AVPlayerItem) {
    abrPhase = 1
    abrBaseline = lastIndicatedBitrate(item)
    // 钳到极低码率：多码率源应被迫切到最低变体，access log 的
    // indicatedBitrate 随之下降；单码率源不会变——以此区分。
    item.preferredPeakBitRate = 10_000
    logEvent("abr", "已钳制 preferredPeakBitRate，基线 indicated=\(Int(abrBaseline))")
    Timer.scheduledTimer(withTimeInterval: 5.0, repeats: false) { [weak self] _ in
      guard let self = self, let item = self.playerItem else { return }
      let clamped = self.lastIndicatedBitrate(item)
      item.preferredPeakBitRate = 0
      let variants = (self.checks["variants"] as? [String: Any])?["count"] as? Int ?? -1
      let switched = self.abrBaseline > 0 && clamped >= 0 && clamped < self.abrBaseline * 0.8
      self.checks["abr"] = [
        "baselineIndicated": self.abrBaseline,
        "clampedIndicated": clamped,
        "variantCount": variants,
        "switched": switched,
      ]
      self.logEvent("abr", "钳制后 indicated=\(Int(clamped))，切换=\(switched)")
      self.abrPhase = 2
      self.sequenceDone = true
    }
  }

  // MARK: - 门2：帧管线

  private func setupFramePipeline(item: AVPlayerItem) {
    guard let device = MTLCreateSystemDefaultDevice() else {
      frameError = "无 Metal 设备"
      return
    }
    metalDevice = device
    metalQueue = device.makeCommandQueue()
    do {
      let library = try device.makeLibrary(source: sharpenShaderSource, options: nil)
      if let function = library.makeFunction(name: "sharpen") {
        pipeline = try device.makeComputePipelineState(function: function)
      } else {
        frameError = "锐化函数缺失"
      }
    } catch {
      frameError = "Metal 管线建立失败：\(error.localizedDescription)"
    }
    var cache: CVMetalTextureCache?
    if CVMetalTextureCacheCreate(nil, nil, device, nil, &cache) == kCVReturnSuccess {
      textureCache = cache
    } else {
      frameError = "CVMetalTextureCache 建立失败"
    }
    let attributes: [String: Any] = [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
    ]
    let output = AVPlayerItemVideoOutput(pixelBufferAttributes: attributes)
    item.add(output)
    videoOutput = output

    let link = CADisplayLink(target: self, selector: #selector(frameTick))
    link.add(to: .main, forMode: .common)
    displayLink = link
    logEvent("framePipeline", "VideoOutput + Metal 管线已挂载（只测不用）")
  }

  @objc private func frameTick() {
    guard frameSamplesMs.count < 180,
          let output = videoOutput else {
      displayLink?.invalidate()
      displayLink = nil
      return
    }
    let hostTime = CACurrentMediaTime()
    let itemTime = output.itemTime(forHostTime: hostTime)
    guard output.hasNewPixelBuffer(forItemTime: itemTime) else { return }
    var displayTime = CMTime.zero
    guard let buffer = output.copyPixelBuffer(forItemTime: itemTime, itemTimeForDisplay: &displayTime) else {
      return
    }
    processFrame(buffer)
  }

  private func processFrame(_ buffer: CVPixelBuffer) {
    let start = CACurrentMediaTime()
    frameWidth = CVPixelBufferGetWidth(buffer)
    frameHeight = CVPixelBufferGetHeight(buffer)
    frameFormat = CVPixelBufferGetPixelFormatType(buffer)
    frameIOSurface = CVPixelBufferGetIOSurface(buffer) != nil
    frameBytesPerRow = CVPixelBufferGetBytesPerRow(buffer)

    guard let cache = textureCache,
          let device = metalDevice,
          let queue = metalQueue,
          let pipeline = pipeline else {
      if frameError == nil { frameError = "Metal 资源不完整，帧未处理" }
      return
    }
    var cvTexture: CVMetalTexture?
    let status = CVMetalTextureCacheCreateTextureFromImage(
      nil, cache, buffer, nil, .bgra8Unorm,
      frameWidth, frameHeight, 0, &cvTexture
    )
    guard status == kCVReturnSuccess, let cvTexture = cvTexture,
          let inTexture = CVMetalTextureGetTexture(cvTexture) else {
      if frameError == nil { frameError = "纹理创建失败（CVReturn \(status)）" }
      return
    }
    if outTexture == nil || outTexture!.width != frameWidth || outTexture!.height != frameHeight {
      let descriptor = MTLTextureDescriptor.texture2DDescriptor(
        pixelFormat: .bgra8Unorm, width: frameWidth, height: frameHeight, mipmapped: false
      )
      descriptor.usage = [.shaderWrite, .shaderRead]
      descriptor.storageMode = .private
      outTexture = device.makeTexture(descriptor: descriptor)
    }
    guard let outTexture = outTexture,
          let commandBuffer = queue.makeCommandBuffer(),
          let encoder = commandBuffer.makeComputeCommandEncoder() else {
      if frameError == nil { frameError = "命令缓冲建立失败" }
      return
    }
    encoder.setComputePipelineState(pipeline)
    encoder.setTexture(inTexture, index: 0)
    encoder.setTexture(outTexture, index: 1)
    let threadWidth = pipeline.threadExecutionWidth
    let threadHeight = max(1, pipeline.maxTotalThreadsPerThreadgroup / threadWidth)
    let threadsPerGroup = MTLSize(width: threadWidth, height: threadHeight, depth: 1)
    let groups = MTLSize(
      width: (frameWidth + threadWidth - 1) / threadWidth,
      height: (frameHeight + threadHeight - 1) / threadHeight,
      depth: 1
    )
    encoder.dispatchThreadgroups(groups, threadsPerThreadgroup: threadsPerGroup)
    encoder.endEncoding()
    commandBuffer.commit()
    commandBuffer.waitUntilCompleted()
    frameSamplesMs.append((CACurrentMediaTime() - start) * 1000)
    if frameSamplesMs.count == 180 {
      logEvent("framePipeline", "已测满 180 帧，停止采样")
    }
  }

  // MARK: - 快照与收尾

  private func snapshot() -> [String: Any] {
    var frame: [String: Any] = [
      "frames": frameSamplesMs.count,
      "width": frameWidth,
      "height": frameHeight,
      "pixelFormat": frameFormat,
      "ioSurfaceBacked": frameIOSurface,
      "bytesPerRow": frameBytesPerRow,
    ]
    if !frameSamplesMs.isEmpty {
      let sorted = frameSamplesMs.sorted()
      frame["avgMs"] = frameSamplesMs.reduce(0, +) / Double(frameSamplesMs.count)
      frame["p95Ms"] = sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))]
      frame["maxMs"] = sorted.last ?? 0
    }
    if let frameError = frameError {
      frame["error"] = frameError
    }
    return [
      "active": player != nil,
      "presenting": viewController != nil && viewController!.viewIfLoaded?.window != nil,
      "sequenceDone": sequenceDone,
      "elapsedMs": elapsedMs(),
      "checks": checks,
      "frame": frame,
      "events": events,
    ]
  }

  private func teardown() {
    displayLink?.invalidate()
    displayLink = nil
    if let token = timeObserverToken, let player = player {
      player.removeTimeObserver(token)
    }
    timeObserverToken = nil
    statusObservation?.invalidate()
    statusObservation = nil
    player?.pause()
    if let item = playerItem, let output = videoOutput {
      item.remove(output)
    }
    videoOutput = nil
    viewController?.dismiss(animated: false)
    viewController = nil
    player = nil
    playerItem = nil
    outTexture = nil
    textureCache = nil
  }

  private func elapsedMs() -> Int {
    guard let start = loadStartedAt else { return 0 }
    return Int(Date().timeIntervalSince(start) * 1000)
  }

  private func logEvent(_ name: String, _ detail: String) {
    events.append(["tMs": elapsedMs(), "name": name, "detail": detail])
    if events.count > 200 {
      events.removeFirst(events.count - 200)
    }
  }
}

@_cdecl("init_plugin_avproto")
func initPlugin() -> Plugin {
  return AvProtoPlugin()
}
