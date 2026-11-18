/**
 * 超分画布选引擎包装（Muse 2026-11-19，fix2 超分换代）。
 *
 * VideoSurface / Player 只挂这一个组件，引擎选择收敛在此：
 *  - 探针 v2 机器门全过（摄入路径可用＋720p 全链成本 < 帧预算）
 *    且自动档为 natural/crisp → WebGpuSrCanvas（Anime4K 模型超分）；
 *  - 其余一切情况（探针未过/未完成、风格档 cinema/anime_*、用户关）
 *    → SuperResCanvas（现行 WebGL 锐化管线，即回退层）。
 * WebGPU 引擎一旦死亡（Device Lost/成本停档），本会话永久回退，
 * 不再重试（webgpuSr 的旁路纪律）。两条管线永不同时挂载、不叠加。
 * 画质采纳门的同帧对比证据在 fix2 报告与存档中（夹具实测）；设备
 * 侧的最终启用以探针 v2 在该设备上的实测为准——过不了自动回退，
 * 零用户操作。
 */

import React, { useEffect, useState } from "react";
import type { SuperResMode } from "../../shared/model/store";
import { getSrProbeResult } from "../../shared/diagnostics/gpuProbe";
import SuperResCanvas from "./SuperResCanvas";
import WebGpuSrCanvas from "./WebGpuSrCanvas";

type Props = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  mode: SuperResMode;
  active?: boolean;
  ready?: boolean;
  fit?: "contain" | "cover";
  srcKey?: string;
  fps?: number;
  onFallbackChange?: (useSvgFallback: boolean) => void;
  onActiveModeChange?: (mode: SuperResMode) => void;
  onTrace?: (event: string, data?: Record<string, unknown>) => void;
};

/* 会话级闩锁：WebGPU 引擎死过一次，本会话所有播放面都不再试。 */
let webgpuSessionDead = false;

export default function SrCanvas(props: Props) {
  const [probeReady, setProbeReady] = useState(() => getSrProbeResult() !== null);
  const [, setDeadTick] = useState(0);

  /* 探针在启动后后台完成：轮询缓存直到有结果（上限 ~40s），
   * 有结果后若门全过，后续挂载的播放面自动走 WebGPU 管线。 */
  useEffect(() => {
    if (probeReady) return;
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      if (getSrProbeResult() !== null || n > 20) {
        setProbeReady(getSrProbeResult() !== null);
        clearInterval(timer);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [probeReady]);

  const probe = getSrProbeResult();
  const engaged =
    !webgpuSessionDead &&
    probeReady &&
    probe?.gatesPass === true &&
    !!probe.recommendedPath &&
    (props.mode === "natural" || props.mode === "crisp");

  if (engaged) {
    return (
      <WebGpuSrCanvas
        videoRef={props.videoRef}
        mode={props.mode}
        active={props.active}
        ready={props.ready}
        fit={props.fit}
        srcKey={props.srcKey}
        fps={props.fps}
        onActiveModeChange={props.onActiveModeChange}
        onTrace={props.onTrace}
        onEngineDead={() => {
          webgpuSessionDead = true;
          props.onTrace?.("sr.webgpu_dead", {});
          setDeadTick((v) => v + 1);
        }}
      />
    );
  }
  return <SuperResCanvas {...props} />;
}

/* 供测试/诊断读取的会话闩锁状态。 */
export function isWebgpuSessionDead(): boolean {
  return webgpuSessionDead;
}
