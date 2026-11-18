import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "../../shared/ui/ios/controls";
import { api, platform } from "../../shared/api/api";
import { playbackSource } from "../playback/mediaTransport";
import {
  getLastAvProtoRun,
  saveAvProtoRun,
  type AvProtoRun,
  type ProtoGate3,
  type ProtoSnapshot,
} from "../../shared/diagnostics/avProto";

/* AVFoundation 原型自检页（Muse 2026-11-19）：设置 → 诊断里的手动入口，
 * 默认不触发、不影响正常使用。流程：打开 Rust 门3 记账 → 取首页第一条
 * 视频的播放地址 → 拼回环地址交给 Swift AVPlayer 呈现并自动跑完
 * 起播/seek/字幕/ABR 检查与帧管线采样 → 收尾取回三门结果存档，
 * 诊断报告随后可直接引用。测试源取「当前线路下首页第一条」，与正式
 * 播放同一条解析路径（api.play → playbackSource → media_http_origin）。 */

type Phase = "idle" | "preparing" | "running" | "finishing";

function checkRow(label: string, value: string, state: "ok" | "bad" | "wait" | "data") {
  const mark = state === "ok" ? "✓" : state === "bad" ? "✗" : state === "wait" ? "…" : "·";
  const color = state === "ok" ? "text-ok" : state === "bad" ? "text-bad" : "text-mut";
  return (
    <div className="flex items-start gap-2 py-1" key={label}>
      <span className={`${color} text-[13px] w-4 shrink-0`}>{mark}</span>
      <span className="text-[13px] text-on w-20 shrink-0">{label}</span>
      <span className="text-[13px] text-mut flex-1 min-w-0">{value}</span>
    </div>
  );
}

export default function AvProtoLab() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [snap, setSnap] = useState<ProtoSnapshot | null>(null);
  const [run, setRun] = useState<AvProtoRun | null>(() => getLastAvProtoRun());
  const sessionRef = useRef<string>("");
  const pollRef = useRef<number | null>(null);
  const finishingRef = useRef(false);

  const stopPolling = () => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => stopPolling, []);

  const finish = async () => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    stopPolling();
    setPhase("finishing");
    try {
      const finalSnap = await invoke<ProtoSnapshot>("plugin:avproto|proto_close", { payload: {} });
      const gate3 = await invoke<ProtoGate3>("proto_session_end");
      const completed: AvProtoRun = {
        at: new Date().toISOString(),
        sessionId: sessionRef.current,
        snapshot: finalSnap,
        gate3,
      };
      saveAvProtoRun(completed);
      setRun(completed);
      setSnap(finalSnap);
    } catch (e) {
      setError(`收尾失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      finishingRef.current = false;
      setPhase("idle");
    }
  };

  const start = async () => {
    setError("");
    setSnap(null);
    setPhase("preparing");
    try {
      if (platform !== "ios") throw new Error("原型自检仅适用于 iOS");
      sessionRef.current = await invoke<string>("proto_session_begin");
      const feed = await api.feed(1, 1);
      const card = feed.items?.[0];
      if (!card) throw new Error("首页暂无可用的测试视频");
      const info = await api.play(card.id, 0);
      const streamUrl = info?.streams?.main || info?.video_url;
      if (!streamUrl) throw new Error("测试视频暂无播放地址");
      const source = playbackSource(streamUrl, false);
      const origin = await invoke<string>("media_http_origin");
      const url = `${origin.replace(/\/$/, "")}${source.route}`;
      await invoke("plugin:avproto|proto_load", { payload: { url } });
      setPhase("running");
      pollRef.current = window.setInterval(async () => {
        try {
          const status = await invoke<ProtoSnapshot>("plugin:avproto|proto_status", { payload: {} });
          setSnap(status);
          if (status.sequenceDone) {
            // 检查跑完后留 4 秒让帧采样继续累积，再自动收尾。
            window.setTimeout(() => { void finish(); }, 4000);
            stopPolling();
          }
        } catch { /* 轮询失败不打断自检，收尾时再报错 */ }
      }, 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      try { await invoke("proto_session_end"); } catch { /* 会话可能未开 */ }
      setPhase("idle");
    }
  };

  const checks = (snap?.checks ?? {}) as Record<string, any>;
  const frame = (snap?.frame ?? {}) as Record<string, any>;
  const gate3 = run && phase === "idle" ? run.gate3 : null;

  return (
    <div className="p-5">
      <h2 className="text-[15px] font-bold text-on">AVFoundation 原型自检</h2>
      <p className="text-[13px] text-mut mt-2">
        验证混合路线的三道门：原生 AVPlayer 经本机回环服务喂流（门1）、取帧到 Metal
        锐化的管线实测（门2）、Rust 服务侧分片记账对账（门3）。开始后会弹出原生
        播放器并自动检查，期间可用播放器右上角「关闭自检」提前结束；结果会存档，
        并进入诊断报告。
      </p>

      <div className="mt-4">
        {checkRow("起播", checks.playing ? `已出画（${checks.startupMs ?? "?"}ms）` : checks.itemError ? `失败：${checks.itemError}` : "等待播放", checks.playing ? "ok" : checks.itemError ? "bad" : "wait")}
        {checkRow("Seek", checks.seek ? (checks.seek.skipped ? `跳过（${checks.seek.skipped}）` : `目标 ${checks.seek.target}s → ${checks.seek.landed}s，偏差 ${checks.seek.delta}s`) : "等待", checks.seek ? (checks.seek.ok === false ? "bad" : "data") : "wait")}
        {checkRow("字幕轨", checks.subtitles ? (checks.subtitles.present ? `${checks.subtitles.options} 条，已选中第一条` : "源无字幕轨（数据）") : "等待", checks.subtitles ? "data" : "wait")}
        {checkRow("多码率", checks.abr ? `变体 ${checks.abr.variantCount} 个，钳制后切换${checks.abr.switched ? "已发生" : "未发生"}` : checks.variants ? `变体 ${checks.variants.count ?? "?"} 个` : "等待", checks.abr ? "data" : "wait")}
        {checkRow("帧管线", frame.frames ? `${frame.frames} 帧 · 平均 ${frame.avgMs != null ? Number(frame.avgMs).toFixed(2) : "?"}ms · ${frame.width}x${frame.height} · IOSurface ${frame.ioSurfaceBacked ? "是" : "否"}` : frame.error ? frame.error : "等待采样", frame.frames ? "data" : "wait")}
        {checkRow("门3 对账", gate3 ? `独立计数 ${gate3.independentRequests} · 已记 ${gate3.recordedResponses} · 缺口 ${gate3.missingResponses} · 应请求分片 ${gate3.expectedSegments} · 实记 ${gate3.segmentResponses}` : "收尾后出对账", gate3 ? (gate3.missingResponses > 0 ? "bad" : "ok") : "wait")}
      </div>

      {snap?.events && snap.events.length > 0 && (
        <div className="mt-3 max-h-32 overflow-y-auto rounded-(--r-sm) bg-s3 p-3">
          {snap.events.map((event, index) => (
            <div key={index} className="text-[12px] text-mut leading-relaxed">
              {event.tMs}ms · {event.name} · {event.detail}
            </div>
          ))}
        </div>
      )}

      {error && <div className="text-[13px] text-bad mt-3">{error}</div>}

      <div className="flex gap-2 mt-4">
        {phase === "running" ? (
          <Button onClick={() => { void finish(); }} className="flex-1 h-9 rounded-(--r-ctl) brand-grad text-[14px] pressable">
            结束并取结果
          </Button>
        ) : (
          <Button
            disabled={phase === "preparing" || phase === "finishing"}
            onClick={() => { void start(); }}
            className="flex-1 h-9 rounded-(--r-ctl) brand-grad text-[14px] pressable disabled:opacity-60"
          >
            {phase === "preparing" ? "正在准备…" : phase === "finishing" ? "正在收尾…" : "开始自检"}
          </Button>
        )}
      </div>
      {run && phase === "idle" && (
        <div className="text-[12px] text-mut mt-3">最近一轮：{run.at} · 会话 {run.sessionId}</div>
      )}
    </div>
  );
}
