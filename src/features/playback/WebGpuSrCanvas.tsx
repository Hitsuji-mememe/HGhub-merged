/**
 * WebGPU 模型超分画布（Muse 2026-11-19，fix2 超分换代）。
 *
 * 与 SuperResCanvas 同契约（同 Props、同挂载位、同呈现矩形口径），
 * 内部换成 webgpuSr 引擎（Anime4K CNN：Restore＋Upscale x2）。
 * 只被 SrCanvas 在「探针 v2 机器门全过＋自动档为 natural/crisp」时
 * 挂载；引擎死亡（Device Lost / 成本降级到停）经 onEngineDead 上报，
 * SrCanvas 本会话内永久回退 SuperResCanvas——两条管线永不同时
 * 呈现、不叠加（U1 口径）。
 *
 * 帧循环：rVFC 驱动（无 rVFC 时 rAF 兜底）；引擎自身丢弃过期帧。
 * 画布尺寸与 SuperResCanvas 的 syncSize 同口径（CSS 尺寸 × dpr≤2.5，
 * 上限 2560），呈现矩形用 srContentRect（contain）/居中裁切（cover），
 * 与 <video> 的 object-fit 严格一致。
 */

import React, { useEffect, useRef, useState } from "react";
import type { SuperResMode } from "../../shared/model/store";
import { getSrProbeResult } from "../../shared/diagnostics/gpuProbe";
import { srContentRect, srDemote } from "./SuperResCanvas";
import { WebGpuSrEngine } from "./webgpuSr";

/** 呈现档回报口径（整改 B17-2）：引擎降级级经 srDemote 映射回模式
 * 阶梯——degrade 0 = 原档、1 = 降一档（2 = 引擎已死、组件随即卸载）。 */
export function webgpuReportedMode(mode: SuperResMode, degrade: 0 | 1 | 2): SuperResMode {
  return srDemote(mode, degrade);
}

type Props = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  mode: SuperResMode;
  active?: boolean;
  ready?: boolean;
  fit?: "contain" | "cover";
  srcKey?: string;
  fps?: number;
  onActiveModeChange?: (mode: SuperResMode) => void;
  onTrace?: (event: string, data?: Record<string, unknown>) => void;
  /** 引擎不可用/死亡：SrCanvas 据此本会话回退 WebGL 管线。 */
  onEngineDead: () => void;
};

type VideoWithVfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export default function WebGpuSrCanvas({
  videoRef,
  mode,
  active = true,
  ready = true,
  fit = "contain",
  srcKey = "",
  fps,
  onActiveModeChange,
  onTrace,
  onEngineDead,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<WebGpuSrEngine | null>(null);
  const [presented, setPresented] = useState(false);
  /* 引擎降级级（整改 B17-2）：引擎每次变更经 onDegrade 回报至此，
   * 与 presented/mode 一起驱动呈现档回报 effect。 */
  const [degrade, setDegrade] = useState<0 | 1 | 2>(0);
  const activeModeCbRef = useRef(onActiveModeChange);
  activeModeCbRef.current = onActiveModeChange;
  const activeRef = useRef(active);
  activeRef.current = active;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const deadRef = useRef(false);
  const presentedRef = useRef(false);

  /* 画布尺寸同步（与 SuperResCanvas.syncSize 同口径）。 */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const syncSize = () => {
      const cssW = canvas.clientWidth || canvas.getBoundingClientRect().width;
      const cssH = canvas.clientHeight || canvas.getBoundingClientRect().height;
      if (cssW <= 0 || cssH <= 0) return;
      const dpr = Math.min(window.devicePixelRatio || 2, 2.5);
      const w = Math.min(2560, Math.max(2, Math.round(cssW * dpr)));
      const h = Math.min(2560, Math.max(2, Math.round(cssH * dpr)));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };
    syncSize();
    const ro = new ResizeObserver(syncSize);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current as VideoWithVfc | null;
    if (!canvas || !video) return;
    let cancelled = false;
    let rafId = 0;
    let vfcId = 0;
    setPresented(false);
    presentedRef.current = false;
    setDegrade(0);

    const die = () => {
      if (deadRef.current) return;
      deadRef.current = true;
      onEngineDead();
    };

    const start = async () => {
      const probe = getSrProbeResult();
      const path = probe?.recommendedPath ?? "copy";
      const engine = await WebGpuSrEngine.create(canvas, { path, onLost: die, onDegrade: (d) => { if (!cancelled) setDegrade(d); } });
      if (cancelled) {
        engine?.destroy();
        return;
      }
      if (!engine) {
        die();
        return;
      }
      engineRef.current = engine;
      onTrace?.("sr.webgpu_start", { path });

      /* 暂停停处理（fix2.1 批二#5）：暂停时视频帧不再变化，旧实现仍以
       * rAF 约 60fps 对同一静止帧反复跑全链 CNN，纯烧电发热。现行：
       * paused 时只在 currentTime 跳变（暂停中 seek）时补处理一帧，
       * 其余 tick 直接跳过——画布保留最后一帧呈现、不清屏；播放恢复
       * 后 rVFC/rAF 循环本就一直在转，自动恢复逐帧处理。 */
      let lastMediaTime = -1;
      const frame = () => {
        if (cancelled || deadRef.current) return;
        const eng = engineRef.current;
        if (!eng) return;
        if (eng.isDead) {
          die();
          return;
        }
        const pausedStill = video.paused && Math.abs(video.currentTime - lastMediaTime) < 0.001;
        if (activeRef.current && readyRef.current && video.videoWidth > 0 && !pausedStill) {
          const cw = canvas.width;
          const ch = canvas.height;
          let dst: [number, number, number, number] = [0, 0, 1, 1];
          let src: [number, number, number, number] = [0, 0, 1, 1];
          if (fitRef.current === "cover") {
            const canvasAr = cw / ch;
            const videoAr = video.videoWidth / video.videoHeight;
            if (canvasAr > videoAr) {
              const srcH = videoAr / canvasAr;
              src = [0, (1 - srcH) / 2, 1, srcH];
            } else {
              const srcW = canvasAr / videoAr;
              src = [(1 - srcW) / 2, 0, srcW, 1];
            }
          } else {
            const rect = srContentRect(cw, ch, video.videoWidth, video.videoHeight, "contain");
            dst = [rect.x / cw, rect.y / ch, rect.w / cw, rect.h / ch];
          }
          const intervalMs = fps && fps > 0 ? 1000 / fps : 33.3;
          const did = eng.processFrame(video, intervalMs, { dst, src });
          if (did) lastMediaTime = video.currentTime;
          if (did && !presentedRef.current) {
            /* 首帧呈现：只置 presented＋记 trace；呈现档回报收敛到
             * 下方 effect（整改 B17-2）——旧实现在此一次性报原 mode，
             * 引擎后续 degrade 后 facts 永远停在原档。 */
            presentedRef.current = true;
            setPresented(true);
            onTrace?.("sr.webgpu_present", { path });
          }
        }
        if (typeof video.requestVideoFrameCallback === "function" && !video.paused) {
          vfcId = video.requestVideoFrameCallback(frame);
        } else {
          rafId = window.requestAnimationFrame(frame);
        }
      };
      frame();
    };
    void start();

    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (vfcId && typeof video.cancelVideoFrameCallback === "function") {
        try { video.cancelVideoFrameCallback(vfcId); } catch { /* 忽略 */ }
      }
      engineRef.current?.destroy();
      engineRef.current = null;
    };
    // srcKey 变化 = 换源：引擎与纹理按新源重建（与 SuperResCanvas 同纪律）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcKey]);

  /* 呈现档回报（整改 B17-2）：首帧呈现后开始报，mode 或引擎 degrade
   * 每次变化都重报 srDemote(mode, degrade)，facts 呈现档与真实管线
   * 一致（旧实现只在首帧报一次原 mode，降级后永不更新）。 */
  useEffect(() => {
    if (presented) activeModeCbRef.current?.(webgpuReportedMode(mode, degrade));
  }, [presented, mode, degrade]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{ opacity: presented ? 1 : 0, transition: "opacity .12s ease" }}
    />
  );
}
